import { useEffect, useId, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';

import { useT } from '../i18n/context.ts';
import { MQ_NARROW_TABLE, MQ_SHEET, useMediaQuery } from '../state/use-media-query.ts';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';

/** Below this width the priority 2 columns hide too (the priority 3 columns hide below `MQ_NARROW_TABLE`, 1280 px). */
export const MQ_COMPACT_TABLE = '(max-width: 999px)';

/** 1: always shown. 2: hidden below 1000 px. 3: hidden below 1280 px (ADR 0073 decision 7). */
export type ColumnPriority = 1 | 2 | 3;

/** What a column compares when it decides that its cells are empty or all the same. */
export type CellValue = string | number | boolean | null | undefined;

export interface Column<R> {
  id: string;
  header: string;
  /** What the column means; the tooltip of its header. */
  headerTitle?: string;
  cell: (r: R) => ReactNode;
  /** The key `sort.onSort` receives; a column without one is not sortable. */
  sortKey?: string;
  align?: 'start' | 'end';
  mono?: boolean;
  /** V3: the column is hidden below 900 px. New code uses `priority`. */
  hideBelow?: 'narrow';
  /** The cell that carries the router link of `rowHref` (default: the first column that is shown). */
  link?: boolean;
  /** Which windows show the column; default 1. */
  priority?: ColumnPriority;
  /** Figures: aligned to the end, with tabular digits, in the header and in every cell. They never wrap. */
  numeric?: boolean;
  /** The cell stays on one line (times, model names, ids): the column takes the room it needs and the others give way. */
  nowrap?: boolean;
  /**
   * Hide the column, header included, when it carries nothing: `true` when every row is empty, `'same'` when every row is empty or
   * all rows (at least two) say the same thing. Never while the table has no rows.
   */
  hideWhenEmpty?: boolean | 'same';
  /**
   * The plain value of a cell, for `hideWhenEmpty`. Without it the cell itself is compared when it is text or a number; a cell that
   * draws an element counts as content.
   */
  value?: (r: R) => CellValue;
  /** The column stays in view when the table scrolls sideways. */
  stickyStart?: boolean;
}

/** One row as a card (below 900 px): the first line is `lead`, `title` (the link of the card) and `end`; `meta` is the second. */
export interface DataCard {
  lead?: ReactNode;
  title: ReactNode;
  end?: ReactNode;
  meta?: ReactNode;
}

export interface DataTableProps<R> {
  /** Screen-reader caption and accessible name. */
  caption: string;
  columns: Column<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  sort?: { key: string; dir: 'asc' | 'desc'; onSort: (key: string) => void };
  /** The link column renders a router link; the link stretches over the whole row (CSS), so the row is clickable. */
  rowHref?: (r: R) => string;
  selectedKey?: string | null;
  /** Below 900 px the rows are drawn as cards through this renderer; without it the table stays. */
  card?: (r: R) => DataCard;
}

type AriaSort = 'ascending' | 'descending' | 'none';

// ---- which columns are shown ---------------------------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === false || (typeof value === 'string' && value.trim() === '');
}

/** `null` is empty; a string is its text; anything else is content whose sameness cannot be told. */
function sameKey(value: unknown): string | null | undefined {
  if (isEmpty(value)) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}

/** Whether the column asks to be hidden and carries nothing (or, for `'same'`, says the same in every row). */
function carriesNothing<R>(column: Column<R>, rows: readonly R[]): boolean {
  const { hideWhenEmpty } = column;
  if (hideWhenEmpty === undefined || hideWhenEmpty === false || rows.length === 0) return false;
  const keys = rows.map((row) => sameKey(column.value === undefined ? column.cell(row) : column.value(row)));
  if (keys.every((key) => key === null)) return true;
  if (hideWhenEmpty !== 'same' || rows.length < 2) return false;
  const first = keys[0];
  return typeof first === 'string' && keys.every((key) => key === first);
}

function useShownColumns<R>(columns: Column<R>[], rows: R[]): Column<R>[] {
  const narrow = useMediaQuery(MQ_NARROW_TABLE);
  const compact = useMediaQuery(MQ_COMPACT_TABLE);
  const empty = useMemo(
    () => new Set(columns.filter((column) => carriesNothing(column, rows)).map((column) => column.id)),
    [columns, rows],
  );
  return columns.filter((column) => {
    const priority = column.priority ?? 1;
    if (priority === 3 && narrow) return false;
    if (priority === 2 && compact) return false;
    return !empty.has(column.id);
  });
}

function cellClass<R>(column: Column<R>): string {
  const classes: string[] = [];
  if (column.mono === true) classes.push('mono');
  if (column.numeric === true) classes.push('is-num');
  if (column.numeric === true || column.align === 'end') classes.push('is-end');
  if (column.nowrap === true) classes.push('is-nowrap');
  if (column.hideBelow === 'narrow') classes.push('col-narrow');
  if (column.stickyStart === true) classes.push('is-sticky-start');
  return classes.join(' ');
}

// ---- a click on the row, outside its link -----------------------------------------------------------------------------------

/** Anything inside a row that does its own work when it is pressed. */
const INTERACTIVE =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="switch"]';

/**
 * The link of a row stretches over the row (CSS), except when its cell is sticky: a sticky cell is the containing block of the
 * stretched link, which then covers that cell only. So a plain click on any other part of a linked row presses its link. A click
 * with a modifier key, while text is selected, or on something interactive is left alone.
 */
