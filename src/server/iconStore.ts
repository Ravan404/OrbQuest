/**
 * Game icons. Almost every game of the database (gameDatabase.ts) has an
 * icon on Discord's CDN (`cdn.discordapp.com/app-icons/<id>/<hash>.png`); the
 * window shows that address right away. A few programs Discord has no icon
 * for (Firefox, Opera GX) use their website's icon, which only the server
 * downloads. The icon of a library game is saved once to the icon cache, so
 * it also shows offline and the placeholder window can use it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OFFLINE, PROJECT_ROOT } from './config.ts';
import type { DatabaseGame } from './gameDatabaseSource.ts';

/** Network lookup failures are expected offline; printed only with DQR_DEBUG=1. */
const debugLog = (...args: unknown[]): void => {
  if (process.env.DQR_DEBUG) console.debug(...args);
};

export const CACHED_ICON_URL_PREFIX = '/game-icons-cache/';

/** Largest icon file that is stored. Icons are shown at 40-64 px. */
export const MAX_ICON_BYTES = 512 * 1024;
const MIN_ICON_BYTES = 64;
/** How long a game without an icon is not searched again (persisted). */
export const ICON_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const ICON_UA = 'OrbQuest/1.0 (game icon cache)';

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
};
const ICON_FILE = /^([a-z0-9]+)\.(png|jpg|webp|gif|ico|svg)$/;

/**
 * Inspects magic bytes so corrupt responses or HTML error pages served with an
 * image content-type are never persisted into `icon-cache/`.
 */
function detectImageExtension(bytes: Buffer, contentType: string): string | undefined {
  if (bytes.length < MIN_ICON_BYTES) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }

  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  // GIF: GIF87a or GIF89a
  if (bytes.length >= 6) {
    const gifHeader = bytes.toString('ascii', 0, 6);
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'gif';
  }

  // ICO: 00 00 01 00
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'ico';
  }

  // SVG: starts with XML/SVG tag and declared as image/svg+xml
  if (contentType === 'image/svg+xml') {
    const head = bytes.subarray(0, 256).toString('utf8').trimStart();
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  }

  return undefined;
}

export interface IconStoreOptions {
  /** Writable folder for downloaded icons. */
  cacheDir: string;
}

export interface IconStore {
  /** URL of the icon stored for a key, or undefined. Never touches the network. */
  localIconForKey(key: string): string | undefined;
  /** True when a lookup for this key failed recently (no new request). */
  recentlyFailed(key: string): boolean;
  markFailed(key: string): void;
  /** Downloads a remote image into the cache. Returns its local URL. */
  saveRemoteIcon(key: string, remoteUrl: string): Promise<string | undefined>;
}

/** Creates an icon store for the given cache folder. */
export function createIconStore(options: IconStoreOptions): IconStore {
  let index: Map<string, string> | null = null;
  let failures: Map<string, number> | null = null;
  const failuresFile = path.join(options.cacheDir, 'failed.json');

  function scan(): Map<string, string> {
    const found = new Map<string, string>();
    let files: string[] = [];
    try {
      files = fs.readdirSync(options.cacheDir);
    } catch {
      return found; // nothing cached yet
    }
    for (const file of files) {
      const match = ICON_FILE.exec(file);
      if (match && !found.has(match[1])) found.set(match[1], CACHED_ICON_URL_PREFIX + file);
    }
    return found;
  }

  function getIndex(): Map<string, string> {
    if (!index) index = scan();
    return index;
  }

  function getFailures(): Map<string, number> {
    if (!failures) {
      failures = new Map();
      try {
        const raw = JSON.parse(fs.readFileSync(failuresFile, 'utf8')) as Record<string, number>;
        for (const [key, at] of Object.entries(raw)) {
          if (typeof at === 'number' && Date.now() - at < ICON_FAILURE_TTL_MS) failures.set(key, at);
        }
      } catch {
        // no file yet
      }
    }
    return failures;
  }

  function persistFailures(): void {
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true });
      fs.writeFileSync(failuresFile, JSON.stringify(Object.fromEntries(getFailures())), 'utf8');
    } catch (error) {
      debugLog('Could not save icon lookup failures:', error);
    }
  }

  return {
    localIconForKey(key) {
      if (!key) return undefined;
      return getIndex().get(key);
    },

    recentlyFailed(key) {
      const at = getFailures().get(key);
      return at !== undefined && Date.now() - at < ICON_FAILURE_TTL_MS;
    },

    markFailed(key) {
      if (!key) return;
      getFailures().set(key, Date.now());
      persistFailures();
    },

    async saveRemoteIcon(key, remoteUrl) {
      if (!/^[a-z0-9]+$/.test(key) || !/^https:\/\//i.test(remoteUrl)) return undefined;
      const existing = getIndex().get(key);
      if (existing) return existing;
      try {
        const response = await fetch(remoteUrl, {
          headers: { 'User-Agent': ICON_UA, Accept: 'image/png,image/webp,image/jpeg,image/*;q=0.8' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_ICON_BYTES) return undefined;
        const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_TYPES[type] && !type.startsWith('image/')) return undefined;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < MIN_ICON_BYTES || bytes.length > MAX_ICON_BYTES) return undefined;

        const extension = detectImageExtension(bytes, type) ?? IMAGE_TYPES[type];
        if (!extension) return undefined;

        fs.mkdirSync(options.cacheDir, { recursive: true });
        const target = path.join(options.cacheDir, `${key}.${extension}`);
        const temp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temp, bytes);
        fs.renameSync(temp, target);
        const url = CACHED_ICON_URL_PREFIX + `${key}.${extension}`;
        getIndex().set(key, url);
        if (failures?.has(key)) {
          failures.delete(key);
          persistFailures();
        }
        return url;
      } catch (error) {
        debugLog(`Icon download failed for "${key}":`, error);
        return undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Application instance
// ---------------------------------------------------------------------------

export const ICON_CACHE_DIR = path.join(PROJECT_ROOT, 'icon-cache');

const store = createIconStore({ cacheDir: ICON_CACHE_DIR });

type IconSource = Pick<DatabaseGame, 'id' | 'icon' | 'site'>;

/** The game's icon on Discord's CDN. */
export function discordIconUrl(game: Pick<DatabaseGame, 'id' | 'icon'>, size = 128): string | undefined {
  return game.icon ? `https://cdn.discordapp.com/app-icons/${game.id}/${game.icon}.png?size=${size}` : undefined;
}

/**
 * Where the game's icon is downloaded from: Discord's CDN, or for a program
 * Discord has no icon for (Firefox), its website's icon through Google's
 * favicon service, which returns the site's largest icon.
 */
export function remoteIconUrl(game: IconSource): string | undefined {
  if (game.icon) return discordIconUrl(game, 256);
  return game.site ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(game.site)}&sz=256` : undefined;
}

/** File name part of a game's saved icon: `r-operagx` -> `roperagx`. */
function iconKey(game: Pick<DatabaseGame, 'id'>): string {
  return game.id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The saved icon of a game, without touching the network. */
export function localGameIcon(game: Pick<DatabaseGame, 'id'>): string | undefined {
  return store.localIconForKey(iconKey(game));
}

/** Saves the game's icon to the icon cache once. Returns its local URL. */
export async function cacheGameIcon(game: IconSource): Promise<string | undefined> {
  const key = iconKey(game);
  const remote = remoteIconUrl(game);
  if (!remote || OFFLINE || store.recentlyFailed(key)) return store.localIconForKey(key);
  const local = await store.saveRemoteIcon(key, remote);
  if (!local) store.markFailed(key);
  return local;
}
