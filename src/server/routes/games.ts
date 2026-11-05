import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  gamesMap,
  applyTimerPreferences,
  updateGameElapsed,
  findGameById,
  parseTimerPreferences,
  rescanGamesDir,
  stopGameProcess,
  stopAllRunningGames,
  toPublicGame,
  kickoffLogo,
  savePersistedState,
} from '../gameStore.ts';
import { downloadsFolder } from '../downloads.ts';
import { writeFileAtomic } from '../fsUtil.ts';
import { buildStartScripts, scriptFileName } from '../../utils/startScripts.ts';
import type { IdParams } from './gameInput.ts';
import { launchGame } from './gameLaunch.ts';
import { editGame } from './gameEdit.ts';
import { removeGame } from './gameRemove.ts';
import { addGame } from './gameAdd.ts';

const router = Router();

function publicList() {
  return Array.from(gamesMap.values()).map((game) => {
    updateGameElapsed(game);
    kickoffLogo(game);
    return toPublicGame(game);
  });
}

// GET /api/games
//
// Icons are fetched in the background (kickoffLogo); the list never waits for them.
router.get('/', (_req: Request, res: Response) => {
  res.json(publicList());
});

// POST /api/games/rescan: read Games/ again and repair missing or old placeholders
router.post('/rescan', async (_req: Request, res: Response) => {
  await rescanGamesDir();
  res.json(publicList());
});

// POST /api/games/stop-all
router.post('/stop-all', (_req: Request, res: Response) => {
  const count = stopAllRunningGames();
  res.json({ success: true, stoppedCount: count });
});

// POST /api/games/:id/stop
router.post('/:id/stop', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) {
    return res.status(404).json({ error: 'Game not found' });
  }
  const { game } = match;
  stopGameProcess(game);
  res.json({ success: true, game: toPublicGame(game) });
});

// POST /api/games/:id/reset-timer (the timer settings stay)
router.post('/:id/reset-timer', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) {
    return res.status(404).json({ error: 'Game not found' });
  }
  const { game } = match;
  stopGameProcess(game);
  game.elapsedSeconds = 0;
  game.completed = false;
  game.startedAt = undefined;
  savePersistedState(true);
  res.json({ success: true, game: toPublicGame(game) });
});

// PUT /api/games/:id/timer: target, wait for Discord, stop at the end
//
// Allowed for every entry, catalog entries included: the preferences belong to
// the library, not to the files on disk. They are saved in Games/.state.json.
router.put('/:id/timer', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) return res.status(404).json({ error: 'Game not found' });
  const { game } = match;
  if (game.isRunning) {
    return res.status(409).json({ error: `Stop "${game.name}" before changing its timer.` });
  }
  const prefs = parseTimerPreferences((req.body || {}) as Record<string, unknown>);
  if (typeof prefs === 'string') return res.status(400).json({ error: prefs });
  if (Object.keys(prefs).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  applyTimerPreferences(game, prefs);
  savePersistedState(true);
  res.json({ success: true, game: toPublicGame(game) });
});

// POST /api/games/:id/script { kind: 'bat' | 'ps1' | 'py' }
//
// Saves the start script of a game to the user's Downloads folder as
// `<Game> - OrbQuest.<kind>`. The script is built here from the game, so a
// request only chooses the kind.
router.post('/:id/script', (req: Request<IdParams>, res: Response) => {
  const match = findGameById(req.params.id);
  if (!match) return res.status(404).json({ error: 'Game not found' });
  const kind = (req.body as Record<string, unknown> | undefined)?.kind;
  if (kind !== 'bat' && kind !== 'ps1' && kind !== 'py') {
    return res.status(400).json({ error: 'kind must be bat, ps1 or py.' });
  }
  const game = toPublicGame(match.game);
  const folder = downloadsFolder();
  const fileName = scriptFileName(game, kind);
  const target = path.join(folder, fileName);
  try {
    fs.mkdirSync(folder, { recursive: true });
    writeFileAtomic(target, buildStartScripts(game)[kind]);
  } catch (error) {
    console.warn('Could not save the start script', error);
    return res.status(500).json({ error: `Could not save ${fileName} to ${folder}.` });
  }
  res.json({ success: true, fileName, path: target });
});

router.post('/:id/launch', launchGame);
router.patch('/:id', editGame);
router.delete('/:id', removeGame);
router.post('/', addGame);

export default router;
