import React from 'react';
import { AppProfile, BUFFER_PRESET_DURATIONS, FINAL_SAFETY_MARGIN_SECONDS } from '../types';
import { t } from '../strings';
import { SectionLabel } from '../components/ui';

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2">
    <h3 className="text-[15px] font-semibold text-text">{title}</h3>
    <div className="space-y-2 text-[14px] leading-relaxed text-muted">{children}</div>
  </section>
);

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="space-y-0.5 border-b border-line py-2.5 last:border-b-0">
    <dt className="text-[12px] text-faint">{label}</dt>
    <dd className="break-all font-mono text-[12px] text-text">{value}</dd>
  </div>
);

const dateOnly = (iso?: string) => (iso ? iso.slice(0, 10) : '-');

export const AboutView: React.FC<{ profile: AppProfile }> = ({ profile }) => {
  const database = profile.gameDatabase;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="grid max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
        <article className="max-w-2xl space-y-7">
          <header className="space-y-3">
            <h2 className="text-[20px] font-semibold text-text">{t('aboutTitle')}</h2>
            <p className="text-[14px] leading-relaxed text-muted">{t('aboutIntro')}</p>
            <p className="text-[14px] leading-relaxed text-muted">{t('aboutSafe')}</p>
          </header>

          <Section title={t('aboutLimitsTitle')}>
            <p>{t('aboutLimits')}</p>
          </Section>

          <Section title={t('aboutTimerTitle')}>
            <p>
              {t('aboutTimer', {
                fast: BUFFER_PRESET_DURATIONS.fast.start,
                normal: BUFFER_PRESET_DURATIONS.normal.start,
                long: BUFFER_PRESET_DURATIONS.long.start,
                end: FINAL_SAFETY_MARGIN_SECONDS,
              })}
            </p>
          </Section>

          <Section title={t('aboutAddTitle')}>
            <p>{t('aboutAdd')}</p>
            <p>{t('aboutScript')}</p>
          </Section>

          <Section title={t('aboutFilesTitle')}>
            <p>{t('aboutFiles')}</p>
            <p>{t('aboutLog')}</p>
          </Section>

          <Section title={t('aboutRemoveTitle')}>
            <p>{t('aboutRemove')}</p>
          </Section>
        </article>

        <aside className="self-start rounded-xl border border-line bg-surface px-4 py-3">
          <SectionLabel className="pb-1">{t('aboutFacts')}</SectionLabel>
          <dl>
            <Fact label={t('aboutVersion')} value={profile.version} />
            <Fact label={t('aboutDbGames')} value={database?.games ?? '-'} />
            <Fact label={t('aboutDbUpdated')} value={dateOnly(database?.updatedAt)} />
            <Fact label={t('aboutGamesFolder')} value={profile.gamesFolder ?? '-'} />
          </dl>
        </aside>
      </div>
    </div>
  );
};
