import type { StoredGame } from '../config.ts';
import { cacheGameIcon, discordIconUrl, localGameIcon, remoteIconUrl } from '../iconStore.ts';
import { findGameByExecutable, findGameByName, getGameById, type DatabaseGame } from '../gameDatabase.ts';

/** The icon of a library game. */

/** The Discord database game a library entry is: by its id, its executable or its exact name. */
export function databaseGameFor(game: Pick<StoredGame, 'appId' | 'executable' | 'name'>): DatabaseGame | undefined {
  return getGameById(game.appId) ?? findGameByExecutable(game.executable) ?? findGameByName(game.name);
}

/**
 * Sets the game's icon: the saved copy, or Discord's CDN address while the
 * icon is saved in the background. A game Discord does not know has none.
 */
export function kickoffLogo(game: StoredGame): void {
  if (game.logoUrl?.startsWith('/') || game.logoPromise) return;
  const match = databaseGameFor(game);
  if (!match) return;
  const local = localGameIcon(match);
  if (local) {
    game.logoUrl = local;
    return;
  }
  // A website icon (Firefox) shows once the server has saved it.
  game.logoUrl = discordIconUrl(match);
  if (!remoteIconUrl(match)) return;
  game.logoPromise = cacheGameIcon(match).then((url) => {
    game.logoPromise = undefined;
    if (url) game.logoUrl = url;
    return url;
  });
}
