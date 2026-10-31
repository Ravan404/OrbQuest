# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use **Report a vulnerability** on the repository's Security tab (GitHub private vulnerability reporting). Say what you found, how to reproduce it and which version you used. You will get an answer within a week.

## What counts

OrbQuest runs a local HTTP server and starts programs on your PC, so these matter most:

- a web page or another machine reaching the local API (it should accept loopback only);
- writing or deleting files outside the `Games` folder, or deleting a real Steam install;
- starting a program other than the placeholder or the executable you chose;
- anything that reads a Discord token, logs in to Discord or sends anything about you. The app must never do this; it only downloads public data.

## What it does not do

It never logs in to Discord, never reads your token and never changes the Discord client. It sends no data about you; these are the only hosts it asks for anything:

| Purpose | Hosts |
|---|---|
| Game database updates (every six hours) | `raw.githubusercontent.com/Ravan404/OrbQuest`, `cdn.jsdelivr.net/gh/Ravan404/OrbQuest` (the published database). Only if both fail for a day: `discord.com` (Discord's public list of detectable games) |
| Game icons | `cdn.discordapp.com` |

`DQR_OFFLINE=1` turns all of them off; the bundled database and saved icons keep working.
