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

/**
 * Where a catalog card comes from:
 *  - `database`: the local quest database has an executable for this game;
 *  - `catalog`:  a known game without local quest data (Reddit is searched
 *                online when it is opened);
 *  - `online`:   not in the database, found by a live Reddit search.
 */
export type CatalogSource = 'database' | 'catalog' | 'online';

export interface CatalogGame {
  name: string;
  icon?: string;
  source?: CatalogSource;
  /** Executables the local database (or the online search) has for this game. */
  executableCount?: number;
}

export interface RedditMatch {
  title: string;
  /** Clean resolved game title of this result (used when adding to the library). */
  gameName?: string;
  url: string;
  folderPath: string;
  executableName: string;
  hasFolder: boolean;
  inLibrary: boolean;
  source?: 'verified' | 'pcgw' | 'steam' | 'steam-manifest' | 'reddit' | 'web';
  questMethod?: 'process' | 'steam-manifest';
  steamAppId?: number;
  manifestFileName?: string;
  manifestContent?: string;
  confidence?: 'verified' | 'high' | 'medium' | 'experimental';
  notes?: string;
  logoUrl?: string;
  isPrimary?: boolean;
  /** `database`: local quest database; `online`: live Reddit search. */
  foundVia?: 'database' | 'online';
  /** A database result that the live Reddit search returned as well. */
  onlineConfirmed?: boolean;
}

export type SearchMatch = RedditMatch;

/** Server profile returned by GET /api/profile. */
export interface AppProfile {
  version: string;
  /** Folder that holds the library entries (Games/). */
  gamesFolder?: string;
  questDatabase?: {
    updatedAt?: string;
    bundled?: { updatedAt?: string; checkedThrough?: string; entries?: number; games?: number };
    local?: { updatedAt?: string; entries?: number };
  };
}

export interface SearchQuestsResponse {
  matches: SearchMatch[];
  query: string;
  /** `database` (local first) or `online` ("Search Reddit"). */
  mode?: 'database' | 'online';
  redditRateLimited?: boolean;
  sourcesSearched?: string[];
  totalFound: number;
  databaseCount?: number;
  /** Live Reddit results that are not already in the database. */
  onlineCount?: number;
  /** Live Reddit results identical to a database result (hidden). */
  onlineDuplicateCount?: number;
  /** True when Reddit was searched live for this answer. */
  onlineSearched?: boolean;
  /** Reddit could not be reached (network or HTTP error) - not the same as "no results". */
  onlineFailed?: boolean;
  /** When Reddit is rate limiting: seconds until the next search is possible. */
  redditRetryAfterSeconds?: number;
  redditCount?: number;
  secondaryCount?: number;
}


export interface ToastNotification {
  id: string;
  title: string;
  message: string;
  type?: 'success' | 'info' | 'milestone' | 'warning';
}
