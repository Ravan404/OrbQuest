/**
 * Tells the window when a newer OrbQuest release is out. GitHub's API is
 * asked for the latest published release (drafts and pre-releases are not
 * returned) shortly after the start and then every six hours. Nothing is
 * downloaded or installed: the window links to the release page.
 *
 *   DQR_UPDATE_CHECK=0   never ask (DQR_OFFLINE=1 also turns it off)
 */

import { OFFLINE } from './config.ts';
import { APP_VERSION } from '../version.ts';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/Ravan404/OrbQuest/releases/latest';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

export interface UpdateInfo {
  version: string;
  /** The release page on GitHub. */
  url: string;
}

let latest: UpdateInfo | null = null;

/** The numeric parts of `v1.4.0` or `1.4.0`, or null. */
function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `candidate` is a higher version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = versionParts(candidate);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** GitHub's answer as an update, or null when it is not a usable release. */
export function parseLatestRelease(body: unknown): UpdateInfo | null {
  if (!body || typeof body !== 'object') return null;
  const release = body as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const url = typeof release.html_url === 'string' ? release.html_url : '';
  if (!versionParts(tag) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\//.test(url)) return null;
  return { version: tag.replace(/^v/, ''), url };
}

/** Asks GitHub once. A failure keeps what the last check found. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { 'User-Agent': `OrbQuest/${APP_VERSION} (update check)`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return;
    const release = parseLatestRelease(await response.json());
    if (release) latest = release;
  } catch {
    // Offline or GitHub unreachable: the next check tries again.
  }
}

/** The newer release, if the last check found one. */
export function availableUpdate(): UpdateInfo | null {
  return latest && isNewerVersion(latest.version, APP_VERSION) ? latest : null;
}

export function scheduleUpdateChecks(): void {
  if (OFFLINE || process.env.DQR_UPDATE_CHECK === '0') return;
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY_MS).unref();
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS).unref();
}
