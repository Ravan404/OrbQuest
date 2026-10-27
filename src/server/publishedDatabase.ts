/**
 * publishedDatabase.ts
 *
 * The published quest database. A GitHub Actions workflow
 * (.github/workflows/database.yml) reads new r/DiscordQuests posts every few
 * hours and commits the rebuilt src/server/redditCache.json to the main
 * branch. The app downloads that one file instead of asking Reddit itself, so
 * Reddit sees a handful of requests a day in total, however many people run
 * the app. An ETag keeps an unchanged file from being downloaded again.
 */

import { APP_VERSION } from '../version.ts';

const DEFAULT_URLS = [
  'https://raw.githubusercontent.com/Ravan404/OrbQuest/main/src/server/redditCache.json',
  'https://cdn.jsdelivr.net/gh/Ravan404/OrbQuest@main/src/server/redditCache.json',
];

/** Where the database is downloaded from, in order. DQR_DATABASE_URL replaces the list (forks). */
export const PUBLISHED_DATABASE_URLS = process.env.DQR_DATABASE_URL?.trim()
  ? [process.env.DQR_DATABASE_URL.trim()]
  : DEFAULT_URLS;

/** The real file is about 40 KB; anything this large is not it. */
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface PublishedDatabase {
  generatedAt?: string;
  checkedThrough?: string;
  entries: unknown[];
}

export type PublishedDatabaseResult =
  | { status: 'updated'; database: PublishedDatabase; etag: string; url: string }
  | { status: 'unchanged'; url: string }
  | { status: 'failed' };

/**
 * Downloads the published database. `etag` is the one saved from the last
 * download; the server then answers 304 when nothing changed. The first URL
 * that answers wins; a failure, an oversized or malformed file tries the next.
 */
export async function fetchPublishedDatabase(
  etag = '',
  urls: readonly string[] = PUBLISHED_DATABASE_URLS,
  fetchImpl: typeof fetch = fetch
): Promise<PublishedDatabaseResult> {
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': `OrbQuest/${APP_VERSION} (quest database)`,
          Accept: 'application/json',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 304) return { status: 'unchanged', url };
      if (!response.ok) continue;
      if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) continue;
      const text = await response.text();
      if (text.length > MAX_BYTES) continue;
      const database: unknown = JSON.parse(text);
      if (!database || typeof database !== 'object' || !Array.isArray((database as PublishedDatabase).entries)) continue;
      return { status: 'updated', database: database as PublishedDatabase, etag: response.headers.get('etag') || '', url };
    } catch {
      // Unreachable, timed out or not JSON: try the next address.
    }
  }
  return { status: 'failed' };
}
