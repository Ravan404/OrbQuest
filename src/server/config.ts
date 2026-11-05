import path from 'node:path';
import type { BufferPreset, GameOrigin } from '../types.ts';
import type { ChildProcess } from 'node:child_process';

/**
 * Runtime settings. Override with environment variables:
 *
 *   ORBQUEST_BIND_HOST            default 127.0.0.1
 *   ORBQUEST_RATE_LIMIT_MAX       requests per window per IP (default 100)
 *   ORBQUEST_ROOT                 writable root (Games/ lives here)
 *   ORBQUEST_ASSET_ROOT           read-only bundled files (dist/, placeholder exe)
 */

export const PORT = Number(process.env.PORT || 3000);
export const BIND_HOST = process.env.ORBQUEST_BIND_HOST || '127.0.0.1';
export const PROJECT_ROOT = process.env.ORBQUEST_ROOT || process.cwd();
export const ASSET_ROOT = process.env.ORBQUEST_ASSET_ROOT || PROJECT_ROOT;
export const GAMES_DIR = process.env.ORBQUEST_GAMES_DIR || path.join(PROJECT_ROOT, 'Games');
export const PLACEHOLDER_EXE = path.join(ASSET_ROOT, 'placeholder', 'placeholder_runtime.exe');

/**
 * ORBQUEST_OFFLINE=1: no network requests at all (database updates, Discord's
 * icons). The bundled game database and saved icons still work. Used by
 * the tests, and available to anyone who wants the app to stay offline.
 */
export const OFFLINE = process.env.ORBQUEST_OFFLINE === '1';

export const RATE_LIMIT_WINDOW = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = Number(process.env.ORBQUEST_RATE_LIMIT_MAX || 100);

/**
 * Hostnames the API accepts in the `Host` header. A page can point a hostname
 * it controls at 127.0.0.1 (DNS rebinding) to look same-origin, so only loopback
 * names are accepted by default. ORBQUEST_ALLOWED_HOSTS adds more
 * (`*.example.com` works); a single `*` turns the check off.
 */
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];

function parseAllowedHosts(raw: string | undefined): string[] {
  const extra = (raw || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
}

export const ALLOWED_HOSTS = parseAllowedHosts(process.env.ORBQUEST_ALLOWED_HOSTS);

/** In-memory state of a game entry (never sent to clients as-is). */
export interface StoredGame {
  id: string;
  name: string;
  folder: string;
  executable: string;
  logoUrl?: string;
  /** Pending logo resolution, kicked off once per game. */
  logoPromise?: Promise<string | undefined>;
  isRunning: boolean;
  startedAt?: number;
  elapsedSeconds: number;
  process?: ChildProcess;
  targetMinutes?: number;
  bufferPreset?: BufferPreset;
  autoStop?: boolean;
  completed?: boolean;
  warmupRemainingSeconds?: number;
  session?: { started: number; base: number; warmup: number; resumed: boolean };
  /** Where the entry came from: added by hand, from the catalog, or found by the scan. */
  origin?: GameOrigin;
  /** ISO timestamp written when the entry was first created. */
  addedAt?: string;
  specialRootPath?: string;
  steamAppId?: number;
  /** Discord application id (game database) of a game added from the catalog. */
  appId?: string;
}
