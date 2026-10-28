import { XMLParser } from 'fast-xml-parser';
import { instantGameLogo, resolveGameLogo } from './logo.js';
import { canonicalGameName, normalizeGameKey } from './gameNames.ts';
import { findQuestDbRecords, type QuestDbRecord } from './questLookup.ts';
import type { VerifiedGameInfo } from './questDatabase.ts';
import { getRedditCacheRevision } from './redditCacheStore.ts';
import { REDDIT_USER_AGENT, cooldownRemainingMs, isCoolingDown, politeFetch } from './redditClient.ts';
import { rememberOnlineEntries } from './onlineResultMemory.ts';
import { redditPostToEntries, type RedditCacheEntry } from './redditDataset.ts';

export interface UnifiedMatch {
  title: string;
  /** Clean resolved title of this result; used as the library name when added. */
  gameName?: string;
  url: string;
  folderPath: string;
  executableName: string;
  hasFolder: boolean;
  inLibrary: boolean;
  source: 'verified' | 'pcgw' | 'steam' | 'steam-manifest' | 'reddit' | 'web';
  questMethod?: 'process' | 'steam-manifest';
  steamAppId?: number;
  manifestFileName?: string;
  manifestContent?: string;
  confidence: 'verified' | 'high' | 'medium' | 'experimental';
  notes?: string;
  logoUrl?: string;
  isPrimary?: boolean;
  /** Where this result came from: the local quest database or a live Reddit search. */
  foundVia?: 'database' | 'online';
  /** A database result that a live Reddit search returned as well. */
  onlineConfirmed?: boolean;
}

/**
 * `database` answers from the local quest database and only asks Reddit when
 * the database has nothing for the game. `online` ("Search Reddit") always runs
 * a live Reddit search and adds what it finds below the database results.
 */
export type SearchMode = 'database' | 'online';

export interface SearchQuestResult {
  matches: UnifiedMatch[];
  query: string;
  mode: SearchMode;
  redditRateLimited: boolean;
  sourcesSearched: string[];
  totalFound: number;
  /** Results from the local quest database. */
  databaseCount: number;
  /** Live Reddit results that are NOT already in the database. */
  onlineCount: number;
  /** Live Reddit results identical to a database result (same executable), hidden. */
  onlineDuplicateCount: number;
  /** True when Reddit was queried live for this answer. */
  onlineSearched: boolean;
  /** The live Reddit search could not reach Reddit (network/HTTP error). */
  onlineFailed: boolean;
  /** When Reddit is rate limiting: seconds until the next search is possible. */
  redditRetryAfterSeconds?: number;
  /** Kept for older clients: same as `totalFound`. */
  redditCount: number;
  secondaryCount: number;
}

export interface SearchOptions {
  mode?: SearchMode;
  /** Executables already in the library (case-insensitive). */
  existingExecutables?: Set<string>;
}

// In-memory cache for database-mode answers (TTL: 1 hour)
interface CacheEntry {
  data: SearchQuestResult;
  timestamp: number;
}
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;
// An empty result is only cached briefly so a later retry (or a background
// cache refresh that just landed) can still reach Reddit.
const EMPTY_CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_SIZE = 100; // Limit cache size to prevent memory issues

// Live Reddit search. Every request goes through redditClient.ts, which
// spaces requests, keeps a per-minute budget and honours 429 / Retry-After /
// X-Ratelimit-Reset with a shared cooldown. A search is ONE request: the feed
// already carries the post text, so posts are never fetched one by one, and
// nothing is retried automatically.
const REDDIT_QUERY_TTL_MS = 10 * 60 * 1000;
const REDDIT_RSS_TIMEOUT_MS = 6000;
const MAX_REDDIT_FEED_ENTRIES = 12;
/**
 * Outcome of one live Reddit search. `failed` means Reddit could not be
 * reached or answered with an error, which is different from "no results".
 */
export interface RedditSearchOutcome {
  matches: UnifiedMatch[];
  rateLimited: boolean;
  failed: boolean;
  /** Milliseconds until Reddit may be searched again (when rate limited). */
  retryAfterMs: number;
}
const redditQueryCache = new Map<string, RedditSearchOutcome & { timestamp: number }>();
const redditInflight = new Map<string, Promise<RedditSearchOutcome>>();

