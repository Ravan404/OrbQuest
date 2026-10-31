# Changelog

## [Unreleased]

### Changed

- **The catalog is Discord's own list of detectable games** (`discord.com/api/v9/applications/detectable`) instead of executables read from r/DiscordQuests posts. r/DiscordQuests now only fills in the quest programs Discord publishes no executable for: apps such as Firefox, Opera GX and the Comet browser, and quest games Discord has not added yet (AION 2, Forza Horizon 6, Marathon and others). Those show an r/DiscordQuests label and keep Discord's id and icon where Discord knows them. It has every game Discord can detect with a Windows executable (about 10,400), and the placeholder is written to the path Discord matches, including its folder: `Games\VALORANT\win64\valorant-win64-shipping.exe`. Before, a placeholder such as `Games\VALORANT\VALORANT-Win64-Shipping.exe` could miss Discord's folder rule.
- The catalog page shows the games that have had Discord quests; searching finds any game in Discord's list, by name, other name or executable. When Discord lists several executables, the game's own is preselected and the others are in a list.
- The Game database workflow rebuilds `src/server/gameDatabase.json` from Discord and r/DiscordQuests every six hours; the app downloads it as before and never asks Reddit itself. It reads Discord's list itself only when the published file has been unreachable for a day.
- Icons come only from Discord's CDN and are saved for offline use. The Content-Security-Policy now allows images only from the app and `cdn.discordapp.com`.
- `DQR_DATABASE_REFRESH` replaces `DQR_REDDIT_CACHE_REFRESH` (the old name still works).

### Removed

- Search Reddit and every Reddit request from the app, `npm run build-reddit-cache` and `npm run icons:download`.
- Icon lookups on Steam, SteamGridDB, Lutris and PCGamingWiki, and the bundled icon files.
- Adding Steam-manifest installs from the catalog. Installs made by earlier versions are still listed and can be removed safely.
- Games Discord only recognises with command-line arguments (Team Fortress 2, Half-Life 2) are not in the catalog, because a placeholder is started without arguments.


## [1.3.0] — 2026-10-28

### Changed

- The r/DiscordQuests snapshots moved from the repository root to `data/reddit/`.
- **Renamed to OrbQuest.** The exe is `OrbQuest.exe`, logs go to `%LOCALAPPDATA%\OrbQuest`, and the settings variables are `DQR_ROOT` and `DQR_ASSET_ROOT` (`DISCORD_QUEST_ROOT` and `DISCORD_QUEST_ASSET_ROOT` still work). Library folders, saved timers and Steam installs from DiscordQuestRun keep working; placeholders are upgraded on the next scan.
- The window was rewritten. Games are cards with a large icon and a Launch button; the timer stays small at the bottom of each card. Every screen uses the same buttons, fields and dialogs.
- Light and dark themes in black and white. The app follows the Windows setting until you pick one with the theme button; the choice is saved in `Games/.settings.json`. The desktop window opens in the matching colour.
- The About page was rewritten in plainer words.
- The placeholder window matches the app: black and white, light or dark with the app's theme (or Windows when the app follows the system), with a dark title bar in dark mode. It shows the elapsed time large, the target next to it, the phase (Starting, Running, Finishing, Done) and a thin progress line. The server passes the theme as `DQR_THEME`.
- The placeholder window and its taskbar button show the game's icon. Before a launch the app writes the icon next to the placeholder as `.game-icon.ico`; the placeholder executable itself is unchanged.
- All window text lives in `src/strings.ts`. The lookup screen, the dialogs and the script dialog no longer have their own hard-coded English.
- "Search Online" is now called "Search Reddit", which is what it does.
- `lucide-react` 1.61 and `tsx` 4.23.15 (updates inside the existing version ranges; `npm audit` reports no vulnerabilities).
- Node.js 22.12 or newer is required (Node 20 is end-of-life; Vite 8 needs 20.19+ or 22.12+).
- Reddit requests identify the app by its project page instead of a personal account. `DQR_REDDIT_USER_AGENT` overrides it.
- `build_windows_exe.bat` installs with `npm ci` and pinned Python packages (`requirements-build.txt`).
- Major dependency upgrades: React 19, Vite 8 with `@vitejs/plugin-react` 6, Express 5, esbuild 0.28, TypeScript 7 and `@types/node` 24. Express 5 needed a new catch-all route path (`/{*splat}`) and typed `/:id` params; TypeScript 7 needed `types` in `tsconfig.json`.

