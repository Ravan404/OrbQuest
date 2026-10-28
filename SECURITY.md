# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use **Report a vulnerability** on the repository's Security tab (GitHub private vulnerability reporting). Say what you found, how to reproduce it and which version you used. You will get an answer within a week.

## What counts

OrbQuest runs a local HTTP server and starts programs on your PC, so these matter most:

- a web page or another machine reaching the local API (it should accept loopback only);
- writing or deleting files outside the `Games` folder, or deleting a real Steam install;
- starting a program other than the placeholder or the executable you chose;
- anything that reads a Discord token or talks to Discord's servers. The app must never do this.

## What it does not do

It never logs in to Discord, never reads your token and never changes the Discord client. It sends no data about you; these are the only hosts it asks for anything:

| Purpose | Hosts |
|---|---|
| Quest database updates | `raw.githubusercontent.com/Ravan404/OrbQuest`, `cdn.jsdelivr.net/gh/Ravan404/OrbQuest` (the published database). Only if both fail for a day: `www.reddit.com`, `arctic-shift.photon-reddit.com` |
| Search Reddit (only when you press it, or the database has nothing for a game) | `www.reddit.com`, `arctic-shift.photon-reddit.com` (an r/DiscordQuests archive, used when Reddit refuses) |
| Discord's public list of detectable games (names, executables, icon ids) | `discord.com`; if that fails, the copies at `raw.githubusercontent.com/RlxChap2/api.discord.com` and `markterence.github.io/discord-quest-completer` |
| Game icons | `cdn.discordapp.com`, `api.steamcmd.net`, `store.steampowered.com`, `steamcommunity.com`, `cdn.cloudflare.steamstatic.com`, `www.steamgriddb.com`, `lutris.net`, `pcgamingwiki.com` |

`DQR_OFFLINE=1` turns all of them off; the bundled database and icons keep working.
