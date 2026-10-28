/**
 * onlineResultMemory.ts
 *
 * The live Reddit results the server returned recently, by executable.
 *
 * When the user adds one of them to the library, questDatabaseLearning.ts
 * saves exactly this entry - read from Reddit by the server itself - into the
 * local quest database. Nothing the browser sends is written to the database.
 */

import type { RedditCacheEntry } from './redditDataset.ts';

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ITEMS = 500;

const memory = new Map<string, { entry: RedditCacheEntry; at: number }>();

function key(executableName: string): string {
  return executableName.trim().toLowerCase();
}

/** Remembers live results (the newest result per executable wins). */
export function rememberOnlineEntries(entries: RedditCacheEntry[]): void {
  const now = Date.now();
  for (const entry of entries) {
    const exe = key(entry.executableName || '');
    if (!exe) continue;
    memory.delete(exe);
    memory.set(exe, { entry, at: now });
  }
  while (memory.size > MAX_ITEMS) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** The live result recently shown for an executable, if any. */
export function recentOnlineEntry(executableName: string): RedditCacheEntry | undefined {
  const exe = key(executableName || '');
  const item = memory.get(exe);
  if (!item) return undefined;
  if (Date.now() - item.at > TTL_MS) {
    memory.delete(exe);
    return undefined;
  }
  return item.entry;
}