### Added

- The quest database is updated centrally. A GitHub Actions workflow reads new r/DiscordQuests posts every six hours and commits the rebuilt database; the app downloads that one file (with an ETag) instead of asking Reddit itself, so Reddit's limits no longer depend on how many people use the app. A downloaded database is kept for offline use; Reddit is asked directly only when the file cannot be reached for a day. `DQR_DATABASE_URL` points a fork at its own copy.
- `theme` in `GET/PUT /api/settings`.
- Escape closes the add/edit and script dialogs.
- Unit test for the start scripts (`src/utils/startScripts.ts`).
- CI runs on Windows and Ubuntu with Node 22 and 24, and builds the placeholder from its C source.
- A Release workflow builds `DiscordQuestRun.exe` for a `v*` tag and attaches it with its SHA-256 to a draft GitHub release.
- `CONTRIBUTING.md`, `SECURITY.md`, issue and pull request templates, Dependabot.

### Fixed

- Several bundled icons showed the wrong picture: VALORANT was a cactus, Counter-Strike 2 showed Counter-Strike 2D, Delta Force and Destiny 2 were unrelated photos, Baldur's Gate 3 was a mod tool logo, and Dead by Daylight and Overwatch 2 were nearly invisible. They now use the icons from Discord's game list.
- Rescan did not notice a game folder deleted in Explorer; the entry stayed in the library and a launch recreated the folder. Rescan now removes it (a missing executable alone is still repaired).
- With Select on, a game removed with its own button stayed in the selection, so the bar showed the old count.
- `npm run clean` failed on Windows (`rm -rf`).
- Five earlier placeholder builds were not recognised as the app's own file, so their library folders were never upgraded, an executable change kept the old copy, and removing a Steam-manifest entry left its install behind.
- The start scripts (.bat, .ps1, .py) did not apply the timer: they set variables only the placeholder reads and always asked for the path of a dummy `C:\Path\To\Your\Game.exe`. They now ask for the game's .exe, start it, and close it when the card's timer is up (unless there is no limit or Stop at the end is off).
- README: the About page does show the database date; removing a Steam-manifest entry deletes the placeholder install the app wrote; icons are written to `icon-cache/`. All settings variables are listed.
- On narrow game cards the Launch button pushed the remove button out of the card.
- A card showed "00:00 / 15:00" and Reset when no time had been counted yet.
- `scripts/build-placeholder.bat` failed to link: `-Wl,--stack,0x100000,0x20000` split the stack size at the comma. It passes it with `-Xlinker` now.

### Removed

- `.env.example`: the app never read a `.env` file. The settings are listed in the README.
- The `lint` script (the same as `typecheck`) and unused functions in the server code.
- The unused language switch in the old `i18n.tsx`, unused strings, and the unused `ExecutableDiscovery` type and preset labels.

## [1.2.26] — 2026-10-26

### Fixed

