/**
 * redditPosts.ts
 *
 * Fetches the r/DiscordQuests posts that are newer than what the quest
 * database has already checked - the rate-limit friendly way to keep the
 * database current:
 *
 *   - the subreddit LISTING is read (newest first, 100 posts per request),
 *     never Reddit's search: one request usually covers every new post;
 *   - reading stops at the first post the database already knows (or that is
 *     older than its "checked through" time), so an update costs one request,
 *     not a crawl of the whole subreddit;
 *   - when Reddit rate limits or refuses the request, the same range is read
 *     from the Arctic Shift archive of the subreddit (same post ids and text);
 *   - every request goes through redditClient.ts (spacing, per-minute budget,
 *     Retry-After / X-Ratelimit-Reset cooldowns, no automatic retries).
 *
 * Post bodies are returned as Reddit markdown source (`textFormat:
 * "markdown"`); redditDataset.ts turns them into text before extraction.
 */

import { REDDIT_USER_AGENT, politeFetch, type RemoteHost } from './client.ts';

export const SUBREDDIT = 'DiscordQuests';
const PAGE_SIZE = 100;

export interface SubredditPost {
  id: string;
  title: string;
  selfText: string;
  url: string;
  createdAt: string;
  textFormat: 'markdown';
}

export type PostSource = RemoteHost;

export interface NewPostsResult {
  /** New posts, oldest first. */
  posts: SubredditPost[];
  /** Where they came from; null when no source answered. */
  source: PostSource | null;
  /** Newest post the listing showed (questions included); '' when none. */
  newestCreatedAt: string;
  /** The listing reached the already checked range, so nothing is missing. */
  complete: boolean;
  rateLimited: boolean;
  failed: boolean;
  /** Milliseconds until Reddit may be asked again, when rate limited. */
  retryAfterMs: number;
  requests: number;
}

export interface FetchNewPostsOptions {
  /** ISO time: posts created at or before it are already checked. */
  since: string;
  /** Post ids the database already contains (an extra stop signal). */
  knownIds?: Set<string>;
  /** Most listing pages per source (default 5 = 500 posts). */
  maxPages?: number;
  /** Sources in the order they are tried (default Reddit, then Arctic Shift). */
  sources?: PostSource[];
  /** Background work may wait for the per-minute budget. */
  waitForBudget?: boolean;
}

interface SourceOutcome {
  posts: SubredditPost[];
  newestMs: number;
  complete: boolean;
  rateLimited: boolean;
  failed: boolean;
  retryAfterMs: number;
  requests: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function permalinkOf(id: string, url: string, permalink?: string): string {
  if (permalink && permalink.startsWith('/r/')) return `https://www.reddit.com${permalink}`;
  if (/^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url)) {
    return url.replace(/^https:\/\/(?:www\.|old\.)?reddit\.com/i, 'https://www.reddit.com');
  }
  return `https://www.reddit.com/r/${SUBREDDIT}/comments/${id}/`;
}

/** A listing row as a post, or null for rows that are no use (removed, deleted, broken). */
function toPost(row: Record<string, unknown>): SubredditPost | null {
  const id = text(row.id).trim().toLowerCase();
  const createdMs = Number(row.created_utc) * 1000;
  if (!/^[a-z0-9]+$/.test(id) || !Number.isFinite(createdMs)) return null;
  const selfText = text(row.selftext);
  if (row.removed_by_category || selfText === '[removed]' || selfText === '[deleted]') return null;
  return {
    id,
    title: text(row.title).slice(0, 300),
    selfText: selfText.slice(0, 40_000),
    url: permalinkOf(id, text(row.url), text(row.permalink) || undefined),
    createdAt: new Date(createdMs).toISOString(),
    textFormat: 'markdown',
  };
}

