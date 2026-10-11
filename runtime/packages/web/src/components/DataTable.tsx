import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Icon } from './Icon.tsx';

export interface Column<R> {
  id: string;
  header: string;
  cell: (r: R) => ReactNode;
  /** The key `sort.onSort` receives; a column without one is not sortable. */
  sortKey?: string;
  align?: 'start' | 'end';
  mono?: boolean;
  hideBelow?: 'narrow';
  /** The cell that carries the router link of `rowHref` (default: the first column). */
  link?: boolean;
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
}

type AriaSort = 'ascending' | 'descending' | 'none';

function cellClass<R>(column: Column<R>): string {
  const classes: string[] = [];
  if (column.mono === true) classes.push('mono');
  if (column.align === 'end') classes.push('is-end');
  if (column.hideBelow === 'narrow') classes.push('col-narrow');
  return classes.join(' ');
}

/**
 * A semantic table: sr-only caption, `th scope=col`, sortable headers as buttons with `aria-sort`, a wrapper that scrolls
 * sideways by itself (never the page) and an optional link per row (04 4.3, 6.6 rule 8).
 */
export function DataTable<R>({ caption, columns, rows, rowKey, sort, rowHref, selectedKey }: DataTableProps<R>) {
  const linkColumn = columns.find((column) => column.link === true)?.id ?? columns[0]?.id;

  function ariaSortOf(column: Column<R>): AriaSort | undefined {
    if (sort === undefined || column.sortKey === undefined) return undefined;
    if (sort.key !== column.sortKey) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  return (
    <div className="tbl-wrap">
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const ariaSort = ariaSortOf(column);
              const sortKey = column.sortKey;
              return (
                <th key={column.id} scope="col" aria-sort={ariaSort} className={cellClass(column)}>
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
                {columns.map((column) => (
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
