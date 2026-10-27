/**
 * logo.ts
 *
 * Multi-tier game icon resolution engine with 0-ms local/catalog lookup,
 * persistent disk caching (`iconStore.ts`), inflight deduplication, and
 * background pre-caching.
 *
 * Resolution hierarchy (no API key required at any tier):
 *   Tier 0 — Local Disk (`public/game-icons/` & `icon-cache/`):
 *            0 ms, 100% offline.
 *   Tier 1 — Discord Detectable Applications + Discord CDN:
 *            Matches by canonical name, aliases, Windows `.exe` name, or
 *            Steam App ID against the bundled Discord catalog (and live
 *            `discord.com/api/v9/applications/detectable` updates), serving
 *            `https://cdn.discordapp.com/app-icons/{id}/{hash}.png?size=128`.
 *   Tier 2 — Steam Official Square Icon (`api.steamcmd.net` + `storesearch`):
 *            Resolves the Steam App ID (via Quest DB, Discord `third_party_skus`,
 *            `store.steampowered.com/api/storesearch`, or `SearchApps`) and
 *            fetches the true 1:1 square `common.icon` hash from Steam's CDN.
 *   Tier 3 — SteamGridDB Public API:
 *            Curated square community/official icons (`width === height`).
 *   Tier 4 — Lutris Open Game Database API (`lutris.net/api/games`):
 *            Square icons for standalone/launcher titles.
 *   Tier 5 — PCGamingWiki MediaWiki API:
 *            Prioritizes explicit `icon`/`favicon` assets over wide banners.
 */

import { OFFLINE } from './config.ts';
import { VERIFIED_QUEST_GAMES } from './questDatabase.ts';
import {
  findDiscordApplication,
  findDiscordIconUrl,
  findDiscordSteamAppId,
  refreshDiscordDetectableCatalog,
} from './discordDetectable.ts';
import { normalizeGameKey } from './gameKey.ts';
import {
  canonicalIconKey,
  localIconForKey,
  localIconForName,
  markIconFailed,
  recentlyFailedIcon,
  saveRemoteIcon,
} from './iconStore.ts';
import { listQuestDbRecords, recordExecutables, type QuestDbRecord } from './questLookup.ts';

/** Network lookup failures are expected offline; printed only with DQR_DEBUG=1. */
const debugLog = (...args: unknown[]): void => {
  if (process.env.DQR_DEBUG) console.debug(...args);
};

const LOGO_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const LOGO_NEGATIVE_TTL_MS = 60 * 60 * 1000;
const MAX_LOGO_CACHE_ENTRIES = 600;
const REMOTE_TIMEOUT_MS = 5_000;

interface LogoCacheEntry {
  url: string | undefined;
  at: number;
}

const logoCache = new Map<string, LogoCacheEntry>();
const logoInflight = new Map<string, Promise<string | undefined>>();

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const APP_UA = 'OrbQuest/1.0 (game icon lookup)';

function cacheKey(name: string, executable?: string, steamAppId?: number): string {
  return `${(name || '').trim().toLowerCase()}|${(executable || '').trim().toLowerCase()}|${steamAppId ?? ''}`;
}

function remember(key: string, url: string | undefined): void {
  if (logoCache.size >= MAX_LOGO_CACHE_ENTRIES && !logoCache.has(key)) {
    const oldest = logoCache.keys().next().value;
    if (oldest !== undefined) logoCache.delete(oldest);
  }
  logoCache.delete(key);
  logoCache.set(key, { url, at: Date.now() });
}

function cached(key: string): string | undefined | null {
  const entry = logoCache.get(key);
  if (!entry) return null;
  const ttl = entry.url ? LOGO_POSITIVE_TTL_MS : LOGO_NEGATIVE_TTL_MS;
  if (Date.now() - entry.at >= ttl) {
    logoCache.delete(key);
    return null;
  }
  return entry.url;
}

function toHttps(url: string | undefined): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed.replace(/^http:\/\//i, 'https://');
}

