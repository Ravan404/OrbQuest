import { useEffect, type MutableRefObject } from 'react';
import type { Game } from '../types';
import { playMilestoneSound } from '../utils/audio';
import { t } from '../strings';

/**
 * Merges the server's list into the one on screen: games the server no longer
 * has are dropped, new ones are appended, the server's copy of each game wins
 * and the on-screen order is kept.
 */
export function mergePolledGames(previous: Game[], serverGames: Game[]): Game[] {
  const serverById = new Map(serverGames.map((game) => [game.id, game]));
  const merged: Game[] = [];
  for (const local of previous) {
    const server = serverById.get(local.id);
    if (!server) continue;
    serverById.delete(local.id);
    merged.push(server);
  }
  for (const server of serverById.values()) merged.push(server);
  return merged;
}

type SetGames = React.Dispatch<React.SetStateAction<Game[]>>;

interface PollerOptions {
  setGames: SetGames;
  celebratedGamesRef: MutableRefObject<Set<string>>;
  bufferResetTriggersRef: MutableRefObject<Set<string>>;
  soundEnabled: boolean;
  showToast: (title: string, message: string, type?: 'success' | 'info' | 'milestone' | 'warning') => void;
}

/**
 * Polls /api/games once per second, keeps the on-screen timers in sync with
 * the server, and shows a notice when a timer finishes. Stopping the process
 * at the end is the server's job.
 */
export function useGamePoller({
  setGames,
  celebratedGamesRef,
  bufferResetTriggersRef,
  soundEnabled,
  showToast,
}: PollerOptions): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch('/api/games');
        if (!res.ok) throw new Error(`Status poll: ${res.status}`);
        const serverGames: Game[] = await res.json();
        if (cancelled) return;
        for (const game of serverGames) {
          if (bufferResetTriggersRef.current.delete(game.id)) celebratedGamesRef.current.delete(game.id);
          if (game.completed && !celebratedGamesRef.current.has(game.id)) {
            celebratedGamesRef.current.add(game.id);
            if (soundEnabled) playMilestoneSound();
            showToast(
              t('noticeFinished'),
              t(game.autoStop !== false ? 'noticeFinishedStopped' : 'noticeFinishedRunning', {
                name: game.name,
                mins: game.targetMinutes ?? 15,
              }),
              'milestone'
            );
          }
        }
        setGames((prev) => mergePolledGames(prev, serverGames));
      } catch (error) {
        console.warn('Failed to fetch games for status check', error);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setGames, celebratedGamesRef, bufferResetTriggersRef, soundEnabled, showToast]);
}
