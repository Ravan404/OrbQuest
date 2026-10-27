import { BUFFER_PRESET_DURATIONS, type GameOrigin } from '../../types.ts';
import { computeGameTimerPhase } from '../../utils/timerUtils.ts';
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ASSET_ROOT, GAMES_DIR, PLACEHOLDER_EXE, StoredGame } from '../config.ts';
import { isPathInside, isSafeFileName, libraryFolderName } from '../security.ts';
import {
  gamesMap,
  allocateLibraryId,
  applyTimerPreferences,
  beginGameSession,
  updateGameElapsed,
  findGameById,
  gameDirectory,
  getExecutablePath,
  inferKnownExecutableForGame,
  parseTimerPreferences,
  rescanGamesDir,
  stopGameProcess,
  stopAllRunningGames,
  toPublicGame,
  kickoffLogo,
  savePersistedState,
  writeGameMeta,
  saveSpecialGame,
  removeSpecialGame,
  type TimerPreferences,
} from '../gameStore.ts';
import {
  ensureManagedPlaceholderExecutable,
  hasPlaceholderRuntimeSignature,
  upgradeLegacyPlaceholder,
} from '../placeholderUpgrade.ts';
import { parseSimulatedSteamManifest } from '../steamManifest.ts';
import { findSteamAppsPath } from '../steamPaths.ts';
import { learnFromLibraryAddition } from '../questDatabaseLearning.ts';
import { getSettings } from '../settingsStore.ts';
import { writePlaceholderIcon } from '../placeholderIcon.ts';
import {
  MANAGED_INSTALL_MARKER,
  buildSimulatedManifest,
  canReplaceManifest,
  installDirectoryIsForeign,
  planSteamRemoval,
  writeManagedMarker,
} from '../steamLibrarySafety.ts';

/** How long a launch may wait for the child `spawn` event before failing the request. */
const LAUNCH_SPAWN_TIMEOUT_MS = 15_000;

const MAX_NAME_LENGTH = 120;

const router = Router();

/** Route params of the `/:id` routes (Express 5 types allow arrays by default). */
type IdParams = { id: string };

function publicList() {
  return Array.from(gamesMap.values()).map((game) => {
    updateGameElapsed(game);
    kickoffLogo(game);
    return toPublicGame(game);
  });
}

/** Validates an executable file name from a request. Returns the name or an error. */
function parseExecutableName(value: unknown): { value: string } | { error: string } {
  const requested = typeof value === 'string' ? value.trim() : '';
  if (!requested) return { error: 'Executable name is required' };
  if (!requested.toLowerCase().endsWith('.exe')) return { error: 'Executable must end with .exe' };
  if (!isSafeFileName(requested)) return { error: 'Executable name must be a safe file name.' };
  return { value: requested };
}

/** Validates a display name from a request. Returns the name or an error. */
function parseDisplayName(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) return { error: 'Name is required' };
  if (value.trim().length > MAX_NAME_LENGTH) return { error: `Name is too long (${MAX_NAME_LENGTH} characters max).` };
  return { value: value.trim() };
}

// 1. Games list
//
// Logo resolution is fire-and-forget (see kickoffLogo): the response is
// never blocked on remote icon lookups.
router.get('/', (_req: Request, res: Response) => {
  res.json(publicList());
});

// 2. Rescan Games directory and repair any missing/legacy placeholders
router.post('/rescan', async (_req: Request, res: Response) => {
  await rescanGamesDir();
  res.json(publicList());
});

// 3. Stop All Games
router.post('/stop-all', (_req: Request, res: Response) => {
  const count = stopAllRunningGames();
  res.json({ success: true, stoppedCount: count });
});

