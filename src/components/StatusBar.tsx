import React from 'react';
import { Play, RotateCcw, Square } from 'lucide-react';
import { Game } from '../types';
import { computeGameTimerPhase, formatRuntime } from '../utils/timerUtils';
import { t } from '../strings';
import { Button, IconButton } from './ui';
import { statusChip } from './GameCard';

interface StatusBarProps {
  selectedGame: Game | null;
  runningCount: number;
  onTogglePlay: (game: Game) => void;
  onReset: (game: Game) => void;
  onStopAll: () => void;
}

/** Bottom strip: the selected game with quick controls, and Stop all. */
export const StatusBar: React.FC<StatusBarProps> = ({ selectedGame: game, runningCount, onTogglePlay, onReset, onStopAll }) => {
  const phase = game
    ? computeGameTimerPhase(game.elapsedSeconds, game.targetMinutes ?? 15, game.bufferPreset ?? 'normal', game.warmupRemainingSeconds)
    : null;

  return (
    <footer className="flex h-11 shrink-0 items-center gap-3 border-t border-line bg-surface px-4 text-[13px]">
      {game && phase ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="truncate font-medium text-text">{game.name}</span>
          {statusChip(game, phase)}
          {(game.isRunning || game.elapsedSeconds > 0) && (
            <span className="tabular font-mono text-[12px] text-muted">{formatRuntime(phase.displayElapsedSeconds)}</span>
          )}
          <Button
            id="bottom-quick-toggle-btn"
            size="sm"
            variant={game.isRunning ? 'danger-soft' : 'secondary'}
            icon={game.isRunning ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3 fill-current" />}
            onClick={() => onTogglePlay(game)}
          >
            {game.isRunning ? t('stop') : t('launch')}
          </Button>
          {(game.isRunning || game.elapsedSeconds > 0) && (
            <IconButton id="bottom-quick-reset-btn" label={t('resetTitle')} className="h-7 w-7" onClick={() => onReset(game)}>
              <RotateCcw className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      ) : (
        <span className="flex-1 text-faint">{t('nothingSelected')}</span>
      )}

      <span className={`tabular hidden sm:inline ${runningCount > 0 ? 'text-run' : 'text-faint'}`}>
        {t('runningCount', { n: runningCount })}
      </span>
      <Button
        id="global-stop-all-btn"
        size="sm"
        variant="danger-soft"
        disabled={runningCount === 0}
        icon={<Square className="h-3 w-3 fill-current" />}
        onClick={onStopAll}
      >
        {t('stopAll')}
      </Button>
    </footer>
  );
};
