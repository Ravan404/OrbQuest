/**
 * The desktop window's session. The desktop app (desktop_app.py) makes a new
 * random token on every start and gives it to the server as DQR_API_TOKEN.
 * The window first opens `/session?token=...`, which turns the token into a
 * cookie only that window holds; from then on every `/api` request needs
 * it. Another program on the PC does not know the token, so it cannot start
 * or remove games through the API. Without DQR_API_TOKEN (development, tests)
 * there is no check.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'orbquest_session';

/** Compares two secrets in constant time. */
export function sameSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One cookie from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

const token = () => process.env.DQR_API_TOKEN?.trim() ?? '';

/** The environment for a program the server starts: without the desktop app's tokens. */
export function withoutSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { DQR_SHUTDOWN_TOKEN: _shutdown, DQR_API_TOKEN: _api, ...rest } = env;
  return rest;
}

/** GET /session?token=...: sets the session cookie and opens the app. */
export function startSession(req: Request, res: Response): void {
  const expected = token();
  if (!expected) {
    res.redirect('/');
    return;
  }
  if (!sameSecret(req.query.token, expected)) {
    res.status(403).send('This page only opens from the OrbQuest window.');
    return;
  }
  res.cookie(SESSION_COOKIE, expected, { httpOnly: true, sameSite: 'strict', path: '/' });
  res.redirect('/');
}

/** Lets an `/api` request through only with the session cookie (when there is a token). */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const expected = token();
  // The desktop app's own control calls carry their own token (server.ts).
  if (!expected || req.path.startsWith('/internal/')) {
    next();
    return;
  }
  if (sameSecret(readCookie(req.get('cookie'), SESSION_COOKIE), expected)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Open OrbQuest from its own window.' });
}
