import { BOARD_STATES, type BoardState, type WorkItem, type WorkItemBoard } from '@mcs/shared';
import { useCallback, useContext, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { Button } from '../../components/Button.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { FilterBar, useUrlState, type FilterField } from '../../components/FilterBar.tsx';
import { ApiError } from '../../data/api-errors.ts';
import { ApiContext, InstanceIdContext } from '../../data/hooks/useInstance.ts';
import { useWorkItems } from '../../data/hooks/useWorkItems.ts';
import { useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import { boardDisplay } from '../../lib/lifecycle-display.ts';
import { tasksSpec, type TasksUrlState } from '../../lib/url-state.ts';
import { WorkItemColumn } from './WorkItemColumn.tsx';

/** What an author writes in runtime.json to declare a work item (BoardItemSchema); the example title is in the language shown. */
function declareExample(title: string): string {
  const text = (value: string): string => JSON.stringify(value);
  return [
    '{',
    '  "board": {',
    '    "items": [',
    '      {',
    '        "key": ' + text('release') + ',',
    '        "title": ' + text(title) + ',',
    '        "match": { "labels": [' + text('release') + '] }',
    '      }',
    '    ]',
    '  }',
    '}',
  ].join(String.fromCharCode(10));
}

/** Columns that hold items are wide; an empty one shrinks, so six columns fit more often (the board scrolls inside itself). */
const FULL_COLUMN = 'minmax(12rem, 1fr)';
const EMPTY_COLUMN = 'minmax(6rem, 0.3fr)';

function kindOf(error: Error | null): 'load' | 'contract' {
  return error instanceof ApiError && error.info.kind === 'contract' ? 'contract' : 'load';
}

function matches(item: WorkItem, state: TasksUrlState): boolean {
  if (state.state.length > 0 && !state.state.includes(item.state)) return false;
  const q = state.q.toLowerCase();
  return q === '' || [item.title, item.key, item.rule, item.source].some((field) => field.toLowerCase().includes(q));
}

function countActive(state: TasksUrlState): number {
  return (state.q === '' ? 0 : 1) + (state.state.length === 0 ? 0 : 1);
}

function BoardSkeleton() {
  const t = useT();
  return (
    <div className="board board--loading" aria-busy="true">
      <span className="sr-only" role="status">
        {t('tasks.loading')}
      </span>
      {BOARD_STATES.map((state) => (
        <div key={state} className="board__col" aria-hidden="true">
          <div className="skeleton__cell board__skeleton-head" />
          <div className="skeleton__row board__skeleton-card" />
          <div className="skeleton__row board__skeleton-card" />
        </div>
      ))}
    </div>
  );
}

function Derivation({ text }: { text: string }) {
  const t = useT();
  const id = useId();
  if (text === '') return null;
  return (
    <Disclosure id={id} label={t('tasks.derivation.toggle')}>
      <p className="board__derivation">
        <ServerText>{text}</ServerText>
      </p>
    </Disclosure>
  );
}

function DeclareHelp({ derivation }: { derivation: string }) {
  const t = useT();
  return (
    <EmptyState title={t('tasks.empty.title')} icon="tasks">
      <div className="board__help">
        <p>{t('tasks.empty.body')}</p>
        <p>{t('tasks.empty.declare', { key: 'board.items' })}</p>
        <pre className="board__example">
          <code>{declareExample(t('tasks.empty.exampleTitle'))}</code>
        </pre>
        <Derivation text={derivation} />
      </div>
    </EmptyState>
  );
}

function Board({ board, filtered }: { board: WorkItemBoard; filtered: readonly WorkItem[] }) {
  const t = useT();
  const grouped = useMemo(
    () => BOARD_STATES.map((state) => ({ state, items: filtered.filter((item) => item.state === state) })),
    [filtered],
  );
  const columns = grouped.map((group) => (group.items.length === 0 ? EMPTY_COLUMN : FULL_COLUMN)).join(' ');
  const style: CSSProperties & { '--board-cols': string } = { '--board-cols': columns };
  return (
    <div
      className="board"
      role="group"
      aria-label={t('tasks.board')}
      style={style}
      data-truncated={board.truncated ? 'true' : undefined}
    >
      {grouped.map((group) => (
        <WorkItemColumn key={group.state} state={group.state} items={group.items} />
      ))}
    </div>
  );
}

function BoardBody() {
  const t = useT();
  const board = useWorkItems();
  const [state, setState, ignored] = useUrlState(tasksSpec);
  const [dismissed, setDismissed] = useState<string[] | null>(null);

  const stateOptions = BOARD_STATES.map((value) => ({
    value,
    label: value === 'stale' ? t('tasks.column.stale') : t(boardDisplay(value).labelKey),
  }));
  const fields: FilterField[] = [
    {
      kind: 'text',
      id: 'tasks-q',
      label: t('tasks.filter.search'),
      value: state.q,
      placeholder: t('tasks.filter.searchPlaceholder'),
      shortcutSlash: true,
      onChange: (q) => {
        setState({ q });
      },
    },
    {
      kind: 'multi',
      id: 'tasks-state',
      label: t('tasks.filter.state'),
      value: state.state,
      options: stateOptions,
      onChange: (selected) => {
        setState({ state: BOARD_STATES.filter((value): value is BoardState => selected.includes(value)) });
      },
    },
  ];
  const clearAll = useCallback(() => {
    setState({ q: '', state: [] });
  }, [setState]);

  const data = board.data;
  const filtered = useMemo(
    () => (data === undefined ? [] : data.items.filter((item) => matches(item, state))),
    [data, state],
  );
  const activeCount = countActive(state);

  let body: ReactNode;
  if (data === undefined) {
    body = board.isError ? (
      <ErrorState
        kind={kindOf(board.error)}
        subjectKey="error.subject.tasks"
        error={board.error}
        onRetry={() => {
          void board.refetch();
        }}
      />
    ) : (
      <BoardSkeleton />
    );
  } else if (data.items.length === 0) {
    body = <DeclareHelp derivation={data.derivation} />;
  } else if (filtered.length === 0) {
    body = (
      <EmptyState title={t('tasks.filtered.title')}>
        <p>{t('tasks.filtered.hint')}</p>
        <Button onClick={clearAll}>{t('tasks.filtered.clear')}</Button>
      </EmptyState>
    );
  } else {
    body = <Board board={data} filtered={filtered} />;
  }

  const refreshFailing = board.isError && data !== undefined;
  return (
    <>
      {data?.items.length === 0 ? null : (
        <FilterBar
          label={t('tasks.filter.label')}
          fields={fields}
          primary={fields}
          ignoredKeys={ignored.length > 0 && dismissed !== ignored ? ignored : []}
          onDismissIgnored={() => {
            setDismissed(ignored);
          }}
          activeCount={activeCount}
          onClearAll={clearAll}
        />
      )}
      {refreshFailing ? (
        <ErrorState
          kind="refresh"
          size="inline"
          subjectKey="error.subject.tasks"
          error={board.error}
          lastGoodAt={board.dataUpdatedAt}
          onRetry={() => {
            void board.refetch();
          }}
        />
      ) : null}
      {data === undefined || data.items.length === 0 ? null : <Derivation text={data.derivation} />}
      {data?.truncated === true ? <p className="muted">{t('tasks.truncated', { count: data.items.length })}</p> : null}
      {body}
    </>
  );
}

function BoardUnavailable() {
  const t = useT();
  return <p className="muted">{t('tasks.waiting')}</p>;
}

/** `/tasks`: the work items in six columns with the evidence behind each placement (04 4.4.5). */
export function WorkItemBoardPage() {
  const t = useT();
  const title = t('route.tasks.title');
  const headingRef = usePageChrome(title);
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return (
    <section className="page tasks">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      {api === null || instanceId === null ? <BoardUnavailable /> : <BoardBody />}
    </section>
  );
}
