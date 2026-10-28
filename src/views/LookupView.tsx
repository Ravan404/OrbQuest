import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, ExternalLink, Globe, Loader2, Plus } from 'lucide-react';
import { SearchMatch } from '../types';
import { api } from '../api';
import { t } from '../strings';
import { Button, Chip, IconButton, SearchInput, Segmented } from '../components/ui';
import { GameIcon } from '../components/GameIcon';

interface LookupViewProps {
  gameName: string;
  onBack: () => void;
  /** Called after a result was added, with the name it was added under. */
  onAdded: (name: string) => void;
  onError: (message: string) => void;
}

type ResultFilter = 'all' | 'database' | 'online' | 'steam';

const exeKey = (match: SearchMatch) => match.executableName.trim().toLowerCase();
const comparable = (value: string | undefined) => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isSteam = (match: SearchMatch) => match.questMethod === 'steam-manifest' || match.source === 'steam-manifest';

/**
 * Executables found for one game: the local database first, Reddit only when
 * asked (Search Reddit) or when the database has nothing.
 */
export const LookupView: React.FC<LookupViewProps> = ({ gameName, onBack, onAdded, onError }) => {
  const [input, setInput] = useState(gameName);
  const [active, setActive] = useState(gameName);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchingOnline, setSearchingOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<{ seconds: number | null } | null>(null);
  const [picked, setPicked] = useState<SearchMatch | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [copied, setCopied] = useState<string | null>(null);

  // Only the newest request may update the screen; older ones are aborted.
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback((game: string, online: boolean) => {
    const clean = game.trim();
    if (!clean) return;
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const id = ++requestId.current;

    setError(null);
    setOnlineError(null);
    if (online) {
      setSearchingOnline(true);
    } else {
      setLoading(true);
      setSearchingOnline(false);
      setMatches([]);
      setPicked(null);
      setFilter('all');
      setRateLimit(null);
    }

    api
      .lookup(clean, online, ctrl.signal)
      .then((data) => {
        if (id !== requestId.current) return;
        const response = Array.isArray(data) ? undefined : data;
        const list = Array.isArray(data) ? data : data.matches || [];
        setMatches(list);
        setRateLimit(response?.redditRateLimited ? { seconds: response.redditRetryAfterSeconds ?? null } : null);
        if (response?.onlineFailed) setOnlineError(t('redditUnreachable'));
        // Keep the pick when the same executable is still listed.
        setPicked((previous) => (previous ? list.find((m) => exeKey(m) === exeKey(previous)) ?? null : null));
        if (online) setFilter('all');
      })
      .catch((err: Error) => {
        if (err?.name === 'AbortError' || id !== requestId.current) return;
        // A failed Reddit search keeps the database results on screen.
        if (online) setOnlineError(err.message || t('searchFailed'));
        else setError(err.message || t('searchFailed'));
      })
      .finally(() => {
        if (id !== requestId.current) return;
        setLoading(false);
        setSearchingOnline(false);
      });
  }, []);

  useEffect(() => {
    setInput(gameName);
    setActive(gameName);
    run(gameName, false);
  }, [gameName, run]);

  useEffect(() => () => controller.current?.abort(), []);

  const add = async (match: SearchMatch) => {
    if (match.inLibrary) return;
    setAdding(true);
    try {
      const result = await api.addMatch(match, active);
      const name = result?.game?.name || match.gameName || active;
      const key = exeKey(match);
      setMatches((previous) => previous.map((m) => (exeKey(m) === key ? { ...m, inLibrary: true } : m)));
      setPicked((previous) => (previous && exeKey(previous) === key ? { ...previous, inLibrary: true } : previous));
      onAdded(name);
    } catch (err: any) {
      onError(err?.message || t('addFailed'));
    } finally {
      setAdding(false);
    }
  };

  const copyExe = (exe: string) => {
    navigator.clipboard.writeText(exe).then(() => {
      setCopied(exe);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const counts = useMemo(() => {
    const result: Record<ResultFilter, number> = { all: matches.length, database: 0, online: 0, steam: 0 };
    for (const match of matches) {
      if (match.foundVia === 'online') result.online++;
      else result.database++;
      if (isSteam(match)) result.steam++;
    }
    return result;
  }, [matches]);

  const shown = useMemo(() => {
    if (filter === 'database') return matches.filter((m) => m.foundVia !== 'online');
    if (filter === 'online') return matches.filter((m) => m.foundVia === 'online');
    if (filter === 'steam') return matches.filter(isSteam);
    return matches;
  }, [matches, filter]);

  // A filter is only offered when it shows a real subset of the results.
  const filters = (
    [
      { value: 'database', label: t('database') },
      { value: 'online', label: t('online') },
      { value: 'steam', label: t('steam') },
    ] as { value: ResultFilter; label: string }[]
  ).filter((option) => counts[option.value] > 0 && counts[option.value] < counts.all);

  const onlineButton = (
    <Button
      id="search-online-btn"
      onClick={() => run(active, true)}
      disabled={loading || searchingOnline}
      icon={searchingOnline ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
    >
      {searchingOnline ? t('searching') : t('searchOnline')}
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 px-6 pb-3 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <IconButton id="reddit-back-btn" label={t('back')} onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
          <h2 className="mr-3 truncate text-[16px] font-semibold text-text">{active}</h2>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!input.trim()) return;
              setActive(input.trim());
              run(input.trim(), false);
            }}
          >
            <SearchInput className="w-56" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t('catalogSearch')} />
          </form>
          <div className="ml-auto flex items-center gap-2">
            {onlineButton}
            <Button
              id="add-selected-game-btn"
              variant="primary"
              disabled={!picked || picked.inLibrary || adding}
              onClick={() => picked && add(picked)}
              icon={adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : picked?.inLibrary ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            >
              {adding ? t('adding') : picked?.inLibrary ? t('added') : t('addSelected')}
            </Button>
          </div>
        </div>

        {rateLimit && (
          <p className="rounded-md border border-line bg-sunken px-3 py-2 text-[13px] text-muted">
            {rateLimit.seconds ? t('redditBusy', { n: rateLimit.seconds }) : t('redditBusyShort')}
          </p>
        )}
        {onlineError && (
          <p className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2 text-[13px] text-danger">{onlineError}</p>
        )}
        {!loading && filters.length > 0 && (
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[{ value: 'all' as ResultFilter, label: t('filterAll') }, ...filters].map((option) => ({
              value: option.value,
              label: (
                <>
                  {option.label} <span className="tabular text-faint">{counts[option.value]}</span>
                </>
              ),
            }))}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-1">
        {loading ? (
          <div className="mt-20 flex items-center justify-center gap-2 text-[13px] text-faint">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('searching')}
          </div>
        ) : error ? (
          <div className="mt-16 text-center">
            <p className="text-[14px] text-danger">{error}</p>
            <div className="mt-4 flex justify-center">{onlineButton}</div>
          </div>
        ) : matches.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="text-[14px] text-muted">{t('noResults', { query: active })}</p>
            <div className="mt-4 flex justify-center">{onlineButton}</div>
          </div>
        ) : shown.length === 0 ? (
          <p className="mt-16 text-center text-[13px] text-faint">{t('noResultsInFilter')}</p>
        ) : (
          <div className="space-y-2">
            {shown.map((match, index) => {
              const isPicked = picked !== null && exeKey(picked) === exeKey(match);
              const name = match.gameName?.trim() || active;
              const showTitle = Boolean(match.title) && comparable(match.title) !== comparable(name);
              return (
                <div
                  key={`${match.foundVia || 'database'}-${match.executableName}-${index}`}
                  id={`search-match-${index}`}
                  onClick={() => !match.inLibrary && setPicked(match)}
                  className={`flex items-start gap-3 rounded-xl border bg-surface px-4 py-3 transition-colors ${
                    match.inLibrary
                      ? 'border-line opacity-60'
                      : isPicked
                      ? 'border-primary'
                      : 'border-line hover:border-line-strong'
                  }`}
                >
                  <GameIcon name={name} src={match.logoUrl} size="md" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-text">{name}</span>
                      {match.foundVia === 'online' ? <Chip tone="wait">{t('online')}</Chip> : <Chip tone="run">{t('database')}</Chip>}
                      {isSteam(match) && <Chip tone="outline">{t('steam')}</Chip>}
                      {match.inLibrary && <Chip>{t('inLibrary')}</Chip>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 font-mono text-[12px]">
                      <span className="flex items-center gap-1 text-text">
                        {match.executableName}
                        <button
                          type="button"
                          title={t('copyExe')}
                          aria-label={t('copyExe')}
                          onClick={(event) => {
                            event.stopPropagation();
                            copyExe(match.executableName);
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-hover hover:text-text"
                        >
                          {copied === match.executableName ? <Check className="h-3 w-3 text-run" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </span>
                      {match.hasFolder && (
                        // Repeated spaces matter in some folder names ("Yu-Gi-Oh!  Master Duel").
                        <span className="max-w-md truncate text-faint" style={{ whiteSpace: 'pre' }} title={match.folderPath}>
                          {match.folderPath}
                        </span>
                      )}
                    </div>
                    {showTitle && <p className="text-[12px] leading-relaxed text-muted">{match.title}</p>}
                    {match.notes && <p className="text-[12px] leading-normal text-faint">{match.notes}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {match.url && (
                      <a
                        href={match.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-text"
                      >
                        {t('source')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {!match.inLibrary && (
                      <Button
                        size="sm"
                        disabled={adding}
                        onClick={(event) => {
                          event.stopPropagation();
                          add(match);
                        }}
                      >
                        {t('add')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
