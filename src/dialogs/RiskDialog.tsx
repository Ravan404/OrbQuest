import type React from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '../strings';
import { Button, Dialog } from '../components/ui';

const REPORTS_URL = 'https://github.com/Ravan404/OrbQuest/blob/main/docs/alternatives.md#what-users-have-reported';

/**
 * The risk of using OrbQuest, shown until it is accepted. Closing it any other
 * way only hides it until the next start.
 */
export const RiskDialog: React.FC<{ onAccept: () => void; onClose: () => void }> = ({ onAccept, onClose }) => (
  <Dialog
    title={t('riskTitle')}
    onClose={onClose}
    footer={
      <>
        <a
          href={REPORTS_URL}
          target="_blank"
          rel="noreferrer"
          className="mr-auto flex items-center gap-1 text-[13px] text-muted hover:text-text"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('riskDetails')}
        </a>
        <Button variant="primary" onClick={onAccept}>
          {t('riskAccept')}
        </Button>
      </>
    }
  >
    <p className="text-[13px] text-muted">{t('riskText')}</p>
  </Dialog>
);
