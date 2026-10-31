/**
 * redditDataset.ts
 *
 * Turns raw r/DiscordQuests posts (an Apify/reddit-scraper dataset, a live
 * subreddit crawl or an RSS feed entry) into the compact cache entries the
 * catalog search reads first, before any Reddit request is made.
 *
 * Everything in here is offline and deterministic - no network access - and
 * reused by the background refresher in redditCacheStore.ts.
 */

import {
  extractInstallDir,
  extractMatchesFromText,
  isMeaningfulFolder,
  sanitizeSourceUrl,
  type UnifiedMatch,
} from './extract.ts';
import { cleanDisplayName, normalizeGameKey } from '../gameKey.ts';
import {
  applyRedditEntryFix,
  REDDIT_ENTRY_FIXES,
  REDDIT_POST_SUPPLEMENTS,
  redditPostId,
} from './corrections.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RedditCacheEntry {
  /** Canonical game name (see gameNames.ts) - one name per game. */
  gameName: string;
  executableName: string;
  folderPath: string;
  url: string;
  confidence: 'verified' | 'high' | 'medium' | 'experimental';
  source: 'reddit';
  notes?: string;
  questMethod?: 'process' | 'steam-manifest';
  steamAppId?: number;
  manifestFileName?: string;
  manifestContent?: string;
  /** Other names the post used for this game ("Marvel Rivals Deadpool"). Search-only. */
  aliases?: string[];
  /** Title of the Reddit post the entry was read from. */
  postTitle?: string;
  /**
   * Local part of the database only: how the entry got there - found by the
   * background update, or saved when the user added a live Reddit result to
   * the library - and when.
   */
  addedFrom?: 'refresh' | 'library';
  addedAt?: string;
}

/** Minimal shape of a scraped Reddit post (Apify dataset or the live API). */
export interface RedditPostLike {
  title?: string;
  selfText?: string;
  selftext?: string;
  body?: string;
  url?: string;
  permalink?: string;
  /**
   * `markdown`: the body is Reddit's markdown source (the `selftext` of the
   * Reddit JSON API and of the Arctic Shift archive), with backslash escapes
   * such as "ONCE\_HUMAN.exe". Default `text`: already rendered (RSS feeds,
   * the Apify dataset).
   */
  textFormat?: 'text' | 'markdown';
}

// ---------------------------------------------------------------------------
// Markdown source -> text
// ---------------------------------------------------------------------------

/** ASCII punctuation: the only characters a markdown backslash escapes. */
const MARKDOWN_ESCAPABLE = /[!-\/:-@\[-`{-~]/;

/** One markdown line: escapes resolved, inline code spans kept literally. */
function unescapeMarkdownLine(line: string): string {
  let out = '';
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '\\' && index + 1 < line.length && MARKDOWN_ESCAPABLE.test(line[index + 1])) {
      out += line[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      let run = 1;
      while (line[index + run] === '`') run++;
      const close = line.indexOf('`'.repeat(run), index + run);
      const end = close === -1 ? index + run : close + run;
      out += line.slice(index, end);
      index = end;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

/**
 * Plain text of a post body given as Reddit markdown source, the way Reddit
 * renders it: "ONCE\_HUMAN.exe" -> "ONCE_HUMAN.exe",
 * "..\\March of Giants\\TheLineClient.exe" -> "..\March of Giants\TheLineClient.exe",
 * "**MHST.exe**" -> "MHST.exe". A backslash in front of a letter is not an
 * escape ("..\Game" stays), and code (indented lines, `inline code`) is kept
 * literally - exactly as markdown treats it.
 */
export function redditMarkdownToText(markdown: string): string {
  return text(markdown)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (/^(?: {4}|\t)/.test(line) ? line : unescapeMarkdownLine(line).replace(/\*\*(?=\S)(.+?)\*\*/g, '$1')))
    .join('\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Game-name cleaning
// ---------------------------------------------------------------------------

/**
 * Remote payloads (a scraped dataset, the Reddit API, an RSS feed) are
 * untrusted: a field that "should" be a string can arrive as a number, an
 * object (XMLParser turns nested elements into objects) or null. Calling
 * `.trim()` on those used to throw a TypeError, which aborted the whole
 * cache rebuild instead of skipping the one broken row.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Trailing noise that r/DiscordQuests appends to post titles.
 *
 * The list is applied repeatedly from the end of the title, so
 * "Where Winds Meet - Ends January 11th, 2026 (700 Orbs)" first loses the
 * parenthetical, then the date clause and ends up as "Where Winds Meet".
 */
const TRAILING_NOISE: RegExp[] = [
  // "Folder Structure and EXE Location:" / "File Directory" / "directory?"
  /\s*(?:folder\s+structure\s+and\s+exe\s+location|exe\s+location|file\s+directory|directory)\s*[.:?]?\s*$/i,
  // "Filepath for Discord Quest Completer"
  /\s*filepath\s+for\s+discord\s*quest\s*completer\s*$/i,
  // "- Ends March 23rd, 2026 (700 orbs)" / "- Ends 02/02"
  /\s*[-\u2013\u2014:]\s*(?:ends?\b[^-\u2013\u2014:()]*)?\(\s*\d+\s*orbs?[^)]*\)\s*$/i,
  // "(700 orbs, ends 1/29)"
  /\s*\(\s*[^)]*orbs?[^)]*\)\s*$/i,
  // "- Ends December 23rd, 2025" / "- 8th December 2025" / "- 700 Orbs"
  /\s*[-\u2013\u2014]\s*(?:ends?\b.*|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s*,?\s*\d{4}.*|\d+\s*orbs?\b.*)$/i,
  // "Quest", "Quests", "Questt" (typo), "orb", "demo", "location", "exe"...
  /\s*\b(?:quests?|questt|orbs?|demos?|betas?|alphas?|launch|events?|challenges?|helps?|locations?|directories|filepaths?|discord|exe)\b\.?\s*[.:]?\s*$/i,
];

