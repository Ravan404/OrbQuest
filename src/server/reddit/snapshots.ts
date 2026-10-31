/**
 * questDatabaseSource.ts
 *
 * The r/DiscordQuests snapshots the bundled quest database is built from
 * (`data/reddit/dataset_reddit-*.json`) and the build itself.
 *
 * Used by process-apify.ts and scripts/update-quest-database.ts -
 * never by the running server, which only reads the finished
 * `src/server/redditCache.json` (baked into dist/server.cjs).
 *
 * Snapshot formats:
 *   - the original Apify "reddit-scraper" export: a bare JSON array of posts
 *     whose text is already rendered;
 *   - update snapshots: `{ source, fetchedAt, checkedThrough, textFormat,
 *     posts: [...] }`, usually with Reddit markdown source
 *     (`textFormat: "markdown"`).
 * Older snapshots come first; a post that appears in two snapshots is read
 * from the older one, so a hand-checked entry never changes behind the back
 * of its corrections (redditCorrections.ts).
 */

import fs from 'fs';
import path from 'path';
import { redditPostId } from './corrections.ts';
import {
  dedupeEntries,
  redditPostToEntries,
  type RedditCacheEntry,
  type RedditPostLike,
} from './dataset.ts';

export const DATASET_FILE_PATTERN = /^dataset_reddit-.*\.json$/;
/** Folder of the r/DiscordQuests snapshots, relative to the repository root. */
export const DATASET_DIR = path.join('data', 'reddit');

export interface DatasetPost extends RedditPostLike {
  id?: string;
  createdAt?: string;
}

export interface DatasetSnapshot {
  file: string;
  source: string;
  fetchedAt?: string;
  /** Newest subreddit post the snapshot's listing had seen; later posts are new. */
  checkedThrough?: string;
  posts: DatasetPost[];
}

export interface LoadedDataset {
  snapshots: DatasetSnapshot[];
  /** Every post once, oldest snapshot first. */
  posts: DatasetPost[];
  checkedThrough: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Newest of a list of ISO timestamps ('' when there is none). */
export function newestTimestamp(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value as string)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';
}

function newestCreatedAt(posts: DatasetPost[]): string | undefined {
  return newestTimestamp(posts.map((post) => isoOrUndefined(post.createdAt))) || undefined;
}

/** The date a snapshot file name carries ("..._2026-10-14..."), for ordering. */
function fileDate(name: string): string {
  return /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1] ?? '';
}

/** Every snapshot file in `root`, oldest first. */
export function listDatasetFiles(root: string): string[] {
  const dir = path.join(root, DATASET_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => DATASET_FILE_PATTERN.test(name))
    .sort((a, b) => fileDate(a).localeCompare(fileDate(b)) || a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

export function readDatasetSnapshot(file: string): DatasetSnapshot {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (Array.isArray(raw)) {
    const posts = raw.filter(isObject) as DatasetPost[];
    return { file, source: 'apify-reddit-scraper', checkedThrough: newestCreatedAt(posts), posts };
  }
  if (!isObject(raw) || !Array.isArray(raw.posts)) {
    throw new Error(`${file} is not a dataset snapshot (expected an array or { posts: [...] }).`);
  }
  const textFormat = raw.textFormat === 'markdown' ? 'markdown' : 'text';
  const posts = (raw.posts.filter(isObject) as DatasetPost[]).map((post) => ({
    ...post,
    textFormat: post.textFormat === 'markdown' || post.textFormat === 'text' ? post.textFormat : textFormat,
  }));
  return {
    file,
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    fetchedAt: isoOrUndefined(raw.fetchedAt),
    checkedThrough: isoOrUndefined(raw.checkedThrough) ?? newestCreatedAt(posts),
    posts,
  };
}

function postIdOf(post: DatasetPost): string | undefined {
  const id = typeof post.id === 'string' ? post.id.trim().toLowerCase() : '';
  return id || redditPostId(typeof post.url === 'string' ? post.url : post.permalink);
}

/** Reads snapshots (oldest first) into one list with every post once. */
export function loadDataset(files: string[]): LoadedDataset {
  const snapshots = files.map(readDatasetSnapshot);
  const seen = new Set<string>();
  const posts: DatasetPost[] = [];
  for (const snapshot of snapshots) {
    for (const post of snapshot.posts) {
      const id = postIdOf(post);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      posts.push(post);
    }
  }
  return { snapshots, posts, checkedThrough: newestTimestamp(snapshots.map((snapshot) => snapshot.checkedThrough)) };
}

/** Reddit post ids a dataset already contains. */
export function datasetPostIds(dataset: LoadedDataset): Set<string> {
  return new Set(dataset.posts.map(postIdOf).filter((id): id is string => Boolean(id)));
}

/** The database entries of a list of posts: canonical names, post fixes, one entry per executable. */
export function buildDatabaseEntries(posts: DatasetPost[]): RedditCacheEntry[] {
  return dedupeEntries(posts.flatMap((post) => redditPostToEntries(post)));
}
