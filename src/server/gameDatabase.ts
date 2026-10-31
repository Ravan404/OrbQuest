/**
 * gameDatabase.ts
 *
 * The game database: Discord's list of detectable games in compact form
 * (gameDatabaseSource.ts). Everything the catalog shows and every executable
 * the app writes comes from it.
 *
 *   1. The bundled copy (gameDatabase.json) is imported, so esbuild bakes it
 *      into dist/server.cjs and the desktop app always has it.
 *   2. Every six hours the app downloads the published copy
 *      (publishedDatabase.ts). A newer one replaces the bundled one and is
 *      kept in `Games/.game-database.json`, so it also works offline.
 *   3. Only when the published copy cannot be reached for a day does the app
 *      read Discord's list itself.
 *
 * Searches read the in-memory index; they never touch the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR, OFFLINE } from './config.ts';
import { APP_VERSION } from '../version.ts';
import { gameNameMatchRank, normalizeGameKey } from './gameKey.ts';
import { writeJsonAtomic } from './fsUtil.ts';
import bundledDatabase from './gameDatabase.json';
import featured from './featuredGames.json';
import {
  DISCORD_DETECTABLE_URL,
  buildGameDatabase,
  executableFileName,
  normalizeExecutablePath,
  sameGames,
  toDatabaseGame,
  type DatabaseGame,
  type GameDatabase,
} from './gameDatabaseSource.ts';
import { fetchPublishedDatabase, PUBLISHED_DATABASE_URLS } from './publishedDatabase.ts';

export type { DatabaseGame } from './gameDatabaseSource.ts';

const LOCAL_FILE = path.join(GAMES_DIR, '.game-database.json');
/** How often the published database is checked (also while the app stays open). */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Discord itself is asked at most this often, and only when the published file is unreachable. */
const DIRECT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Discord's full list is about 13 MB. */
const DIRECT_MAX_BYTES = 64 * 1024 * 1024;

/** `DQR_DATABASE_REFRESH=1` forces a check at start, `=0` disables it (DQR_REDDIT_CACHE_REFRESH, the 1.3.0 name, still works). */
const REFRESH_MODE = (process.env.DQR_DATABASE_REFRESH ?? process.env.DQR_REDDIT_CACHE_REFRESH ?? '').trim();

interface LocalFile {
  /** Last successful check (published copy or Discord). */
  checkedAt?: string;
  etag?: string;
  /** The downloaded database, when it is newer than the bundled one. */
  database?: GameDatabase;
}

interface IndexedGame {
  game: DatabaseGame;
  /** Name and aliases with their comparison keys. */
  names: { name: string; key: string }[];
  /** File names of the executables, lower-cased. */
  files: string[];
}

let _database: GameDatabase = { source: DISCORD_DETECTABLE_URL, generatedAt: '', games: [] };
let _bundledAt = '';
let _downloaded = false;
let _checkedAt = '';
let _etag = '';
let _index: IndexedGame[] = [];
let _byId = new Map<string, DatabaseGame>();
let _byFile = new Map<string, DatabaseGame[]>();
let _persist = false;
let _refreshing = false;
let _refreshTimer: NodeJS.Timeout | undefined;

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function isNewer(candidate: string | undefined, than: string): boolean {
  return Boolean(candidate) && !Number.isNaN(Date.parse(candidate!)) && (!than || Date.parse(candidate!) > Date.parse(than));
}

/** Untrusted input (a download, the local file) as a database, or null. */
function validDatabase(value: unknown): GameDatabase | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GameDatabase>;
  if (!Array.isArray(raw.games) || typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) return null;
  // The compact form uses the same field names as Discord's, so it goes through the same checks.
  const games = raw.games
    .map((game) => {
      const g = game as Partial<DatabaseGame>;
      return toDatabaseGame({
        id: g?.id,
        name: g?.name,
        aliases: g?.aliases,
        icon_hash: g?.icon,
        executables: Array.isArray(g?.executables) ? g.executables.map((name) => ({ name, os: 'win32' })) : [],
      });
    })
    .filter((game): game is DatabaseGame => Boolean(game));
  if (games.length === 0) return null;
  return { source: typeof raw.source === 'string' ? raw.source : DISCORD_DETECTABLE_URL, generatedAt: raw.generatedAt, games };
}

