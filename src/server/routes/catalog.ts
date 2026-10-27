import { Router, Request, Response } from 'express';
import { GENERAL_GAME_NAMES } from '../gameCatalog.ts';
import { gameNameMatchRank, normalizeGameKey } from '../gameKey.ts';
import { listQuestDbRecords, recordExecutables } from '../questLookup.ts';
import { localIconForKey } from '../iconStore.ts';
import { instantGameLogo, queueDatabaseIcon } from '../logo.ts';

const router = Router();

const MAX_RESULTS = 50;

export interface CatalogSuggestion {
  name: string;
  /** Local icon URL when one is on disk (database games). */
  icon?: string;
  /**
   * `database`: the game has quest data in the local database (an executable
   * is shown right away, no Reddit request needed).
   * `catalog`: a known game without local quest data; selecting it searches
   * Reddit online.
   */
  source: 'database' | 'catalog';
  executableCount?: number;
}

/**
 * 9. Catalog Search
 *
 * One card per game. The local quest database (Reddit-derived entries plus the
 * curated registry) is listed first; the general game list only adds games the
 * database does not know. Every name is compared by its canonical key, so
 * "HELLDIVERS™ 2" / "Helldivers 2" or "Marvel Rivals" / "Marvel Rivals
 * Deadpool" can no longer appear as two different games. Reddit is never
 * queried from this endpoint.
 */
router.get('/', async (req: Request, res: Response, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) {
      return res.json([]);
    }

    const q = normalizeGameKey(query);
    if (q.length < 2) return res.json([]);

    const records = listQuestDbRecords();

    // 1. Games with local quest data, best match first: the exact name, then
    //    a game known under exactly this alias ("osrs", "nte"), then name
    //    prefix / contained matches, then aliases that contain the query.
    const rank = (name: string, key: string, aliasKeys: string[]): number => {
      const byName = gameNameMatchRank(name, key, q);
      if (byName === 0) return 0;
      if (aliasKeys.includes(q)) return 1;
      if (byName > 0) return byName + 1;
      if (q.length >= 4 && aliasKeys.some((alias) => alias.includes(q))) return 4;
      return -1;
    };
    const matched = records
      .map((record) => ({ record, score: rank(record.name, record.key, record.aliasKeys) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => a.score - b.score || a.record.name.localeCompare(b.record.name));
    // Matches without an icon jump the background icon queue.
    for (const { record } of matched.slice(0, MAX_RESULTS)) queueDatabaseIcon(record, true);
    const databaseResults: CatalogSuggestion[] = matched.map(({ record }) => {
      const exes = recordExecutables(record);
      return {
        name: record.name,
        source: 'database' as const,
        icon: localIconForKey(record.key) ?? instantGameLogo(record.name, exes[0]),
        executableCount: exes.length,
      };
    });

    // 2. General game list - only games the database does not already cover
    //    under their own name or one of their aliases.
    const covered = new Set<string>();
    for (const record of records) {
      covered.add(record.key);
      for (const alias of record.aliasKeys) covered.add(alias);
    }
    const catalogResults: CatalogSuggestion[] = GENERAL_GAME_NAMES.map((name, index) => {
      const key = normalizeGameKey(name);
      return { name, index, key, score: gameNameMatchRank(name, key, q) };
    })
      .filter((game) => game.score >= 0 && !covered.has(game.key))
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((game) => ({
        name: game.name,
        source: 'catalog' as const,
        icon: localIconForKey(game.key) ?? instantGameLogo(game.name),
      }));

    res.json([...databaseResults, ...catalogResults].slice(0, MAX_RESULTS));
  } catch (err) {
    next(err);
  }
});

/**
 * Every game of the local quest database with its local icon, for the idle
 * catalog screen. Answers from memory: no Reddit, no icon service.
 */
router.get('/database', (_req: Request, res: Response) => {
  const games: CatalogSuggestion[] = listQuestDbRecords().map((record) => {
    const exes = recordExecutables(record);
    return {
      name: record.name,
      source: 'database' as const,
      icon: localIconForKey(record.key) ?? instantGameLogo(record.name, exes[0]),
      executableCount: exes.length,
    };
  });
  res.json(games);
});

export default router;
