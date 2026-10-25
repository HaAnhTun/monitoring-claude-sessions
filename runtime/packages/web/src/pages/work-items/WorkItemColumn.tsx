import type { BoardState, WorkItem } from '@mcs/shared';
import { useId } from 'react';

import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { WorkItemCard } from './WorkItemCard.tsx';

/** The heading of each column: the board vocabulary, with the long name the design gives to the stale column (04 4.4.5). */
const COLUMN_LABEL = {
  working: 'state.working.label',
  waiting: 'state.board.waiting',
  completed: 'state.completed.label',
  failed: 'state.failed.label',
  stale: 'tasks.column.stale',
  unknown: 'state.unknown.label',
} as const satisfies Readonly<Record<BoardState, MessageKey>>;

export interface WorkItemColumnProps {
  state: BoardState;
  items: readonly WorkItem[];
}

/** One column of the board: a section with its name and count, and one card per work item. Read-only (no dragging). */
export function WorkItemColumn({ state, items }: WorkItemColumnProps) {
  const t = useT();
  const headingId = useId();
  return (
    <section
      className="board__col"
      aria-labelledby={headingId}
      data-state={state}
      data-empty={items.length === 0 ? 'true' : undefined}
    >
      <header className="board__head">
        <h2 id={headingId} className="board__title">
          <span className="state-dot state-dot--solid" aria-hidden="true" />
          <span>{t(COLUMN_LABEL[state])}</span>
        </h2>
        <span className="board__count">{t('tasks.column.count', { count: items.length })}</span>
      </header>
      <div className="board__cards">
        {items.length === 0 ? (
          <p className="board__none">{t('tasks.column.empty')}</p>
        ) : (
          items.map((item) => <WorkItemCard key={item.id} item={item} />)
        )}
      </div>
    </section>
  );
}
