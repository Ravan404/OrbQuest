/**
 * gameCatalog.ts
 *
 * The general game list behind the catalog screen: popular Steam titles
 * (`catalog_cache.json`) plus a few big launcher-only games. These names carry
 * no quest data of their own; the quest database (Reddit-derived entries and
 * the curated registry) is merged on top of them by `questLookup.ts`.
 *
 * The JSON file is imported (not read from disk at runtime) so esbuild bakes
 * it into `dist/server.cjs`. The packaged desktop app therefore always has the
 * full list, no matter which folder the executable is started from.
 */

import steamCatalogNames from '../../catalog_cache.json';
import { cleanDisplayName, normalizeGameKey } from './gameKey.ts';

/** Big titles that are not sold on Steam (or not under this name). */
export const NON_STEAM_GAMES = [
  'Roblox',
  'Dragonheir: Silent Gods',
  'Minecraft Java Edition',
  'League of Legends',
  'VALORANT',
  'Fortnite',
  'Call of Duty',
  'Overwatch 2',
  'Genshin Impact',
  'Honkai: Star Rail',
  'Arknights: Endfield',
  'League of Legends: Wild Rift',
  'World of Warcraft',
  'Diablo IV',
  'The Sims 4',
  'EA SPORTS FC',
  'Minecraft Bedrock',
  'PUBG: BATTLEGROUNDS',
];

/** Cleans a list of names and drops entries that are the same game. */
function uniqueNames(names: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = cleanDisplayName(raw);
    const key = normalizeGameKey(name);
    // A name without a single Latin letter or digit can never be found by a
    // typed query, so it would only be dead weight in the list.
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

/** Steam catalog names, cleaned (no trademark marks, no duplicate spellings). */
export const STEAM_CATALOG_NAMES: string[] = uniqueNames(
  Array.isArray(steamCatalogNames) ? steamCatalogNames : []
);

/** Every general game name, launcher-only titles first. */
export const GENERAL_GAME_NAMES: string[] = uniqueNames([...NON_STEAM_GAMES, ...STEAM_CATALOG_NAMES]);
