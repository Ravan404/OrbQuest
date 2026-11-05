import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppProfile, Game, ToastNotification, UpdateStatus } from './types';
import { api, type GameDraft, type ThemeSetting, type TimerSettings } from './api';
import { t } from './strings';
import { useGamePoller } from './hooks/useGamePoller';
import { playClickSound, playLaunchSound, playStopSound } from './utils/audio';
import { TopBar, type View } from './components/TopBar';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { Button } from './components/ui';
import { LibraryView } from './views/LibraryView';
import { CatalogView } from './views/CatalogView';
import { AboutView } from './views/AboutView';
import { GameDialog } from './dialogs/GameDialog';
import { ScriptDialog } from './dialogs/ScriptDialog';
import { UpdateDialog } from './dialogs/UpdateDialog';

type NoticeTone = NonNullable<ToastNotification['type']>;

/** How often the window asks the local server whether a new release was found. */
const UPDATE_POLL_MS = 5 * 60 * 1000;

/** Pins the page to a theme; `system` leaves it to the Windows setting. */
function applyTheme(theme: ThemeSetting) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether Windows uses dark apps; follows changes while the app is open. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const update = () => setDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return dark;
}

export default function App() {
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  const [games, setGames] = useState<Game[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [view, setView] = useState<View>('library');

  const [soundEnabled, setSoundEnabled] = useState(true);
  // The server puts the saved theme on the page (server.ts).
  const [theme, setTheme] = useState<ThemeSetting>(() => {
    const saved = document.documentElement.dataset.theme;
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });

  const [notice, setNotice] = useState<ToastNotification | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'add' | 'update' } | { kind: 'edit' | 'script'; game: Game } | null>(
    null
  );

  // Games that already showed their "timer finished" notice, and games whose
  // notice may fire again after a reset or a new launch.
  const celebratedGamesRef = useRef<Set<string>>(new Set());
  const bufferResetTriggersRef = useRef<Set<string>>(new Set());

  const showNotice = useCallback((title: string, message: string, type: NoticeTone = 'info') => {
    setNotice({ id: String(Date.now()), title, message, type });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const click = () => {
    if (soundEnabled) playClickSound();
  };

  useEffect(() => applyTheme(theme), [theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: profileAttempt is the Retry button's trigger.
  useEffect(() => {
    const controller = new AbortController();
    setProfileFailed(false);
    api
      .profile(controller.signal)
      .then(setProfile)
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        console.error('Could not load the app profile:', error);
        setProfileFailed(true);
      });
    return () => controller.abort();
  }, [profileAttempt]);

  // The server asks GitHub for a new release at its start and every six
  // hours; the first answer waits for that first check.
  useEffect(() => {
    const check = () =>
      api
        .update()
        .then(setUpdateStatus)
        .catch(() => {});
    check();
    const timer = window.setInterval(check, UPDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const loadGames = useCallback(async (rescan = false): Promise<Game[] | null> => {
    try {
      const list = rescan ? await api.rescan() : await api.games();
      setGames(list);
      setSelectedGameId((current) => current ?? list[0]?.id ?? null);
      return list;
    } catch (error) {
      console.warn('Could not load games', error);
      return null;
    }
  }, []);

  // First load: settings, then the games.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await api.settings().catch(() => null);
      if (!cancelled && settings) {
        if (typeof settings.soundEnabled === 'boolean') setSoundEnabled(settings.soundEnabled);
        if (settings.theme) setTheme(settings.theme);
      }
      if (!cancelled) await loadGames();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadGames]);

  useGamePoller({ setGames, celebratedGamesRef, bufferResetTriggersRef, soundEnabled, showToast: showNotice });

  const replaceGame = useCallback((updated: Game) => {
    setGames((previous) => previous.map((game) => (game.id === updated.id ? { ...game, ...updated } : game)));
  }, []);

  const selectedGame = useMemo(() => games.find((game) => game.id === selectedGameId) ?? null, [games, selectedGameId]);
  const runningCount = useMemo(() => games.filter((game) => game.isRunning).length, [games]);

  const fail = (error: unknown) =>
    showNotice(t('noticeError'), (error as Error)?.message || t('updateFailed'), 'warning');

  const saveSettings = (patch: Parameters<typeof api.saveSettings>[0]) =>
    api.saveSettings(patch).catch((error) => console.warn('Could not save settings', error));

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) playClickSound();
    saveSettings({ soundEnabled: next });
  };

  // Until the button is used the app follows Windows. The button switches
  // to the other theme of the one on screen, and the choice is kept.
  const systemDark = useSystemDark();
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const toggleTheme = () => {
    click();
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    saveSettings({ theme: next });
  };

  const togglePlay = async (game: Game) => {
    const launching = !game.isRunning;
    if (soundEnabled) {
      if (launching) playLaunchSound();
      else playStopSound();
    }
    try {
      const { game: updated } = launching ? await api.launch(game) : await api.stop(game.id);
      replaceGame(updated);
      bufferResetTriggersRef.current.add(game.id);
      if (launching) showNotice(t('noticeStarted'), t('noticeStartedText', { name: game.name }), 'success');
      else showNotice(t('noticeStopped'), t('noticeStoppedText', { name: game.name }));
    } catch (error) {
      fail(error);
    }
  };

  const setTimer = async (game: Game, timer: TimerSettings) => {
    if (game.isRunning) return;
    click();
    try {
      const { game: updated } = await api.setTimer(game.id, timer);
      replaceGame(updated);
    } catch (error) {
      fail(error);
      return;
    }
    // A new target can be reached again, so its notice may fire again.
    celebratedGamesRef.current.delete(game.id);
    bufferResetTriggersRef.current.add(game.id);
    if (timer.targetMinutes !== (game.targetMinutes ?? 15)) {
      showNotice(
        t('noticeTimer'),
        timer.targetMinutes > 0 ? t('noticeTimerText', { n: timer.targetMinutes }) : t('noticeTimerNoLimit')
      );
    }
  };

  const resetTimer = async (game: Game) => {
    click();
    try {
      const { game: updated } = await api.resetTimer(game.id);
      celebratedGamesRef.current.delete(game.id);
      bufferResetTriggersRef.current.add(game.id);
      replaceGame(updated);
      showNotice(t('noticeReset'), t('noticeResetText', { name: game.name }));
    } catch (error) {
      fail(error);
    }
  };

  const removeGame = async (game: Game) => {
    if (soundEnabled) playStopSound();
    try {
      const result = await api.remove(game.id);
      setGames((previous) => previous.filter((g) => g.id !== game.id));
      setSelectedGameId((current) => (current === game.id ? null : current));
      showNotice(
        t('noticeRemoved'),
        result?.preservedSteamInstall ? t('noticeSteamKept') : t('noticeRemovedText', { name: game.name })
      );
    } catch (error) {
      fail(error);
    }
  };

  const stopAll = async () => {
    if (soundEnabled) playStopSound();
    try {
      const result = await api.stopAll();
      setGames((previous) => previous.map((game) => ({ ...game, isRunning: false })));
      showNotice(t('noticeStopped'), t('noticeStoppedAll', { n: result?.stoppedCount ?? 0 }));
    } catch (error) {
      fail(error);
    }
  };

  /** Runs `action` for every id and returns the ids it worked for. */
  const forEachId = async (ids: string[], action: (id: string) => Promise<unknown>) => {
    const results = await Promise.all(
      ids.map((id) =>
        action(id).then(
          () => true,
          () => false
        )
      )
    );
    return ids.filter((_, index) => results[index]);
  };

  const stopMany = async (ids: string[]) => {
    if (soundEnabled) playStopSound();
    const stopped = await forEachId(ids, api.stop);
    setGames((previous) => previous.map((game) => (stopped.includes(game.id) ? { ...game, isRunning: false } : game)));
    if (stopped.length < ids.length) {
      showNotice(t('noticeError'), t('noticePartial', { done: stopped.length, total: ids.length }), 'warning');
    } else {
      showNotice(t('noticeStopped'), t('noticeStoppedAll', { n: stopped.length }));
    }
  };

  const removeMany = async (ids: string[]) => {
    if (soundEnabled) playStopSound();
    const removed = await forEachId(ids, api.remove);
    setGames((previous) => previous.filter((game) => !removed.includes(game.id)));
    setSelectedGameId((current) => (current && removed.includes(current) ? null : current));
    if (removed.length < ids.length) {
      showNotice(t('noticeError'), t('noticePartial', { done: removed.length, total: ids.length }), 'warning');
    } else {
      showNotice(t('noticeRemoved'), t('noticeRemovedMany', { n: removed.length }));
    }
  };

  // A failure is thrown so the dialog stays open and shows it.
  const addGame = async (draft: GameDraft) => {
    await api.add(draft);
    showNotice(t('noticeAdded'), t('noticeAddedText', { name: draft.name }), 'success');
    loadGames();
  };

  const editGame = async (game: Game, draft: GameDraft) => {
    const { game: updated } = await api.edit(game.id, draft);
    replaceGame(updated);
    showNotice(t('noticeSaved'), t('noticeSavedText', { name: draft.name }), 'success');
    loadGames();
  };

  const rescan = () => {
    click();
    loadGames(true).then((list) => {
      if (list) showNotice(t('noticeRescanned'), t('noticeRescannedText'));
    });
  };

  const openView = (next: View) => {
    click();
    setView(next);
  };

  if (!profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted">
        <span>{profileFailed ? t('serverUnreachable') : t('loading')}</span>
        {profileFailed && <Button onClick={() => setProfileAttempt((attempt) => attempt + 1)}>{t('retry')}</Button>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar
        version={profile.version}
        update={updateStatus?.update ?? null}
        installable={Boolean(updateStatus?.installable)}
        onInstallUpdate={() => setDialog({ kind: 'update' })}
        view={view}
        onView={openView}
        runningCount={runningCount}
        dark={dark}
        onToggleTheme={toggleTheme}
        soundEnabled={soundEnabled}
        onToggleSound={toggleSound}
        onRescan={rescan}
        onAddGame={() => {
          click();
          setDialog({ kind: 'add' });
        }}
      />

      <main className="flex min-h-0 flex-1 flex-col">
        {view === 'library' ? (
          <LibraryView
            games={games}
            selectedGameId={selectedGameId}
            onSelectGame={(game) => {
              click();
              setSelectedGameId(game.id);
            }}
            onTogglePlay={togglePlay}
            onSetTimer={setTimer}
            onResetTimer={resetTimer}
            onRemove={removeGame}
            onScript={(game) => setDialog({ kind: 'script', game })}
            onEdit={(game) => {
              click();
              setDialog({ kind: 'edit', game });
            }}
            onAddGame={() => setDialog({ kind: 'add' })}
            onOpenCatalog={() => openView('catalog')}
            onStopMany={stopMany}
            onRemoveMany={removeMany}
          />
        ) : view === 'catalog' ? (
          <CatalogView
            databaseSize={profile.gameDatabase?.games}
            onAdded={(name) => {
              showNotice(t('noticeAdded'), t('noticeAddedText', { name }), 'success');
              loadGames();
            }}
            onError={(message) => showNotice(t('noticeError'), message, 'warning')}
            onAddCustom={() => {
              click();
              setDialog({ kind: 'add' });
            }}
          />
        ) : (
          <AboutView profile={profile} />
        )}
      </main>

      <StatusBar
        selectedGame={selectedGame}
        runningCount={runningCount}
        onTogglePlay={togglePlay}
        onReset={resetTimer}
        onStopAll={stopAll}
      />

      <Toast notice={notice} onDismiss={dismissNotice} />

      {dialog?.kind === 'add' && <GameDialog onClose={() => setDialog(null)} onSubmit={addGame} />}
      {dialog?.kind === 'edit' && (
        <GameDialog
          game={dialog.game}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => editGame(dialog.game, draft)}
        />
      )}
      {dialog?.kind === 'script' && (
        <ScriptDialog
          game={dialog.game}
          onClose={() => setDialog(null)}
          onNotice={(title, text, tone) => showNotice(title, text, tone === 'warning' ? 'warning' : 'success')}
        />
      )}
      {dialog?.kind === 'update' && updateStatus?.update && (
        <UpdateDialog update={updateStatus.update} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
