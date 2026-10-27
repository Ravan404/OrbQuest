/**
 * iconStore.ts
 *
 * Game icons that are already on disk, so the UI never waits for a remote
 * image service to show them.
 *
 *   - Bundled icons: `public/game-icons/<key>.<ext>`, copied into `dist/` by the
 *     Vite build and therefore part of the Windows package. They are produced
 *     by `npm run icons:download` for every game of the local quest database.
 *   - Cached icons: remote icons that were resolved for other games (catalog
 *     entries, custom games) are saved once to `icon-cache/` next to the
 *     Games folder. They are served from the same origin on later launches.
 *
 * `<key>` is `normalizeGameKey(name)`, the same key the quest database uses,
 * so "Helldivers™ 2" and "Helldivers 2" share one icon file.
 *
 * Nothing in here blocks on the network. Only `saveRemoteIcon` downloads, and
 * it is only called from the background lookup in logo.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ASSET_ROOT, PROJECT_ROOT } from './config.ts';
import { normalizeGameKey } from './gameKey.ts';
import { listQuestDbRecords, recordExecutables, type QuestDbRecord } from './questLookup.ts';

/** Network lookup failures are expected offline; printed only with DQR_DEBUG=1. */
const debugLog = (...args: unknown[]): void => {
  if (process.env.DQR_DEBUG) console.debug(...args);
};

export const BUNDLED_ICON_URL_PREFIX = '/game-icons/';
export const CACHED_ICON_URL_PREFIX = '/game-icons-cache/';

/** Largest icon file that is stored. Icons are shown at 40-64 px. */
export const MAX_ICON_BYTES = 512 * 1024;
/**
 * Steam's CDN occasionally returns HTTP 200 with a tiny (<1 KB) blank placeholder
 * when an app's image asset has not been published. Requiring at least 1,500 bytes
 * for Steam CDN responses avoids caching blank placeholders.
 */
const STEAM_CDN_MIN_BYTES = 1_500;
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
  /** Folders that hold bundled icons, first match wins. */
  bundledDirs: string[];
  /** Writable folder for icons downloaded at runtime. */
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

/** Creates an icon store for the given bundled and cache folders. */
export function createIconStore(options: IconStoreOptions): IconStore {
  let index: Map<string, string> | null = null;
  let failures: Map<string, number> | null = null;
  const failuresFile = path.join(options.cacheDir, 'failed.json');

  function scan(): Map<string, string> {
    const found = new Map<string, string>();
    const sources: Array<{ dir: string; prefix: string }> = [
      ...options.bundledDirs.map((dir) => ({ dir, prefix: BUNDLED_ICON_URL_PREFIX })),
      { dir: options.cacheDir, prefix: CACHED_ICON_URL_PREFIX },
    ];
    for (const { dir, prefix } of sources) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue; // folder missing: nothing bundled / nothing cached yet
      }
      for (const file of files) {
        const match = ICON_FILE.exec(file);
        if (!match || found.has(match[1])) continue;
        found.set(match[1], prefix + file);
      }
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
        const minBytes = /(?:steamstatic|akamaihd)\.net/i.test(remoteUrl)
          ? STEAM_CDN_MIN_BYTES
          : MIN_ICON_BYTES;
        if (bytes.length < minBytes || bytes.length > MAX_ICON_BYTES) return undefined;

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

/** Where bundled icons are looked for: the built app first, then the source folder. */
export const BUNDLED_ICON_DIRS = [
  path.join(ASSET_ROOT, 'dist', 'game-icons'),
  path.join(ASSET_ROOT, 'public', 'game-icons'),
];

const store = createIconStore({
  bundledDirs: BUNDLED_ICON_DIRS,
  cacheDir: path.join(PROJECT_ROOT, 'icon-cache'),
});

export const ICON_CACHE_DIR = path.join(PROJECT_ROOT, 'icon-cache');

export function localIconForKey(key: string): string | undefined {
  return store.localIconForKey(key);
}

function findQuestRecordForNameOrExe(name: string, executable?: string): QuestDbRecord | undefined {
  const key = normalizeGameKey(name);
  const cleanExe = executable ? executable.replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase() : '';
  const records = listQuestDbRecords();
  if (key) {
    const byKeyOrAlias = records.find((item) => item.key === key || item.aliasKeys.includes(key));
    if (byKeyOrAlias) return byKeyOrAlias;
  }
  if (cleanExe) {
    return records.find((item) =>
      recordExecutables(item).some((exe) => exe.trim().toLowerCase() === cleanExe)
    );
  }
  return undefined;
}

/**
 * Icon for a game name (and optional executable). A name that is only an alias
 * of a database game ("osrs", "ow2") or matches a database executable resolves
 * to that game's local icon.
 */
export function localIconForName(name: string, executable?: string): string | undefined {
  const key = normalizeGameKey(name);
  if (key) {
    const direct = store.localIconForKey(key);
    if (direct) return direct;
  }
  const record = findQuestRecordForNameOrExe(name, executable);
  return record ? store.localIconForKey(record.key) : undefined;
}

/**
 * The key an icon is stored under for a game name: the database record's key
 * when the name is that game, one of its aliases, or matches its executable;
 * otherwise the plain normalized name key.
 */
export function canonicalIconKey(name: string, executable?: string): string {
  const key = normalizeGameKey(name);
  const record = findQuestRecordForNameOrExe(name, executable);
  return record ? record.key : key;
}

export function recentlyFailedIcon(key: string): boolean {
  return store.recentlyFailed(key);
}

export function markIconFailed(key: string): void {
  store.markFailed(key);
}

export function saveRemoteIcon(key: string, remoteUrl: string): Promise<string | undefined> {
  return store.saveRemoteIcon(key, remoteUrl);
}
