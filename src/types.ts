export type BufferPreset = 'fast' | 'normal' | 'long' | 'off';

/** Final process-alive margin; Discord detection is not observable by this app. */
export const FINAL_SAFETY_MARGIN_SECONDS = 10;

/** Launch and edit reject anything above this. 1440 minutes is 24 hours. */
export const MAX_QUEST_TARGET_MINUTES = 1440;

/**
 * Where a library entry came from. Persisted per game folder in
 * `.game-meta.json` so a manually added ("custom") entry stays visually
 * distinct from one added through the online catalog.
 */
export type GameOrigin = 'custom' | 'catalog' | 'scanned';

export const GAME_ORIGINS: GameOrigin[] = ['custom', 'catalog', 'scanned'];

export function isGameOrigin(value: unknown): value is GameOrigin {
  return typeof value === 'string' && (GAME_ORIGINS as string[]).includes(value);
}

export interface Game {
  id: string;
  name: string;
  folder: string;
  executable: string;
  logoUrl?: string;
  isRunning: boolean;
  startedAt?: number;
  warmupRemainingSeconds?: number;
  completed?: boolean;
  elapsedSeconds: number;
  targetMinutes?: number; // Target timer in minutes (e.g. 15, or 0 for unlimited)
  bufferPreset?: BufferPreset; // Post-spawn detection preset
  autoStop?: boolean; // Whether to automatically stop runner when target is reached
  origin?: GameOrigin; // custom | catalog | scanned
  addedAt?: string; // ISO timestamp of when the entry was created
  specialRootPath?: string;
  steamAppId?: number;
}

/** Seconds waited after launch (`start`) and kept after the target (`end`). */
export const BUFFER_PRESET_DURATIONS: Record<BufferPreset, { total: number; start: number; end: number }> = {
  fast: {
    total: 3 + FINAL_SAFETY_MARGIN_SECONDS,
    start: 3,
    end: FINAL_SAFETY_MARGIN_SECONDS,
  },
  normal: {
    total: 5 + FINAL_SAFETY_MARGIN_SECONDS,
    start: 5,
    end: FINAL_SAFETY_MARGIN_SECONDS,
  },
  long: {
    total: 8 + FINAL_SAFETY_MARGIN_SECONDS,
    start: 8,
    end: FINAL_SAFETY_MARGIN_SECONDS,
  },
  off: {
    total: 0,
    start: 0,
    end: 0,
  },
};

/** A game of the Discord game database, as the catalog lists it. */
export interface CatalogGame {
  /** Discord application id. */
  id: string;
  name: string;
  icon?: string;
  /** Windows executables Discord recognises, e.g. `win64/valorant-win64-shipping.exe`. */
  executables: string[];
  /** True when a library entry is this game. */
  inLibrary: boolean;
  /** `reddit`: Discord's list has no executable for it; the one shown comes from r/DiscordQuests. */
  source?: 'reddit';
}

/** Server profile returned by GET /api/profile. */
export interface AppProfile {
  version: string;
  /** Folder that holds the library entries (Games/). */
  gamesFolder?: string;
  gameDatabase?: {
    updatedAt?: string;
    games?: number;
    from?: 'bundled' | 'downloaded';
    checkedAt?: string;
  };
}

export interface ToastNotification {
  id: string;
  title: string;
  message: string;
  type?: 'success' | 'info' | 'milestone' | 'warning';
}
