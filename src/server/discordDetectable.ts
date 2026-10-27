/**
 * discordDetectable.ts
 *
 * Discord's Detectable Applications registry (`https://discord.com/api/v9/applications/detectable`)
 * is the authoritative source Discord's own desktop client uses to identify
 * running games, show Quest artwork, and map executables to application IDs.
 *
 * Every entry provides:
 *   - `id` & `iconHash`: served directly as a 1:1 square icon from Discord's CDN
 *     (`https://cdn.discordapp.com/app-icons/{id}/{iconHash}.png?size=128`)
 *   - `name` & `aliases`: official title and alternative spellings
 *   - `executables`: Windows process names (`win32`), allowing accurate icon
 *     resolution even when a game's title is abbreviated or spelled differently
 *   - `steamAppId`: cross-referenced Steam App ID from `third_party_skus`
 *
 * Architecture:
 *   1. A curated, compact snapshot (`discordIconCatalog.json`) is baked into
 *      the server bundle at build time, giving 0-ms offline resolution for
 *      the quest database, the general catalog, and modern detectable titles.
 *   2. At runtime, when a game is not found in the bundled snapshot, the
 *      live Discord detectable endpoint (with GitHub mirror fallbacks) is
 *      fetched once per 24 hours and cached in `icon-cache/discord-detectable.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import bundledCatalog from './discordIconCatalog.json';
import { normalizeGameKey, knownAliasesFor } from './gameNames.ts';
import { ICON_CACHE_DIR } from './iconStore.ts';
import { listQuestDbRecords, recordExecutables } from './questLookup.ts';

const debugLog = (...args: unknown[]): void => {
  if (process.env.DQR_DEBUG) console.debug(...args);
};

export interface DiscordAppEntry {
  id: string;
  name: string;
  aliases?: string[];
  iconHash: string;
  executables?: string[];
  steamAppId?: number;
}

interface RawDiscordExecutable {
  name?: string;
  os?: string;
  is_launcher?: boolean;
}

interface RawDiscordSku {
  distributor?: string;
  id?: string;
}

interface RawDiscordDetectableApp {
  id?: string;
  name?: string;
  aliases?: string[];
  icon_hash?: string | null;
  executables?: RawDiscordExecutable[];
  third_party_skus?: RawDiscordSku[];
}

const DISCORD_DETECTABLE_URLS = [
  'https://discord.com/api/v9/applications/detectable',
  'https://raw.githubusercontent.com/RlxChap2/api.discord.com/main/current.json',
  'https://markterence.github.io/discord-quest-completer/detectable.json',
];

const DISCORD_CDN_ICON_BASE = 'https://cdn.discordapp.com/app-icons';
const LIVE_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_FETCH_TIMEOUT_MS = 12_000;
const DISCORD_UA = 'OrbQuest/1.0 (game icon resolver)';

/** Generic wrapper executable names that are shared across many unrelated games. */
const GENERIC_EXECUTABLES = new Set([
  'game.exe',
  'launcher.exe',
  'play.exe',
  'start.exe',
  'main.exe',
  'client.exe',
  'shipping.exe',
  'unrealcefsubprocess.exe',
  'unitycrashhandler64.exe',
  'unitycrashhandler32.exe',
  'crashreportclient.exe',
  'setup.exe',
  'install.exe',
  'unins000.exe',
  'uninstall.exe',
  'updater.exe',
  'update.exe',
  'patcher.exe',
  'bootstrapper.exe',
  'crashhandler.exe',
  'cefprocess.exe',
]);

/** Roman numeral <-> Arabic numeral sequel conversions at the end of a title. */
const ROMAN_SUFFIX_PAIRS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biii\b/gi, '3'],
  [/\bii\b/gi, '2'],
  [/\biv\b/gi, '4'],
  [/\bvi\b/gi, '6'],
  [/\bv\b/gi, '5'],
  [/\b3\b/g, 'iii'],
  [/\b2\b/g, 'ii'],
  [/\b4\b/g, 'iv'],
  [/\b6\b/g, 'vi'],
];

