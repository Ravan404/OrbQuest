/**
 * redditClient.ts
 *
 * The only place that sends requests to Reddit - and to the Arctic Shift
 * archive of r/DiscordQuests, which the database update uses when Reddit
 * refuses to answer. Every caller (the live "Search Reddit" search, the
 * background database update, scripts/update-quest-database.ts) goes through
 * `politeFetch`, so together they stay far below the limits that get a client
 * rate limited or blocked:
 *
 *   - one request at a time per host, with a minimum gap between requests;
 *   - a rolling budget per minute (Reddit allows roughly 10 unauthenticated
 *     requests per minute; the app uses at most REDDIT_MAX_PER_MINUTE);
 *   - the server's own signals are obeyed: after HTTP 429, or when
 *     X-Ratelimit-Remaining reaches 0, nothing is sent until Retry-After /
 *     X-Ratelimit-Reset has passed (a cooldown shared by all callers);
 *   - nothing is retried automatically: callers report "rate limited" and the
 *     user decides when to try again.
 */

import { OFFLINE } from './config.ts';
import { APP_VERSION } from '../version.ts';

/**
 * Reddit asks API clients for a unique, descriptive User-Agent
 * (`platform:app-id:version (contact)`); generic ones such as "Mozilla/5.0"
 * are throttled hard. A fork or a repackaged build can identify itself with
 * DQR_REDDIT_USER_AGENT.
 */
export const REDDIT_USER_AGENT =
  process.env.DQR_REDDIT_USER_AGENT?.trim() ||
  `desktop:com.orbquest:v${APP_VERSION} (+https://github.com/Ravan404/OrbQuest)`;

export type RemoteHost = 'reddit' | 'arctic-shift';

interface HostPolicy {
  /** Smallest gap between two requests to the host. */
  minIntervalMs: number;
  /** Most requests to the host in any 60 second window. */
  maxPerMinute: number;
  /** Cooldown after a 429 that names no reset time. */
  defaultCooldownMs: number;
  /** Cooldown after a 403 (the host refuses this client for now). */
  refusedCooldownMs: number;
}

export const REDDIT_MAX_PER_MINUTE = 8;

const DEFAULT_POLICIES: Record<RemoteHost, HostPolicy> = {
  reddit: {
    minIntervalMs: 2_000,
    maxPerMinute: REDDIT_MAX_PER_MINUTE,
    defaultCooldownMs: 60_000,
    refusedCooldownMs: 5 * 60_000,
  },
  'arctic-shift': {
    minIntervalMs: 1_500,
    maxPerMinute: 20,
    defaultCooldownMs: 60_000,
    refusedCooldownMs: 5 * 60_000,
  },
};

const MAX_COOLDOWN_MS = 15 * 60_000;
const WINDOW_MS = 60_000;

interface HostState {
  queue: Promise<void>;
  lastRequestAt: number;
  recent: number[];
  cooldownUntil: number;
  policy: HostPolicy;
}

function freshState(host: RemoteHost): HostState {
  return {
    queue: Promise.resolve(),
    lastRequestAt: 0,
    recent: [],
    cooldownUntil: 0,
    policy: { ...DEFAULT_POLICIES[host] },
  };
}

const hosts: Record<RemoteHost, HostState> = {
  reddit: freshState('reddit'),
  'arctic-shift': freshState('arctic-shift'),
};

export interface PoliteResponse {
  /** The answer, or null when nothing was sent (cooldown, budget) or the network failed. */
  response: Response | null;
  /** HTTP status; 0 without a response. */
  status: number;
  /** The host asked us to slow down (429, spent budget) - no answer for now. */
  rateLimited: boolean;
  /** Network error, timeout or an HTTP error other than 429. */
  failed: boolean;
  /** Milliseconds until the host may be asked again (0 = now). */
  retryAfterMs: number;
}

export interface PoliteFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Background work may wait (up to a minute) for the per-minute budget;
   * interactive searches never do - they report "rate limited" right away.
   */
  waitForBudget?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Case-insensitive header lookup. */
