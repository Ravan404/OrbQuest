import { performance } from 'node:perf_hooks';
import { BUFFER_PRESET_DURATIONS } from '../../types.ts';
import { computeGameTimerPhase } from '../../utils/timerUtils.ts';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GAMES_DIR, type StoredGame } from '../config.ts';
import { gamesMap } from './registry.ts';
import { savePersistedState } from './persistence.ts';

/** Placeholder processes and their timers. */

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
  const phase = computeGameTimerPhase(
    game.elapsedSeconds,
    game.targetMinutes,
    game.bufferPreset,
    game.warmupRemainingSeconds
  );
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