// 4. Launch Game
router.post('/:id/launch', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const { game } = match;
  if (game.isRunning) {
    return res.status(409).json({ error: `"${game.name}" is already running` });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const parsed = parseTimerPreferences({
    targetMinutes: body.targetMinutes ?? game.targetMinutes ?? 15,
    bufferPreset: body.bufferPreset ?? game.bufferPreset ?? 'normal',
    autoStop: body.autoStop ?? game.autoStop ?? true,
  });
  if (typeof parsed === 'string') {
    return res.status(400).json({ error: parsed });
  }
  const prefs = parsed as Required<TimerPreferences>;

  let executablePath: string;
  try {
    executablePath = getExecutablePath(game);
  } catch {
    return res.status(400).json({ error: 'Invalid executable path.' });
  }

  const workingDirectory = path.dirname(executablePath);
  const isManagedDirectory =
    isPathInside(GAMES_DIR, executablePath) ||
    fs.existsSync(path.join(workingDirectory, MANAGED_INSTALL_MARKER)) ||
    fs.existsSync(path.join(workingDirectory, '.game-meta.json')) ||
    fs.existsSync(path.join(workingDirectory, '.game-name.txt'));

  if (isManagedDirectory) {
    const knownExe = inferKnownExecutableForGame(game.name, game.folder);
    const fallbackExe = `${path.basename(game.folder).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'game'}.exe`;
    if (
      knownExe &&
      game.executable.toLowerCase() === fallbackExe.toLowerCase() &&
      knownExe.toLowerCase() !== game.executable.toLowerCase() &&
      (!fs.existsSync(executablePath) || hasPlaceholderRuntimeSignature(executablePath))
    ) {
      // A placeholder named after the folder: switch to the executable the
      // quest database knows for this game.
      const oldPath = executablePath;
      game.executable = knownExe;
      executablePath = getExecutablePath(game);
      ensureManagedPlaceholderExecutable(executablePath, PLACEHOLDER_EXE);
      if (fs.existsSync(oldPath) && oldPath.toLowerCase() !== executablePath.toLowerCase()) {
        try {
          fs.rmSync(oldPath, { force: true });
        } catch {
          // A locked old placeholder is harmless; the next scan ignores it.
        }
      }
      if (isPathInside(GAMES_DIR, workingDirectory)) {
        writeGameMeta(game.folder, { executable: game.executable });
      }
    } else if (fs.existsSync(executablePath)) {
      upgradeLegacyPlaceholder(executablePath, PLACEHOLDER_EXE);
    } else {
      ensureManagedPlaceholderExecutable(executablePath, PLACEHOLDER_EXE);
    }
    // The placeholder window shows the game's icon. Only inside Games/: a
    // Steam library gets nothing but the placeholder itself.
    if (isPathInside(GAMES_DIR, executablePath)) {
      writePlaceholderIcon(path.dirname(executablePath), game.logoUrl);
    }
  }

  if (!fs.existsSync(executablePath)) {
    return res.status(404).json({
      error: `Executable not found: ${game.executable}. Add the real game executable to ${game.folder}.`,
    });
  }

  const oldPhase = computeGameTimerPhase(game.elapsedSeconds, game.targetMinutes, game.bufferPreset);
  const changed = game.bufferPreset !== prefs.bufferPreset || game.targetMinutes !== prefs.targetMinutes;
  if (game.completed || oldPhase.phase === 'completed' || changed) game.elapsedSeconds = 0;
  applyTimerPreferences(game, prefs);
  game.completed = false;
  const config = BUFFER_PRESET_DURATIONS[prefs.bufferPreset];
  let child: ChildProcess;
  // The desktop control token must never be inherited by a launched game.
  const { DQR_SHUTDOWN_TOKEN: _shutdownToken, ...childEnvironment } = process.env;
  const launchEnv = {
    ...childEnvironment,
    DQR_GAME_NAME: game.name,
    DQR_TARGET_SECONDS: String(prefs.targetMinutes * 60),
    DQR_BUFFER_START: String(config.start),
    DQR_BUFFER_END: String(config.end),
    DQR_RESUME_SECONDS: String(game.elapsedSeconds),
    DQR_LAUNCHED_AT: String(Date.now()),
    // The placeholder window uses the app's light or dark theme.
    DQR_THEME: getSettings().theme,
  };
  try {
    const pyRuntimePath = path.resolve(ASSET_ROOT, 'placeholder_runtime.py');
    const usePosixPlaceholderFallback =
      process.platform !== 'win32' &&
      executablePath.toLowerCase().endsWith('.exe') &&
      hasPlaceholderRuntimeSignature(executablePath) &&
      fs.existsSync(pyRuntimePath);

    const spawnCmd = usePosixPlaceholderFallback ? 'python3' : executablePath;
    const spawnArgs = usePosixPlaceholderFallback ? [pyRuntimePath] : [];

    child = spawn(spawnCmd, spawnArgs, {
      cwd: workingDirectory,
      detached: false,
      windowsHide: false,
      stdio: 'ignore',
      env: launchEnv,
    });
  } catch {
    return res.status(500).json({ error: 'Could not launch game process.' });
  }
  // Reserve immediately against duplicate clicks, but do not count before spawn.
  game.process = child;
  game.isRunning = true;
  let settled = false;
  let spawnTimer: ReturnType<typeof setTimeout> | undefined;
  const reply = (status: number, body: unknown) => {
    if (settled || res.headersSent) return;
    settled = true;
    if (spawnTimer) clearTimeout(spawnTimer);
    if (status >= 400) res.status(status).json(body);
    else res.json(body);
  };
  const cleanup = () => {
    if (game.process !== child) return;
    updateGameElapsed(game);
    game.process = undefined;
    game.session = undefined;
    game.isRunning = false;
    game.startedAt = undefined;
    game.warmupRemainingSeconds = 0;
    savePersistedState(true);
  };
  spawnTimer = setTimeout(() => {
    if (settled) return;
    // `spawn` never arrived. Drop the reservation so the library is not stuck
    // on "running" and the HTTP request is not left hanging.
    try {
      child.kill();
    } catch {
      // The process may not exist yet. The error/exit handlers finish the request.
    }
    cleanup();
    reply(500, { error: 'Game process did not start in time.' });
  }, LAUNCH_SPAWN_TIMEOUT_MS);
  spawnTimer.unref?.();
  child.once('spawn', () => {
    if (game.process !== child) {
      reply(409, { error: 'Launch was cancelled.' });
      return;
    }
    beginGameSession(game);
    savePersistedState(true);
    reply(200, { success: true, game: toPublicGame(game) });
  });
  child.once('error', () => {
    cleanup();
    reply(500, { error: 'Could not launch game process.' });
  });
  child.once('exit', cleanup);
});

