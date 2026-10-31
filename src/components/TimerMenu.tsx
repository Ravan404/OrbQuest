import React, { useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { BufferPreset, BUFFER_PRESET_DURATIONS, Game, MAX_QUEST_TARGET_MINUTES } from '../types';
import type { TimerSettings } from '../api';
import { clampTargetMinutes } from '../utils/timerUtils';
import { t } from '../strings';
import { Button, Segmented, SectionLabel, popClass } from './ui';

interface TimerMenuProps {
  game: Game;
  /** The button that opened the menu; the menu sits under it, or above when there is no room. */
  anchor: HTMLElement;
  onChange: (timer: TimerSettings) => void;
  onReset: () => void;
  onClose: () => void;
}

const PRESET_MINUTES = [15, 10, 5, 1, 0];
const BUFFER_PRESETS: BufferPreset[] = ['fast', 'normal', 'long', 'off'];
const PRESET_LABEL: Record<BufferPreset, 'presetFast' | 'presetNormal' | 'presetLong' | 'presetOff'> = {
  fast: 'presetFast',
  normal: 'presetNormal',
  long: 'presetLong',
  off: 'presetOff',
};

export const TimerMenu: React.FC<TimerMenuProps> = ({ game, anchor, onChange, onReset, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const targetMinutes = game.targetMinutes ?? 15;
  const autoStop = game.autoStop !== false;
  const bufferPreset = game.bufferPreset ?? 'normal';
  const [customMinutes, setCustomMinutes] = useState(String(targetMinutes > 0 ? targetMinutes : 15));

  const current: TimerSettings = { targetMinutes, autoStop, bufferPreset };

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const menu = menuRef.current;
      const width = menu?.offsetWidth ?? 300;
      const height = menu?.offsetHeight ?? 320;
      const margin = 8;
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - height - 6);
      }
      setPosition({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  return (
    <>
      <div className="fixed inset-0 z-30" onMouseDown={onClose} />
      <div
        ref={menuRef}
        role="dialog"
        aria-label={t('timer')}
        style={{ top: position.top, left: position.left }}
        className={`animate-enter fixed z-40 w-[300px] space-y-4 p-4 text-[13px] ${popClass}`}
      >
        <div className="space-y-2">
          <SectionLabel>{t('duration')}</SectionLabel>
          <Segmented
            className="w-full"
            value={targetMinutes}
            onChange={(minutes) => {
              onChange({ ...current, targetMinutes: minutes });
              onClose();
            }}
            options={PRESET_MINUTES.map((minutes) => ({
              value: minutes,
              label: minutes === 0 ? '∞' : t('minutesShort', { n: minutes }),
              title: minutes === 0 ? t('noLimit') : undefined,
            }))}
          />
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onChange({ ...current, targetMinutes: clampTargetMinutes(parseInt(customMinutes, 10)) });
              onClose();
            }}
          >
            <span className="text-muted">{t('custom')}</span>
            <input
              type="number"
              min={1}
              max={MAX_QUEST_TARGET_MINUTES}
              value={customMinutes}
              onChange={(event) => setCustomMinutes(event.target.value)}
              className="tabular h-7 w-16 rounded-md border border-line-strong bg-surface px-2 text-text focus:border-primary focus:outline-none"
            />
            <span className="text-muted">{t('minutes')}</span>
            <Button type="submit" size="sm" className="ml-auto">
              {t('set')}
            </Button>
          </form>
        </div>

        <div className="space-y-2">
          <SectionLabel>{t('detection')}</SectionLabel>
          <div className="grid grid-cols-4 gap-1">
            {BUFFER_PRESETS.map((preset) => {
              const info = BUFFER_PRESET_DURATIONS[preset];
              const active = preset === bufferPreset;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange({ ...current, bufferPreset: preset })}
                  className={`flex flex-col items-center rounded-md border py-1.5 ${
                    active ? 'border-primary text-text' : 'border-line text-muted hover:bg-hover hover:text-text'
                  }`}
                >
                  <span className={active ? 'font-medium' : ''}>{t(PRESET_LABEL[preset])}</span>
                  <span className="tabular text-[10px] text-faint">
                    {t('presetSeconds', { start: info.start, end: info.end })}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[12px] leading-snug text-faint">{t('detectionHelp')}</p>
        </div>

        <div className="flex items-center justify-between border-t border-line pt-3">
          <label className="flex items-center gap-2 text-muted hover:text-text">
            <input
              type="checkbox"
              checked={autoStop}
              onChange={(event) => onChange({ ...current, autoStop: event.target.checked })}
              className="h-3.5 w-3.5"
            />
            {t('stopAtEnd')}
          </label>
          {game.elapsedSeconds > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              title={t('resetTitle')}
              onClick={() => {
                onReset();
                onClose();
              }}
            >
              {t('reset')}
            </Button>
          )}
        </div>
      </div>
    </>
  );
};
