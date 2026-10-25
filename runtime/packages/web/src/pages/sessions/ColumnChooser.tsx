import { useCallback, useMemo } from 'react';

import { Button } from '../../components/Button.tsx';
import { Popover } from '../../components/Popover.tsx';
import { useT } from '../../i18n/context.ts';
import { usePrefs } from '../../state/prefs-store.ts';

export interface ColumnOption {
  id: string;
  label: string;
  /** The column cannot be turned off (it carries the link of the row). */
  required?: boolean;
}

export interface ColumnChoice {
  /** The ids of the columns to draw, in the order of the table. */
  selected: readonly string[];
  /** Turns one column on or off. */
  toggle: (id: string, on: boolean) => void;
  /** Back to the default columns; the stored choice is forgotten. */
  reset: () => void;
  /** The selection is the default one. */
  isDefault: boolean;
}

/**
 * The columns to draw: the stored choice cleaned of ids the table does not know and completed with the required ones, in the
 * order of the table; the default columns when nothing is stored.
 */
export function resolveColumns(
  stored: readonly string[] | undefined,
  all: readonly string[],
  required: readonly string[],
  defaults: readonly string[],
): string[] {
  if (stored === undefined) return [...defaults];
  const chosen = new Set([...stored, ...required]);
  return all.filter((id) => chosen.has(id));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The columns of one table as the user chose them (ADR 0073 decision 7, review R-35). The choice lives in the `tableColumns`
 * preference under the table id; a choice equal to the default is not stored, so a later change of the defaults reaches
 * everyone who never chose. `all`, `required` and `defaults` are constants of the table (stable between renders).
 */
export function useColumnChoice(
  tableId: string,
  all: readonly string[],
  required: readonly string[],
  defaults: readonly string[],
): ColumnChoice {
  const { prefs, setPref } = usePrefs();
  const tables = prefs.tableColumns;
  const stored = tables?.[tableId];
  const selected = useMemo(() => resolveColumns(stored, all, required, defaults), [stored, all, required, defaults]);

  const store = useCallback(
    (ids: readonly string[] | null) => {
      const others = Object.fromEntries(Object.entries(tables ?? {}).filter(([id]) => id !== tableId));
      setPref('tableColumns', ids === null ? others : { ...others, [tableId]: [...ids] });
    },
    [tables, tableId, setPref],
  );
  const toggle = useCallback(
    (id: string, on: boolean) => {
      const next = new Set(selected);
      if (on) next.add(id);
      else next.delete(id);
      const ids = resolveColumns([...next], all, required, defaults);
      store(sameList(ids, defaults) ? null : ids);
    },
    [selected, all, required, defaults, store],
  );
  const reset = useCallback(() => {
    store(null);
  }, [store]);
  return { selected, toggle, reset, isDefault: sameList(selected, defaults) };
}

export interface ColumnChooserProps {
  /** The key of the table in the `tableColumns` preference. */
  tableId: string;
  /** Every column the table can draw, in its order. */
  options: readonly ColumnOption[];
  /** The columns drawn until the user chooses. */
  defaults: readonly string[];
}

/** The "Columns" button of a table and the panel of check boxes behind it. */
export function ColumnChooser({ tableId, options, defaults }: ColumnChooserProps) {
  const t = useT();
  const all = useMemo(() => options.map((option) => option.id), [options]);
  const required = useMemo(
    () => options.filter((option) => option.required === true).map((option) => option.id),
    [options],
  );
  const choice = useColumnChoice(tableId, all, required, defaults);
  return (
    <Popover icon="columns" label={t('sessions.columns.button')} panelLabel={t('sessions.columns.panel')} align="end">
      <div className="column-chooser">
        <fieldset className="column-chooser__group">
          <legend className="sr-only">{t('sessions.columns.panel')}</legend>
          {options.map((option) => (
            <label key={option.id} className="filter-bar__check">
              <input
                type="checkbox"
                checked={choice.selected.includes(option.id)}
                disabled={option.required === true}
                onChange={(event) => {
                  choice.toggle(option.id, event.target.checked);
                }}
              />
              <span>{option.label}</span>
              {option.required === true ? (
                <span className="muted column-chooser__note">{t('sessions.columns.required')}</span>
              ) : null}
            </label>
          ))}
        </fieldset>
        <p className="muted column-chooser__hint">{t('sessions.columns.hint')}</p>
        <Button variant="quiet" onClick={choice.reset} disabled={choice.isDefault}>
          {t('sessions.columns.reset')}
        </Button>
      </div>
    </Popover>
  );
}
