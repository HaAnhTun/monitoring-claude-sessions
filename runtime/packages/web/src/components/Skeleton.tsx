export type SkeletonVariant = 'table' | 'list' | 'tiles' | 'text';

export interface SkeletonProps {
  rows: number;
  variant: SkeletonVariant;
  /** Text for screen readers: "Loading sessions". */
  label: string;
}

/** Placeholder while the first load runs. One status text for assistive technology; the bars are decorative. */
export function Skeleton({ rows, variant, label }: SkeletonProps) {
  const count = Math.max(0, Math.floor(rows));
  return (
    <div className={`skeleton skeleton--${variant}`} aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton__row" aria-hidden="true" />
      ))}
    </div>
  );
}
