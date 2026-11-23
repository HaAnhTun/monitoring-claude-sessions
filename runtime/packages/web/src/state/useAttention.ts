// The attention center as hooks (ADR 0107, design attention-trust 3.1): the data hooks give the rows, the notifier turns them
// into announcements, an OS notification and settled counts, and the chrome store gets what the tab title and the tab icon
// show. The host of the shell calls `useAttention` (a user instance) or `useTaskAttention` (a task instance: no terminals)
// once and provides the result through `AttentionContext`. The words come from the caller (`text`): nothing here reads the
// catalogue.
import type { SessionSummary } from '@mcs/shared';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { useAuthSession } from '../data/hooks/useAuth.ts';
import { useLinkedSessions } from '../data/hooks/useFolders.ts';
import { useSidebarSessions } from '../data/hooks/useSessions.ts';
import { useTerminalState } from '../data/hooks/useTerminalState.ts';
import {
  buildAttentionRows,
  effectiveScope,
  selectedKeyOf,
  type AttentionRow,
  type AttentionScope,
} from '../lib/attention-rows.ts';
import type { SeenMap } from '../lib/attention-seen.ts';
import { attentionPrefsOf } from '../lib/prefs.ts';
import type { LiveSession } from '../lib/workspace-view.ts';
import { useAnnounce } from './announcer.tsx';
import { chromeOf, NO_ATTENTION_CHROME, useAttentionChromeStore } from './attention-chrome.ts';
import type { AttentionValue } from './attention-context.ts';
import { createNotifier, type NotifierSeams, type OsNotification } from './attention-notifier.ts';
import { usePrefs, usePrefsStore } from './prefs-store.ts';

/** The browser seams of the notifier; tests replace them. */
export interface AttentionSeams {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly page: () => { visible: boolean; focused: boolean };
  readonly notify: (notification: OsNotification) => void;
  /** Calls `listener` whenever the page becomes visible or gets the focus; returns the unsubscribe. */
  readonly onPageActive: (listener: () => void) => () => void;
}

/** The OS notification behind a dynamic import: the first chunk carries this call and nothing of the module. */
export function lazyNotify(notification: OsNotification): void {
  void import('./attention-env.ts').then(
    (env) => env.showNotification(notification),
    () => false,
  );
}

export const browserAttentionSeams: AttentionSeams = {
  now: () => Date.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
  page: () => ({ visible: document.visibilityState === 'visible', focused: document.hasFocus() }),
  notify: lazyNotify,
  onPageActive: (listener) => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') listener();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', listener);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', listener);
    };
  },
};

/** What the caller supplies: the words and where a click on the OS notification goes. */
export interface AttentionHostSeams {
  text: NotifierSeams['text'];
  open: NotifierSeams['open'];
  /** Default: the seams of the browser. */
  seams?: AttentionSeams;
}

export interface AttentionCoreInput extends AttentionHostSeams {
  rows: readonly AttentionRow[];
  /** False until the lists were read once: the first snapshot the notifier sees is its silent baseline. */
  ready: boolean;
  /** The effective scope; a change swaps the whole list, so the notifier takes it as a new silent baseline. */
  scope: AttentionScope;
  /** The key of the row the person looks at. */
  selectedKey: string | null;
  /**
   * Names the list beyond the scope (default: the scope alone). A change is a new silent baseline: unlocking shows terminals
   * that were waiting all along, which is not news.
   */
  epoch?: string;
}

const NO_SEEN: SeenMap = Object.freeze({});

