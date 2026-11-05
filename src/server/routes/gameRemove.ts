import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR } from '../config.ts';
import { isPathInside } from '../security.ts';
import { gamesMap, findGameById, stopGameProcess, savePersistedState, removeSpecialGame } from '../gameStore.ts';
import { parseSimulatedSteamManifest } from '../steamManifest.ts';
import { planSteamRemoval } from '../steamLibrarySafety.ts';
import type { IdParams } from './gameInput.ts';

/** Removing a game, and never anything this app did not create. */

// DELETE /api/games/:id: the folder and the library entry
export function removeGame(req: Request<IdParams>, res: Response) {
  const match = findGameById(req.params.id);
  if (!match) {
    // Already gone or not found, consider success
    return res.json({ success: true, deleted: false, message: 'Game already removed' });
  }

  const { key, game } = match;
  stopGameProcess(game);
  let preservedSteamInstall = false;

  if (game.folder) {
    const specialRootPath = game.specialRootPath ? path.resolve(game.specialRootPath) : null;
    const steamAppsPath = specialRootPath || path.join(GAMES_DIR, 'steamapps');
    const isSteamGame = Boolean(
      specialRootPath || game.folder.toLowerCase().startsWith(`steamapps${path.sep}common${path.sep}`)
    );
    let folderPath = specialRootPath
      ? path.join(specialRootPath, 'common', path.basename(game.folder))
      : path.join(GAMES_DIR, game.folder);
    let manifestPathToRemove: string | undefined;
    try {
      // Only the manifest of this app id is looked at. Without an id none is touched,
      // so the first manifest of a real Steam library is never picked by accident.
      const appId = game.steamAppId ?? Number(game.id.match(/^steam-(\d+)$/i)?.[1]);
      if (isSteamGame && Number.isSafeInteger(appId) && appId > 0) {
        const candidatePath = path.join(steamAppsPath, `appmanifest_${appId}.acf`);
        if (fs.existsSync(candidatePath)) {
          try {
            const manifest = parseSimulatedSteamManifest(fs.readFileSync(candidatePath, 'utf-8'));
            if (manifest.appId === appId) {
              folderPath = path.join(steamAppsPath, 'common', manifest.installDir);
              manifestPathToRemove = candidatePath;
            }
          } catch (error) {
            console.warn(`Could not inspect manifest "${candidatePath}" during game removal:`, error);
          }
        }
      }

      const allowedBase = specialRootPath || GAMES_DIR;
      const removal = isSteamGame
        ? planSteamRemoval(folderPath, manifestPathToRemove, game.executable)
        : { deleteFolder: true, deleteManifest: false, preserved: false };
      if (removal.preserved) {
        console.warn(
          `Refusing to delete Steam files for "${game.name}" because they are not a placeholder created by this app.`
        );
      }
      if (removal.deleteFolder && isPathInside(allowedBase, folderPath) && fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
      }

      if (isSteamGame && removal.deleteManifest && manifestPathToRemove) {
        try {
          fs.rmSync(manifestPathToRemove, { force: true });
        } catch (error) {
          console.warn('Could not clean simulated Steam manifest:', error);
        }
      }
      preservedSteamInstall = removal.preserved;
    } catch (err) {
      console.warn('Failed to delete game folder:', err);
    }
  }

  gamesMap.delete(key);
  gamesMap.delete(game.id);
  if (game.specialRootPath) removeSpecialGame(game.id);
  savePersistedState(true);
  res.json({
    success: true,
    deleted: true,
    id: game.id,
    ...(preservedSteamInstall ? { preservedSteamInstall: true } : {}),
  });
}