// 5. Stop Game
router.post('/:id/stop', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) {
    return res.status(404).json({ error: 'Game not found' });
  }
  const { game } = match;
  stopGameProcess(game);
  res.json({ success: true, game: toPublicGame(game) });
});

// 6. Reset Game Timer (the timer preferences stay)
router.post('/:id/reset-timer', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) {
    return res.status(404).json({ error: 'Game not found' });
  }
  const { game } = match;
  stopGameProcess(game);
  game.elapsedSeconds = 0;
  game.completed = false;
  game.startedAt = undefined;
  savePersistedState(true);
  res.json({ success: true, game: toPublicGame(game) });
});

// 7. Timer preferences (target, detection preset, auto-stop)
//
// Allowed for every entry, catalog entries included: the preferences belong to
// the library, not to the files on disk. They are saved in Games/.state.json.
router.put('/:id/timer', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) return res.status(404).json({ error: 'Game not found' });
  const { game } = match;
  if (game.isRunning) {
    return res.status(409).json({ error: `Stop "${game.name}" before changing its timer.` });
  }
  const prefs = parseTimerPreferences((req.body || {}) as Record<string, unknown>);
  if (typeof prefs === 'string') return res.status(400).json({ error: prefs });
  if (Object.keys(prefs).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  applyTimerPreferences(game, prefs);
  savePersistedState(true);
  res.json({ success: true, game: toPublicGame(game) });
});

