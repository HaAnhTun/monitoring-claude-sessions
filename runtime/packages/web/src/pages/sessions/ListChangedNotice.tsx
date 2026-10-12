import type { QueryKey } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { Button } from '../../components/Button.tsx';
import { useStreamControls } from '../../stream/StreamProvider.tsx';

export interface ListChangedNoticeProps {
  /** The list query key the reconciler counts pending changes for (`qk.sessions(iid, query)`). */
  queryKey: QueryKey;
  /** Applies the pending changes: the explorer refetches its loaded pages. */
  onRefresh: () => void;
}

const NO_UNSUBSCRIBE = (): void => undefined;

/**
 * The "List changed: Refresh" notice of 04 5.5 rule R3. While the stream is live the explorer stops polling and the reconciler
 * only counts the membership changes it did not apply to a list the user has scrolled away from (or that has several pages).
 * Nothing is shown when the count is zero or there is no stream provider. Refresh forgets the count first, then refetches.
 */
export function ListChangedNotice({ queryKey, onRefresh }: ListChangedNoticeProps) {
  const pending = useStreamControls()?.pending ?? null;
  // The count lives outside React: the version number changes on every bump or reset and is the store snapshot.
  const subscribe = useCallback((notify: () => void) => pending?.subscribe(notify) ?? NO_UNSUBSCRIBE, [pending]);
  useSyncExternalStore(subscribe, () => pending?.version() ?? 0);
  const count = pending?.get(queryKey) ?? 0;
  if (pending === null || count === 0) return null;
  return (
    <div role="status" aria-label="List changed" className="state state--inline">
      <span className="state__title">{`${String(count)} ${count === 1 ? 'session' : 'sessions'} changed`}</span>
      <span className="state__actions">
        <Button
          icon="refresh"
          onClick={() => {
            pending.reset(queryKey);
            onRefresh();
          }}
        >
          Refresh
        </Button>
      </span>
    </div>
  );
}
