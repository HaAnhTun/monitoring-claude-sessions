import { useContext, useEffect, useRef, type RefObject } from 'react';

import { Button } from '../components/Button.tsx';
import { InstanceIdContext, useInstance } from '../data/hooks/useInstance.ts';
import { useHealth } from '../data/hooks/useHealth.ts';
import { useFormat, useT } from '../i18n/context.ts';
import { useStreamControls } from '../stream/StreamProvider.tsx';
import { useFreshness } from '../stream/useFreshness.ts';
import { useAnnounce } from '../state/announcer.tsx';
import { LiveControl } from './LiveControl.tsx';
import { UserMenu } from './UserMenu.tsx';

/**
 * The shell polls `/health` at `poll.healthMs` whenever an instance is active, with or without a stream (UI-I4). It hands its
 * own `refetch` to the bar: the same query is also read from the cache by observers without a fetch function, and only an
 * observer that owns the fetch function can refetch it.
 */
function HealthPoll({ refetchRef }: { refetchRef: RefObject<(() => void) | null> }) {
  const { refetch } = useHealth();
  useEffect(() => {
    refetchRef.current = () => {
      void refetch();
    };
    return () => {
      refetchRef.current = null;
    };
  }, [refetch, refetchRef]);
  return null;
}

/**
 * The header of the shell, 48 px (ADR 0073 decision 4, review R-04): the instance title, the one Live control (the worse of the
 * connection and the ingestion, ADR 0033), "updated Ns ago" while the data is stale, the refresh button (it says "Retry now" while
 * the monitor cannot be reached) and the user menu. It only renders what `useFreshness` and the server's health say. The title is
 * a paragraph, not a heading: every page owns the one `h1` (6.6 rule 3). It also announces the transitions of the connection
 * politely through the shell's live region.
 */
export function TopBar() {
  const t = useT();
  const format = useFormat();
  const instanceQuery = useInstance();
  const instance = instanceQuery.data;
  const iid = useContext(InstanceIdContext);
  const refetchHealth = useRef<(() => void) | null>(null);
  const stream = useStreamControls();
  const announce = useAnnounce();
  const freshness = useFreshness({ announce });
  const { connection } = freshness;

  function retryNow(): void {
    stream?.retryNow();
    void instanceQuery.refetch();
    refetchHealth.current?.();
  }

  const needsRetry = connection.state === 'reconnecting' || connection.state === 'offline';
  const title = instance?.title ?? t('shell.appTitle');
  // The task name is shown only when it adds something: a title that is the task name already says it.
  const slug = instance !== undefined && instance.slug !== instance.title ? instance.slug : null;
  return (
    <header className="topbar">
      {iid === null ? null : <HealthPoll refetchRef={refetchHealth} />}
      <div className="topbar__identity">
        <p className="topbar__title" title={title}>
          {title}
        </p>
        {slug === null ? null : (
          <p className="topbar__task" title={slug}>
            {slug}
          </p>
        )}
      </div>
      <div className="topbar__status">
        <LiveControl freshness={freshness} />
        {connection.stale && connection.ageMs !== null ? (
          <span className="topbar__age">{t('topbar.updatedAgo', { age: format.age(connection.ageMs / 1000) })}</span>
        ) : null}
        {needsRetry ? (
          <Button icon="refresh" onClick={retryNow}>
            {t('common.retryNow')}
          </Button>
        ) : (
          <Button
            variant="icon"
            icon="refresh"
            aria-label={t('topbar.refresh')}
            title={t('topbar.refresh')}
            onClick={retryNow}
          />
        )}
        {instance === undefined ? null : <UserMenu />}
      </div>
    </header>
  );
}
