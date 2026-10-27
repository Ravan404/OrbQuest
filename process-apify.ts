/**
 * process-apify.ts
 *
 * Rebuilds the bundled quest database (src/server/redditCache.json) from the
 * r/DiscordQuests snapshots in data/reddit/ (`dataset_reddit-*.json`:
 * the original Apify "reddit-scraper" export plus the update snapshots written
 * by scripts/update-quest-database.ts). No network access.
 *
 * Every entry gets its canonical game name (src/server/gameNames.ts) and the
 * hand-checked fix of its post (src/server/redditCorrections.ts), so the same
 * game never ends up in the database under two names.
 *
 * When the result differs from the current database, the update date is
 * recorded in src/server/questDatabaseInfo.ts (QUEST_DATABASE_UPDATED_AT and
 * the QUEST_DATABASE_UPDATE_HISTORY list). Rebuilding identical data changes
 * nothing.
 *
 * Usage:
 *   npx tsx process-apify.ts [path-to-one-dataset.json] [--note "text"]
 *
 * Without a path every dataset_reddit-*.json snapshot is used, oldest first.
 */

import path from 'path';
import {
  buildDatabaseEntries,
  countGames,
  listDatasetFiles,
  loadDataset,
  writeBundledDatabase,
} from './src/server/questDatabaseSource.ts';

function run() {
  const args = process.argv.slice(2);
  const noteIndex = args.indexOf('--note');
  const note = noteIndex >= 0 ? args.splice(noteIndex, 2)[1] : undefined;
  const root = process.cwd();
  const files = args[0] ? [path.resolve(args[0])] : listDatasetFiles(root);
  if (files.length === 0) {
    throw new Error('No dataset_reddit-*.json snapshot found in data/reddit/.');
  }

  for (const file of files) console.log(`Reading dataset: ${path.relative(root, file)}`);
  const dataset = loadDataset(files);
  const entries = buildDatabaseEntries(dataset.posts);
  const result = writeBundledDatabase(root, dataset, entries, { note });

  console.log('\nDone.');
  console.log(`  Posts scanned:       ${dataset.posts.length}`);
  console.log(`  Total cache entries: ${entries.length}`);
  console.log(`  Distinct games:      ${countGames(entries)}`);
  console.log(`  Checked through:     ${dataset.checkedThrough || '-'}`);
  console.log(
    result.changed
      ? `\nDatabase updated (${result.update.updatedAt}): src/server/redditCache.json + src/server/questDatabaseInfo.ts`
      : `\nDatabase unchanged (last update ${result.update.updatedAt}).`
  );
}

try {
  run();
} catch (error) {
  console.error('Failed to build the quest database:', error);
  process.exit(1);
}
