// The panel behind the Live control (ADR 0073 decision 5, review R-24): four sections, each with its own status dot. Read-only; the
// numbers come from the endpoint tracker, the stream snapshot and the cached `/health` report, the state of the two signals from
// the freshness model. The long form stays in the health section of the settings.
import type { HealthReport } from '@mcs/shared';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';

import { Icon } from '../components/Icon.tsx';
import { useNow } from '../components/RelativeTime.tsx';
import { InstanceIdContext, useApi } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { useFormat, useT } from '../i18n/context.ts';
import { ServerText } from '../i18n/ServerText.tsx';
import type { MessageKey } from '../i18n/types.ts';
import type { EndpointRecord } from '../data/endpoint-tracker.ts';
import { chipText, INGESTION_STATUS_KEYS, type ChipTone, type Freshness } from '../stream/freshness.ts';
import type { StreamSnapshot } from '../stream/stream-client.ts';
import { useStreamSnapshot } from '../stream/StreamProvider.tsx';

/** The most server errors the panel lists; the settings page holds the rest. */
export const MAX_ERRORS_SHOWN = 5;

export const STREAM_STATUS_KEYS = {
  idle: 'live.stream.status.idle',
  connecting: 'live.stream.status.connecting',
  open: 'live.stream.status.open',
  backoff: 'live.stream.status.backoff',
  stopped: 'live.stream.status.stopped',
} as const satisfies Record<StreamSnapshot['status'], MessageKey>;

/** The status dot of a line. The word beside it carries the meaning; the dot is a second cue. */
export function LiveDot({ tone }: { tone: ChipTone }) {
  return <span className="live-dot" data-tone={tone} aria-hidden="true" />;
}

function Section({ title, tone, children }: { title: string; tone: ChipTone; children: ReactNode }) {
  return (
    <section className="live-section">
      <h3 className="live-section__title">
        <LiveDot tone={tone} />
        <span>{title}</span>
      </h3>
      {children}
    </section>
  );
}

function Row({ tone, children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <li className="live-row">
      {tone === undefined ? <span className="live-row__gap" aria-hidden="true" /> : <LiveDot tone={tone} />}
      <span className="live-row__text">{children}</span>
    </li>
  );
}

function endpointTone(record: EndpointRecord): ChipTone {
  if (record.failures > 0) return 'failed';
  return record.lastSuccess === null ? 'idle' : 'ok';
}

function ConnectionSection({ freshness, stream }: { freshness: Freshness; stream: StreamSnapshot }) {
  const t = useT();
  const format = useFormat();
  const { tracker } = useApi();
  const subscribe = useCallback((fn: () => void) => tracker.subscribe(fn), [tracker]);
  const records = useSyncExternalStore(subscribe, () => tracker.snapshot());
  const now = useNow();
  const chip = freshness.connectionChip;

  return (
    <Section title={t('live.section.connection')} tone={chip.tone}>
      <p className="live-status" data-connection={freshness.connection.state}>
        {chipText(t, chip)}
      </p>
      <ul className="live-list">
        {stream.status === 'open' ? (
          <Row>{t('live.stream.connected', { time: format.clock(stream.openedAt ?? now) })}</Row>
        ) : (
          <Row>
            {t('live.stream.notConnected', { status: t(STREAM_STATUS_KEYS[stream.status]) })}
            {stream.lastError === null ? null : (
              <>
                {': '}
                <ServerText>{stream.lastError}</ServerText>
              </>
            )}
          </Row>
        )}
        <Row>
          {stream.lastSeq === null ? t('live.stream.noEvent') : t('live.stream.lastEvent', { seq: stream.lastSeq })}
        </Row>
        {stream.counters.invalid === 0 ? null : (
          <Row tone="stale">{t('live.stream.invalid', { count: stream.counters.invalid })}</Row>
        )}
        {stream.lastResetReason === null ? null : (
          <Row>{t('live.stream.reset', { reason: stream.lastResetReason })}</Row>
        )}
      </ul>
      <h4 className="live-subtitle">{t('live.endpoints.heading')}</h4>
      {records.length === 0 ? (
        <p className="live-note">{t('live.endpoints.none')}</p>
      ) : (
        <ul className="live-list" data-live-list="endpoints">
          {records.map((record) => (
            <Row key={record.name} tone={endpointTone(record)}>
              <code className="live-code">{record.name}</code>{' '}
              {record.lastSuccess === null
                ? t('live.endpoint.never')
                : t('live.endpoint.ok', { age: format.age((now - record.lastSuccess) / 1000) })}
              {record.failures === 0 ? null : (
                <>
                  {'; '}
                  {t('live.endpoint.failing', { count: record.failures })}
                  {record.lastError === null ? null : (
                    <>
                      {', '}
                      {t('live.endpoint.lastError')} <ServerText>{record.lastError.message}</ServerText>
                    </>
                  )}
                </>
              )}
            </Row>
          ))}
        </ul>
      )}
    </Section>
  );
}

