import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { removeSandbox } = await import('./helpers.ts');
const security = await import('../src/server/security.ts');
const { computeGameTimerPhase, clampTargetMinutes } = await import('../src/utils/timerUtils.ts');
const { parseTimerPreferences } = await import('../src/server/gameStore.ts');
const { mergePolledGames } = await import('../src/hooks/useGamePoller.ts');
const { escapeBatch, escapeBatchQuoted, escapePowerShell } = await import('../src/utils/scriptEscape.ts');
const { buildStartScripts, scriptFileName, scriptRunSeconds } = await import('../src/utils/startScripts.ts');

after(removeSandbox);

test('isPathInside respects folder boundaries', () => {
  const root = path.resolve('/data/Games');
  assert.equal(security.isPathInside(root, path.join(root, 'Foo')), true);
  assert.equal(security.isPathInside(root, root), false);
  assert.equal(security.isPathInside(root, path.resolve('/data/Games-evil/x')), false);
  assert.equal(security.isPathInside(root, path.join(root, '..', 'x')), false);
});

test('isSafeFileName rejects separators, reserved names and illegal characters', () => {
  assert.equal(security.isSafeFileName('game.exe'), true);
  for (const bad of ['', '../x.exe', 'a/b.exe', 'a\\b.exe', 'CON', 'nul.exe', 'a:b.exe', 'a?.exe', 'x\u0001.exe']) {
    assert.equal(security.isSafeFileName(bad), false, bad);
  }
});

test('libraryFolderName skips generic engine folders', () => {
  assert.equal(security.libraryFolderName('wwm_standard\\Engine\\Binaries\\Win64r', 'Where Winds Meet'), 'Win64r');
  assert.equal(security.libraryFolderName('Marvel\\Binaries\\Win64', 'Marvel Rivals'), 'Marvel Rivals');
  assert.equal(security.libraryFolderName('Not found', 'Roblox'), 'Roblox');
});

test('state-changing cross-site requests are refused', () => {
  assert.equal(security.isAllowedOriginForMethod('GET', 'https://evil.example', 'cross-site'), true);
  assert.equal(security.isAllowedOriginForMethod('POST', undefined, 'cross-site'), false);
  assert.equal(security.isAllowedOriginForMethod('POST', 'https://evil.example', undefined), false);
  assert.equal(security.isAllowedOriginForMethod('POST', 'null', undefined), false);
  assert.equal(security.isAllowedOriginForMethod('POST', 'http://127.0.0.1:3000', 'same-origin'), true);
  assert.equal(security.isAllowedRequestHost('attacker.example'), false);
  assert.equal(security.isAllowedRequestHost('localhost'), true);
});

test('timer phases: detection, active, final margin, completed', () => {
  assert.equal(computeGameTimerPhase(2, 1, 'normal', 3).phase, 'detecting');
  assert.equal(computeGameTimerPhase(30, 1, 'normal').phase, 'active');
  assert.equal(computeGameTimerPhase(66, 1, 'normal').phase, 'finalizing');
  assert.equal(computeGameTimerPhase(75, 1, 'normal').phase, 'completed');
  assert.equal(computeGameTimerPhase(100_000, 0, 'normal').phase, 'active', 'no limit never completes');
  assert.equal(clampTargetMinutes(0), 1);
  assert.equal(clampTargetMinutes(99_999), 1440);
});

test('parseTimerPreferences validates every field that is present', () => {
  assert.deepEqual(parseTimerPreferences({ targetMinutes: 0, bufferPreset: 'off', autoStop: false }), {
    targetMinutes: 0,
    bufferPreset: 'off',
    autoStop: false,
  });
  assert.deepEqual(parseTimerPreferences({}), {});
  assert.equal(typeof parseTimerPreferences({ targetMinutes: '15' }), 'object', 'numeric strings are accepted');
  assert.equal(typeof parseTimerPreferences({ bufferPreset: 'toString' }), 'string', 'prototype keys are not presets');
  assert.equal(typeof parseTimerPreferences({ autoStop: 1 }), 'string');
});

test('mergePolledGames keeps the screen order and takes the server copy', () => {
  const game = (id: string, targetMinutes: number) => ({ id, name: id, folder: id, executable: `${id}.exe`, isRunning: false, elapsedSeconds: 0, targetMinutes });
  const merged = mergePolledGames([game('b', 1), game('a', 1), game('gone', 1)], [game('a', 5), game('b', 6), game('new', 7)]);
  assert.deepEqual(merged.map((g) => g.id), ['b', 'a', 'new']);
  assert.equal(merged[0].targetMinutes, 6);
});

