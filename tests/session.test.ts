import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

const { removeSandbox } = await import('./helpers.ts');
const express = (await import('express')).default;
const { requireSession, startSession, withoutSecrets, SESSION_COOKIE } = await import('../src/server/session.ts');

after(removeSandbox);

test('with a desktop token only the window that opened /session may use the API', async () => {
  process.env.DQR_API_TOKEN = 'secret-token';
  const app = express();
  app.get('/session', startSession);
  app.use('/api', requireSession);
  app.get('/api/games', (_req, res) => res.json([]));
  app.get('/api/internal/ready', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/games`)).status, 401, 'no cookie');
    assert.equal((await fetch(`${base}/session?token=wrong`, { redirect: 'manual' })).status, 403);

    const opened = await fetch(`${base}/session?token=secret-token`, { redirect: 'manual' });
    assert.equal(opened.status, 302);
    const cookie = opened.headers.get('set-cookie') ?? '';
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=secret-token;`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const withCookie = await fetch(`${base}/api/games`, { headers: { cookie: `${SESSION_COOKIE}=secret-token` } });
    assert.equal(withCookie.status, 200);
    const forged = await fetch(`${base}/api/games`, { headers: { cookie: `${SESSION_COOKIE}=guess` } });
    assert.equal(forged.status, 401);
    assert.equal(
      (await fetch(`${base}/api/internal/ready`)).status,
      200,
      'the desktop control calls have their own token'
    );
  } finally {
    delete process.env.DQR_API_TOKEN;
    server.close();
  }
});

test('without a token the API is open, and started programs never get the tokens', () => {
  let passed = false;
  requireSession({ path: '/games', get: () => undefined } as never, {} as never, () => {
    passed = true;
  });
  assert.ok(passed);
  const env = withoutSecrets({ PATH: 'x', DQR_API_TOKEN: 'a', DQR_SHUTDOWN_TOKEN: 'b' });
  assert.deepEqual(env, { PATH: 'x' });
});
