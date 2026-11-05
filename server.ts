import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ASSET_ROOT, BIND_HOST, GAMES_DIR, PORT, RATE_LIMIT_MAX_REQUESTS } from './src/server/config.ts';
import { createRateLimiter, isAllowedOriginForMethod, isAllowedRequestHost } from './src/server/security.ts';
import { initGameStore, startElapsedTicker, stopAllRunningGames, savePersistedState } from './src/server/gameStore.ts';
import gamesRouter from './src/server/routes/games.ts';
import catalogRouter from './src/server/routes/catalog.ts';
import settingsRouter from './src/server/routes/settings.ts';
import { APP_VERSION } from './src/version.ts';
import { getGameDatabaseInfo, loadGameDatabase, scheduleGameDatabaseRefresh } from './src/server/gameDatabase.ts';
import { ICON_CACHE_DIR } from './src/server/iconStore.ts';
import { getSettings } from './src/server/settingsStore.ts';
import { requireSession, sameSecret, startSession, withoutSecrets } from './src/server/session.ts';
import { scheduleUpdateChecks, updateAnswer } from './src/server/updateCheck.ts';
import { canInstall, downloadState, startUpdateDownload } from './src/server/updateInstall.ts';
import { spawn } from 'node:child_process';

const app = express();

let shuttingDown = false;
function shutdownHandler() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down server, stopping all running games...');
  const stoppedCount = stopAllRunningGames();
  savePersistedState(true);
  console.log(`Stopped ${stoppedCount} game(s)`);
  // taskkill /t /f in stopGameProcess handles descendants on Windows.
  setTimeout(() => process.exit(0), 1000);
}

