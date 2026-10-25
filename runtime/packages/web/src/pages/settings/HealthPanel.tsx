// The long form of the Live popover (ADR 0073 decision 5, 04-ui.md 4.4.7): the connection of this browser, what the server says about
// ingestion, the database, the server itself, the open alerts and the server errors. Read only. Two things are never mixed up: the
// connection is observed by this page, ingestion is reported by the server, and a server report that cannot be trusted right now
// (the page is not in sync) is shown as "unknown" with the last known status, never as OK.
import type { AlertItem, ErrorItem, HealthReport } from '@mcs/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { ErrorState } from '../../components/ErrorState.tsx';
import { RelativeTime, useNow } from '../../components/RelativeTime.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useHealth } from '../../data/hooks/useHealth.ts';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import { STREAM_STATUS_KEYS } from '../../shell/HealthPopover.tsx';
import { chipText, INGESTION_STATUS_KEYS, type ChipTone, type Freshness } from '../../stream/freshness.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { useStreamSnapshot } from '../../stream/StreamProvider.tsx';
import { useFreshness } from '../../stream/useFreshness.ts';
import { CommandLine, Dash, Fact, Facts, SettingsCard, Verdict } from './SettingsParts.tsx';

/** The server keeps at most this many errors (`HealthReport.errors`); the page shows all of them. */
export const MAX_SERVER_ERRORS = 20;

function useYesNo(): (value: boolean) => string {
  const t = useT();
  return (value) => t(value ? 'settings.yes' : 'settings.no');
}

/** The reason codes of the ingestion report that have a sentence of their own; any other text is drawn as the server sent it. */
const REASON_KEYS = {
  HOOKS_FAILING: 'settings.health.reason.HOOKS_FAILING',
  HOOK_GAP: 'settings.health.reason.HOOK_GAP',
  HOOKS_NOT_INSTALLED: 'settings.health.reason.HOOKS_NOT_INSTALLED',
  IMPORT_LAG: 'settings.health.reason.IMPORT_LAG',
  IMPORT_ERRORS: 'settings.health.reason.IMPORT_ERRORS',
  BACKFILLING: 'settings.health.reason.BACKFILLING',
  TRANSCRIPTS_NOT_FOUND: 'settings.health.reason.TRANSCRIPTS_NOT_FOUND',
  SPOOL_BACKLOG: 'settings.health.reason.SPOOL_BACKLOG',
  DB_ERROR: 'settings.health.reason.DB_ERROR',
  PROVIDER_SILENT: 'settings.health.reason.PROVIDER_SILENT',
  EVENT_LOOP_SLOW: 'settings.health.reason.EVENT_LOOP_SLOW',
  INGEST_HEALTH_PARTIAL: 'settings.health.reason.INGEST_HEALTH_PARTIAL',
} as const satisfies Record<string, MessageKey>;

function isKnownReason(reason: string): reason is keyof typeof REASON_KEYS {
  return Object.hasOwn(REASON_KEYS, reason);
}

function ReasonText({ reason }: { reason: string }) {
  const t = useT();
  return isKnownReason(reason) ? <>{t(REASON_KEYS[reason])}</> : <ServerText>{reason}</ServerText>;
}

