# Configuration

OrbQuest works without any settings. These are for running it your own way. Settings are environment variables; the app does not read a `.env` file. In PowerShell: `$env:PORT = 4000; npm run dev`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ORBQUEST_BIND_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only if you mean to share it on the LAN |
| `ORBQUEST_ALLOWED_HOSTS` | loopback names | Extra `Host` values, comma separated. `*.example.com` is allowed. A single `*` turns the check off |
| `ORBQUEST_RATE_LIMIT_MAX` | `100` | Catalog requests per IP per minute |
| `ORBQUEST_ROOT` | working directory | Where `Games/` and `icon-cache/` are written. The desktop app uses `%LOCALAPPDATA%\OrbQuest` |
| `ORBQUEST_GAMES_DIR` | `<ORBQUEST_ROOT>/Games` | The library folder itself |
| `ORBQUEST_ASSET_ROOT` | `ORBQUEST_ROOT` | Read-only files: `dist/` and `placeholder/` |
| `ORBQUEST_DATABASE_REFRESH` | unset | Background database update. Unset means every six hours. `1` forces one at the start. `0` never |
| `ORBQUEST_DATABASE_URL` | `src/server/gameDatabase.json` on this repository's `database` branch | Where the published game database is downloaded from. Point it at your fork's copy |
| `ORBQUEST_STEAMAPPS` | Steam's own `steamapps` | The Steam library Steam quests are written to |
| `ORBQUEST_DOWNLOADS_DIR` | Windows' Downloads folder | Where start scripts are saved |
| `ORBQUEST_UPDATE_CHECK` | unset | `0`: never ask GitHub for a new release |
| `ORBQUEST_OFFLINE` | unset | `1`: no network requests at all. The bundled database and saved icons still work. The hosts are listed in the [privacy policy](../PRIVACY.md) |
| `ORBQUEST_DEBUG` | unset | Any value: log failed icon downloads |
| `ORBQUEST_NODE_EXE` | `node.exe` on `PATH` | Build only: the Node.js runtime `scripts\build-windows.bat` packs into the app |
