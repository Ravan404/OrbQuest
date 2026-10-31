import {
  ensureManagedPlaceholderExecutable,
  hasPlaceholderRuntimeSignature,
  upgradeLegacyPlaceholder,
} from './placeholderUpgrade.ts';
import { performance } from 'node:perf_hooks';
import { BUFFER_PRESET_DURATIONS, MAX_QUEST_TARGET_MINUTES, type BufferPreset } from '../types.ts';
import { computeGameTimerPhase } from '../utils/timerUtils.ts';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  GAMES_DIR,
  PLACEHOLDER_EXE,
  StoredGame,
} from './config.ts';
import { isPathInside, isSafeExecutablePath } from './security.ts';
import { cacheGameIcon, discordIconUrl, localGameIcon } from './iconStore.ts';
import { findGameByExecutable, findGameByName, getGameById, type DatabaseGame } from './gameDatabase.ts';
import { isGameOrigin, type GameOrigin } from '../types.ts';
import { readSimulatedSteamManifest } from './steamManifest.ts';
import { writeJsonAtomic } from './fsUtil.ts';

/**
 * In-memory game store + process lifecycle.
 *
 * Running state is volatile by design (the child process dies with the
 * server). The accumulated quest runtime (`elapsedSeconds`) is persisted to
 * `Games/.state.json` so an interrupted run can resume, but a COMPLETED
 * quest counter is deliberately reset on every launcher restart: a finished
 * quest is a closed event, so the library always starts a new day at 00:00.
 */

export const gamesMap = new Map<string, StoredGame>();

// ---------------------------------------------------------------
// Per-game metadata (origin / provenance)
// ---------------------------------------------------------------

/**
 * Provenance marker stored next to the game's placeholder executable.
 *
 * Keeping it inside the game folder (instead of a central index) means it
 * survives folder moves and never desynchronises from the entry it belongs
 * to. Entries without the file are library folders found by the scan.
 */
export const GAME_META_FILE_NAME = '.game-meta.json';

export interface GameMeta {
  /** Stable library id, persisted when it cannot be derived from the folder name. */
  id?: string;
  name?: string;
  executable?: string;
  origin?: GameOrigin;
  addedAt?: string;
  specialRootPath?: string;
  steamAppId?: number;
  /** Discord application id of a game added from the catalog. */
  appId?: string;
}

/**
 * The executable Discord expects for a game (e.g. `win64/valorant-win64-shipping.exe`),
 * used when a managed game folder's `.exe` was removed by an antivirus scan.
 * The game is found by its Discord id, its name or its folder name.
 */
export function inferKnownExecutableForGame(displayName: string, folderName: string, appId?: string): string | undefined {
  const game = getGameById(appId) ?? findGameByName(displayName) ?? findGameByName(path.basename(folderName.trim()));
  return game?.executables[0];
}

/** Ids we are willing to restore from a metadata file. */
function isStableGameId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,80}$/.test(value);
}

/**
 * Library id for a folder.
 *
 * "Foo Bar" and "Foo-Bar" both used to become `foo-bar`, and the second folder
 * was silently dropped on every scan. A preferred id from `.game-meta.json`
 * is kept so the disambiguated id survives a restart.
 */
