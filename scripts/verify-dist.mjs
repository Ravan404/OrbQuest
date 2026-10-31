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
 *      folder, no background database update);
 *   3. the bundled game database is the one in the repository and answers
 *      offline: search, the featured games and Discord's executable paths;
 *   4. a catalog game is written where Discord looks for it and its
 *      placeholder runs;
 *   5. the frontend is served and backend/database files are not.
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
      DQR_DATABASE_REFRESH: '0',
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

    // The bundled game database is part of the build.
    const bundled = JSON.parse(read('src/server/gameDatabase.json'));
    const info = profile.json?.gameDatabase;
    check(
      info?.updatedAt === bundled.generatedAt && info?.games === bundled.games.length && info?.from === 'bundled',
      `bundled game database updated ${bundled.generatedAt} (${bundled.games.length} games from Discord's list)`
    );

    // 3. Offline game database ---------------------------------------------------
    const catalog = await getJson(base, '/api/catalog?q=valorant');
    const valorant = (catalog.json || [])[0];
    check(
      valorant?.name === 'VALORANT' &&
        valorant.executables?.includes('win64/valorant-win64-shipping.exe') &&
        /^https:\/\/cdn\.discordapp\.com\/app-icons\//.test(valorant.icon ?? ''),
      'searching "valorant" finds VALORANT with its Discord executable path and icon'
    );

    const featured = await getJson(base, '/api/catalog/featured');
    const featuredList = Array.isArray(featured.json) ? featured.json : [];
    check(
      featuredList.length >= 90 && featuredList.every((game) => game.executables?.length > 0),
      `the catalog page lists ${featuredList.length} games with Discord quests`
    );

    // 4-5. Placeholder runtime & launcher lifecycle ------------------------------
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
        name: valorant?.name,
        appId: valorant?.id,
        executableName: 'win64/valorant-win64-shipping.exe',
        origin: 'catalog',
      },
    });
    const addedId = added.json?.game?.id;
    const addedExePath = path.join(dataRoot, 'Games', added.json?.game?.folder || 'VALORANT', 'win64', 'valorant-win64-shipping.exe');
    check(
      added.status === 200 && fs.existsSync(addedExePath),
      'adding VALORANT from the catalog creates Games/VALORANT/win64/valorant-win64-shipping.exe'
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

    // 6. Static files ------------------------------------------------------------
    const page = await getJson(base, '/');
    check(page.status === 200 && page.type.includes('text/html'), 'frontend index.html is served');
    for (const forbidden of ['/server.cjs', '/server.cjs.map', '/gameDatabase.json', '/featuredGames.json']) {
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
