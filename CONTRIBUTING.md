# Contributing

Thanks for wanting to help. Bug reports, catalog suggestions and pull requests are all welcome.

## Set up

You need Node.js 22.12 or newer. The desktop package and the placeholder are Windows-only; the server, the window and the tests also run on Linux and macOS.

```bash
npm ci
npm run dev        # http://127.0.0.1:3000
```

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
npm run verify:dist
```

CI runs the same four commands on Windows and Ubuntu.

- Keep a change to one topic, and add a test in `tests/` when you fix a bug.
- Every text the window shows lives in `src/strings.ts`.
- Add a line under `[Unreleased]` in `CHANGELOG.md` for anything a user would notice.
- Do not commit `dist/`, `Games/` or downloaded icons in `icon-cache/`.

## The game database

`src/server/gameDatabase.json` comes from Discord's list of detectable games and is rebuilt by the Game database workflow every six hours; do not edit it by hand. `npm run update-database` does the same locally.

A game is missing or has the wrong executable: that is Discord's list, so it cannot be fixed here. The game can still be added by hand with Add game.

The games shown on the catalog page before a search are the Discord application ids in `src/server/featuredGames.json`. A game that gets a Discord quest belongs there.

The executable chosen by default when Discord lists several is decided by `src/utils/executables.ts`.

## The placeholder executable

`placeholder_runtime.exe` is committed so a fresh clone works without a C compiler. If you change `placeholder_runtime.c`, rebuild it with `scripts\build-placeholder.bat` (MinGW-w64) and add the old file's SHA-256 to `LEGACY_SHA256_HASHES` in `src/server/placeholderUpgrade.ts`, so copies in users' `Games` folders are upgraded.

## Releases

1. `npm run bump-version -- 1.3.1`. It writes the version everywhere and turns the `[Unreleased]` heading of `CHANGELOG.md` into `[1.3.1]`.
2. Commit and push, then `git tag v1.3.1` and `git push origin v1.3.1`.
3. The Release workflow builds `OrbQuest.exe` on Windows and attaches it with its SHA-256 to a draft release. Check it and publish.