/** The notifier over given rows: no data hook in here, so a test drives it with plain arrays. */
export function useAttentionCore(input: AttentionCoreInput): AttentionValue {
  const { rows, ready, scope, selectedKey, text, open } = input;
  const epoch = input.epoch ?? scope;
  const seams = input.seams ?? browserAttentionSeams;
  const store = usePrefsStore();
  const { prefs } = usePrefs();
  const announce = useAnnounce();
  const chromeStore = useAttentionChromeStore();
  const { attentionTitle, attentionFavicon } = attentionPrefsOf(prefs);
  const seen = prefs.attentionSeen;

  const host = useRef({ text, open, announce });
  useEffect(() => {
    host.current = { text, open, announce };
  }, [text, open, announce]);

  const notifier = useMemo(
    () =>
      createNotifier({
        now: seams.now,
        setTimer: seams.setTimer,
        clearTimer: seams.clearTimer,
        page: seams.page,
        notify: seams.notify,
        announce: (message) => {
          host.current.announce(message);
        },
        text: (event) => host.current.text(event),
        open: (row) => {
          host.current.open(row);
        },
        seen: {
          read: () => store.getSnapshot().attentionSeen ?? NO_SEEN,
          write: (next) => {
            store.setPref('attentionSeen', { ...next });
          },
        },
        config: () => {
          const current = attentionPrefsOf(store.getSnapshot());
          return { delayMs: current.attentionDelaySeconds * 1000, notify: current.attentionNotify };
        },
      }),
    [seams, store],
  );
  useEffect(
    () => () => {
      notifier.dispose();
    },
    [notifier],
  );

  // `seen` is a dependency on purpose: a mark written elsewhere ("Mark as seen", Lock terminals) changes the levels.
  useEffect(() => {
    if (ready) notifier.ingest(rows, { selectedKey, epoch });
  }, [notifier, ready, rows, selectedKey, epoch, seen]);
  useEffect(
    () =>
      seams.onPageActive(() => {
        notifier.viewing(selectedKey);
      }),
    [notifier, seams, selectedKey],
  );

  const snapshot = useSyncExternalStore(notifier.subscribe, notifier.getSnapshot, notifier.getSnapshot);
  useEffect(() => {
    chromeStore.set(chromeOf(snapshot.summary, { title: attentionTitle, favicon: attentionFavicon }));
  }, [chromeStore, snapshot.summary, attentionTitle, attentionFavicon]);
  useEffect(
    () => () => {
      chromeStore.set(NO_ATTENTION_CHROME);
    },
    [chromeStore],
  );

  return useMemo(
    () => ({ items: snapshot.items, summary: snapshot.summary, scope, markSeen: notifier.markSeen }),
    [snapshot, scope, notifier],
  );
}

export interface UseAttentionOptions extends AttentionHostSeams {
  /** What the person looks at: the selected terminal of the Workspace (`?session=NAME`) or the open session page. */
  selected: { terminal: string | null; sessionId: string | null };
}

const NO_TERMINALS: readonly LiveSession[] = [];
const NO_SESSIONS: readonly SessionSummary[] = [];

/**
 * The attention center of a user instance: the live terminals with their monitor rows (the same two requests the Workspace
 * page makes, shared through the cache) and, with scope `all`, the sidebar list. Locked, it has no terminals: `here` is empty.
 */
export function useAttention(options: UseAttentionOptions): AttentionValue {
  const { prefs } = usePrefs();
  const scope = effectiveScope(attentionPrefsOf(prefs).attentionScope, 'user');
  const auth = useAuthSession();
  const terminal = useTerminalState({ eventsOpen: true });
  const terminals = terminal.data?.sessions ?? NO_TERMINALS;
  const linkedIds = useMemo(
    () =>
      terminals
        .filter((session) => session.link.transcript === 'tracked')
        .flatMap((session) => (session.link.sessionId === null ? [] : [session.link.sessionId])),
    [terminals],
  );
  const linked = useLinkedSessions(linkedIds);
  const sidebar = useSidebarSessions(false, { enabled: scope === 'all' });
  const linkedItems = linked.data?.items ?? NO_SESSIONS;
  const sidebarItems = scope === 'all' ? (sidebar.data?.items ?? NO_SESSIONS) : NO_SESSIONS;
  const rows = useMemo(
    () => buildAttentionRows({ sessions: [...linkedItems, ...sidebarItems], terminals, scope }),
    [linkedItems, sidebarItems, terminals, scope],
  );
  const locked = auth.data?.authenticated === false || auth.isError;
  const ready =
    (locked || terminal.data !== undefined || terminal.isError) &&
    (linkedIds.length === 0 || linked.data !== undefined || linked.isError) &&
    (scope === 'here' || sidebar.data !== undefined);
  const selectedKey = selectedKeyOf(rows, options.selected);
  const epoch = `${scope}:${locked ? 'locked' : 'open'}`;
  return useAttentionCore({ ...options, rows, ready, scope, selectedKey, epoch });
}

/** The attention center of a task instance: every session of the sidebar list, no terminals, no session cookie. */
export function useTaskAttention(options: UseAttentionOptions): AttentionValue {
  const sidebar = useSidebarSessions(false);
  const items = sidebar.data?.items ?? NO_SESSIONS;
  const rows = useMemo(() => buildAttentionRows({ sessions: items, terminals: NO_TERMINALS, scope: 'all' }), [items]);
  const selectedKey = selectedKeyOf(rows, options.selected);
  return useAttentionCore({ ...options, rows, ready: sidebar.data !== undefined, scope: 'all', selectedKey });
}