/** Builds the official square Discord CDN icon URL for an application. */
export function discordAppIconUrl(appId: string, iconHash: string, size = 128): string {
  return `${DISCORD_CDN_ICON_BASE}/${encodeURIComponent(appId)}/${encodeURIComponent(iconHash)}.png?size=${size}`;
}

function cleanExecutableBaseName(raw: string | undefined): string {
  if (!raw) return '';
  const base = raw.replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase() ?? '';
  if (!base || !base.endsWith('.exe') || GENERIC_EXECUTABLES.has(base)) return '';
  return base;
}

/** Normalized key variants including Roman/Arabic numeral sequel equivalents. */
function normalizedKeyVariants(name: string): string[] {
  const base = normalizeGameKey(name);
  if (!base) return [];
  const out = new Set<string>([base]);
  for (const [pattern, replacement] of ROMAN_SUFFIX_PAIRS) {
    if (pattern.test(name)) {
      const variant = normalizeGameKey(name.replace(pattern, replacement));
      if (variant) out.add(variant);
    }
  }
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// In-memory index (seeded from bundled JSON, enriched by disk/live cache)
// ---------------------------------------------------------------------------

let catalogEntries: DiscordAppEntry[] = [];
let byExactKey = new Map<string, DiscordAppEntry[]>();
let byAliasKey = new Map<string, DiscordAppEntry[]>();
let byExecutable = new Map<string, DiscordAppEntry[]>();
let bySteamId = new Map<number, DiscordAppEntry>();
let initialized = false;
let lastLiveRefreshAttemptAt = 0;
let liveRefreshInflight: Promise<boolean> | null = null;

function pushToMapList(map: Map<string, DiscordAppEntry[]>, key: string, entry: DiscordAppEntry): void {
  if (!key) return;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = [];
    map.set(key, bucket);
  }
  if (!bucket.some((item) => item.id === entry.id)) {
    bucket.push(entry);
  }
}

function rebuildDiscordIndex(entries: readonly DiscordAppEntry[]): void {
  const mergedById = new Map<string, DiscordAppEntry>();
  for (const item of entries) {
    if (!item?.id || !item?.name || !item?.iconHash) continue;
    mergedById.set(item.id, item);
  }

  catalogEntries = Array.from(mergedById.values());
  byExactKey = new Map();
  byAliasKey = new Map();
  byExecutable = new Map();
  bySteamId = new Map();

  for (const entry of catalogEntries) {
    for (const key of normalizedKeyVariants(entry.name)) {
      pushToMapList(byExactKey, key, entry);
    }
    for (const alias of entry.aliases ?? []) {
      for (const key of normalizedKeyVariants(alias)) {
        pushToMapList(byAliasKey, key, entry);
      }
    }
    for (const exe of entry.executables ?? []) {
      const clean = cleanExecutableBaseName(exe);
      if (clean) pushToMapList(byExecutable, clean, entry);
    }
    if (entry.steamAppId && Number.isSafeInteger(entry.steamAppId) && !bySteamId.has(entry.steamAppId)) {
      bySteamId.set(entry.steamAppId, entry);
    }
  }
}

function runtimeCacheFilePath(): string {
  return path.join(ICON_CACHE_DIR, 'discord-detectable.json');
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  const base = Array.isArray(bundledCatalog) ? (bundledCatalog as DiscordAppEntry[]) : [];
  let combined: DiscordAppEntry[] = [...base];

  try {
    const cacheFile = runtimeCacheFilePath();
    if (fs.existsSync(cacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
        updatedAt?: number;
        entries?: DiscordAppEntry[];
      };
      if (Array.isArray(parsed?.entries) && parsed.entries.length > 0) {
        combined = [...base, ...parsed.entries];
      }
      if (typeof parsed?.updatedAt === 'number') {
        lastLiveRefreshAttemptAt = parsed.updatedAt;
      }
    }
  } catch (error) {
    debugLog('Could not read cached Discord detectable index:', error);
  }

  rebuildDiscordIndex(combined);
}

/**
 * Finds the best matching Discord application for a game name, executable, or
 * Steam App ID. Synchronous and zero-network (reads the in-memory index).
 */