function IngestionSection({ freshness }: { freshness: Freshness }) {
  const t = useT();
  const format = useFormat();
  const { ingestion, ingestionChip } = freshness;
  const lastKnown = ingestion.lastKnown;
  return (
    <Section title={t('live.section.ingestion')} tone={ingestionChip.tone}>
      <p className="live-status" data-ingestion={ingestion.display}>
        {chipText(t, ingestionChip)}
      </p>
      {lastKnown === null ? null : (
        <p className="live-note">
          {lastKnown.ageSeconds === null
            ? t('live.ingest.lastKnownNoAge', { status: t(INGESTION_STATUS_KEYS[lastKnown.status]) })
            : t('live.ingest.lastKnown', {
                status: t(INGESTION_STATUS_KEYS[lastKnown.status]),
                age: format.age(lastKnown.ageSeconds),
              })}
        </p>
      )}
      {ingestion.reasons.length === 0 ? null : (
        <ul className="live-list" data-live-list="reasons">
          {ingestion.reasons.map((reason) => (
            <Row key={reason}>
              <ServerText>{reason}</ServerText>
            </Row>
          ))}
        </ul>
      )}
    </Section>
  );
}

function serverTone(runtime: HealthReport['runtime']): ChipTone {
  if (runtime.ownershipConflict) return 'failed';
  return runtime.outdated || runtime.previousRunUnclean ? 'stale' : 'ok';
}

function ServerSection({ health }: { health: HealthReport | undefined }) {
  const t = useT();
  const format = useFormat();
  if (health === undefined) {
    return (
      <Section title={t('live.section.server')} tone="unknown">
        <p className="live-note">{t('live.server.none')}</p>
      </Section>
    );
  }
  const { runtime } = health;
  return (
    <Section title={t('live.section.server')} tone={serverTone(runtime)}>
      <dl className="live-facts">
        <dt>{t('live.server.version')}</dt>
        <dd>
          <code className="live-code">{runtime.version}</code>
        </dd>
        <dt>{t('live.server.uptime')}</dt>
        <dd>{format.duration(runtime.uptimeMs / 1000)}</dd>
        <dt>{t('live.server.epoch')}</dt>
        <dd>
          <code className="live-code">{health.epoch}</code>
        </dd>
        <dt>{t('live.server.started')}</dt>
        <dd>{format.clock(runtime.startedAt)}</dd>
      </dl>
      {runtime.outdated || runtime.previousRunUnclean || runtime.ownershipConflict ? (
        <ul className="live-list" data-live-list="flags">
          {runtime.ownershipConflict ? <Row tone="failed">{t('live.server.conflict')}</Row> : null}
          {runtime.previousRunUnclean ? <Row tone="stale">{t('live.server.unclean')}</Row> : null}
          {runtime.outdated ? <Row tone="stale">{t('live.server.restartNeeded')}</Row> : null}
        </ul>
      ) : null}
      <p className="live-note">{t('live.server.epochNote')}</p>
    </Section>
  );
}

function ErrorsSection({ health }: { health: HealthReport | undefined }) {
  const t = useT();
  const format = useFormat();
  const errors = health?.errors ?? [];
  const shown = errors.slice(0, MAX_ERRORS_SHOWN);
  return (
    <Section title={t('live.section.errors')} tone={errors.length === 0 ? 'ok' : 'stale'}>
      {errors.length === 0 ? (
        <p className="live-note">{t('live.errors.none')}</p>
      ) : (
        <>
          <ul className="live-list" data-live-list="errors">
            {shown.map((error) => (
              <Row key={`${error.at}|${error.source}|${error.code}|${error.message}`} tone="stale">
                <span className="live-error__head">
                  {format.clock(error.at)} <code className="live-code">{`${error.source}/${error.code}`}</code>
                </span>
                <ServerText className="live-error__message">{error.message}</ServerText>
              </Row>
            ))}
          </ul>
          {errors.length > shown.length ? (
            <p className="live-note">{t('live.errors.shown', { shown: shown.length, total: errors.length })}</p>
          ) : null}
        </>
      )}
    </Section>
  );
}

/** The content of the Live popover. `onNavigate` closes the popover when the link to the settings is followed. */
export function HealthPopover({ freshness, onNavigate }: { freshness: Freshness; onNavigate?: () => void }) {
  const t = useT();
  const stream = useStreamSnapshot();
  const iid = useContext(InstanceIdContext);
  // Cache read only: the shell polls `/health`.
  const health = useQuery<HealthReport>({ queryKey: qk.health(iid ?? ''), queryFn: skipToken }).data;
  return (
    <div className="live-popover">
      <ConnectionSection freshness={freshness} stream={stream} />
      <IngestionSection freshness={freshness} />
      <ServerSection health={health} />
      <ErrorsSection health={health} />
      <Link to="/settings?section=health" className="live-popover__link" onClick={onNavigate}>
        <span>{t('live.popover.settings')}</span>
        <Icon name="chevron-right" />
      </Link>
    </div>
  );
}
