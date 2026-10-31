import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { gamesDir, readJson, removeSandbox } = await import('./helpers.ts');
const db = await import('../src/server/gameDatabase.ts');
const { buildGameDatabase, normalizeExecutablePath } = await import('../src/server/gameDatabaseSource.ts');
const { fetchPublishedDatabase } = await import('../src/server/publishedDatabase.ts');
const bundled = (await import('../src/server/gameDatabase.json', { with: { type: 'json' } })).default as {
  generatedAt: string;
  games: { id: string; name: string; executables: string[]; icon?: string }[];
};

const localFile = path.join(gamesDir, '.game-database.json');
const newGame = { id: '99999999999999999', name: 'Published Test Game', executables: ['win64/publishedtest-win64-shipping.exe'] };
const later = new Date(Date.parse(bundled.generatedAt) + 86_400_000).toISOString();
const published = { source: 'test', generatedAt: later, games: [...bundled.games, newGame] };
const hasNewGame = () => Boolean(db.getGameById(newGame.id));

/**
 * A fake network. The first published address is down; the second serves
 * `body` with an ETag. Discord's own address serves `discord` when given.
 */
function fakeFetch(body: unknown, options: { etag?: string; discord?: unknown; publishedDown?: boolean } = {}) {
  const etag = options.etag ?? '"v1"';
  const requests: { url: string; ifNoneMatch: string | null }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    requests.push({ url, ifNoneMatch });
    if (url.startsWith('https://discord.com/')) {
      return options.discord ? new Response(JSON.stringify(options.discord)) : new Response('down', { status: 503 });
    }
    if (options.publishedDown || url.includes('raw.githubusercontent.com')) return new Response('busy', { status: 503 });
    if (ifNoneMatch === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
  }) as typeof fetch;
  return { impl, requests };
}

after(removeSandbox);

test("Discord's list is reduced to Windows games with safe executable paths", () => {
  const raw = [
    {
      id: '700136079562375258',
      name: 'VALORANT',
      aliases: ['VALORANT', 'Valorant PBE'],
      icon_hash: '11f81959f4fdd76ca6c39c59eac256c1',
      executables: [
        { os: 'win32', name: 'win64/VALORANT-Win64-Shipping.exe', is_launcher: false },
        { os: 'win32', name: 'riotclient.exe', is_launcher: true },
        { os: 'darwin', name: 'valorant.app', is_launcher: false },
      ],
    },
    { id: '700136079562375258', name: 'Duplicate id', executables: [{ os: 'win32', name: 'dup.exe' }] },
    { id: '1', name: 'Bad id', executables: [{ os: 'win32', name: 'x.exe' }] },
    { id: '123456789012', name: 'Mac only', executables: [{ os: 'darwin', name: 'game.app' }] },
    { id: '223456789012', name: 'Unsafe', executables: [{ os: 'win32', name: '../evil.exe' }, { os: 'win32', name: 'c:/x.exe' }] },
    { id: '323456789012', name: 'Source', executables: [{ os: 'win32', name: '>hl2.exe' }] },
  ];
  const database = buildGameDatabase(raw, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    database.games.map((game) => [game.name, game.executables]),
    [
      ['Source', ['hl2.exe']],
      ['VALORANT', ['win64/valorant-win64-shipping.exe']],
    ]
  );
  assert.deepEqual(database.games[1].aliases, ['Valorant PBE'], 'the main name is not repeated as an alias');
  assert.equal(normalizeExecutablePath('Binaries\\Win64\\Game.exe'), 'binaries/win64/game.exe');
  assert.equal(normalizeExecutablePath('game.bin'), null);
  assert.equal(normalizeExecutablePath('a/../b.exe'), null);
});

