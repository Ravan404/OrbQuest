/**
 * questDatabaseSource.ts
 *
 * The r/DiscordQuests snapshots the bundled quest database is built from
 * (`data/reddit/dataset_reddit-*.json`) and the build itself.
 *
 * Used by process-apify.ts and scripts/update-quest-database.ts -
 * never by the running server, which only reads the finished
 * `src/server/redditCache.json` (baked into dist/server.cjs).
 *
 * Snapshot formats:
 *   - the original Apify "reddit-scraper" export: a bare JSON array of posts
 *     whose text is already rendered;
 *   - update snapshots: `{ source, fetchedAt, checkedThrough, textFormat,
 *     posts: [...] }`, usually with Reddit markdown source
 *     (`textFormat: "markdown"`).
 * Older snapshots come first; a post that appears in two snapshots is read
 * from the older one, so a hand-checked entry never changes behind the back
 * of its corrections (redditCorrections.ts).
 */

import fs from 'fs';
import path from 'path';
import { APP_VERSION } from '../version.ts';
import { normalizeGameKey } from './gameKey.ts';
import { redditPostId } from './redditCorrections.ts';
import {
  dedupeEntries,
  redditPostToEntries,
  type RedditCacheEntry,
  type RedditPostLike,
} from './redditDataset.ts';

export const DATASET_FILE_PATTERN = /^dataset_reddit-.*\.json$/;
/** Folder of the r/DiscordQuests snapshots, relative to the repository root. */
export const DATASET_DIR = path.join('data', 'reddit');

export interface DatasetPost extends RedditPostLike {
  id?: string;
  createdAt?: string;
}

export interface DatasetSnapshot {
  file: string;
  source: string;
  fetchedAt?: string;
  /** Newest subreddit post the snapshot's listing had seen; later posts are new. */
  checkedThrough?: string;
  posts: DatasetPost[];
}

export interface LoadedDataset {
  snapshots: DatasetSnapshot[];
  /** Every post once, oldest snapshot first. */
  posts: DatasetPost[];
  checkedThrough: string;
}

/** One line of the update history kept in questDatabaseInfo.ts. */
export interface QuestDatabaseUpdate {
  updatedAt: string;
  checkedThrough: string;
  entries: number;
  games: number;
  posts: number;
  sources: string[];
  note?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Newest of a list of ISO timestamps ('' when there is none). */
export function newestTimestamp(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value as string)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';
}

function newestCreatedAt(posts: DatasetPost[]): string | undefined {
  return newestTimestamp(posts.map((post) => isoOrUndefined(post.createdAt))) || undefined;
}

/** The date a snapshot file name carries ("..._2026-10-14..."), for ordering. */
function fileDate(name: string): string {
  return /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1] ?? '';
}

/** Every snapshot file in `root`, oldest first. */
export function listDatasetFiles(root: string): string[] {
  const dir = path.join(root, DATASET_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => DATASET_FILE_PATTERN.test(name))
    .sort((a, b) => fileDate(a).localeCompare(fileDate(b)) || a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

export function readDatasetSnapshot(file: string): DatasetSnapshot {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (Array.isArray(raw)) {
    const posts = raw.filter(isObject) as DatasetPost[];
    return { file, source: 'apify-reddit-scraper', checkedThrough: newestCreatedAt(posts), posts };
  }
  if (!isObject(raw) || !Array.isArray(raw.posts)) {
    throw new Error(`${file} is not a dataset snapshot (expected an array or { posts: [...] }).`);
  }
  const textFormat = raw.textFormat === 'markdown' ? 'markdown' : 'text';
  const posts = (raw.posts.filter(isObject) as DatasetPost[]).map((post) => ({
    ...post,
    textFormat: post.textFormat === 'markdown' || post.textFormat === 'text' ? post.textFormat : textFormat,
  }));
  return {
    file,
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    fetchedAt: isoOrUndefined(raw.fetchedAt),
    checkedThrough: isoOrUndefined(raw.checkedThrough) ?? newestCreatedAt(posts),
    posts,
  };
}

function postIdOf(post: DatasetPost): string | undefined {
  const id = typeof post.id === 'string' ? post.id.trim().toLowerCase() : '';
  return id || redditPostId(typeof post.url === 'string' ? post.url : post.permalink);
}

/** Reads snapshots (oldest first) into one list with every post once. */
export function loadDataset(files: string[]): LoadedDataset {
  const snapshots = files.map(readDatasetSnapshot);
  const seen = new Set<string>();
  const posts: DatasetPost[] = [];
  for (const snapshot of snapshots) {
    for (const post of snapshot.posts) {
      const id = postIdOf(post);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      posts.push(post);
    }
  }
  return { snapshots, posts, checkedThrough: newestTimestamp(snapshots.map((snapshot) => snapshot.checkedThrough)) };
}

/** Reddit post ids a dataset already contains. */
export function datasetPostIds(dataset: LoadedDataset): Set<string> {
  return new Set(dataset.posts.map(postIdOf).filter((id): id is string => Boolean(id)));
}

/** The database entries of a list of posts: canonical names, post fixes, one entry per executable. */
export function buildDatabaseEntries(posts: DatasetPost[]): RedditCacheEntry[] {
  return dedupeEntries(posts.flatMap((post) => redditPostToEntries(post)));
}

export function countGames(entries: RedditCacheEntry[]): number {
  return new Set(entries.map((entry) => normalizeGameKey(entry.gameName) || entry.gameName)).size;
}

// ---------------------------------------------------------------------------
// Writing the bundled database
// ---------------------------------------------------------------------------

export const DATABASE_JSON_PATH = path.join('src', 'server', 'redditCache.json');
export const DATABASE_INFO_PATH = path.join('src', 'server', 'questDatabaseInfo.ts');

interface BundledDatabaseFile {
  generatedAt?: string;
  version?: string;
  checkedThrough?: string;
  entries?: unknown;
}

function readJson(file: string): BundledDatabaseFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as BundledDatabaseFile;
  } catch {
    return null;
  }
}