// Disallowed or generic executable names to filter out false positives
const BANNED_EXECUTABLES = new Set([
  'setup.exe',
  'installer.exe',
  'unins000.exe',
  'uninstall.exe',
  'uninst.exe',
  'update.exe',
  'updater.exe',
  'patcher.exe',
  'crashhandler.exe',
  'crashhandler64.exe',
  'unitycrashhandler.exe',
  'unitycrashhandler64.exe',
  'dxwebsetup.exe',
  'vcredist_x64.exe',
  'vcredist_x86.exe',
  'discord.exe',
  'cmd.exe',
  'powershell.exe',
  'explorer.exe',
  'chrome.exe',
  'steam.exe',
  'epicgameslauncher.exe',
  'riotclientservices.exe',
  // Windows reserved device names: never a game, and games.ts rejects them
  // again via isSafeFileName().
  'con.exe', 'prn.exe', 'aux.exe', 'nul.exe',
  'com1.exe', 'com2.exe', 'com3.exe', 'com4.exe',
  'com5.exe', 'com6.exe', 'com7.exe', 'com8.exe', 'com9.exe',
  'lpt1.exe', 'lpt2.exe', 'lpt3.exe', 'lpt4.exe',
  'lpt5.exe', 'lpt6.exe', 'lpt7.exe', 'lpt8.exe', 'lpt9.exe',
]);

// ---------------------------------------------------------------------------
// Path / executable extraction helpers
// ---------------------------------------------------------------------------

/** Characters allowed inside a Windows path segment (spaces included). */
const PATH_SEGMENT_CHARS = String.raw`A-Za-z0-9_ .()+\-'&`;
/** Longest segment accepted before a "path" is treated as prose. */
const MAX_PATH_SEGMENT_LENGTH = 64;
/** Deepest accepted path. Real install paths stay well below this. */
const MAX_PATH_SEGMENTS = 12;

/**
 * Full path ending in .exe, e.g. `C:\Games\Foo\Bar.exe` or `Folder\Game.exe`.
 *
 * The rules that keep prose out of the match:
 *   * a drive letter must be followed *directly* by a separator, so the
 *     optional `C:` can never latch onto the last letter of a word that merely
 *     happens to be followed by a colon ("...Tools: Highly detectable...");
 *   * every segment is length-capped and the path can not be arbitrarily deep,
 *     so a sentence in front of the real path ("... Can be emulated with the
 *     following path Desktop\...") can never be absorbed into the match;
 *   * `(?<![A-Za-z0-9])` keeps the match from starting mid-word.
 */
