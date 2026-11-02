import type { GameOrigin } from '../../types.ts';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR, PLACEHOLDER_EXE, type StoredGame } from '../config.ts';
import { isPathInside, isSafeFileName, libraryFolderName } from '../security.ts';
import {
  gamesMap,
  allocateLibraryId,
  applyTimerPreferences,
  parseTimerPreferences,
  toPublicGame,
  kickoffLogo,
  savePersistedState,
  writeGameMeta,
  saveSpecialGame,
  type TimerPreferences,
} from '../gameStore.ts';
import { upgradeLegacyPlaceholder } from '../placeholderUpgrade.ts';
import { getGameById } from '../gameDatabase.ts';
import type { DatabaseGame, SteamQuest } from '../gameDatabaseSource.ts';
import {
  buildSimulatedManifest,
  canReplaceManifest,
  installDirectoryIsForeign,
  writeManagedMarker,
} from '../steamLibrarySafety.ts';
import { findSteamAppsPath } from '../steamPaths.ts';
import { parseDisplayName, parseExecutableName } from './gameInput.ts';

/** Adding a game: from the catalog, a Steam quest, or by hand. */

// POST /api/games
//
// A catalog game sends its Discord application id and one of the executables
// Discord lists for it; the placeholder is written to that relative path
// (`Games/VALORANT/win64/valorant-win64-shipping.exe`), which is what Discord
// matches. A custom game sends a name and an executable of its own.
export function addGame(req: Request, res: Response) {
  const body = (req.body || {}) as Record<string, unknown>;

  const parsedName = parseDisplayName(body.name);
  if ('error' in parsedName) return res.status(400).json({ error: parsedName.error });
  const parsedExe = parseExecutableName(body.executableName);
  if ('error' in parsedExe) return res.status(400).json({ error: parsedExe.error });
  const prefs = parseTimerPreferences(body);
  if (typeof prefs === 'string') return res.status(400).json({ error: prefs });

  const displayName = parsedName.value;
  const cleanExe = parsedExe.value;
  const entryOrigin: GameOrigin = body.origin === 'catalog' ? 'catalog' : 'custom';
  let appId: string | undefined;
  if (body.appId !== undefined) {
    const known = typeof body.appId === 'string' ? getGameById(body.appId) : undefined;
    if (!known) return res.status(400).json({ error: 'Unknown game.' });
    if (!known.executables.includes(cleanExe.toLowerCase())) {
      return res.status(400).json({ error: 'That executable is not one Discord lists for this game.' });
    }
    appId = known.id;
    if (!fs.existsSync(PLACEHOLDER_EXE)) return res.status(500).json({ error: 'App files are missing.' });
    if (known.steam) return addSteamQuest(res, known, known.steam, displayName, cleanExe.toLowerCase(), prefs);
  }

  if (!fs.existsSync(PLACEHOLDER_EXE)) {
    return res.status(500).json({ error: 'App files are missing.' });
  }

  const sanitizedFolderName = libraryFolderName(
    typeof body.folderPath === 'string' ? body.folderPath : undefined,
    displayName
  );
  let targetFolder = sanitizedFolderName;
  let counter = 2;
  const existingFolders = new Set(Array.from(gamesMap.values()).map((g) => g.folder.toLowerCase()));
  while (
    existingFolders.has(targetFolder.toLowerCase()) ||
    fs.existsSync(path.join(GAMES_DIR, targetFolder)) ||
    !isSafeFileName(targetFolder)
  ) {
    targetFolder = `${sanitizedFolderName} (${counter})`;
    counter++;
    if (counter > 100) {
      return res.status(409).json({ error: 'A game folder with that name already exists.' });
    }
  }

  const id = allocateLibraryId(targetFolder);
  if (gamesMap.has(id)) {
    return res.status(409).json({ error: 'This game is already in the library.' });
  }
  const targetDir = path.join(GAMES_DIR, targetFolder);
  const targetExecutable = path.join(targetDir, cleanExe);
  if (!isPathInside(GAMES_DIR, targetDir) || !isPathInside(targetDir, targetExecutable)) {
    return res.status(400).json({ error: 'Invalid folder path' });
  }

  const addedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(targetExecutable), { recursive: true });
    if (!fs.existsSync(targetExecutable)) {
      fs.copyFileSync(PLACEHOLDER_EXE, targetExecutable);
    } else {
      upgradeLegacyPlaceholder(targetExecutable, PLACEHOLDER_EXE);
    }
    fs.writeFileSync(path.join(targetDir, '.game-name.txt'), displayName, 'utf-8');
    writeGameMeta(targetFolder, {
      id,
      name: displayName,
      executable: cleanExe,
      origin: entryOrigin,
      addedAt,
      ...(appId ? { appId } : {}),
    });
  } catch (e) {
    console.warn('Could not write game folder files', e);
    return res.status(500).json({ error: 'Failed to create game folder' });
  }

  const newGame: StoredGame = {
    id,
    name: displayName,
    folder: targetFolder,
    executable: cleanExe,
    isRunning: false,
    elapsedSeconds: 0,
    origin: entryOrigin,
    addedAt,
    appId,
  };
  applyTimerPreferences(newGame, prefs);

  gamesMap.set(id, newGame);
  savePersistedState(true);
  kickoffLogo(newGame);
  res.json({ success: true, game: toPublicGame(newGame) });
}

