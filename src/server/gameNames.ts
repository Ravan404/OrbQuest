/**
 * gameNames.ts
 *
 * One display name per game.
 *
 * The local quest database is built from r/DiscordQuests posts, and post
 * titles name the same game in many ways: "Marvel Rivals Deadpool Quest",
 * "OldSchool RuneScape", "FC26", "Rune Dise" (a typo), the install folder
 * "MTFS"... Before this module existed each spelling became its own catalog
 * card next to the general game list's spelling, so one game showed up twice
 * even though both cards led to the very same executable.
 *
 * `canonicalGameName` maps every spelling onto one name, in this order:
 *   1. the executable belongs to a game of the curated quest registry;
 *   2. a curated alias (spellings used by the posts, named the way the
 *      r/DiscordQuests game index wiki names them);
 *   3. the curated registry's own name or one of its longer aliases;
 *   4. the general game list's (Steam) spelling;
 *   5. otherwise the cleaned name itself.
 * Every comparison goes through `normalizeGameKey`, so case, punctuation,
 * spacing and trademark marks never create a second game.
 */

import { GENERAL_GAME_NAMES } from './gameCatalog.ts';
import { cleanDisplayName, normalizeGameKey } from './gameKey.ts';
import { VERIFIED_QUEST_GAMES } from './questDatabase.ts';

export { cleanDisplayName, normalizeGameKey } from './gameKey.ts';

/**
 * Canonical name -> other spellings found in r/DiscordQuests posts.
 *
 * A raw name whose key equals the canonical name's own key is mapped too,
 * which also fixes capitalisation ("Runescape" -> "RuneScape",
 * "The Mound: Omen Of Cthulhu" -> "The Mound: Omen of Cthulhu").
 */
const GAME_NAME_ALIASES: Record<string, string[]> = {
  'Albion Online': ['Albion Online: Dragonfire'],
  // "Typhoeus -> endfield.exe" (post 1wxdf03)
  'Arknights: Endfield': ['Typhoeus'],
  'Call of Duty': ['Call of Duty: Modern Warfare 4', 'Call of Duty HQ'],
  // "Dark Arisen Arrives Quest": ".../dragons dogma 2/dd2.exe" (post 1x1r5wc)
  "Dragon's Dogma 2": ['Dark Arisen Arrives'],
  // "Dragonstride: Legacy Reborn Quest": "..\\Dragonheir Silent Gods\\Dragonheir.exe" (post 1wu9005)
  'Dragonheir: Silent Gods': [
    'Dragonheir: Chaos Revelry',
    'Dragonheir Silent Gods',
    'Dragonstride: Legacy Reborn',
    'Dragonstride',
  ],
  'EA SPORTS FC 26': ['FC26', 'FC 26'],
  'EA SPORTS FC 27': ['FC27', 'FC 27'],
  'Fallout 4': ['Fallout Series'],
  'Genshin Impact': ['Genshin Impact: Song of the Welkin Moon "Luna VI"'],
  'GODDESS OF VICTORY: NIKKE': ['NIKKE'],
  "John Carpenter's Toxic Commando": ["John Carpenter's Toxic Commando Demo", 'Toxic Commando'],
  Marathon: ['Marathon Server Slam'],
  'MARVEL SNAP': ['MARVEL SNAP x Draft Mode'],
  'MARVEL T\u014Dkon: Fighting Souls': ['MTFS', 'Marvel Tokon Fightings Souls'],
  'Marvel Rivals': ['Marvel Rivals Deadpool'],
  Minecraft: ['Minecraft Java Edition', 'Minecraft Bedrock', 'Minecraft Launcher'],
  'Neverness to Everness': ['NTE', 'NTE: Neverness to Everness'],
  'Old School RuneScape': ['OldSchool RuneScape', 'OSRS'],
  // "ROR2 Hallowed Concepts Quest" (post 1x0wsuu)
  'Risk of Rain 2': ['ROR2', 'ROR2 Hallowed Concepts'],
  // Roblox experiences whose quests run RobloxPlayerBeta.exe (posts 1tgyz0m,
  // 1tyryd9, 1u8p99x, 1uzocvk)
  Roblox: ['Roblox Fisch', 'Roblox: Frontlines', 'Basketball Zero', 'Tennis Zero'],
  'Rune Dice': ['Rune Dise'],
  RuneScape: ['RS3'],
  'skate.': [],
  'The Mound: Omen of Cthulhu': [],
  Warframe: ['Complete Warframe'],
};