export function findDiscordApplication(
  name: string,
  executable?: string,
  steamAppId?: number
): DiscordAppEntry | undefined {
  ensureInitialized();

  // 1. Direct Steam App ID hit
  if (steamAppId && Number.isSafeInteger(steamAppId)) {
    const bySteam = bySteamId.get(steamAppId);
    if (bySteam) return bySteam;
  }

  const primaryKeys = normalizedKeyVariants(name);
  const primaryKey = primaryKeys[0] ?? '';

  // Collect known aliases and executables from our local Quest DB if this game is in it
  const aliasKeySet = new Set<string>(primaryKeys.slice(1));
  const exeSet = new Set<string>();

  const cleanExe = cleanExecutableBaseName(executable);
  if (cleanExe) exeSet.add(cleanExe);

  for (const alias of knownAliasesFor(name)) {
    for (const k of normalizedKeyVariants(alias)) {
      if (k !== primaryKey) aliasKeySet.add(k);
    }
  }

  if (primaryKey) {
    const dbRecord = listQuestDbRecords().find(
      (rec) =>
        rec.key === primaryKey ||
        rec.aliasKeys.includes(primaryKey) ||
        (cleanExe ? recordExecutables(rec).some((e) => cleanExecutableBaseName(e) === cleanExe) : false)
    );
    if (dbRecord) {
      if (dbRecord.key !== primaryKey) aliasKeySet.add(dbRecord.key);
      for (const k of dbRecord.aliasKeys) {
        if (k !== primaryKey) aliasKeySet.add(k);
      }
      for (const e of recordExecutables(dbRecord)) {
        const ce = cleanExecutableBaseName(e);
        if (ce) exeSet.add(ce);
      }
      if (!steamAppId && dbRecord.verified?.steamAppId) {
        const byVerifiedSteam = bySteamId.get(dbRecord.verified.steamAppId);
        if (byVerifiedSteam) return byVerifiedSteam;
      }
    }
  }

  // Gather candidate Discord applications from all index maps
  const candidates = new Map<string, DiscordAppEntry>();
  for (const k of primaryKeys) {
    for (const app of byExactKey.get(k) ?? []) candidates.set(app.id, app);
    for (const app of byAliasKey.get(k) ?? []) candidates.set(app.id, app);
  }
  for (const exe of exeSet) {
    for (const app of byExecutable.get(exe) ?? []) candidates.set(app.id, app);
  }
  for (const k of aliasKeySet) {
    for (const app of byExactKey.get(k) ?? []) candidates.set(app.id, app);
    for (const app of byAliasKey.get(k) ?? []) candidates.set(app.id, app);
  }

  if (candidates.size === 0) return undefined;

  let bestEntry: DiscordAppEntry | undefined;
  let bestScore = -1;

  for (const candidate of candidates.values()) {
    const cNameKeys = normalizedKeyVariants(candidate.name);
    const cAliasKeys = (candidate.aliases ?? []).flatMap(normalizedKeyVariants);
    const cExes = (candidate.executables ?? []).map(cleanExecutableBaseName).filter(Boolean);

    const exactNameMatch = primaryKeys.some((k) => cNameKeys.includes(k));
    const exactDiscordAliasMatch = primaryKeys.some((k) => cAliasKeys.includes(k));
    const exeMatch =
      cExes.length > 0 &&
      Array.from(exeSet).some(
        (targetExe) =>
          cExes.includes(targetExe) ||
          normalizeGameKey(targetExe.replace(/\.exe$/i, '')) ===
            normalizeGameKey(cExes[0].replace(/\.exe$/i, ''))
      );
    const questAliasMatchesName = cNameKeys.some((k) => aliasKeySet.has(k));
    const questAliasMatchesAlias = cAliasKeys.some((k) => aliasKeySet.has(k));

    // Guard against short single-word collisions where executables conflict
    // (e.g. "GearUP" [gearup_ball.exe] vs 2014 game "Gear Up" [traktor.amalgam.app.exe])
    if (
      !exeMatch &&
      exeSet.size > 0 &&
      cExes.length > 0 &&
      candidate.name.trim().toLowerCase() !== name.trim().toLowerCase() &&
      primaryKey.length <= 7
    ) {
      continue;
    }

    let score = 0;
    if (exactNameMatch && exeMatch) score = 100;
    else if (exactNameMatch) score = 92;
    else if (exactDiscordAliasMatch && exeMatch) score = 88;
    else if (exactDiscordAliasMatch) score = 82;
    else if (exeMatch && questAliasMatchesName) score = 78;
    else if (exeMatch) score = 72;
    else if (questAliasMatchesName) score = 52;
    else if (questAliasMatchesAlias) score = 42;

    if (score > bestScore) {
      bestScore = score;
      bestEntry = candidate;
    }
  }

  return bestScore > 0 ? bestEntry : undefined;
}