- The desktop app could stop answering after a while. The backend wrote its warnings into a pipe nobody read; once the pipe was full the server blocked. Its output now goes to `%LOCALAPPDATA%\DiscordQuestRun\backend.log`.
- Timer settings and the sound switch were lost on every start of the desktop app (it picks a new port each time, and the browser storage belongs to one port). They are now saved by the server in `Games/.state.json` and `Games/.settings.json`. Settings an older version left in the browser are moved over once.
- Timer settings were also dropped from `Games/.state.json` after a reset or a finished quest. They are now kept.
- Editing a game checks every value before changing files. A rejected edit no longer leaves the folder renamed while the library points at the old one.
- Steam-manifest games could not be edited at all ("Game folder is missing"). Their name and timer can now be changed; the folder and executable stay as the manifest says.
- A renamed folder that was found by the scan lost its saved progress on the next start. The id is now stored in `.game-meta.json`.
- Changing the executable of an entry overwrote a real executable of that name in the folder. An existing file is now kept.
- Removing a Steam game without an app id could pick the first manifest of the Steam library. Only the manifest of the game's own app id is looked at now.
- Placeholder checks read and hashed every executable completely, a real game binary of several hundred MB included, on every scan and launch. Files larger than any placeholder are skipped and results are cached.
- Starting the app a second time did not bring the open window forward (it searched for a title without the version number).
- Editing a game with "No limit" silently changed it to 15 minutes. The edit dialog has a No limit option now, and its custom field accepts up to 1440 minutes like the rest of the app.
- Batch start scripts printed carets in names with brackets or `&` (`Baldur's Gate ^(3^)`).
- Bulk stop and remove report the entries that failed instead of removing them from the screen.
- State files are written atomically, so a crash during a save cannot leave a broken `.state.json`.

### Added

- `npm test`: unit and API tests in `tests/`, also run by CI.
- `DQR_OFFLINE=1` turns off every network request.
- `scripts/build-placeholder.bat` rebuilds `placeholder_runtime.exe` from its C source with MinGW-w64. `bump-version` and `verify:dist` now include `placeholder_runtime.rc`.
- `PUT /api/games/:id/timer` and `GET/PUT /api/settings`.

### Removed

- The unused `/api/quests` and `/api/discover` endpoints (the latter returned made-up paths and sizes).
- The unused folder-picker bridge in `desktop_app.py` and the unused "move to a Steam folder" branch of the edit endpoint.
- The deprecated `X-XSS-Protection` header and the sandbox host left in `vite.config.ts`.

### Security

- `body-parser` and `vite` updated (`npm audit` reports no vulnerabilities).

## [1.2.25] — 2026-10-16

### Added

- Game icons are stored locally. `npm run icons:download` fetches an icon for every game of the local quest database into `public/game-icons/` (commit the folder). The Windows package ships them, so they show without any network request.
- Icons for other games are saved once to `icon-cache/` after their first lookup and are used on every later start. Failed lookups are remembered for 24 hours.
- The idle catalog screen lists the whole local quest database with icons. It works offline.

### Changed

- While a game runs, only the timer button is greyed out. The Script button stays available.
- Database games are labelled "Database" in the catalog and in search results (the search tab was called "Saved"). They are listed first.
- The timer popover shows "Detection time" with the start and end seconds separately (for example `5s + 10s`). It used to show the total (15s) under the label "Extra time".
- In a library card, Launch and Stop have the same width. The Script and timer buttons stay visible while a game runs; they are greyed out.
- The About page was rewritten: what the app does and cannot prove, how the timer works, how games are added, which files are used, and what Remove deletes. A panel shows the database date and the Games folder.
- The brand block at the bottom of the sidebar was removed.

### Fixed

- Icons found by a lookup are stored under the database game they belong to, so they show in the catalog too.
- Database games without a bundled icon are looked up in the background after start (two at a time), and the result is kept on disk.
- Icons appeared late. Icons were downloaded from remote services on every start and before every search result. Icons on disk are now used immediately, and search no longer waits up to 1.2 s for them.
- Catalog results did not carry an icon. They do now for database games.

## [1.2.23] — 2026-10-15

### Fixed

