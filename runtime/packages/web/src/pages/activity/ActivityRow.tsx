import type { ActivityEvent, EventCategory, ToolStatus } from '@mcs/shared';
import { memo } from 'react';
import { Link } from 'react-router';

import { ClampedText } from '../../components/ClampedText.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TagBadge, type Tone } from '../../components/TagBadge.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';

/** One-line summaries longer than this are clamped with "Show more" (04 4.4.4). */
export const SUMMARY_CLAMP_CHARS = 200;
const SHORT_ID_CHARS = 8;
const MS_PER_SECOND = 1000;

/** `page`: the full row of /activity. `compact`: the one-line row of the Overview. */
export type ActivityMode = 'page' | 'compact';

export interface ActivityRowProps {
  event: ActivityEvent;
  mode: ActivityMode;
}

const TOOL_STATUS_TONE: Readonly<Record<ToolStatus, Tone>> = {
  pending: 'running',
  succeeded: 'completed',
  failed: 'failed',
  denied: 'waiting',
  interrupted: 'idle',
  unknown: 'unknown',
};

export const CATEGORY_KEYS = {
  lifecycle: 'activity.category.lifecycle',
  prompt: 'activity.category.prompt',
  tool: 'activity.category.tool',
  agent: 'activity.category.agent',
  notification: 'activity.category.notification',
  compaction: 'activity.category.compaction',
  error: 'activity.category.error',
  ingest: 'activity.category.ingest',
} as const satisfies Record<EventCategory, MessageKey>;

const SOURCE_KEYS = {
  hook: 'activity.source.hook',
  transcript: 'activity.source.transcript',
  monitor: 'activity.source.monitor',
} as const satisfies Record<ActivityEvent['source'], MessageKey>;

const TOOL_STATUS_KEYS = {
  pending: 'activity.toolStatus.pending',
  succeeded: 'activity.toolStatus.succeeded',
  failed: 'activity.toolStatus.failed',
  denied: 'activity.toolStatus.denied',
  interrupted: 'activity.toolStatus.interrupted',
  unknown: 'activity.toolStatus.unknown',
} as const satisfies Record<ToolStatus, MessageKey>;

function SeverityMark({ severity }: { severity: ActivityEvent['severity'] }) {
  const t = useT();
  if (severity === 'info') return null;
  return (
    <span className={`activity-row__severity activity-row__severity--${severity}`}>
      <Icon name={severity === 'error' ? 'failed' : 'alert'} />
      <span>{t(severity === 'error' ? 'activity.severity.error' : 'activity.severity.warning')}</span>
    </span>
  );
}

function Duration({ ms }: { ms: number }) {
  const t = useT();
  const format = useFormat();
  return (
    <span className="activity-row__duration muted">
      {ms < MS_PER_SECOND
        ? t('activity.duration.ms', { value: format.number(ms) })
        : format.duration(ms / MS_PER_SECOND)}
    </span>
  );
}

/** The summary is server text: one line with the whole text in the tooltip, or clamped at 200 characters with "Show more". */
function Summary({ id, text }: { id: number; text: string }) {
  if (text === '') return null;
  if (text.length <= SUMMARY_CLAMP_CHARS) {
    return (
      <div className="activity-row__summary" title={text}>
        <ServerText>{text}</ServerText>
      </div>
    );
  }
  return (
    <div className="activity-row__summary activity-row__summary--long">
      <ClampedText
        id={`ev-summary-${String(id)}`}
        text={text}
        clampChars={SUMMARY_CLAMP_CHARS}
        render={(shown) => <ServerText>{shown}</ServerText>}
      />
    </div>
  );
}

function SessionLink({ event }: { event: ActivityEvent }) {
  const label = event.sessionLabel === '' ? event.sessionId.slice(0, SHORT_ID_CHARS) : event.sessionLabel;
  return (
    <Link className="activity-row__session" to={`/sessions/${event.sessionId}`} title={label}>
      {label}
    </Link>
  );
}

function GapRow({ event }: { event: ActivityEvent }) {
  const t = useT();
  // The note sits inside an ordinary list item, so the list keeps its structure for assistive technology.
  return (
    <li className="activity-row activity-row--gap" id={`ev-${String(event.id)}`}>
      <div className="activity-row__gap" role="note">
        <Icon name="alert" />
        <span className="activity-row__gap-text">
          <span>{t('activity.gap')}</span>
          {event.summary === '' ? null : <ServerText className="activity-row__gap-reason">{event.summary}</ServerText>}
        </span>
        <RelativeTime iso={event.at} mode="clock" />
      </div>
    </li>
  );
}

function DetailsList({ details }: { details: ActivityEvent['details'] }) {
  return (
    <dl className="activity-row__details">
      {Object.entries(details).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value === null ? '-' : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActivityRowView({ event, mode }: ActivityRowProps) {
  const t = useT();
  if (event.type === 'monitor.gap') return <GapRow event={event} />;
  const compact = mode === 'compact';
  const classes = ['activity-row'];
  if (compact) classes.push('activity-row--compact');
  if (event.severity === 'error') classes.push('activity-row--error');
  const hasDetails = !compact && Object.keys(event.details).length > 0;
  return (
    <li className={classes.join(' ')} id={`ev-${String(event.id)}`} data-severity={event.severity}>
      <div className="activity-row__time">
        <RelativeTime iso={event.at} mode="clock" />
      </div>
      <div className="activity-row__main">
        <div className="activity-row__head">
          <SeverityMark severity={event.severity} />
          <span className="activity-row__type mono">{event.type}</span>
          {event.toolName === null ? null : <span className="activity-row__tool">{event.toolName}</span>}
          {event.toolStatus === null ? null : (
            <TagBadge tone={TOOL_STATUS_TONE[event.toolStatus]}>{t(TOOL_STATUS_KEYS[event.toolStatus])}</TagBadge>
          )}
          {event.durationMs === null ? null : <Duration ms={event.durationMs} />}
        </div>
        <Summary id={event.id} text={event.summary} />
        {compact ? null : (
          <div className="activity-row__meta">
            <SessionLink event={event} />
            {event.agentLabel === null ? null : (
              <span className="activity-row__agent muted" title={t('activity.row.agent')}>
                <Icon name="bot" />
                <span>{event.agentLabel}</span>
              </span>
            )}
            <TagBadge tone="neutral">{t(CATEGORY_KEYS[event.category])}</TagBadge>
            {event.sources.map((source) => (
              <TagBadge key={source} tone="neutral">
                {t(SOURCE_KEYS[source])}
              </TagBadge>
            ))}
          </div>
        )}
        {hasDetails ? (
          <Disclosure id={`ev-details-${String(event.id)}`} label={t('activity.row.details')}>
            <DetailsList details={event.details} />
          </Disclosure>
        ) : null}
      </div>
      {compact ? <SessionLink event={event} /> : null}
    </li>
  );
}

/** A row of the activity feed: an event, or a separator where the monitor knows events may be missing. */
export const ActivityRow = memo(ActivityRowView);
