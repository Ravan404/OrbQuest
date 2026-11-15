import type React from 'react';
import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { t } from '../strings';
import { Button, Dialog } from '../components/ui';

/** Asks before a Steam quest is written into Steam's folder. */
export const SteamQuestDialog: React.FC<{ name: string; onAdd: () => Promise<void>; onClose: () => void }> = ({
  name,
  onAdd,
  onClose,
}) => {
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    await onAdd();
    setBusy(false);
  };

  return (
    <Dialog
      title={t('steamDialogTitle', { name })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            disabled={busy}
            onClick={add}
          >
            {busy ? t('adding') : t('add')}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">{t('steamDialogText')}</p>
    </Dialog>
  );
};
