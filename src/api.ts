import type { AppProfile, BufferPreset, CatalogGame, Game } from './types';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface AppSettings {
  soundEnabled: boolean;
  theme: ThemeSetting;
}

export interface TimerSettings {
  targetMinutes: number;
  autoStop: boolean;
  bufferPreset: BufferPreset;
}

export interface GameDraft {
  name: string;
  executableName: string;
  folderPath?: string;
  targetMinutes: number;
  autoStop: boolean;
}

/** Calls the local server. A failed request throws with the server's `{ error }` text when it sent one. */
async function request<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json' } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

const gameUrl = (id: string, action = '') => `/api/games/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

export const api = {
  profile: (signal?: AbortSignal) => request<AppProfile>('/api/profile', { signal }),

  settings: () => request<Partial<AppSettings>>('/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => request<AppSettings>('/api/settings', { method: 'PUT', json: patch }),

  games: () => request<Game[]>('/api/games'),
  rescan: () => request<Game[]>('/api/games/rescan', { method: 'POST' }),

  launch: (game: Game) =>
    request<{ game: Game }>(gameUrl(game.id, 'launch'), {
      method: 'POST',
      json: {
        bufferPreset: game.bufferPreset ?? 'normal',
        targetMinutes: game.targetMinutes ?? 15,
        autoStop: game.autoStop !== false,
      },
    }),
  stop: (id: string) => request<{ game: Game }>(gameUrl(id, 'stop'), { method: 'POST' }),
  stopAll: () => request<{ stoppedCount?: number }>('/api/games/stop-all', { method: 'POST' }),
  resetTimer: (id: string) => request<{ game: Game }>(gameUrl(id, 'reset-timer'), { method: 'POST' }),
  setTimer: (id: string, timer: TimerSettings) => request<{ game: Game }>(gameUrl(id, 'timer'), { method: 'PUT', json: timer }),

  add: (draft: GameDraft) => request<{ game?: Game }>('/api/games', { method: 'POST', json: { ...draft, origin: 'custom' } }),
  /** Adds a catalog game with one of the executables Discord lists for it. */
  addFromCatalog: (game: CatalogGame, executable: string) =>
    request<{ game?: Game }>('/api/games', {
      method: 'POST',
      json: { name: game.name, executableName: executable, appId: game.id, origin: 'catalog' },
    }),
  edit: (id: string, draft: GameDraft) => request<{ game: Game }>(gameUrl(id), { method: 'PATCH', json: draft }),
  remove: (id: string) => request<{ preservedSteamInstall?: boolean }>(gameUrl(id), { method: 'DELETE' }),

  catalogFeatured: (signal?: AbortSignal) => request<CatalogGame[]>('/api/catalog/featured', { signal }),
  catalog: (query: string, signal?: AbortSignal) =>
    request<CatalogGame[]>(`/api/catalog?q=${encodeURIComponent(query)}`, { signal }),
};