/**
 * A quest Discord only detects through Steam (EA SPORTS FC 27): the
 * placeholder goes to `steamapps/common/<installDir>/` of the Steam library
 * and a minimal `appmanifest_<appId>.acf` next to it, as the r/DiscordQuests
 * post describes. A real install or a real manifest of that game is never
 * overwritten.
 */
function addSteamQuest(
  res: Response,
  known: DatabaseGame,
  steam: SteamQuest,
  displayName: string,
  executable: string,
  prefs: TimerPreferences
) {
  const id = `steam-${steam.appId}`;
  if (gamesMap.has(id)) return res.status(409).json({ error: 'This game is already in the library.' });
  const steamAppsPath = findSteamAppsPath();
  if (!steamAppsPath) {
    return res.status(404).json({ error: `${known.name} needs Steam, and no Steam installation was found.` });
  }

  const commonDir = path.join(steamAppsPath, 'common');
  const targetDir = path.join(commonDir, steam.installDir);
  const targetExecutable = path.join(targetDir, executable);
  const manifestPath = path.join(steamAppsPath, `appmanifest_${steam.appId}.acf`);
  if (!isPathInside(commonDir, targetDir) || !isPathInside(targetDir, targetExecutable)) {
    return res.status(400).json({ error: 'Invalid folder path' });
  }
  if (installDirectoryIsForeign(targetDir, executable) || !canReplaceManifest(manifestPath)) {
    return res.status(409).json({ error: `${known.name} is already installed on Steam; its files were left alone.` });
  }

  try {
    fs.mkdirSync(path.dirname(targetExecutable), { recursive: true });
    if (!fs.existsSync(targetExecutable)) fs.copyFileSync(PLACEHOLDER_EXE, targetExecutable);
    else upgradeLegacyPlaceholder(targetExecutable, PLACEHOLDER_EXE);
    fs.writeFileSync(path.join(targetDir, '.game-name.txt'), displayName, 'utf-8');
    writeManagedMarker(targetDir, { appId: steam.appId, executable });
    fs.writeFileSync(manifestPath, buildSimulatedManifest(steam.appId, displayName, steam.installDir), 'utf-8');
  } catch (error) {
    console.warn('Could not write the Steam quest files', error);
    return res.status(500).json({ error: 'Could not write to the Steam folder.' });
  }

  const newGame: StoredGame = {
    id,
    name: displayName,
    folder: path.join('special', steam.installDir),
    executable,
    isRunning: false,
    elapsedSeconds: 0,
    origin: 'catalog',
    addedAt: new Date().toISOString(),
    specialRootPath: steamAppsPath,
    steamAppId: steam.appId,
    appId: known.id,
  };
  applyTimerPreferences(newGame, prefs);
  gamesMap.set(id, newGame);
  saveSpecialGame({
    id,
    rootPath: steamAppsPath,
    installDir: steam.installDir,
    executable,
    name: displayName,
    steamAppId: steam.appId,
    appId: known.id,
  });
  savePersistedState(true);
  kickoffLogo(newGame);
  return res.json({ success: true, game: toPublicGame(newGame) });
}