/**
 * Content-Security-Policy for production builds. `style-src` allows inline
 * styles for the timer's progress width, and `img-src` allows Discord's CDN
 * until icons are saved. The dev server does not get it: the Vite client needs
 * a WebSocket.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.discordapp.com",
  "connect-src 'self'",
  "object-src 'none'",
].join('; ');

app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  next();
});

// Only loopback hostnames (or allowed ones) and same-site origins may talk to the API.
app.use((req, res, next) => {
  if (!isAllowedRequestHost(req.hostname)) {
    console.warn(`Blocked request with untrusted Host header "${req.get('host')}".`);
    return res.status(403).json({ error: 'Host not allowed.' });
  }
  if (!isAllowedOriginForMethod(req.method, req.get('origin'), req.get('sec-fetch-site'))) {
    console.warn(`Blocked cross-origin ${req.method} request from Origin "${req.get('origin') || 'unknown'}".`);
    return res.status(403).json({ error: 'Cross-origin request not allowed.' });
  }
  next();
});

// For the endpoints that can reach the network.
const checkRateLimit = createRateLimiter(RATE_LIMIT_MAX_REQUESTS);
const rateLimited = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
};

// Only the desktop window may use the API (session.ts).
app.get('/session', startSession);
app.use('/api', requireSession);

app.get('/api/profile', (_req, res) => {
  res.json({
    version: APP_VERSION,
    gameDatabase: getGameDatabaseInfo(),
    gamesFolder: GAMES_DIR,
  });
});
// A newer release, found by updateCheck.ts; the window asks now and then.
app.get('/api/update', async (_req, res) => {
  const update = await updateAnswer();
  res.json({
    update: update ? { version: update.version, url: update.url } : null,
    installable: canInstall(update),
    download: downloadState(),
  });
});
// Downloads and checks the update; the desktop app installs it (updateInstall.ts).
app.post('/api/update/download', rateLimited, (_req, res) => {
  res.json(startUpdateDownload());
});
// Opens the library folder in Explorer (Windows only). The path is fixed.
app.post('/api/open-games-folder', rateLimited, (_req, res) => {
  if (process.platform !== 'win32') return res.sendStatus(404);
  try {
    fs.mkdirSync(GAMES_DIR, { recursive: true });
    spawn('explorer.exe', [GAMES_DIR], { detached: true, stdio: 'ignore', env: withoutSecrets() })
      .on('error', () => {})
      .unref();
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Could not open the folder.' });
  }
});
// Desktop-only control endpoints. Their token never reaches the browser, and it
// keeps another service on a raced port from passing for the backend. Without
// the token both routes are 404.
function desktopAuthorized(req: express.Request): boolean {
  const expected = process.env.ORBQUEST_SHUTDOWN_TOKEN;
  const remote = req.socket.remoteAddress;
  if (!expected || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote || '')) return false;
  return sameSecret(req.get('X-OrbQuest-Shutdown-Token') || '', expected);
}
app.get('/api/internal/ready', (req, res) => {
  if (!process.env.ORBQUEST_SHUTDOWN_TOKEN) return res.sendStatus(404);
  if (!desktopAuthorized(req)) return res.sendStatus(403);
  res.json({ ok: true });
});
// TerminateProcess on Windows skips signal handlers and would orphan games.
app.post('/api/internal/shutdown', (req, res) => {
  if (!process.env.ORBQUEST_SHUTDOWN_TOKEN) return res.sendStatus(404);
  if (!desktopAuthorized(req)) return res.sendStatus(403);
  res.json({ success: true });
  setImmediate(shutdownHandler);
});
app.use('/api/games', gamesRouter);
app.use('/api/catalog', rateLimited, catalogRouter);
app.use('/api/settings', settingsRouter);

async function startServer() {
  await initGameStore();
  startElapsedTicker();

  loadGameDatabase();
  scheduleGameDatabaseRefresh();
  scheduleUpdateChecks();

  // Game icons saved from Discord's CDN (see iconStore.ts).
  app.use('/game-icons-cache', express.static(ICON_CACHE_DIR, { dotfiles: 'deny', maxAge: '7d', fallthrough: false }));

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(ASSET_ROOT, 'dist');
    const indexPath = path.join(distPath, 'index.html');
    /**
     * `npm run build` writes the frontend and `server.cjs` into the same `dist/`
     * folder, so the backend bundle, its sourcemap and the database files are
     * refused here.
     */
    const isBackendArtifact = (requestPath: string): boolean => {
      // `req.path` is still percent-encoded and `send` decodes it, so both forms are
      // checked: "/server%2Ecjs" would otherwise be served.
      let decoded = requestPath;
      try {
        decoded = decodeURIComponent(requestPath);
      } catch {
        // Malformed percent-encoding - keep the raw path.
      }
      return [requestPath, decoded].some((candidate) => {
        const withoutQuery = candidate.split('?')[0].split('#')[0];
        if (withoutQuery.startsWith('/.')) return true; // dotfiles
        if (/(?:^|\/)(?:gameDatabase|featuredGames|redditCache|discordIconCatalog)\.json$/i.test(withoutQuery))
          return true;
        const fileName = withoutQuery.replace(/\/+$/, '').split('/').pop() ?? '';
        return /\.(?:cjs|mjs|map)$/i.test(fileName);
      });
    };
    if (fs.existsSync(distPath)) {
      app.use((req, res, next) => {
        if (isBackendArtifact(req.path)) {
          console.warn(`Blocked request for backend artifact "${req.path}".`);
          return res.status(404).send('Not Found');
        }
        next();
      });
      app.use(express.static(distPath, { dotfiles: 'deny', index: false }));
    }
    // Express 5 path syntax: a bare '*' is no longer valid; '/{*splat}' also matches '/'.
    app.get('/{*splat}', (_req, res) => {
      let html: string;
      try {
        html = fs.readFileSync(indexPath, 'utf8');
      } catch {
        return res.status(404).send('Application build not found');
      }
      // The saved theme is on the page before the app starts, so the window
      // never shows the other one first.
      const { theme } = getSettings();
      if (theme === 'light' || theme === 'dark')
        html = html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
      res.type('html').send(html);
    });
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number; statusCode?: number } | null) ?? {};
    if (status.status === 404 || status.statusCode === 404) {
      return res.status(404).send('Not Found');
    }
    console.error('Server error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Express 5 also calls this callback with the error when listening fails;
  // the 'error' handler below reports it.
  const server = app.listen(PORT, BIND_HOST, (error?: Error) => {
    if (error) return;
    console.log(`Server running at http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${PORT}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other OrbQuest server, or set PORT to a free port.`);
    } else {
      console.error('Failed to start server:', error);
    }
    process.exitCode = 1;
  });

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);
}

startServer().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
