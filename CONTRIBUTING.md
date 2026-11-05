# Contributing

Thanks for wanting to help. Bug reports, catalog suggestions and pull requests are all welcome. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 22.12 or newer. The desktop package and the placeholder are Windows-only; the server, the window and the tests also run on Linux and macOS.

```bash
npm ci
npm run dev        # http://127.0.0.1:3000
```

## Before you open a pull request

```bash
npm run typecheck
npm run lint        # npm run format fixes the format
npm test
npm run build
npm run verify:dist
npm run test:e2e    # Windows: clicks through the built app
```

CI runs them on Windows and Ubuntu, builds both Windows packages and installs, starts and uninstalls them (`scripts/smoke-test-package.ps1`).

- Keep a change to one topic, and add a test in `tests/` when you fix a bug.
- Every text the window shows lives in `src/strings.ts`.
- Add a line under `[Unreleased]` in `CHANGELOG.md` for anything a user would notice.
- Do not commit `dist/`, `Games/` or downloaded icons in `icon-cache/`.

## The game database

`src/server/gameDatabase.json` comes from Discord's list of detectable games, plus r/DiscordQuests for programs Discord publishes no executable for. The Game database workflow rebuilds it every six hours and publishes it on the `database` branch, so the copy on `main` is only the starting point; do not edit it by hand. `npm run update-database` does the same locally.

An r/DiscordQuests entry with the wrong name or executable: add a fix for its post in `src/server/reddit/corrections.ts`. In a fork, set `ORBQUEST_REDDIT_USER_AGENT` so the update identifies your project to Reddit. A game Discord lists with the wrong executable cannot be fixed here; it can still be added by hand with Add game.

The games shown on the catalog page before a search are the Discord application ids in `src/server/featuredGames.json`. A game that gets a Discord quest belongs there.

The executable chosen by default when Discord lists several is decided by `src/utils/executables.ts`.

## The placeholder executable

`placeholder/placeholder_runtime.exe` is committed so a fresh clone works without a C compiler. Its build is reproducible with the pinned toolchain, WinLibs GCC 16.2.0 UCRT r3: CI rebuilds it and fails when it differs from the committed file, so the binary always matches the source. `scripts\build-placeholder.bat --check` does the same locally.

If you change `placeholder/placeholder_runtime.c`, rebuild it with `scripts\build-placeholder.bat` and add the old file's SHA-256 (the script prints it) to `LEGACY_SHA256_HASHES` in `src/server/placeholderUpgrade.ts`: OrbQuest recognises its placeholders by their SHA-256, and copies in users' `Games` folders are then upgraded.

## Releases

1. `npm run bump-version -- 1.7.0`. It writes the version everywhere and turns the `[Unreleased]` heading of `CHANGELOG.md` into `[1.7.0]`.
2. Commit and push, then `git tag v1.7.0` and `git push origin v1.7.0`.
3. The Release workflow builds `OrbQuest-Setup-1.7.0.exe` and the portable `OrbQuest-1.7.0.exe` on Windows, with the newest database from the `database` branch, installs and starts them, and attaches them with `SHA256SUMS.txt` to a draft release, with its notes from `CHANGELOG.md`. Check it and publish: installed copies then offer the update.
