import type { StoredGame } from '../config.ts';

/** The games of the library in memory, by id, and how a request finds one. */

export const gamesMap = new Map<string, StoredGame>();

export function toPublicGame(game: StoredGame): Omit<StoredGame, 'process' | 'session' | 'logoPromise'> {
  const { process: _process, session: _session, logoPromise: _logoPromise, ...publicGame } = game;
  return publicGame;
}

/**
 * Finds a game by its id (Express has already decoded the URL part). Only
 * the id counts: two games may share a name, and a request must never reach
 * the wrong one.
 */
export function findGameById(id: string): { key: string; game: StoredGame } | null {
  if (typeof id !== 'string' || !id.trim()) return null;
  const wanted = id.trim();
  const exact = gamesMap.get(wanted);
  if (exact) return { key: wanted, game: exact };
  const lower = wanted.toLowerCase();
  for (const [key, game] of gamesMap.entries()) {
    if (key.toLowerCase() === lower || game.id.toLowerCase() === lower) return { key, game };
  }
  return null;
}