export function allocateLibraryId(folderName: string, preferred?: string): string {
  const base = folderName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '') || 'game';
  const takenByOther = (id: string) => {
    const existing = gamesMap.get(id);
    return Boolean(existing && existing.folder !== folderName);
  };
  if (preferred && isStableGameId(preferred) && !takenByOther(preferred)) return preferred;
  if (!takenByOther(base)) return base;
  let suffix = 2;
  while (takenByOther(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function gameMetaPath(folder: string): string {
  return path.join(GAMES_DIR, folder, GAME_META_FILE_NAME);
}

export function readGameMeta(folder: string): GameMeta {
  try {
    const file = gameMetaPath(folder);
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<GameMeta>;
    const rawExe = typeof parsed.executable === 'string' ? parsed.executable.trim() : '';
    return {
      id: typeof parsed.id === 'string' && isStableGameId(parsed.id) ? parsed.id : undefined,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined,
      executable: rawExe && isSafeExecutablePath(rawExe) ? rawExe.replace(/\\/g, '/') : undefined,
      origin: isGameOrigin(parsed.origin) ? parsed.origin : undefined,
      addedAt: typeof parsed.addedAt === 'string' ? parsed.addedAt : undefined,
      specialRootPath: typeof parsed.specialRootPath === 'string' ? parsed.specialRootPath : undefined,
      steamAppId: Number.isSafeInteger(parsed.steamAppId) ? parsed.steamAppId : undefined,
      appId: typeof parsed.appId === 'string' && /^(?:\d{5,25}|r-[a-z0-9]{1,60})$/.test(parsed.appId) ? parsed.appId : undefined,
    };
  } catch {
    return {};
  }
}

export function writeGameMeta(folder: string, meta: GameMeta): void {
  try {
    const folderPath = path.join(GAMES_DIR, folder);
    if (!isPathInside(GAMES_DIR, folderPath) || !fs.existsSync(folderPath)) return;
    const file = gameMetaPath(folder);
    const merged: GameMeta = { ...readGameMeta(folder), ...meta };
    for (const key of Object.keys(merged) as (keyof GameMeta)[]) {
      if (merged[key] === undefined) delete merged[key];
    }
    writeJsonAtomic(file, merged);
  } catch (e) {
    console.warn('Could not write game metadata:', e);
  }
}

/** Origin shown when a folder carries no provenance marker of its own. */
export function resolveGameOrigin(meta: GameMeta): GameOrigin {
  return meta.origin ?? 'scanned';
}

// ---------------------------------------------------------------
// Persisted quest progress and timer preferences
// ---------------------------------------------------------------

const STATE_FILE = () => path.join(GAMES_DIR, '.state.json');
const SPECIAL_GAMES_FILE = () => path.join(GAMES_DIR, '.special-games.json');
export interface SpecialGameRecord {
  id: string;
  rootPath: string;
  installDir: string;
  executable: string;
  name: string;
  steamAppId: number;
}
let lastStateSave = 0;

interface PersistedEntry {
  elapsedSeconds: number;
  updatedAt: number;
  targetMinutes?: number;
  bufferPreset?: BufferPreset;
  autoStop?: boolean;
  completed?: boolean;
}

interface PersistedState {
  [gameId: string]: PersistedEntry;
}

export interface TimerPreferences {
  targetMinutes?: number;
  bufferPreset?: BufferPreset;
  autoStop?: boolean;
}

/** 0 means "no limit"; anything else is 1..MAX_QUEST_TARGET_MINUTES whole minutes. */
export function isValidTargetMinutes(value: unknown): boolean {
  const target = Number(value);
  return Number.isInteger(target) && target >= 0 && target <= MAX_QUEST_TARGET_MINUTES;
}

export function isBufferPreset(value: unknown): value is BufferPreset {
  return typeof value === 'string' && Object.hasOwn(BUFFER_PRESET_DURATIONS, value);
}

/**
 * Validates a timer-preference payload. Returns the cleaned preferences, or an
 * error message. Only the fields that are present are returned.
 */
export function parseTimerPreferences(body: Record<string, unknown>): TimerPreferences | string {
  const prefs: TimerPreferences = {};
  if (body.targetMinutes !== undefined) {
    if (!isValidTargetMinutes(body.targetMinutes)) return 'Invalid timer settings.';
    prefs.targetMinutes = Number(body.targetMinutes);
  }
  if (body.bufferPreset !== undefined) {
    if (!isBufferPreset(body.bufferPreset)) return 'Invalid timer settings.';
    prefs.bufferPreset = body.bufferPreset;
  }
  if (body.autoStop !== undefined) {
    if (typeof body.autoStop !== 'boolean') return 'Invalid timer settings.';
    prefs.autoStop = body.autoStop;
  }
  return prefs;
}

export function applyTimerPreferences(game: StoredGame, prefs: TimerPreferences): void {
  if (prefs.targetMinutes !== undefined) game.targetMinutes = prefs.targetMinutes;
  if (prefs.bufferPreset !== undefined) game.bufferPreset = prefs.bufferPreset;
  if (prefs.autoStop !== undefined) game.autoStop = prefs.autoStop;
}

function hasTimerPreferences(game: StoredGame): boolean {
  return game.targetMinutes !== undefined || game.bufferPreset !== undefined || game.autoStop !== undefined;
}

export function loadPersistedState(): void {
  let droppedFinishedCounters = false;
  try {
    const file = STATE_FILE();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as PersistedState;
    if (!raw || typeof raw !== 'object') return;
    for (const game of gamesMap.values()) {
      const entry = raw[game.id];
      if (!entry || typeof entry !== 'object') continue;

      // Timer preferences survive a restart independently of the counter.
      const hasKnownPreset = isBufferPreset(entry.bufferPreset);
      if (hasKnownPreset) game.bufferPreset = entry.bufferPreset;
      if (isValidTargetMinutes(entry.targetMinutes)) game.targetMinutes = Number(entry.targetMinutes);
      if (typeof entry.autoStop === 'boolean') game.autoStop = entry.autoStop;

      const savedSeconds = Number.isFinite(entry.elapsedSeconds) ? Math.max(0, Math.floor(entry.elapsedSeconds)) : 0;
      const finished = entry.completed === true;

      // A COMPLETED quest counter is never restored: restarting the launcher
      // always shows a finished quest back at 00:00. Legacy entries without a
      // known buffer preset counted pre-spawn time and cannot be credited.
      if (finished || savedSeconds <= 0 || !hasKnownPreset) {
        if (finished || savedSeconds > 0) droppedFinishedCounters = true;
        game.elapsedSeconds = 0;
        game.completed = false;
        continue;
      }

      game.elapsedSeconds = savedSeconds;
      game.completed = false;
    }
  } catch (e) {
    console.warn('Could not load persisted quest progress:', e);
    return;
  }
  // Rewrite the file so the finished counters are gone from disk as well and
  // cannot come back through a later throttled save. Timer preferences stay.
  if (droppedFinishedCounters) savePersistedState(true);
}

export function savePersistedState(force = false): void {
  const now = Date.now();
  if (!force && now - lastStateSave < 30_000) return;
  try {
    const data: PersistedState = {};
    for (const game of gamesMap.values()) {
      if (game.elapsedSeconds <= 0 && !hasTimerPreferences(game)) continue;
      data[game.id] = {
        elapsedSeconds: game.elapsedSeconds,
        updatedAt: now,
        targetMinutes: game.targetMinutes,
        bufferPreset: game.bufferPreset,
        autoStop: game.autoStop,
        completed: game.completed,
      };
    }
    writeJsonAtomic(STATE_FILE(), data);
    lastStateSave = now;
  } catch (e) {
    console.warn('Could not persist quest progress:', e);
  }
}

function readSpecialGames(): SpecialGameRecord[] {
  const file = SPECIAL_GAMES_FILE();
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? (parsed as SpecialGameRecord[]) : [];
}

export function saveSpecialGame(record: SpecialGameRecord): void {
  try {
    const next = readSpecialGames().filter((item) => item.id !== record.id);
    next.push(record);
    writeJsonAtomic(SPECIAL_GAMES_FILE(), next);
  } catch (error) {
    console.warn('Could not persist simulated Steam game:', error);
  }
}

export function removeSpecialGame(id: string): void {
  try {
    if (!fs.existsSync(SPECIAL_GAMES_FILE())) return;
    writeJsonAtomic(SPECIAL_GAMES_FILE(), readSpecialGames().filter((item) => item.id !== id));
  } catch (error) {
    console.warn('Could not update simulated Steam game registry:', error);
  }
}

// ---------------------------------------------------------------
// Logo resolution (fire-and-forget, cached, write-back)
// ---------------------------------------------------------------

/** The Discord database game a library entry is: by its id, its executable or its exact name. */
export function databaseGameFor(game: Pick<StoredGame, 'appId' | 'executable' | 'name'>): DatabaseGame | undefined {
  return getGameById(game.appId) ?? findGameByExecutable(game.executable) ?? findGameByName(game.name);
}

/**
 * Sets the game's icon: the saved copy, or Discord's CDN address while the
 * icon is saved in the background. A game Discord does not know has none.
 */
export function kickoffLogo(game: StoredGame): void {
  if (game.logoUrl?.startsWith('/') || game.logoPromise) return;
  const match = databaseGameFor(game);
  if (!match) return;
  const local = localGameIcon(match);
  if (local) {
    game.logoUrl = local;
    return;
  }
  game.logoUrl = discordIconUrl(match);
  if (!game.logoUrl) return;
  game.logoPromise = cacheGameIcon(match).then((url) => {
    game.logoPromise = undefined;
    if (url) game.logoUrl = url;
    return url;
  });
}

// ---------------------------------------------------------------
// Library scan
// ---------------------------------------------------------------

async function scanGamesDir(): Promise<void> {
  if (!fs.existsSync(GAMES_DIR)) {
    try {
      fs.mkdirSync(GAMES_DIR, { recursive: true });
    } catch (e) {
      console.warn('Could not create Games directory', e);
    }
    return;
  }

  try {
    // Steam-manifest installs written into a real Steam library.
    for (const record of readSpecialGames()) {
      const folder = path.join('special', record.installDir);
      const installFolder = path.join(record.rootPath, 'common', record.installDir);
      const executablePath = path.join(installFolder, record.executable);
      if (!fs.existsSync(executablePath) && fs.existsSync(path.join(installFolder, '.dqr-managed.json'))) {
        ensureManagedPlaceholderExecutable(executablePath, PLACEHOLDER_EXE);
      } else if (fs.existsSync(executablePath)) {
        upgradeLegacyPlaceholder(executablePath, PLACEHOLDER_EXE);
      }
      if (!fs.existsSync(executablePath) || gamesMap.has(record.id)) continue;
      gamesMap.set(record.id, {
        id: record.id,
        name: record.name,
        folder,
        executable: record.executable,
        isRunning: false,
        elapsedSeconds: 0,
        origin: 'catalog',
        specialRootPath: record.rootPath,
        steamAppId: record.steamAppId,
      });
    }
    const folders = fs.readdirSync(GAMES_DIR, { withFileTypes: true });
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      // Hidden folders and the local steamapps copy.
      if (folder.name.startsWith('.') || folder.name.toLowerCase() === 'steamapps') continue;
      const folderPath = path.join(GAMES_DIR, folder.name);
      let files: string[] = [];
      try {
        files = fs.readdirSync(folderPath);
      } catch {
        continue;
      }

      // Read .game-name.txt if available
      let storedName = '';
      const nameFile = path.join(folderPath, '.game-name.txt');
      if (fs.existsSync(nameFile)) {
        try {
          storedName = fs.readFileSync(nameFile, 'utf-8').trim();
        } catch {}
      }

      // Provenance marker (custom / catalog) written when the entry was added
      const meta = readGameMeta(folder.name);
      const hintedName = meta.name || storedName || folder.name;
      const metaExe = meta.executable && isSafeExecutablePath(meta.executable) ? meta.executable : '';
      const knownExe = metaExe || inferKnownExecutableForGame(hintedName, folder.name, meta.appId);
      const fallbackExe = `${folder.name.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'game'}.exe`;

      // Find executable or restore if the placeholder was removed by AV.
      // Catalog games keep theirs in a subfolder (`win64/x.exe`), as Discord expects.
      let exeName = '';
      const actualExe = files.find((f) => f.toLowerCase().endsWith('.exe'));
      if (metaExe && fs.existsSync(path.join(folderPath, metaExe))) {
        exeName = metaExe;
        if (!folder.isSymbolicLink()) upgradeLegacyPlaceholder(path.join(folderPath, metaExe), PLACEHOLDER_EXE);
      } else if (actualExe) {
        const actualPath = path.join(folderPath, actualExe);
        if (
          !folder.isSymbolicLink() &&
          knownExe &&
          actualExe.toLowerCase() === fallbackExe.toLowerCase() &&
          knownExe.toLowerCase() !== actualExe.toLowerCase() &&
          hasPlaceholderRuntimeSignature(actualPath)
        ) {
          exeName = knownExe;
          ensureManagedPlaceholderExecutable(path.join(folderPath, exeName), PLACEHOLDER_EXE);
          try {
            fs.rmSync(actualPath, { force: true });
          } catch {}
        } else {
          exeName = actualExe;
          if (!folder.isSymbolicLink()) upgradeLegacyPlaceholder(actualPath, PLACEHOLDER_EXE);
        }
      } else {
        exeName = knownExe || fallbackExe;
        if (!folder.isSymbolicLink()) {
          ensureManagedPlaceholderExecutable(path.join(folderPath, exeName), PLACEHOLDER_EXE);
        }
      }

      const displayName = meta.name || storedName || findGameByExecutable(exeName)?.name || folder.name;

      const id = allocateLibraryId(folder.name, meta.id);
      const defaultId = folder.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '') || 'game';
      // Persist disambiguated id and executable name so folder metadata survives AV quarantine.
      if ((id !== defaultId && meta.id !== id) || meta.executable !== exeName) {
        writeGameMeta(folder.name, { ...(id !== defaultId ? { id } : {}), executable: exeName });
      }

      const existing = gamesMap.get(id);
      if (!existing) {
        const game: StoredGame = {
          id,
          name: displayName,
          folder: folder.name,
          executable: exeName,
          isRunning: false,
          elapsedSeconds: 0,
          origin: resolveGameOrigin(meta),
          addedAt: meta.addedAt,
          specialRootPath: meta.specialRootPath,
          steamAppId: meta.steamAppId,
          appId: meta.appId,
        };
        gamesMap.set(id, game);
        // Logo resolution is intentionally fire-and-forget: it must never
        // block startup or the 1 Hz status poll.
        kickoffLogo(game);
      } else {
        existing.executable = exeName;
        existing.name = displayName;
        if (!existing.logoUrl) kickoffLogo(existing);
      }
    }

    // Simulated Steam layout used by catalog discoveries:
    // Games/steamapps/appmanifest_<appid>.acf and
    // Games/steamapps/common/<installdir>/<game>.exe
    const steamAppsDir = path.join(GAMES_DIR, 'steamapps');
    const commonDir = path.join(steamAppsDir, 'common');
    if (fs.existsSync(steamAppsDir) && fs.existsSync(commonDir)) {
      for (const entry of fs.readdirSync(steamAppsDir)) {
        if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
        try {
          const manifest = readSimulatedSteamManifest(path.join(steamAppsDir, entry));
          const folderPath = path.join(commonDir, manifest.installDir);
          const folder = path.join('steamapps', 'common', manifest.installDir);
          const meta = readGameMeta(folder);
          const files = fs.existsSync(folderPath) ? fs.readdirSync(folderPath) : [];
          let executable = files.find((file) => file.toLowerCase().endsWith('.exe'));
          if (!executable) {
            const recoveredExe =
              meta.executable || inferKnownExecutableForGame(meta.name || manifest.name, manifest.installDir);
            if (recoveredExe && ensureManagedPlaceholderExecutable(path.join(folderPath, recoveredExe), PLACEHOLDER_EXE)) {
              executable = recoveredExe;
            }
          } else {
            upgradeLegacyPlaceholder(path.join(folderPath, executable), PLACEHOLDER_EXE);
          }
          if (!executable) {
            console.warn(`Simulated Steam manifest has no executable: ${entry}`);
            continue;
          }
          const id = `steam-${manifest.appId}`;
          if (gamesMap.has(id)) continue;
          const game: StoredGame = {
            id,
            name: meta.name || manifest.name,
            folder,
            executable,
            isRunning: false,
            elapsedSeconds: 0,
            origin: resolveGameOrigin(meta),
            addedAt: meta.addedAt,
            specialRootPath: meta.specialRootPath,
            steamAppId: meta.steamAppId ?? manifest.appId,
          };
          gamesMap.set(id, game);
          kickoffLogo(game);
        } catch (error) {
          console.warn(`Could not scan simulated Steam manifest "${entry}":`, error);
        }
      }
    }
  } catch (err) {
    console.error('Error scanning Games directory:', err);
  }
}

