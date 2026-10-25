import type { Overview } from '@mcs/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { ErrorState } from '../../components/ErrorState.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { useHealth } from '../../data/hooks/useHealth.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import { LiveDot } from '../../shell/HealthPopover.tsx';
import { chipText, INGESTION_STATUS_KEYS } from '../../stream/freshness.ts';
import { useFreshness } from '../../stream/useFreshness.ts';

export interface IngestionSummaryProps {
  /** `overview.alerts`; undefined while the overview is not loaded. */
  alerts: Overview['alerts'] | undefined;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overview-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Dash() {
  const t = useT();
  return (
    <span className="muted" title={t('common.notAvailable')}>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{t('common.notAvailable')}</span>
    </span>
  );
}

/**
 * The ingestion summary of the overview (ADR 0073 decision 9, 04 4.4.1 step 2): the status the monitor reports, when a hook event
 * and a transcript record last arrived, how far the transcript import is behind and how many alerts are open, with a link to the
 * long form in Settings. While this browser is out of sync the status is "unknown" with the last known one, never "OK".
 */
export function IngestionSummary({ alerts }: IngestionSummaryProps) {
  const t = useT();
  const format = useFormat();
  const health = useHealth();
  const { ingestion, ingestionChip } = useFreshness();
  const report = health.data;
  const lastKnown = ingestion.lastKnown;

  let body: ReactNode;
  if (report === undefined) {
    body = health.isError ? (
      <ErrorState
        kind="load"
        size="inline"
        subjectKey="error.subject.health"
        error={health.error}
        onRetry={() => {
          void health.refetch();
        }}
      />
    ) : (
      <Skeleton variant="text" rows={4} label={t('overview.ingestion.loading')} />
    );
  } else {
    const { hooks, transcripts } = report.ingestion;
    body = (
      <>
        <p className="overview-ingestion__status" data-ingestion={ingestion.display}>
          <LiveDot tone={ingestionChip.tone} />
          <span>{chipText(t, ingestionChip)}</span>
        </p>
        {lastKnown === null ? null : (
          <p className="muted small">
            {lastKnown.ageSeconds === null
              ? t('live.ingest.lastKnownNoAge', { status: t(INGESTION_STATUS_KEYS[lastKnown.status]) })
              : t('live.ingest.lastKnown', {
                  status: t(INGESTION_STATUS_KEYS[lastKnown.status]),
                  age: format.age(lastKnown.ageSeconds),
                })}
          </p>
        )}
        <dl className="overview-facts">
          <Fact label={t('overview.ingestion.lastHook')}>
            {hooks.enabled ? <RelativeTime iso={hooks.lastReceivedAt} /> : t('overview.ingestion.hooksOff')}
          </Fact>
          <Fact label={t('overview.ingestion.lastTranscript')}>
            <RelativeTime iso={transcripts.lastImportedAt} />
          </Fact>
          <Fact label={t('overview.ingestion.lag')}>
            {transcripts.importLagMs === null ? <Dash /> : format.duration(transcripts.importLagMs / 1000)}
          </Fact>
          <Fact label={t('overview.ingestion.alerts')}>
            {alerts === undefined ? (
              <Dash />
            ) : alerts.open === 0 ? (
              t('overview.ingestion.alertsNone')
            ) : (
              <>
                {format.number(alerts.open)}
                {alerts.critical > 0 ? (
                  <span className="overview-fact__critical">
                    {' '}
                    ({t('overview.ingestion.critical', { count: format.number(alerts.critical) })})
                  </span>
                ) : null}
              </>
            )}
          </Fact>
        </dl>
      </>
    );
  }

  return (
    <section className="card overview-section" aria-labelledby="overview-ingestion-title">
      <header className="overview-section__head">
        <h2 id="overview-ingestion-title">{t('overview.ingestion.title')}</h2>
        <Link to="/settings?section=health" className="overview-section__action">
          {t('overview.ingestion.details')}
        </Link>
      </header>
      <div className="overview-section__body">{body}</div>
    </section>
  );
}
