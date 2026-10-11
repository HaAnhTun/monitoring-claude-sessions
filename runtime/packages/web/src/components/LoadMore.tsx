import { Button } from './Button.tsx';

export interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  /** Rows on screen. */
  shown: number;
  /** Rows the server counted; null when it did not count. */
  total: number | null;
  /** Plural noun: "sessions". */
  noun: string;
  /** The page limit is reached: no button, a note to narrow the filters (04 5.3 rule 3). */
  capped?: boolean | undefined;
  /** Rows per page, for the button text. Default 100. */
  pageSize?: number | undefined;
  /** The total hit the server's counting cap and is shown as "10000+". */
  totalIsLowerBound?: boolean | undefined;
}

const DEFAULT_PAGE_SIZE = 100;

export function LoadMore({
  hasMore,
  loading,
  onLoad,
  shown,
  total,
  noun,
  capped = false,
  pageSize = DEFAULT_PAGE_SIZE,
  totalIsLowerBound = false,
}: LoadMoreProps) {
  if (capped) {
    return (
      <div className="load-more">
        <p role="status" className="load-more__text">
          {`Showing the first ${String(shown)} ${noun}; narrow the filters to see others`}
        </p>
      </div>
    );
  }
  const count =
    total === null
      ? `Showing ${String(shown)} ${noun}`
      : `Showing ${String(shown)} of ${String(total)}${totalIsLowerBound ? '+' : ''} ${noun}`;
  const step = total === null || totalIsLowerBound ? pageSize : Math.max(1, Math.min(pageSize, total - shown));
  return (
    <div className="load-more">
      <p role="status" className="load-more__text">
        {count}
      </p>
      {hasMore ? (
        <Button onClick={onLoad} loading={loading} disabled={loading}>
          {loading ? 'Loading...' : `Load ${String(step)} more`}
        </Button>
      ) : null}
    </div>
  );
}
