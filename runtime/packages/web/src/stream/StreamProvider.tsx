// The React side of the realtime client (04 5.6 "StreamProvider"). It waits for `GET /instance`, creates one stream client per
// instance id (`expectedEpoch = instance.epoch`, `startSeq = instance.headSeq`), starts it in an effect and stops it in the
// cleanup, so Strict Mode's start/stop/start is safe (`stop()` is idempotent and `start()` after it opens a new source). It
// wires the client to the reconciler (batches, R5 resync, instance change, epoch change), installs the R4 ledger reapply on
// the query cache, tells the data hooks whether the stream is live (`StreamLiveContext`: the polling fallback is off while it
// is) and exposes the snapshot, the ledger, the live buffers and the pending-change counts to the pages.
import { routes } from '@mcs/shared';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import { StreamLiveContext, useInstance } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { createLiveBufferRegistry, type LiveBufferRegistry } from './live-buffer.ts';
import { createPatchLedger, type PatchLedger } from './patch-ledger.ts';
import {
  createPendingChanges,
  createReconciler,
  installLedgerReapply,
  NO_TRANSCRIPTS,
  type PendingChanges,
  type TranscriptRegistry,
} from './reconcile.ts';
import {
  createStreamClient,
  type EventSourceLike,
  type StreamClient,
  type StreamSnapshot,
  type WindowLike,
} from './stream-client.ts';

/** The snapshot of "no client yet": before the instance is known, after the provider unmounted, or without a provider. */
export const IDLE_STREAM_SNAPSHOT: StreamSnapshot = {
  status: 'idle',
  instanceId: null,
  epoch: null,
  lastSeq: null,
  serverHeadSeq: null,
  lastResetReason: null,
  openedAt: null,
  lastMessageAt: null,
  lastHeartbeatAt: null,
  inSyncAt: null,
  attempt: 0,
  nextRetryAt: null,
  lastError: null,
  counters: { messages: 0, duplicates: 0, invalid: 0, unknownKinds: 0, resyncs: 0, reconnects: 0 },
};

/** A stable store in front of whichever client is current, so `useSyncExternalStore` never sees a client come and go. */
interface StreamHost {
  snapshot: () => StreamSnapshot;
  subscribe: (fn: () => void) => () => void;
  attach: (client: StreamClient | null) => void;
  retryNow: () => void;
}

function createStreamHost(): StreamHost {
  let current: StreamClient | null = null;
  let detach: (() => void) | null = null;
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const fn of [...listeners]) fn();
  }
  return {
    snapshot: () => current?.snapshot() ?? IDLE_STREAM_SNAPSHOT,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    attach(client) {
      detach?.();
      current = client;
      detach = client === null ? null : client.subscribe(notify);
      notify();
    },
    retryNow() {
      current?.retryNow();
    },
  };
}

const NO_HOST: StreamHost = {
  snapshot: () => IDLE_STREAM_SNAPSHOT,
  subscribe: () => () => undefined,
  attach: () => undefined,
  retryNow: () => undefined,
};

/** The server was restarted with other code: the page offers "The monitor was updated: Reload page". */
export interface MonitorUpdate {
  runtimeVersion: string;
  codeStamp: string;
}

export interface StreamControls {
  /** Rule R4. */
  ledger: PatchLedger;
  /** The mounted live feeds register here to receive `event/append` and `tool_call/upsert` (5.7). */
  liveBuffers: LiveBufferRegistry;
  /** Rule R3: membership changes a list did not show, per list query. */
  pending: PendingChanges;
  /** "Retry now" of the connection chip. */
  retryNow(): void;
  monitorUpdated: MonitorUpdate | null;
  /** @internal for `useStreamSnapshot` */
  host: StreamHost;
}

const StreamContext = createContext<StreamControls | null>(null);

/** The stream snapshot of the nearest provider; the idle snapshot without one. */
export function useStreamSnapshot(): StreamSnapshot {
  const host = useContext(StreamContext)?.host ?? NO_HOST;
  return useSyncExternalStore(host.subscribe, host.snapshot);
}

/** Ledger, live buffers, pending counts and the update notice; `null` outside a `StreamProvider`. */
export function useStreamControls(): StreamControls | null {
  return useContext(StreamContext);
}

