import { Router, Request, Response } from 'express';
import { getSettings, updateSettings } from '../settingsStore.ts';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(getSettings());
});

router.put('/', (req: Request, res: Response) => {
  const result = updateSettings((req.body || {}) as Record<string, unknown>);
  if (typeof result === 'string') return res.status(400).json({ error: result });
  res.json(result);
});

export default router;
