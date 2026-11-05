import type React from 'react';
import { ArrowUpCircle, Moon, Plus, RefreshCw, Sun, Volume2, VolumeX } from 'lucide-react';
import type { UpdateInfo } from '../types';
import { t } from '../strings';
import { Button, IconButton } from './ui';

export type View = 'library' | 'catalog' | 'about';

const UPDATE_PILL =
  'flex items-center gap-1 self-center rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-on-primary hover:bg-primary-hover';

interface TopBarProps {
  version: string;
  /** A newer release: a button when the app installs it itself, else a link to its page. */
  update: UpdateInfo | null;
  installable: boolean;
  onInstallUpdate: () => void;
  view: View;
  onView: (view: View) => void;
  runningCount: number;
  /** The dark theme is on screen. */
  dark: boolean;
  onToggleTheme: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onRescan: () => void;
  onAddGame: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  version,
  update,
  installable,
  onInstallUpdate,
  view,
  onView,
  runningCount,
  dark,
  onToggleTheme,
  soundEnabled,
  onToggleSound,
  onRescan,
  onAddGame,
}) => {
  const tabs: { id: View; label: string }[] = [
    { id: 'library', label: t('navLibrary') },
    { id: 'catalog', label: t('navCatalog') },
    { id: 'about', label: t('navAbout') },
  ];

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-surface px-4">
      <div className="mr-5 flex items-baseline gap-2">
        <span className="text-[14px] font-semibold tracking-tight text-text">{t('appTitle')}</span>
        <span className="tabular text-[11px] text-faint">{version}</span>
        {update && installable && (
          <button
            id="update-available-link"
            type="button"
            onClick={onInstallUpdate}
            title={t('updateInstallTitle', { version: update.version })}
            className={UPDATE_PILL}
          >
            <ArrowUpCircle className="h-3 w-3" />
            {t('updateAvailable', { version: update.version })}
          </button>
        )}
        {update && !installable && (
          <a
            id="update-available-link"
            href={update.url}
            target="_blank"
            rel="noreferrer"
            title={t('updateTitle', { version: update.version })}
            className={UPDATE_PILL}
          >
            <ArrowUpCircle className="h-3 w-3" />
            {t('updateAvailable', { version: update.version })}
          </a>
        )}
      </div>

      <nav className="flex h-full items-stretch" aria-label="Views">
        {tabs.map((tab) => {
          const active = tab.id === view;
          return (
            <button
              key={tab.id}
              id={`nav-${tab.id}`}
              type="button"
              onClick={() => onView(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex items-center gap-1.5 px-3 text-[13px] transition-colors ${
                active ? 'font-medium text-text' : 'text-muted hover:text-text'
              }`}
            >
              {tab.label}
              {tab.id === 'library' && runningCount > 0 && (
                <span className="tabular rounded-full bg-run/15 px-1.5 text-[11px] font-semibold text-run">
                  {runningCount}
                </span>
              )}
              {active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-text" />}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-1">
        {/* Shows the theme a click switches to. */}
        <IconButton id="theme-toggle-btn" label={dark ? t('themeToLight') : t('themeToDark')} onClick={onToggleTheme}>
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </IconButton>
        <IconButton
          id="sound-toggle-btn"
          label={soundEnabled ? t('soundOn') : t('soundOff')}
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        >
          {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </IconButton>
        <Button
          id="header-refresh-btn"
          variant="ghost"
          title={t('rescanTitle')}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={onRescan}
        >
          {t('rescan')}
        </Button>
        <Button
          id="header-add-game-btn"
          variant="primary"
          className="ml-1"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={onAddGame}
        >
          {t('addGame')}
        </Button>
      </div>
    </header>
  );
};
