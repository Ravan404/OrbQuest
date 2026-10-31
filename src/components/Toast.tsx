import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { ToastNotification } from '../types';
import { IconButton, popClass } from './ui';

const DOT: Record<NonNullable<ToastNotification['type']>, string> = {
  milestone: 'bg-run',
  success: 'bg-run',
  warning: 'bg-danger',
  info: 'bg-faint',
};

/** Short notice in the lower right corner. Hides itself after a few seconds. */
export const Toast: React.FC<{ notice: ToastNotification | null; onDismiss: () => void }> = ({ notice, onDismiss }) => {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onDismiss, notice.type === 'milestone' ? 8000 : 4500);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;

  return (
    <div
      key={notice.id}
      id="phone-notification-banner"
      role="status"
      aria-live="polite"
      className={`animate-enter fixed bottom-14 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 py-3 pl-4 pr-2 ${popClass}`}
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[notice.type ?? 'info']}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-text">{notice.title}</div>
        <div className="mt-0.5 break-words text-[13px] leading-snug text-muted">{notice.message}</div>
      </div>
      <IconButton label="Dismiss" className="h-6 w-6" onClick={onDismiss}>
        <X className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
};
