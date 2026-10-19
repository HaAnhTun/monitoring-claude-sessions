import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { Button } from './Button.tsx';

/** What the rows are called, as a plural message of the catalogue: `common.noun.sessions` reads "session" or "sessions". */
export type NounKey = Extract<MessageKey, `common.noun.${string}`>;

export interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  /** Rows on screen. */
  shown: number;
  /** Rows the server counted; null when it did not count. */
  total: number | null;
  /** What the rows are called (a `common.noun.*` message); the plural form follows the count. */
  nounKey?: NounKey | undefined;
  /** Deprecated: plural noun as plain English text ("sessions"); use `nounKey`. Kept until the pages that pass it are converted. */
  noun?: string | undefined;
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
  nounKey,
  noun = '',
  capped = false,
  pageSize = DEFAULT_PAGE_SIZE,
  totalIsLowerBound = false,
}: LoadMoreProps) {
  const t = useT();
  const name = nounKey === undefined ? noun : t(nounKey, { count: total ?? shown });
  if (capped) {
    return (
      <div className="load-more">
        <p role="status" className="load-more__text">
          {t('common.loadMore.capped', { shown, noun: name })}
        </p>
      </div>
    );
  }
  let count: string;
  if (total === null) count = t('common.loadMore.showing', { shown, noun: name });
  else if (totalIsLowerBound) count = t('common.loadMore.showingOfAtLeast', { shown, total, noun: name });
  else count = t('common.loadMore.showingOf', { shown, total, noun: name });
  const step = total === null || totalIsLowerBound ? pageSize : Math.max(1, Math.min(pageSize, total - shown));
  return (
    <div className="load-more">
      <p role="status" className="load-more__text">
        {count}
      </p>
      {hasMore ? (
        <Button onClick={onLoad} loading={loading} disabled={loading}>
          {loading ? t('common.loading') : t('common.loadMore.button', { count: step })}
        </Button>
      ) : null}
    </div>
  );
}
