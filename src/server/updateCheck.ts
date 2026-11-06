/**
 * Tells the window when a newer OrbQuest release is out. GitHub's API is
 * asked for the latest published release (drafts and pre-releases are not
 * returned) right at the start and then every six hours. The API allows 60
 * requests an hour per IP address, which people behind one address can use
 * up, so when it does not answer the release page's redirect is read instead.
 * A failed check is tried again after ten minutes. Installing it is
 * updateInstall.ts.
 *
 *   ORBQUEST_UPDATE_CHECK=0   never ask (ORBQUEST_OFFLINE=1 also turns it off)
 */

import { OFFLINE } from './config.ts';
import { APP_VERSION } from '../version.ts';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/Ravan404/OrbQuest/releases/latest';
/** Redirects to the latest published release, without the API's limit. */
export const LATEST_RELEASE_PAGE = 'https://github.com/Ravan404/OrbQuest/releases/latest';
/** Release files are only ever downloaded from here. */
export const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/Ravan404/OrbQuest/releases/download/';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 10 * 60 * 1000;
/** How long GET /api/update waits for a check that is still running. */
const ANSWER_WAIT_MS = 8_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT = `OrbQuest/${APP_VERSION} (update check)`;

export interface UpdateInfo {
  version: string;
  /** The release page on GitHub. */
  url: string;
  /** Download address of each release file, by file name. */
  assets?: Record<string, string>;
}

let latest: UpdateInfo | null = null;
let running: Promise<boolean> | null = null;

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
  const assets: Record<string, string> = {};
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const { name, browser_download_url: download } = (asset ?? {}) as Record<string, unknown>;
    if (
      typeof name === 'string' &&
      /^[\w.-]+$/.test(name) &&
      typeof download === 'string' &&
      download.startsWith(RELEASE_DOWNLOAD_PREFIX)
    ) {
      assets[name] = download;
    }
  }
  return { version: tag.replace(/^v/, ''), url, ...(Object.keys(assets).length ? { assets } : {}) };
}

/** The release a redirect to `.../releases/tag/v1.2.3` points at, or null. */
export function parseReleaseRedirect(location: string | null): UpdateInfo | null {
  const match = /^https:\/\/github\.com\/Ravan404\/OrbQuest\/releases\/tag\/(v(\d+\.\d+\.\d+))$/.exec(location ?? '');
  if (!match) return null;
  const [url, tag, version] = match;
  const files = [`OrbQuest-Setup-${version}.exe`, `OrbQuest-${version}.exe`, 'SHA256SUMS.txt'];
  return {
    version,
    url,
    assets: Object.fromEntries(files.map((name) => [name, `${RELEASE_DOWNLOAD_PREFIX}${tag}/${name}`])),
  };
}

async function askApi(fetchImpl: typeof fetch): Promise<UpdateInfo | null> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response.ok ? parseLatestRelease(await response.json()) : null;
}

async function askReleasePage(fetchImpl: typeof fetch): Promise<UpdateInfo | null> {
  const response = await fetchImpl(LATEST_RELEASE_PAGE, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseReleaseRedirect(response.headers.get('location'));
}

/** Asks GitHub once; true when it answered. A failure keeps what the last check found. */
export function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  running = (async () => {
    try {
      const release = (await askApi(fetchImpl).catch(() => null)) ?? (await askReleasePage(fetchImpl));
      if (release) latest = release;
      return release !== null;
    } catch {
      // Offline or GitHub unreachable: tried again later.
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * The newer release, after waiting (a few seconds at most) for a check that
 * is still running, so the window that asks right after the start gets the
 * answer of the first check instead of nothing.
 */
export async function updateAnswer(waitMs = ANSWER_WAIT_MS): Promise<UpdateInfo | null> {
  if (running) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }
  return availableUpdate();
}

/** The newer release, if the last check found one. */
export function availableUpdate(): UpdateInfo | null {
  return latest && isNewerVersion(latest.version, APP_VERSION) ? latest : null;
}

export function scheduleUpdateChecks(): void {
  if (OFFLINE || process.env.ORBQUEST_UPDATE_CHECK === '0') return;
  const run = async () => {
    const answered = await checkForUpdate();
    setTimeout(run, answered ? CHECK_INTERVAL_MS : RETRY_INTERVAL_MS).unref();
  };
  void run();
}