// 8. Edit Game (name, executable, folder and/or timer preferences)
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
router.patch('/:id', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) return res.status(404).json({ error: 'Game not found' });
  const { game } = match;

  if (game.isRunning) {
    return res.status(409).json({ error: `Stop "${game.name}" before editing it.` });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const isSteamInstall = Boolean(game.specialRootPath);

  // --- Validate -----------------------------------------------------------
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
    const sameFolder = (a: string, b: string) => a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase();
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
      error: 'A Steam install keeps the folder and executable from its manifest. Only the name and timer can be changed.',
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

  // --- Apply ----------------------------------------------------------------
  if (exeChanged) {
    const currentExecutablePath = path.join(currentDir, game.executable);
    const nextExecutablePath = path.join(currentDir, nextExecutable);
    try {
      if (!fs.existsSync(nextExecutablePath)) fs.copyFileSync(PLACEHOLDER_EXE, nextExecutablePath);
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
    game.logoFailed = false;
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
});

// 9. Delete Game (folder and library entry)
router.delete('/:id', (req: Request<IdParams>, res: Response) => {
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
      // Only the manifest of THIS app id is ever looked at. Without an app id
      // no manifest is touched at all (the first manifest of a real Steam
      // library must never be picked by accident).
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
});

// 10. Add Game to Library
router.post('/', (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const { folderPath, origin, questMethod, steamAppId, manifestFileName, manifestContent } = body;

  const parsedName = parseDisplayName(body.name);
  if ('error' in parsedName) return res.status(400).json({ error: parsedName.error });
  const parsedExe = parseExecutableName(body.executableName);
  if ('error' in parsedExe) return res.status(400).json({ error: parsedExe.error });
  const prefs = parseTimerPreferences(body);
  if (typeof prefs === 'string') return res.status(400).json({ error: prefs });

  const displayName = parsedName.value;
  const cleanExe = parsedExe.value;

  // Provenance tag: the Add Custom Game dialog sends 'custom', the catalog
  // discovery flow sends 'catalog'. Anything else is treated as custom.
  const entryOrigin: GameOrigin = origin === 'catalog' ? 'catalog' : 'custom';
  const isSteamManifest = questMethod === 'steam-manifest';
  let parsedManifest: ReturnType<typeof parseSimulatedSteamManifest> | undefined;
  if (isSteamManifest) {
    if (typeof manifestContent !== 'string' || typeof manifestFileName !== 'string') {
      return res.status(400).json({ error: 'Steam manifest content is required.' });
    }
    try {
      parsedManifest = parseSimulatedSteamManifest(manifestContent);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Steam manifest.' });
    }
    if (steamAppId !== undefined && Number(steamAppId) !== parsedManifest.appId) {
      return res.status(400).json({ error: 'Manifest appid does not match the catalog result.' });
    }
    if (!/^appmanifest_\d+\.acf$/i.test(manifestFileName)) {
      return res.status(400).json({ error: 'Manifest file name is invalid.' });
    }
  }

  if (!fs.existsSync(PLACEHOLDER_EXE)) {
    return res.status(500).json({ error: 'App files are missing.' });
  }

  const steamAppsPath = parsedManifest ? findSteamAppsPath() : undefined;
  if (parsedManifest && !steamAppsPath) {
    return res.status(404).json({ error: 'Steam installation folder was not found.' });
  }

  // Steam's installdir must match the folder exactly, so it is never renamed
  // to "Name (2)". A normal library folder can be disambiguated.
  const sanitizedFolderName = parsedManifest
    ? parsedManifest.installDir
    : libraryFolderName(typeof folderPath === 'string' ? folderPath : undefined, displayName);
  if (parsedManifest && !isSafeFileName(sanitizedFolderName)) {
    return res.status(400).json({ error: 'Manifest installdir is not a safe folder name.' });
  }

  let targetFolder = sanitizedFolderName;
  if (!parsedManifest) {
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
  }

  const id = parsedManifest ? `steam-${parsedManifest.appId}` : allocateLibraryId(targetFolder);
  if (gamesMap.has(id)) {
    return res.status(409).json({ error: 'This game is already in the library.' });
  }

  const targetDir = parsedManifest
    ? path.join(steamAppsPath!, 'common', targetFolder)
    : path.join(GAMES_DIR, targetFolder);
  const manifestPath = parsedManifest
    ? path.join(steamAppsPath!, `appmanifest_${parsedManifest.appId}.acf`)
    : undefined;
  // Security: ensure targetDir is inside the allowed root (path-relative, not prefix).
  if (!isPathInside(parsedManifest ? steamAppsPath! : GAMES_DIR, targetDir)) {
    return res.status(400).json({ error: 'Invalid folder path' });
  }
  if (manifestPath && !isPathInside(steamAppsPath!, manifestPath)) {
    return res.status(400).json({ error: 'Invalid manifest path' });
  }
  if (
    parsedManifest &&
    (installDirectoryIsForeign(targetDir, cleanExe) || (manifestPath && !canReplaceManifest(manifestPath)))
  ) {
    return res.status(409).json({
      error: 'That Steam install was left alone.',
    });
  }

  const addedAt = new Date().toISOString();
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const targetExecutable = path.join(targetDir, cleanExe);
    if (!fs.existsSync(targetExecutable)) {
      fs.copyFileSync(PLACEHOLDER_EXE, targetExecutable);
    } else {
      upgradeLegacyPlaceholder(targetExecutable, PLACEHOLDER_EXE);
    }
    fs.writeFileSync(path.join(targetDir, '.game-name.txt'), displayName, 'utf-8');
    if (parsedManifest && manifestPath) {
      fs.writeFileSync(
        manifestPath,
        buildSimulatedManifest(parsedManifest.appId, parsedManifest.name, targetFolder),
        'utf-8'
      );
      writeManagedMarker(targetDir, { appId: parsedManifest.appId, executable: cleanExe });
    } else {
      writeGameMeta(targetFolder, {
        id,
        name: displayName,
        executable: cleanExe,
        origin: entryOrigin,
        addedAt,
      });
    }
  } catch (e) {
    console.warn('Could not write game folder files', e);
    return res.status(500).json({ error: 'Failed to create game folder' });
  }

  const newGame: StoredGame = {
    id,
    name: displayName,
    // Steam installs use the same `special/<installdir>` key the scan uses.
    folder: parsedManifest ? path.join('special', targetFolder) : targetFolder,
    executable: cleanExe,
    isRunning: false,
    elapsedSeconds: 0,
    origin: entryOrigin,
    addedAt,
    specialRootPath: parsedManifest ? steamAppsPath : undefined,
    steamAppId: parsedManifest?.appId,
  };
  applyTimerPreferences(newGame, prefs);

  gamesMap.set(id, newGame);
  if (parsedManifest && steamAppsPath) {
    saveSpecialGame({
      id,
      rootPath: steamAppsPath,
      installDir: targetFolder,
      executable: cleanExe,
      name: displayName,
      steamAppId: parsedManifest.appId,
    });
  }
  savePersistedState(true);
  kickoffLogo(newGame);
  // A game found by a live Reddit search is saved to the local quest
  // database too, so the next search finds it offline.
  const learned = learnFromLibraryAddition(cleanExe);
  res.json({ success: true, game: toPublicGame(newGame), addedToQuestDatabase: Boolean(learned) });
});

export default router;
