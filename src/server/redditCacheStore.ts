/**
 * redditCacheStore.ts
 *
 * The Reddit-derived part of the local quest database.
 *
 *   1. The bundled database (`redditCache.json`, built from the r/DiscordQuests
 *      snapshots by process-apify.ts) is imported, so esbuild bakes it into
 *      `dist/server.cjs` and the packaged desktop app always has it. When it
 *      was updated is recorded in questDatabaseInfo.ts.
 *   2. A local part lives next to the library (`Games/.quest-database.json`):
 *      games the background update found in newer posts, and games the user
 *      added to the library from a live Reddit result (so the next search
 *      finds them offline). Its own update/check dates are stored in the file.
 *   3. Search screens read the in-memory copy synchronously - a normal search
 *      never touches the network.
 *   4. The background update downloads the published database
 *      (publishedDatabase.ts) every six hours. When it is newer than the
 *      bundled one it takes its place and is kept in the local file, so it
 *      also works offline. Only when the published file cannot be reached
 *      for a day does the app read new r/DiscordQuests posts itself
 *      (redditPosts.ts), usually with a single request.
 */

import fs from 'fs';
import path from 'path';
import { GAMES_DIR, OFFLINE } from './config.ts';
import { APP_VERSION } from '../version.ts';
import bundledDatabase from './redditCache.json';
import {
  QUEST_DATABASE_CHECKED_THROUGH,
  QUEST_DATABASE_UPDATED_AT,
  QUEST_DATABASE_UPDATE_HISTORY,
} from './questDatabaseInfo.ts';
import { normalizeGameKey } from './gameKey.ts';
import { redditPostId } from './redditCorrections.ts';
import {
  dedupeEntries,
  mergeEntries,
  normalizeCacheEntry,
  redditPostToEntries,
  type RedditCacheEntry,
} from './redditDataset.ts';
import { fetchNewSubredditPosts } from './redditPosts.ts';
import { fetchPublishedDatabase, PUBLISHED_DATABASE_URLS } from './publishedDatabase.ts';

export type { RedditCacheEntry } from './redditDataset.ts';

// ---------------------------------------------------------------------------
// Files and settings
// ---------------------------------------------------------------------------

/** The local part of the database (writable, next to the library). */
const LOCAL_FILE = path.join(GAMES_DIR, '.quest-database.json');
/** Name used by v1.2.21 development builds; still read once. */
const LEGACY_LOCAL_FILE = path.join(GAMES_DIR, '.reddit-cache.json');

/** How often the published database is checked (also while the app stays open). */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Reddit itself is asked at most this often, and only when the published file is unreachable. */
const DIRECT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Listing pages an update may read (100 posts each). One is the normal case;
 * after months without a start the listing is read up to Reddit's own limit
 * (1000 posts), spaced by redditClient.ts, so the checked range always moves on.
 */
const REFRESH_MAX_PAGES = 10;

/** `DQR_REDDIT_CACHE_REFRESH=1` forces an update at start, `=0` disables it. */
const REFRESH_MODE = (process.env.DQR_REDDIT_CACHE_REFRESH || '').trim();

interface BundledFile {
  generatedAt?: string;
  checkedThrough?: string;
  entries?: unknown;
}

interface PublishedPart {
  generatedAt?: string;
  checkedThrough?: string;
  etag?: string;
  entries?: unknown;
}

interface LocalFile {
  version?: string;
  /** The last downloaded published database, when it is newer than the bundled one. */
  published?: PublishedPart;
  /** Last change of the local entries. */
  updatedAt?: string;
  /** Last successful update check (published database or r/DiscordQuests). */
  checkedAt?: string;
  /** Newest post the background update had seen. */
  checkedThrough?: string;
  /** v1.2.21 refresh files only had this. */
  generatedAt?: string;
  entries?: unknown;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Entries of the bundled database, or of the newer published one. */
let _seedEntries: RedditCacheEntry[] = [];
/** The published database in use, saved with the local file. */
let _published: { generatedAt: string; checkedThrough: string; etag: string; entries: RedditCacheEntry[] } | null = null;
let _refreshTimer: NodeJS.Timeout | undefined;
/** Entries of the local part (background update + library additions). */
let _localEntries: RedditCacheEntry[] = [];
/** Seed + local; the seed wins when both know an executable. */
let _entries: RedditCacheEntry[] = [];
let _bundledUpdatedAt = '';
let _bundledCheckedThrough = '';
let _localUpdatedAt = '';
let _localCheckedAt = '';
let _localCheckedThrough = '';
/** Whether changes of the local part are written to LOCAL_FILE. */
let _persistLocal = false;
let _refreshing = false;
/** Bumped on every change so derived indexes (questLookup.ts) can rebuild. */
let _revision = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoOrEmpty(value: unknown): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : '';
}