/** The update history currently recorded in questDatabaseInfo.ts. */
export function readUpdateHistory(root: string): QuestDatabaseUpdate[] {
  try {
    const source = fs.readFileSync(path.join(root, DATABASE_INFO_PATH), 'utf-8');
    const match = /QUEST_DATABASE_UPDATE_HISTORY[^=]*=\s*(\[[\s\S]*?\n\]);/.exec(source);
    const history = match ? JSON.parse(match[1]) : [];
    return Array.isArray(history) ? history.filter(isObject) as unknown as QuestDatabaseUpdate[] : [];
  } catch {
    return [];
  }
}

function renderInfoModule(latest: QuestDatabaseUpdate, history: QuestDatabaseUpdate[]): string {
  return `/**
 * questDatabaseInfo.ts - GENERATED by process-apify.ts and
 * scripts/update-quest-database.ts. Do not edit by hand.
 *
 * When the bundled quest database (src/server/redditCache.json) was updated.
 * It is not shown in the interface: GET /api/profile reports it as
 * \`questDatabase\` and the server logs it at startup. Every update adds a line
 * to QUEST_DATABASE_UPDATE_HISTORY (newest first).
 */

export interface QuestDatabaseUpdate {
  /** When the database content last changed. */
  updatedAt: string;
  /** Newest r/DiscordQuests post the update had checked; later posts are new. */
  checkedThrough: string;
  /** Entries (one per executable) and distinct games. */
  entries: number;
  games: number;
  /** Reddit posts the database was built from. */
  posts: number;
  sources: string[];
  note?: string;
}

/** Last time the bundled database changed. */
export const QUEST_DATABASE_UPDATED_AT = ${JSON.stringify(latest.updatedAt)};
/** Newest r/DiscordQuests post the bundled database had checked. */
export const QUEST_DATABASE_CHECKED_THROUGH = ${JSON.stringify(latest.checkedThrough)};

export const QUEST_DATABASE_UPDATE_HISTORY: QuestDatabaseUpdate[] = ${JSON.stringify(history, null, 2)};
`;
}

export interface WriteDatabaseResult {
  changed: boolean;
  update: QuestDatabaseUpdate;
}

/**
 * Writes redditCache.json and questDatabaseInfo.ts.
 *
 * Nothing is written when neither the entries nor the checked range changed,
 * so rebuilding the same data never moves the update date.
 */
export function writeBundledDatabase(
  root: string,
  dataset: LoadedDataset,
  entries: RedditCacheEntry[],
  options: { note?: string; now?: Date } = {}
): WriteDatabaseResult {
  const jsonPath = path.join(root, DATABASE_JSON_PATH);
  const current = readJson(jsonPath);
  const history = readUpdateHistory(root);
  const unchanged =
    current !== null &&
    JSON.stringify(current.entries) === JSON.stringify(entries) &&
    (current.checkedThrough ?? '') === dataset.checkedThrough &&
    history.length > 0;

  const sources = Array.from(new Set(dataset.snapshots.map((snapshot) => snapshot.source)));
  if (unchanged) {
    // Same content: only the version stamp follows the app version; the
    // update date and history stay as they are.
    if (current && current.version !== APP_VERSION) {
      fs.writeFileSync(jsonPath, `${JSON.stringify({ ...current, version: APP_VERSION }, null, 2)}\n`, 'utf-8');
    }
    return { changed: false, update: history[0] };
  }

  const update: QuestDatabaseUpdate = {
    updatedAt: (options.now ?? new Date()).toISOString(),
    checkedThrough: dataset.checkedThrough,
    entries: entries.length,
    games: countGames(entries),
    posts: dataset.posts.length,
    sources,
    ...(options.note ? { note: options.note } : {}),
  };
  const nextHistory = [update, ...history];

  const output = {
    generatedAt: update.updatedAt,
    version: APP_VERSION,
    checkedThrough: update.checkedThrough,
    entries,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(path.join(root, DATABASE_INFO_PATH), renderInfoModule(update, nextHistory), 'utf-8');
  return { changed: true, update };
}
