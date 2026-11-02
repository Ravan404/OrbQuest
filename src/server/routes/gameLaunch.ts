import { BUFFER_PRESET_DURATIONS } from '../../types.ts';
import { computeGameTimerPhase } from '../../utils/timerUtils.ts';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ASSET_ROOT, GAMES_DIR, PLACEHOLDER_EXE } from '../config.ts';
import { isPathInside } from '../security.ts';
import {
  applyTimerPreferences,
  beginGameSession,
  updateGameElapsed,
  findGameById,
  getExecutablePath,
  inferKnownExecutableForGame,
  parseTimerPreferences,
  toPublicGame,
  savePersistedState,
  writeGameMeta,
  type TimerPreferences,
} from '../gameStore.ts';
import {
  ensureManagedPlaceholderExecutable,
  hasPlaceholderRuntimeSignature,
  upgradeLegacyPlaceholder,
} from '../placeholderUpgrade.ts';
import { getSettings } from '../settingsStore.ts';
import { writePlaceholderIcon } from '../placeholderIcon.ts';
import { MANAGED_INSTALL_MARKER } from '../steamLibrarySafety.ts';
import type { IdParams } from './gameInput.ts';
import { withoutSecrets } from '../session.ts';

/** Starting a game: writes or repairs its placeholder and starts it with the timer. */

/** How long a launch may wait for the child `spawn` event before failing the request. */
const LAUNCH_SPAWN_TIMEOUT_MS = 15_000;

// POST /api/games/:id/launch
export function launchGame(req: Request<IdParams>, res: Response) {
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
    // A Steam quest's marker is in its install folder, the executable can be deeper.
    Boolean(
      game.specialRootPath &&
        fs.existsSync(path.join(game.specialRootPath, 'common', path.basename(game.folder), MANAGED_INSTALL_MARKER))
    ) ||
    fs.existsSync(path.join(workingDirectory, '.game-meta.json')) ||
    fs.existsSync(path.join(workingDirectory, '.game-name.txt'));

  if (isManagedDirectory) {
    const knownExe = inferKnownExecutableForGame(game.name, game.folder, game.appId);
    const fallbackExe = `${
      path
        .basename(game.folder)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '') || 'game'
    }.exe`;
    if (
      knownExe &&
      game.executable.toLowerCase() === fallbackExe.toLowerCase() &&
      knownExe.toLowerCase() !== game.executable.toLowerCase() &&
      (!fs.existsSync(executablePath) || hasPlaceholderRuntimeSignature(executablePath))
    ) {
      // A placeholder named after the folder: switch to the executable
      // Discord lists for this game.
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
    // The placeholder window shows the game's icon. In a Steam library only
    // next to our own placeholder, never into a real game's folder.
    if (isPathInside(GAMES_DIR, executablePath) || hasPlaceholderRuntimeSignature(executablePath)) {
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
  // A launched game never sees the desktop app's tokens.
  const childEnvironment = withoutSecrets();
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
}
