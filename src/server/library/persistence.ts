import { BUFFER_PRESET_DURATIONS, MAX_QUEST_TARGET_MINUTES, type BufferPreset } from '../../types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR, type StoredGame } from '../config.ts';
import { writeJsonAtomic } from '../fsUtil.ts';
import { gamesMap } from './registry.ts';

/**
 * Saved timers and progress (`Games/.state.json`) and Steam quest records.
 *
 * Running state lives in memory only (the child process dies with the
 * server). The accumulated quest runtime (`elapsedSeconds`) is saved so an
 * interrupted run can resume, but a completed counter is reset when the app
 * starts again: a finished quest is a closed event, so the library always
 * starts a new day at 00:00.
 */

const STATE_FILE = () => path.join(GAMES_DIR, '.state.json');
const SPECIAL_GAMES_FILE = () => path.join(GAMES_DIR, '.special-games.json');
export interface SpecialGameRecord {
  id: string;
  rootPath: string;
  installDir: string;
  executable: string;
  name: string;
  steamAppId: number;
  /** Discord application id of the catalog game. */
  appId?: string;
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

      // A completed counter is not restored: after a restart a finished quest shows
      // 00:00. Old entries without a known buffer preset counted time before the
      // spawn and cannot be credited.
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

export function readSpecialGames(): SpecialGameRecord[] {
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
    writeJsonAtomic(
      SPECIAL_GAMES_FILE(),
      readSpecialGames().filter((item) => item.id !== id)
    );
  } catch (error) {
    console.warn('Could not update simulated Steam game registry:', error);
  }
}
