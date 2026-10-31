/**
 * extract.ts
 *
 * Reads executable names and install folders out of r/DiscordQuests post
 * text. Used only by the game database update (scripts/update-game-database.ts)
 * for quest programs Discord's own list has no executable for; the app
 * itself never reads Reddit.
 */

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