function headerValue(headers: unknown, name: string): string | undefined {
  const source = headers as { get?: (key: string) => unknown } | null | undefined;
  if (!source || typeof source.get !== 'function') return undefined;
  const titled = name.replace(/(^|-)([a-z])/g, (_, dash: string, char: string) => dash + char.toUpperCase());
  for (const key of [name, name.toLowerCase(), titled]) {
    const value = source.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return undefined;
}

function numberHeader(headers: unknown, name: string): number | undefined {
  const value = Number(headerValue(headers, name));
  return Number.isFinite(value) ? value : undefined;
}

/** Retry-After as milliseconds (seconds or an HTTP date). */
function retryAfterMs(headers: unknown): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function clampCooldown(ms: number): number {
  return Math.min(Math.max(ms, 1_000), MAX_COOLDOWN_MS);
}

function startCooldown(state: HostState, ms: number): number {
  const wait = clampCooldown(ms);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + wait);
  return wait;
}

/** Milliseconds until `host` may be asked again (0 = now). */
export function cooldownRemainingMs(host: RemoteHost): number {
  return Math.max(0, hosts[host].cooldownUntil - Date.now());
}

export function isCoolingDown(host: RemoteHost): boolean {
  return cooldownRemainingMs(host) > 0;
}

/**
 * Sends one GET request to `host`, politely (see the file comment).
 * Never throws; inspect `rateLimited` / `failed`.
 */
export async function politeFetch(
  host: RemoteHost,
  url: string,
  options: PoliteFetchOptions = {}
): Promise<PoliteResponse> {
  if (OFFLINE) return { response: null, status: 0, rateLimited: false, failed: true, retryAfterMs: 0 };
  const state = hosts[host];
  const previous = state.queue;
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const limited = (waitMs: number): PoliteResponse => ({
    response: null,
    status: 0,
    rateLimited: true,
    failed: false,
    retryAfterMs: Math.max(0, Math.round(waitMs)),
  });

  try {
    if (Date.now() < state.cooldownUntil) return limited(state.cooldownUntil - Date.now());

    let now = Date.now();
    state.recent = state.recent.filter((at) => now - at < WINDOW_MS);
    if (state.recent.length >= state.policy.maxPerMinute) {
      const waitMs = WINDOW_MS - (now - state.recent[0]) + 50;
      if (!options.waitForBudget) return limited(waitMs);
      await sleep(waitMs);
      now = Date.now();
      state.recent = state.recent.filter((at) => now - at < WINDOW_MS);
    }

    const gap = state.policy.minIntervalMs - (Date.now() - state.lastRequestAt);
    if (gap > 0) await sleep(gap);
    state.lastRequestAt = Date.now();
    state.recent.push(state.lastRequestAt);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: options.headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      return { response: null, status: 0, rateLimited: false, failed: true, retryAfterMs: 0 };
    }

    const status = Number(response.status) || 0;
    const reset = numberHeader(response.headers, 'x-ratelimit-reset');
    const resetMs = reset !== undefined ? reset * 1000 : undefined;

    if (status === 429) {
      const wait = startCooldown(state, retryAfterMs(response.headers) ?? resetMs ?? state.policy.defaultCooldownMs);
      return { response, status, rateLimited: true, failed: false, retryAfterMs: wait };
    }
    if (status === 403) {
      // Reddit answers 403 to clients it refuses for a while; asking again at
      // once would only make that worse.
      startCooldown(state, state.policy.refusedCooldownMs);
      return { response, status, rateLimited: false, failed: true, retryAfterMs: 0 };
    }

    const remaining = numberHeader(response.headers, 'x-ratelimit-remaining');
    if (remaining !== undefined && remaining <= 0) {
      // A valid answer, but the budget is spent: pause until the reset.
      startCooldown(state, resetMs ?? state.policy.defaultCooldownMs);
    }
    return { response, status, rateLimited: false, failed: !response.ok, retryAfterMs: 0 };
  } finally {
    release();
  }
}

