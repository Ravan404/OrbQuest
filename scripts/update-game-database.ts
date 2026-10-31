/**
 * scripts/update-game-database.ts
 *
 *   npm run update-database
 *   npm run update-database -- --dry-run   (show what would change, write nothing)
 *
 * Downloads Discord's list of detectable games and rebuilds
 * src/server/gameDatabase.json from it. The file is only rewritten when the
 * games changed, so its date says when Discord's list last changed. The
 * Game database workflow (.github/workflows/database.yml) runs this every
 * six hours and commits the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DISCORD_DETECTABLE_URL,
  buildGameDatabase,
  sameGames,
  serializeGameDatabase,
  type GameDatabase,
} from '../src/server/gameDatabaseSource.ts';
import { APP_VERSION } from '../src/version.ts';

const FILE = path.join(process.cwd(), 'src', 'server', 'gameDatabase.json');

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const response = await fetch(DISCORD_DETECTABLE_URL, {
    headers: { 'User-Agent': `OrbQuest/${APP_VERSION} (game database update)`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Discord answered HTTP ${response.status}.`);
  const next = buildGameDatabase(await response.json(), new Date().toISOString());

  const current: GameDatabase | null = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
  console.log(`Discord lists ${next.games.length} games with a Windows executable.`);
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
  console.log(`Written: ${path.relative(process.cwd(), FILE)}`);
}

run().catch((error) => {
  console.error('The database update failed:', error);
  process.exitCode = 1;
});