export async function initGameStore(): Promise<void> {
  await scanGamesDir();
  loadPersistedState();
}

/**
 * Drops entries whose folder under Games/ was deleted outside the app. A
 * missing executable is not enough (antivirus quarantine is repaired by the
 * scan); only a missing folder means the user removed the game. Running
 * entries and Steam-library installs are left alone.
 */
function pruneDeletedFolders(): void {
  let removed = 0;
  for (const [key, game] of gamesMap) {
    if (game.isRunning || game.specialRootPath) continue;
    if (fs.existsSync(path.join(GAMES_DIR, game.folder))) continue;
    gamesMap.delete(key);
    removed++;
  }
  if (removed > 0) savePersistedState(true);
}

export async function rescanGamesDir(): Promise<void> {
  await scanGamesDir();
  pruneDeletedFolders();
}

// ---------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------

/** Only the backend advances time. Monotonic clocks survive wall-clock adjustments. */
export function beginGameSession(game: StoredGame, now = performance.now()): void {
  const config = BUFFER_PRESET_DURATIONS[game.bufferPreset ?? 'normal'];
  if (game.completed) game.elapsedSeconds = 0;
  game.completed = false;
  const resumed = game.elapsedSeconds > 0;
  // Partial initial warmup is not credited across a stopped process.
  const base = resumed ? Math.max(config.start, game.elapsedSeconds) : 0;
  game.session = { started: now, base, warmup: config.start, resumed };
  game.startedAt = Date.now();
  game.isRunning = true;
  game.warmupRemainingSeconds = config.start;
}