/**
 * Executable names that many unrelated games share. They never decide which
 * game an entry belongs to.
 */
const GENERIC_EXECUTABLES = new Set([
  'app.exe',
  'bin.exe',
  'client.exe',
  'client-win64-shipping.exe',
  'game.exe',
  'game-win64-shipping.exe',
  'launcher.exe',
  'main.exe',
  'play.exe',
  'project.exe',
  'run.exe',
  'shipping.exe',
  'start.exe',
  'ue4game.exe',
  'ue5game.exe',
  'unrealgame.exe',
]);

/** Registry aliases shorter than this ("wt", "fn", "cod") are search-only. */
const MIN_CANONICAL_ALIAS_KEY_LENGTH = 5;

function buildLookup(): {
  curatedByKey: Map<string, string>;
  verifiedByKey: Map<string, string>;
  verifiedByExe: Map<string, string>;
  generalByKey: Map<string, string>;
  aliasesByKey: Map<string, string[]>;
} {
  const curatedByKey = new Map<string, string>();
  const verifiedByKey = new Map<string, string>();
  const verifiedByExe = new Map<string, string>();
  const generalByKey = new Map<string, string>();
  const aliasesByKey = new Map<string, string[]>();

  const addAlias = (canonical: string, alias: string) => {
    const key = normalizeGameKey(canonical);
    const list = aliasesByKey.get(key) ?? [];
    if (!list.some((existing) => normalizeGameKey(existing) === normalizeGameKey(alias))) list.push(alias);
    aliasesByKey.set(key, list);
  };

  for (const [canonical, aliases] of Object.entries(GAME_NAME_ALIASES)) {
    curatedByKey.set(normalizeGameKey(canonical), canonical);
    for (const alias of aliases) {
      curatedByKey.set(normalizeGameKey(alias), canonical);
      addAlias(canonical, alias);
    }
  }

  for (const game of VERIFIED_QUEST_GAMES) {
    const exe = game.executable.trim().toLowerCase();
    if (exe && !GENERIC_EXECUTABLES.has(exe) && !verifiedByExe.has(exe)) verifiedByExe.set(exe, game.name);
    const nameKey = normalizeGameKey(game.name);
    if (nameKey && !verifiedByKey.has(nameKey)) verifiedByKey.set(nameKey, game.name);
    for (const alias of game.aliases) {
      addAlias(game.name, alias);
      const aliasKey = normalizeGameKey(alias);
      if (aliasKey.length >= MIN_CANONICAL_ALIAS_KEY_LENGTH && !verifiedByKey.has(aliasKey)) {
        verifiedByKey.set(aliasKey, game.name);
      }
    }
  }

  for (const name of GENERAL_GAME_NAMES) {
    const key = normalizeGameKey(name);
    if (key && !generalByKey.has(key)) generalByKey.set(key, name);
  }

  return { curatedByKey, verifiedByKey, verifiedByExe, generalByKey, aliasesByKey };
}

const LOOKUP = buildLookup();

/**
 * The one display name used for a game everywhere in the app.
 *
 * `executableName` is optional; when it belongs to a curated registry game it
 * wins over whatever the post title said ("Roblox Fisch" + RobloxPlayerBeta.exe
 * is simply Roblox).
 */
export function canonicalGameName(rawName: string, executableName?: string): string {
  const cleaned = cleanDisplayName(rawName);
  const exe = (executableName || '').trim().toLowerCase();
  if (exe && !GENERIC_EXECUTABLES.has(exe)) {
    const byExecutable = LOOKUP.verifiedByExe.get(exe);
    if (byExecutable) return byExecutable;
  }

  const key = normalizeGameKey(cleaned);
  if (!key) return cleaned;
  return (
    LOOKUP.curatedByKey.get(key) ??
    LOOKUP.verifiedByKey.get(key) ??
    LOOKUP.generalByKey.get(key) ??
    cleaned
  );
}

/**
 * Search-only alternative names of a canonical game: curated post spellings
 * plus the registry aliases (short ones such as "osrs" or "zzz" included).
 */
export function knownAliasesFor(canonicalName: string): string[] {
  return [...(LOOKUP.aliasesByKey.get(normalizeGameKey(canonicalName)) ?? [])];
}