/** An epoch time as the ISO text `RelativeTime` takes. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function LastError({ error }: { error: ErrorItem | null }) {
  if (error === null) return <Dash />;
  return (
    <span className="settings-error">
      <code>{`${error.source}/${error.code}`}</code> <RelativeTime iso={error.at} mode="both" />
      <ServerText as="p" className="settings-error__message">
        {error.message}
      </ServerText>
    </span>
  );
}

// ---- connection ----------------------------------------------------------------------------------------------------------

function ConnectionCard({ freshness }: { freshness: Freshness }) {
  const t = useT();
  const format = useFormat();
  const stream = useStreamSnapshot();
  const instance = useInstance().data;
  const now = useNow();
  const { connection, connectionChip } = freshness;
  return (
    <SettingsCard title={t('live.section.connection')} tone={connectionChip.tone}>
      <p className="settings-status" data-connection={connection.state}>
        {chipText(t, connectionChip)}
      </p>
      <Facts>
        <Fact label={t('settings.health.stream')}>
          {stream.status === 'open' ? (
            t('live.stream.connected', { time: format.clock(stream.openedAt ?? now) })
          ) : (
            <>
              {t('live.stream.notConnected', { status: t(STREAM_STATUS_KEYS[stream.status]) })}
              {stream.lastError === null ? null : (
                <>
                  {': '}
                  <ServerText>{stream.lastError}</ServerText>
                </>
              )}
            </>
          )}
        </Fact>
        <Fact label={t('settings.health.lastSync')}>
          {connection.lastSyncAt === null ? (
            t('settings.never')
          ) : (
            <RelativeTime iso={isoOf(connection.lastSyncAt)} mode="both" />
          )}
        </Fact>
        {instance === undefined ? null : (
          <Fact label={t('settings.health.staleAfter')}>{format.duration(instance.staleAfterMs / 1000)}</Fact>
        )}
        <Fact label={t('settings.health.lastEvent')}>
          {stream.lastSeq === null ? t('live.stream.noEvent') : format.number(stream.lastSeq)}
        </Fact>
        {stream.counters.invalid === 0 ? null : (
          <Fact label={t('settings.health.invalid')}>{format.number(stream.counters.invalid)}</Fact>
        )}
        {stream.lastResetReason === null ? null : (
          <Fact label={t('settings.health.lastReset')} mono>
            {stream.lastResetReason}
          </Fact>
        )}
        {connection.lastError === null ? null : (
          <Fact label={t('settings.health.connectionError')}>
            <code>{connection.lastError.source}</code> <ServerText>{connection.lastError.message}</ServerText>
          </Fact>
        )}
      </Facts>
    </SettingsCard>
  );
}

// ---- ingestion -----------------------------------------------------------------------------------------------------------

function HooksFacts({ hooks }: { hooks: HealthReport['ingestion']['hooks'] }) {
  const t = useT();
  const format = useFormat();
  const yesNo = useYesNo();
  return (
    <div className="settings-split__part">
      <h4 className="settings-card__subtitle">{t('settings.health.hooks')}</h4>
      <Facts>
        <Fact label={t('settings.health.hooks.enabled')}>{yesNo(hooks.enabled)}</Fact>
        {hooks.enabled ? (
          <>
            <Fact label={t('settings.health.hooks.installed')}>
              {hooks.installed === null ? t('settings.unknown') : yesNo(hooks.installed)}
            </Fact>
            <Fact label={t('settings.health.hooks.lastReceived')}>
              <RelativeTime iso={hooks.lastReceivedAt} mode="both" />
            </Fact>
            <Fact label={t('settings.health.hooks.lastEvent')}>
              <RelativeTime iso={hooks.lastEventAt} mode="both" />
            </Fact>
            <Fact label={t('settings.health.hooks.backlog')}>{format.bytes(hooks.spoolPendingBytes)}</Fact>
            <Fact label={t('settings.health.hooks.lag')}>
              {hooks.spoolLagMs === null ? <Dash /> : format.duration(hooks.spoolLagMs / 1000)}
            </Fact>
            <Fact label={t('settings.health.errorsHour')}>{format.number(hooks.errorsLastHour)}</Fact>
            <Fact label={t('settings.health.lastError')}>
              <LastError error={hooks.lastError} />
            </Fact>
          </>
        ) : null}
      </Facts>
      {hooks.enabled ? null : <p className="settings-card__note muted small">{t('settings.health.hooks.off')}</p>}
    </div>
  );
}

function TranscriptFacts({ transcripts }: { transcripts: HealthReport['ingestion']['transcripts'] }) {
  const t = useT();
  const format = useFormat();
  const yesNo = useYesNo();
  return (
    <div className="settings-split__part">
      <h4 className="settings-card__subtitle">{t('settings.health.transcripts')}</h4>
      <Facts>
        <Fact label={t('settings.health.transcripts.folder')}>
          <Verdict tone={transcripts.dirFound ? 'ok' : 'failed'}>{yesNo(transcripts.dirFound)}</Verdict>
        </Fact>
        <Fact label={t('settings.health.transcripts.files')}>{format.number(transcripts.filesTracked)}</Fact>
        <Fact label={t('settings.health.transcripts.lastScan')}>
          <RelativeTime iso={transcripts.lastScanAt} mode="both" />
        </Fact>
        <Fact label={t('settings.health.transcripts.lastImported')}>
          <RelativeTime iso={transcripts.lastImportedAt} mode="both" />
        </Fact>
        <Fact label={t('settings.health.transcripts.lag')}>
          {transcripts.importLagMs === null ? <Dash /> : format.duration(transcripts.importLagMs / 1000)}
        </Fact>
        <Fact label={t('settings.health.transcripts.pending')}>{format.bytes(transcripts.pendingBytes)}</Fact>
        <Fact label={t('settings.health.transcripts.invalidLines')}>{format.number(transcripts.invalidLines)}</Fact>
        <Fact label={t('settings.health.errorsHour')}>{format.number(transcripts.errorsLastHour)}</Fact>
        <Fact label={t('settings.health.lastError')}>
          <LastError error={transcripts.lastError} />
        </Fact>
      </Facts>
    </div>
  );
}

function IngestionCard({ freshness, report }: { freshness: Freshness; report: HealthReport }) {
  const t = useT();
  const format = useFormat();
  const { ingestion, ingestionChip } = freshness;
  const lastKnown = ingestion.lastKnown;
  return (
    <SettingsCard title={t('live.section.ingestion')} tone={ingestionChip.tone} wide>
      <p className="settings-status" data-ingestion={ingestion.display}>
        {chipText(t, ingestionChip)}
      </p>
      {lastKnown === null ? null : (
        <p className="settings-card__note muted small">
          {lastKnown.ageSeconds === null
            ? t('live.ingest.lastKnownNoAge', { status: t(INGESTION_STATUS_KEYS[lastKnown.status]) })
            : t('live.ingest.lastKnown', {
                status: t(INGESTION_STATUS_KEYS[lastKnown.status]),
                age: format.age(lastKnown.ageSeconds),
              })}
        </p>
      )}
      {ingestion.reasons.length === 0 ? null : (
        <ul className="settings-reasons">
          {ingestion.reasons.map((reason) => (
            <li key={reason}>
              <ReasonText reason={reason} />
            </li>
          ))}
        </ul>
      )}
      {ingestion.known ? null : (
        <p className="settings-card__note muted small">
          {t('settings.health.cached', { time: format.clock(report.checkedAt) })}
        </p>
      )}
      <div className="settings-split">
        <HooksFacts hooks={report.ingestion.hooks} />
        <TranscriptFacts transcripts={report.ingestion.transcripts} />
      </div>
    </SettingsCard>
  );
}

// ---- database and server -------------------------------------------------------------------------------------------------

function DatabaseCard({ db }: { db: HealthReport['db'] }) {
  const t = useT();
  const format = useFormat();
  return (
    <SettingsCard title={t('settings.health.database')} tone={db.ok ? 'ok' : 'failed'}>
      <p className="settings-status">{t(db.ok ? 'settings.health.database.ok' : 'settings.health.database.failed')}</p>
      <Facts>
        <Fact label={t('settings.health.database.size')}>{format.bytes(db.sizeBytes)}</Fact>
        <Fact label={t('settings.health.database.wal')}>{format.bytes(db.walBytes)}</Fact>
        <Fact label={t('settings.health.database.free')}>
          {db.freeDiskBytes === null ? t('common.notAvailable') : format.bytes(db.freeDiskBytes)}
        </Fact>
        <Fact label={t('settings.health.database.schema')}>{format.number(db.schemaVersion)}</Fact>
        {db.lastError === null ? null : (
          <Fact label={t('settings.health.lastError')}>
            <ServerText>{db.lastError}</ServerText>
          </Fact>
        )}
      </Facts>
    </SettingsCard>
  );
}

function serverTone(runtime: HealthReport['runtime']): ChipTone {
  if (runtime.ownershipConflict) return 'failed';
  return runtime.outdated || runtime.previousRunUnclean ? 'stale' : 'ok';
}

function ServerCard({ runtime, epoch }: { runtime: HealthReport['runtime']; epoch: string }) {
  const t = useT();
  const format = useFormat();
  const restart = useInstance().data?.commands.restart;
  const flagged = runtime.ownershipConflict || runtime.previousRunUnclean || runtime.outdated;
  return (
    <SettingsCard title={t('live.section.server')} tone={serverTone(runtime)} wide>
      <ul className="settings-flags">
        {runtime.ownershipConflict ? (
          <li>
            <Verdict tone="failed">{t('live.server.conflict')}</Verdict>
          </li>
        ) : null}
        {runtime.previousRunUnclean ? (
          <li>
            <Verdict tone="stale">{t('live.server.unclean')}</Verdict>
          </li>
        ) : null}
        {runtime.outdated ? (
          <li>
            <Verdict tone="stale">{t('live.server.restartNeeded')}</Verdict>
          </li>
        ) : null}
        {flagged ? null : (
          <li>
            <Verdict tone="ok">{t('settings.health.server.ok')}</Verdict>
          </li>
        )}
      </ul>
      {runtime.outdated && restart !== undefined ? (
        <div className="settings-restart">
          <p className="muted small">{t('settings.health.server.restart')}</p>
          <CommandLine command={restart} copyLabel={t('settings.health.server.copyRestart')} />
        </div>
      ) : null}
      <Facts columns>
        <Fact label={t('live.server.version')} mono>
          {runtime.version}
        </Fact>
        <Fact label={t('settings.health.server.codeStamp')} mono>
          {runtime.codeStamp}
        </Fact>
        <Fact label={t('live.server.started')}>
          <RelativeTime iso={runtime.startedAt} mode="both" />
        </Fact>
        <Fact label={t('live.server.uptime')}>{format.duration(runtime.uptimeMs / 1000)}</Fact>
        <Fact label={t('settings.health.server.pid')} mono>
          {runtime.pid}
        </Fact>
        <Fact label={t('live.server.epoch')} mono>
          {epoch}
        </Fact>
        <Fact label={t('settings.health.server.loop')}>
          {t('settings.health.server.ms', {
            value: format.number(runtime.eventLoopDelayP99Ms, { maximumFractionDigits: 1 }),
          })}
        </Fact>
        <Fact label={t('settings.health.server.memory')}>{format.bytes(runtime.rssBytes)}</Fact>
        <Fact label={t('settings.health.server.heap')}>{format.bytes(runtime.heapUsedBytes)}</Fact>
        <Fact label={t('settings.health.server.clients')}>{format.number(runtime.sseClients)}</Fact>
      </Facts>
    </SettingsCard>
  );
}

// ---- alerts and errors ---------------------------------------------------------------------------------------------------

function AlertRow({ alert }: { alert: AlertItem }) {
  const t = useT();
  const critical = alert.severity === 'critical';
  return (
    <li className="settings-alert" data-severity={alert.severity}>
      <div className="settings-alert__head">
        <TagBadge tone={critical ? 'failed' : 'stale'} icon="alert">
          {t(critical ? 'settings.health.alerts.critical' : 'settings.health.alerts.warning')}
        </TagBadge>
        <ServerText className="settings-alert__title">{alert.title}</ServerText>
      </div>
      <p className="settings-alert__meta muted small">
        <span>
          {t('settings.health.alerts.rule')} <code>{alert.rule}</code>
        </span>
        <span>
          {t('settings.health.alerts.since')} <RelativeTime iso={alert.since} mode="relative" />
        </span>
        <span>
          {t('settings.health.alerts.lastFired')} <RelativeTime iso={alert.lastFiredAt} mode="relative" />
        </span>
        <span>{t('settings.health.alerts.fired', { count: alert.fireCount })}</span>
      </p>
      {alert.sessionId === null ? null : (
        <Link className="settings-alert__link" to={`/sessions/${encodeURIComponent(alert.sessionId)}`}>
          {t('settings.health.alerts.session')}
        </Link>
      )}
    </li>
  );
}

function AlertsCard({ alerts }: { alerts: readonly AlertItem[] }) {
  const t = useT();
  const tone: ChipTone =
    alerts.length === 0 ? 'ok' : alerts.some((alert) => alert.severity === 'critical') ? 'failed' : 'stale';
  return (
    <SettingsCard title={t('settings.health.alerts')} tone={tone} wide>
      {alerts.length === 0 ? (
        <p className="settings-status">{t('settings.health.alerts.none')}</p>
      ) : (
        <ul className="settings-list" data-list="alerts">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

function ErrorsCard({ errors }: { errors: readonly ErrorItem[] }) {
  const t = useT();
  const shown = errors.slice(0, MAX_SERVER_ERRORS);
  return (
    <SettingsCard
      title={t('settings.health.errors')}
      tone={shown.length === 0 ? 'ok' : 'stale'}
      wide
      note={shown.length === 0 ? undefined : t('settings.health.errors.note', { max: MAX_SERVER_ERRORS })}
    >
      {shown.length === 0 ? (
        <p className="settings-status">{t('live.errors.none')}</p>
      ) : (
        <ul className="settings-list" data-list="errors">
          {shown.map((error) => (
            <li key={`${error.at}|${error.source}|${error.code}|${error.message}`} className="settings-server-error">
              <div className="settings-server-error__head">
                <RelativeTime iso={error.at} mode="both" />
                <code>{`${error.source}/${error.code}`}</code>
                {error.where === null ? null : <code className="muted">{error.where}</code>}
                {error.sessionId === null ? null : (
                  <Link to={`/sessions/${encodeURIComponent(error.sessionId)}`}>
                    {t('settings.health.errors.session')}
                  </Link>
                )}
              </div>
              <ServerText as="p" className="settings-server-error__message">
                {error.message}
              </ServerText>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

// ---- the panel -----------------------------------------------------------------------------------------------------------

export function HealthPanel(): ReactNode {
  const t = useT();
  const health = useHealth();
  const freshness = useFreshness();
  const report = health.data;
  return (
    <div className="settings-health">
      {health.isError && report !== undefined ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.health"
          error={health.error}
          lastGoodAt={health.dataUpdatedAt}
          onRetry={() => {
            void health.refetch();
          }}
        />
      ) : null}
      <div className="settings-grid">
        <ConnectionCard freshness={freshness} />
        {report === undefined ? null : (
          <>
            <DatabaseCard db={report.db} />
            <IngestionCard freshness={freshness} report={report} />
            <ServerCard runtime={report.runtime} epoch={report.epoch} />
            <AlertsCard alerts={report.alerts} />
            <ErrorsCard errors={report.errors} />
          </>
        )}
      </div>
      {report !== undefined ? null : health.isError ? (
        <ErrorState
          kind="load"
          subjectKey="error.subject.health"
          error={health.error}
          onRetry={() => {
            void health.refetch();
          }}
        />
      ) : (
        <Skeleton variant="list" rows={6} label={t('settings.health.loading')} />
      )}
    </div>
  );
}
