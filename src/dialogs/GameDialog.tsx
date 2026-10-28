import React, { useState } from 'react';
import { Game, MAX_QUEST_TARGET_MINUTES } from '../types';
import type { GameDraft } from '../api';
import { clampTargetMinutes } from '../utils/timerUtils';
import { t } from '../strings';
import { Button, Dialog, Segmented, TextInput } from '../components/ui';

interface GameDialogProps {
  /** The entry to edit; leave it out to add a new game. */
  game?: Game | null;
  onClose: () => void;
  /** Throws to keep the dialog open and show the message. */
  onSubmit: (draft: GameDraft) => Promise<void>;
}

type Duration = 15 | 10 | 5 | 1 | 0 | 'custom';

const PRESETS: Duration[] = [15, 10, 5, 1, 0];

function initialDuration(minutes: number): { duration: Duration; custom: string } {
  // 0 is "no limit" and must stay 0, not fall through to a custom 15.
  const preset = PRESETS.find((value) => value === minutes);
  if (preset !== undefined) return { duration: preset, custom: String(minutes || 15) };
  return { duration: 'custom', custom: String(minutes > 0 ? minutes : 15) };
}

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block space-y-1.5">
    <span className="block text-[12px] font-medium text-muted">{label}</span>
    {children}
    {hint && <span className="block text-[12px] text-faint">{hint}</span>}
  </label>
);

export const GameDialog: React.FC<GameDialogProps> = ({ game, onClose, onSubmit }) => {
  const editing = Boolean(game);
  // A Steam install keeps the folder and executable its manifest names.
  const filesLocked = Boolean(game?.specialRootPath);
  const start = initialDuration(game?.targetMinutes ?? 15);

  const [name, setName] = useState(game?.name ?? '');
  const [exe, setExe] = useState(game?.executable ?? '');
  const [folder, setFolder] = useState(game?.folder ?? '');
  const [duration, setDuration] = useState<Duration>(start.duration);
  const [customMinutes, setCustomMinutes] = useState(start.custom);
  const [autoStop, setAutoStop] = useState(game ? game.autoStop !== false : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim() !== '' && exe.trim() !== '' && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    let executableName = exe.trim();
    if (!executableName.toLowerCase().endsWith('.exe')) executableName += '.exe';
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        executableName,
        folderPath: folder.trim() || undefined,
        targetMinutes: duration === 'custom' ? clampTargetMinutes(parseInt(customMinutes, 10)) : duration,
        autoStop,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || t('updateFailed'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={editing ? t('dialogEdit') : t('dialogAdd')}
      subtitle={editing ? game?.name : undefined}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button id="custom-game-submit-btn" type="submit" form="game-dialog-form" variant="primary" disabled={!canSubmit}>
            {busy ? (editing ? t('saving') : t('adding')) : editing ? t('save') : t('addToLibrary')}
          </Button>
        </>
      }
    >
      <form id="game-dialog-form" onSubmit={submit} className="space-y-4">
        {error && <p className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2 text-[13px] text-danger">{error}</p>}

        <Field label={t('fieldName')}>
          <TextInput
            id="custom-game-name-input"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('fieldNamePlaceholder')}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fieldExe')}>
            <TextInput
              id="custom-game-exe-input"
              required
              className="font-mono"
              value={exe}
              readOnly={filesLocked}
              onChange={(event) => setExe(event.target.value)}
              placeholder={t('fieldExePlaceholder')}
            />
          </Field>
          <Field label={t('fieldFolder')}>
            <TextInput
              value={folder}
              readOnly={filesLocked}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t('fieldFolderPlaceholder')}
            />
          </Field>
        </div>
        {filesLocked && <p className="-mt-2 text-[12px] text-faint">{t('fieldFolderLocked')}</p>}

        <div className="space-y-2">
          <span className="block text-[12px] font-medium text-muted">{t('fieldTimer')}</span>
          <Segmented
            className="w-full"
            value={duration}
            onChange={setDuration}
            options={[
              ...PRESETS.map((value) => ({
                value,
                label: value === 0 ? '∞' : t('minutesShort', { n: value }),
                title: value === 0 ? t('noLimit') : undefined,
              })),
              { value: 'custom' as Duration, label: t('custom') },
            ]}
          />
          {duration === 'custom' && (
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <TextInput
                type="number"
                min={1}
                max={MAX_QUEST_TARGET_MINUTES}
                className="tabular w-24"
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
              />
              {t('minutes')}
            </div>
          )}
          <label className="flex items-center gap-2 pt-1 text-[13px] text-muted hover:text-text">
            <input type="checkbox" checked={autoStop} onChange={(event) => setAutoStop(event.target.checked)} className="h-3.5 w-3.5" />
            {t('stopAtEnd')}
          </label>
        </div>
      </form>
    </Dialog>
  );
};