/**
 * Returns the Discord CDN square icon URL for a game if matched in the
 * in-memory Discord catalog (0 ms, no network).
 */
export function findDiscordIconUrl(
  name: string,
  executable?: string,
  steamAppId?: number,
  size = 128
): string | undefined {
  const app = findDiscordApplication(name, executable, steamAppId);
  if (!app?.iconHash) return undefined;
  return discordAppIconUrl(app.id, app.iconHash, size);
}

/**
 * Returns the Steam App ID associated with a game in Discord's detectable
 * applications registry, if known.
 */
export function findDiscordSteamAppId(name: string, executable?: string): number | undefined {
  return findDiscordApplication(name, executable)?.steamAppId;
}

function slimRawDetectableApps(rawList: unknown): DiscordAppEntry[] {
  if (!Array.isArray(rawList)) return [];
  const entries: DiscordAppEntry[] = [];

  for (const item of rawList as RawDiscordDetectableApp[]) {
    if (!item?.id || !item?.name || !item?.icon_hash) continue;
    if (item.id === '466685661806592000') continue;

    const exes = Array.from(
      new Set(
        (item.executables ?? [])
          .filter((e) => !e.os || e.os === 'win32')
          .map((e) => cleanExecutableBaseName(e.name))
          .filter(Boolean)
      )
    );
    const steamSku = (item.third_party_skus ?? []).find(
      (s) => s.distributor === 'steam' && /^\d+$/.test(String(s.id ?? ''))
    );
    const aliases = Array.from(new Set((item.aliases ?? []).map((a) => a.trim()).filter(Boolean)));

    entries.push({
      id: String(item.id),
      name: String(item.name).trim(),
      ...(aliases.length > 0 ? { aliases } : {}),
      iconHash: String(item.icon_hash).trim(),
      ...(exes.length > 0 ? { executables: exes } : {}),
      ...(steamSku?.id ? { steamAppId: Number(steamSku.id) } : {}),
    });
  }

  return entries;
}

/**
 * Refreshes the in-memory Discord detectable catalog from Discord's live
 * public API (or GitHub mirrors) at most once per 24 hours unless `force` is set.
 */
export async function refreshDiscordDetectableCatalog(force = false): Promise<boolean> {
  ensureInitialized();

  if (!force && Date.now() - lastLiveRefreshAttemptAt < LIVE_REFRESH_TTL_MS) {
    return false;
  }
  if (liveRefreshInflight) return liveRefreshInflight;

  liveRefreshInflight = (async () => {
    lastLiveRefreshAttemptAt = Date.now();
    for (const url of DISCORD_DETECTABLE_URLS) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': DISCORD_UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const raw = await response.json();
        const freshEntries = slimRawDetectableApps(raw);
        if (freshEntries.length < 100) continue;

        const base = Array.isArray(bundledCatalog) ? (bundledCatalog as DiscordAppEntry[]) : [];
        rebuildDiscordIndex([...base, ...freshEntries]);

        try {
          fs.mkdirSync(ICON_CACHE_DIR, { recursive: true });
          const cacheFile = runtimeCacheFilePath();
          const tmpFile = `${cacheFile}.tmp`;
          fs.writeFileSync(
            tmpFile,
            JSON.stringify({ updatedAt: Date.now(), entries: freshEntries }),
            'utf8'
          );
          fs.renameSync(tmpFile, cacheFile);
        } catch (writeError) {
          debugLog('Could not persist live Discord detectable cache:', writeError);
        }
        return true;
      } catch (error) {
        debugLog(`Discord detectable fetch failed from ${url}:`, error);
      }
    }
    return false;
  })().finally(() => {
    liveRefreshInflight = null;
  });

  return liveRefreshInflight;
}