- Adding or deleting a Steam-manifest quest no longer overwrites or deletes a real Steam install. A real manifest (extra fields such as `buildid` or `SizeOnDisk`) or a folder that is not this app's placeholder is left on disk. The library entry can still be removed.
- New Steam placeholder installs use the manifest `installdir`, a rebuilt manifest, and a `.dqr-managed.json` marker. The folder is not renamed to `Name (2)`.
- Two folders that collapse to the same id (`Foo Bar` and `Foo-Bar`) both stay in the library.
- A Windows path is split on `\` and `/`, so a generic tail such as `Win64` does not become the folder name.
- Launch returns an error if the process does not start within 15 seconds.
- Custom timers are limited to 1–1440 minutes.
- The library poll drops games the server no longer has and adds games it gained.
- Catalog entries cannot be edited. The Edit button is disabled for them.
- If the local server cannot be reached, the window shows the error and a Retry button.

## [1.2.22] — 2026-10-14

- Typing in the catalog no longer calls Reddit. Reddit runs after Enter or Search Online, and only when the local database has nothing for that game.
- Quest database updated from r/DiscordQuests through 2026-10-14 (89 entries, 85 games).
- Reddit requests are serialized, capped, and not retried after a rate limit.
- A game added from a live Reddit result is saved to the offline database.

## [1.2.21] — 2026-10-14

- Catalog and search show one card per game. The local database is listed first.
- Search Online adds live Reddit results under the database results instead of repeating them.
- Quest names are cleaned and mapped to a canonical spelling. Hand-checked post fixes live in `redditCorrections.ts`.
- The production bundle and the Windows package include the quest database. `npm run verify:dist` checks that the built server can answer from it.

## [1.2.20] — 2026-10-06

- The offline Reddit dataset is the first search source. Junk rows (no usable executable, sentence fragments, bad paths) are dropped when the cache is rebuilt.
- `GET /server.cjs` and the sourcemap are refused, including percent-encoded paths.
- Requests with a non-loopback `Host` header are rejected unless `DQR_ALLOWED_HOSTS` allows them.
- Production responses send a Content-Security-Policy.
- Scraped links are limited to `http` and `https`. Scanned post text is length-capped.

## [1.2.19] — 2026-10-05

- Local Reddit cache, loaded at startup and refreshed in the background.
- Search order: session cache, bundled cache, then live Reddit.

## [1.2.18] — 2026-10-05

- Reddit client reads rate-limit headers and backs off. Requests are spaced out.

## [1.2.17] — 2026-10-05

- Catalog matching ignores punctuation, accents, and edition marks. Prefix matches rank higher.

## [1.2.16] — 2026-10-05

- Catalog lists known games first. Reddit is searched after a game is selected.

## [1.2.15] — 2026-10-05

- Reddit query cache and in-flight deduplication. Stale catalog requests are cancelled while typing.

## [1.2.14] — 2026-10-05

- Executable search results come from Reddit posts only.

## [1.2.13] — 2026-10-05

- Catalog search talks to Reddit directly instead of searching every source and filtering afterward.

## [1.2.12] — 2026-10-05

- Catalog results limited to games with a community quest post. Empty library search can open the catalog.

## [1.2.11] — 2026-10-05

- Icon lookups share one in-flight SteamGridDB or Steam request. The icon cache drops unused entries.

## [1.2.10] — 2026-10-05

- SteamGridDB icons load even when the CDN does not send CORS headers.

## [1.2.9] — 2026-10-05

- Game icons prefer square SteamGridDB images, then Steam and PCGamingWiki.

## [1.2.8] — 2026-10-04

- Reddit posts with a simulated Steam manifest are kept as manifest quests.
- Steam manifest games find the installed Steam `steamapps` folder, including libraries listed in `libraryfolders.vdf`.
- Edit is a labeled button. Catalog and scanned entries can be edited. A later release locked catalog entries again because the server rejected those edits.

## [1.2.0] — 2026-10-03

- Simulated Steam manifest quests.
- Version shown in the window title, the build script, and the header.

## [1.1.1] — 2026-09-27

- Library entries can be renamed. Origin is stored in `.game-meta.json`.
- English-only UI.
- Completed quest counters reset on restart.

## [1.1.0] — 2026-09-27

- Backend split into modules. Loopback bind, rate limits, path checks.
- Quest progress saved to `Games/.state.json`.
- Removed the open `proxy-image` endpoint.

## [1.0.0]

- First release: library, placeholder process, quest timer, catalog, Reddit search, Windows shell.
