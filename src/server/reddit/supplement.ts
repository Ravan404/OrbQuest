/**
 * Quest programs Discord's list has no executable for: browsers and other
 * apps Discord lists without executables (Firefox, Comet), and new quest
 * games Discord has not added yet. Their executables come from
 * r/DiscordQuests posts (dataset.ts). An entry is only used while Discord's
 * list knows neither its executable nor the game: once Discord adds a game,
 * Discord's own entry takes over.
 *
 * Some quests are only detected through Steam (EA SPORTS FC 27, Marathon):
 * the post has Steam's app id and folder, and the entry keeps them so the app
 * writes the manifest and the placeholder into the Steam library.
 */

import { normalizeGameKey } from '../gameKey.ts';
import {
  executableFileName,
  normalizeExecutablePath,
  safeInstallDir,
  type DatabaseGame,
  type SteamQuest,
} from '../gameDatabaseSource.ts';
import type { RedditCacheEntry } from './dataset.ts';
import { extractInstallDir } from './extract.ts';

/**
 * Websites of programs Discord has no icon for, keyed by normalized name.
 * The app shows the site's icon instead of the program's initials.
 */
const PROGRAM_SITES: Record<string, string> = {
  firefox: 'firefox.com',
  operagx: 'operagx.gg',
};

/**
 * The Steam folder and the executable inside it of a Steam-manifest quest:
 * `steamapps\common\EA SPORTS FC 27` + `fc27.exe`, or with subfolders
 * `...\Toxic Commando Demo\client_pc\root\bin\pc` + `toxic commando.exe`.
 */
function steamQuestOf(entry: RedditCacheEntry): { steam: SteamQuest; executable: string } | undefined {
  if (entry.questMethod !== 'steam-manifest' || !entry.steamAppId) return undefined;
  const fromManifest = /"installdir"\s+"([^"]+)"/i.exec(entry.manifestContent || '')?.[1];
  const installDir = safeInstallDir(fromManifest ?? extractInstallDir(entry.folderPath));
  if (!installDir) return undefined;
  const segments = entry.folderPath.split(/[\\/]+/).map((segment) => segment.trim()).filter(Boolean);
  const at = segments.findIndex((segment) => segment.toLowerCase() === installDir.toLowerCase());
  const inside = at >= 0 ? segments.slice(at + 1) : [];
  const executable = normalizeExecutablePath([...inside, executableFileName(entry.executableName)].join('/'));
  return executable ? { steam: { appId: entry.steamAppId, installDir }, executable } : undefined;
}

interface DiscordApp {
  id?: unknown;
  name?: unknown;
  aliases?: unknown;
  icon_hash?: unknown;
}

/** Id of a supplement entry Discord has no application for. */
function redditId(key: string): string {
  return `r-${key.slice(0, 60)}`;
}

export function buildRedditSupplement(
  entries: readonly RedditCacheEntry[],
  discordList: readonly unknown[],
  discordGames: readonly DatabaseGame[]
): DatabaseGame[] {
  const knownFiles = new Set(discordGames.flatMap((game) => game.executables.map(executableFileName)));
  const knownNames = new Set(
    discordGames.flatMap((game) => [game.name, ...(game.aliases ?? [])].map((name) => normalizeGameKey(name)))
  );

  // Applications Discord knows by name but lists without executables.
  const nameless = new Map<string, { id: string; icon?: string }>();
  for (const raw of discordList) {
    const app = (raw ?? {}) as DiscordApp;
    if (typeof app.id !== 'string' || typeof app.name !== 'string') continue;
    const names = [app.name, ...(Array.isArray(app.aliases) ? app.aliases : [])].filter((n): n is string => typeof n === 'string');
    const icon = typeof app.icon_hash === 'string' && /^[a-f0-9]{32}$/.test(app.icon_hash) ? app.icon_hash : undefined;
    for (const name of names) {
      const key = normalizeGameKey(name);
      if (key && !knownNames.has(key) && !nameless.has(key)) nameless.set(key, { id: app.id, ...(icon ? { icon } : {}) });
    }
  }

  // "Comet AI Browser" on Reddit is "Comet" in Discord's list.
  const discordAppFor = (key: string) =>
    nameless.get(key) ??
    [...nameless.entries()]
      .filter(([name]) => name.length >= 5 && key.startsWith(name))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];

  const byName = new Map<string, DatabaseGame>();
  for (const entry of entries) {
    const steamQuest = steamQuestOf(entry);
    const executable = steamQuest?.executable ?? normalizeExecutablePath(executableFileName(entry.executableName));
    const key = normalizeGameKey(entry.gameName);
    if (!executable || !key || knownFiles.has(executableFileName(executable)) || knownNames.has(key)) continue;
    // A post the extractor misread names the file instead of the game.
    if (/\.exe$/i.test(entry.gameName.trim())) continue;
    const existing = byName.get(key);
    if (existing) {
      // A Steam quest keeps the one executable its Steam folder holds; a post
      // with the Steam setup wins over one without it.
      if (steamQuest && !existing.steam) {
        existing.steam = steamQuest.steam;
        existing.executables = [executable];
      } else if (!existing.steam && !steamQuest && !existing.executables.includes(executable)) {
        existing.executables.push(executable);
      }
      continue;
    }
    const discord = discordAppFor(key);
    const site = discord?.icon ? undefined : PROGRAM_SITES[key];
    byName.set(key, {
      id: discord?.id ?? redditId(key),
      name: entry.gameName,
      executables: [executable],
      ...(discord?.icon ? { icon: discord.icon } : {}),
      source: 'reddit',
      ...(entry.url ? { url: entry.url } : {}),
      ...(steamQuest ? { steam: steamQuest.steam } : {}),
      ...(site ? { site } : {}),
    });
  }
  return [...byName.values()];
}
