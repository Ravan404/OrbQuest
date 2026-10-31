/**
 * gameKey.ts
 *
 * Tiny, dependency-free helpers that decide when two game names refer to the
 * same game. Every list the app merges (the general game list, the curated
 * quest registry, the Reddit-derived database and live Reddit results) is
 * compared through `normalizeGameKey`, so "HELLDIVERS™ 2", "Helldivers 2" and
 * "helldivers-2" can never show up as three different games again.
 */

/** Trademark-style marks that Steam store names carry but nobody types. */
const TRADEMARK_MARKS = /[\u2122\u00AE\u00A9\u2120]/g;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Comparison key of a game name: trademark marks removed, accents folded,
 * lower-cased and reduced to `[a-z0-9]`.
 *
 * The marks are stripped BEFORE the Unicode normalization on purpose: NFKD
 * turns "™" into the letters "TM", which used to make "Battlefield™ 6" invisible
 * to a "battlefield 6" query.
 */
export function normalizeGameKey(value: unknown): string {
  return text(value)
    .replace(TRADEMARK_MARKS, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Keys of every word-start suffix of a name:
 * "EA SPORTS FC 26" -> ["easportsfc26", "sportsfc26", "fc26", "26"].
 */
export function wordStartKeys(value: unknown): string[] {
  const words = text(value)
    .replace(TRADEMARK_MARKS, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.map((_, index) => words.slice(index).join(''));
}

/** Queries up to this length only match at the start of a word. */
const WORD_START_QUERY_LENGTH = 3;

/**
 * How well a game name matches a normalized query: 0 exact, 1 prefix,
 * 2 contained, -1 no match. A short query (up to three letters) only matches
 * at a word start, so "fc" finds "EA SPORTS FC 26" but not
 * "Heart of Chornobyl", and "nte" does not find "Counter-Strike 2".
 */
export function gameNameMatchRank(name: string, key: string, query: string): number {
  if (!query) return -1;
  if (key === query) return 0;
  if (key.startsWith(query)) return 1;
  const contained =
    query.length <= WORD_START_QUERY_LENGTH
      ? wordStartKeys(name).some((suffix) => suffix.startsWith(query))
      : key.includes(query);
  return contained ? 2 : -1;
}