/**
 * Words that only ever start a question, never a game title. A title that
 * begins with one of them AND continues with a prose word is a question
 * ("help for forza horizon 6 quest"), while "Where Winds Meet" is a perfectly
 * good game name that merely starts with a question word.
 */
const TITLE_QUESTION_START =
  /^(?:how|why|what|when|where|which|who|is|are|was|were|can|could|should|would|does|do|did|any|anyone|somebody|someone|psa|megathread|method|fix|guide|tutorial|update|release|reminder|question|help)\b/i;

const TITLE_PROSE_WORD =
  /^(?:to|do|does|did|is|are|the|a|an|for|of|in|on|at|my|your|our|i|you|we|it|this|that|there|here|any|someone|anyone|please|me|with|from|and|or|but|if|then|so|get|got|need|needs|want|know|work|works|working|use|using|try|tried|much|many|more|most|not|no|yes|up|out|off|over|under|about|into|via|per|etc|new|old|best|good|bad|easy|hard|way|ways|thing|things|stuff|guys|hey|hi|hello|thanks|thank|sorry)$/i;

/** Known helper tools that show up as post titles but are not games. */
const TOOL_TITLE =
  /(?:discord\s*quest\s*completer|orbshacker|steam\s*quest\s*mode|quest\s*completer|no\s+more\s+scripts?|\bi\s+made\b|\ba\s+fix\s+for\b)/i;

/** Maximum length kept for a game name. */
const MAX_GAME_NAME_LENGTH = 80;

function looksLikeQuestionTitle(name: string): boolean {
  if (name.endsWith('?')) return true;
  if (TOOL_TITLE.test(name)) return true;
  // A bare question word ("Update:", "Question") is never a game name.
  if (/^\s*(?:psa|megathread|question|update|release|reminder|guide|tutorial|help)\s*[.:]?\s*$/i.test(name)) {
    return true;
  }
  if (!TITLE_QUESTION_START.test(name)) return false;
  const rest = name.replace(TITLE_QUESTION_START, '').trim().split(/\s+/);
  return rest.length === 0 || TITLE_PROSE_WORD.test(rest[0]);
}

/**
 * A shouty title ("NTE LAUNCH DRIFT") is a clip/announcement headline rather
 * than a catalog name, so the install directory in the post body is the better
 * source. Single-word all-caps names ("STALZONE", "EMPULSE") are kept.
 */
function looksLikeHeadline(name: string): boolean {
  if (/[a-z]/.test(name)) return false;
  return name.split(/\s+/).filter(Boolean).length >= 3;
}

/** True when the cleaned title cannot be trusted as a game name. */
function isUnreliableTitle(name: string): boolean {
  return looksLikeQuestionTitle(name) || looksLikeHeadline(name);
}

/**
 * Derives a clean game name from a post title.
 *
 * Returns an empty string when the title does not look like a game name, so
 * the caller can fall back to the install directory found in the post body.
 */
export function cleanGameName(rawTitle: string): string {
  let name = text(rawTitle).replace(/\s+/g, ' ').trim();
  if (!name) return '';
  // Megathreads are sticky discussion threads, never a game.
  if (/megathread/i.test(name)) return '';

  // Drop a leading bracket tag such as "[Discord Quest]".
  name = name.replace(/^\[[^\]]*\]\s*/, '').trim();

  for (let pass = 0; pass < 6; pass++) {
    const before = name;
    for (const pattern of TRAILING_NOISE) {
      name = name.replace(pattern, '').trim();
    }
    if (name === before) break;
  }

  // Trailing sentence punctuation ("skate. Quest" -> "skate").
  name = name.replace(/[\s?!.,;:]+$/, '').trim();

  if (!name || name.length > MAX_GAME_NAME_LENGTH) return '';
  if (isUnreliableTitle(name)) return '';
  return name;
}