export function updateGameElapsed(game: StoredGame, now = performance.now()): void {
  if (!game.isRunning || !game.session) return;
  const { started, base, warmup, resumed } = game.session;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  game.warmupRemainingSeconds = Math.max(0, warmup - seconds);
  game.elapsedSeconds = base + (resumed ? Math.max(0, seconds - warmup) : seconds);
  const phase = computeGameTimerPhase(game.elapsedSeconds, game.targetMinutes, game.bufferPreset, game.warmupRemainingSeconds);
  if (phase.phase === 'completed') {
    game.completed = true;
    if (game.autoStop !== false) game.elapsedSeconds = phase.totalDurationSeconds;
  }
}

export function tickGames(): void {
  for (const game of gamesMap.values()) {
    updateGameElapsed(game);
    if (game.isRunning && game.completed && game.autoStop !== false) stopGameProcess(game);
  }
  savePersistedState(false);
}

export function startElapsedTicker(): NodeJS.Timeout {
  return setInterval(tickGames, 250);
}

/** Folder that holds the game's executable (inside Games/ or a Steam library). */
export function gameDirectory(game: StoredGame): string {
  return path.dirname(getExecutablePath(game));
}

export function getExecutablePath(game: StoredGame): string {
  if (game.specialRootPath) {
    return path.resolve(game.specialRootPath, 'common', path.basename(game.folder), game.executable);
  }
  return path.resolve(GAMES_DIR, game.folder, game.executable);
}

