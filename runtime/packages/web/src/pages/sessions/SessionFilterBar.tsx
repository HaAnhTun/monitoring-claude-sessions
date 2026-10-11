import { LIFECYCLE_STATES } from '@mcs/shared';

import { FilterBar, type FilterField } from '../../components/FilterBar.tsx';
import { lifecycleDisplay } from '../../lib/lifecycle-display.ts';
import type { SessionsUrlState } from '../../lib/url-state.ts';

export interface SessionFilterBarProps {
  state: SessionsUrlState;
  onChange: (patch: Partial<SessionsUrlState>) => void;
  ignoredKeys: string[];
  onDismissIgnored: () => void;
  activeCount: number;
  onClearAll: () => void;
}

const STATE_OPTIONS = LIFECYCLE_STATES.map((state) => ({ value: state, label: lifecycleDisplay(state).label }));

/** A positive whole number from typed text; null for an empty box; undefined for text that is not a work item id. */
function parseTask(text: string): number | null | undefined {
  if (text === '') return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** The filter fields of `/sessions` (04 3.2): the URL state in, patches of it out. */
export function SessionFilterBar({
  state,
  onChange,
  ignoredKeys,
  onDismissIgnored,
  activeCount,
  onClearAll,
}: SessionFilterBarProps) {
  const fields: FilterField[] = [
    {
      kind: 'text',
      id: 'sessions-q',
      label: 'Search',
      value: state.q,
      placeholder: 'Label, id, project, model',
      shortcutSlash: true,
      onChange: (q) => {
        onChange({ q });
      },
    },
    {
      kind: 'multi',
      id: 'sessions-state',
      label: 'State',
      value: state.state,
      options: STATE_OPTIONS,
      onChange: (selected) => {
        onChange({ state: LIFECYCLE_STATES.filter((s) => selected.includes(s)) });
      },
    },
    {
      kind: 'text',
      id: 'sessions-project',
      label: 'Project',
      value: state.project,
      onChange: (project) => {
        onChange({ project });
      },
    },
    {
      kind: 'text',
      id: 'sessions-task',
      label: 'Work item',
      value: state.task === null ? '' : String(state.task),
      placeholder: 'Item number',
      onChange: (text) => {
        const task = parseTask(text);
        if (task !== undefined) onChange({ task });
      },
    },
    {
      kind: 'text',
      id: 'sessions-model',
      label: 'Model',
      value: state.model,
      onChange: (model) => {
        onChange({ model });
      },
    },
    {
      kind: 'range',
      id: 'sessions-range',
      label: 'Time range',
      value: state.range,
      onChange: (range) => {
        onChange({ range });
      },
    },
    {
      kind: 'intRange',
      id: 'sessions-tokens',
      label: 'Tokens',
      min: state.tokMin,
      max: state.tokMax,
      onChange: (tokMin, tokMax) => {
        onChange({ tokMin, tokMax });
      },
    },
    {
      kind: 'flag',
      id: 'sessions-errors',
      label: 'Only sessions with errors',
      value: state.errors,
      onChange: (errors) => {
        onChange({ errors });
      },
    },
    {
      kind: 'flag',
      id: 'sessions-unmatched',
      label: 'Show unmatched sessions',
      value: state.unmatched,
      onChange: (unmatched) => {
        onChange({ unmatched });
      },
    },
  ];
  return (
    <FilterBar
      label="Filter sessions"
      fields={fields}
      ignoredKeys={ignoredKeys}
      onDismissIgnored={onDismissIgnored}
      activeCount={activeCount}
      onClearAll={onClearAll}
    />
  );
}
