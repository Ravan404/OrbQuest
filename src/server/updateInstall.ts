/**
 * Installs a newer release from inside the app. The desktop app tells the
 * server how it runs (ORBQUEST_INSTALL_KIND, desktop_app.py):
 *
 *   installed   OrbQuest-Setup-<version>.exe is downloaded to <data>/update/
 *   portable    OrbQuest-<version>.exe is downloaded next to the running exe
 *
 * The file comes only from this repository's release downloads and must
 * match the SHA-256 in the release's SHA256SUMS.txt; anything else is
 * deleted. The server then writes <data>/update/pending.json. The desktop app
 * checks the file again, closes, and starts it: the installer runs silently
 * and opens OrbQuest again, a portable exe replaces the old one.
 *
 * The server never starts the downloaded file itself.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.ts';
import { writeJsonAtomic } from './fsUtil.ts';
import { availableUpdate, RELEASE_DOWNLOAD_PREFIX, type UpdateInfo } from './updateCheck.ts';
import { APP_VERSION } from '../version.ts';

export type InstallKind = 'installed' | 'portable';

/** The largest release file accepted. The packages are about 40 and 55 MB. */
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

export const UPDATE_DIR = () => path.join(PROJECT_ROOT, 'update');
export const PENDING_FILE = () => path.join(UPDATE_DIR(), 'pending.json');

export interface DownloadState {
  state: 'idle' | 'downloading' | 'ready' | 'failed';
  version?: string;
  received?: number;
  total?: number;
  error?: string;
}

let download: DownloadState = { state: 'idle' };

/** How this copy of OrbQuest runs; undefined outside the desktop app. */
export function installKind(): InstallKind | undefined {
  const kind = process.env.ORBQUEST_INSTALL_KIND;
  return kind === 'installed' || kind === 'portable' ? kind : undefined;
}

/** The release file this copy updates itself with. */
export function updateFileName(kind: InstallKind, version: string): string {
  return kind === 'installed' ? `OrbQuest-Setup-${version}.exe` : `OrbQuest-${version}.exe`;
}

/** True when this copy can install `update` itself. */
export function canInstall(update: UpdateInfo | null): boolean {
  const kind = installKind();
  if (!update || !kind || !update.assets) return false;
  if (kind === 'portable' && !process.env.ORBQUEST_APP_EXE) return false;
  return Boolean(update.assets[updateFileName(kind, update.version)] && update.assets['SHA256SUMS.txt']);
}

/** `<sha256>  <file>` lines (`sha256sum` and certutil style) as a map. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S.*?)\s*$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function downloadState(): DownloadState {
  return download;
}

/** Where the file goes: the update folder, or next to the portable exe. */
function targetFor(kind: InstallKind, fileName: string): string {
  if (kind === 'installed') return path.join(UPDATE_DIR(), fileName);
  return path.join(path.dirname(process.env.ORBQUEST_APP_EXE ?? ''), fileName);
}

async function fetchChecked(url: string, fetchImpl: typeof fetch): Promise<Response> {
  if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) throw new Error('Not a release download of OrbQuest.');
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': `OrbQuest/${APP_VERSION} (update)` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`GitHub answered HTTP ${response.status}.`);
  return response;
}

/** SHA-256 of a file on disk. */
function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Downloads and checks the update. Returns at once; downloadState() follows
 * the progress. A second call while one runs does nothing.
 */
export function startUpdateDownload(fetchImpl: typeof fetch = fetch): DownloadState {
  if (download.state === 'downloading') return download;
  const update = availableUpdate();
  const kind = installKind();
  if (!update || !kind || !canInstall(update)) {
    download = {
      state: 'failed',
      error: 'This copy of OrbQuest cannot update itself; download it from the release page.',
    };
    return download;
  }
  const version = update.version;
  const fileName = updateFileName(kind, version);
  download = { state: 'downloading', version, received: 0 };
  void (async () => {
    const target = targetFor(kind, fileName);
    const partial = `${target}.partial`;
    try {
      const sums = parseChecksums(await (await fetchChecked(update.assets!['SHA256SUMS.txt'], fetchImpl)).text());
      const expected = sums.get(fileName);
      if (!expected) throw new Error(`SHA256SUMS.txt does not list ${fileName}.`);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!(fs.existsSync(target) && fileSha256(target) === expected)) {
        const response = await fetchChecked(update.assets![fileName], fetchImpl);
        const total = Number(response.headers.get('content-length') || 0);
        if (total > MAX_DOWNLOAD_BYTES) throw new Error('The download is larger than any OrbQuest release.');
        download = { ...download, total: total || undefined };
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(partial);
        let received = 0;
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            received += chunk.length;
            if (received > MAX_DOWNLOAD_BYTES) throw new Error('The download is larger than any OrbQuest release.');
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
            download = { ...download, received };
          }
        } finally {
          await new Promise<void>((resolve) => out.end(() => resolve()));
        }
        if (hash.digest('hex') !== expected)
          throw new Error('The download does not match its SHA-256; it was deleted.');
        fs.renameSync(partial, target);
      }
      writeJsonAtomic(PENDING_FILE(), { kind, version, file: target, sha256: expected });
      download = { state: 'ready', version, received: download.received, total: download.total };
    } catch (error) {
      fs.rmSync(partial, { force: true });
      download = { state: 'failed', version, error: error instanceof Error ? error.message : String(error) };
    }
  })();
  return download;
}

/** Test hook. */
export function resetUpdateDownload(): void {
  download = { state: 'idle' };
}
