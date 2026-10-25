import { LIFECYCLE_STATES } from '@mcs/shared';

import { FilterBar, type FilterField } from '../../components/FilterBar.tsx';
import { useT } from '../../i18n/context.ts';
import { lifecycleDisplay } from '../../lib/lifecycle-display.ts';
import type { SessionsUrlState, TimeRange } from '../../lib/url-state.ts';

export interface SessionFilterBarProps {
  state: SessionsUrlState;
  onChange: (patch: Partial<SessionsUrlState>) => void;
  /** The range that means "no filter": the default of the address. */
  rangeDefault: TimeRange;
  ignoredKeys: string[];
  onDismissIgnored: () => void;
  activeCount: number;
  onClearAll: () => void;
}

/** A positive whole number from typed text; null for an empty box; undefined for text that is not a work item id. */
function parseTask(text: string): number | null | undefined {
  if (text === '') return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/**
 * The filters of `/sessions` (ADR 0073 decision 7): one row with the search (the `/` key), the state chip, the time range and
 * "Only errors", then "More filters (n)" with project, work item, model, tokens and the unmatched switch; a filter that is on
 * and sits in the popover has a removable chip under the row. The URL state in, patches of it out.
 */
export function SessionFilterBar({
  state,
  onChange,
  rangeDefault,
  ignoredKeys,
  onDismissIgnored,
  activeCount,
  onClearAll,
}: SessionFilterBarProps) {
  const t = useT();
  const stateOptions = LIFECYCLE_STATES.map((member) => ({
    value: member,
    label: t(lifecycleDisplay(member).labelKey),
  }));
  const search: FilterField = {
    kind: 'text',
    id: 'sessions-q',
    label: t('sessions.filter.search'),
    value: state.q,
    placeholder: t('sessions.filter.searchPlaceholder'),
    shortcutSlash: true,
    onChange: (q) => {
      onChange({ q });
    },
  };
  const states: FilterField = {
    kind: 'multi',
    id: 'sessions-state',
    label: t('sessions.filter.state'),
    value: state.state,
    options: stateOptions,
    onChange: (selected) => {
      onChange({ state: LIFECYCLE_STATES.filter((member) => selected.includes(member)) });
    },
  };
  const range: FilterField = {
    kind: 'range',
    id: 'sessions-range',
    label: t('sessions.filter.range'),
    value: state.range,
    defaultValue: rangeDefault,
    onChange: (next) => {
      onChange({ range: next });
    },
  };
  const errors: FilterField = {
    kind: 'flag',
    id: 'sessions-errors',
    label: t('sessions.filter.errors'),
    value: state.errors,
    onChange: (next) => {
      onChange({ errors: next });
    },
  };
  const more: FilterField[] = [
    {
      kind: 'text',
      id: 'sessions-project',
      label: t('sessions.filter.project'),
      value: state.project,
      onChange: (project) => {
        onChange({ project });
      },
    },
    {
      kind: 'text',
      id: 'sessions-task',
      label: t('sessions.filter.task'),
      value: state.task === null ? '' : String(state.task),
      placeholder: t('sessions.filter.taskPlaceholder'),
      onChange: (text) => {
        const task = parseTask(text);
        if (task !== undefined) onChange({ task });
      },
    },
    {
      kind: 'text',
      id: 'sessions-model',
      label: t('sessions.filter.model'),
      value: state.model,
      onChange: (model) => {
        onChange({ model });
      },
    },
    {
      kind: 'intRange',
      id: 'sessions-tokens',
      label: t('sessions.filter.tokens'),
      min: state.tokMin,
      max: state.tokMax,
      onChange: (tokMin, tokMax) => {
        onChange({ tokMin, tokMax });
      },
    },
    {
      kind: 'flag',
      id: 'sessions-unmatched',
      label: t('sessions.filter.unmatched'),
      value: state.unmatched,
      onChange: (unmatched) => {
        onChange({ unmatched });
      },
    },
  ];
  const primary = [search, states, range, errors];
  return (
    <FilterBar
      label={t('sessions.filter.label')}
      fields={[...primary, ...more]}
      primary={primary}
      ignoredKeys={ignoredKeys}
      onDismissIgnored={onDismissIgnored}
      activeCount={activeCount}
      onClearAll={onClearAll}
    />
  );
}
