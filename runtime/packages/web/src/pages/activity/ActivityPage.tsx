import { useCallback, useContext, useMemo, useState } from 'react';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { useUrlState } from '../../components/FilterBar.tsx';
import { toEventFilter, type EventFilter } from '../../data/endpoints.ts';
import { ApiContext, InstanceIdContext } from '../../data/hooks/useInstance.ts';
import { useT } from '../../i18n/context.ts';
import { activitySpec, formatUrlState, type ActivityUrlState } from '../../lib/url-state.ts';
import { ActivityFeed } from './ActivityFeed.tsx';
import { ActivityFilterBar } from './ActivityFilterBar.tsx';

/** The server refuses a shorter search (`query_too_short`, 03 5.4). */
const MIN_SEARCH_CHARS = 2;

/** The `listEvents` filter of the URL state, without a search the server would refuse. */
function eventFilterOf(state: ActivityUrlState): EventFilter {
  const filter = toEventFilter(state);
  if (Array.from(state.q).length < MIN_SEARCH_CHARS) delete filter.q;
  return filter;
}

/** How many filters differ from their defaults. A custom range counts once. */
function countActive(state: ActivityUrlState): number {
  const keys = new Set<string>();
  for (const key of formatUrlState(activitySpec, state).keys())
    keys.add(key === 'from' || key === 'to' ? 'range' : key);
  return keys.size;
}

const CLEARED: Partial<ActivityUrlState> = {
  types: [],
  session: '',
  project: '',
  tool: '',
  severity: [],
  q: '',
  range: activitySpec.range.default,
};

function ActivityUnavailable() {
  const t = useT();
  const title = t('route.activity.title');
  const headingRef = usePageChrome(title);
  return (
    <section className="page activity">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
    </section>
  );
}

function Activity() {
  const t = useT();
  const title = t('route.activity.title');
  const headingRef = usePageChrome(title);
  const [state, setState, ignored] = useUrlState(activitySpec);
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  const filter = useMemo(() => eventFilterOf(state), [state]);
  const activeCount = countActive(state);
  const clearAll = useCallback(() => {
    setState(CLEARED);
  }, [setState]);
  return (
    <section className="page activity">
      <header className="activity__header">
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <p className="muted">{t('activity.description')}</p>
      </header>
      <ActivityFilterBar
        state={state}
        onChange={setState}
        ignoredKeys={ignored.length > 0 && dismissed !== ignored ? ignored : []}
        onDismissIgnored={() => {
          setDismissed(ignored);
        }}
        activeCount={activeCount}
        onClearAll={clearAll}
      />
      {Array.from(state.q).length === 1 ? <p className="muted">{t('activity.filter.minSearch')}</p> : null}
      <ActivityFeed filter={filter} mode="page" filtered={activeCount > 0} onClearFilters={clearAll} />
    </section>
  );
}

/**
 * `/activity`: the events of all sessions, newest first, with filters in the address (`?severity=error` is the target of the
 * Overview error figure). Until the app providers are mounted it shows only its heading, so the route never crashes the shell.
 */
export function ActivityPage() {
  const api = useContext(ApiContext);
  const instanceId = useContext(InstanceIdContext);
  return api === null || instanceId === null ? <ActivityUnavailable /> : <Activity />;
}
