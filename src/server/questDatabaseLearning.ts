/**
 * questDatabaseLearning.ts
 *
 * A game the quest database did not know, found by a live Reddit search and
 * added to the library, is saved into the local quest database
 * (`Games/.quest-database.json`). The next search for it is then answered
 * offline, without asking Reddit again.
 */

import { recentOnlineEntry } from './onlineResultMemory.ts';
import { listQuestDbRecords, recordExecutables } from './questLookup.ts';
import { addLocalEntry } from './redditCacheStore.ts';
import type { RedditCacheEntry } from './redditDataset.ts';

/** True when any game of the quest database already uses this executable. */
export function questDatabaseHasExecutable(executableName: string): boolean {
  const exe = executableName.trim().toLowerCase();
  return listQuestDbRecords().some((record) =>
    recordExecutables(record).some((candidate) => candidate.trim().toLowerCase() === exe)
  );
}

/**
 * Called after a game was added to the library. When its executable came from
 * a live Reddit result the server returned and the database does not have it
 * yet, that result is saved to the local database. Returns the saved entry.
 */
export function learnFromLibraryAddition(executableName: string): RedditCacheEntry | null {
  if (!executableName || questDatabaseHasExecutable(executableName)) return null;
  const online = recentOnlineEntry(executableName);
  if (!online) return null;
  return addLocalEntry(online, 'library') ? online : null;
}
