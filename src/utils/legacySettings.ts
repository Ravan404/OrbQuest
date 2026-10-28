import { BUFFER_PRESET_DURATIONS, type BufferPreset, type Game } from '../types';

/**
 * Versions up to 1.2.25 kept timer preferences and the sound switch in the
 * browser's localStorage. They are now saved by the server. This moves any
 * values still found in this browser to the server once, then removes them.
 *
 * Only games the server has no timer preferences for are touched, so a value
 * saved through the server always wins.
 */

const TIMERS_KEY = 'discordquest_timers';
const SOUND_KEY = 'discordquest_sound';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable (private mode); nothing to clean up then.
  }
}

export interface LegacyMigrationResult {
  gamesChanged: boolean;
  soundEnabled?: boolean;
}

export async function migrateLegacyBrowserSettings(games: Game[]): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { gamesChanged: false };

  const rawTimers = readStorage(TIMERS_KEY);
  if (rawTimers) {
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(rawTimers) ?? {};
    } catch {
      parsed = {};
    }
    let allSaved = true;
    for (const game of games) {
      const legacy = parsed[game.id];
      if (!legacy || typeof legacy !== 'object') continue;
      if (game.targetMinutes !== undefined || game.bufferPreset !== undefined || game.autoStop !== undefined) continue;
      const body: Record<string, unknown> = {};
      if (Number.isInteger(legacy.targetMinutes)) body.targetMinutes = legacy.targetMinutes;
      if (typeof legacy.autoStop === 'boolean') body.autoStop = legacy.autoStop;
      if (typeof legacy.bufferPreset === 'string' && legacy.bufferPreset in BUFFER_PRESET_DURATIONS) {
        body.bufferPreset = legacy.bufferPreset as BufferPreset;
      }
      if (Object.keys(body).length === 0) continue;
      const status = await fetch(`/api/games/${encodeURIComponent(game.id)}/timer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((res) => res.status)
        .catch(() => 0);
      if (status === 200) result.gamesChanged = true;
      // 400 (unusable old value) and 404 (game gone) will never succeed; drop them.
      else if (status !== 400 && status !== 404) allSaved = false;
    }
    if (allSaved) removeStorage(TIMERS_KEY);
  }

  const rawSound = readStorage(SOUND_KEY);
  if (rawSound === 'true' || rawSound === 'false') {
    const soundEnabled = rawSound === 'true';
    const ok = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soundEnabled }),
    })
      .then((res) => res.ok)
      .catch(() => false);
    if (ok) {
      result.soundEnabled = soundEnabled;
      removeStorage(SOUND_KEY);
    }
  } else if (rawSound !== null) {
    removeStorage(SOUND_KEY);
  }

  return result;
}
