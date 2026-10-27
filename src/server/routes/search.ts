import { Router, Request, Response } from 'express';
import { gamesMap } from '../gameStore.ts';
import { executeMultiSourceSearch } from '../webSearch.ts';

const router = Router();

/**
 * 10. Quest & Executable Search
 *
 *   GET /api/search-quests?game=<name>&format=full            local database first,
 *                                                            Reddit only when it has nothing
 *   GET /api/search-quests?game=<name>&format=full&online=1   "Search Reddit": live Reddit search
 *                                                            added below the database results
 */
router.get('/', async (req: Request, res: Response, next) => {
  try {
    const gameName = String(req.query.game || '').trim();
    const format = String(req.query.format || '');
    // "Search Reddit" asks for a live Reddit search on top of the database.
    const online = ['1', 'true', 'yes'].includes(String(req.query.online || '').toLowerCase());

    if (!gameName) {
      return res.status(400).json({ error: 'Game name is required' });
    }

    // Validate game name to prevent injection attacks
    if (gameName.length > 200) {
      return res.status(400).json({ error: 'Game name too long' });
    }
    // Only prevent null bytes and control characters; game names may contain
    // normal punctuation and spaces.
    if (/[\x00-\x1F\x7F]/.test(gameName)) {
      return res.status(400).json({ error: 'Game name contains invalid characters' });
    }

    // "Already in Library" is decided per result, by exact executable match.
    const existingExecutables = new Set(
      Array.from(gamesMap.values()).map((g) => g.executable.toLowerCase())
    );

    const result = await executeMultiSourceSearch(gameName, {
      mode: online ? 'online' : 'database',
      existingExecutables,
    });

    res.setHeader('X-Reddit-RateLimited', String(result.redditRateLimited));
    res.setHeader('X-Sources-Searched', result.sourcesSearched.join(','));

    // If full format requested, send result object with metadata
    if (format === 'full') {
      res.json(result);
    } else {
      // Return matches array for standard compatibility
      res.json(result.matches);
    }
  } catch (err) {
    console.error('Error during multi-source search:', err);
    next(err);
  }
});

export default router;
