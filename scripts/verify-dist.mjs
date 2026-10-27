#!/usr/bin/env node
/**
 * scripts/verify-dist.mjs
 *
 * Checks the production bundle BEFORE it is packaged into the Windows EXE
 * (build_windows_exe.bat runs this right after `npm run build`; CI runs it as
 * well). Version 1.2.20 shipped a backend bundle that crashed on start, which
 * only showed up on the user's machine - this script catches that class of
 * problem on the build machine instead.
 *
 *   npm run verify:dist
 *
 * It verifies that:
 *   1. the version number is the same in package.json, desktop_app.py,
 *      build_windows_exe.bat and placeholder_runtime.rc;
 *   2. `dist/server.cjs` starts in production mode (with a throw-away data
 *      folder, no background Reddit refresh);
 *   3. the bundled quest database is the one in the repository (same update
 *      date) and answers offline: one catalog card per game and a database
 *      answer for a known game, without Reddit;
 *   4. the frontend is served and backend/database files are not.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverBundle = path.join(root, 'dist', 'server.cjs');
const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function getJson(base, endpoint, options = {}) {
  const response = await fetch(base + endpoint, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, body, type: response.headers.get('content-type') || '' };
}

async function main() {
  console.log('Verifying the production bundle...');

  // 1. Version numbers -------------------------------------------------------
  const version = JSON.parse(read('package.json')).version;
  const desktopVersion = /^APP_VERSION = "([^"]+)"/m.exec(read('desktop_app.py'))?.[1];
  const batVersion = /Version: (\S+)/.exec(read('build_windows_exe.bat'))?.[1];
  check(desktopVersion === version, `desktop_app.py APP_VERSION is ${version} (found ${desktopVersion})`);
  check(batVersion === version, `build_windows_exe.bat shows version ${version} (found ${batVersion})`);
  const rcVersion = /VALUE "ProductVersion",\s*"(\d+\.\d+\.\d+)\.0\\0"/.exec(read('placeholder_runtime.rc'))?.[1];
  check(rcVersion === version, `placeholder_runtime.rc ProductVersion is ${version} (found ${rcVersion})`);

  if (!fs.existsSync(serverBundle)) {
    check(false, 'dist/server.cjs exists (run "npm run build" first)');
    return;
  }

  // 2. Start the bundled backend ---------------------------------------------
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dqr-verify-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const server = spawn(process.execPath, [serverBundle], {
    cwd: dataRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DQR_BIND_HOST: '127.0.0.1',
      DQR_REDDIT_CACHE_REFRESH: '0',
      DQR_ROOT: dataRoot,
      DQR_ASSET_ROOT: root,
      DQR_GAMES_DIR: path.join(dataRoot, 'Games'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));
  let exited = false;
  server.on('exit', () => (exited = true));

  try {
    let profile;
    for (let attempt = 0; attempt < 60 && !exited; attempt++) {
      try {
        profile = await getJson(base, '/api/profile');
        if (profile.status === 200) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check(profile?.status === 200, 'dist/server.cjs starts in production mode');
    if (profile?.status !== 200) {
      console.log(output.trim().split('\n').slice(-25).join('\n'));
      return;
    }
    check(profile.json?.version === version, `backend reports version ${version} (found ${profile.json?.version})`);

    // The update date of the bundled quest database is part of the build.
    const bundled = JSON.parse(read('src/server/redditCache.json'));
    const info = profile.json?.questDatabase?.bundled;
    check(
      info?.updatedAt === bundled.generatedAt && info?.entries === bundled.entries.length,
      `bundled quest database updated ${bundled.generatedAt} (${bundled.entries.length} entries, checked through ${bundled.checkedThrough})`
    );

    // 3. Offline quest database ------------------------------------------------
    const catalog = await getJson(base, '/api/catalog?q=marvel%20rivals');
    const rivals = (catalog.json || []).filter((card) => card.name.toLowerCase().includes('marvel rivals'));
    check(
      rivals.length === 1 && rivals[0].name === 'Marvel Rivals' && rivals[0].source === 'database',
      'catalog shows exactly one "Marvel Rivals" card from the quest database'
    );

    const helldivers = await getJson(base, '/api/catalog?q=helldivers');
    check(
      (helldivers.json || []).length === 1 && helldivers.json[0].name === 'Helldivers 2',
      'catalog merges "HELLDIVERS 2" spellings into one card'
    );

    const dbCatalog = await getJson(base, '/api/catalog/database');
    const dbCatalogList = Array.isArray(dbCatalog.json) ? dbCatalog.json : [];
    const dbWithIcons = dbCatalogList.filter((item) => typeof item?.icon === 'string' && item.icon.length > 0);
    // Games the scheduled database update just added may have no icon yet; the
    // window shows their initials and the server looks the icon up later. Most
    // games without one means the icon lookup itself is broken.
    check(
      dbCatalogList.length > 0 && dbWithIcons.length >= dbCatalogList.length * 0.9,
      `at least 90% of the ${dbCatalogList.length} quest database games resolve an icon immediately (${dbWithIcons.length}/${dbCatalogList.length})`
    );
    const withoutIcon = dbCatalogList.filter((item) => !item?.icon).map((item) => item.name);
    if (withoutIcon.length > 0) console.log(`  note no immediate icon yet: ${withoutIcon.join(', ')}`);

    const search = await getJson(base, '/api/search-quests?game=Where%20Winds%20Meet&format=full');
    const wwm = (search.json?.matches || []).find((match) => match.executableName === 'wwm.exe');
    check(
      JSON.stringify(search.json?.sourcesSearched) === JSON.stringify(['database']) &&
        wwm?.foundVia === 'database' &&
        typeof wwm?.logoUrl === 'string' &&
        wwm.logoUrl.length > 0,
      'executable search answers "Where Winds Meet" (wwm.exe) with its icon from the local database without Reddit'
    );

    // 4. Placeholder runtime & launcher lifecycle ------------------------------
    const placeholderBytes = fs.readFileSync(path.join(root, 'placeholder_runtime.exe'));
    const peOffset = placeholderBytes.readUInt32LE(0x3c);
    const stackCommit = Number(placeholderBytes.readBigUInt64LE(peOffset + 24 + 80));
    check(
      placeholderBytes.subarray(0, 2).toString('ascii') === 'MZ' && stackCommit >= 0x20000,
      `placeholder_runtime.exe is a valid Win32 PE64 binary with SizeOfStackCommit=${stackCommit}`
    );

    const added = await getJson(base, '/api/games', {
      method: 'POST',
      body: {
        name: 'Where Winds Meet',
        folderPath: 'wwm_standard\\Engine\\Binaries\\Win64r',
        executableName: 'wwm.exe',
        origin: 'catalog',
      },
    });
    const addedId = added.json?.game?.id;
    const addedExePath = path.join(dataRoot, 'Games', added.json?.game?.folder || 'Win64r', 'wwm.exe');
    check(
      added.status === 200 && added.json?.game?.executable === 'wwm.exe' && fs.existsSync(addedExePath),
      'adding "Where Winds Meet" creates Games/Win64r/wwm.exe'
    );

    fs.rmSync(addedExePath, { force: true });
    const rescanned = await getJson(base, '/api/games/rescan', { method: 'POST' });
    check(
      rescanned.status === 200 && fs.existsSync(addedExePath),
      'rescanning automatically restores missing/quarantined placeholder executable'
    );

    const launched = await getJson(base, `/api/games/${encodeURIComponent(addedId)}/launch`, {
      method: 'POST',
      body: { targetMinutes: 15, bufferPreset: 'normal', autoStop: true },
    });
    check(
      launched.status === 200 && launched.json?.game?.isRunning === true,
      'launching placeholder starts session and sets isRunning=true'
    );

    const stopped = await getJson(base, `/api/games/${encodeURIComponent(addedId)}/stop`, { method: 'POST' });
    const reset = await getJson(base, `/api/games/${encodeURIComponent(addedId)}/reset-timer`, { method: 'POST' });

    // Timer preferences are saved by the server and survive a reset.
    const timer = await getJson(base, `/api/games/${encodeURIComponent(addedId)}/timer`, {
      method: 'PUT',
      body: { targetMinutes: 7, bufferPreset: 'long', autoStop: false },
    });
    const stateFile = path.join(dataRoot, 'Games', '.state.json');
    const savedState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    check(
      timer.status === 200 &&
        timer.json?.game?.targetMinutes === 7 &&
        savedState[addedId]?.targetMinutes === 7 &&
        savedState[addedId]?.bufferPreset === 'long' &&
        savedState[addedId]?.autoStop === false,
      'timer preferences are saved to Games/.state.json'
    );
    const settings = await getJson(base, '/api/settings', { method: 'PUT', body: { soundEnabled: false } });
    check(
      settings.status === 200 && settings.json?.soundEnabled === false,
      'the sound setting is saved by the server'
    );
    const removed = await getJson(base, `/api/games/${encodeURIComponent(addedId)}`, { method: 'DELETE' });
    check(
      stopped.status === 200 &&
        stopped.json?.game?.isRunning === false &&
        reset.status === 200 &&
        reset.json?.game?.elapsedSeconds === 0 &&
        removed.status === 200 &&
        removed.json?.deleted === true,
      'stop, reset-timer, and delete endpoints complete cleanly'
    );

    // 5. Static files ------------------------------------------------------------
    const page = await getJson(base, '/');
    check(page.status === 200 && page.type.includes('text/html'), 'frontend index.html is served');
    for (const forbidden of ['/server.cjs', '/server.cjs.map', '/redditCache.json', '/discordIconCatalog.json']) {
      const response = await getJson(base, forbidden);
      check(response.status === 404, `${forbidden} is not served`);
    }
  } finally {
    await stopServer(server);
    removeTempDir(dataRoot);
  }
}

/** Stops the backend and waits (at most 5 s) until the process has really exited. */
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  let timer;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 5_000);
  });
  server.kill();
  await Promise.race([exited, timeout]);
  clearTimeout(timer);
}

/**
 * Removes the throw-away data folder. Windows keeps a folder locked for a
 * moment after the process that used it as its working directory exits, so
 * the removal is retried - and a leftover temp folder never fails the check
 * (it would otherwise stop build_windows_exe.bat for no real reason).
 */
function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`  note could not remove the temporary folder ${dir}: ${error?.message || error}`);
  }
}

main()
  .catch((error) => {
    failures.push(String(error?.stack || error));
    console.error(error);
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\nProduction bundle verification FAILED (${failures.length} problem(s)).`);
      process.exit(1);
    }
    console.log('\nProduction bundle verified.');
  });
