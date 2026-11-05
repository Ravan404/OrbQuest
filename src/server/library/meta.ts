import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR } from '../config.ts';
import { isPathInside, isSafeExecutablePath } from '../security.ts';
import { findGameByName, getGameById } from '../gameDatabase.ts';
import { isGameOrigin, type GameOrigin } from '../../types.ts';
import { writeJsonAtomic } from '../fsUtil.ts';
import { gamesMap } from './registry.ts';

/** Per-game metadata files (`.game-meta.json`) and library ids. */

/**
 * Where an entry came from, stored next to its placeholder so it survives
 * folder moves. A folder without the file was found by the scan.
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
export function inferKnownExecutableForGame(
  displayName: string,
  folderName: string,
  appId?: string
): string | undefined {
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
 * "Foo Bar" and "Foo-Bar" would both become `foo-bar`. An id from
 * `.game-meta.json` keeps the second one apart after a restart.
 */
export function allocateLibraryId(folderName: string, preferred?: string): string {
  const base =
    folderName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]/g, '') || 'game';
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
      appId:
        typeof parsed.appId === 'string' && /^(?:\d{5,25}|r-[a-z0-9]{1,60})$/.test(parsed.appId)
          ? parsed.appId
          : undefined,
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

/** Origin shown when a folder has no `.game-meta.json`. */
export function resolveGameOrigin(meta: GameMeta): GameOrigin {
  return meta.origin ?? 'scanned';
}
