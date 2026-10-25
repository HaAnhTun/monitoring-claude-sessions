import { toQuery, type ActivityEvent, type ToolCallItem } from '@mcs/shared';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { clipText } from '../../components/ClampedText.tsx';
import { DataTable, type Column, type DataCard } from '../../components/DataTable.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Icon } from '../../components/Icon.tsx';
import { LoadMore } from '../../components/LoadMore.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { useToolCalls } from '../../data/hooks/useToolCalls.ts';
import { TIMELINE_PAGE_LIMIT, useTimeline } from '../../data/hooks/useTimeline.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import type { Formatters } from '../../i18n/format.ts';
import type { TFunction } from '../../i18n/types.ts';
import { formatUrlState, parseUrlState, sessionDetailSpec } from '../../lib/url-state.ts';
import { useShowInTranscript } from './TimelineRow.tsx';

export interface SessionErrorsProps {
  sessionId: string;
  /** `null` or omitted: every agent of the session. */
  agentId?: string | null;
  /** The label of the chosen agent, for the line that says the list is narrowed to it. */
  agentLabel?: string | undefined;
  /** The errors and warnings of the whole session (not of the chosen agent), for the line above the list. */
  errorCount?: number | undefined;
  warningCount?: number | undefined;
}

const SKELETON_ROWS = 4;
/** The first line of a message is cut here (review R-13). */
const MESSAGE_CHARS = 120;
const DEFAULTS = parseUrlState(sessionDetailSpec, new URLSearchParams()).value;
const ALL_AGENTS_SEARCH = `?${formatUrlState(sessionDetailSpec, { ...DEFAULTS, tab: 'errors' }).toString()}`;

/** The first line of the text the monitor recorded for the failure, cut to 120 characters. */
export function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > MESSAGE_CHARS ? `${clipText(line, MESSAGE_CHARS).trimEnd()}…` : line;
}

/** One row of the tab: the event, and what the tool call behind it adds (the engine keeps the tool name and its argument there). */
interface Failure {
  event: ActivityEvent;
  /** The tool that failed: the one the event names, or the one of its tool call. */
  tool: string | null;
  /** What the tool was asked to do: the summary of the input of its call. */
  argument: string | null;
  durationMs: number | null;
  /** Only a non-zero exit code is worth a word. */
  exitCode: number | null;
}

function failureOf(event: ActivityEvent, call: ToolCallItem | undefined): Failure {
  const exitCode = call?.exitCode ?? null;
  const summary = call?.summary ?? '';
  return {
    event,
    tool: event.toolName ?? call?.name ?? null,
    argument: summary === '' ? null : firstLine(summary),
    durationMs: event.durationMs ?? call?.durationMs ?? null,
    exitCode: exitCode === null || exitCode === 0 ? null : exitCode,
  };
}

function durationText(t: TFunction, format: Formatters, ms: number): string {
  return ms < 1000 ? t('tabs.events.durationMs', { ms }) : format.duration(ms / 1000);
}

function SeverityIcon({ event }: { event: ActivityEvent }) {
  const t = useT();
  const error = event.severity === 'error';
  return (
    <span className={error ? 'error-row__severity error-row__severity--error' : 'error-row__severity'}>
      <Icon name={error ? 'failed' : 'alert'} />
      <span className="sr-only">{t(error ? 'tabs.severity.error' : 'tabs.severity.warning')}</span>
    </span>
  );
}

/** What the transcript button is called for: the tool, or the kind of the event when no tool is involved. */
function whatOf(failure: Failure): string {
  return failure.tool ?? failure.event.type;
}

/** The tool that failed and what it was asked to do, or the kind of the event when no tool is involved. */
function WhatCell({ failure }: { failure: Failure }) {
  return (
    <span className="error-row__what">
      <SeverityIcon event={failure.event} />
      <span className="error-row__name">
        {failure.tool === null ? (
          <span className="mono error-row__type">{failure.event.type}</span>
        ) : (
          <span className="error-row__tool">{failure.tool}</span>
        )}
        {failure.argument === null ? null : (
          <span className="mono muted error-row__argument" title={failure.argument}>
            {failure.argument}
          </span>
        )}
      </span>
    </span>
  );
}

