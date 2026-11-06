import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { removeSandbox, sandboxRoot } = await import('./helpers.ts');
const { checkForUpdate, parseReleaseRedirect } = await import('../src/server/updateCheck.ts');
const {
  canInstall,
  downloadState,
  parseChecksums,
  PENDING_FILE,
  resetUpdateDownload,
  startUpdateDownload,
  updateFileName,
} = await import('../src/server/updateInstall.ts');
const { availableUpdate } = await import('../src/server/updateCheck.ts');

after(removeSandbox);

const RELEASE = 'https://github.com/Ravan404/OrbQuest/releases/download/v99.0.0/';
const setupBytes = Buffer.from('installer bytes');
const portableBytes = Buffer.from('portable bytes');
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** GitHub as the update sees it: the release and its files. */
function github(files: Record<string, Buffer | string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return Response.json({
        tag_name: 'v99.0.0',
        html_url: 'https://github.com/Ravan404/OrbQuest/releases/tag/v99.0.0',
        assets: Object.keys(files).map((name) => ({ name, browser_download_url: RELEASE + name })),
      });
    }
    const name = url.slice(RELEASE.length);
    if (!(name in files)) return new Response('missing', { status: 404 });
    const body = files[name];
    return new Response(typeof body === 'string' ? body : new Uint8Array(body));
  }) as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100 && downloadState().state === 'downloading'; i++) await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  resetUpdateDownload();
  fs.rmSync(path.join(sandboxRoot, 'update'), { recursive: true, force: true });
  delete process.env.ORBQUEST_INSTALL_KIND;
  delete process.env.ORBQUEST_APP_EXE;
});

test('when the API limit is used up, the release page finds the update and it can be installed', async () => {
  const page = 'https://github.com/Ravan404/OrbQuest/releases/tag/v99.1.0';
  const fetchImpl = (async (input: string | URL | Request) =>
    String(input).includes('api.github.com')
      ? new Response('rate limit exceeded', { status: 403 })
      : new Response(null, { status: 302, headers: { location: page } })) as typeof fetch;
  assert.equal(await checkForUpdate(fetchImpl), true);
  assert.equal(availableUpdate()?.version, '99.1.0');
  assert.equal(availableUpdate()?.url, page);
  process.env.ORBQUEST_INSTALL_KIND = 'installed';
  assert.equal(canInstall(availableUpdate()), true);
  assert.equal(
    availableUpdate()?.assets?.['OrbQuest-Setup-99.1.0.exe'],
    'https://github.com/Ravan404/OrbQuest/releases/download/v99.1.0/OrbQuest-Setup-99.1.0.exe'
  );
});

test('a redirect anywhere but a release of this repository is ignored', () => {
  for (const location of [
    null,
    'https://evil.example/Ravan404/OrbQuest/releases/tag/v99.0.0',
    'https://github.com/someone/OrbQuest/releases/tag/v99.0.0',
    'https://github.com/Ravan404/OrbQuest/releases',
    'https://github.com/Ravan404/OrbQuest/releases/tag/v99.0.0/../evil',
  ]) {
    assert.equal(parseReleaseRedirect(location), null, String(location));
  }
});

test('checksum files in sha256sum and certutil style are read', () => {
  const sums = parseChecksums(
    `${'a'.repeat(64)}  OrbQuest-1.6.0.exe\r\n${'B'.repeat(64)} *OrbQuest-Setup-1.6.0.exe\nnoise`
  );
  assert.equal(sums.get('OrbQuest-1.6.0.exe'), 'a'.repeat(64));
  assert.equal(sums.get('OrbQuest-Setup-1.6.0.exe'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('the installed app downloads the installer, checks it and leaves it for the desktop app', async () => {
  const sums = `${sha(setupBytes)}  OrbQuest-Setup-99.0.0.exe\n${sha(portableBytes)}  OrbQuest-99.0.0.exe\n`;
  const fetchImpl = github({
    'OrbQuest-Setup-99.0.0.exe': setupBytes,
    'OrbQuest-99.0.0.exe': portableBytes,
    'SHA256SUMS.txt': sums,
  });
  await checkForUpdate(fetchImpl);
  assert.equal(canInstall(availableUpdate()), false, 'not from source or a browser');

  process.env.ORBQUEST_INSTALL_KIND = 'installed';
  assert.equal(canInstall(availableUpdate()), true);
  startUpdateDownload(fetchImpl);
  await settle();
  assert.equal(downloadState().state, 'ready', JSON.stringify(downloadState()));
  const pending = JSON.parse(fs.readFileSync(PENDING_FILE(), 'utf8'));
  assert.equal(pending.kind, 'installed');
  assert.equal(path.basename(pending.file), updateFileName('installed', '99.0.0'));
  assert.equal(path.dirname(pending.file), path.join(sandboxRoot, 'update'));
  assert.deepEqual(fs.readFileSync(pending.file), setupBytes);
  assert.equal(pending.sha256, sha(setupBytes));
});

test('the portable app downloads the new exe next to itself', async () => {
  const fetchImpl = github({
    'OrbQuest-99.0.0.exe': portableBytes,
    'SHA256SUMS.txt': `${sha(portableBytes)}  OrbQuest-99.0.0.exe\n`,
  });
  await checkForUpdate(fetchImpl);
  const folder = path.join(sandboxRoot, 'Downloads');
  fs.mkdirSync(folder, { recursive: true });
  process.env.ORBQUEST_INSTALL_KIND = 'portable';
  process.env.ORBQUEST_APP_EXE = path.join(folder, 'OrbQuest-1.6.0.exe');
  startUpdateDownload(fetchImpl);
  await settle();
  assert.equal(downloadState().state, 'ready', JSON.stringify(downloadState()));
  assert.deepEqual(fs.readFileSync(path.join(folder, 'OrbQuest-99.0.0.exe')), portableBytes);
});

test('a download that does not match its SHA-256 is deleted and never offered', async () => {
  const fetchImpl = github({
    'OrbQuest-Setup-99.0.0.exe': Buffer.from('something else'),
    'SHA256SUMS.txt': `${sha(setupBytes)}  OrbQuest-Setup-99.0.0.exe\n`,
  });
  await checkForUpdate(fetchImpl);
  process.env.ORBQUEST_INSTALL_KIND = 'installed';
  startUpdateDownload(fetchImpl);
  await settle();
  assert.equal(downloadState().state, 'failed');
  assert.match(downloadState().error ?? '', /SHA-256/);
  assert.equal(fs.existsSync(PENDING_FILE()), false);
  assert.deepEqual(
    fs
      .readdirSync(path.join(sandboxRoot, 'update'))
      .filter((name) => name.endsWith('.exe') || name.endsWith('.partial')),
    []
  );
});

test('files from anywhere but the release downloads are ignored', async () => {
  const fetchImpl = (async () =>
    Response.json({
      tag_name: 'v99.0.0',
      html_url: 'https://github.com/Ravan404/OrbQuest/releases/tag/v99.0.0',
      assets: [
        { name: 'OrbQuest-Setup-99.0.0.exe', browser_download_url: 'https://evil.example/OrbQuest-Setup-99.0.0.exe' },
        { name: 'SHA256SUMS.txt', browser_download_url: `${RELEASE}SHA256SUMS.txt` },
      ],
    })) as unknown as typeof fetch;
  await checkForUpdate(fetchImpl);
  process.env.ORBQUEST_INSTALL_KIND = 'installed';
  assert.equal(canInstall(availableUpdate()), false);
  assert.equal(startUpdateDownload(fetchImpl).state, 'failed');
});
