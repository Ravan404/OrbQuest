/**
 * scripts/download-game-icons.ts
 *
 *   npm run icons:download            fetch icons for games that have none yet
 *   npm run icons:download -- --force refetch every game
 *
 * Writes `public/game-icons/<key>.<ext>` for every game of the local quest
 * database. `npm run build` copies the folder into `dist/`, so the Windows
 * package ships the icons and the app never has to download them while it
 * runs. Commit the folder after running this script.
 *
 * Sources: the multi-tier pipeline in `src/server/logo.ts`:
 *   1. Discord Detectable Applications CDN (`cdn.discordapp.com/app-icons/...`)
 *   2. Steam Official Square Icon (`api.steamcmd.net` + `storesearch`)
 *   3. SteamGridDB Public API
 *   4. Lutris Open Game Database API
 *   5. PCGamingWiki MediaWiki API
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshDiscordDetectableCatalog } from '../src/server/discordDetectable.ts';
import { findRemoteIconUrl } from '../src/server/logo.ts';
import { listQuestDbRecords, recordExecutables } from '../src/server/questLookup.ts';
import { loadRedditCache } from '../src/server/redditCacheStore.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'game-icons');
const force = process.argv.includes('--force');
const MAX_BYTES = 512 * 1024;
const UA = 'OrbQuest/1.0 (game icon download)';

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
};

function existingIcon(key: string): string | undefined {
  return fs.readdirSync(outDir).find((file) => file.startsWith(`${key}.`) && !file.endsWith('.json'));
}

async function download(url: string): Promise<{ bytes: Buffer; ext: string } | undefined> {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/png,image/webp,image/jpeg,image/*;q=0.8' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXTENSIONS[type];
  if (!ext) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 64 || bytes.length > MAX_BYTES) return undefined;
  return { bytes, ext };
}

async function main(): Promise<void> {
  loadRedditCache();
  await refreshDiscordDetectableCatalog(false).catch(() => false);

  fs.mkdirSync(outDir, { recursive: true });
  const records = listQuestDbRecords();
  const found: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  let networkErrors = 0;

  for (const record of records) {
    const current = existingIcon(record.key);
    if (current && !force) {
      skipped.push(record.name);
      continue;
    }

    let saved = false;
    const executable = recordExecutables(record)[0];
    const steamAppId =
      record.verified?.steamAppId ??
      record.entries.find((e) => e.steamAppId && e.steamAppId > 0)?.steamAppId;

    for (const name of [record.name, ...record.aliases.slice(0, 2)]) {
      try {
        const url = await findRemoteIconUrl(name, executable, steamAppId);
        if (!url) continue;
        const image = await download(url);
        if (!image) continue;
        if (current) fs.unlinkSync(path.join(outDir, current));
        fs.writeFileSync(path.join(outDir, `${record.key}.${image.ext}`), image.bytes);
        saved = true;
        break;
      } catch (error) {
        networkErrors++;
        console.warn(`  ${name}: ${(error as Error).message}`);
      }
    }

    if (saved) {
      found.push(record.name);
      console.log(`  ok    ${record.name}`);
    } else {
      missing.push(record.name);
      console.log(`  none  ${record.name}`);
    }
  }

  console.log(
    `\nIcons: ${found.length} downloaded, ${skipped.length} already present, ${missing.length} without an icon, ${networkErrors} request errors.`
  );
  if (networkErrors > 0 && found.length === 0) {
    console.log('No icon could be downloaded. Check your network connection and run the command again.');
  }
  if (missing.length > 0) {
    console.log('Games without an icon keep the gradient badge. Add a file named <key>.png by hand if you have one.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
