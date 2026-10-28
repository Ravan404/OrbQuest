/**
 * scripts/update-quest-database.ts
 *
 * Updates the bundled quest database from r/DiscordQuests, the rate-limit
 * friendly way:
 *
 *   1. the snapshots already in the repository (data/reddit/dataset_reddit-*.json) tell
 *      which posts the database has checked;
 *   2. only the posts created after that are read from the subreddit LISTING -
 *      never Reddit's search - which is usually ONE request (redditPosts.ts).
 *      When Reddit rate limits or refuses the request, the same range is read
 *      from the Arctic Shift archive of the subreddit. All requests are spaced,
 *      budgeted and obey Retry-After / X-Ratelimit-Reset (redditClient.ts);
 *   3. the new posts are stored as a snapshot (data/reddit/dataset_reddit-update_<date>.json);
 *   4. src/server/redditCache.json is rebuilt and the update date is recorded
 *      in src/server/questDatabaseInfo.ts.
 *
 * Usage:
 *   npm run update-database
 *   npm run update-database -- --source arctic-shift   (or --source reddit)
 *   npm run update-database -- --dry-run               (show new posts, write nothing)
 *
 * Review the new entries (git diff src/server/redditCache.json) before
 * committing; posts the extractor reads wrongly get a fix in
 * src/server/redditCorrections.ts, then run `npm run build-reddit-cache`.
 */

import fs from 'fs';
import path from 'path';
import {
  DATASET_DIR,
  buildDatabaseEntries,
  datasetPostIds,
  listDatasetFiles,
  loadDataset,
  newestTimestamp,
  writeBundledDatabase,
} from '../src/server/questDatabaseSource.ts';
import { redditPostToEntries } from '../src/server/redditDataset.ts';
import { fetchNewSubredditPosts, type PostSource } from '../src/server/redditPosts.ts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function snapshotPath(root: string, date: string): string {
  const dir = path.join(root, DATASET_DIR);
  fs.mkdirSync(dir, { recursive: true });
  let candidate = path.join(dir, `dataset_reddit-update_${date}.json`);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `dataset_reddit-update_${date}-${n}.json`);
  }
  return candidate;
}

async function run(): Promise<void> {
  const root = process.cwd();
  const dryRun = process.argv.includes('--dry-run');
  const sourceArg = argValue('--source');
  const sources: PostSource[] | undefined =
    sourceArg === 'reddit' || sourceArg === 'arctic-shift' ? [sourceArg] : undefined;

  const files = listDatasetFiles(root);
  const dataset = loadDataset(files);
  console.log(`Database snapshots: ${files.length}, posts: ${dataset.posts.length}.`);
  console.log(`Checked through:    ${dataset.checkedThrough || '(nothing yet)'}`);

  const result = await fetchNewSubredditPosts({
    since: dataset.checkedThrough,
    knownIds: datasetPostIds(dataset),
    maxPages: 10,
    waitForBudget: true,
    sources,
  });

  if (!result.source) {
    console.error(
      result.rateLimited
        ? `Reddit is rate limiting (try again in ${Math.ceil(result.retryAfterMs / 1000)} s) and the archive did not answer.`
        : 'Neither Reddit nor the Arctic Shift archive answered. Nothing was changed.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n${result.posts.length} new post(s) via ${result.source}, ${result.requests} request(s).`);
  if (!result.complete) console.warn('The listing did not reach the checked range; run the update again later.');
  for (const post of result.posts) {
    const entries = redditPostToEntries(post);
    console.log(
      `  ${post.createdAt.slice(0, 10)} ${post.id} "${post.title}" -> ` +
        (entries.map((entry) => `${entry.gameName} [${entry.executableName}]`).join(', ') || 'no executable')
    );
  }

  const checkedThrough = newestTimestamp([
    dataset.checkedThrough,
    result.complete || result.source === 'arctic-shift' ? result.newestCreatedAt : '',
  ]);
  if (result.posts.length === 0 && checkedThrough === dataset.checkedThrough) {
    console.log('\nThe database is up to date.');
    return;
  }
  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const fetchedAt = new Date().toISOString();
  const file = snapshotPath(root, fetchedAt.slice(0, 10));
  const snapshot = {
    source: result.source,
    subreddit: 'DiscordQuests',
    fetchedAt,
    checkedThrough,
    textFormat: 'markdown',
    note: 'Written by scripts/update-quest-database.ts: the r/DiscordQuests posts created after the previous snapshots.',
    posts: result.posts.map(({ textFormat: _format, ...post }) => post),
  };
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  console.log(`\nSnapshot written: ${path.relative(root, file)}`);

  const next = loadDataset([...files, file]);
  const entries = buildDatabaseEntries(next.posts);
  const written = writeBundledDatabase(root, next, entries, {
    note: `Update from r/DiscordQuests via ${result.source}: ${result.posts.length} new post(s).`,
  });
  console.log(
    written.changed
      ? `Database updated (${written.update.updatedAt}): ${written.update.entries} entries, ${written.update.games} games.`
      : 'The database content did not change.'
  );
}

run().catch((error) => {
  console.error('The database update failed:', error);
  process.exitCode = 1;
});