export interface StreamProviderProps {
  children: ReactNode;
  /** Test seam: the `EventSource` factory (default: the browser's). */
  esFactory?: (url: string) => EventSourceLike;
  /** Test seam: where `online`/`offline` events come from (default: `window`). */
  windowTarget?: WindowLike | null;
  /** Polite announcements of the reconciler ("Alert: <title>"). */
  announce?: (message: string) => void;
  /** The mounted transcript viewers (04 5.4). */
  transcriptRegistry?: TranscriptRegistry;
  /** R3 exception: the list is scrolled to the top. */
  listAtTop?: (queryKey: QueryKey) => boolean;
  /** `session/delete`: the detail page shows "This session was removed by retention cleanup". */
  onSessionRemoved?: (sessionId: string) => void;
}

export function StreamProvider(props: StreamProviderProps): ReactElement {
  const queryClient = useQueryClient();
  const instance = useInstance().data;
  const [host] = useState(createStreamHost);
  const [ledger] = useState(() => createPatchLedger());
  const [liveBuffers] = useState(createLiveBufferRegistry);
  const [pending] = useState(createPendingChanges);
  const [monitorUpdated, setMonitorUpdated] = useState<MonitorUpdate | null>(null);
  const live = useSyncExternalStore(host.subscribe, () => host.snapshot().status === 'open');
  const iid = instance?.instanceId ?? null;

  // Reads the latest props and instance without making the effect restart when they change identity.
  const build = useEffectEvent(() => {
    if (instance === undefined) throw new Error('StreamProvider started without instance info');
    const reconciler = createReconciler({
      queryClient,
      iid: instance.instanceId,
      ledger,
      liveBuffers,
      pending,
      transcriptRegistry: props.transcriptRegistry ?? NO_TRANSCRIPTS,
      ...(props.announce === undefined ? {} : { announce: props.announce }),
      ...(props.listAtTop === undefined ? {} : { listAtTop: props.listAtTop }),
      ...(props.onSessionRemoved === undefined ? {} : { onSessionRemoved: props.onSessionRemoved }),
    });
    const uninstall = installLedgerReapply(queryClient, ledger, instance.instanceId);
    const loaded = { runtimeVersion: instance.runtimeVersion, codeStamp: instance.codeStamp };
    const client = createStreamClient({
      url: routes.stream.path,
      expectedInstanceId: instance.instanceId,
      expectedEpoch: instance.epoch,
      startSeq: instance.headSeq,
      heartbeatMs: instance.heartbeatMs,
      ...(props.esFactory === undefined ? {} : { esFactory: props.esFactory }),
      ...(props.windowTarget === undefined ? {} : { windowTarget: props.windowTarget }),
      onBatch: (changes) => {
        reconciler.applyBatch(changes);
      },
      onResync: (reason) => {
        reconciler.resync(reason);
      },
      onInstanceChanged: () => {
        reconciler.instanceChanged();
      },
      onEpochChanged: (info) => {
        void queryClient.invalidateQueries({ queryKey: qk.instance(), exact: true });
        void queryClient.invalidateQueries({ queryKey: qk.config(instance.instanceId) });
        const known = info.runtimeVersion !== '' || info.codeStamp !== '';
        if (known && (info.runtimeVersion !== loaded.runtimeVersion || info.codeStamp !== loaded.codeStamp)) {
          setMonitorUpdated({ runtimeVersion: info.runtimeVersion, codeStamp: info.codeStamp });
        }
      },
    });
    return {
      client,
      dispose: () => {
        uninstall();
        reconciler.dispose();
      },
    };
  });

  useEffect(() => {
    if (iid === null) return undefined;
    const { client, dispose } = build();
    host.attach(client);
    client.start();
    return () => {
      client.stop();
      host.attach(null);
      dispose();
    };
  }, [iid, host]);

  const controls = useMemo<StreamControls>(
    () => ({
      ledger,
      liveBuffers,
      pending,
      retryNow: () => {
        host.retryNow();
      },
      monitorUpdated,
      host,
    }),
    [ledger, liveBuffers, pending, host, monitorUpdated],
  );

  return (
    <StreamContext value={controls}>
      <StreamLiveContext value={live}>{props.children}</StreamLiveContext>
    </StreamContext>
  );
}