async function readJson(response: Response | null): Promise<any> {
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Reddit: /r/DiscordQuests/new.json, newest first, paged with `after`. */
async function fromReddit(options: Required<Pick<FetchNewPostsOptions, 'maxPages'>> & FetchNewPostsOptions, sinceMs: number): Promise<SourceOutcome> {
  const outcome: SourceOutcome = { posts: [], newestMs: 0, complete: false, rateLimited: false, failed: false, retryAfterMs: 0, requests: 0 };
  let after = '';
  for (let page = 0; page < options.maxPages; page++) {
    const url = `https://www.reddit.com/r/${SUBREDDIT}/new.json?limit=${PAGE_SIZE}&raw_json=1${after ? `&after=${after}` : ''}`;
    const answer = await politeFetch('reddit', url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT, Accept: 'application/json' },
      timeoutMs: 10_000,
      waitForBudget: options.waitForBudget,
    });
    if (answer.response || answer.failed) outcome.requests++;
    if (answer.rateLimited) return { ...outcome, rateLimited: true, retryAfterMs: answer.retryAfterMs };
    if (answer.failed || !answer.response) return { ...outcome, failed: true };

    const json = await readJson(answer.response);
    const children: any[] = Array.isArray(json?.data?.children) ? json.data.children : [];
    let reachedChecked = false;
    for (const child of children) {
      const row = child?.data;
      if (!row || typeof row !== 'object') continue;
      const createdMs = Number(row.created_utc) * 1000;
      if (Number.isFinite(createdMs)) outcome.newestMs = Math.max(outcome.newestMs, createdMs);
      const id = text(row.id).toLowerCase();
      if ((Number.isFinite(createdMs) && createdMs <= sinceMs) || options.knownIds?.has(id)) {
        reachedChecked = true;
        continue;
      }
      const post = toPost(row);
      if (post) outcome.posts.push(post);
    }
    after = text(json?.data?.after);
    if (reachedChecked || !after || children.length === 0) {
      outcome.complete = true;
      break;
    }
  }
  return outcome;
}

/** Arctic Shift: posts created after `since`, oldest first, paged by creation time. */
async function fromArcticShift(options: Required<Pick<FetchNewPostsOptions, 'maxPages'>> & FetchNewPostsOptions, sinceMs: number): Promise<SourceOutcome> {
  const outcome: SourceOutcome = { posts: [], newestMs: 0, complete: false, rateLimited: false, failed: false, retryAfterMs: 0, requests: 0 };
  let afterSeconds = Math.floor(sinceMs / 1000);
  for (let page = 0; page < options.maxPages; page++) {
    const url =
      `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${SUBREDDIT}` +
      `&after=${afterSeconds}&sort=asc&limit=${PAGE_SIZE}&fields=id,title,selftext,created_utc,url`;
    const answer = await politeFetch('arctic-shift', url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT, Accept: 'application/json' },
      timeoutMs: 15_000,
      waitForBudget: options.waitForBudget,
    });
    if (answer.response || answer.failed) outcome.requests++;
    if (answer.rateLimited) return { ...outcome, rateLimited: true, retryAfterMs: answer.retryAfterMs };
    const json = await readJson(answer.response);
    if (answer.failed || !Array.isArray(json?.data)) return { ...outcome, failed: true };

    const rows: any[] = json.data;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const createdMs = Number(row.created_utc) * 1000;
      if (!Number.isFinite(createdMs)) continue;
      outcome.newestMs = Math.max(outcome.newestMs, createdMs);
      afterSeconds = Math.max(afterSeconds, Math.floor(createdMs / 1000));
      if (createdMs <= sinceMs || options.knownIds?.has(text(row.id).toLowerCase())) continue;
      const post = toPost(row);
      if (post) outcome.posts.push(post);
    }
    if (rows.length < PAGE_SIZE) {
      outcome.complete = true;
      break;
    }
  }
  return outcome;
}

/**
 * The posts created after `options.since`, from the first source that
 * answers. Never throws.
 */
export async function fetchNewSubredditPosts(options: FetchNewPostsOptions): Promise<NewPostsResult> {
  const sinceMs = Number.isNaN(Date.parse(options.since)) ? 0 : Date.parse(options.since);
  const settings = { maxPages: 5, ...options };
  const sources = options.sources ?? (['reddit', 'arctic-shift'] as PostSource[]);
  const result: NewPostsResult = {
    posts: [],
    source: null,
    newestCreatedAt: '',
    complete: false,
    rateLimited: false,
    failed: false,
    retryAfterMs: 0,
    requests: 0,
  };

  for (const source of sources) {
    const outcome = source === 'reddit' ? await fromReddit(settings, sinceMs) : await fromArcticShift(settings, sinceMs);
    result.requests += outcome.requests;
    if (outcome.rateLimited || outcome.failed) {
      if (source === 'reddit') {
        result.rateLimited = result.rateLimited || outcome.rateLimited;
        result.retryAfterMs = outcome.retryAfterMs;
      }
      result.failed = true;
      continue;
    }
    const seen = new Set<string>();
    result.posts = outcome.posts
      .filter((post) => (seen.has(post.id) ? false : (seen.add(post.id), true)))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    result.source = source;
    result.newestCreatedAt = outcome.newestMs ? new Date(outcome.newestMs).toISOString() : '';
    result.complete = outcome.complete;
    result.failed = false;
    break;
  }
  return result;
}
