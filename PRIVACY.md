# Privacy

OrbQuest has no account, no analytics and no telemetry. It collects nothing about you and sends nothing about you to anyone. It never logs in to Discord and never reads your Discord token.

## What stays on your PC

Your library, timers and settings are in `%LOCALAPPDATA%\OrbQuest`, and logs are next to them. A Steam quest you add is written to Steam's own `steamapps` folder, and a start script you save goes to your Downloads folder. To find those two folders the app reads their location from the Windows registry. Uninstalling OrbQuest keeps `%LOCALAPPDATA%\OrbQuest`; delete that folder to remove your library too.

## What the app downloads

The app only downloads public files. These requests carry no personal data, but like any connection they show your IP address to the server, and they name OrbQuest and its version as the client.

| What | From | When |
|---|---|---|
| Game database | `raw.githubusercontent.com`, `cdn.jsdelivr.net`; `discord.com` only if both fail for a day | Every six hours |
| Game icons | `cdn.discordapp.com`; `www.google.com/s2/favicons` for the few programs Discord has no icon for | When a game is shown or added |
| New release check | `api.github.com`; `github.com` when that does not answer | At the start and every six hours |
| An update | `github.com` (the file itself comes from `objects.githubusercontent.com`) | Only when you click Install and restart |

Those services have their own privacy policies: [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement), [jsDelivr](https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net), [Discord](https://discord.com/privacy) and [Google](https://policies.google.com/privacy).

Setting the environment variable `ORBQUEST_OFFLINE=1` turns all of these requests off; the bundled database and saved icons keep working.