function useDatabase(database: GameDatabase): void {
  _database = database;
  _byId = new Map(database.games.map((game) => [game.id, game]));
  _byFile = new Map();
  _index = database.games.map((game) => {
    const files = [...new Set(game.executables.map((exe) => executableFileName(exe)))];
    for (const file of files) _byFile.set(file, [...(_byFile.get(file) ?? []), game]);
    return {
      game,
      names: [game.name, ...(game.aliases ?? [])].map((name) => ({ name, key: normalizeGameKey(name) })),
      files,
    };
  });
}

function saveLocal(): void {
  if (!_persist) return;
  const data: LocalFile = {
    checkedAt: _checkedAt || undefined,
    etag: _etag || undefined,
    database: _downloaded ? _database : undefined,
  };
  try {
    writeJsonAtomic(LOCAL_FILE, data);
  } catch (error) {
    console.warn('[GameDatabase] Could not save the downloaded database:', error);
  }
}

/** Loads the bundled database and a newer downloaded one. Called once at start. */
export function loadGameDatabase(): void {
  const bundled = bundledDatabase as GameDatabase;
  _bundledAt = bundled.generatedAt;
  _downloaded = false;
  useDatabase(bundled);
  _checkedAt = _etag = '';
  try {
    if (fs.existsSync(LOCAL_FILE)) {
      const local = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) as LocalFile;
      _checkedAt = typeof local.checkedAt === 'string' ? local.checkedAt : '';
      _etag = typeof local.etag === 'string' ? local.etag : '';
      const downloaded = validDatabase(local.database);
      if (downloaded && isNewer(downloaded.generatedAt, _bundledAt)) {
        useDatabase(downloaded);
        _downloaded = true;
      }
    }
  } catch {
    console.warn(`[GameDatabase] Ignoring unreadable file ${LOCAL_FILE}.`);
  }
  _persist = true;
  console.log(
    `[GameDatabase] ${_database.games.length} games from Discord's list (updated ${_database.generatedAt}, ${_downloaded ? 'downloaded' : 'bundled'}).`
  );
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function getGameById(id: string | undefined): DatabaseGame | undefined {
  return id ? _byId.get(id) : undefined;
}

/** The games shown on the catalog page before anything is searched. */
export function getFeaturedGames(): DatabaseGame[] {
  return featured.ids.map((id) => _byId.get(id)).filter((game): game is DatabaseGame => Boolean(game));
}

/**
 * The game an executable belongs to. A path (`win64/valorant-win64-shipping.exe`)
 * must match Discord's path; a bare file name only counts when one game uses it.
 */
export function findGameByExecutable(executable: string | undefined): DatabaseGame | undefined {
  const normalized = normalizeExecutablePath(executable);
  if (!normalized) return undefined;
  const candidates = _byFile.get(executableFileName(normalized)) ?? [];
  // The given path may be longer than Discord's (`Games/VALORANT/win64/...`), never shorter.
  const exact = candidates.find((game) =>
    game.executables.some((exe) => exe === normalized || normalized.endsWith(`/${exe}`))
  );
  if (exact) return exact;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The game with exactly this name or alias. */
export function findGameByName(name: string | undefined): DatabaseGame | undefined {
  const key = normalizeGameKey(name);
  if (!key) return undefined;
  return _index.find((entry) => entry.names.some((n) => n.key === key))?.game;
}

/**
 * Games for a search, best first: exact name, then names starting with the
 * query, then names containing it (a short query only matches at a word
 * start), then a name the query starts with ("overwatch 2" finds
 * "Overwatch"), then an executable file name. Within a rank the featured
 * (quest) games come first. Never touches the network.
 */
export function searchGames(query: string, limit = 50): DatabaseGame[] {
  const key = normalizeGameKey(query);
  if (key.length < 2) return [];
  const featuredIds = new Set(featured.ids);
  const exeQuery = query.trim().toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  const ranked: { game: DatabaseGame; rank: number }[] = [];
  for (const entry of _index) {
    let rank = Infinity;
    for (const { name, key: nameKey } of entry.names) {
      const r = gameNameMatchRank(name, nameKey, key);
      if (r >= 0 && r < rank) rank = r;
    }
    if (rank === Infinity && entry.names.some((n) => n.key.length >= 5 && key.startsWith(n.key))) rank = 3;
    if (rank === Infinity && exeQuery.length >= 4 && entry.files.some((file) => file.includes(exeQuery))) rank = 4;
    if (rank !== Infinity) ranked.push({ game: entry.game, rank });
  }
  const isFeatured = (game: DatabaseGame) => (featuredIds.has(game.id) ? 0 : 1);
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      isFeatured(a.game) - isFeatured(b.game) ||
      a.game.name.length - b.game.name.length ||
      a.game.name.localeCompare(b.game.name)
  );
  return ranked.slice(0, limit).map((item) => item.game);
}

