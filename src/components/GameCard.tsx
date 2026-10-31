import React, { useState } from 'react';
import { Clock, Pencil, Play, RotateCcw, Square, Terminal, Trash2 } from 'lucide-react';
import { Game } from '../types';
import { computeGameTimerPhase, formatRuntime, GameTimerPhase } from '../utils/timerUtils';
import { t } from '../strings';
import { Button, Chip, IconButton } from './ui';
import { GameIcon } from './GameIcon';

interface GameCardProps {
  game: Game;
  selected: boolean;
  /** Shown in select mode; `undefined` hides the checkbox. */
  marked?: boolean;
  onMark: () => void;
  onSelect: () => void;
  onTogglePlay: () => void;
  onOpenTimer: (anchor: HTMLElement) => void;
  onReset: () => void;
  onScript: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

const formatTarget = (minutes: number) => {
  if (minutes === 0) return '∞';
  if (minutes < 60) return t('minutesShort', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

export function statusChip(game: Game, phase: GameTimerPhase) {
  if (game.isRunning && phase.phase === 'detecting') {
    return <Chip tone="wait">{t('waiting', { n: phase.remainingBeforeActive })}</Chip>;
  }
  if (game.isRunning && phase.phase === 'finalizing') {
    const left = Math.max(0, phase.totalDurationSeconds - Math.floor(game.elapsedSeconds));
    return <Chip tone="wait">{t('finishing', { n: left })}</Chip>;
  }
  if (phase.phase === 'completed') return <Chip tone="run">{t('done')}</Chip>;
  if (game.isRunning) return <Chip tone="run" dot>{t('running')}</Chip>;
  return <Chip>{t('idle')}</Chip>;
}

export const GameCard: React.FC<GameCardProps> = ({
  game,
  selected,
  marked,
  onMark,
  onSelect,
  onTogglePlay,
  onOpenTimer,
  onReset,
  onScript,
  onEdit,
  onRemove,
}) => {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const running = game.isRunning;
  const isCatalog = game.origin === 'catalog';
  const targetMinutes = game.targetMinutes ?? 15;
  const phase = computeGameTimerPhase(
    game.elapsedSeconds,
    targetMinutes,
    game.bufferPreset ?? 'normal',
    game.warmupRemainingSeconds
  );
  // Seconds inside the detection wait are not counted, so 00:00 is not worth a line.
  const hasTime = running || phase.displayElapsedSeconds > 0 || phase.phase === 'completed';
  const selectMode = marked !== undefined;

  return (
    <article
      id={`game-card-${game.id}`}
      onClick={selectMode ? onMark : onSelect}
      className={`relative flex flex-col overflow-hidden rounded-xl border bg-surface transition-colors ${
        marked ? 'border-primary' : selected ? 'border-line-strong ring-1 ring-line-strong' : 'border-line hover:border-line-strong'
      }`}
    >
      {selectMode && (
        <input
          type="checkbox"
          checked={marked}
          onChange={onMark}
          onClick={(event) => event.stopPropagation()}
          aria-label={t('selectGame', { name: game.name })}
          className="absolute right-3 top-3 z-10 h-4 w-4"
        />
      )}

      <div className="flex gap-3.5 p-4 pb-3">
        <GameIcon name={game.name} src={game.logoUrl} size="lg" />
        <div className="min-w-0 flex-1 pr-5">
          <h3 className="truncate text-[15px] font-semibold text-text" title={game.name}>
            {game.name}
          </h3>
          <p className="truncate font-mono text-[11px] text-faint" title={`${game.folder}\\${game.executable}`}>
            {game.executable}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {statusChip(game, phase)}
            {(game.origin ?? 'scanned') === 'custom' && <Chip tone="outline">{t('tagCustom')}</Chip>}
          </div>
        </div>
      </div>

      <div className="mt-auto flex items-center gap-0.5 px-3 pb-3" onClick={(event) => event.stopPropagation()}>
        {confirmRemove ? (
          <>
            <span className="flex-1 px-1 text-[13px] text-danger">{t('confirmRemove')}</span>
            <Button
              id={`confirm-delete-${game.id}`}
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            >
              {t('yes')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              {t('cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button
              id={`play-stop-btn-${game.id}`}
              variant={running ? 'danger-soft' : 'primary'}
              className="mr-1 flex-1"
              icon={running ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3 fill-current" />}
              onClick={onTogglePlay}
            >
              {running ? t('stop') : t('launch')}
            </Button>
            <Button
              id={`timer-btn-${game.id}`}
              variant="ghost"
              className="tabular shrink-0 px-2"
              disabled={running}
              title={running ? t('timerLocked') : t('timer')}
              icon={<Clock className="h-3.5 w-3.5" />}
              onClick={(event) => onOpenTimer(event.currentTarget)}
            >
              {formatTarget(targetMinutes)}
            </Button>
            <IconButton label={t('script')} onClick={onScript}>
              <Terminal className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              label={isCatalog ? t('editLockedCatalog') : running ? t('editLockedRunning') : t('edit')}
              disabled={running || isCatalog}
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton id={`delete-game-btn-${game.id}`} label={t('remove')} tone="danger" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </>
        )}
      </div>

      {hasTime && (
        <div className="flex items-center gap-2 px-4 pb-2 text-[11px] text-faint" onClick={(event) => event.stopPropagation()}>
          <span className="tabular font-mono">
            {formatRuntime(phase.displayElapsedSeconds)}
            {phase.targetSeconds > 0 && ` / ${formatRuntime(phase.targetSeconds)}`}
          </span>
          <button
            id={`reset-timer-btn-${game.id}`}
            type="button"
            onClick={onReset}
            title={t('resetTitle')}
            className="ml-auto flex items-center gap-1 rounded px-1 hover:text-text"
          >
            <RotateCcw className="h-3 w-3" />
            {t('reset')}
          </button>
        </div>
      )}
      <div className="h-[3px] w-full bg-sunken">
        {hasTime && phase.targetSeconds > 0 && (
          <div
            className={`h-full transition-[width] duration-500 ${phase.phase === 'detecting' ? 'bg-wait' : running ? 'bg-run' : 'bg-faint'}`}
            style={{ width: `${phase.progressPct}%` }}
          />
        )}
      </div>
    </article>
  );
};
