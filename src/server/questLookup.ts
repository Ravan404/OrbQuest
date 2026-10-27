/**
 * questLookup.ts
 *
 * The local quest database as the search screens see it: ONE record per game.
 *
 * Two sources are merged by canonical game name (gameNames.ts):
 *   - the Reddit-derived entries (redditCacheStore.ts) - the primary data, it
 *     is what r/DiscordQuests posted for the game;
 *   - the curated registry (questDatabase.ts) - only used as the data of a
 *     game the Reddit entries do not cover, but its aliases ("osrs", "zzz")
 *     always help to find a game.
 *
 * Nothing in here touches the network. The catalog screen lists these records
 * first, and the executable search answers from them before Reddit is asked.
 */

import { cleanDisplayName, knownAliasesFor, normalizeGameKey } from './gameNames.ts';
import { gameNameMatchRank } from './gameKey.ts';
import { VERIFIED_QUEST_GAMES, type VerifiedGameInfo } from './questDatabase.ts';
import { getRedditCacheEntries, getRedditCacheRevision } from './redditCacheStore.ts';
import type { RedditCacheEntry } from './redditDataset.ts';

export interface QuestDbRecord {
  /** Canonical display name. */
  name: string;
  /** `normalizeGameKey(name)`. */
  key: string;
  /** Other names that find this game (never shown as separate games). */
  aliases: string[];
  aliasKeys: string[];
  /** Reddit-derived entries of this game, one per executable. */
  entries: RedditCacheEntry[];
  /** Curated registry data of the same game (used when `entries` is empty). */
  verified?: VerifiedGameInfo;
}

let indexedRevision = -1;
let records: QuestDbRecord[] = [];

function createRecord(name: string, key: string): QuestDbRecord {
  return { name, key, aliases: [], aliasKeys: [], entries: [] };
}

function addAliases(record: QuestDbRecord, names: readonly string[]): void {
  for (const raw of names) {
    const alias = cleanDisplayName(raw);
    const key = normalizeGameKey(alias);
    if (!alias || !key || key === record.key || record.aliasKeys.includes(key)) continue;
    record.aliases.push(alias);
    record.aliasKeys.push(key);
  }
}

function rebuildIndex(): void {
  const byKey = new Map<string, QuestDbRecord>();
  const byExecutable = new Map<string, QuestDbRecord>();

  for (const entry of getRedditCacheEntries()) {
    const key = normalizeGameKey(entry.gameName) || entry.gameName.trim().toLowerCase();
    let record = byKey.get(key);
    if (!record) {
      record = createRecord(entry.gameName, key);
      byKey.set(key, record);
    }
    record.entries.push(entry);
    addAliases(record, entry.aliases ?? []);
    byExecutable.set(entry.executableName.trim().toLowerCase(), record);
  }

  for (const game of VERIFIED_QUEST_GAMES) {
    const key = normalizeGameKey(game.name);
    let record = byKey.get(key) ?? byExecutable.get(game.executable.trim().toLowerCase());
    if (!record) {
      record = createRecord(game.name, key);
      byKey.set(key, record);
    }
    record.verified ??= game;
    addAliases(record, [game.name, ...game.aliases]);
  }

  for (const record of byKey.values()) addAliases(record, knownAliasesFor(record.name));

  records = Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
  indexedRevision = getRedditCacheRevision();
}

function ensureIndex(): void {
  if (indexedRevision !== getRedditCacheRevision()) rebuildIndex();
}

/** Every game of the local quest database, alphabetically. */
export function listQuestDbRecords(): readonly QuestDbRecord[] {
  ensureIndex();
  return records;
}

/** Executables a record contributes to search results. */
export function recordExecutables(record: QuestDbRecord): string[] {
  if (record.entries.length > 0) return record.entries.map((entry) => entry.executableName);
  return record.verified ? [record.verified.executable] : [];
}

/**
 * Games of the local database that answer a query.
 *
 * An exact game name ("RuneScape") returns only that game, so picking a game
 * in the catalog never mixes in a different one ("Old School RuneScape").
 * Anything else returns every game whose name contains the query, plus games
 * known under that alias ("osrs", "deadpool"). Explicit executable queries
 * ("aces.exe") match the executable names instead.
 */
export function findQuestDbRecords(query: string): QuestDbRecord[] {
  ensureIndex();
  const q = normalizeGameKey(query);
  if (q.length < 2) return [];

  if (/\.exe$/i.test(query.trim())) {
    return records.filter((record) =>
      recordExecutables(record).some((exe) => {
        const exeKey = normalizeGameKey(exe);
        return exeKey === q || (q.length >= 6 && exeKey.includes(q));
      })
    );
  }

  const exact = records.filter((record) => record.key === q);
  if (exact.length > 0) return exact;

  const rank = (record: QuestDbRecord): number => {
    if (record.aliasKeys.includes(q)) return 0;
    const byName = gameNameMatchRank(record.name, record.key, q);
    if (byName >= 0) return byName;
    if (q.length >= 4 && record.aliasKeys.some((key) => key.includes(q))) return 3;
    return -1;
  };

  return records
    .map((record) => ({ record, score: rank(record) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.record.name.localeCompare(b.record.name))
    .map((item) => item.record);
}
