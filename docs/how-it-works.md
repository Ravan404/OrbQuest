# How it works

## Files on disk

The desktop app keeps everything in `%LOCALAPPDATA%\OrbQuest`. Each library entry is a folder under `Games/`:

| File | What it is |
|---|---|
| `<name>.exe` | Placeholder copied in by the app (in the subfolder Discord expects, e.g. `win64\valorant-win64-shipping.exe`), or an executable you placed there |
| `.game-name.txt` | Display name |
| `.game-meta.json` | Where the entry came from (`custom`, `catalog` or `scanned`), its executable path, its Discord application id and when it was added |
| `.game-icon.ico` | The game's icon for the placeholder window |
| `Games/.state.json` | Elapsed time and timer settings |
| `Games/.settings.json` | App settings: sound on/off, theme (`system`, `light` or `dark`) |
| `Games/.game-database.json` | The last downloaded game database, when it is newer than the one in the build |
| `Games/.special-games.json` | Steam quests, which live in the Steam library instead of `Games/` |
| `icon-cache/` | Saved game icons, next to `Games/` |

If two folder names would become the same id (`Foo Bar` and `Foo-Bar`), the second id is stored in `.game-meta.json` so both stay in the library.

A Steam quest is written to `steamapps\common\<game>` of the Steam installation with a small `appmanifest_<id>.acf`, as the r/DiscordQuests post describes. A real install or manifest of the game is never overwritten, and removing the entry deletes only what the app wrote.

## The game database

`src/server/gameDatabase.json` is Discord's list of detectable games (`discord.com/api/v9/applications/detectable`) in compact form: every game with a Windows executable, the executables with the folder part Discord matches, its other names and its icon id.

Discord also lists quest programs without any executable (Firefox, the Comet browser) and adds new quest games to its list late. For those the database takes the executable from r/DiscordQuests posts, marked `"source": "reddit"` and shown with an r/DiscordQuests label in the catalog. Such an entry is only used while Discord's list knows neither its executable nor the game; once Discord adds it, Discord's entry takes over. It keeps Discord's id and icon when Discord knows the program by name; a program Discord has no icon for (Firefox, Opera GX) gets its website in `"site"`, and the app shows that site's icon. A quest the post sets up through Steam keeps Steam's app id and folder in `"steam"`.

`src/server/featuredGames.json` names the games shown on the catalog page before anything is searched: the ones that have had Discord quests, plus every r/DiscordQuests entry.

Typing in the catalog searches this list in memory: exact names first, then names that start with or contain the text, then executable names. Nothing is sent over the network for a search.

The [Game database workflow](../.github/workflows/database.yml) reads Discord's list and the r/DiscordQuests posts newer than the snapshots in `data/reddit/` (through the Arctic Shift archive when Reddit refuses) every six hours, checks that the list did not suddenly lose many games, runs the tests and publishes `gameDatabase.json` and the snapshots on the [`database` branch](https://github.com/Ravan404/OrbQuest/tree/database) when something changed. That branch holds a single commit that each update replaces; releases are built with its database.

The app itself never asks Reddit. Every install downloads that file every six hours, from `raw.githubusercontent.com` or, if that fails, jsDelivr, with an ETag so an unchanged file is not sent again. A downloaded database that is newer than the one in the build replaces it and is kept in `Games/.game-database.json`, so it works offline too. Only when the file cannot be downloaded for a day does the app read Discord's list itself.

```bash
npm run update-database              # rebuild gameDatabase.json from Discord's list and r/DiscordQuests
npm run update-database -- --dry-run # show what would change, write nothing
```

A post the extractor reads wrongly gets a fix in `src/server/reddit/corrections.ts`. Anything still missing can be added by hand with Add game.

## Updates

The server asks GitHub for the latest release at its start and every six hours. When you click Install and restart, it downloads the release file for your copy (the installer, or the portable exe) and checks it against the release's `SHA256SUMS.txt`. The desktop app checks the file again, closes, and starts it. The installer runs silently and opens OrbQuest again; a new portable exe deletes the old one.

## Security

- Binds to `127.0.0.1` unless `ORBQUEST_BIND_HOST` says otherwise.
- In the desktop app only its own window can use the API: the window opens with a token that is new on every start and keeps it as an HttpOnly cookie. Another program on the PC cannot start or remove games through it.
- Rejects a `Host` header that is not loopback, unless `ORBQUEST_ALLOWED_HOSTS` allows it. That blocks a page from calling this API by pointing its own hostname at `127.0.0.1`.
- Production builds send a Content-Security-Policy. The dev server does not, so the Vite client can connect.
- `dist/server.cjs`, its sourcemap and the database JSON files are not served as static files.
- File writes stay inside `Games/` and `icon-cache/`, for a Steam quest inside that game's folder and manifest in Steam's `steamapps`, and a start script only as `<Game> - OrbQuest.<bat|ps1|py>` in Downloads. An executable path from a request or from Discord's list must stay inside its game folder (no `..`, drive letters or absolute paths).
- Images are only loaded from the app itself and `cdn.discordapp.com`. A website icon is downloaded by the server and served from `icon-cache/`, and only real PNG, JPEG, WebP, GIF or ICO files are saved.
- An update is only downloaded from this repository's releases, must match the SHA-256 in the release's `SHA256SUMS.txt`, and is checked again by the desktop app before it runs.

To report a problem, see [SECURITY.md](../SECURITY.md).