test('search and executable lookups use the bundled database', () => {
  db.loadGameDatabase();
  assert.equal(db.searchGames('valorant')[0]?.name, 'VALORANT');
  assert.equal(db.searchGames('overwatch 2')[0]?.name, 'Overwatch', 'a longer query still finds the game');
  assert.equal(db.searchGames('wwm.exe')[0]?.name, 'Where Winds Meet', 'an executable name finds its game');
  assert.equal(db.searchGames('a').length, 0, 'one letter is not a search');

  assert.equal(db.findGameByExecutable('win64/valorant-win64-shipping.exe')?.name, 'VALORANT');
  assert.equal(db.findGameByExecutable('Games/VALORANT/Win64/VALORANT-Win64-Shipping.exe')?.name, 'VALORANT');
  assert.equal(db.findGameByExecutable('VALORANT-Win64-Shipping.exe')?.name, 'VALORANT', 'a unique file name is enough');
  assert.equal(db.findGameByExecutable('game.exe'), undefined, 'a file name many games use says nothing');
  assert.equal(db.findGameByName('roblox')?.name, 'ROBLOX');

  const featured = db.getFeaturedGames();
  assert.ok(featured.length >= 90, `featured games: ${featured.length}`);
  assert.ok(featured.some((game) => game.name === 'VALORANT'));
});

test('a newer published database replaces the bundled one and survives a restart', async () => {
  fs.rmSync(localFile, { force: true });
  db.loadGameDatabase();
  assert.equal(hasNewGame(), false);

  const first = fakeFetch(published);
  await db.refreshGameDatabase(first.impl);
  assert.equal(first.requests.length, 2, 'the second address is tried when the first fails');
  assert.ok(hasNewGame());
  assert.deepEqual(
    { updatedAt: db.getGameDatabaseInfo().updatedAt, from: db.getGameDatabaseInfo().from },
    { updatedAt: later, from: 'downloaded' }
  );
  assert.equal(readJson(localFile).etag, '"v1"');

  const second = fakeFetch(published);
  await db.refreshGameDatabase(second.impl);
  assert.equal(second.requests.at(-1)?.ifNoneMatch, '"v1"', 'the saved ETag is sent');
  assert.ok(hasNewGame(), 'a 304 keeps the database');

  db.loadGameDatabase();
  assert.ok(hasNewGame(), 'the downloaded database is used again after a restart, offline');
});

test('a published database older than the bundled one is ignored', async () => {
  fs.rmSync(localFile, { force: true });
  db.loadGameDatabase();
  await db.refreshGameDatabase(fakeFetch({ ...published, generatedAt: '2020-01-01T00:00:00.000Z' }, { etag: '"old"' }).impl);
  assert.equal(hasNewGame(), false);
  assert.equal(db.getGameDatabaseInfo().from, 'bundled');
});

test("Discord's own list is read only when the published one is unreachable, at most once a day", async () => {
  fs.rmSync(localFile, { force: true });
  db.loadGameDatabase();
  const discord = [
    ...[{ id: newGame.id, name: newGame.name, executables: [{ os: 'win32', name: newGame.executables[0] }] }],
  ];
  const first = fakeFetch(null, { publishedDown: true, discord });
  await db.refreshGameDatabase(first.impl);
  assert.ok(first.requests.some((r) => r.url.startsWith('https://discord.com/')), 'Discord was asked');
  assert.ok(hasNewGame(), "Discord's list is used");

  const second = fakeFetch(null, { publishedDown: true, discord });
  await db.refreshGameDatabase(second.impl);
  assert.ok(!second.requests.some((r) => r.url.startsWith('https://discord.com/')), 'not again within a day');
});

test('a broken, oversized or unreachable download is not used', async () => {
  const urls = ['https://example.invalid/db.json'];
  const answer = (body: string, headers: Record<string, string> = {}) =>
    (async () => new Response(body, { status: 200, headers })) as typeof fetch;
  assert.equal((await fetchPublishedDatabase('', urls, answer('not json'))).status, 'failed');
  assert.equal((await fetchPublishedDatabase('', urls, answer('{"games":"no"}'))).status, 'failed');
  assert.equal(
    (await fetchPublishedDatabase('', urls, answer('{"games":[]}', { 'content-length': String(32 * 1024 * 1024) }))).status,
    'failed'
  );
  const down = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  assert.equal((await fetchPublishedDatabase('', urls, down)).status, 'failed');
});
