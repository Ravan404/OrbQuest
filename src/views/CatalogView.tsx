import React, { useEffect, useState } from 'react';
import { ChevronRight, CornerDownLeft, Loader2 } from 'lucide-react';
import { CatalogGame } from '../types';
import { api } from '../api';
import { t } from '../strings';
import { CATALOG_TYPING_DEBOUNCE_MS, MIN_CATALOG_QUERY_LENGTH, catalogSubmitTarget } from '../utils/catalogSearch';
import { Button, Chip, SearchInput, SectionLabel } from '../components/ui';
import { GameIcon } from '../components/GameIcon';

interface CatalogViewProps {
  /** Opens the lookup screen for a game name. */
  onLookUp: (gameName: string) => void;
}

const POPULAR = [
  'Marvel Rivals',
  'Genshin Impact',
  'Honkai: Star Rail',
  'Zenless Zone Zero',
  'Arknights: Endfield',
  'Where Winds Meet',
  'Delta Force',
  'The First Descendant',
  'Roblox',
  'War Thunder',
  'Fortnite',
  'VALORANT',
  'Once Human',
  'Black Myth: Wukong',
  'Apex Legends',
];

const exeLabel = (count: number) => (count === 1 ? t('exeCountOne') : t('exeCount', { n: count }));

const tileClass =
  'flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors';

export const CatalogView: React.FC<CatalogViewProps> = ({ onLookUp }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [database, setDatabase] = useState<CatalogGame[]>([]);

  // The whole local database, shown while nothing is typed. Works offline.
  useEffect(() => {
    const controller = new AbortController();
    api
      .catalogDatabase(controller.signal)
      .then((list) => setDatabase(Array.isArray(list) ? list : []))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Typing searches the local catalog only, after a short pause.
  useEffect(() => {
    const trimmed = query.trim();
    setPicked(null);
    if (trimmed.length < MIN_CATALOG_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .catalog(trimmed, controller.signal)
        .then((list) => setResults(Array.isArray(list) ? list : []))
        .catch((error) => {
          if (error?.name !== 'AbortError') setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, CATALOG_TYPING_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const target = catalogSubmitTarget(query, picked);
  const typed = query.trim().length >= MIN_CATALOG_QUERY_LENGTH;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 px-6 pb-3 pt-5">
        <form
          id="catalog-search-form"
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (target) onLookUp(target);
          }}
        >
          <SearchInput
            id="catalog-search-input"
            className="w-full max-w-md"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('catalogSearch')}
            enterKeyHint="search"
            trailing={
              loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : typed ? (
                <CornerDownLeft className="h-3.5 w-3.5" />
              ) : null
            }
          />
          <Button id="catalog-search-reddit-btn" type="submit" variant="primary" disabled={!target}>
            {t('lookUp')}
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {POPULAR.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setQuery(name)}
              className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted transition-colors hover:border-line-strong hover:text-text"
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2">
        {!typed ? (
          <>
            <div className="mb-3 flex items-baseline gap-3">
              <SectionLabel>{t('catalogDatabase')}</SectionLabel>
              <span className="text-[12px] text-faint">{t('catalogDatabaseHint')}</span>
              <span className="tabular ml-auto text-[12px] text-faint">{t('gameCount', { n: database.length })}</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
              {database.map((game) => (
                <button
                  key={game.name}
                  type="button"
                  onClick={() => setQuery(game.name)}
                  className={`${tileClass} border-line bg-surface hover:border-line-strong`}
                >
                  <GameIcon name={game.name} src={game.icon} size="sm" />
                  <span className="truncate text-[13px] text-text">{game.name}</span>
                  <span className="tabular ml-auto shrink-0 text-[11px] text-faint">{exeLabel(game.executableCount ?? 0)}</span>
                </button>
              ))}
            </div>
          </>
        ) : results.length === 0 && !loading ? (
          <div className="mt-16 text-center">
            <p className="text-[14px] text-muted">{t('catalogNoMatch', { query: query.trim() })}</p>
            <Button id="catalog-search-online-btn" variant="primary" className="mt-4" onClick={() => onLookUp(query.trim())}>
              {t('searchOnline')}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
            {results.map((game) => {
              const active = picked === game.name;
              return (
                <div
                  key={`${game.source}-${game.name}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setPicked(game.name)}
                  onDoubleClick={() => onLookUp(game.name)}
                  onKeyDown={(event) => event.key === 'Enter' && onLookUp(game.name)}
                  className={`${tileClass} cursor-default ${
                    active ? 'border-primary bg-surface' : 'border-line bg-surface hover:border-line-strong'
                  }`}
                >
                  <GameIcon name={game.name} src={game.icon} size="sm" />
                  <span className="truncate text-[13px] text-text">{game.name}</span>
                  {game.source === 'database' && <Chip tone="run">{t('database')}</Chip>}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    icon={<ChevronRight className="order-last h-3.5 w-3.5" />}
                    onClick={(event) => {
                      event.stopPropagation();
                      onLookUp(game.name);
                    }}
                  >
                    {t('lookUp')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
