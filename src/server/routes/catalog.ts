import { Router, Request, Response } from 'express';
import type { CatalogGame } from '../../types.ts';
import { getFeaturedGames, searchGames, type DatabaseGame } from '../gameDatabase.ts';
import { databaseGameFor, gamesMap } from '../gameStore.ts';
import { discordIconUrl, localGameIcon } from '../iconStore.ts';

/**
 * The catalog: games of the Discord game database (gameDatabase.ts).
 *
 *   GET /api/catalog?q=<text>   search, best first
 *   GET /api/catalog/featured   the games shown before anything is searched
 *
 * Neither touches the network; icons are Discord CDN addresses the window
 * loads itself, or a saved copy.
 */
const router = Router();

const MAX_RESULTS = 50;
const MAX_QUERY_LENGTH = 100;

function libraryGameIds(): Set<string> {
  const ids = new Set<string>();
  for (const game of gamesMap.values()) {
    const match = databaseGameFor(game);
    if (match) ids.add(match.id);
  }
  return ids;
}

function toCatalogGame(game: DatabaseGame, inLibrary: Set<string>): CatalogGame {
  return {
    id: game.id,
    name: game.name,
    icon: localGameIcon(game) ?? discordIconUrl(game, 64),
    executables: game.executables,
    inLibrary: inLibrary.has(game.id),
  };
}

router.get('/', (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_QUERY_LENGTH) : '';
  if (query.length < 2) return res.json([]);
  const inLibrary = libraryGameIds();
  res.json(searchGames(query, MAX_RESULTS).map((game) => toCatalogGame(game, inLibrary)));
});

router.get('/featured', (_req: Request, res: Response) => {
  const inLibrary = libraryGameIds();
  res.json(getFeaturedGames().map((game) => toCatalogGame(game, inLibrary)));
});

export default router;
