export type SkeletonVariant = 'table' | 'header' | 'tiles' | 'list' | 'text';

export interface SkeletonProps {
  /** Table: body rows. Header: meta rows under the title bar. Tiles: tiles. List and text: rows. */
  rows: number;
  variant: SkeletonVariant;
  /** Text for screen readers: "Loading sessions". */
  label: string;
  /** Table only: how many columns a row has (default 5). */
  columns?: number;
}

const DEFAULT_COLUMNS = 5;

function Cells({ count }: { count: number }) {
  return Array.from({ length: count }, (_unused, index) => <span key={index} className="skeleton__cell" />);
}

/**
 * Placeholder while the first load runs. One status text for assistive technology; the bars are decorative. A table is drawn
 * like the table it stands for (a header bar and rows of `columns` cells), a header like a title over a few meta lines.
 */
export function Skeleton({ rows, variant, label, columns = DEFAULT_COLUMNS }: SkeletonProps) {
  const count = Math.max(0, Math.floor(rows));
  const cells = Math.max(1, Math.floor(columns));
  return (
    <div className={`skeleton skeleton--${variant}`} aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {variant === 'table' ? (
        <div className="skeleton__head" aria-hidden="true">
          <Cells count={cells} />
        </div>
      ) : null}
      {variant === 'header' ? <div className="skeleton__title" aria-hidden="true" /> : null}
      {Array.from({ length: count }, (_unused, index) => (
        <div key={index} className="skeleton__row" aria-hidden="true">
          {variant === 'table' ? <Cells count={cells} /> : null}
        </div>
      ))}
    </div>
  );
}