function useRowClick(wrap: RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = wrap.current;
    if (element === null || !active) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const { target } = event;
      if (!(target instanceof Element) || target.closest(INTERACTIVE) !== null) return;
      if ((window.getSelection()?.toString() ?? '') !== '') return;
      target.closest('tr.data-table__row--link')?.querySelector<HTMLAnchorElement>('a.data-table__link')?.click();
    };
    element.addEventListener('click', onClick);
    return () => {
      element.removeEventListener('click', onClick);
    };
  }, [wrap, active]);
}

// ---- the table -------------------------------------------------------------------------------------------------------------

interface ViewProps<R> extends DataTableProps<R> {
  shown: Column<R>[];
}

function TableView<R>({ caption, shown, rows, rowKey, sort, rowHref, selectedKey }: ViewProps<R>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useRowClick(wrapRef, rowHref !== undefined);
  const linkColumn = shown.find((column) => column.link === true)?.id ?? shown[0]?.id;

  function ariaSortOf(column: Column<R>): AriaSort | undefined {
    if (sort === undefined || column.sortKey === undefined) return undefined;
    if (sort.key !== column.sortKey) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  return (
    <div className="tbl-wrap" ref={wrapRef}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {shown.map((column) => {
              const ariaSort = ariaSortOf(column);
              const sortKey = column.sortKey;
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cellClass(column)}
                  title={column.headerTitle}
                >
                  {sort !== undefined && sortKey !== undefined ? (
                    <button
                      type="button"
                      className="data-table__sort"
                      onClick={() => {
                        sort.onSort(sortKey);
                      }}
                    >
                      <span>{column.header}</span>
                      {ariaSort === 'ascending' ? <Icon name="arrow-up" /> : null}
                      {ariaSort === 'descending' ? <Icon name="arrow-down" /> : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const href = rowHref?.(row);
            return (
              <tr
                key={key}
                className={href === undefined ? 'data-table__row' : 'data-table__row data-table__row--link'}
                aria-current={selectedKey === key ? 'true' : undefined}
              >
                {shown.map((column) => (
                  <td key={column.id} className={cellClass(column)}>
                    {href !== undefined && column.id === linkColumn ? (
                      <Link to={href} className="data-table__link">
                        {column.cell(row)}
                      </Link>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- the card list ----------------------------------------------------------------------------------------------------------

/** The sort of a table, for a list that has no header row: the column to sort by and the direction, in one line. */
function CardSort<R>({ columns, sort }: { columns: Column<R>[]; sort: NonNullable<DataTableProps<R>['sort']> }) {
  const t = useT();
  const id = useId();
  const sortable = columns.flatMap((column) =>
    column.sortKey === undefined ? [] : [{ ...column, sortKey: column.sortKey }],
  );
  if (sortable.length === 0) return null;
  const ascending = sort.dir === 'asc';
  return (
    <div className="data-cards__sort">
      <label htmlFor={id}>{t('lists.sortBy')}</label>
      <select
        id={id}
        className="input"
        value={sort.key}
        onChange={(event) => {
          sort.onSort(event.target.value);
        }}
      >
        {sortable.map((column) => (
          <option key={column.id} value={column.sortKey}>
            {column.header}
          </option>
        ))}
      </select>
      <Button
        variant="icon"
        icon={ascending ? 'arrow-up' : 'arrow-down'}
        aria-label={t(ascending ? 'lists.sortAscending' : 'lists.sortDescending')}
        title={t(ascending ? 'lists.sortAscending' : 'lists.sortDescending')}
        onClick={() => {
          sort.onSort(sort.key);
        }}
      />
    </div>
  );
}

function CardView<R>({
  caption,
  columns,
  rows,
  rowKey,
  sort,
  rowHref,
  selectedKey,
  card,
}: DataTableProps<R> & { card: NonNullable<DataTableProps<R>['card']> }) {
  const sortable = useMemo(() => columns.filter((column) => !carriesNothing(column, rows)), [columns, rows]);
  return (
    <div className="data-cards-wrap">
      {sort === undefined ? null : <CardSort columns={sortable} sort={sort} />}
      <ul className="data-cards" aria-label={caption}>
        {rows.map((row) => {
          const key = rowKey(row);
          const href = rowHref?.(row);
          const parts = card(row);
          return (
            <li
              key={key}
              className={href === undefined ? 'data-card' : 'data-card data-card--link'}
              data-row=""
              aria-current={selectedKey === key ? 'true' : undefined}
            >
              <div className="data-card__head">
                {parts.lead}
                <span className="data-card__title">
                  {href === undefined ? (
                    parts.title
                  ) : (
                    <Link to={href} className="data-table__link">
                      {parts.title}
                    </Link>
                  )}
                </span>
                {parts.end === undefined ? null : <span className="data-card__end">{parts.end}</span>}
              </div>
              {parts.meta === undefined ? null : <div className="data-card__meta">{parts.meta}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A semantic table: sr-only caption, `th scope=col`, sortable headers as buttons with `aria-sort`, a wrapper that scrolls
 * sideways by itself (never the page) and an optional link per row (04 4.3, 6.6 rule 8). Columns carry a priority and can hide
 * themselves when empty; below 900 px a page that gave a `card` renderer gets a list of cards with one link each instead. Where
 * `matchMedia` does not exist the table with all its columns is drawn.
 */
export function DataTable<R>(props: DataTableProps<R>) {
  const sheet = useMediaQuery(MQ_SHEET);
  const shown = useShownColumns(props.columns, props.rows);
  if (sheet && props.card !== undefined) return <CardView {...props} card={props.card} />;
  return <TableView {...props} shown={shown} />;
}