const FULL_PATH_REGEX = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:` +
    // Absolute path: a real drive letter (colon immediately + separator).
    String.raw`[A-Za-z]:[\\/](?:[${PATH_SEGMENT_CHARS}]{1,${MAX_PATH_SEGMENT_LENGTH}}[\\/]){0,${MAX_PATH_SEGMENTS}}[${PATH_SEGMENT_CHARS}]{1,${MAX_PATH_SEGMENT_LENGTH}}\.exe` +
    String.raw`|` +
    // Relative path: at least one separator, then the executable.
    String.raw`(?:[${PATH_SEGMENT_CHARS}]{1,${MAX_PATH_SEGMENT_LENGTH}}[\\/]){1,${MAX_PATH_SEGMENTS}}[${PATH_SEGMENT_CHARS}]{1,${MAX_PATH_SEGMENT_LENGTH}}\.exe` +
  String.raw`)\b`,
  'gi'
);

/**
 * Words that mark a path segment as prose rather than a directory name.
 *
 * Deliberately excludes prepositions and articles ("of", "the", "to", "in"...)
 * because they are common inside real folder names - "Call of Duty HQ" or
 * "Path of Exile" must survive. A segment is only dropped when it contains at
 * least two of these words, which prose always does and game names never do.
 */
const PROSE_WORDS = new Set([
  'about','actually','after','again','also','although','always','am','another','any','anyone','anything',
  'are','because','before','being','both','but','can','cant','come','could','couldnt','did','didnt','do',
  'does','doesnt','doing','done','dont','either','else','emulate','emulated','even','ever','every',
  'everything','find','following','found','get','give','go','going','gone','had','has','have','having',
  'here','heres','however','if','into','is','it','its','just','keep','know','let','like','likely','look',
  'looking','made','make','may','might','more','most','much','must','my','need','needed','never','not','now',
  'only','otherwise','our','rather','really','since','so','some','someone','something','still','such','sure',
  'take','tell','than','thats','their','theirs','them','then','there','therefore','these','they','think',
  'this','those','though','thus','too','trying','until','upon','use','used','using','very','want','was',
  'were','what','whats','when','where','whether','which','while','who','whom','whose','why','will','with',
  'within','without','wont','work','works','working','would','yet','you','your','yours',
  'submitted','directory','folder','location','install','installed','exe','executable',
]);

/** Segments that are files rather than folders never belong in an install path. */
const FILE_SEGMENT = /\.(?:acf|exe|dll|json|cfg|ini|txt|log|dat|bin|zip|rar)\b/i;

/**
 * True when a leading path segment is prose rather than a folder name.
 *
 * "use script as normal .." and "... Can be emulated with the following path"
 * both qualify, while "Call of Duty HQ", "Path of Exile" and "Opera GX" - real
 * folder names that merely contain everyday words - do not.
 */
function isProseSegment(segment: string): boolean {
  const words = segment.toLowerCase().match(/[a-z']+/g) ?? [];
  const prose = words.filter((word) => PROSE_WORDS.has(word)).length;
  return prose >= 2 || (prose >= 1 && words.length >= 3);
}

/** Trims segments, drops empties and normalizes every separator to a backslash. */
function normalizeFolder(folder: string): string {
  return folder
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('\\');
}

/**
 * Drops leading and trailing segments that are clearly prose.
 *
 * "... Can be emulated with the following path Desktop\common\Arc Raiders"
 * becomes "common\Arc Raiders" instead of dragging a whole sentence into the
 * install folder the app creates.
 */
export function trimProseSegments(folderPath: string): string {
  const segments = normalizeFolder(folderPath).split('\\');
  while (segments.length > 1 && isProseSegment(segments[0])) segments.shift();
  while (segments.length > 1 && isProseSegment(segments[segments.length - 1])) segments.pop();
  return segments.join('\\');
}

/** A folder is only usable when it names at least one real directory. */
export function isMeaningfulFolder(folderPath: string): boolean {
  const segments = normalizeFolder(folderPath)
    .split('\\')
    .filter((segment) => segment && segment !== '.' && segment !== '..' && !/^[A-Za-z]:$/.test(segment));
  return segments.length > 0;
}

/** Rejects executable "names" that are really sentence fragments. */
export function isPlausibleExecutableName(name: string): boolean {
  const value = name.trim();
  if (!/^[A-Za-z0-9_ .()+\-'&[\]]{1,64}\.exe$/i.test(value)) return false;
  // Only the extension may contain a dot ("game.exe", never "foo. - bar.exe").
  if (value.lastIndexOf('.') !== value.length - 4) return false;
  // Sentence punctuation never appears in a file name.
  if (/[?!,;:=]/.test(value)) return false;
  if (/\s[-\u2013\u2014]\s/.test(value)) return false;
  const words = value.slice(0, -4).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 && value.length <= 40;
}

/**
 * Cleans a "folder: ..." style hint: strips the scraper tail
 * ("submitted by /u/x [link] [comments]") and any trailing executable.
 */
export function sanitizeFolderHint(raw: string): string {
  let value = raw.split(/\r?\n/)[0];
  value = value.split(/\s+submitted by\s+/i)[0];
  value = value.replace(/\s*\[(?:link|comments)\]\s*$/gi, '');
  const exeCut = value.search(/\.exe\b/i);
  if (exeCut > 0) value = value.slice(0, exeCut).replace(/[\\/]+$/, '');
  if (value.length > 160) value = value.slice(0, 160);
  return value.trim();
}

/**
 * Only http(s) links may be surfaced to the UI.
 *
 * The URL ends up as an `<a href>` in the results view, so a `javascript:`
 * (or `data:`) value coming from a scraped post or an RSS feed would become a
 * click-to-execute XSS on the app origin. Anything else is dropped, which
 * simply hides the "Source" link.
 */
export function sanitizeSourceUrl(url: string): string {
  // A security filter must never throw on hostile input: a non-string (an
  // XMLParser object, a number) is simply not a usable URL.
  const value = typeof url === 'string' ? url.trim() : '';
  return /^https?:\/\/[^\s<>"']+$/i.test(value) ? value : '';
}

/**
 * Hard bound on how much text is scanned.
 *
 * Reddit caps a post body at ~40k characters, so this never affects real data;
 * it only keeps a pathological feed entry from turning into a CPU sink.
 */
const MAX_SCAN_LENGTH = 500_000;

/** Install directory name from a Steam-style path ("...\steamapps\common\Foo"). */
export function extractInstallDir(folderPath: string): string | undefined {
  const segments = normalizeFolder(folderPath).split('\\');
  const isCommon = (segment: string) => /^common$/i.test(segment);
  const isSteamApps = (segment: string) => /^steamapps$/i.test(segment);

  // Prefer "steamapps\common\<Game>", fall back to a bare "common\<Game>".
  const indexes = [
    segments.findIndex((segment, i) => isCommon(segment) && i > 0 && isSteamApps(segments[i - 1])),
    segments.findIndex(isCommon),
  ];
  for (const index of indexes) {
    const candidate = index >= 0 ? segments[index + 1] : undefined;
    if (candidate?.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Picks the most path-like candidate out of every full path in the text.
 *
 * Every match contributes the folder/executable pair at its end plus, when the
 * text continues with prose after the executable, the pair at the first
 * plausible executable inside it. Steam-style install paths win, then the
 * deepest folder, then the last mention (posts usually repeat the working path
 * at the end).
 */
function findBestPath(text: string): string | null {
  const candidates: Array<{ value: string; index: number; score: number }> = [];

  const consider = (folder: string, executable: string, index: number) => {
    if (!isPlausibleExecutableName(executable)) return;

    // A segment that is really a file ("appmanifest_123.acf ...") means the
    // match swallowed more than one path; keep only what precedes it. Such a
    // truncated folder is still usable, but scores below a clean one.
    let cleaned = trimProseSegments(folder);
    let truncated = false;
    const fileIndex = cleaned.split('\\').findIndex((segment) => FILE_SEGMENT.test(segment));
    if (fileIndex >= 0) {
      cleaned = cleaned.split('\\').slice(0, fileIndex).join('\\');
      truncated = true;
    }
    if (!cleaned || !isMeaningfulFolder(cleaned)) return;

    const lower = cleaned.toLowerCase();
    candidates.push({
      value: `${cleaned}\\${executable}`,
      index,
      score:
        (truncated ? -3 : 0) +
        (lower.includes('steamapps') || lower.includes('common') ? 4 : 0) +
        Math.min(cleaned.split('\\').length, 5) +
        index / Math.max(text.length, 1),
    });
  };

  for (const match of text.matchAll(FULL_PATH_REGEX)) {
    const raw = match[0];
    const index = match.index ?? 0;

    // Candidate at the end of the match (the normal case).
    const lastSlash = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
    if (lastSlash > 0) {
      consider(raw.substring(0, lastSlash), raw.substring(lastSlash + 1).trim(), index);
    }

    // Candidate at the first executable inside the match: the text often keeps
    // talking after the path ("...Game.exe and then restart Discord").
    const segments = raw.split(/[\\/]+/);
    for (let i = 1; i < segments.length; i++) {
      const executable = segments[i].trim();
      if (!/\.exe$/i.test(executable)) continue;
      consider(segments.slice(0, i).join('\\'), executable, index);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  return candidates[0].value;
}
/**
 * Matches `"key" "value"` pairs inside a Steam manifest blob.
 *
 * Values may contain apostrophes ("Assassin's Creed..."), so a plain
 * `[^"']+` would cut them in half.
 */
const QUOTED_VALUE = (key: string): RegExp =>
  new RegExp(`["']${key}["']\\s*["']([^"']*(?:'(?=[A-Za-z])[^"']*)*)["']`, 'i');

/**
 * Extracts candidate .exe and folder from freeform text with advanced heuristic parsing.
 */
export function extractMatchesFromText(
  text: string,
  title: string,
  url: string,
  source: 'reddit' | 'web' | 'pcgw' = 'web'
): UnifiedMatch | null {
  if (!text) return null;
  if (text.length > MAX_SCAN_LENGTH) text = text.slice(0, MAX_SCAN_LENGTH);

  const normalizedText = text
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
  const manifestMatch = normalizedText.match(/appmanifest_(\d+)\.acf/i);
  const installDirMatch = normalizedText.match(QUOTED_VALUE('installdir'));
  const hasManifestTemplate =
    source === 'reddit' &&
    manifestMatch &&
    installDirMatch &&
    /appstate|steamapps\s*[\\/]\s*common|stateflags/i.test(normalizedText);
  if (hasManifestTemplate) {
    const exeMatchFromManifest = normalizedText.match(/\b([A-Za-z0-9_.-]+\.exe)\b/i);
    const executableName = exeMatchFromManifest?.[1];
    const installDir = installDirMatch[1].trim();
    if (
      executableName &&
      isPlausibleExecutableName(executableName) &&
      !BANNED_EXECUTABLES.has(executableName.toLowerCase())
    ) {
      const nameMatch = normalizedText.match(QUOTED_VALUE('name'));
      const appId = Number(manifestMatch[1]);
      const manifestContent = `"AppState"
{
    "appid"     "${appId}"
    "name"      "${nameMatch?.[1]?.trim() || installDir}"
    "StateFlags"        "4"
    "installdir"        "${installDir}"
}`;
      return {
        title: title.trim(),
        gameName: installDir,
        url: sanitizeSourceUrl(url),
        folderPath: `steamapps\\common\\${installDir}`,
        executableName,
        hasFolder: true,
        inLibrary: false,
        source: 'steam-manifest',
        questMethod: 'steam-manifest',
        steamAppId: appId,
        manifestFileName: `appmanifest_${appId}.acf`,
        manifestContent,
        confidence: 'verified',
        notes: 'Reddit post contains the simulated Steam manifest quest template.',
      };
    }

  }

  // 1. Look for a full path ending in .exe, e.g. C:\\Games\\Foo\\Bar.exe or
  //    Folder/Subfolder/Game.exe. See FULL_PATH_REGEX above for the rules that
  //    keep prose out of the match.
  const pathMatch = findBestPath(text);

  // 2. Look for a standalone .exe file NAME (no spaces, no separators).
  //    NOTE: the class must not contain whitespace - otherwise the regex
  //    captures the words preceding the file name ("run setup.exe") and the
  //    banned-executable check below no longer matches.
  const exeRegex = /\b([A-Za-z0-9_.\-]+\.exe)\b/i;
  const exeMatch = text.match(exeRegex);

  // 3. Look for directory or folder hint
  const folderRegex = /(?:folder|directory|path|install\s*dir|location)\s*[:=-]\s*([^\r\n<>"]+)/im;
  const folderMatch = text.match(folderRegex);

  let folderPath = 'Not found';
  let executableName = 'Not found';

  if (pathMatch) {
    // findBestPath already normalized the folder part of the path.
    const lastSlash = pathMatch.lastIndexOf('\\');
    folderPath = pathMatch.substring(0, lastSlash);
    executableName = pathMatch.substring(lastSlash + 1).trim();
  } else {
    if (folderMatch) folderPath = sanitizeFolderHint(folderMatch[1]);
    if (exeMatch) executableName = exeMatch[1].trim();
  }

  // Clean trailing punctuation
  executableName = executableName.replace(/^[(\["']+|[)\]"',.:;]+$/g, '').trim();

  // Validate executable: it must look like a real file name (not a sentence
  // fragment) and must not be a banned installer/system binary.
  if (
    !isPlausibleExecutableName(executableName) ||
    BANNED_EXECUTABLES.has(executableName.toLowerCase())
  ) {
    return null;
  }

  const hasFolder =
    Boolean(folderPath.trim()) && !folderPath.toLowerCase().startsWith('not found');

  return {
    title: title.trim(),
    url: sanitizeSourceUrl(url),
    folderPath: hasFolder ? folderPath : 'Not found',
    executableName,
    hasFolder,
    inLibrary: false,
    source,
    confidence: source === 'pcgw' ? 'high' : hasFolder ? 'medium' : 'experimental',
    isPrimary: true,
  };
}

/** Decodes the HTML entities Reddit's feed leaves in post bodies ("Assassin&#39;s"). */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

/** A feed field as text (XMLParser turns elements with attributes into objects). */
function feedFieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as any)['#text'] === 'string') return (value as any)['#text'];
  return '';
}

/** Plain text of a feed entry's HTML content. */
function feedContentText(entry: any): string {
  const content = typeof entry?.content === 'string' ? entry.content : entry?.content?.['#text'] || '';
  return decodeHtmlEntities(String(content).replace(/<[^>]+>/g, ' '));
}

/** A live Reddit result in the same shape as a database result. */
function entryToOnlineMatch(entry: RedditCacheEntry): UnifiedMatch {
  return { ...cacheEntryToMatch(entry), foundVia: 'online' };
}

async function searchReddit(query: string, broad: boolean): Promise<RedditSearchOutcome> {
  const parser = new XMLParser({ ignoreAttributes: false });
  const matches: UnifiedMatch[] = [];
  let rateLimited = false;
  let failed = false;
  let retryAfterMs = 0;

  const urls = [
    `https://www.reddit.com/r/DiscordQuests/search.rss?q=${encodeURIComponent(
      query
    )}&restrict_sr=1&sort=relevance&t=all&limit=25`,
  ];

  if (broad) {
    urls.push(
      `https://www.reddit.com/search.rss?q=${encodeURIComponent(
        `"${query}" (exe OR executable OR folder OR directory OR path)`
      )}&sort=relevance&t=all&limit=25`
    );
  }

  for (const url of urls) {
    const answer = await politeFetch('reddit', url, {
      headers: {
        'User-Agent': REDDIT_USER_AGENT,
        Accept: 'application/rss+xml, application/xml',
      },
      timeoutMs: REDDIT_RSS_TIMEOUT_MS,
    });

    if (answer.rateLimited) {
      rateLimited = true;
      retryAfterMs = answer.retryAfterMs;
      console.warn(`Reddit is rate limiting searches; the next search is possible in ${Math.ceil(retryAfterMs / 1000)}s.`);
      break; // never hammer a limited host
    }
    if (answer.failed || !answer.response) {
      failed = true;
      console.warn(`Reddit search failed${answer.status ? ` (HTTP ${answer.status})` : ''}.`);
      continue;
    }

    let xml = '';
    try {
      xml = await answer.response.text();
    } catch {
      failed = true;
      continue;
    }
    const feed = parser.parse(xml);
    const entries = Array.isArray(feed?.feed?.entry)
      ? feed.feed.entry
      : feed?.feed?.entry
      ? [feed.feed.entry]
      : [];

    for (const entry of entries.slice(0, MAX_REDDIT_FEED_ENTRIES)) {
      const title = decodeHtmlEntities(feedFieldText(entry.title)) || 'Reddit Community Post';
      const postUrl = typeof entry.link?.['@_href'] === 'string' ? entry.link['@_href'] : '';

      // The same rules as the local database (redditDataset.ts): game names
      // are canonical, known post typos are fixed, tool announcements are
      // skipped - so a live result can be compared with (and deduplicated
      // against) a database result.
      const found = redditPostToEntries(
        { title, selfText: feedContentText(entry), url: postUrl },
        { fallbackName: query }
      );
      // Remembered so that adding one of them to the library can save it to
      // the local quest database (questDatabaseLearning.ts).
      rememberOnlineEntries(found);
      matches.push(...found.map(entryToOnlineMatch));
    }
  }

  return { matches, rateLimited, failed: failed && matches.length === 0, retryAfterMs };
}

/** Shared Reddit search used by the Catalog and executable-results screens. */
export async function searchRedditOnly(query: string): Promise<RedditSearchOutcome> {
  const cleanQuery = query.trim().toLowerCase();
  const cached = redditQueryCache.get(cleanQuery);
  const cacheTtl = cached?.rateLimited || cached?.matches.length === 0
    ? 60 * 1000
    : REDDIT_QUERY_TTL_MS;
  if (cached && Date.now() - cached.timestamp < cacheTtl && !(cached.rateLimited && !isCoolingDown('reddit'))) {
    return {
      matches: cached.matches,
      rateLimited: cached.rateLimited,
      failed: cached.failed,
      retryAfterMs: cached.rateLimited ? cooldownRemainingMs('reddit') : 0,
    };
  }
  const pending = redditInflight.get(cleanQuery);
  if (pending) return pending;
  if (isCoolingDown('reddit')) {
    return { matches: [], rateLimited: true, failed: false, retryAfterMs: cooldownRemainingMs('reddit') };
  }

  const request = (async () => {
    // The original spelling is kept: it names results whose post does not.
    const result = await searchReddit(query.trim(), false);
    // An unreachable Reddit is not an answer: the next request tries again.
    if (!result.failed) redditQueryCache.set(cleanQuery, { ...result, timestamp: Date.now() });
    return result;
  })().finally(() => {
    redditInflight.delete(cleanQuery);
  });
  redditInflight.set(cleanQuery, request);
  return request;
}

/**
 * Maps local database entries onto the unified search-result shape.
 *
 * Live Reddit results go through the very same mapping (see
 * `entryToOnlineMatch`), so a database result and a live result for the same
 * post look identical and can be deduplicated by executable.
 */
export function cacheEntryToMatch(entry: RedditCacheEntry): UnifiedMatch {
  const hasFolder =
    Boolean(entry.folderPath) && !entry.folderPath.toLowerCase().startsWith('not found');

  return {
    title: entry.postTitle || entry.gameName,
    gameName: entry.gameName,
    url: entry.url,
    folderPath: entry.folderPath,
    executableName: entry.executableName,
    hasFolder,
    inLibrary: false,
    source: entry.questMethod === 'steam-manifest' ? 'steam-manifest' : 'reddit',
    confidence: entry.confidence,
    notes: entry.notes,
    isPrimary: true,
    questMethod: entry.questMethod,
    steamAppId: entry.steamAppId,
    manifestFileName: entry.manifestFileName,
    manifestContent: entry.manifestContent,
  };
}

/** A curated registry game as a search result (only for games Reddit data lacks). */
function verifiedGameToMatch(game: VerifiedGameInfo): UnifiedMatch {
  return {
    title: game.name,
    gameName: game.name,
    url: '',
    folderPath: game.defaultFolder,
    executableName: game.executable,
    hasFolder: Boolean(game.defaultFolder),
    inLibrary: false,
    source: 'verified',
    confidence: 'high',
    notes: game.notes,
    isPrimary: true,
    questMethod: 'process',
  };
}

function executableKey(match: { executableName: string }): string {
  return match.executableName.trim().toLowerCase();
}

/** Keeps the first result per executable: the same .exe is the same result. */
function dedupeByExecutable<T extends { executableName: string }>(matches: T[]): T[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = executableKey(match);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordToMatches(record: QuestDbRecord): UnifiedMatch[] {
  if (record.entries.length > 0) {
    return record.entries.map((entry) => ({
      ...cacheEntryToMatch(entry),
      gameName: record.name,
      foundVia: 'database' as const,
    }));
  }
  return record.verified ? [{ ...verifiedGameToMatch(record.verified), foundVia: 'database' as const }] : [];
}

/** Results of the local quest database for a query - no network involved. */
export function searchDatabaseMatches(query: string): UnifiedMatch[] {
  return dedupeByExecutable(findQuestDbRecords(query).flatMap(recordToMatches));
}

/**
 * Marks results that are already part of the library.
 *
 * Only an EXACT executable match counts. Matching on the search query used to
 * flag every result of a multi-result search as "Already in Library" after a
 * single add, even though the other results are different executables.
 */
export function applyLibraryFlags<T extends { executableName: string; inLibrary: boolean }>(
  matches: T[],
  existingExecutables: Set<string>
): T[] {
  const normalized = new Set(Array.from(existingExecutables).map((exe) => exe.trim().toLowerCase()));
  return matches.map((match) => ({
    ...match,
    inLibrary: normalized.has(match.executableName.trim().toLowerCase()),
  }));
}

/** Longest a search waits for game icons before answering without them. */
const LOGO_WAIT_MS = 1_200;

/**
 * Adds a game icon to every result, waiting at most LOGO_WAIT_MS.
 *
 * Icons are cosmetic: a slow icon service must never hold back a local
 * database answer. A lookup that misses the deadline keeps running in the
 * background and lands in the logo cache for the next search; the UI shows its
 * local badge meanwhile.
 */
async function attachLogos(matches: UnifiedMatch[], fallbackName: string): Promise<UnifiedMatch[]> {
  if (matches.length === 0) return matches;

  const logos = new Map<string, string | undefined>();
  const targets = new Map<string, { name: string; executable?: string; steamAppId?: number }>();

  for (const match of matches) {
    const name = match.gameName?.trim() || fallbackName;
    const key = `${name.toLowerCase()}|${(match.executableName || '').toLowerCase()}|${match.steamAppId ?? ''}`;
    if (!targets.has(key)) {
      const instant = instantGameLogo(name, match.executableName, match.steamAppId);
      if (instant) logos.set(key, instant);
      targets.set(key, { name, executable: match.executableName, steamAppId: match.steamAppId });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LOGO_WAIT_MS);
  });
  const lookups = Promise.all(
    Array.from(targets.entries()).map(async ([key, target]) => {
      try {
        const resolved = await resolveGameLogo(target.name, target.executable, target.steamAppId);
        if (resolved) logos.set(key, resolved);
      } catch {
        // Keep any instant logo already placed in `logos`.
      }
    })
  );
  await Promise.race([lookups, deadline]);
  if (timer) clearTimeout(timer);

  return matches.map((match) => {
    const name = match.gameName?.trim() || fallbackName;
    const key = `${name.toLowerCase()}|${(match.executableName || '').toLowerCase()}|${match.steamAppId ?? ''}`;
    const logoUrl = logos.get(key) || match.logoUrl;
    return logoUrl ? { ...match, logoUrl } : match;
  });
}

function rememberResult(cacheKey: string, result: SearchQuestResult): void {
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldest = Array.from(searchCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    oldest.slice(0, Math.floor(MAX_CACHE_SIZE * 0.2)).forEach(([key]) => searchCache.delete(key));
  }
  searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
}

/**
 * Executable search behind the results screen.
 *
 * `database` mode (default): the local quest database answers first. Only
 * when it has nothing for the game is Reddit searched live - the database IS
 * the r/DiscordQuests data, so asking Reddit again would only repeat it.
 *
 * `online` mode ("Search Reddit"): Reddit is always searched live. Results
 * that are already in the database (same executable) are not repeated; the
 * database result is marked as confirmed instead, and only the new results
 * are added below it.
 */
export async function executeMultiSourceSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchQuestResult> {
  const cleanQ = query.trim();
  const mode: SearchMode = options.mode === 'online' ? 'online' : 'database';
  const existingExecutables = options.existingExecutables ?? new Set<string>();
  // The database revision is part of the key: a background refresh that adds
  // games must not be hidden behind an older answer.
  const cacheKey = `${getRedditCacheRevision()}:${cleanQ.toLowerCase()}`;

  /** Icons (from the logo cache, so usually instantly) + library flags. */
  const finish = async (result: SearchQuestResult): Promise<SearchQuestResult> => {
    const withLogos = await attachLogos(result.matches, cleanQ);
    return { ...result, matches: applyLibraryFlags(withLogos, existingExecutables) };
  };

  // ── Layer 1: In-memory session cache (database mode only) ───────────────
  if (mode === 'database') {
    const cached = searchCache.get(cacheKey);
    if (cached) {
      const ttl = cached.data.matches.length === 0 ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS;
      if (Date.now() - cached.timestamp < ttl) {
        const limited = cached.data.onlineSearched && isCoolingDown('reddit');
        return finish({
          ...cached.data,
          redditRateLimited: limited,
          redditRetryAfterSeconds: limited ? Math.ceil(cooldownRemainingMs('reddit') / 1000) : undefined,
          sourcesSearched: ['cache'],
        });
      }
    }
  }

  // ── Layer 2: Local quest database (no network request) ──────────────────
  const databaseMatches = searchDatabaseMatches(cleanQ);

  if (mode === 'database' && databaseMatches.length > 0) {
    const result: SearchQuestResult = {
      matches: databaseMatches,
      query: cleanQ,
      mode,
      redditRateLimited: false,
      sourcesSearched: ['database'],
      totalFound: databaseMatches.length,
      databaseCount: databaseMatches.length,
      onlineCount: 0,
      onlineDuplicateCount: 0,
      onlineSearched: false,
      onlineFailed: false,
      redditCount: databaseMatches.length,
      secondaryCount: 0,
    };
    rememberResult(cacheKey, result);
    return finish(result);
  }

  // ── Layer 3: Live Reddit search ("Search Reddit", or nothing local) ─────
  const redditData = await searchRedditOnly(cleanQ);
  const onlineMatches = dedupeByExecutable(
    redditData.matches.map((match) => ({
      ...match,
      gameName: match.gameName?.trim() || canonicalGameName(cleanQ),
      foundVia: 'online' as const,
      isPrimary: true,
      inLibrary: false,
    }))
  );

  // The database IS the r/DiscordQuests data: a live result with an executable
  // the database already lists is the same result, so it is not repeated.
  const databaseExecutables = new Set(databaseMatches.map(executableKey));
  const confirmed = new Set(
    onlineMatches.map(executableKey).filter((key) => databaseExecutables.has(key))
  );
  // Reddit's search also returns posts about other games ("MARVEL SNAP" for
  // "Marvel Rivals"); they stay visible but come after the searched game.
  const queryKey = normalizeGameKey(cleanQ);
  const relevance = (match: UnifiedMatch): number => {
    const key = normalizeGameKey(match.gameName);
    if (key === queryKey) return 0;
    return key && queryKey && (key.includes(queryKey) || queryKey.includes(key)) ? 1 : 2;
  };
  const newOnlineMatches = onlineMatches
    .filter((match) => !databaseExecutables.has(executableKey(match)))
    .map((match, index) => ({ match, index, score: relevance(match) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.match);
  const merged = [
    ...databaseMatches.map((match) =>
      confirmed.has(executableKey(match)) ? { ...match, onlineConfirmed: true } : match
    ),
    ...newOnlineMatches,
  ];

  const sourcesSearched = ['database'];
  if (!redditData.rateLimited && !redditData.failed) sourcesSearched.push('reddit-live');

  const result: SearchQuestResult = {
    matches: merged,
    query: cleanQ,
    mode,
    redditRateLimited: redditData.rateLimited,
    sourcesSearched,
    totalFound: merged.length,
    databaseCount: databaseMatches.length,
    onlineCount: newOnlineMatches.length,
    onlineDuplicateCount: confirmed.size,
    onlineSearched: true,
    onlineFailed: redditData.failed,
    ...(redditData.rateLimited ? { redditRetryAfterSeconds: Math.max(1, Math.ceil(redditData.retryAfterMs / 1000)) } : {}),
    redditCount: merged.length,
    secondaryCount: 0,
  };
  // A failed live search is not remembered, so trying again reaches Reddit.
  if (mode === 'database' && !redditData.failed) rememberResult(cacheKey, result);
  return finish(result);
}
