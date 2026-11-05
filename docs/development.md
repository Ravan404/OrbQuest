# Development

## Run from source

Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

The server listens on `http://127.0.0.1:3000`. The server, the window and the tests also run on Linux and macOS; the desktop packages and the placeholder are Windows-only.

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript check |
| `npm run lint` | Biome lint and format check (`npm run format` fixes the format) |
| `npm test` | Unit and API tests (`tests/`), offline, in a temporary folder |
| `npm run test:e2e` | Browser test of the built app in Edge or Chrome (Windows; run `npm run build` first) |
| `npm run build` | Frontend plus `dist/server.cjs` |
| `npm start` | Run the production server |
| `npm run verify:dist` | Boot the built server and check the offline database |
| `npm run update-database` | Rebuild `src/server/gameDatabase.json` from Discord's list and r/DiscordQuests (`-- --dry-run` only shows the changes) |
| `npm run bump-version -- <version>` | Write a new version everywhere and start its changelog section |
| `npm run clean` | Delete `dist/` and Vite's cache |

## Windows packages

Needs Windows, Python 3.13 and [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```bat
scripts\build-windows.bat
powershell -ExecutionPolicy Bypass -File scripts\smoke-test-package.ps1
```

The first writes `release\OrbQuest-Setup-<version>.exe`, `release\OrbQuest-<version>.exe` and `release\SHA256SUMS.txt`. The second installs, starts and uninstalls them.

If the app does not start, look at `%LOCALAPPDATA%\OrbQuest\startup.log`. The server's messages go to `backend.log` in the same folder, and the previous run is kept as `backend.log.1`. The window needs the Microsoft Edge WebView2 runtime, which Windows 10 and 11 normally have; on a PC without it, put a Fixed Version runtime in a `WebView2Runtime` folder next to the exe.

## The placeholder

`placeholder/placeholder_runtime.exe` is committed so a fresh clone works without a C compiler. Its build is reproducible: CI rebuilds it from `placeholder/placeholder_runtime.c` with a pinned toolchain and fails if the result differs from the committed file by a single byte. See [CONTRIBUTING.md](../CONTRIBUTING.md#the-placeholder-executable).

## Layout

```
server.ts                  Express app
src/App.tsx                UI state and actions
src/views/                 Library, Catalog, About
src/components/            Cards, bars, timer menu, shared controls (ui.tsx)
src/dialogs/               Add/edit game, start script, update
src/hooks/, src/utils/     Polling, timer maths, start scripts, executable choice
src/strings.ts             Every text the window shows
src/index.css              Light and dark theme colours
src/server/                Game database, catalog, icons, Steam quests, session, updates
src/server/library/        The library: scan, saved timers, placeholder processes
src/server/routes/         The HTTP API
src/server/gameDatabase.json  Discord's list of detectable games (compact)
src/server/featuredGames.json Games shown before a search
src/server/reddit/         Reads r/DiscordQuests for the database update (not part of the app)
data/reddit/               r/DiscordQuests post snapshots
tests/                     node:test suites (npm test); tests/e2e/ is the browser test
scripts/                   Test runner, database update, Windows build, release checks
desktop/                   Windows window (pywebview), PyInstaller recipe, Inno Setup script
placeholder/               Placeholder process: Win32 source and committed exe, Python fallback for Linux and macOS
assets/                    App icon: icon.svg (source) and OrbQuest.ico (exe and window)
public/                    favicon.svg, copied into dist/ by the build
docs/                      This documentation and the README's images
```