function MessageCell({ failure }: { failure: Failure }) {
  const t = useT();
  const format = useFormat();
  const { event } = failure;
  const message = firstLine(event.summary);
  let timing: string | null = null;
  if (failure.durationMs !== null) {
    const duration = durationText(t, format, failure.durationMs);
    timing =
      event.toolStatus === 'failed' || failure.exitCode !== null
        ? t('tabs.errors.failedAfter', { duration })
        : t('tabs.errors.tookDuration', { duration });
  }
  return (
    <span className="error-row__message" title={event.summary === '' ? undefined : event.summary}>
      {message === '' ? <span className="muted">{t('tabs.errors.noMessage')}</span> : <span>{message}</span>}
      {timing === null && failure.exitCode === null ? null : (
        <span className="muted error-row__timing">
          {timing === null ? null : <span>{timing}</span>}
          {failure.exitCode === null ? null : <span>{t('tabs.errors.exitCode', { code: failure.exitCode })}</span>}
        </span>
      )}
    </span>
  );
}

function EventCell({ event }: { event: ActivityEvent }) {
  const t = useT();
  return (
    <span className="error-row__event">
      <span className="mono" title={t('tabs.errors.eventTip')}>{`#${String(event.id)}`}</span>
      <RelativeTime iso={event.at} mode="clock" />
    </span>
  );
}

function OpenButton({ failure, onOpen }: { failure: Failure; onOpen: (event: ActivityEvent) => void }) {
  const t = useT();
  if (failure.event.transcriptRef === null) return null;
  return (
    <Button
      variant="quiet"
      icon="file-text"
      aria-label={t('tabs.errors.openFor', { what: whatOf(failure) })}
      onClick={() => {
        onOpen(failure.event);
      }}
    >
      {t('tabs.errors.open')}
    </Button>
  );
}

function rowKey(failure: Failure): string {
  return String(failure.event.id);
}

function rowClass(failure: Failure): string | undefined {
  return failure.event.severity === 'error' ? 'error-row--error' : undefined;
}

/**
 * The warnings and errors the monitor recorded for the session, one row each (review R-13): the tool that failed and its argument,
 * how long it took, the first line of what was recorded, the number and time of the event and a button that opens its place in
 * the transcript. The engine keeps the tool name, the argument, the duration and the exit code of a failed call on the call, not
 * on the event of its result, so the failed calls of the session are read too and matched by the tool use id; without them the row
 * names the kind of the event. The agent column hides itself when every row is from the same agent. The events carry no error
 * body (the monitor never stores one), so the message is the summary the monitor wrote for the event, or "No message recorded".
 */
