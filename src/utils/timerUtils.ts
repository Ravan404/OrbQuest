import {
  BufferPreset,
  BUFFER_PRESET_DURATIONS,
  MAX_QUEST_TARGET_MINUTES,
} from '../types';

/** Custom timer entry. Presets may still use 0 for unlimited. */
export function clampTargetMinutes(value: number): number {
  if (!Number.isFinite(value)) return 15;
  return Math.min(MAX_QUEST_TARGET_MINUTES, Math.max(1, Math.floor(value)));
}

export interface GameTimerPhase {
  phase: 'detecting' | 'active' | 'finalizing' | 'completed';
  displayElapsedSeconds: number;
  targetSeconds: number;
  progressPct: number;
  statusMessage: string;
  isMilestoneReached: boolean;
  secondsRemainingInQuest: number;
  totalDurationSeconds: number;
  /** Seconds left until the quest countdown itself begins (0 once active). */
  remainingBeforeActive: number;
}

export function formatRuntime(totalSeconds: number): string {
  const safeSec = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSec / 60);
  const seconds = safeSec % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function computeGameTimerPhase(
  elapsedSeconds: number,
  targetMinutes = 15,
  bufferPreset: BufferPreset = 'normal',
  warmupRemainingSeconds = 0,
): GameTimerPhase {
  const config = BUFFER_PRESET_DURATIONS[bufferPreset] || BUFFER_PRESET_DURATIONS.normal;
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  const targetSeconds = Math.max(0, targetMinutes * 60);
  const active = Math.max(0, elapsed - config.start);
  const remainingBeforeActive = Math.max(0, config.start - elapsed, warmupRemainingSeconds);
  const totalDurationSeconds = targetSeconds ? config.total + targetSeconds : 0;
  const detecting = remainingBeforeActive > 0;
  const reached = targetSeconds > 0 && active >= targetSeconds;
  const completed = reached && elapsed >= totalDurationSeconds && !detecting;
  const phase = detecting ? 'detecting' : completed ? 'completed' : reached ? 'finalizing' : 'active';
  return {
    phase,
    displayElapsedSeconds: targetSeconds ? Math.min(active, targetSeconds) : active,
    targetSeconds,
    progressPct: completed ? 100 : targetSeconds ? Math.min(99, Math.floor(active / targetSeconds * 100)) : 0,
    statusMessage: detecting ? `Detection allowance (${remainingBeforeActive}s)`
      : completed ? 'Local timer completed' : reached ? `Final safety margin (${Math.max(0, totalDurationSeconds - elapsed)}s)`
      : 'Quest timer active',
    isMilestoneReached: completed,
    secondsRemainingInQuest: targetSeconds ? Math.max(0, targetSeconds - active) : 0,
    totalDurationSeconds,
    remainingBeforeActive,
  };
}