function newest(...values: string[]): string {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';
}

function executableKey(entry: { executableName: string }): string {
  return entry.executableName.trim().toLowerCase();
}

/** Validated, fixed and canonically named entries of an untrusted list. */
function normalizeEntries(list: unknown): RedditCacheEntry[] {
  if (!Array.isArray(list)) return [];
  return dedupeEntries(
    list.map((entry) => normalizeCacheEntry(entry)).filter((entry): entry is RedditCacheEntry => Boolean(entry))
  );
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    console.warn(`[QuestDatabase] Ignoring unreadable file ${filePath}.`);
    return null;
  }
}

function commitEntries(): void {
  _entries = mergeEntries(_seedEntries, _localEntries);
  _revision++;
}

function saveLocal(): void {
  if (!_persistLocal) return;
  const data: LocalFile = {
    version: APP_VERSION,
    updatedAt: _localUpdatedAt || undefined,
    checkedAt: _localCheckedAt || undefined,
    checkedThrough: _localCheckedThrough || undefined,
    published: _published ?? undefined,
    entries: _localEntries,
  };
  try {
    fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[QuestDatabase] Could not save the local quest database:', err);
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Loads the database. Called once at boot; the search layer reads the
 * in-memory copy synchronously.
 *
 * Without an argument the bundled database is used together with the local
 * part next to the library. `filePath` loads one specific database file
 * instead; nothing is written back then.
 */
export function loadRedditCache(filePath?: string): void {
  if (filePath) {
    const file = readJsonFile<BundledFile>(filePath);
    _seedEntries = normalizeEntries(file?.entries);
    _localEntries = [];
    _bundledUpdatedAt = isoOrEmpty(file?.generatedAt);
    _bundledCheckedThrough = isoOrEmpty(file?.checkedThrough);
    _localUpdatedAt = _localCheckedAt = _localCheckedThrough = '';
    _published = null;
    _persistLocal = false;
    commitEntries();
    if (file) console.log(`[QuestDatabase] Loaded ${_entries.length} entries from ${filePath}.`);
    else console.warn('[QuestDatabase] Database file missing or corrupt - starting empty.');
    return;
  }

  const seed = bundledDatabase as BundledFile;
  const local = readJsonFile<LocalFile>(LOCAL_FILE) ?? readJsonFile<LocalFile>(LEGACY_LOCAL_FILE);
  _seedEntries = normalizeEntries(seed.entries);
  _bundledUpdatedAt = isoOrEmpty(seed.generatedAt) || isoOrEmpty(QUEST_DATABASE_UPDATED_AT);
  _bundledCheckedThrough = isoOrEmpty(seed.checkedThrough) || isoOrEmpty(QUEST_DATABASE_CHECKED_THROUGH);
  _published = null;
  _localEntries = normalizeEntries(local?.entries).filter(
    (entry) => !_seedEntries.some((seedEntry) => executableKey(seedEntry) === executableKey(entry))
  );
  _localUpdatedAt = isoOrEmpty(local?.updatedAt) || isoOrEmpty(local?.generatedAt);
  _localCheckedAt = isoOrEmpty(local?.checkedAt) || isoOrEmpty(local?.generatedAt);
  _localCheckedThrough = isoOrEmpty(local?.checkedThrough);
  const published = local?.published;
  if (published && isNewer(isoOrEmpty(published.generatedAt), _bundledUpdatedAt)) usePublished(published);
  _persistLocal = true;
  commitEntries();
  console.log(
    `[QuestDatabase] Loaded ${_seedEntries.length} bundled entries (updated ${_bundledUpdatedAt || 'unknown'})` +
      (_localEntries.length ? ` and ${_localEntries.length} local entries (updated ${_localUpdatedAt || 'unknown'}).` : '.')
  );
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Every entry of the local Reddit-derived database. */
export function getRedditCacheEntries(): readonly RedditCacheEntry[] {
  return _entries;
}

/** Changes whenever the entry list changes. */
export function getRedditCacheRevision(): number {
  return _revision;
}

// ---------------------------------------------------------------------------
// Local additions
// ---------------------------------------------------------------------------

/**
 * Adds an entry to the local part of the database, e.g. a live Reddit result
 * the user added to the library. Returns false when the entry is unusable or
 * its executable is already in the database.
 */
export function addLocalEntry(entry: RedditCacheEntry, addedFrom: 'library' | 'refresh'): boolean {
  const normalized = normalizeCacheEntry(entry);
  if (!normalized) return false;
  const key = executableKey(normalized);
  if (_entries.some((existing) => executableKey(existing) === key)) return false;
  const now = new Date().toISOString();
  _localEntries = [..._localEntries, { ...normalized, addedFrom, addedAt: now }];
  _localUpdatedAt = now;
  commitEntries();
  saveLocal();
  console.log(`[QuestDatabase] Saved "${normalized.gameName}" (${normalized.executableName}) to the local quest database.`);
  return true;
}

// ---------------------------------------------------------------------------
// Update dates (not shown in the interface; GET /api/profile reports them)
// ---------------------------------------------------------------------------

export interface QuestDatabaseInfo {
  /** Newest change of the database (bundled or local). */
  updatedAt: string;
  bundled: {
    updatedAt: string;
    checkedThrough: string;
    entries: number;
    games: number;
    /** Number of recorded updates (questDatabaseInfo.ts history). */
    updates: number;
  };
  local: {
    updatedAt: string;
    checkedAt: string;
    checkedThrough: string;
    entries: number;
    fromLibrary: number;
    fromRefresh: number;
  };
}

export function getQuestDatabaseInfo(): QuestDatabaseInfo {
  const games = (entries: RedditCacheEntry[]) =>
    new Set(entries.map((entry) => normalizeGameKey(entry.gameName) || entry.gameName)).size;
  return {
    updatedAt: newest(_bundledUpdatedAt, _localUpdatedAt),
    bundled: {
      updatedAt: _bundledUpdatedAt,
      checkedThrough: _bundledCheckedThrough,
      entries: _seedEntries.length,
      games: games(_seedEntries),
      updates: QUEST_DATABASE_UPDATE_HISTORY.length,
    },
    local: {
      updatedAt: _localUpdatedAt,
      checkedAt: _localCheckedAt,
      checkedThrough: _localCheckedThrough,
      entries: _localEntries.length,
      fromLibrary: _localEntries.filter((entry) => entry.addedFrom === 'library').length,
      fromRefresh: _localEntries.filter((entry) => entry.addedFrom !== 'library').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Background update
// ---------------------------------------------------------------------------

/** True when the database has not been checked for new posts for a day. */
function isOlderThan(timestamp: string, ms: number): boolean {
  return !timestamp || Date.now() - Date.parse(timestamp) > ms;
}

/** True when the database has not been checked for six hours. */
function isRefreshDue(): boolean {
  return _entries.length === 0 || isOlderThan(_localCheckedAt, REFRESH_INTERVAL_MS);
}

function isNewer(candidate: string, than: string): boolean {
  return Boolean(candidate) && (!than || Date.parse(candidate) > Date.parse(than));
}

/** Makes a published database the base of the search; local entries it now knows are dropped. */
function usePublished(part: PublishedPart): void {
  const entries = normalizeEntries(part.entries);
  if (entries.length === 0) return;
  _published = {
    generatedAt: isoOrEmpty(part.generatedAt),
    checkedThrough: isoOrEmpty(part.checkedThrough),
    etag: typeof part.etag === 'string' ? part.etag : '',
    entries,
  };
  _seedEntries = entries;
  _bundledUpdatedAt = _published.generatedAt;
  _bundledCheckedThrough = newest(_bundledCheckedThrough, _published.checkedThrough);
  const known = new Set(entries.map(executableKey));
  _localEntries = _localEntries.filter((entry) => !known.has(executableKey(entry)));
}

/**
 * One update check: the published database first; r/DiscordQuests itself
 * only when that file could not be reached and Reddit was not asked for a
 * day. `fetchImpl` is replaced by the tests.
 */
export async function refreshQuestDatabase(fetchImpl: typeof fetch = fetch): Promise<void> {
  const result = await fetchPublishedDatabase(_published?.etag ?? '', PUBLISHED_DATABASE_URLS, fetchImpl);
  if (result.status !== 'failed') {
    const now = new Date().toISOString();
    let note = 'unchanged';
    if (result.status === 'updated') {
      const generatedAt = isoOrEmpty(result.database.generatedAt);
      if (isNewer(generatedAt, _bundledUpdatedAt)) {
        usePublished({ ...result.database, etag: result.etag });
        _localUpdatedAt = now;
        note = `${_seedEntries.length} entries, updated ${generatedAt}`;
      } else if (_published) {
        _published.etag = result.etag;
      }
    }
    _localCheckedAt = now;
    commitEntries();
    saveLocal();
    console.log(`[QuestDatabase] Published database checked via ${result.url} (${note}).`);
    return;
  }
  if (!isOlderThan(_localCheckedAt, DIRECT_REFRESH_INTERVAL_MS)) {
    console.warn('[QuestDatabase] The published database could not be reached; trying again later.');
    return;
  }
  await runDirectRefresh();
}

async function runDirectRefresh(): Promise<void> {
  const since = newest(_bundledCheckedThrough, _localCheckedThrough);
  const knownIds = new Set(
    _entries.map((entry) => redditPostId(entry.url)).filter((id): id is string => Boolean(id))
  );
  const result = await fetchNewSubredditPosts({
    since,
    knownIds,
    maxPages: REFRESH_MAX_PAGES,
    waitForBudget: true,
  });

  if (!result.source) {
    console.warn(
      `[QuestDatabase] Update check failed (${result.rateLimited ? 'Reddit is rate limiting' : 'no answer'}); ` +
        'the next start tries again.'
    );
    return;
  }

  const now = new Date().toISOString();
  const known = new Set(_entries.map(executableKey));
  const additions = dedupeEntries(result.posts.flatMap((post) => redditPostToEntries(post)))
    .filter((entry) => !known.has(executableKey(entry)))
    .map((entry) => ({ ...entry, addedFrom: 'refresh' as const, addedAt: now }));

  if (additions.length > 0) {
    _localEntries = mergeEntries(_localEntries, additions);
    _localUpdatedAt = now;
  }
  _localCheckedAt = now;
  // Reddit lists newest first: an incomplete read left a gap, so the checked
  // range only moves when the listing reached posts the database knew.
  if (result.complete || result.source === 'arctic-shift') {
    _localCheckedThrough = newest(since, result.newestCreatedAt);
  }
  commitEntries();
  saveLocal();
  console.log(
    `[QuestDatabase] Update check via ${result.source}: ${result.posts.length} new post(s), ` +
      `${additions.length} new game entr${additions.length === 1 ? 'y' : 'ies'}, ${result.requests} request(s).`
  );
}

/**
 * Starts the background update (non-blocking) and repeats it every six hours
 * while the app runs. A check is skipped while the last one is less than six
 * hours old. DQR_REDDIT_CACHE_REFRESH=1 forces one at start, =0 disables it.
 */
export function scheduleRedditCacheRefresh(force = REFRESH_MODE === '1'): void {
  if (REFRESH_MODE === '0' || OFFLINE) {
    console.log('[QuestDatabase] Background refresh disabled.');
    return;
  }
  if (!_refreshTimer) {
    _refreshTimer = setInterval(() => scheduleRedditCacheRefresh(false), REFRESH_INTERVAL_MS);
    _refreshTimer.unref();
  }
  if (_refreshing) return;
  if (!force && !isRefreshDue()) {
    console.log('[QuestDatabase] Local quest database is fresh - skipping background refresh.');
    return;
  }

  _refreshing = true;
  refreshQuestDatabase()
    .catch((err) => console.error('[QuestDatabase] Refresh failed:', err))
    .finally(() => {
      _refreshing = false;
    });
}

