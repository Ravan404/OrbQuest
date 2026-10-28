import React, { useMemo, useState } from 'react';
import { ChevronRight, Plus, Square, Trash2 } from 'lucide-react';
import { Game } from '../types';
import type { TimerSettings } from '../api';
import { t } from '../strings';
import { Button, SearchInput, Segmented, popClass } from '../components/ui';
import { GameCard } from '../components/GameCard';
import { TimerMenu } from '../components/TimerMenu';

interface LibraryViewProps {
  games: Game[];
  selectedGameId: string | null;
  onSelectGame: (game: Game) => void;
  onTogglePlay: (game: Game) => void;
  onSetTimer: (game: Game, timer: TimerSettings) => void;
  onResetTimer: (game: Game) => void;
  onRemove: (game: Game) => void;
  onScript: (game: Game) => void;
  onEdit: (game: Game) => void;
  onAddGame: () => void;
  onOpenCatalog: () => void;
  onStopMany: (ids: string[]) => void;
  onRemoveMany: (ids: string[]) => void;
}

type Filter = 'all' | 'running' | 'custom';

export const LibraryView: React.FC<LibraryViewProps> = ({
  games,
  selectedGameId,
  onSelectGame,
  onTogglePlay,
  onSetTimer,
  onResetTimer,
  onRemove,
  onScript,
  onEdit,
  onAddGame,
  onOpenCatalog,
  onStopMany,
  onRemoveMany,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [timerMenu, setTimerMenu] = useState<{ gameId: string; anchor: HTMLElement } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [confirmRemoveMany, setConfirmRemoveMany] = useState(false);

  const runningCount = games.filter((game) => game.isRunning).length;
  const customCount = games.filter((game) => game.origin === 'custom').length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((game) => {
      if (filter === 'running' && !game.isRunning) return false;
      if (filter === 'custom' && game.origin !== 'custom') return false;
      if (!q) return true;
      return [game.name, game.executable, game.folder].some((value) => value.toLowerCase().includes(q));
    });
  }, [games, query, filter]);

  // A game removed elsewhere (its own Remove button, a rescan) drops out of the selection.
  const markedIds = useMemo(() => games.filter((game) => marked.has(game.id)).map((game) => game.id), [games, marked]);
  const allVisibleMarked = visible.length > 0 && visible.every((game) => marked.has(game.id));
  const timerGame = timerMenu ? games.find((game) => game.id === timerMenu.gameId) : undefined;

  const toggleMark = (id: string) => {
    setConfirmRemoveMany(false);
    setMarked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const stopSelecting = () => {
    setSelecting(false);
    setMarked(new Set());
    setConfirmRemoveMany(false);
  };

  const filterOptions: { value: Filter; label: React.ReactNode }[] = [
    { value: 'all', label: <>{t('filterAll')} <span className="tabular text-faint">{games.length}</span></> },
    { value: 'running', label: <>{t('filterRunning')} <span className="tabular text-faint">{runningCount}</span></> },
  ];
  if (customCount > 0) {
    filterOptions.push({ value: 'custom', label: <>{t('filterCustom')} <span className="tabular text-faint">{customCount}</span></> });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-5">
        <SearchInput
          id="library-search-input"
          className="w-64"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('search')}
        />
        <Segmented value={filter} onChange={setFilter} options={filterOptions} />
        <div className="ml-auto flex items-center gap-2">
          {selecting ? (
            <>
              <Button
                variant="ghost"
                onClick={() =>
                  setMarked((previous) => {
                    const next = new Set(previous);
                    visible.forEach((game) => (allVisibleMarked ? next.delete(game.id) : next.add(game.id)));
                    return next;
                  })
                }
              >
                {allVisibleMarked ? t('selectNone') : t('selectAll')}
              </Button>
              <Button onClick={stopSelecting}>{t('doneSelecting')}</Button>
            </>
          ) : (
            <>
              <Button onClick={() => setSelecting(true)} disabled={games.length === 0}>
                {t('select')}
              </Button>
              <Button id="explore-catalog-btn" onClick={onOpenCatalog} icon={<ChevronRight className="order-last h-3.5 w-3.5" />}>
                {t('navCatalog')}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-1" onScroll={() => timerMenu && setTimerMenu(null)}>
        {games.length === 0 ? (
          <div className="mx-auto mt-16 max-w-sm text-center">
            <h2 className="text-[16px] font-semibold text-text">{t('libraryEmpty')}</h2>
            <p className="mt-1 text-[13px] text-muted">{t('libraryEmptyHint')}</p>
            <div className="mt-5 flex justify-center gap-2">
              <Button id="empty-open-catalog-btn" variant="primary" onClick={onOpenCatalog}>
                {t('browseCatalog')}
              </Button>
              <Button id="empty-add-game-btn" onClick={onAddGame} icon={<Plus className="h-3.5 w-3.5" />}>
                {t('addGame')}
              </Button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="text-[14px] text-muted">{query.trim() ? t('noMatch', { query: query.trim() }) : t('filterEmpty')}</p>
            {query.trim() && (
              <Button id="no-match-open-catalog-btn" className="mt-4" onClick={onOpenCatalog}>
                {t('browseCatalog')}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
            {visible.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                selected={game.id === selectedGameId}
                marked={selecting ? marked.has(game.id) : undefined}
                onMark={() => toggleMark(game.id)}
                onSelect={() => onSelectGame(game)}
                onTogglePlay={() => onTogglePlay(game)}
                onOpenTimer={(anchor) => setTimerMenu({ gameId: game.id, anchor })}
                onReset={() => onResetTimer(game)}
                onScript={() => onScript(game)}
                onEdit={() => onEdit(game)}
                onRemove={() => onRemove(game)}
              />
            ))}
          </div>
        )}
      </div>

      {selecting && markedIds.length > 0 && (
        <div className={`animate-enter mx-6 mb-4 flex shrink-0 items-center gap-2 px-4 py-2.5 text-[13px] ${popClass}`}>
          <span className="tabular mr-2 font-medium text-text">{t('markedCount', { n: markedIds.length })}</span>
          <Button
            icon={<Square className="h-3 w-3" />}
            onClick={() => {
              onStopMany(markedIds);
              stopSelecting();
            }}
          >
            {t('stopMarked')}
          </Button>
          <Button
            variant={confirmRemoveMany ? 'danger' : 'danger-soft'}
            icon={<Trash2 className="h-3 w-3" />}
            onClick={() => {
              if (!confirmRemoveMany) {
                setConfirmRemoveMany(true);
                return;
              }
              onRemoveMany(markedIds);
              stopSelecting();
            }}
          >
            {confirmRemoveMany ? t('confirmRemoveMarked', { n: markedIds.length }) : t('removeMarked')}
          </Button>
        </div>
      )}

      {timerMenu && timerGame && !timerGame.isRunning && (
        <TimerMenu
          game={timerGame}
          anchor={timerMenu.anchor}
          onChange={(timer) => onSetTimer(timerGame, timer)}
          onReset={() => onResetTimer(timerGame)}
          onClose={() => setTimerMenu(null)}
        />
      )}
    </div>
  );
};
