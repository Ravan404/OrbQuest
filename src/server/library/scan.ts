import {
  ensureManagedPlaceholderExecutable,
  hasPlaceholderRuntimeSignature,
  upgradeLegacyPlaceholder,
} from '../placeholderUpgrade.ts';
import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR, PLACEHOLDER_EXE, type StoredGame } from '../config.ts';
import { isSafeExecutablePath } from '../security.ts';
import { findGameByExecutable } from '../gameDatabase.ts';
import { readSimulatedSteamManifest } from '../steamManifest.ts';
import { gamesMap } from './registry.ts';
import {
  inferKnownExecutableForGame,
  allocateLibraryId,
  readGameMeta,
  writeGameMeta,
  resolveGameOrigin,
} from './meta.ts';
import { loadPersistedState, savePersistedState, readSpecialGames } from './persistence.ts';
import { kickoffLogo } from './icons.ts';

/** Reading the Games folder and the Steam quests into the library. */

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
        ...(typeof record.appId === 'string' ? { appId: record.appId } : {}),
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

      let storedName = '';
      const nameFile = path.join(folderPath, '.game-name.txt');
      if (fs.existsSync(nameFile)) {
        try {
          storedName = fs.readFileSync(nameFile, 'utf-8').trim();
        } catch {}
      }

      // Where the entry came from, written when it was added
      const meta = readGameMeta(folder.name);
      const hintedName = meta.name || storedName || folder.name;
      const metaExe = meta.executable && isSafeExecutablePath(meta.executable) ? meta.executable : '';
      const knownExe = metaExe || inferKnownExecutableForGame(hintedName, folder.name, meta.appId);
      const fallbackExe = `${folder.name.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'game'}.exe`;

      // Find the executable, or restore a placeholder that antivirus removed.
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
      const defaultId =
        folder.name
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9._-]/g, '') || 'game';
      // Save the id and executable so the folder survives antivirus quarantine.
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
        // The icon is fetched in the background; startup and the status poll never wait for it.
        kickoffLogo(game);
      } else {
        existing.executable = exeName;
        existing.name = displayName;
        if (!existing.logoUrl) kickoffLogo(existing);
      }
    }

    // Steam layout inside Games/ from early versions:
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
            if (
              recoveredExe &&
              ensureManagedPlaceholderExecutable(path.join(folderPath, recoveredExe), PLACEHOLDER_EXE)
            ) {
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
