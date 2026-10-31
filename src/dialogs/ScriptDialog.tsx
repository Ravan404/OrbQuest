import React, { useMemo, useState } from 'react';
import { Clipboard, Download } from 'lucide-react';
import { Game } from '../types';
import { t } from '../strings';
import { buildStartScripts, ScriptKind, SCRIPT_LABELS, scriptFileName } from '../utils/startScripts';
import { Button, Dialog, Segmented } from '../components/ui';

interface ScriptDialogProps {
  game: Game;
  onClose: () => void;
  onNotice: (title: string, text: string, tone?: 'info' | 'warning') => void;
}

export const ScriptDialog: React.FC<ScriptDialogProps> = ({ game, onClose, onNotice }) => {
  const [kind, setKind] = useState<ScriptKind>('bat');
  const scripts = useMemo(() => buildStartScripts(game), [game]);
  const fileName = scriptFileName(game, kind);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(scripts[kind]);
      onNotice(t('copied'), fileName);
    } catch {
      onNotice(t('noticeError'), t('copyFailed'), 'warning');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([scripts[kind]], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    onNotice(t('downloaded'), fileName);
  };

  return (
    <Dialog
      width="lg"
      title={t('scriptTitle')}
      subtitle={game.name}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto truncate font-mono text-[12px] text-faint">{fileName}</span>
          <Button icon={<Clipboard className="h-3.5 w-3.5" />} onClick={copy}>
            {t('copy')}
          </Button>
          <Button variant="primary" icon={<Download className="h-3.5 w-3.5" />} onClick={download}>
            {t('download')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{t('scriptHelp')}</p>
      <Segmented
        value={kind}
        onChange={setKind}
        options={(Object.keys(SCRIPT_LABELS) as ScriptKind[]).map((key) => ({ value: key, label: SCRIPT_LABELS[key] }))}
      />
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-sunken p-4 font-mono text-[12px] leading-[1.5] text-text">
        {scripts[kind]}
      </pre>
    </Dialog>
  );
};
