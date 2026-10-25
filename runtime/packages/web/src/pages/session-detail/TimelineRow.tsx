import { routes, type ActivityEvent, type EventCategory, type ToolStatus } from '@mcs/shared';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { Icon } from '../../components/Icon.tsx';
import type { IconName } from '../../components/icons.ts';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { pathFor } from '../../data/endpoints.ts';
import { useDataEnv } from '../../data/hooks/useInstance.ts';
import { useT } from '../../i18n/context.ts';
import type { MessageKey, TFunction } from '../../i18n/types.ts';
import { formatUrlState, parseUrlState, sessionDetailSpec } from '../../lib/url-state.ts';
import { useShowToast } from '../../state/toast-store.ts';

const MAIN_AGENT = 'main';
const DEFAULTS = parseUrlState(sessionDetailSpec, new URLSearchParams()).value;

/** The icon of an event category, in front of the event name. */
const CATEGORY_ICON: Readonly<Record<EventCategory, IconName>> = {
  lifecycle: 'activity',
  prompt: 'user',
  tool: 'tool',
  agent: 'bot',
  notification: 'bell',
  compaction: 'layers',
  error: 'failed',
  ingest: 'database',
};

const CATEGORY_KEYS = {
  lifecycle: 'activity.category.lifecycle',
  prompt: 'activity.category.prompt',
  tool: 'activity.category.tool',
  agent: 'activity.category.agent',
  notification: 'activity.category.notification',
  compaction: 'activity.category.compaction',
  error: 'activity.category.error',
  ingest: 'activity.category.ingest',
} as const satisfies Readonly<Record<EventCategory, MessageKey>>;

/** The dot of an event: the state of its tool call, or the severity of the event itself. */
type DotTone = 'running' | 'completed' | 'failed' | 'waiting' | 'idle' | 'unknown' | 'stale';

const TOOL_STATUS_TONE: Readonly<Record<ToolStatus, DotTone>> = {
  pending: 'running',
  succeeded: 'completed',
  failed: 'failed',
  denied: 'waiting',
  interrupted: 'idle',
  unknown: 'unknown',
};

const TOOL_STATUS_KEYS = {
  pending: 'tabs.events.status.pending',
  succeeded: 'tabs.events.status.succeeded',
  failed: 'tabs.events.status.failed',
  denied: 'tabs.events.status.denied',
  interrupted: 'tabs.events.status.interrupted',
  unknown: 'tabs.events.status.unknown',
} as const satisfies Readonly<Record<ToolStatus, MessageKey>>;

export interface TimelineRowProps {
  event: ActivityEvent;
  /** The details are open. */
  open: boolean;
  onToggle: (eventId: number, open: boolean) => void;
  /** Absent: no "Show in transcript" button. */
  onShowInTranscript?: ((event: ActivityEvent) => void) | undefined;
  /** Draw the source tags: the events of the list do not all come from the same sources. */
  showSources?: boolean | undefined;
}

/** The words of the dot of an event, or null when the event has no status worth a dot (an ordinary event). */
function dotOf(event: ActivityEvent, t: TFunction): { tone: DotTone; text: string } | null {
  if (event.toolStatus !== null)
    return { tone: TOOL_STATUS_TONE[event.toolStatus], text: t(TOOL_STATUS_KEYS[event.toolStatus]) };
  if (event.severity === 'error') return { tone: 'failed', text: t('tabs.severity.error') };
  if (event.severity === 'warning') return { tone: 'stale', text: t('tabs.severity.warning') };
  return null;
}

/**
 * Resolves the transcript entry of an event (`GET .../transcript/locate?agent=&offset=`) and opens it in the Transcript tab
 * (`?tab=transcript&agent=&i=`). A failure is a toast and the page stays where it is. A newer click or leaving the page
 * cancels the request that is still running.
 */