// ---------------------------------------------------------------------------
// Folder helpers
// ---------------------------------------------------------------------------

/** Generic engine folders that never identify a game. */
const GENERIC_FOLDER_NAMES = new Set([
  '.', '..', 'bin', 'binaries', 'win64', 'win32', 'x64', 'x86', 'game', 'games',
  'engine', 'client', 'content', 'shippergame', 'shipping', 'windowsnoeditor',
  'program files', 'program files (x86)', 'steam', 'steamapps', 'common',
  'users', 'desktop', 'documents', 'programdata',
]);

function isDriveSegment(segment: string): boolean {
  return /^[A-Za-z]:$/.test(segment);
}

/**
 * First folder segment that could plausibly be a game name.
 * "Neverness To Everness\Client\WindowsNoEditor\HT\Binaries\Win64" yields
 * "Neverness To Everness".
 */
function firstMeaningfulSegment(folderPath: string): string | undefined {
  for (const segment of folderPath.split('\\')) {
    const value = segment.trim();
    if (!value || GENERIC_FOLDER_NAMES.has(value.toLowerCase())) continue;
    if (isDriveSegment(value)) continue;
    if (value.length > 40 || value.split(/\s+/).length > 5) continue;
    return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry building
// ---------------------------------------------------------------------------

/** Most aliases kept per entry; they only widen the search. */
const MAX_ENTRY_ALIASES = 6;

/** The `"name"` value of a simulated Steam manifest ("EA SPORTS FC\u2122 27"). */
function manifestDisplayName(manifestContent: string | undefined): string {
  const match = /"name"\s+"([^"]+)"/i.exec(manifestContent || '');
  return match ? cleanDisplayName(match[1]) : '';
}

/**
 * Gives an entry its canonical game name and keeps the other spellings the
 * post used as search aliases.
 *
 * A hand-checked fix (redditCorrections.ts) that names the game explicitly
 * always wins; otherwise the cleaned post name is used.
 */
function finalizeEntryName(
  entry: RedditCacheEntry,
  extraNames: string[] = [],
  options: { postFix?: boolean } = {}
): RedditCacheEntry {
  const id = redditPostId(entry.url);
  // The post's fix describes the entry the extractor reads; the extra games of
  // the same post (REDDIT_POST_SUPPLEMENTS) carry their own names.
  const fix = id && options.postFix !== false ? REDDIT_ENTRY_FIXES[id] : undefined;
  const canonical = cleanDisplayName(fix?.gameName || entry.gameName);
  const canonicalKey = normalizeGameKey(canonical);

  // A fix that lists the aliases replaces the spellings collected from the
  // post (a title such as "blue pro and torchlight inf" names two games).
  const candidates = fix?.aliases ?? [entry.gameName, ...(entry.aliases ?? []), ...extraNames];
  const aliases: string[] = [];
  for (const candidate of candidates) {
    const name = cleanDisplayName(candidate);
    const key = normalizeGameKey(name);
    if (!name || key.length < 3 || key === canonicalKey || name.length > MAX_GAME_NAME_LENGTH) continue;
    if (GENERIC_FOLDER_NAMES.has(name.toLowerCase())) continue;
    if (aliases.some((alias) => normalizeGameKey(alias) === key)) continue;
    aliases.push(name);
  }

  const result: RedditCacheEntry = { ...entry, gameName: canonical || entry.gameName };
  if (aliases.length > 0) result.aliases = aliases.slice(0, MAX_ENTRY_ALIASES);
  else delete result.aliases;
  return result;
}

/**
 * Builds a cache entry out of an already extracted match.
 *
 * The raw game name is resolved in this order: `preferredName` (a known game
 * name from the verified quest database), the name inside a Steam manifest,
 * the cleaned post title, the install folder mentioned in the path and finally
 * `fallbackName` (the query of a live search). The raw name is then mapped to
 * its canonical spelling (gameNames.ts), and the hand-checked fix of the post
 * (redditCorrections.ts) is applied.
 */
