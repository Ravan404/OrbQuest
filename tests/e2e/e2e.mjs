/**
 * Browser test of the built app (npm run test:e2e, after npm run build).
 *
 * Starts dist/server.cjs on a free port with its own temporary library, Steam
 * folder and Downloads folder, then clicks through the window in Edge or
 * Chrome (puppeteer-core; E2E_BROWSER can name the browser). Placeholders are
 * really started, so it runs on Windows only. E2E_SCREENSHOTS keeps a
 * screenshot of every step in that folder.
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

if (process.platform !== 'win32') {
  console.log('The browser test starts Windows placeholders; it runs on Windows only.');
  process.exit(0);
}

const ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!fs.existsSync(path.join(ROOT, 'dist', 'server.cjs'))) {
  console.error('dist/server.cjs is missing. Run npm run build first.');
  process.exit(1);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orbquest-e2e-'));
const DATA = path.join(SANDBOX, 'data');
const STEAMAPPS = path.join(SANDBOX, 'Steam', 'steamapps');
const DOWNLOADS = path.join(SANDBOX, 'Downloads');
const OUT = process.env.E2E_SCREENSHOTS ? path.resolve(process.env.E2E_SCREENSHOTS) : path.join(SANDBOX, 'screenshots');
for (const dir of [DATA, STEAMAPPS, DOWNLOADS, OUT]) fs.mkdirSync(dir, { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const serverLog = fs.openSync(path.join(SANDBOX, 'server.log'), 'w');
const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.cjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'production',
    DQR_ROOT: DATA,
    DQR_ASSET_ROOT: ROOT,
    DQR_DATABASE_REFRESH: '0',
    DQR_UPDATE_CHECK: '0',
    DQR_STEAMAPPS: STEAMAPPS,
    DQR_DOWNLOADS_DIR: DOWNLOADS,
  },
  stdio: ['ignore', serverLog, serverLog],
  windowsHide: true,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/api/profile`)).ok) break;
  } catch {
    // Not listening yet.
  }
  await sleep(100);
}

function findBrowser() {
  const candidates = [
    process.env.E2E_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('No Edge or Chrome found; set E2E_BROWSER to a Chromium browser.');
  return found;
}

const results = [];
const ok = (name, passed, info = '') => {
  results.push({ name, passed });
  console.log(passed ? 'PASS' : 'FAIL', name, info);
};
const api = async (route, init) => (await fetch(BASE + route, init)).json();
const procRunning = (exe) => {
  const file = exe.split(/[\\/]/).pop();
  return execSync(`tasklist /FO CSV /FI "IMAGENAME eq ${file}" /NH`)
    .toString()
    .toLowerCase()
    .includes(file.toLowerCase());
};

const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 820 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('dialog', (d) => d.accept());

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
async function click(text, { within = 'body', exact = true, nth = 0 } = {}) {
  const handles = await page.$$(`${within} button, ${within} [role=button], ${within} a`);
  const hits = [];
  for (const handle of handles) {
    const info = await handle.evaluate((e) => ({
      t: (e.innerText || '').trim(),
      a: e.getAttribute('aria-label') || '',
      ti: e.getAttribute('title') || '',
      vis: Boolean(e.offsetWidth || e.offsetHeight),
      dis: e.disabled,
    }));
    if (!info.vis || info.dis) continue;
    const labels = [info.t, info.a, info.ti];
    if (exact ? labels.includes(text) : labels.some((label) => label.includes(text))) hits.push(handle);
  }
  if (!hits[nth]) throw new Error(`button "${text}" not found`);
  await hits[nth].click();
  await sleep(400);
}
async function typeInto(placeholder, value, { clear = true } = {}) {
  const el = await page.$(`input[placeholder="${placeholder}"]`);
  if (!el) throw new Error(`input "${placeholder}" not found`);
  if (clear) {
    await el.evaluate((input) => input.select());
    await page.keyboard.press('Backspace');
  }
  await el.type(value);
}
const bodyText = () => page.evaluate(() => document.body.innerText);
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(name, false, e.message);
    await shot(`fail-${name.replace(/\W+/g, '_')}`).catch(() => {});
  }
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  await step('theme toggle switches, is saved and survives a reload', async () => {
    const darkOnScreen = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgb(250, 250, 250)');
    const before = await darkOnScreen();
    await click(before ? 'Switch to the light theme' : 'Switch to the dark theme');
    const s = await api('/api/settings');
    const after = await darkOnScreen();
    ok(
      'theme button switches to the other theme and saves it',
      after !== before && s.theme === (after ? 'dark' : 'light'),
      `${before} -> ${after}, saved ${s.theme}`
    );
    await click(after ? 'Switch to the light theme' : 'Switch to the dark theme');
    const saved = (await api('/api/settings')).theme;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const attr = await page.evaluate(() => document.documentElement.dataset.theme);
    await sleep(2500);
    const label = await page.$eval('#theme-toggle-btn', (b) => b.getAttribute('aria-label') || b.getAttribute('title'));
    ok(
      'the saved theme is on the page at load and the button offers the other one',
      attr === saved && label === (saved === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'),
      `${saved} ${attr} ${label}`
    );
    await shot(`theme-${saved}`);
  });

  await step('sound toggle is saved', async () => {
    await click('Sounds on');
    const s = await api('/api/settings');
    ok('sound toggle is saved', s.soundEnabled === false);
    await click('Sounds off');
  });

  await step('catalog lists the games with Discord quests', async () => {
    await click('Catalog', { nth: 0 });
    await sleep(1200);
    const txt = await bodyText();
    const tiles = await page.$$eval('button', (els) => els.filter((e) => e.innerText.trim() === 'Add').length);
    ok(
      'catalog lists the games with Discord quests',
      /Games with Discord quests/i.test(txt) && /10,4\d\d games and apps in the catalog/.test(txt) && tiles >= 90,
      `tiles=${tiles}`
    );
    await shot('catalog');
  });

  await step('add VALORANT from catalog', async () => {
    await typeInto('Search games', 'valorant');
    await sleep(1000);
    await shot('search-valorant');
    await click('Add', { nth: 0 });
    await sleep(1500);
    const games = await api('/api/games');
    const v = games.find((g) => /valorant/i.test(g.name));
    ok(
      'add VALORANT from catalog',
      v?.executable === 'win64/valorant-win64-shipping.exe',
      v ? `${v.folder}/${v.executable}` : JSON.stringify(games)
    );
    ok(
      'placeholder written where Discord looks',
      v && fs.existsSync(path.join(DATA, 'Games', v.folder, 'win64', 'valorant-win64-shipping.exe'))
    );
    const txt = await bodyText();
    ok('catalog marks it as in library', /In library/.test(txt));
  });

  let valorant;
  await step('library shows the card', async () => {
    await click('Library');
    await sleep(1000);
    const txt = await bodyText();
    valorant = (await api('/api/games')).find((g) => /valorant/i.test(g.name));
    ok('library shows the card', /VALORANT/i.test(txt));
    await shot('library-one');
  });

  await step('timer: 1 min, preset Off', async () => {
    await click('Timer');
    await sleep(400);
    await shot('timer-menu');
    await click('Off', { exact: false, within: '[role=dialog]' });
    await click('1m', { within: '[role=dialog]' });
    await sleep(600);
    const g = (await api('/api/games')).find((x) => x.id === valorant.id);
    ok(
      'timer: 1 min, preset Off',
      g.targetMinutes === 1 && g.bufferPreset === 'off',
      `${g.targetMinutes}m ${g.bufferPreset} autoStop=${g.autoStop}`
    );
  });

  await step('launch starts the placeholder process', async () => {
    await click('Launch');
    await sleep(2500);
    const g = (await api('/api/games')).find((x) => x.id === valorant.id);
    ok(
      'launch starts the placeholder process',
      g.isRunning && procRunning(valorant.executable),
      `isRunning=${g.isRunning}`
    );
    ok(
      'placeholder icon written next to the exe',
      fs.existsSync(path.join(DATA, 'Games', valorant.folder, path.dirname(valorant.executable), '.game-icon.ico'))
    );
    await shot('running');
  });

  await step('timer finishes and auto-stops the process', async () => {
    const deadline = Date.now() + 100_000;
    let g;
    while (Date.now() < deadline) {
      await sleep(3000);
      g = (await api('/api/games')).find((x) => x.id === valorant.id);
      if (!g.isRunning) break;
    }
    await sleep(1500);
    ok(
      'timer finishes and auto-stops the process',
      !g.isRunning && !procRunning(valorant.executable),
      `elapsed=${g.elapsedSeconds}s completed=${g.completed}`
    );
    await shot('finished');
  });

  await step('reset sets the time back', async () => {
    const before = (await api('/api/games')).find((x) => x.id === valorant.id);
    if (before.elapsedSeconds > 0) {
      await click('Reset', { nth: 0 });
      await sleep(600);
    }
    const g = (await api('/api/games')).find((x) => x.id === valorant.id);
    ok('reset sets the time back', g.elapsedSeconds === 0 && g.targetMinutes === 1, `elapsed=${g.elapsedSeconds}`);
  });

  await step('launch + manual stop', async () => {
    await click('Launch');
    await sleep(2000);
    await click('Stop', { nth: 0 });
    await sleep(1500);
    const g = (await api('/api/games')).find((x) => x.id === valorant.id);
    ok('launch + manual stop', !g.isRunning && !procRunning(valorant.executable));
  });

  await step('add custom game via dialog', async () => {
    await click('Add game', { nth: 0 });
    await sleep(500);
    await shot('dialog-add');
    await typeInto('Roblox', 'My Test Game');
    await typeInto('RobloxPlayerBeta.exe', 'mytestgame.exe');
    await click('Add', { within: '[role=dialog]' });
    await sleep(1200);
    const g = (await api('/api/games')).find((x) => x.name === 'My Test Game');
    ok(
      'add custom game via dialog',
      g && fs.existsSync(path.join(DATA, 'Games', g.folder, 'mytestgame.exe')),
      g ? g.folder : 'missing'
    );
  });

  await step('edit custom game (name, exe, folder)', async () => {
    const cards = await page.$$('h3');
    for (const c of cards) {
      if ((await c.evaluate((e) => e.innerText)) === 'My Test Game') {
        await c.hover();
        break;
      }
    }
    await click('Edit', { nth: 0 });
    await sleep(500);
    await typeInto('Roblox', 'Renamed Game');
    await typeInto('RobloxPlayerBeta.exe', 'renamed.exe');
    await typeInto('Same as the name', 'Renamed Folder');
    await shot('dialog-edit');
    await click('Save');
    await sleep(1200);
    const g = (await api('/api/games')).find((x) => x.name === 'Renamed Game');
    const dir = g && path.join(DATA, 'Games', g.folder);
    ok(
      'edit custom game (name, exe, folder)',
      g &&
        g.folder === 'Renamed Folder' &&
        fs.existsSync(path.join(dir, 'renamed.exe')) &&
        !fs.existsSync(path.join(dir, 'mytestgame.exe')),
      g ? `${g.folder}\\${g.executable}` : 'missing'
    );
  });

  await step('catalog entry edit is locked', async () => {
    const r = await fetch(`${BASE}/api/games/${valorant.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    ok('catalog entry edit is locked', r.status === 403);
  });

  await step('start script dialog', async () => {
    await click('Start script', { nth: 0 });
    await sleep(500);
    const txt = await page.$eval('[role=dialog]', (e) => e.innerText);
    await shot('script');
    ok('start script dialog', /Start script/.test(txt) && /(\.exe|VALORANT|Renamed)/i.test(txt));
    await click('Save to Downloads');
    await sleep(800);
    const any = fs.readdirSync(DOWNLOADS).filter((f) => f.endsWith(' - OrbQuest.bat'));
    ok('the start script is saved to Downloads as <game> - OrbQuest.bat', any.length === 1, any.join(', '));
    await shot('script-saved');
    await page.keyboard.press('Escape');
    await sleep(400);
    ok('escape closes the dialog', !(await page.$('[role=dialog]')));
  });

  await step('library search filters', async () => {
    await typeInto('Search', 'renamed');
    await sleep(500);
    const names = await page.$$eval('h3', (els) => els.map((e) => e.innerText));
    ok('library search filters', names.length === 1 && names[0] === 'Renamed Game', names.join(','));
    await typeInto('Search', '');
  });

  await step('rescan keeps the library', async () => {
    await click('Rescan');
    await sleep(1500);
    const games = await api('/api/games');
    ok('rescan keeps the library', games.length === 2, String(games.length));
  });

  await step('missing placeholder is restored on launch', async () => {
    fs.rmSync(path.join(DATA, 'Games', 'Renamed Folder', 'renamed.exe'));
    const g = (await api('/api/games')).find((x) => x.name === 'Renamed Game');
    const r = await api(`/api/games/${g.id}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await sleep(1500);
    ok('missing placeholder is restored on launch', r.success && procRunning('renamed.exe'));
    await api('/api/games/stop-all', { method: 'POST' });
    await sleep(1500);
    ok('stop all stops everything', !procRunning('renamed.exe'));
  });

  await step('default executable when Discord lists several', async () => {
    await click('Catalog', { nth: 0 });
    await typeInto('Search games', 'marvel rivals');
    await sleep(1000);
    const value = await page.$eval('select', (el) => el.value).catch(() => '');
    await shot('marvel');
    ok('default executable when Discord lists several', value === 'win64/marvel-win64-shipping.exe', value);
  });

  await step('a game Discord does not list can be added by hand', async () => {
    await typeInto('Search games', 'zzqqxx no such game');
    await sleep(1000);
    const txt = await bodyText();
    await click('Add it by its .exe name');
    await sleep(500);
    const dialog = await page.$('[role=dialog]');
    ok('a game Discord does not list can be added by hand', /has nothing called/.test(txt) && Boolean(dialog));
    await page.keyboard.press('Escape');
    await sleep(300);
  });

  await step('about page', async () => {
    await click('About');
    await sleep(800);
    const txt = await bodyText();
    await shot('about');
    ok('about page', /About OrbQuest/.test(txt) && txt.includes(VERSION) && /10,?4\d\d/.test(txt));
  });

  await step('bulk select and remove', async () => {
    await click('Library');
    await sleep(600);
    await click('Select');
    await click('Select all');
    const bar = '.animate-enter.mx-6';
    await click('Remove', { within: bar });
    await shot('bulk-confirm');
    await click('Remove 2?', { within: bar });
    await sleep(1500);
    const games = await api('/api/games');
    ok(
      'bulk select and remove',
      games.length === 0 && !fs.existsSync(path.join(DATA, 'Games', 'Renamed Folder')),
      String(games.length)
    );
    await shot('empty-again');
  });

  await step('narrow window layout', async () => {
    await page.setViewport({ width: 420, height: 800 });
    await sleep(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await shot('narrow');
    ok('narrow window layout has no horizontal scroll', !overflow);
  });

  await step('Steam quest from the catalog', async () => {
    await page.setViewport({ width: 1280, height: 820 });
    await click('Catalog');
    await typeInto('Search games', 'fc 27');
    await sleep(1000);
    const txt = await bodyText();
    ok('Steam quests are marked in the catalog', /EA SPORTS FC 27/.test(txt) && /\bSteam\b/.test(txt));
    await shot('catalog-steam');
    await click('Add', { nth: 0 });
    await sleep(500);
    ok(
      'a Steam quest asks first and writes nothing yet',
      /into Steam's folder/.test(await bodyText()) && !fs.existsSync(path.join(STEAMAPPS, 'appmanifest_4080220.acf'))
    );
    await shot('catalog-steam-confirm');
    await click('Confirm');
    await sleep(1500);
    const games = await api('/api/games');
    ok(
      'a Steam quest is written into the Steam library',
      games.some((g) => g.id === 'steam-4080220') &&
        fs.existsSync(path.join(STEAMAPPS, 'common', 'EA SPORTS FC 27', 'fc27.exe')) &&
        fs.existsSync(path.join(STEAMAPPS, 'appmanifest_4080220.acf'))
    );
    await click('Library');
    await sleep(800);
    await shot('library-steam');
  });

  await step('website icon for a program Discord has none for', async () => {
    await click('Catalog');
    await typeInto('Search games', 'firefox');
    await sleep(3000);
    const loaded = await page.evaluate(
      () =>
        [...document.images].some(
          (img) => img.src.includes('/api/catalog/icons/') || img.src.includes('/game-icons-cache/')
        ) && [...document.images].every((img) => !img.complete || img.naturalWidth > 0)
    );
    await shot('catalog-firefox');
    ok('Firefox shows its website icon', loaded);
  });

  await step('open folder button and update link', async () => {
    await page.setRequestInterception(true);
    page.on('request', (r) =>
      r.url().endsWith('/api/update')
        ? r.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              update: { version: '9.9.9', url: 'https://github.com/Ravan404/OrbQuest/releases/tag/v9.9.9' },
            }),
          })
        : r.continue()
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const link = await page
      .$eval('#update-available-link', (a) => ({ t: a.innerText.trim(), href: a.href, target: a.target }))
      .catch(() => null);
    ok(
      'a new release shows a link next to the version',
      link?.t === 'Update 9.9.9' && link.target === '_blank' && link.href.endsWith('/v9.9.9'),
      JSON.stringify(link)
    );
    await shot('update-link');
    await click('About');
    await sleep(600);
    ok('About has an Open folder button', Boolean(await page.$('#open-games-folder-btn')));
    await shot('about-folder');
  });

  ok('no console errors', errors.length === 0, errors.join(' || '));
} finally {
  await fetch(`${BASE}/api/games/stop-all`, { method: 'POST' }).catch(() => {});
  await browser.close().catch(() => {});
  try {
    execSync(`taskkill /pid ${server.pid} /t /f`, { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length} / ${results.length} passed`);
if (failed.length) console.log(`Server log: ${path.join(SANDBOX, 'server.log')}`);
else if (!process.env.E2E_SCREENSHOTS) {
  await sleep(500);
  fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed.length ? 1 : 0);
