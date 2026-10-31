import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { gamesDir, placeholderPath, readJson, removeSandbox, sandboxRoot } = await import('./helpers.ts');
const express = (await import('express')).default;
const store = await import('../src/server/gameStore.ts');
const gamesRouter = (await import('../src/server/routes/games.ts')).default;
const settingsRouter = (await import('../src/server/routes/settings.ts')).default;
const { resetSettingsCache } = await import('../src/server/settingsStore.ts');
const { loadGameDatabase } = await import('../src/server/gameDatabase.ts');

const stateFile = path.join(gamesDir, '.state.json');

let server: Server;
let base = '';

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** Simulates a restart of the server: memory is dropped and Games/ is read again. */
async function restart(): Promise<void> {
  store.gamesMap.clear();
  await store.initGameStore();
}

async function addGame(name: string, executableName: string, extra: Record<string, unknown> = {}) {
  const added = await call('POST', '/api/games', { name, executableName, origin: 'custom', ...extra });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  return added.json.game;
}

before(async () => {
  loadGameDatabase();
  await store.initGameStore();
  const app = express();
  app.use(express.json());
  app.use('/api/games', gamesRouter);
  app.use('/api/settings', settingsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  removeSandbox();
});

test('adding a game creates the folder, the placeholder and saves its timer', async () => {
  const game = await addGame('Alpha Game', 'alpha.exe', { targetMinutes: 7, autoStop: false });
  assert.ok(fs.existsSync(path.join(gamesDir, game.folder, 'alpha.exe')));
  assert.equal(game.targetMinutes, 7);
  assert.equal(readJson(stateFile)[game.id].targetMinutes, 7);
  assert.equal(readJson(stateFile)[game.id].autoStop, false);
});

test('timer preferences survive a reset and a restart', async () => {
  const game = await addGame('Bravo Game', 'bravo.exe');
  const timer = await call('PUT', `/api/games/${game.id}/timer`, { targetMinutes: 0, bufferPreset: 'long', autoStop: false });
  assert.equal(timer.status, 200);
  assert.equal(timer.json.game.targetMinutes, 0);

  const reset = await call('POST', `/api/games/${game.id}/reset-timer`);
  assert.equal(reset.status, 200);

  await restart();
  const reloaded = store.gamesMap.get(game.id)!;
  assert.equal(reloaded.targetMinutes, 0);
  assert.equal(reloaded.bufferPreset, 'long');
  assert.equal(reloaded.autoStop, false);
});

test('a finished counter is dropped on restart but its timer preferences stay', async () => {
  const game = await addGame('Charlie Game', 'charlie.exe');
  const stored = store.gamesMap.get(game.id)!;
  stored.targetMinutes = 3;
  stored.bufferPreset = 'fast';
  stored.elapsedSeconds = 400;
  stored.completed = true;
  store.savePersistedState(true);

  await restart();
  const reloaded = store.gamesMap.get(game.id)!;
  assert.equal(reloaded.elapsedSeconds, 0);
  assert.equal(reloaded.targetMinutes, 3);
  assert.equal(reloaded.bufferPreset, 'fast');
  assert.equal(readJson(stateFile)[game.id].targetMinutes, 3);
});

test('timer settings are rejected when they are out of range', async () => {
  const game = await addGame('Delta Game', 'delta.exe');
  for (const body of [
    { targetMinutes: -1 },
    { targetMinutes: 1441 },
    { targetMinutes: 2.5 },
    { bufferPreset: 'turbo' },
    { autoStop: 'yes' },
    {},
  ]) {
    const response = await call('PUT', `/api/games/${game.id}/timer`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const launch = await call('POST', `/api/games/${game.id}/launch`, { targetMinutes: 99999 });
  assert.equal(launch.status, 400);
  assert.equal(store.gamesMap.get(game.id)!.isRunning, false);
});

test('a rejected edit does not rename the folder on disk', async () => {
  const game = await addGame('Echo Game', 'echo.exe');
  const response = await call('PATCH', `/api/games/${game.id}`, {
    folderPath: 'Echo Renamed',
    targetMinutes: 'not a number',
  });
  assert.equal(response.status, 400);
  assert.ok(fs.existsSync(path.join(gamesDir, game.folder)));
  assert.ok(!fs.existsSync(path.join(gamesDir, 'Echo Renamed')));
  assert.equal(store.gamesMap.get(game.id)!.folder, game.folder);
});

test('a renamed folder keeps its id and saved progress after a restart', async () => {
  const game = await addGame('Foxtrot Game', 'foxtrot.exe');
  const stored = store.gamesMap.get(game.id)!;
  stored.bufferPreset = 'normal';
  stored.targetMinutes = 15;
  stored.elapsedSeconds = 120;
  store.savePersistedState(true);

  const renamed = await call('PATCH', `/api/games/${game.id}`, { folderPath: 'Foxtrot Moved' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.game.folder, 'Foxtrot Moved');

  await restart();
  const reloaded = store.gamesMap.get(game.id);
  assert.ok(reloaded, 'the id did not change');
  assert.equal(reloaded!.folder, 'Foxtrot Moved');
  assert.equal(reloaded!.elapsedSeconds, 120);
});

test('the edit dialog may send the current folder back unchanged', async () => {
  const game = await addGame('Golf Game', 'golf.exe');
  const response = await call('PATCH', `/api/games/${game.id}`, {
    name: 'Golf Game Renamed',
    executableName: 'golf.exe',
    folderPath: game.folder,
    targetMinutes: 10,
    autoStop: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.game.name, 'Golf Game Renamed');
  assert.equal(fs.readFileSync(path.join(gamesDir, game.folder, '.game-name.txt'), 'utf8'), 'Golf Game Renamed');
});

test('changing the executable never overwrites a real file and removes only our placeholder', async () => {
  const game = await addGame('Hotel Game', 'hotel.exe');
  const folder = path.join(gamesDir, game.folder);
  fs.writeFileSync(path.join(folder, 'real.exe'), 'real game binary');

  const response = await call('PATCH', `/api/games/${game.id}`, { executableName: 'real.exe' });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(fs.readFileSync(path.join(folder, 'real.exe'), 'utf8'), 'real game binary');
  assert.ok(!fs.existsSync(path.join(folder, 'hotel.exe')), 'the old placeholder was removed');

  const back = await call('PATCH', `/api/games/${game.id}`, { executableName: 'hotel.exe' });
  assert.equal(back.status, 200);
  assert.ok(fs.existsSync(path.join(folder, 'real.exe')), 'a real executable is never deleted');
});

test('catalog entries accept timer changes only', async () => {
  const added = await call('POST', '/api/games', { name: 'India Game', executableName: 'india.exe', origin: 'catalog' });
  const game = added.json.game;
  assert.equal((await call('PATCH', `/api/games/${game.id}`, { name: 'Other' })).status, 403);
  assert.equal((await call('PATCH', `/api/games/${game.id}`, { name: 'India Game', targetMinutes: 5 })).status, 200);
  assert.equal((await call('PUT', `/api/games/${game.id}/timer`, { targetMinutes: 6 })).status, 200);
  assert.equal(store.gamesMap.get(game.id)!.targetMinutes, 6);
});

test('Steam installs can be renamed and removed without touching real Steam files', async () => {
  const steamApps = path.join(sandboxRoot, 'Steam', 'steamapps');
  const installDir = path.join(steamApps, 'common', 'Juliet');
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(placeholderPath, path.join(installDir, 'juliet.exe'));
  fs.writeFileSync(path.join(installDir, '.dqr-managed.json'), JSON.stringify({ managedBy: 'DiscordQuestRun', executable: 'juliet.exe' }));
  const managedManifest = path.join(steamApps, 'appmanifest_123.acf');
  fs.writeFileSync(managedManifest, '"AppState"\n{\n\t"appid"\t\t"123"\n\t"name"\t\t"Juliet"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Juliet"\n}\n');
  const realManifest = path.join(steamApps, 'appmanifest_999.acf');
  fs.writeFileSync(realManifest, '"AppState"\n{\n\t"appid"\t\t"999"\n\t"name"\t\t"Real"\n\t"buildid"\t\t"1"\n\t"installdir"\t\t"Real"\n}\n');

  store.saveSpecialGame({ id: 'steam-123', rootPath: steamApps, installDir: 'Juliet', executable: 'juliet.exe', name: 'Juliet', steamAppId: 123 });
  await call('POST', '/api/games/rescan');
  assert.ok(store.gamesMap.has('steam-123'));
  // Scanned Steam installs are catalog entries; editing them as custom entries
  // is what the dialog does for a Steam game added by hand.
  store.gamesMap.get('steam-123')!.origin = 'custom';

  const renamed = await call('PATCH', '/api/games/steam-123', { name: 'Juliet Renamed', folderPath: 'special/Juliet' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  const records = readJson(path.join(gamesDir, '.special-games.json'));
  assert.equal(records.find((r: any) => r.id === 'steam-123').name, 'Juliet Renamed');

  const exeChange = await call('PATCH', '/api/games/steam-123', { executableName: 'other.exe' });
  assert.equal(exeChange.status, 409);

  assert.equal((await call('PUT', '/api/games/steam-123/timer', { targetMinutes: 4 })).status, 200);

  const removed = await call('DELETE', '/api/games/steam-123');
  assert.equal(removed.status, 200);
  assert.ok(!fs.existsSync(installDir), 'our placeholder install is removed');
  assert.ok(!fs.existsSync(managedManifest), 'our manifest is removed');
  assert.ok(fs.existsSync(realManifest), 'a real Steam manifest is never removed');
});

test('a rescan drops a game whose folder was deleted, but repairs a missing placeholder', async () => {
  const deleted = await addGame('Deleted Outside', 'deletedoutside.exe', { targetMinutes: 3 });
  const quarantined = await addGame('Quarantined Game', 'quarantined.exe');
  assert.ok(readJson(stateFile)[deleted.id], 'the timer was saved');
  fs.rmSync(path.join(gamesDir, deleted.folder), { recursive: true, force: true });
  fs.rmSync(path.join(gamesDir, quarantined.folder, 'quarantined.exe'));

  const rescan = await call('POST', '/api/games/rescan');
  assert.equal(rescan.status, 200);
  const ids = rescan.json.map((game: { id: string }) => game.id);
  assert.ok(!ids.includes(deleted.id), 'the deleted folder is no longer listed');
  assert.ok(ids.includes(quarantined.id), 'a missing executable alone keeps the entry');
  assert.ok(fs.existsSync(path.join(gamesDir, quarantined.folder, 'quarantined.exe')), 'the placeholder is restored');
  assert.ok(!fs.existsSync(path.join(gamesDir, deleted.folder)), 'the deleted folder is not recreated');
  assert.equal(readJson(stateFile)[deleted.id], undefined);
});

test('a catalog game is written to the path Discord matches and keeps it after a restart', async () => {
  const added = await call('POST', '/api/games', {
    name: 'VALORANT',
    executableName: 'win64/valorant-win64-shipping.exe',
    appId: '700136079562375258',
    origin: 'catalog',
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const game = added.json.game;
  const exePath = path.join(gamesDir, game.folder, 'win64', 'valorant-win64-shipping.exe');
  assert.ok(fs.existsSync(exePath), 'the placeholder sits in the win64 subfolder');
  assert.equal(game.executable, 'win64/valorant-win64-shipping.exe');
  assert.match(game.logoUrl ?? '', /^https:\/\/cdn\.discordapp\.com\/app-icons\/700136079562375258\//);

  await restart();
  const reloaded = store.gamesMap.get(game.id)!;
  assert.equal(reloaded.executable, 'win64/valorant-win64-shipping.exe');
  assert.equal(reloaded.appId, '700136079562375258');

  fs.rmSync(exePath);
  await call('POST', '/api/games/rescan');
  assert.ok(fs.existsSync(exePath), 'a removed placeholder is put back in the same subfolder');
});

test('a catalog game only accepts executables Discord lists for it, and paths stay inside the folder', async () => {
  const wrongExe = await call('POST', '/api/games', {
    name: 'VALORANT',
    executableName: 'other.exe',
    appId: '700136079562375258',
    origin: 'catalog',
  });
  assert.equal(wrongExe.status, 400);
  const unknownApp = await call('POST', '/api/games', { name: 'X', executableName: 'x.exe', appId: '123' });
  assert.equal(unknownApp.status, 400);
  for (const executableName of ['../evil.exe', 'C:/Windows/evil.exe', 'a/../../evil.exe', '/abs.exe']) {
    const response = await call('POST', '/api/games', { name: 'Escape', executableName });
    assert.ok(response.status === 400 || !fs.existsSync(path.join(sandboxRoot, 'evil.exe')), executableName);
  }
  assert.ok(!fs.existsSync(path.join(sandboxRoot, 'evil.exe')));
});

test('sound and theme settings are saved next to the library', async () => {
  assert.equal((await call('GET', '/api/settings')).json.soundEnabled, true);
  assert.equal((await call('PUT', '/api/settings', { soundEnabled: 'off' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { soundEnabled: false })).status, 200);
  resetSettingsCache();
  assert.equal((await call('GET', '/api/settings')).json.soundEnabled, false);
  assert.equal(readJson(path.join(gamesDir, '.settings.json')).soundEnabled, false);

  assert.equal((await call('GET', '/api/settings')).json.theme, 'system');
  assert.equal((await call('PUT', '/api/settings', { theme: 'blue' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { theme: 'dark' })).status, 200);
  resetSettingsCache();
  assert.equal((await call('GET', '/api/settings')).json.theme, 'dark');
  assert.equal((await call('GET', '/api/settings')).json.soundEnabled, false);
});
