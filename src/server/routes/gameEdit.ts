import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR, PLACEHOLDER_EXE } from '../config.ts';
import { isPathInside, isSafeFileName } from '../security.ts';
import {
  applyTimerPreferences,
  findGameById,
  gameDirectory,
  parseTimerPreferences,
  toPublicGame,
  kickoffLogo,
  savePersistedState,
  writeGameMeta,
  saveSpecialGame,
} from '../gameStore.ts';
import { hasPlaceholderRuntimeSignature } from '../placeholderUpgrade.ts';
import { parseDisplayName, parseExecutableName, type IdParams } from './gameInput.ts';

/** Changing a game: name, executable, folder and timer. */

// PATCH /api/games/:id: name, executable, folder and timer
//
// Every value is validated before anything on disk changes, so a rejected
// request never leaves the folder renamed while the library still points at
// the old one.
//
// - Catalog entries: only the timer preferences can change.
// - Steam-manifest installs: the name and timer can change. The folder must
//   match the manifest `installdir` and the executable is tied to the
//   placeholder marker, so those stay.
// - Custom / scanned entries inside Games/: everything can change. Only the
//   placeholder this app created is ever deleted; a real executable the user
//   placed in the folder is left alone.
export function editGame(req: Request<IdParams>, res: Response) {
  const match = findGameById(req.params.id);
  if (!match) return res.status(404).json({ error: 'Game not found' });
  const { game } = match;

  if (game.isRunning) {
    return res.status(409).json({ error: `Stop "${game.name}" before editing it.` });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const isSteamInstall = Boolean(game.specialRootPath);

  // Validate first
  const prefs = parseTimerPreferences(body);
  if (typeof prefs === 'string') return res.status(400).json({ error: prefs });

  let nextName = game.name;
  if (body.name !== undefined) {
    const parsed = parseDisplayName(body.name);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    nextName = parsed.value;
  }

  let nextExecutable = game.executable;
  if (body.executableName !== undefined) {
    const parsed = parseExecutableName(body.executableName);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    nextExecutable = parsed.value;
  }

  // The edit dialog always sends the current folder back; only a different
  // value is a rename request.
  let nextFolder = game.folder;
  if (body.folderPath !== undefined && body.folderPath !== null && body.folderPath !== '') {
    const requested = typeof body.folderPath === 'string' ? body.folderPath.trim().replace(/[\\/]+$/, '') : '';
    const sameFolder = (a: string, b: string) =>
      a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase();
    if (!sameFolder(requested, game.folder)) {
      if (!requested || requested.toLowerCase() === 'not found') {
        return res.status(400).json({ error: 'Folder name is required' });
      }
      if (path.basename(requested) !== requested || !isSafeFileName(requested)) {
        return res.status(400).json({ error: 'Folder must be a safe folder name inside Games.' });
      }
      nextFolder = requested;
    }
  }

  const nameChanged = nextName !== game.name;
  const exeChanged = nextExecutable.toLowerCase() !== game.executable.toLowerCase();
  const folderChanged = nextFolder.toLowerCase() !== game.folder.toLowerCase();

  if (game.origin === 'catalog' && (nameChanged || exeChanged || folderChanged)) {
    return res.status(403).json({ error: 'Catalog entries are read-only. Only the timer can be changed.' });
  }
  if (isSteamInstall && (exeChanged || folderChanged)) {
    return res.status(409).json({
      error:
        'A Steam install keeps the folder and executable from its manifest. Only the name and timer can be changed.',
    });
  }

  const currentDir = gameDirectory(game);
  const allowedRoot = isSteamInstall ? path.resolve(game.specialRootPath!) : GAMES_DIR;
  if (!isPathInside(allowedRoot, currentDir) || !fs.existsSync(currentDir)) {
    return res.status(404).json({ error: 'Game folder is missing.' });
  }
  const nextDir = folderChanged ? path.join(GAMES_DIR, nextFolder) : currentDir;
  if (folderChanged) {
    if (!isPathInside(GAMES_DIR, nextDir)) return res.status(400).json({ error: 'Invalid folder path' });
    if (fs.existsSync(nextDir)) {
      return res.status(409).json({ error: 'A game folder with that name already exists.' });
    }
  }
  if (exeChanged && !fs.existsSync(PLACEHOLDER_EXE)) {
    return res.status(500).json({ error: 'Local placeholder runtime is missing from this build.' });
  }

  // Apply
  if (exeChanged) {
    const currentExecutablePath = path.join(currentDir, game.executable);
    const nextExecutablePath = path.join(currentDir, nextExecutable);
    try {
      if (!fs.existsSync(nextExecutablePath)) {
        fs.mkdirSync(path.dirname(nextExecutablePath), { recursive: true });
        fs.copyFileSync(PLACEHOLDER_EXE, nextExecutablePath);
      }
      // Only remove the previous file when it is the placeholder this app
      // created; a real game executable the user placed there is left alone.
      if (fs.existsSync(currentExecutablePath) && hasPlaceholderRuntimeSignature(currentExecutablePath)) {
        fs.rmSync(currentExecutablePath, { force: true });
      }
    } catch (error) {
      console.warn('Could not update the game executable', error);
      return res.status(500).json({ error: 'Failed to update the game executable' });
    }
  }

  if (folderChanged) {
    try {
      fs.renameSync(currentDir, nextDir);
    } catch (error) {
      console.warn('Could not rename the game folder', error);
      // Keep memory and metadata in line with the disk: the executable change
      // above already happened.
      if (exeChanged) {
        game.executable = nextExecutable;
        writeGameMeta(game.folder, { executable: nextExecutable });
        savePersistedState(true);
      }
      return res.status(500).json({ error: 'Failed to update the game folder.' });
    }
  }

  game.name = nextName;
  game.folder = nextFolder;
  game.executable = nextExecutable;
  applyTimerPreferences(game, prefs);
  if (nameChanged || exeChanged) {
    game.logoUrl = undefined;
    kickoffLogo(game);
  }

  try {
    if (nameChanged || folderChanged || exeChanged) {
      fs.writeFileSync(path.join(nextDir, '.game-name.txt'), nextName, 'utf-8');
    }
    if (isSteamInstall) {
      if (nameChanged) {
        saveSpecialGame({
          id: game.id,
          rootPath: game.specialRootPath!,
          installDir: path.basename(game.folder),
          executable: game.executable,
          name: nextName,
          steamAppId: game.steamAppId!,
        });
      }
    } else {
      // The id is stored so a renamed folder keeps its saved progress.
      writeGameMeta(game.folder, {
        id: game.id,
        name: nextName,
        executable: nextExecutable,
        origin: game.origin ?? 'custom',
        addedAt: game.addedAt,
      });
    }
  } catch (error) {
    console.warn('Could not write game metadata after edit', error);
  }
  savePersistedState(true);

  res.json({ success: true, game: toPublicGame(game) });
}
