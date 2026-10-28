/**
 * redditCorrections.ts
 *
 * Hand-checked fixes for r/DiscordQuests posts whose text the generic
 * extractor cannot read correctly: typos, unusual separators, paths that are
 * only described in prose, posts that document two games at once.
 *
 * Every fix is keyed by the Reddit post id, the stable part of the post URL
 * (`/comments/<id>/`). The same table is applied when `process-apify.ts`
 * rebuilds `redditCache.json`, when the background refresh crawls the
 * subreddit again and when a live search returns one of these posts, so a
 * corrected entry can never come back in its broken form under a second name.
 *
 * Each value was checked against the post itself and the subreddit's own game
 * index wiki (https://www.reddit.com/r/DiscordQuests/wiki/game-index/).
 */

import type { RedditCacheEntry } from './redditDataset.ts';

export interface RedditEntryFix {
  /** Why the extracted value was wrong. Documentation only. */
  reason: string;
  gameName?: string;
  executableName?: string;
  folderPath?: string;
  notes?: string;
  confidence?: RedditCacheEntry['confidence'];
  /**
   * Search aliases of the entry. When set they replace the spellings the post
   * used (e.g. a title that names two games or only the quest).
   */
  aliases?: string[];
}

export const REDDIT_ENTRY_FIXES: Record<string, RedditEntryFix> = {
  // "Destiny 2 - Ends December 14th, 2025"
  '1pekhy5': {
    reason: 'The post misspells the executable as "desinty2.exe"; the game index lists destiny2.exe.',
    executableName: 'destiny2.exe',
  },
  // "Albion Online: Dragonfire Quest"
  '1vu2kqj': {
    reason: 'The post writes the path as ".. game \\Albion-Online.exe".',
    folderPath: '..\\game',
  },
  // "Dragonheir: Chaos Revelry Quest"
  '1wh71j1': {
    reason: 'The post uses ">" as the separator: "Dragonheir Silent Gods>Dragonheir.exe".',
    folderPath: 'Dragonheir Silent Gods',
    confidence: 'medium',
  },
  // "Wizard101 Quest"
  '1wmjjry': {
    reason: 'A doubled separator ("\\Wizard101\\\\Wizard101.exe") hid the folder.',
    folderPath: 'Wizard101',
    confidence: 'medium',
  },
  // "Yu-Gi-Oh! Master Duel Quest"
  '1u2bpa1': {
    reason: 'The "!" cut the folder name short; the post stresses that the double space is required.',
    folderPath: 'Yu-Gi-Oh!  Master Duel',
    notes: 'The folder name needs two spaces between "Yu-Gi-Oh!" and "Master Duel".',
  },
  // "Vindictus Quest"
  '1r1tfl5': {
    reason: 'The post only says that any folder works; the game index uses a Vindictus folder.',
    folderPath: 'Vindictus',
    confidence: 'medium',
    notes: 'Any folder works, even the root of a drive.',
  },
  // "Complete Warframe Quest"
  '1u8h6kd': {
    reason: 'The post only names the executable; the game index lists "..\\warframe.exe" (a folder of any name).',
    folderPath: 'Warframe',
    confidence: 'medium',
    notes: 'Any folder name works: the executable only has to sit inside one folder (..\\warframe.exe).',
  },
  // "GearUP Quest"
  '1uldset': {
    reason: 'The post writes "..\\Gearup_ball.exe": the executable goes into a folder of any name.',
    folderPath: 'GearUP',
    confidence: 'medium',
    notes: 'Any folder name works: the executable only has to sit inside one folder (..\\Gearup_ball.exe).',
  },
  // "Duet Night Abyss Quest"
  '1tuwt7i': {
    reason: 'Three dots instead of two in front of the folder ("...\\Duet Night Abyss").',
    folderPath: '..\\Duet Night Abyss',
  },
  // "Dragon Age: The Veilguard Quest"
  '1vuoerw': {
    reason: 'The post lists two spellings of the executable.',
    notes: 'If it is not detected, name the executable "Dragon Age The Veilguard.exe" (with spaces) instead.',
  },
  // "Shift At Midnight Quest"
  '1v3oh81': {
    reason: 'Setup instructions from the post.',
    notes:
      'Start downloading the demo on Steam (about 5-15%) so Steam creates the folder and the identification files Discord checks.',
  },
  // "Enginefall Demo Quest Folder Structure and EXE Location:"
  '1u6s185': {
    reason: 'Setup instructions from the post.',
    notes:
      'Start the demo download on Steam and pause it, then put the executable into the folder Steam created (Manage > Browse local files).',
  },
  // "Method for completing the quests for "Marathon" and "Toxic Commando""
  '1rhvwn9': {
    reason: 'Setup instructions from the post.',
    notes:
      'Steam-only quest: put appmanifest_3065800.acf and appmanifest_4354730.acf into SteamLibrary\\steamapps (copy any existing .acf file and rename it), then restart Discord before running the executable.',
  },
  // "blue pro and torchlight inf" - two games in one post; the second one is a
  // supplement below.
  '1qer5b4': {
    reason: 'The title names two games; the first path in the post is Torchlight: Infinite.',
    gameName: 'Torchlight: Infinite',
    aliases: ['Torchlight Infinite'],
  },
  // "exe paths for yall questers :]" - a list of paths; the extractor reads one
  // of them (skate.), the games the database has no own post for are
  // supplements below.
  '1szuf4r': {
    reason: 'A list post: the title is not a game name.',
    gameName: 'skate.',
    aliases: [],
  },
  // "Wuthering Waves File Directory"
  '1u1nufn': {
    reason: 'The body is just "Wuthering Waves.exe"; the extractor cut the name at its space ("Waves.exe").',
    executableName: 'Wuthering Waves.exe',
  },
  // "Capcom TGS Deals Quest" - the quest accepts several Capcom games.
  '1wa252x': {
    reason: 'The post lists Street Fighter 6 first and Monster Hunter Stories second; the extractor kept the second.',
    gameName: 'Street Fighter 6',
    executableName: 'StreetFighter6.exe',
    folderPath: '..\\Street Fighter 6',
    aliases: ['Capcom TGS Deals'],
    notes: 'For the Capcom TGS Deals quest. Monster Hunter Stories works as well (..\\Monster Hunter Stories\\MHST.exe).',
  },
  // "Capcom TGS Deals Quest"
  '1wa7p56': {
    reason: 'The title only names the quest; folder and executable are Monster Hunter Stories.',
    gameName: 'Monster Hunter Stories',
    aliases: ['Capcom TGS Deals'],
    notes: 'For the Capcom TGS Deals quest. Street Fighter 6 works as well (..\\Street Fighter 6\\StreetFighter6.exe).',
  },
  // "help for forza horizon 6 quest"
  '1tvjx2c': {
    reason: 'A help request: the poster reports that this path did NOT complete the quest.',
    confidence: 'experimental',
    notes: 'Unconfirmed: the Reddit poster reported that this path did not complete the quest.',
  },
};