export function useShowInTranscript(): (event: ActivityEvent) => void {
  const { api } = useDataEnv();
  const navigate = useNavigate();
  const showToast = useShowToast();
  const t = useT();
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  return useCallback(
    (event) => {
      const ref = event.transcriptRef;
      if (ref === null) return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      void api
        .get(
          'transcriptLocate',
          pathFor('transcriptLocate', routes.transcriptLocate, { sessionId: event.sessionId }),
          routes.transcriptLocate.response,
          { query: { agent: ref.agentId, offset: ref.offset }, signal: controller.signal },
        )
        .then((located) => {
          if (controller.signal.aborted) return;
          const search = formatUrlState(sessionDetailSpec, {
            ...DEFAULTS,
            tab: 'transcript',
            agent: ref.agentId === MAIN_AGENT ? '' : ref.agentId,
            i: located.i,
          });
          void navigate(`/sessions/${event.sessionId}?${search.toString()}`);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const detail = error instanceof ApiError ? error.message : t('tabs.events.locateUnexpected');
          showToast(t('tabs.events.locateFailed', { detail }), { kind: 'error' });
        });
    },
    [api, navigate, showToast, t],
  );
}

/** What the name of an event says in one line: its type, then its summary in muted text. */
function EventName({ event }: { event: ActivityEvent }) {
  return (
    <span className="event-row__name" title={event.summary === '' ? event.type : `${event.type}: ${event.summary}`}>
      <span className="mono event-row__type">{event.type}</span>
      {event.toolName === null ? null : <span className="event-row__tool">{event.toolName}</span>}
      {event.summary === '' ? null : <span className="event-row__summary">{event.summary}</span>}
    </span>
  );
}

/** A row of the Events list: one line of 32 to 36 px (time, category icon, name, status dot, agent), or a separator where the monitor knows events may be missing. */
export function TimelineRow({ event, open, onToggle, onShowInTranscript, showSources = false }: TimelineRowProps) {
  const t = useT();
  if (event.type === 'monitor.gap') {
    return (
      <li className="event-row event-row--gap" id={`ev-${String(event.id)}`} role="note">
        <Icon name="alert" />
        <span>
          {event.summary === '' ? t('tabs.events.gap') : t('tabs.events.gapDetail', { detail: event.summary })}
        </span>
      </li>
    );
  }
  const details = Object.entries(event.details);
  const dot = dotOf(event, t);
  const what = event.toolName ?? event.type;
  const detailsId = `ev-details-${String(event.id)}`;
  const classes = ['event-row'];
  if (event.severity === 'error') classes.push('event-row--error');
  if (event.severity === 'warning') classes.push('event-row--warning');
  return (
    <li className={classes.join(' ')} id={`ev-${String(event.id)}`}>
      <div className="event-row__line">
        <span className="event-row__time">
          <RelativeTime iso={event.at} mode="clock" />
        </span>
        <span className="event-row__icon" title={t(CATEGORY_KEYS[event.category])}>
          <Icon name={CATEGORY_ICON[event.category]} />
          <span className="sr-only">{t(CATEGORY_KEYS[event.category])}</span>
        </span>
        <EventName event={event} />
        {dot === null ? (
          <span className="event-row__dot" />
        ) : (
          <span className="event-row__dot" title={dot.text}>
            <span className={`event-dot event-dot--${dot.tone}`} aria-hidden="true" />
            <span className="sr-only">{dot.text}</span>
          </span>
        )}
        <span className="event-row__duration muted">
          {event.durationMs === null ? null : t('tabs.events.durationMs', { ms: event.durationMs })}
        </span>
        <span className="event-row__agent muted" title={event.agentLabel ?? undefined}>
          {event.agentLabel}
        </span>
        {showSources ? (
          <span className="event-row__sources">
            {event.sources.map((source) => (
              <TagBadge key={source} tone="neutral">
                {t(`tabs.events.source.${source}`)}
              </TagBadge>
            ))}
          </span>
        ) : null}
        <span className="event-row__actions">
          {event.transcriptRef === null || onShowInTranscript === undefined ? null : (
            <Button
              variant="icon"
              icon="file-text"
              title={t('tabs.events.showInTranscript')}
              aria-label={t('tabs.events.showInTranscriptFor', { what })}
              onClick={() => {
                onShowInTranscript(event);
              }}
            />
          )}
          {details.length === 0 && event.summary.length === 0 ? null : (
            <Button
              variant="icon"
              icon={open ? 'chevron-down' : 'chevron-right'}
              aria-label={t('tabs.events.details', { type: event.type })}
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              onClick={() => {
                onToggle(event.id, !open);
              }}
            />
          )}
        </span>
      </div>
      {open ? (
        <div id={detailsId} className="event-row__more">
          {event.summary === '' ? null : <p className="event-row__full">{event.summary}</p>}
          {details.length === 0 ? null : (
            <dl className="event-row__details">
              {details.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value === null ? t('tabs.events.noValue') : String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </li>
  );
}
