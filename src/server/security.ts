import path from 'path';
import { ALLOWED_HOSTS, RATE_LIMIT_WINDOW } from './config.ts';

/**
 * Path containment check.
 *
 * The previous implementation used `child.startsWith(parent)` which is a
 * classic prefix bug: `/proje/Games-evil/...` would pass a check against
 * `/proje/Games`. `path.relative` makes the boundary explicit.
 */
export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Strict file-name validation for values that become part of a filesystem
 * path (executable names, folder names).
 *
 * Rejects separators, Windows reserved device names (CON, NUL, ...),
 * control characters and characters illegal on NTFS.
 */
export function isSafeFileName(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value !== path.basename(value)) return false; // contains a separator
  if (/[\\/\x00-\x1F<>:"|?*]/.test(value)) return false;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) return false;
  return true;
}

/**
 * An executable inside a game folder: a file name (`game.exe`) or a relative
 * path as Discord expects it (`win64/game.exe`). Every segment must be a safe
 * file name; `..`, drive letters and absolute paths are refused.
 */
export function isSafeExecutablePath(value: string): boolean {
  if (typeof value !== 'string' || !/\.exe$/i.test(value)) return false;
  const segments = value.split(/[\\/]/);
  return (
    segments.length <= 8 &&
    segments.every((segment) => segment !== '.' && segment !== '..' && !/[. ]$/.test(segment) && isSafeFileName(segment))
  );
}

/**
 * Directory segments that are engine layout, not a game's install folder.
 * `...\Binaries\Win64\Game.exe` must not become a library folder named `Win64`.
 */
const GENERIC_FOLDER_SEGMENTS = new Set([
  'bin',
  'binaries',
  'binary',
  'client',
  'common',
  'game',
  'live',
  'steamapps',
  'win32',
  'win64',
  'x64',
]);

/**
 * Folder name to create under Games/ from a scraped path hint.
 *
 * Splits on both separators, so a Windows path is not treated as one filename
 * on Linux (`path.basename` only splits on the host separator). A generic tail
 * such as `Win64` falls back to the display name instead of colliding with
 * every other Unreal game.
 */
export function libraryFolderName(folderPath: string | undefined, fallback: string): string {
  const raw = typeof folderPath === 'string' ? folderPath.trim() : '';
  const segments =
    !raw || raw.toLowerCase() === 'not found'
      ? []
      : raw.split(/[\\/]+/).filter((segment) => segment && segment !== '.' && segment !== '..');
  const last = segments[segments.length - 1];
  // A generic tail (Win64, Binaries, game) is not a library name. Use the
  // display name so two Unreal games do not both become a folder called Win64.
  const chosen = last && !GENERIC_FOLDER_SEGMENTS.has(last.toLowerCase()) ? last : fallback;
  const cleaned = chosen.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned && isSafeFileName(cleaned) ? cleaned : 'Game';
}

/**
 * Host-header check (DNS-rebinding defence).
 *
 * Express' `req.hostname` is the `Host` header with the port stripped and the
 * IPv6 brackets removed, so the comparison happens on the bare name.
 *
 * A missing Host header is allowed: HTTP/1.0 clients and raw sockets do not
 * send one, and a local process can forge any Host value it likes anyway. What
 * this stops is a *browser* being tricked into sending a hostname the attacker
 * controls, which is the only way to make a cross-origin request look
 * same-origin without triggering a CORS preflight.
 */
export function isAllowedRequestHost(hostname: string | undefined): boolean {
  if (!hostname) return true;
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  return ALLOWED_HOSTS.some((entry) => {
    if (entry === '*') return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.com"
      return host === entry.slice(2) || host.endsWith(suffix);
    }
    return host === entry;
  });
}

/**
 * Cross-Origin / Localhost CSRF defence for state-changing HTTP methods.
 *
 * Blocks cross-site browser requests (`Sec-Fetch-Site: cross-site` or an
 * `Origin` header whose hostname is not in `ALLOWED_HOSTS`) from invoking
 * `POST`/`PUT`/`PATCH`/`DELETE` endpoints on the local server.
 */
export function isAllowedOriginForMethod(
  method: string | undefined,
  originHeader: string | undefined,
  secFetchSiteHeader: string | undefined
): boolean {
  const verb = (method || 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return true;

  if (typeof secFetchSiteHeader === 'string') {
    const site = secFetchSiteHeader.trim().toLowerCase();
    if (site === 'cross-site') return false;
  }

  if (typeof originHeader === 'string' && originHeader.trim() !== '') {
    const rawOrigin = originHeader.trim();
    if (rawOrigin.toLowerCase() === 'null') return false;
    try {
      const parsed = new URL(rawOrigin);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      if (!isAllowedRequestHost(hostname)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Minimal in-memory fixed-window rate limiter.
 * One limiter instance per logical endpoint group; entries are keyed by
 * client ip and cleaned up on every window reset.
 */
export function createRateLimiter(maxRequests: number) {
  const map = new Map<string, { count: number; resetTime: number }>();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, record] of map.entries()) {
      if (now > record.resetTime) map.delete(key);
    }
  };
  const interval = setInterval(cleanup, RATE_LIMIT_WINDOW);
  interval.unref();

  return function checkRateLimit(identifier: string): boolean {
    const now = Date.now();
    const record = map.get(identifier);

    if (!record || now > record.resetTime) {
      map.set(identifier, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
      return true;
    }
    if (record.count >= maxRequests) return false;
    record.count++;
    return true;
  };
}
