// The React side of the terminal events stream (ADR 0098, design 04 4.2): owns one events client while it is enabled, keeps the
// `sessions` of the cached terminal state in step with the lists the server pushes, asks the page to refresh what the list
// does not carry when sessions came or went, refreshes the whole instance after a restart of the server and locks the page
// when the stream ended because the credential is gone. It opens nothing itself: `events-client.ts` decides which tab holds the
// one stream of the browser, when a hidden tab lets go and how a failure is retried.
import { routes, type TerminalState } from '@mcs/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useState } from 'react';

import { markLocked } from '../data/hooks/useAuth.ts';
import { useDataEnv } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { createEventsClient, type EventsClientOptions, type EventsStatus } from './events-client.ts';

/** How long a change of the set of session names waits for a quieter moment before the page refetches. */
export const INVALIDATE_DEBOUNCE_MS = 800;

/**
 * What a test, or a later seam of the terminal view, may replace in the environment of the client: the source factory, the lock
 * manager, the visibility and the network target. Everything else (the url, the instance, the callbacks) is the hook's.
 */
export type TerminalEventsEnvironment = Pick<
  EventsClientOptions,
  'esFactory' | 'locks' | 'visibility' | 'windowTarget' | 'now' | 'setTimer' | 'clearTimer'
>;

export interface UseTerminalEventsOptions {
  /** Only while the Workspace page is mounted, the instance is a user instance and the browser holds the session. */
  enabled: boolean;
  environment?: TerminalEventsEnvironment;
}

export interface TerminalEventsState {
  /** `open` means the list follows the server (the page may poll slowly); anything else means it must poll. */
  status: EventsStatus;
}

function sameNames(a: readonly { name: string }[], b: readonly { name: string }[]): boolean {
  if (a.length !== b.length) return false;
  const names = new Set(a.map((session) => session.name));
  return b.every((session) => names.has(session.name));
}

export function useTerminalEvents(o: UseTerminalEventsOptions): TerminalEventsState {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventsStatus>('idle');
  const { enabled } = o;

  // Reads the latest environment without making the effect restart when its identity changes.
  const environment = useEffectEvent((): TerminalEventsEnvironment => o.environment ?? {});

  useEffect(() => {
    if (!enabled) return undefined;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    function refreshLater(): void {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void queryClient.invalidateQueries({ queryKey: qk.terminalState(iid) });
        void queryClient.invalidateQueries({ queryKey: qk.folders(iid) });
      }, INVALIDATE_DEBOUNCE_MS);
    }
    const client = createEventsClient({
      url: routes.terminalEvents.path,
      expectedInstanceId: iid,
      checkAccess: async () => {
        const session = await queryClient.query({
          queryKey: qk.authSession(iid),
          queryFn: ({ signal }) =>
            api.get('authSession', routes.authSession.path, routes.authSession.response, { signal }),
          staleTime: 0,
        });
        return session.authenticated;
      },
      onSessions: (event) => {
        const key = qk.terminalState(iid);
        const before = queryClient.getQueryData<TerminalState>(key);
        // nothing loaded yet: there are no capabilities to put the list into, and the first fetch brings it
        if (before === undefined) return;
        queryClient.setQueryData<TerminalState>(key, { ...before, sessions: event.sessions });
        if (!sameNames(before.sessions, event.sessions)) refreshLater();
      },
      onEpochChanged: () => {
        void queryClient.invalidateQueries({ queryKey: qk.root(iid) });
      },
      onRevoked: () => {
        markLocked(queryClient, iid);
      },
      ...environment(),
    });
    const unsubscribe = client.subscribe(() => {
      setStatus(client.snapshot().status);
    });
    client.start();
    return () => {
      unsubscribe();
      client.stop();
      if (debounce !== null) clearTimeout(debounce);
      // the next client (another instance, or enabled again) starts from idle, not from the last status of this one
      setStatus('idle');
    };
  }, [enabled, iid, api, queryClient]);

  return { status: enabled ? status : 'idle' };
}