export function stopGameProcess(game: StoredGame): void {
  updateGameElapsed(game);
  const child = game.process;
  game.process = undefined;
  game.isRunning = false;
  game.session = undefined;
  game.startedAt = undefined;
  game.warmupRemainingSeconds = 0;
  savePersistedState(true);
  if (!child || child.exitCode !== null || child.killed) return;

  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', (error) => {
      console.warn(`Could not terminate process tree for "${game.name}":`, error.message);
    });
  } else {
    child.kill();
  }
}

export function stopAllRunningGames(): number {
  let count = 0;
  for (const game of gamesMap.values()) {
    if (game.isRunning) {
      stopGameProcess(game);
      count++;
    }
  }
  return count;
}

export function toPublicGame(
  game: StoredGame
): Omit<StoredGame, 'process' | 'session' | 'logoPromise'> {
  const { process: _process, session: _session, logoPromise: _logoPromise, ...publicGame } =
    game;
  return publicGame;
}

// ---------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------

/** Safely locate a game by ID, folder, or display name. */
export function findGameById(rawId: string): { key: string; game: StoredGame } | null {
  if (!rawId || typeof rawId !== 'string') return null;
  const raw = String(rawId).trim();
  // Prevent path traversal attacks
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw).trim();
    // Additional check after decoding
    if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) return null;
  } catch {}

  const lowerRaw = raw.toLowerCase();
  const lowerDecoded = decoded.toLowerCase();

  // 1. Direct match
  if (gamesMap.has(raw)) return { key: raw, game: gamesMap.get(raw)! };
  if (gamesMap.has(decoded)) return { key: decoded, game: gamesMap.get(decoded)! };
  if (gamesMap.has(lowerRaw)) return { key: lowerRaw, game: gamesMap.get(lowerRaw)! };
  if (gamesMap.has(lowerDecoded)) return { key: lowerDecoded, game: gamesMap.get(lowerDecoded)! };

  // 2. Scan all entries for matches on id, folder, or name
  for (const [key, g] of gamesMap.entries()) {
    if (
      key.toLowerCase() === lowerRaw ||
      key.toLowerCase() === lowerDecoded ||
      g.id.toLowerCase() === lowerRaw ||
      g.id.toLowerCase() === lowerDecoded ||
      g.folder.toLowerCase() === lowerRaw ||
      g.folder.toLowerCase() === lowerDecoded ||
      g.name.toLowerCase() === lowerRaw ||
      g.name.toLowerCase() === lowerDecoded
    ) {
      return { key, game: g };
    }
  }
  return null;
}

