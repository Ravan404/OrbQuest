import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import {
  ASSET_ROOT,
  BIND_HOST,
  GAMES_DIR,
  PORT,
  RATE_LIMIT_MAX_REQUESTS,
} from './src/server/config.ts';
import {
  createRateLimiter,
  isAllowedOriginForMethod,
  isAllowedRequestHost,
} from './src/server/security.ts';
import {
  initGameStore,
  startElapsedTicker,
  stopAllRunningGames,
  savePersistedState,
} from './src/server/gameStore.ts';
import gamesRouter from './src/server/routes/games.ts';
import catalogRouter from './src/server/routes/catalog.ts';
import settingsRouter from './src/server/routes/settings.ts';
import { APP_VERSION } from './src/version.ts';
import { getGameDatabaseInfo, loadGameDatabase, scheduleGameDatabaseRefresh } from './src/server/gameDatabase.ts';
import { ICON_CACHE_DIR } from './src/server/iconStore.ts';

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

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------

/**
 * Content-Security-Policy for the packaged app.
 *
 * `style-src` keeps `'unsafe-inline'` because React writes the timer progress
 * width through inline style attributes, and `img-src` allows Discord's CDN
 * because game icons come from there until they are saved. Everything
 * else is locked to same-origin. Applied in production builds only: the dev
 * server injects the Vite client, which needs a WebSocket connection that
 * `connect-src 'self'` would block.
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

// DNS-rebinding & Localhost CSRF defence: only loopback (or explicitly allowed)
// hostnames and same-site origins may talk to the API.
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

// Simple rate limiting for the network-backed endpoints
const checkRateLimit = createRateLimiter(RATE_LIMIT_MAX_REQUESTS);
const rateLimited = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
};

// ---------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------

app.get('/api/profile', (_req, res) => {
  res.json({
    version: APP_VERSION,
    gameDatabase: getGameDatabaseInfo(),
    gamesFolder: GAMES_DIR,
  });
});
// Desktop-only control endpoints. The nonce is NOT returned to the browser.
// They also prevent the launcher from mistaking another service on a raced
// ephemeral port for its own backend. Without the token both routes are 404.
function desktopAuthorized(req: express.Request): boolean {
  const expected = process.env.DQR_SHUTDOWN_TOKEN;
  const actual = req.get('X-DQR-Shutdown-Token') || '';
  const remote = req.socket.remoteAddress;
  if (!expected || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote || '')) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
app.get('/api/internal/ready', (req, res) => {
  if (!process.env.DQR_SHUTDOWN_TOKEN) return res.sendStatus(404);
  if (!desktopAuthorized(req)) return res.sendStatus(403);
  res.json({ ok: true });
});
// TerminateProcess on Windows skips signal handlers and would orphan games.
app.post('/api/internal/shutdown', (req, res) => {
  if (!process.env.DQR_SHUTDOWN_TOKEN) return res.sendStatus(404);
  if (!desktopAuthorized(req)) return res.sendStatus(403);
  res.json({ success: true });
  setImmediate(shutdownHandler);
});
app.use('/api/games', gamesRouter);
app.use('/api/catalog', rateLimited, catalogRouter);
app.use('/api/settings', settingsRouter);

// ---------------------------------------------------------------
// Boot + Vite middleware / static serving
// ---------------------------------------------------------------

async function startServer() {
  await initGameStore();
  startElapsedTicker();

  loadGameDatabase();
  scheduleGameDatabaseRefresh();

  // Game icons saved from Discord's CDN (see iconStore.ts).
  app.use(
    '/game-icons-cache',
    express.static(ICON_CACHE_DIR, { dotfiles: 'deny', maxAge: '7d', fallthrough: false })
  );

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
     * `npm run build` writes the frontend bundle AND the esbuild server bundle
     * into the same `dist/` folder. Serving the latter would hand the entire
     * backend implementation to anyone who can reach the app, and
     * `server.cjs.map` even embeds the original TypeScript sources
     * (`sourcesContent`). The game database is baked into server.cjs; its
     * JSON files (and those an older build left in dist/) are refused as well.
     */
    const isBackendArtifact = (requestPath: string): boolean => {
      // `req.path` is still percent-encoded while `send` decodes it before
      // touching the disk, so BOTH forms must be checked: "/server%2Ecjs"
      // otherwise slips past the guard and serves the whole backend bundle.
      let decoded = requestPath;
      try {
        decoded = decodeURIComponent(requestPath);
      } catch {
        // Malformed percent-encoding - keep the raw path.
      }
      return [requestPath, decoded].some((candidate) => {
        const withoutQuery = candidate.split('?')[0].split('#')[0];
        if (withoutQuery.startsWith('/.')) return true; // dotfiles
        if (/(?:^|\/)(?:gameDatabase|featuredGames|redditCache|discordIconCatalog)\.json$/i.test(withoutQuery)) return true;
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
      app.use(express.static(distPath, { dotfiles: 'deny' }));
    }
    // Express 5 path syntax: a bare '*' is no longer valid; '/{*splat}' also matches '/'.
    app.get('/{*splat}', (_req, res) => {
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath, { dotfiles: 'deny' }, (err) => {
          if (err && !res.headersSent) {
            res.status(404).send('Not Found');
          }
        });
      } else {
        res.status(404).send('Application build not found');
      }
    });
  }

  // Error handling middleware to catch any stream or route errors
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && (err.status === 404 || err.statusCode === 404)) {
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
    console.log(
      `Server running at http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${PORT}`
    );
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
