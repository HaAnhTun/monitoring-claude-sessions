import { useContext, useEffect, useId, useRef, useState, type RefObject } from 'react';

import { Button } from '../components/Button.tsx';
import { InstanceIdContext, useInstance } from '../data/hooks/useInstance.ts';
import { useHealth } from '../data/hooks/useHealth.ts';
import { fmtAge } from '../lib/format.ts';
// eslint-disable-next-line no-restricted-imports -- the Node builtin pattern `stream` also matches the web folder src/stream (CR-WP-48-1)
import { useStreamControls } from '../stream/StreamProvider.tsx';
// eslint-disable-next-line no-restricted-imports -- the Node builtin pattern `stream` also matches the web folder src/stream (CR-WP-48-1)
import { useFreshness } from '../stream/useFreshness.ts';
import { useAnnounce } from '../state/announcer.tsx';
import { ConnectionChip } from './ConnectionChip.tsx';
import { HealthDetails } from './HealthDetails.tsx';
import { IngestionChip } from './IngestionChip.tsx';
import { PrefsControls } from './PrefsControls.tsx';

const FALLBACK_TITLE = 'Claude session monitor';

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
 * The header of the shell (04 4.1, 4.4, 5.6): the instance title and task, the connection chip and the ingestion chip (two
 * separate signals, ADR 0033), how old the data is, "Retry now"/"Refresh", the health details and the preference controls. It
 * only renders what `useFreshness` and the server's health say. The title is a paragraph, not a heading: every page owns the
 * one `h1` (6.6 rule 3). It also announces the transitions of the connection politely through the shell's live region.
 */
export function TopBar() {
  const instanceQuery = useInstance();
  const instance = instanceQuery.data;
  const iid = useContext(InstanceIdContext);
  const refetchHealth = useRef<(() => void) | null>(null);
  const stream = useStreamControls();
  const announce = useAnnounce();
  const freshness = useFreshness({ announce });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const { connection } = freshness;

  function retryNow(): void {
    stream?.retryNow();
    void instanceQuery.refetch();
    refetchHealth.current?.();
  }

  const needsRetry = connection.state === 'reconnecting' || connection.state === 'offline';
  return (
    <header className="topbar">
      {iid === null ? null : <HealthPoll refetchRef={refetchHealth} />}
      <div className="topbar__identity">
        <p className="topbar__title">{instance?.title ?? FALLBACK_TITLE}</p>
        {instance === undefined ? null : <p className="topbar__task">{instance.slug}</p>}
      </div>
      <div className="topbar__status">
        <ConnectionChip view={connection} chip={freshness.connectionChip} />
        <IngestionChip view={freshness.ingestion} chip={freshness.ingestionChip} />
        {connection.ageMs === null ? null : (
          <span className="topbar__age">{`updated ${fmtAge(connection.ageMs / 1000)} ago`}</span>
        )}
        <Button icon="refresh" onClick={retryNow}>
          {needsRetry ? 'Retry now' : 'Refresh'}
        </Button>
        <Button
          icon={detailsOpen ? 'chevron-down' : 'chevron-right'}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => {
            setDetailsOpen((open) => !open);
          }}
        >
          Details
        </Button>
      </div>
      {instance === undefined ? null : <PrefsControls />}
      <div id={detailsId} className="topbar__details" hidden={!detailsOpen}>
        {detailsOpen ? <HealthDetails /> : null}
      </div>
    </header>
  );
}
