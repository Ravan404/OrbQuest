import type React from 'react';
import { useEffect, useState } from 'react';
import { ArrowUpCircle, ExternalLink } from 'lucide-react';
import type { UpdateDownload, UpdateInfo } from '../types';
import { api } from '../api';
import { t } from '../strings';
import { Button, Dialog } from '../components/ui';

/** The desktop app's bridge (desktop_app.py, DesktopApi); missing in a browser. */
type DesktopBridge = { api: { apply_update(): Promise<{ ok: boolean; error?: string }> } };
const desktop = () => (window as Window & { pywebview?: DesktopBridge }).pywebview;

/**
 * Installs a newer release: the server downloads and checks it, then the
 * desktop app closes OrbQuest, installs it and opens OrbQuest again.
 */
export const UpdateDialog: React.FC<{ update: UpdateInfo; onClose: () => void }> = ({ update, onClose }) => {
  const [download, setDownload] = useState<UpdateDownload>({ state: 'idle' });
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');

  const busy = download.state === 'downloading' || restarting;

  // Follows the download while it runs.
  useEffect(() => {
    if (download.state !== 'downloading') return;
    const timer = window.setInterval(() => {
      api
        .update()
        .then((status) => setDownload(status.download))
        .catch(() => {});
    }, 500);
    return () => window.clearInterval(timer);
  }, [download.state]);

  // Ready: the desktop app takes over.
  useEffect(() => {
    if (download.state === 'failed') setError(download.error || t('updateFailedDownload'));
    if (download.state !== 'ready' || restarting) return;
    const bridge = desktop();
    if (!bridge) {
      setError(t('updateNoDesktop'));
      return;
    }
    setRestarting(true);
    bridge.api
      .apply_update()
      .then((result) => {
        if (!result.ok) {
          setRestarting(false);
          setError(result.error || t('updateFailedDownload'));
        }
      })
      .catch(() => setRestarting(false));
  }, [download, restarting]);

  const start = () => {
    setError('');
    api
      .downloadUpdate()
      .then(setDownload)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const percent =
    download.total && download.received !== undefined
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : 0;

  return (
    <Dialog
      title={t('updateDialogTitle', { version: update.version })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <a
            href={update.url}
            target="_blank"
            rel="noreferrer"
            className="mr-auto flex items-center gap-1 text-[13px] text-muted hover:text-text"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('updateWhatsNew')}
          </a>
          <Button onClick={onClose} disabled={busy}>
            {t('updateLater')}
          </Button>
          <Button variant="primary" icon={<ArrowUpCircle className="h-3.5 w-3.5" />} disabled={busy} onClick={start}>
            {t('updateInstall')}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">{t('updateDialogText')}</p>
      {(download.state === 'downloading' || restarting) && (
        <div className="mt-4 space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${restarting ? 100 : percent}%` }}
            />
          </div>
          <p className="tabular text-[12px] text-faint">
            {restarting ? t('updateRestarting') : t('updateDownloading', { percent })}
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
};
