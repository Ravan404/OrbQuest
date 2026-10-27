/**
 * settingsStore.ts
 *
 * App-wide preferences saved next to the library (`Games/.settings.json`).
 *
 * They used to live in the browser's localStorage. The desktop build picks a
 * new loopback port on every start, and localStorage belongs to one origin
 * (scheme + host + port), so every start began with empty settings. The server
 * folder is the same on every start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GAMES_DIR } from './config.ts';
import { writeJsonAtomic } from './fsUtil.ts';

export type ThemeSetting = 'system' | 'light' | 'dark';

const THEMES: ThemeSetting[] = ['system', 'light', 'dark'];

export interface AppSettings {
  soundEnabled: boolean;
  /** `system` follows the Windows light/dark setting. */
  theme: ThemeSetting;
}

const DEFAULT_SETTINGS: AppSettings = { soundEnabled: true, theme: 'system' };

const isTheme = (value: unknown): value is ThemeSetting =>
  typeof value === 'string' && (THEMES as string[]).includes(value);

const SETTINGS_FILE = () => path.join(GAMES_DIR, '.settings.json');

let current: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (current) return current;
  current = { ...DEFAULT_SETTINGS };
  try {
    const file = SETTINGS_FILE();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppSettings>;
      if (typeof parsed.soundEnabled === 'boolean') current.soundEnabled = parsed.soundEnabled;
      if (isTheme(parsed.theme)) current.theme = parsed.theme;
    }
  } catch (error) {
    console.warn('Could not read app settings:', error);
  }
  return current;
}

/** Validates and saves the fields that are present. Returns the new settings or an error. */
export function updateSettings(body: Record<string, unknown>): AppSettings | string {
  const next = { ...getSettings() };
  if (body.soundEnabled !== undefined) {
    if (typeof body.soundEnabled !== 'boolean') return 'soundEnabled must be true or false.';
    next.soundEnabled = body.soundEnabled;
  }
  if (body.theme !== undefined) {
    if (!isTheme(body.theme)) return 'theme must be system, light or dark.';
    next.theme = body.theme;
  }
  try {
    writeJsonAtomic(SETTINGS_FILE(), next);
  } catch (error) {
    console.warn('Could not save app settings:', error);
    return 'Could not save the settings.';
  }
  current = next;
  return next;
}

/** Test hook: forget the cached copy. */
export function resetSettingsCache(): void {
  current = null;
}
