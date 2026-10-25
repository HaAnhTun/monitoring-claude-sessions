import { EVENT_CATEGORIES } from '@mcs/shared';

import { FilterBar, type FilterField } from '../../components/FilterBar.tsx';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { SEVERITIES, type ActivityUrlState, type TimeRange } from '../../lib/url-state.ts';
import { CATEGORY_KEYS } from './ActivityRow.tsx';

export interface ActivityFilterBarProps {
  state: ActivityUrlState;
  onChange: (patch: Partial<ActivityUrlState>) => void;
  ignoredKeys: string[];
  onDismissIgnored: () => void;
  activeCount: number;
  onClearAll: () => void;
}

const SEVERITY_KEYS = {
  info: 'activity.severity.info',
  warning: 'activity.severity.warning',
  error: 'activity.severity.error',
} as const satisfies Record<(typeof SEVERITIES)[number], MessageKey>;

/** The range of an address without `range`, `from` and `to` (04 3.2). */
const DEFAULT_RANGE: TimeRange = { kind: 'preset', preset: '24h' };

/** The ids of the controls in the row; the others are in the "More filters" panel. */
const PRIMARY_IDS: ReadonlySet<string> = new Set([
  'activity-q',
  'activity-types',
  'activity-severity',
  'activity-range',
]);

/** The filter fields of `/activity` (04 3.2): the URL state in, patches of it out. */
export function ActivityFilterBar({
  state,
  onChange,
  ignoredKeys,
  onDismissIgnored,
  activeCount,
  onClearAll,
}: ActivityFilterBarProps) {
  const t = useT();
  const fields: FilterField[] = [
    {
      kind: 'text',
      id: 'activity-q',
      label: t('activity.filter.search'),
      value: state.q,
      placeholder: t('activity.filter.searchPlaceholder'),
      shortcutSlash: true,
      onChange: (q) => {
        onChange({ q });
      },
    },
    {
      kind: 'multi',
      id: 'activity-types',
      label: t('activity.filter.category'),
      value: state.types,
      options: EVENT_CATEGORIES.map((category) => ({ value: category, label: t(CATEGORY_KEYS[category]) })),
      onChange: (selected) => {
        onChange({ types: EVENT_CATEGORIES.filter((category) => selected.includes(category)) });
      },
    },
    {
      kind: 'multi',
      id: 'activity-severity',
      label: t('activity.filter.severity'),
      value: state.severity,
      options: SEVERITIES.map((severity) => ({ value: severity, label: t(SEVERITY_KEYS[severity]) })),
      onChange: (selected) => {
        onChange({ severity: SEVERITIES.filter((severity) => selected.includes(severity)) });
      },
    },
    {
      kind: 'range',
      id: 'activity-range',
      label: t('activity.filter.range'),
      value: state.range,
      defaultValue: DEFAULT_RANGE,
      onChange: (range) => {
        onChange({ range });
      },
    },
    {
      kind: 'text',
      id: 'activity-session',
      label: t('activity.filter.session'),
      value: state.session,
      placeholder: t('activity.filter.sessionPlaceholder'),
      onChange: (session) => {
        onChange({ session });
      },
    },
    {
      kind: 'text',
      id: 'activity-project',
      label: t('activity.filter.project'),
      value: state.project,
      placeholder: t('activity.filter.projectPlaceholder'),
      onChange: (project) => {
        onChange({ project });
      },
    },
    {
      kind: 'text',
      id: 'activity-tool',
      label: t('activity.filter.tool'),
      value: state.tool,
      placeholder: t('activity.filter.toolPlaceholder'),
      onChange: (tool) => {
        onChange({ tool });
      },
    },
  ];
  return (
    <FilterBar
      label={t('activity.filter.label')}
      fields={fields}
      primary={fields.filter((field) => PRIMARY_IDS.has(field.id))}
      ignoredKeys={ignoredKeys}
      onDismissIgnored={onDismissIgnored}
      activeCount={activeCount}
      onClearAll={onClearAll}
    />
  );
}