export function SessionErrors({ sessionId, agentId = null, agentLabel, errorCount, warningCount }: SessionErrorsProps) {
  const t = useT();
  const query = useMemo(
    () => toQuery({ severity: ['warning', 'error'], ...(agentId === null ? {} : { agent: agentId }) }),
    [agentId],
  );
  const list = useTimeline(sessionId, query);
  const callsQuery = useMemo(
    () => toQuery({ status: ['failed'], ...(agentId === null ? {} : { agent: agentId }) }),
    [agentId],
  );
  const calls = useToolCalls(sessionId, callsQuery);
  const showInTranscript = useShowInTranscript();
  const result = list.query;

  const failures = useMemo(() => {
    const byUse = new Map<string, ToolCallItem>();
    for (const call of calls.data?.items ?? []) byUse.set(call.toolUseId, call);
    return list.items.map((event) =>
      failureOf(event, event.toolUseId === null ? undefined : byUse.get(event.toolUseId)),
    );
  }, [list.items, calls.data]);

  const columns = useMemo<Column<Failure>[]>(
    () => [
      { id: 'what', header: t('tabs.errors.col.what'), cell: (failure) => <WhatCell failure={failure} /> },
      { id: 'message', header: t('tabs.errors.col.message'), cell: (failure) => <MessageCell failure={failure} /> },
      {
        id: 'agent',
        header: t('tabs.errors.col.agent'),
        priority: 2,
        nowrap: true,
        hideWhenEmpty: 'same',
        value: (failure) => failure.event.agentLabel,
        cell: (failure) => (
          <span className="error-row__agent" title={failure.event.agentLabel ?? undefined}>
            {failure.event.agentLabel}
          </span>
        ),
      },
      {
        id: 'event',
        header: t('tabs.errors.col.event'),
        nowrap: true,
        cell: (failure) => <EventCell event={failure.event} />,
      },
      {
        id: 'open',
        header: t('tabs.errors.col.open'),
        nowrap: true,
        cell: (failure) => <OpenButton failure={failure} onOpen={showInTranscript} />,
      },
    ],
    [t, showInTranscript],
  );
  const card = useMemo(
    () =>
      (failure: Failure): DataCard => ({
        lead: <SeverityIcon event={failure.event} />,
        title: (
          <span className="error-row__name">
            <span className={failure.tool === null ? 'mono error-row__type' : 'error-row__tool'}>
              {whatOf(failure)}
            </span>
            {failure.argument === null ? null : (
              <span className="mono muted error-row__argument" title={failure.argument}>
                {failure.argument}
              </span>
            )}
          </span>
        ),
        end: <EventCell event={failure.event} />,
        meta: (
          <>
            <MessageCell failure={failure} />
            <OpenButton failure={failure} onOpen={showInTranscript} />
          </>
        ),
      }),
    [showInTranscript],
  );

  let body;
  if (result.data === undefined) {
    body = result.isError ? (
      <ErrorState
        kind="load"
        subjectKey="error.subject.errors"
        error={result.error}
        onRetry={() => {
          void result.refetch();
        }}
      />
    ) : (
      <Skeleton variant="list" rows={SKELETON_ROWS} label={t('tabs.errors.loading')} />
    );
  } else if (list.items.length === 0) {
    body = (
      <EmptyState
        title={
          agentId === null ? t('tabs.errors.empty') : t('tabs.errors.emptyAgent', { agent: agentLabel ?? agentId })
        }
        icon="completed"
      />
    );
  } else {
    const lastPage = result.data.pages.at(-1);
    body = (
      <>
        <DataTable<Failure>
          caption={t('tabs.errors.caption')}
          columns={columns}
          rows={failures}
          rowKey={rowKey}
          rowClass={rowClass}
          card={card}
        />
        <LoadMore
          hasMore={result.hasNextPage}
          loading={result.isFetchingNextPage}
          onLoad={() => {
            void result.fetchNextPage();
          }}
          shown={list.items.length}
          total={lastPage?.total ?? null}
          totalIsLowerBound={lastPage?.totalIsLowerBound ?? false}
          nounKey="common.noun.events"
          capped={list.capped}
          pageSize={TIMELINE_PAGE_LIMIT}
        />
      </>
    );
  }
  const refreshFailing = result.isError && result.data !== undefined && !result.isFetchNextPageError;
  const counted = errorCount !== undefined && warningCount !== undefined && errorCount + warningCount > 0;
  return (
    <section className="errors-tab" aria-label={t('tabs.errors.region')}>
      {counted || agentId !== null ? (
        <p className="errors-tab__head">
          {counted ? (
            <span className="errors-tab__count">
              {t('tabs.errors.summary', { errors: errorCount, warnings: warningCount })}
            </span>
          ) : null}
          {agentId === null ? null : (
            <span className="muted">
              {t('tabs.errors.agentScope', { agent: agentLabel ?? agentId })}{' '}
              <Link to={{ search: ALL_AGENTS_SEARCH }}>{t('tabs.errors.showAll')}</Link>
            </span>
          )}
        </p>
      ) : null}
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.errors"
          error={result.error}
          lastGoodAt={result.dataUpdatedAt}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : null}
      {body}
    </section>
  );
}
