import React, { useEffect, useState } from 'react';
import { Check, Loader2, Plus } from 'lucide-react';
import { CatalogGame } from '../types';
import { api } from '../api';
import { t } from '../strings';
import { preferredExecutable } from '../utils/executables';
import { Button, Chip, SearchInput, SectionLabel } from '../components/ui';
import { GameIcon } from '../components/GameIcon';

interface CatalogViewProps {
  /** Number of games in Discord's list, for the hint under the search. */
  databaseSize?: number;
  onAdded: (name: string) => void;
  onError: (message: string) => void;
  onAddCustom: () => void;
}

/** Typing searches after this pause; the search itself is local and instant. */
const TYPING_DEBOUNCE_MS = 150;
const MIN_QUERY_LENGTH = 2;

/** One game: icon, name, the executable to use, and Add. */
const CatalogTile: React.FC<{
  game: CatalogGame;
  onAdd: (game: CatalogGame, executable: string) => Promise<void>;
}> = ({ game, onAdd }) => {
  const [executable, setExecutable] = useState(() => preferredExecutable(game));
  const [busy, setBusy] = useState(false);
  const exeId = `exe-${game.id}`;

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
      <GameIcon name={game.name} src={game.icon} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-text" title={game.name}>
          {game.name}
        </p>
        {game.executables.length > 1 ? (
          <select
            id={exeId}
            aria-label={t('executable')}
            value={executable}
            onChange={(event) => setExecutable(event.target.value)}
            className="mt-0.5 w-full max-w-full truncate rounded border border-line bg-surface font-mono text-[11px] text-faint focus:border-primary focus:outline-none"
          >
            {game.executables.map((exe) => (
              <option key={exe} value={exe}>
                {exe}
              </option>
            ))}
          </select>
        ) : (
          <p className="truncate font-mono text-[11px] text-faint" title={executable}>
            {executable}
          </p>
        )}
      </div>
      {game.inLibrary ? (
        <Chip tone="run">
          <Check className="h-3 w-3" />
          {t('inLibrary')}
        </Chip>
      ) : (
        <Button
          size="sm"
          icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onAdd(game, executable);
            setBusy(false);
          }}
        >
          {busy ? t('adding') : t('add')}
        </Button>
      )}
    </div>
  );
};

export const CatalogView: React.FC<CatalogViewProps> = ({ databaseSize, onAdded, onError, onAddCustom }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogGame[]>([]);
  const [featured, setFeatured] = useState<CatalogGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .catalogFeatured(controller.signal)
      .then((list) => setFeatured(Array.isArray(list) ? list : []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
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
    }, TYPING_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, refresh]);

  const add = async (game: CatalogGame, executable: string) => {
    try {
      await api.addFromCatalog(game, executable);
      onAdded(game.name);
      setRefresh((n) => n + 1);
    } catch (error) {
      onError((error as Error)?.message || t('addFailed'));
    }
  };

  const typed = query.trim().length >= MIN_QUERY_LENGTH;
  const shown = typed ? results : featured;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 px-6 pb-3 pt-5">
        <SearchInput
          id="catalog-search-input"
          className="w-full max-w-md"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('catalogSearch')}
          enterKeyHint="search"
          trailing={loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        />
        {databaseSize ? (
          <p className="text-[12px] text-faint">{t('catalogFeaturedHint', { n: databaseSize.toLocaleString('en') })}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2">
        {typed && !loading && results.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="text-[14px] text-muted">{t('catalogNoMatch', { query: query.trim() })}</p>
            <Button variant="primary" className="mt-4" icon={<Plus className="h-3.5 w-3.5" />} onClick={onAddCustom}>
              {t('catalogAddCustom')}
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-baseline gap-3">
              <SectionLabel>{!typed ? t('catalogFeatured') : shown.length === 1 ? t('catalogResultOne') : t('catalogResults', { n: shown.length })}</SectionLabel>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
              {shown.map((game) => (
                <CatalogTile key={game.id} game={game} onAdd={add} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
