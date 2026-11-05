/**
 * Turns Discord's list of detectable games
 * (https://discord.com/api/v9/applications/detectable) into the compact game
 * database the app ships and downloads (src/server/gameDatabase.json).
 *
 * Only Windows executables are kept, launchers and entries that need
 * command-line arguments are dropped, and each
 * executable keeps the folder part Discord matches on: Discord recognises
 * VALORANT only when the running file's path ends in
 * `win64/valorant-win64-shipping.exe`, so the placeholder is written to that
 * same relative path.
 */

export const DISCORD_DETECTABLE_URL = 'https://discord.com/api/v9/applications/detectable';

export interface DatabaseGame {
  /** Discord application id. */
  id: string;
  name: string;
  /** Other names Discord knows the game by. */
  aliases?: string[];
  /** Windows executables as Discord matches them, e.g. `win64/valorant-win64-shipping.exe`. */
  executables: string[];
  /** Icon hash on cdn.discordapp.com/app-icons/<id>/<icon>.png. */
  icon?: string;
  /** `reddit`: an executable Discord's list does not give, read from r/DiscordQuests. */
  source?: 'reddit';
  /** The r/DiscordQuests post a `reddit` entry comes from. */
  url?: string;
  /**
   * A `reddit` quest Discord only detects through Steam: the placeholder goes
   * to `steamapps/common/<installDir>/` of the Steam library, next to an
   * `appmanifest_<appId>.acf`. Its executables are relative to that folder.
   */
  steam?: SteamQuest;
  /** Website of a `reddit` program Discord has no icon for; its icon is used instead. */
  site?: string;
}

export interface SteamQuest {
  appId: number;
  installDir: string;
}

export interface GameDatabase {
  source: string;
  /** When the game list last changed. */
  generatedAt: string;
  games: DatabaseGame[];
}

const NTFS_ILLEGAL = /[<>:"|?*\x00-\x1F]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * A Discord executable entry as a safe relative path, or null. A leading `>`
 * (Discord's marker for a bare file name) is dropped; `..`, drive letters and
 * characters Windows does not allow are refused.
 */
export function normalizeExecutablePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const segments = value.trim().replace(/^>/, '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > 8) return null;
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed !== segment || segment === '.' || segment === '..') return null;
    if (NTFS_ILLEGAL.test(segment) || RESERVED_NAMES.test(segment) || /[. ]$/.test(segment)) return null;
  }
  const file = segments[segments.length - 1];
  if (!/\.exe$/i.test(file)) return null;
  return segments.join('/').toLowerCase();
}

/** The last part of an executable path: `win64/x.exe` -> `x.exe`. */
export function executableFileName(executable: string): string {
  return executable.replace(/\\/g, '/').split('/').pop() ?? executable;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/** One game of Discord's list, or null when it has no usable Windows executable. */
export function toDatabaseGame(raw: unknown): DatabaseGame | null {
  if (!raw || typeof raw !== 'object') return null;
  const app = raw as Record<string, unknown>;
  // Discord application ids are numbers; `r-<name>` marks an r/DiscordQuests entry without one.
  const id = typeof app.id === 'string' && /^(?:\d{5,25}|r-[a-z0-9]{1,60})$/.test(app.id) ? app.id : '';
  const name = cleanName(app.name);
  if (!id || !name) return null;

  const executables: string[] = [];
  for (const entry of Array.isArray(app.executables) ? app.executables : []) {
    if (!entry || typeof entry !== 'object') continue;
    const exe = entry as Record<string, unknown>;
    // A launcher is not the game, and an entry that needs command-line
    // arguments (Source games' `-game tf`) cannot be matched by a placeholder.
    if (exe.os !== 'win32' || exe.is_launcher === true) continue;
    if (typeof exe.arguments === 'string' && exe.arguments.trim()) continue;
    const normalized = normalizeExecutablePath(exe.name);
    if (normalized && !executables.includes(normalized)) executables.push(normalized);
  }
  if (executables.length === 0) return null;

  const aliases: string[] = [];
  for (const alias of Array.isArray(app.aliases) ? app.aliases : []) {
    const clean = cleanName(alias);
    if (
      clean &&
      clean.toLowerCase() !== name.toLowerCase() &&
      !aliases.some((a) => a.toLowerCase() === clean.toLowerCase())
    ) {
      aliases.push(clean);
    }
  }
  const icon = typeof app.icon_hash === 'string' && /^[a-f0-9]{32}$/.test(app.icon_hash) ? app.icon_hash : undefined;

  const fromReddit = app.source === 'reddit';
  const url =
    fromReddit && typeof app.url === 'string' && /^https:\/\/www\.reddit\.com\//.test(app.url) ? app.url : undefined;
  const steam = fromReddit ? toSteamQuest(app.steam) : undefined;
  const site = fromReddit && !icon ? toSite(app.site) : undefined;
  return {
    id,
    name,
    ...(aliases.length ? { aliases } : {}),
    executables,
    ...(icon ? { icon } : {}),
    ...(fromReddit ? { source: 'reddit' as const } : {}),
    ...(url ? { url } : {}),
    ...(steam ? { steam } : {}),
    ...(site ? { site } : {}),
  };
}

/** A folder name Windows and Steam accept as a `steamapps/common` entry, or null. */
export function safeInstallDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const dir = value.trim();
  if (!dir || dir.length > 120 || dir === '.' || dir === '..') return null;
  if (/[\\/]/.test(dir) || NTFS_ILLEGAL.test(dir) || RESERVED_NAMES.test(dir) || /[. ]$/.test(dir)) return null;
  return dir;
}

function toSteamQuest(value: unknown): SteamQuest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const appId = Number(raw.appId);
  const installDir = safeInstallDir(raw.installDir);
  if (!Number.isSafeInteger(appId) || appId <= 0 || !installDir) return undefined;
  return { appId, installDir };
}

/** A bare host name such as `firefox.com`, or undefined. */
function toSite(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const site = value.trim().toLowerCase();
  return site.length <= 100 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(site) ? site : undefined;
}

/** Sorted by name, the order of the file. */
export function sortGames(games: DatabaseGame[]): DatabaseGame[] {
  return [...games].sort(
    (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  );
}

/** The compact database for Discord's whole list, sorted by name. */
export function buildGameDatabase(list: unknown, generatedAt: string): GameDatabase {
  if (!Array.isArray(list)) throw new Error('Discord did not send a list of applications.');
  const byId = new Map<string, DatabaseGame>();
  for (const raw of list) {
    const game = toDatabaseGame(raw);
    if (game && !byId.has(game.id)) byId.set(game.id, game);
  }
  return { source: DISCORD_DETECTABLE_URL, generatedAt, games: sortGames([...byId.values()]) };
}

/** True when two databases list the same games (the date is ignored). */
export function sameGames(a: Pick<GameDatabase, 'games'>, b: Pick<GameDatabase, 'games'>): boolean {
  return JSON.stringify(a.games) === JSON.stringify(b.games);
}

/** The file format: one game per line, so a git diff shows which games changed. */
export function serializeGameDatabase(database: GameDatabase): string {
  const lines = database.games.map((game) => JSON.stringify(game));
  return (
    `{"source":${JSON.stringify(database.source)},"generatedAt":${JSON.stringify(database.generatedAt)},"games":[\n` +
    `${lines.join(',\n')}\n]}\n`
  );
}
