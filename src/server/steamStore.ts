/**
 * Icons of Steam quests Discord has none for, read from Steam's store when
 * the game database is updated (scripts/update-game-database.ts). The app
 * itself only downloads the icon file (iconStore.ts).
 */

const STORE_ITEMS_URL = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
const TIMEOUT_MS = 30_000;

/** Steam's icon file of an app, a 32 px JPEG on Steam's CDN. */
export function steamIconUrl(appId: number, hash: string): string {
  return `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/${hash}.jpg`;
}

/** The icon hash of each app id Steam answered for; empty when Steam cannot be reached. */
export async function fetchSteamIcons(
  appIds: readonly number[],
  userAgent: string,
  fetchImpl: typeof fetch = fetch
): Promise<Map<number, string>> {
  const icons = new Map<number, string>();
  if (appIds.length === 0) return icons;
  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: { language: 'english', country_code: 'US' },
    data_request: { include_assets: true },
  };
  try {
    const response = await fetchImpl(`${STORE_ITEMS_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return icons;
    const body = (await response.json()) as { response?: { store_items?: unknown[] } };
    for (const raw of body?.response?.store_items ?? []) {
      const item = (raw ?? {}) as { appid?: unknown; assets?: { community_icon?: unknown } };
      const icon = item.assets?.community_icon;
      if (Number.isSafeInteger(item.appid) && typeof icon === 'string' && /^[a-f0-9]{40}$/.test(icon)) {
        icons.set(item.appid as number, icon);
      }
    }
  } catch {
    // Steam unreachable: the quests keep the icon they had (see the update script).
  }
  return icons;
}