export function buildCacheEntry(
  match: UnifiedMatch,
  options: { title?: string; url?: string; preferredName?: string; fallbackName?: string } = {}
): RedditCacheEntry | null {
  const rawFolder =
    match.folderPath && !match.folderPath.toLowerCase().startsWith('not found')
      ? match.folderPath
          .trim()
          // "...\Game" / ".../Game" is a common way to write "any parent
          // folder"; the database spells it "..\Game".
          .replace(/^\.{3,}(?=[\\/])/, '..')
      : '';
  const folderPath = rawFolder && isMeaningfulFolder(rawFolder) ? rawFolder : '';

  const installDir = folderPath ? extractInstallDir(folderPath) : undefined;
  const fallbackDir = installDir || (folderPath ? firstMeaningfulSegment(folderPath) : undefined);

  const isManifest = match.questMethod === 'steam-manifest';
  const manifestInstallDir = (match.gameName || '').trim();
  const manifestName = isManifest ? manifestDisplayName(match.manifestContent) : '';
  const titleName = cleanGameName(options.title || '');
  // A manifest always names its own game, so it is trusted even when it would
  // look like a headline as a post title.
  const trustedManifestName = isManifest ? manifestName || manifestInstallDir : '';

  const rawName =
    (options.preferredName || '').trim() ||
    trustedManifestName ||
    cleanGameName(manifestInstallDir) ||
    (titleName && !isUnreliableTitle(titleName) ? titleName : '') ||
    fallbackDir ||
    (options.fallbackName || '').trim() ||
    '';

  if (!rawName) return null;

  let entry: RedditCacheEntry = {
    gameName: rawName,
    executableName: match.executableName.trim(),
    folderPath: folderPath || 'Not found',
    url: sanitizeSourceUrl(options.url ?? match.url ?? ''),
    confidence: match.confidence,
    source: 'reddit',
  };

  if (match.notes) entry.notes = match.notes;
  if (match.questMethod) entry.questMethod = match.questMethod;
  if (match.steamAppId) entry.steamAppId = match.steamAppId;
  if (match.manifestFileName) entry.manifestFileName = match.manifestFileName;
  if (match.manifestContent) entry.manifestContent = match.manifestContent;
  const postTitle = text(options.title).replace(/\s+/g, ' ').trim();
  if (postTitle) entry.postTitle = postTitle.slice(0, 200);

  entry = applyRedditEntryFix(entry);
  return finalizeEntryName(entry, [titleName, manifestName, isManifest ? manifestInstallDir : '']);
}

/**
 * `fallbackName` names the game when neither the title nor the path does
 * (live searches pass the user's query).
 */
function postToEntry(post: RedditPostLike, fallbackName?: string): RedditCacheEntry | null {
  if (!post || typeof post !== 'object') return null;

  const title = text(post.title).trim();
  const rawBody = text(post.selfText ?? post.selftext ?? post.body).trim();
  const body = post.textFormat === 'markdown' ? redditMarkdownToText(rawBody).trim() : rawBody;
  const url = text(post.url || post.permalink).trim();
  if (!title && !body) return null;
  // A tool announcement ("Discord Quest Completer", "I made OrbShacker") only
  // mentions example paths; those are not quest results for a game.
  if (!cleanGameName(title) && TOOL_TITLE.test(title)) return null;

  const match = extractMatchesFromText(`${title}\n${body}`, title, url, 'reddit');
  if (!match) return null;

  return buildCacheEntry(match, { title, url, fallbackName });
}

/**
 * Every cache entry of one post: the entry the extractor reads plus the
 * hand-checked extra games of posts that document more than one
 * (redditCorrections.ts).
 */
export function redditPostToEntries(
  post: RedditPostLike,
  options: { fallbackName?: string } = {}
): RedditCacheEntry[] {
  const entry = postToEntry(post, options.fallbackName);
  if (!post || typeof post !== 'object') return entry ? [entry] : [];

  const url = sanitizeSourceUrl(text(post.url || post.permalink).trim());
  const id = redditPostId(url);
  const supplements = id ? REDDIT_POST_SUPPLEMENTS[id] ?? [] : [];
  const postTitle = text(post.title).replace(/\s+/g, ' ').trim().slice(0, 200);
  const extra = supplements.map((supplement) =>
    finalizeEntryName(
      {
        ...supplement,
        url,
        source: 'reddit',
        ...(postTitle ? { postTitle } : {}),
      },
      [],
      { postFix: false }
    )
  );
  return [...(entry ? [entry] : []), ...extra];
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function executableKey(entry: RedditCacheEntry): string {
  return entry.executableName.trim().toLowerCase();
}

/**
 * Removes duplicates (same executable) and sorts alphabetically.
 *
 * The first occurrence wins, so callers pass the most trusted source first.
 */
export function dedupeEntries(entries: RedditCacheEntry[]): RedditCacheEntry[] {
  const seen = new Set<string>();
  const deduped: RedditCacheEntry[] = [];

  for (const entry of entries) {
    if (!entry.executableName || !entry.gameName) continue;
    const key = executableKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped.sort((a, b) => a.gameName.localeCompare(b.gameName));
}