/**
 * Additional games described by a post next to the one the extractor reads
 * (it keeps a single executable per post).
 */
export const REDDIT_POST_SUPPLEMENTS: Record<string, Array<Omit<RedditCacheEntry, 'url' | 'source'>>> = {
  // "blue pro and torchlight inf": "...\\Torchlight_Infinite.exe" + "bpsr\\BPSR_STEAM.exe"
  '1qer5b4': [
    {
      gameName: 'Blue Protocol: Star Resonance',
      executableName: 'BPSR_STEAM.exe',
      folderPath: 'bpsr',
      confidence: 'medium',
    },
  ],
  // "exe paths for yall questers :]" - only the games without an own post in
  // the database. (The post writes "Fallout76.ex"; the executable is
  // Fallout76.exe.)
  '1szuf4r': [
    { gameName: 'PUBG: BATTLEGROUNDS', executableName: 'TslGame.exe', folderPath: 'Win64', confidence: 'medium' },
    {
      gameName: 'Comet AI Browser',
      executableName: 'comet.exe',
      folderPath: 'Perplexity\\Comet\\Application',
      confidence: 'medium',
    },
    { gameName: 'Hunt: Showdown 1896', executableName: 'HuntGame.exe', folderPath: 'win_x64', confidence: 'medium' },
    { gameName: 'Fallout 76', executableName: 'Fallout76.exe', folderPath: 'Fallout76', confidence: 'medium' },
    { gameName: 'RAID: Shadow Legends', executableName: 'Raid.exe', folderPath: 'build', confidence: 'medium' },
    { gameName: 'Blue Protocol: Star Resonance', executableName: 'bpsr.exe', folderPath: 'Win64', confidence: 'medium' },
    {
      gameName: '2XKO',
      executableName: 'Lion-Win64-Shipping.exe',
      folderPath: '2XKO\\Live\\Lion\\Binaries\\Win64',
      confidence: 'medium',
    },
  ],
  // "March of Giants Playtest": "..\\win64\\thelineclient-win64-shipping"
  // (no ".exe", so the extractor finds nothing).
  '1x02eas': [
    {
      gameName: 'March of Giants',
      executableName: 'TheLineClient-Win64-Shipping.exe',
      folderPath: '..\\win64',
      confidence: 'medium',
      notes:
        'For the March of Giants Playtest quest. If it does not work right away, close Discord completely and restart it before starting the executable.',
    },
  ],
  // "Method for completing the quests for "Marathon" and "Toxic Commando""
  '1rhvwn9': [
    {
      gameName: 'Marathon',
      executableName: 'Marathon.exe',
      folderPath: 'SteamLibrary\\steamapps\\common\\Marathon Server Slam',
      confidence: 'medium',
      notes:
        'Steam-only quest: put appmanifest_3065800.acf and appmanifest_4354730.acf into SteamLibrary\\steamapps (copy any existing .acf file and rename it), then restart Discord before running the executable.',
    },
  ],
};

/** Reddit post id from a post URL (".../comments/<id>/<slug>/"). */
export function redditPostId(url: string | undefined): string | undefined {
  const match = /\/comments\/([a-z0-9]+)(?:[/?#]|$)/i.exec(url || '');
  return match ? match[1].toLowerCase() : undefined;
}

/** Applies the hand-checked fix of the entry's post, if there is one. */
export function applyRedditEntryFix<T extends RedditCacheEntry>(entry: T): T {
  const id = redditPostId(entry.url);
  const fix = id ? REDDIT_ENTRY_FIXES[id] : undefined;
  if (!fix) return entry;
  // Aliases are applied by redditDataset.ts when the name is finalized.
  const { reason: _reason, aliases: _aliases, ...values } = fix;
  const fixed = { ...entry, ...values };
  if (values.folderPath && fixed.confidence === 'experimental' && !values.confidence) {
    fixed.confidence = 'medium';
  }
  return fixed;
}