export interface GameDatabaseInfo {
  updatedAt: string;
  games: number;
  /** `bundled` with the build, or `downloaded` later. */
  from: 'bundled' | 'downloaded';
  checkedAt: string;
}

export function getGameDatabaseInfo(): GameDatabaseInfo {
  return {
    updatedAt: _database.generatedAt,
    games: _database.games.length,
    from: _downloaded ? 'downloaded' : 'bundled',
    checkedAt: _checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

function isOlderThan(timestamp: string, ms: number): boolean {
  return !timestamp || Number.isNaN(Date.parse(timestamp)) || Date.now() - Date.parse(timestamp) > ms;
}

function adopt(database: GameDatabase): boolean {
  if (!isNewer(database.generatedAt, _database.generatedAt) || sameGames(database, _database)) return false;
  useDatabase(database);
  _downloaded = true;
  return true;
}

/** Discord's own list, read when the published copy has been unreachable for a day. */
async function readDiscordDirectly(fetchImpl: typeof fetch): Promise<GameDatabase | null> {
  try {
    const response = await fetchImpl(DISCORD_DETECTABLE_URL, {
      headers: { 'User-Agent': `OrbQuest/${APP_VERSION} (game database)`, Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > DIRECT_MAX_BYTES) return null;
    const text = await response.text();
    if (text.length > DIRECT_MAX_BYTES) return null;
    const database = buildGameDatabase(JSON.parse(text), new Date().toISOString());
    return database.games.length > 0 ? database : null;
  } catch {
    return null;
  }
}

/** One update check. `fetchImpl` is replaced by the tests. */
export async function refreshGameDatabase(fetchImpl: typeof fetch = fetch): Promise<void> {
  const now = new Date().toISOString();
  const result = await fetchPublishedDatabase(_etag, PUBLISHED_DATABASE_URLS, fetchImpl);
  if (result.status !== 'failed') {
    let note = 'unchanged';
    if (result.status === 'updated') {
      _etag = result.etag;
      const database = validDatabase(result.database);
      if (database && adopt(database)) note = `${database.games.length} games, updated ${database.generatedAt}`;
    }
    _checkedAt = now;
    saveLocal();
    console.log(`[GameDatabase] Published database checked via ${result.url} (${note}).`);
    return;
  }
  if (!isOlderThan(_checkedAt, DIRECT_REFRESH_INTERVAL_MS)) {
    console.warn('[GameDatabase] The published database could not be reached; trying again later.');
    return;
  }
  const direct = await readDiscordDirectly(fetchImpl);
  if (!direct) {
    console.warn('[GameDatabase] Neither the published database nor Discord answered; trying again later.');
    return;
  }
  const changed = adopt(direct);
  _checkedAt = now;
  saveLocal();
  console.log(`[GameDatabase] Discord's list read directly (${changed ? `${direct.games.length} games` : 'unchanged'}).`);
}

/**
 * Starts the background update (non-blocking) and repeats it every six hours
 * while the app runs. A check is skipped while the last one is less than six
 * hours old.
 */
export function scheduleGameDatabaseRefresh(force = REFRESH_MODE === '1'): void {
  if (REFRESH_MODE === '0' || OFFLINE) {
    console.log('[GameDatabase] Background update disabled.');
    return;
  }
  if (!_refreshTimer) {
    _refreshTimer = setInterval(() => scheduleGameDatabaseRefresh(false), REFRESH_INTERVAL_MS);
    _refreshTimer.unref();
  }
  if (_refreshing) return;
  if (!force && !isOlderThan(_checkedAt, REFRESH_INTERVAL_MS)) return;
  _refreshing = true;
  refreshGameDatabase()
    .catch((error) => console.error('[GameDatabase] Update failed:', error))
    .finally(() => {
      _refreshing = false;
    });
}