// ---------------------------------------------------------------------------
// Synchronous 0-ms lookup (Local Disk -> In-memory Cache -> Discord Catalog)
// ---------------------------------------------------------------------------

/**
 * Returns a game icon URL synchronously in 0 ms without any network I/O:
 *   1. Local disk icon (`public/game-icons/` or `icon-cache/`)
 *   2. In-memory resolved cache
 *   3. Bundled Discord Detectable Applications catalog (`cdn.discordapp.com/app-icons/...`)
 *
 * When resolved via the Discord catalog and background icons are enabled, the
 * remote image is also queued to be saved into `icon-cache/` for offline use.
 */
export function instantGameLogo(
  name: string,
  executable?: string,
  steamAppId?: number
): string | undefined {
  const local = localIconForName(name, executable);
  if (local) return local;

  const key = cacheKey(name, executable, steamAppId);
  const hit = cached(key);
  if (hit) return hit;

  const discordUrl = findDiscordIconUrl(name, executable, steamAppId);
  if (discordUrl) {
    const iconKey = canonicalIconKey(name, executable);
    if (backgroundIconsEnabled && iconKey && !localIconForKey(iconKey)) {
      void saveRemoteIcon(iconKey, discordUrl).catch(() => undefined);
    }
    return discordUrl;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Known Steam App ID resolution (local DB + Discord third_party_skus)
// ---------------------------------------------------------------------------

function findKnownSteamAppId(
  name: string,
  executable?: string,
  explicitSteamAppId?: number
): number | undefined {
  if (explicitSteamAppId && Number.isSafeInteger(explicitSteamAppId) && explicitSteamAppId > 0) {
    return explicitSteamAppId;
  }

  const fromDiscord = findDiscordSteamAppId(name, executable);
  if (fromDiscord) return fromDiscord;

  const normName = normalizeGameKey(name);
  const cleanExe = (executable || '').replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase() || '';

  for (const record of listQuestDbRecords()) {
    const nameMatch = normName && (record.key === normName || record.aliasKeys.includes(normName));
    const exeMatch =
      cleanExe &&
      recordExecutables(record).some((e) => e.trim().toLowerCase() === cleanExe);
    if (nameMatch || exeMatch) {
      if (record.verified?.steamAppId) return record.verified.steamAppId;
      const entryWithSteam = record.entries.find((e) => e.steamAppId && e.steamAppId > 0);
      if (entryWithSteam?.steamAppId) return entryWithSteam.steamAppId;
    }
  }

  for (const game of VERIFIED_QUEST_GAMES) {
    if (!game.steamAppId) continue;
    const gKey = normalizeGameKey(game.name);
    const isNameMatch = normName && gKey === normName;
    const isExeMatch = cleanExe && game.executable.toLowerCase() === cleanExe;
    const isAliasMatch =
      normName && game.aliases.some((a) => normalizeGameKey(a) === normName);
    if (isNameMatch || isExeMatch || isAliasMatch) {
      return game.steamAppId;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Tier 2: Steam Official Square Icon (SteamCMD API + Store Search)
// ---------------------------------------------------------------------------

interface SteamStoreSearchItem {
  id?: number;
  name?: string;
  tiny_image?: string;
}

interface SteamCmdInfoResponse {
  data?: Record<
    string,
    {
      common?: {
        icon?: string;
        clienticon?: string;
      };
    }
  >;
}

/**
 * Fetches the true 1:1 square Steam application icon hash (`common.icon`) via
 * `api.steamcmd.net/v1/info/{appId}` and returns the official Steam CDN URL.
 */
export async function resolveSteamSquareIconByAppId(appId: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(appId) || appId <= 0) return undefined;
  try {
    const response = await fetch(`https://api.steamcmd.net/v1/info/${appId}`, {
      headers: { 'User-Agent': APP_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as SteamCmdInfoResponse;
    const common = payload?.data?.[String(appId)]?.common;
    const iconHash = common?.icon?.trim();
    if (iconHash && /^[a-f0-9]{32,40}$/i.test(iconHash)) {
      return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${iconHash}.jpg`;
    }
  } catch (error) {
    debugLog(`SteamCMD icon lookup failed for appId ${appId}:`, error);
  }
  return undefined;
}

/**
 * Searches Steam for a game, resolves its App ID, and fetches its square icon.
 * Prefers the true 1:1 square `common.icon` hash from `api.steamcmd.net`,
 * falling back to `storesearch` / `SearchApps` `tiny_image`.
 */
export async function resolveSteamClientIcon(
  name: string,
  knownAppId?: number
): Promise<string | undefined> {
  let appId = knownAppId;
  let fallbackTinyImage: string | undefined;

  if (appId) {
    const square = await resolveSteamSquareIconByAppId(appId);
    if (square) return square;
  }

  // Query Steam's official Store Search API (faster & more reliable than legacy SearchApps)
  try {
    const storeUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=US`;
    const response = await fetch(storeUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = (await response.json()) as { items?: SteamStoreSearchItem[] };
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length > 0) {
        const normTarget = normalizeGameKey(name);
        const match =
          (appId ? items.find((item) => item.id === appId) : undefined) ||
          items.find((item) => normalizeGameKey(item.name || '') === normTarget) ||
          items[0];
        if (match?.id && !appId) {
          appId = match.id;
          const square = await resolveSteamSquareIconByAppId(appId);
          if (square) return square;
        }
        if (match?.tiny_image) {
          fallbackTinyImage = toHttps(match.tiny_image);
        }
      }
    }
  } catch (error) {
    debugLog(`Steam storesearch failed for "${name}":`, error);
  }

  // Legacy Steam Community SearchApps fallback (returns 32x32 / 64x64 app icon URLs)
  try {
    const searchAppsUrl = `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(name)}`;
    const response = await fetch(searchAppsUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (response.ok) {
      const apps = (await response.json()) as Array<{
        appid?: number | string;
        name?: string;
        icon?: string;
        tiny_image?: string;
      }>;
      if (Array.isArray(apps) && apps.length > 0) {
        const normTarget = normalizeGameKey(name);
        const match =
          (appId ? apps.find((app) => Number(app.appid) === appId) : undefined) ||
          apps.find((app) => normalizeGameKey(app.name || '') === normTarget) ||
          apps[0];
        const candidateUrl = toHttps(match?.icon || match?.tiny_image);
        if (candidateUrl) return candidateUrl;
      }
    }
  } catch (error) {
    debugLog(`Steam SearchApps failed for "${name}":`, error);
  }

  return fallbackTinyImage;
}

// ---------------------------------------------------------------------------
// Tier 3: SteamGridDB Public API
// ---------------------------------------------------------------------------

interface SteamGridDbSearchGame {
  id?: number;
  name?: string;
  verified?: boolean;
}

interface SteamGridDbAsset {
  url?: string;
  thumb?: string;
  style?: string;
  width?: number;
  height?: number;
  is_deleted?: boolean;
}

/**
 * Queries SteamGridDB's keyless public web endpoints for a square game icon.
 */
export async function resolveSteamGridDbIcon(name: string): Promise<string | undefined> {
  const searchUrl = `https://www.steamgriddb.com/api/public/search/autocomplete?term=${encodeURIComponent(name)}`;
  const searchResponse = await fetch(searchUrl, {
    headers: { 'User-Agent': APP_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!searchResponse.ok) return undefined;

  const searchData = (await searchResponse.json()) as {
    success?: boolean;
    data?: SteamGridDbSearchGame[];
  };
  if (!searchData.success || !Array.isArray(searchData.data) || searchData.data.length === 0) {
    return undefined;
  }

  const normalizedName = normalizeGameKey(name);
  const game =
    searchData.data.find((candidate) => normalizeGameKey(candidate.name || '') === normalizedName) ||
    searchData.data.find((candidate) => candidate.verified) ||
    searchData.data[0];
  if (!game?.id) return undefined;

  const assetsResponse = await fetch('https://www.steamgriddb.com/api/public/search/assets', {
    method: 'POST',
    headers: {
      'User-Agent': APP_UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      game_id: [game.id],
      order: 'score_desc',
      asset_type: 'icon',
      page: 0,
      limit: 12,
      user_steam64: null,
      user_steam64_likes: null,
    }),
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!assetsResponse.ok) return undefined;

  const assetsData = (await assetsResponse.json()) as {
    success?: boolean;
    data?: { assets?: SteamGridDbAsset[] };
  };
  const assets =
    assetsData.success && Array.isArray(assetsData.data?.assets) ? assetsData.data.assets : [];

  const valid = assets.filter((asset) => {
    if (asset.is_deleted) return false;
    const url = asset.url || asset.thumb || '';
    if (!/^https:\/\/cdn\d*\.steamgriddb\.com\/icon(?:_thumb)?\//i.test(url)) return false;
    return asset.style === 'official' || !asset.width || asset.width === asset.height;
  });

  // Prefer official square icons or moderate dimensions (thumb first when url is huge)
  const official = valid.find((asset) => asset.style === 'official');
  const chosen = official ?? valid[0];
  if (!chosen) return undefined;
  if (chosen.thumb && chosen.width && chosen.width > 256) {
    return toHttps(chosen.thumb) ?? toHttps(chosen.url);
  }
  return toHttps(chosen.url || chosen.thumb);
}

// ---------------------------------------------------------------------------
// Tier 4: Lutris Open Game Database API
// ---------------------------------------------------------------------------

interface LutrisGameResult {
  name?: string;
  slug?: string;
  icon?: string;
}

/**
 * Queries the keyless Lutris API (`https://lutris.net/api/games?search=...`),
 * which provides 1:1 square icons for many standalone and non-Steam PC games.
 */
export async function resolveLutrisIcon(name: string): Promise<string | undefined> {
  try {
    const url = `https://lutris.net/api/games?search=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': APP_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { results?: LutrisGameResult[] };
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) return undefined;

    const normTarget = normalizeGameKey(name);
    const exact = results.find(
      (item) =>
        item.icon &&
        (normalizeGameKey(item.name || '') === normTarget ||
          normalizeGameKey(item.slug || '') === normTarget)
    );
    const candidate = exact ?? results.find((item) => normalizeGameKey(item.name || '').startsWith(normTarget) && item.icon);
    return toHttps(candidate?.icon);
  } catch (error) {
    debugLog(`Lutris icon lookup failed for "${name}":`, error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tier 5: PCGamingWiki MediaWiki API
// ---------------------------------------------------------------------------

/**
 * Fallback to PCGamingWiki for non-Steam titles. Prioritizes explicit `icon`
 * or `favicon` images before generic `logo` files so square icons win over
 * wide horizontal wordmarks.
 */
export async function resolvePcGamingWikiIcon(name: string): Promise<string | undefined> {
  try {
    const pcgwSearchUrl = `https://pcgamingwiki.com/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&limit=1`;
    const response = await fetch(pcgwSearchUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      query?: { search?: Array<{ title?: string }> };
    };
    const pageName = data?.query?.search?.[0]?.title;
    if (!pageName) return undefined;

    const pageUrl =
      `https://pcgamingwiki.com/api.php?action=query&titles=${encodeURIComponent(pageName)}` +
      '&prop=images|imageinfo&inprop=url&iiprop=url&format=json&imlimit=50';
    const pageResponse = await fetch(pageUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!pageResponse.ok) return undefined;

    const pageData = (await pageResponse.json()) as {
      query?: {
        pages?: Record<
          string,
          { images?: Array<{ name?: string; imageinfo?: Array<{ url?: string }> }> }
        >;
      };
    };
    const pages = pageData?.query?.pages;
    if (!pages) return undefined;

    const pageKey = Object.keys(pages)[0];
    const images = pages[pageKey]?.images;
    if (!Array.isArray(images) || images.length === 0) return undefined;

    const withUrls = images.filter(
      (img) =>
        typeof img?.name === 'string' &&
        typeof img?.imageinfo?.[0]?.url === 'string' &&
        /^https?:\/\//i.test(img.imageinfo[0].url)
    );
    const strictIcon = withUrls.find((img) => /\b(icon|favicon)\b/i.test(img.name!));
    const fallbackLogo = withUrls.find((img) => /(icon|logo|favicon)/i.test(img.name!));
    return toHttps((strictIcon ?? fallbackLogo)?.imageinfo?.[0]?.url);
  } catch (error) {
    debugLog(`PCGamingWiki logo search failed for "${name}":`, error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public Multi-Source Lookup & Caching API
// ---------------------------------------------------------------------------

/**
 * Looks up a square icon URL for a game across all remote tiers in priority
 * order. Pure lookup: does not write to `icon-cache/`, so both runtime
 * resolution and `scripts/download-game-icons.ts` share the exact same chain.
 */
export async function findRemoteIconUrl(
  name: string,
  executable?: string,
  steamAppId?: number
): Promise<string | undefined> {
  const cleanName = (name || '').trim();
  if (!cleanName && !executable && !steamAppId) return undefined;

  // Tier 1A: Bundled / In-Memory Discord Detectable Catalog (0 ms)
  const discordInstant = findDiscordIconUrl(cleanName, executable, steamAppId);
  if (discordInstant) return discordInstant;
  if (OFFLINE) return undefined;

  // Tier 1B: Refresh live Discord Detectable API once per 24h for newly released games
  try {
    const refreshed = await refreshDiscordDetectableCatalog(false);
    if (refreshed) {
      const discordLive = findDiscordIconUrl(cleanName, executable, steamAppId);
      if (discordLive) return discordLive;
    }
  } catch (error) {
    debugLog(`Discord live detectable refresh failed for "${cleanName}":`, error);
  }

  const resolvedSteamAppId = findKnownSteamAppId(cleanName, executable, steamAppId);

  // Tier 2: Steam Official Square Icon (SteamCMD `common.icon` + Store Search)
  if (cleanName || resolvedSteamAppId) {
    const steamIcon = await resolveSteamClientIcon(cleanName, resolvedSteamAppId);
    if (steamIcon) return steamIcon;
  }

  // Tier 3: SteamGridDB Public API
  if (cleanName) {
    try {
      const sgdbIcon = await resolveSteamGridDbIcon(cleanName);
      if (sgdbIcon) return sgdbIcon;
    } catch (error) {
      debugLog(`SteamGridDB logo search failed for "${cleanName}":`, error);
    }
  }

  // Tier 4: Lutris Open Game Database API
  if (cleanName) {
    const lutrisIcon = await resolveLutrisIcon(cleanName);
    if (lutrisIcon) return lutrisIcon;
  }

  // Tier 5: PCGamingWiki MediaWiki API
  if (cleanName) {
    const pcgwIcon = await resolvePcGamingWikiIcon(cleanName);
    if (pcgwIcon) return pcgwIcon;
  }

  return undefined;
}

/**
 * Resolves a square game icon URL, checking local disk first, then the
 * in-memory cache, and finally running the multi-tier remote resolution pipeline
 * and saving the downloaded icon into `icon-cache/` for offline reuse.
 */
export async function resolveGameLogo(
  name: string,
  executable?: string,
  steamAppId?: number
): Promise<string | undefined> {
  const local = localIconForName(name, executable);
  if (local) return local;

  const key = cacheKey(name, executable, steamAppId);
  const hit = cached(key);
  if (hit !== null) return hit;

  const pending = logoInflight.get(key);
  if (pending) return pending;

  const request = resolveGameLogoUncached(name, executable, steamAppId).finally(() => {
    logoInflight.delete(key);
  });
  logoInflight.set(key, request);
  return request;
}

async function resolveGameLogoUncached(
  name: string,
  executable?: string,
  steamAppId?: number
): Promise<string | undefined> {
  const key = cacheKey(name, executable, steamAppId);
  const iconKey = canonicalIconKey(name, executable);

  // Even if a remote download failed earlier, a bundled Discord CDN URL is still
  // available immediately without hitting failed external search APIs.
  const discordUrl = findDiscordIconUrl(name, executable, steamAppId);
  if (!discordUrl && iconKey && recentlyFailedIcon(iconKey)) {
    remember(key, undefined);
    return undefined;
  }

  let resolved = discordUrl ?? (await findRemoteIconUrl(name, executable, steamAppId));

  if (OFFLINE) {
    // Nothing is downloaded and nothing is marked failed while offline.
    remember(key, resolved);
    return resolved;
  }
  if (resolved) {
    if (iconKey) {
      const savedLocal = await saveRemoteIcon(iconKey, resolved);
      if (savedLocal) resolved = savedLocal;
    }
  } else if (iconKey) {
    markIconFailed(iconKey);
  }

  remember(key, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Background icons for the quest database
// ---------------------------------------------------------------------------
// Database games without a local icon on disk are downloaded in the background
// with two workers and a pause between requests, so startup and searches never
// wait for network I/O.

const ICON_QUEUE_WORKERS = 2;
const ICON_QUEUE_PAUSE_MS = 250;
const iconQueue: QuestDbRecord[] = [];
const iconQueued = new Set<string>();
let iconWorkers = 0;
let backgroundIconsEnabled = false;

/** Turns the background icon lookups on and queues the games without local disk icons. */
export function startBackgroundIcons(): void {
  if (OFFLINE) return;
  backgroundIconsEnabled = true;
  queueAllDatabaseIcons();
}

/** Queues a database game for a local disk icon download. `priority` puts it first. */
export function queueDatabaseIcon(record: QuestDbRecord, priority = false): void {
  if (!backgroundIconsEnabled) return;
  if (localIconForKey(record.key) || recentlyFailedIcon(record.key) || iconQueued.has(record.key)) {
    return;
  }
  iconQueued.add(record.key);
  if (priority) iconQueue.unshift(record);
  else iconQueue.push(record);
  pumpIconQueue();
}

/** Queues every database game that has no local disk icon yet. */
export function queueAllDatabaseIcons(): void {
  for (const record of listQuestDbRecords()) queueDatabaseIcon(record);
}

function pumpIconQueue(): void {
  while (iconWorkers < ICON_QUEUE_WORKERS && iconQueue.length > 0) {
    const record = iconQueue.shift();
    if (!record) break;
    iconWorkers++;
    fetchDatabaseIcon(record)
      .catch(() => undefined)
      .finally(() => {
        iconWorkers--;
        iconQueued.delete(record.key);
        pumpIconQueue();
      });
  }
}

async function fetchDatabaseIcon(record: QuestDbRecord): Promise<void> {
  const executable = recordExecutables(record)[0];
  const steamAppId =
    record.verified?.steamAppId ??
    record.entries.find((e) => e.steamAppId && e.steamAppId > 0)?.steamAppId;

  for (const name of [record.name, ...record.aliases.slice(0, 3)]) {
    if (localIconForKey(record.key)) return;
    try {
      const url = await findRemoteIconUrl(name, executable, steamAppId);
      if (url && (await saveRemoteIcon(record.key, url))) return;
    } catch {
      // Try next alias
    }
    await new Promise((resolve) => setTimeout(resolve, ICON_QUEUE_PAUSE_MS));
  }

  // Only mark failed when not even a Discord catalog icon exists for the record
  if (!findDiscordApplication(record.name, executable, steamAppId)) {
    markIconFailed(record.key);
  }
}
