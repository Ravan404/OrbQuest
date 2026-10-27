import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { gamesDir, readJson, removeSandbox } = await import('./helpers.ts');
const store = await import('../src/server/redditCacheStore.ts');
const { fetchPublishedDatabase } = await import('../src/server/publishedDatabase.ts');
const bundled = (await import('../src/server/redditCache.json', { with: { type: 'json' } })).default as {
  generatedAt: string;
  checkedThrough: string;
  entries: unknown[];
};

const localFile = path.join(gamesDir, '.quest-database.json');
const newGame = {
  gameName: 'Published Test Game',
  executableName: 'PublishedTestGame-Win64-Shipping.exe',
  folderPath: 'PublishedTestGame\\Binaries\\Win64',
  confidence: 'high',
  url: 'https://www.reddit.com/r/DiscordQuests/comments/abc123/published_test_game/',
  source: 'reddit',
};
const later = new Date(Date.parse(bundled.generatedAt) + 86_400_000).toISOString();
const published = { generatedAt: later, checkedThrough: later, entries: [...bundled.entries, newGame] };

const hasNewGame = () => store.getRedditCacheEntries().some((entry) => entry.executableName === newGame.executableName);

/** A fake host: the first address is down, the second serves `body` with an ETag. */
function fakeFetch(body: unknown, etag = '"v1"') {
  const requests: { url: string; ifNoneMatch: string | null }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    requests.push({ url, ifNoneMatch });
    if (url.includes('raw.githubusercontent.com')) return new Response('busy', { status: 503 });
    if (ifNoneMatch === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
  }) as typeof fetch;
  return { impl, requests };
}

after(removeSandbox);

test('a newer published database replaces the bundled one and survives a restart', async () => {
  store.loadRedditCache();
  assert.equal(hasNewGame(), false);

  const first = fakeFetch(published);
  await store.refreshQuestDatabase(first.impl);
  assert.equal(first.requests.length, 2, 'the second address is tried when the first fails');
  assert.ok(hasNewGame());
  assert.equal(store.getQuestDatabaseInfo().bundled.updatedAt, later);
  assert.equal(readJson(localFile).published.etag, '"v1"');

  const second = fakeFetch(published);
  await store.refreshQuestDatabase(second.impl);
  assert.equal(second.requests.at(-1)?.ifNoneMatch, '"v1"', 'the saved ETag is sent');
  assert.ok(hasNewGame(), 'a 304 keeps the database');

  store.loadRedditCache();
  assert.ok(hasNewGame(), 'the published database is used again after a restart, offline');
});

test('a published database older than the bundled one is ignored', async () => {
  fs.rmSync(localFile, { force: true });
  store.loadRedditCache();
  const older = { ...published, generatedAt: '2020-01-01T00:00:00.000Z' };
  await store.refreshQuestDatabase(fakeFetch(older, '"old"').impl);
  assert.equal(hasNewGame(), false);
  assert.equal(store.getQuestDatabaseInfo().bundled.updatedAt, bundled.generatedAt);
});

test('a broken, oversized or unreachable download is not used', async () => {
  const urls = ['https://example.invalid/db.json'];
  const answer = (body: string, headers: Record<string, string> = {}) =>
    (async () => new Response(body, { status: 200, headers })) as typeof fetch;
  assert.equal((await fetchPublishedDatabase('', urls, answer('not json'))).status, 'failed');
  assert.equal((await fetchPublishedDatabase('', urls, answer('{"entries":"no"}'))).status, 'failed');
  assert.equal(
    (await fetchPublishedDatabase('', urls, answer('{"entries":[]}', { 'content-length': String(6 * 1024 * 1024) }))).status,
    'failed'
  );
  const down = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  assert.equal((await fetchPublishedDatabase('', urls, down)).status, 'failed');
});
