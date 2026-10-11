import { routes, type ActivityEvent, type ToolStatus } from '@mcs/shared';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { ClampedText } from '../../components/ClampedText.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TagBadge, type Tone } from '../../components/TagBadge.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { pathFor } from '../../data/endpoints.ts';
import { useDataEnv } from '../../data/hooks/useInstance.ts';
import { fmtDuration } from '../../lib/format.ts';
import { formatUrlState, parseUrlState, sessionDetailSpec } from '../../lib/url-state.ts';
import { useShowToast } from '../../state/toast-store.ts';

/** One-line summaries longer than this are clamped with "Show more". */
const SUMMARY_CLAMP_CHARS = 200;
const MAIN_AGENT = 'main';
const DEFAULTS = parseUrlState(sessionDetailSpec, new URLSearchParams()).value;

const TOOL_STATUS_TONE: Readonly<Record<ToolStatus, Tone>> = {
  pending: 'running',
  succeeded: 'completed',
  failed: 'failed',
  denied: 'waiting',
  interrupted: 'idle',
  unknown: 'unknown',
};

export interface TimelineRowProps {
  event: ActivityEvent;
  /** The details are open. */
  open: boolean;
  onToggle: (eventId: number, open: boolean) => void;
  /** Absent: no "Show in transcript" button. */
  onShowInTranscript?: ((event: ActivityEvent) => void) | undefined;
}

function durationText(ms: number): string {
  return ms < 1000 ? `${String(ms)} ms` : fmtDuration(ms / 1000);
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
          const detail = error instanceof ApiError ? error.message : 'unexpected error';
          showToast(`Could not open the transcript: ${detail}`, { kind: 'error' });
        });
    },
    [api, navigate, showToast],
  );
}

function SeverityMark({ severity }: { severity: ActivityEvent['severity'] }) {
  if (severity === 'info') return null;
  return (
    <span className={`timeline-row__severity timeline-row__severity--${severity}`}>
      <Icon name={severity === 'error' ? 'failed' : 'alert'} />
      <span>{severity}</span>
    </span>
  );
}

/** A row of the session timeline: a monitor event, or a separator where the monitor knows events may be missing. */
export function TimelineRow({ event, open, onToggle, onShowInTranscript }: TimelineRowProps) {
  if (event.type === 'monitor.gap') {
    return (
      <li className="timeline-row timeline-row--gap" id={`ev-${String(event.id)}`} role="note">
        <Icon name="alert" />
        <span>
          {event.summary === '' ? 'Events may be missing here.' : `Events may be missing here: ${event.summary}`}
        </span>
      </li>
    );
  }
  const details = Object.entries(event.details);
  const rowClass = event.severity === 'error' ? 'timeline-row timeline-row--error' : 'timeline-row';
  return (
    <li className={rowClass} id={`ev-${String(event.id)}`}>
      <div className="timeline-row__head">
        <RelativeTime iso={event.at} mode="clock" />
        <SeverityMark severity={event.severity} />
        <TagBadge tone="neutral">{event.category}</TagBadge>
        <span className="mono timeline-row__type">{event.type}</span>
        {event.toolName === null ? null : <span className="timeline-row__tool">{event.toolName}</span>}
        {event.toolStatus === null ? null : (
          <TagBadge tone={TOOL_STATUS_TONE[event.toolStatus]}>{event.toolStatus}</TagBadge>
        )}
        {event.durationMs === null ? null : <span className="muted">{durationText(event.durationMs)}</span>}
        {event.agentLabel === null ? null : <span className="muted">{event.agentLabel}</span>}
        <span className="timeline-row__sources">
          {event.sources.map((source) => (
            <TagBadge key={source} tone="neutral">
              {source}
            </TagBadge>
          ))}
        </span>
      </div>
      {event.summary === '' ? null : (
        <div className="timeline-row__summary">
          <ClampedText
            id={`ev-summary-${String(event.id)}`}
            text={event.summary}
            clampChars={SUMMARY_CLAMP_CHARS}
            render={(text) => <span>{text}</span>}
          />
        </div>
      )}
      <div className="timeline-row__actions">
        {event.transcriptRef === null || onShowInTranscript === undefined ? null : (
          <Button
            variant="quiet"
            icon="file-text"
            onClick={() => {
              onShowInTranscript(event);
            }}
          >
            Show in transcript
          </Button>
        )}
      </div>
      {details.length === 0 ? null : (
        <Disclosure
          id={`ev-details-${String(event.id)}`}
          label="Details"
          open={open}
          onToggle={(next) => {
            onToggle(event.id, next);
          }}
        >
          <dl className="timeline-row__details">
            {details.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value === null ? '-' : String(value)}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      )}
    </li>
  );
}