test('start-script escaping matches where each value ends up', () => {
  assert.equal(escapeBatchQuoted("Baldur's Gate (3) 100%"), "Baldur's Gate (3) 100%%");
  assert.equal(escapeBatchQuoted('say "hi"\r\nexit'), 'say hi  exit');
  assert.equal(escapeBatch('A & B (x) ^'), 'A ^& B ^(x^) ^^');
  assert.equal(escapePowerShell("it's"), "it''s");
});

test('start scripts close the game after the card timer and escape the game name', () => {
  // Long preset: 8 s wait for Discord + 10 min + 10 s final margin.
  const scripts = buildStartScripts({ name: 'A & B', executable: 'ab.exe', targetMinutes: 10, bufferPreset: 'long' });
  assert.equal(scriptRunSeconds({ targetMinutes: 10, bufferPreset: 'long' }), 618);
  assert.ok(scripts.bat.includes('\r\n'), 'batch files use CRLF');
  assert.ok(scripts.bat.includes('title A ^& B'));
  assert.ok(scripts.bat.includes('Start-Sleep -Seconds 618'));
  assert.ok(scripts.bat.includes('taskkill /im "%GAME_IMAGE%" /t /f'));
  assert.ok(scripts.ps1.includes('Start-Sleep -Seconds 618'));
  assert.ok(scripts.py.includes('time.sleep(618)'));
  assert.ok(scripts.py.includes('"Full path to ab.exe: "'));
  assert.equal(scriptFileName({ id: 'my-game' }, 'ps1'), 'run_my-game.ps1');

  // No limit, or "Stop at the end" off: the scripts only start the game.
  for (const untimed of [{ targetMinutes: 0 }, { targetMinutes: 10, autoStop: false }]) {
    const only = buildStartScripts({ name: 'C', executable: 'c.exe', ...untimed });
    assert.equal(scriptRunSeconds(untimed), 0);
    assert.ok(!only.bat.includes('taskkill') && !only.ps1.includes('Stop-Process') && !only.py.includes('taskkill'));
  }
});

test('a PNG icon is wrapped in a one-image .ico for the placeholder window', async () => {
  const { pngToIco } = await import('../src/server/placeholderIcon.ts');
  const png = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(512, 16);
  png.writeUInt32BE(128, 20);
  const ico = pngToIco(png)!;
  assert.equal(ico.readUInt16LE(2), 1, 'icon type');
  assert.equal(ico.readUInt16LE(4), 1, 'one image');
  assert.equal(ico[6], 0, '512 px is written as 0 (256 or more)');
  assert.equal(ico[7], 128);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.ok(ico.subarray(22).equals(png));
  assert.equal(pngToIco(Buffer.from('not a png at all, just text')), null);
});

test('the default executable of a catalog game is the game binary, not a helper', async () => {
  const { preferredExecutable } = await import('../src/utils/executables.ts');
  const marvel = [
    'win64/marvel-win64-test.exe',
    'win64/marvel-win64-shipping.exe',
    'marvelrivals/marvelrivals_launcher.exe',
    'win64/marvel.exe',
  ];
  assert.equal(preferredExecutable({ name: 'Marvel Rivals', executables: marvel }), 'win64/marvel-win64-shipping.exe');
  assert.equal(preferredExecutable({ name: 'Where Winds Meet', executables: ['wwm.exe', 'where winds meet.exe'] }), 'where winds meet.exe');
  assert.equal(preferredExecutable({ name: 'One', executables: ['one.exe'] }), 'one.exe');
});

test('isSafeExecutablePath accepts a file or a relative path inside the game folder only', async () => {
  const { isSafeExecutablePath } = await import('../src/server/security.ts');
  for (const ok of ['game.exe', 'win64/game.exe', 'Binaries\\Win64\\Game.exe']) assert.ok(isSafeExecutablePath(ok), ok);
  for (const bad of ['../game.exe', 'a/../game.exe', 'C:/game.exe', '/game.exe', 'game.bin', 'con/game.exe', 'a./game.exe', ''])
    assert.ok(!isSafeExecutablePath(bad), bad);
});
