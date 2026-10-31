/**
 * scripts/update-game-database.ts
 *
 *   npm run update-database
 *   npm run update-database -- --dry-run   (show what would change, write nothing)
 *
 * Rebuilds src/server/gameDatabase.json:
 *
 *   1. Discord's list of detectable games gives the games and their
 *      executables.
 *   2. r/DiscordQuests gives the quest programs Discord's list has no
 *      executable for (browsers and other apps, new quest games Discord has
 *      not added yet). Only posts newer than the snapshots in data/reddit/ are
 *      read, usually with one request; new posts are saved as a snapshot.
 *      When Reddit and its Arctic Shift archive do not answer, the snapshots
 *      already there are used.
 *
 * The file is only rewritten when the games changed. The Game database
 * workflow (.github/workflows/database.yml) runs this every six hours and
 * commits the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DISCORD_DETECTABLE_URL,
  buildGameDatabase,
  sameGames,
  serializeGameDatabase,
  sortGames,
  type GameDatabase,
} from '../src/server/gameDatabaseSource.ts';
import { APP_VERSION } from '../src/version.ts';
import { DATASET_DIR, buildDatabaseEntries, datasetPostIds, listDatasetFiles, loadDataset, newestTimestamp } from '../src/server/reddit/snapshots.ts';
import { fetchNewSubredditPosts } from '../src/server/reddit/posts.ts';
import { buildRedditSupplement } from '../src/server/reddit/supplement.ts';

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'src', 'server', 'gameDatabase.json');

function snapshotPath(date: string): string {
  const dir = path.join(ROOT, DATASET_DIR);
  fs.mkdirSync(dir, { recursive: true });
  let candidate = path.join(dir, `dataset_reddit-update_${date}.json`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `dataset_reddit-update_${date}-${n}.json`);
  return candidate;
}

/** Reads new r/DiscordQuests posts into a snapshot; returns every snapshot file. */
async function updateRedditSnapshots(dryRun: boolean): Promise<string[]> {
  const files = listDatasetFiles(ROOT);
  const dataset = loadDataset(files);
  const result = await fetchNewSubredditPosts({
    since: dataset.checkedThrough,
    knownIds: datasetPostIds(dataset),
    maxPages: 10,
    waitForBudget: true,
  });
  if (!result.source) {
    console.warn('r/DiscordQuests could not be read; the saved posts are used.');
    return files;
  }
  const checkedThrough = newestTimestamp([
    dataset.checkedThrough,
    result.complete || result.source === 'arctic-shift' ? result.newestCreatedAt : '',
  ]);
  console.log(`r/DiscordQuests: ${result.posts.length} new post(s) via ${result.source}.`);
  if (dryRun || (result.posts.length === 0 && checkedThrough === dataset.checkedThrough)) return files;
  const fetchedAt = new Date().toISOString();
  const file = snapshotPath(fetchedAt.slice(0, 10));
  const snapshot = {
    source: result.source,
    subreddit: 'DiscordQuests',
    fetchedAt,
    checkedThrough,
    textFormat: 'markdown',
    note: 'Written by scripts/update-game-database.ts: the r/DiscordQuests posts created after the previous snapshots.',
    posts: result.posts.map(({ textFormat: _format, ...post }) => post),
  };
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  console.log(`Snapshot written: ${path.relative(ROOT, file)}`);
  return [...files, file];
}

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const response = await fetch(DISCORD_DETECTABLE_URL, {
    headers: { 'User-Agent': `OrbQuest/${APP_VERSION} (game database update)`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Discord answered HTTP ${response.status}.`);
  const discordList = (await response.json()) as unknown[];
  const discord = buildGameDatabase(discordList, new Date().toISOString());
  console.log(`Discord lists ${discord.games.length} games with a Windows executable.`);

  const snapshots = await updateRedditSnapshots(dryRun);
  const entries = buildDatabaseEntries(loadDataset(snapshots).posts);
  const supplement = buildRedditSupplement(entries, discordList, discord.games);
  console.log(`r/DiscordQuests adds ${supplement.length} program(s) Discord gives no executable for:`);
  for (const game of supplement) console.log(`  ${game.name} [${game.executables.join(', ')}]${game.icon ? '' : ' (no Discord icon)'}`);

  const next: GameDatabase = { ...discord, games: sortGames([...discord.games, ...supplement]) };
  const current: GameDatabase | null = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
  if (current && sameGames(current, next)) {
    console.log(`The database is up to date (last change ${current.generatedAt}).`);
    return;
  }

  const before = new Map((current?.games ?? []).map((game) => [game.id, game]));
  const added = next.games.filter((game) => !before.has(game.id));
  const removed = (current?.games ?? []).filter((game) => !next.games.some((n) => n.id === game.id));
  const changed = next.games.filter((game) => before.has(game.id) && JSON.stringify(before.get(game.id)) !== JSON.stringify(game));
  console.log(`Added ${added.length}, removed ${removed.length}, changed ${changed.length}.`);
  for (const game of added.slice(0, 20)) console.log(`  + ${game.name} [${game.executables.join(', ')}]`);
  if (added.length > 20) console.log(`  ... and ${added.length - 20} more`);

  if (dryRun) {
    console.log('--dry-run: nothing written.');
    return;
  }
  fs.writeFileSync(FILE, serializeGameDatabase(next), 'utf8');
  console.log(`Written: ${path.relative(ROOT, FILE)}`);
}

run().catch((error) => {
  console.error('The database update failed:', error);
  process.exitCode = 1;
});
