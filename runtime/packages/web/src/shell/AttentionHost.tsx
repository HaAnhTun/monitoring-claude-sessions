// The host of the attention center (ADR 0107, design attention-trust 3.5 to 3.11). Mounted once by the shell, it runs the
// attention hooks for the kind of the instance and gives the pages their rows through `AttentionContext`. It supplies what the
// hooks cannot know: the words (from the catalogue), where a click on an OS notification goes, and which row the person looks
// at. It swaps the tab icon, and on a user instance it refreshes the list of terminals every 30 s and when the page comes
// back, so a hidden tab learns about a new terminal. The tab title is not written here: `usePageChrome` reads the same store.
import type { AttentionEventKind, InstanceInfo } from '@mcs/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { matchPath, useLocation, useNavigate, useSearchParams } from 'react-router';

import { useAuthSession } from '../data/hooks/useAuth.ts';
import { useDataEnv } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import type { AttentionRow } from '../lib/attention-rows.ts';
import { attentionPrefsOf } from '../lib/prefs.ts';
import { parseUrlState, workspaceSpec } from '../lib/url-state.ts';
import { titleOf, type TitleMode } from '../lib/workspace-attention.ts';
import { applyFavicon, useAttentionChrome } from '../state/attention-chrome.ts';
import { AttentionContext } from '../state/attention-context.ts';
import type { AttentionTextEvent } from '../state/attention-notifier.ts';
import { usePrefs } from '../state/prefs-store.ts';
import {
  browserAttentionSeams,
  useAttention,
  useTaskAttention,
  type AttentionSeams,
  type UseAttentionOptions,
} from '../state/useAttention.ts';

/** How often the host asks for the list of terminals again (design 3.8); the monitor rows need nothing, the stream brings them. */
export const TERMINAL_REFRESH_MS = 30_000;

/** The longest title an announcement reads out. */
const ANNOUNCE_TITLE_MAX = 60;

const OS_KEYS = {
  needs_you: 'attention.os.needs_you',
  failed: 'attention.os.failed',
  done: 'attention.os.done',
} as const satisfies Record<AttentionEventKind, MessageKey>;

const ANNOUNCE_KEYS = {
  needs_you: 'attention.announce.needs_you',
  failed: 'attention.announce.failed',
  done: 'attention.announce.done',
} as const satisfies Record<AttentionEventKind, MessageKey>;

/** How an announcement names one row: the terminal, else the title the person allows, else the short id. Never used outside the page. */
function spokenNameOf(row: AttentionRow, titles: TitleMode): string | null {
  if (row.terminal !== null) return row.terminal;
  const title = titleOf(row, titles);
  if (title !== null) return title.length > ANNOUNCE_TITLE_MAX ? title.slice(0, ANNOUNCE_TITLE_MAX) : title;
  return row.sessionId === null ? null : row.sessionId.slice(0, 8);
}

/** What both kinds of instance hand to the attention hooks: the words, the navigation and the row that is looked at. */
function useHostOptions(seams: AttentionSeams | undefined): UseAttentionOptions {
  const t = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const { prefs } = usePrefs();
  const titles = attentionPrefsOf(prefs).workspaceTitles;

  const text = useCallback(
    (event: AttentionTextEvent) => {
      // The OS notification is this sentence and the application title, whatever the row is: a count, never a name.
      const body = t(OS_KEYS[event.kind], { count: event.count });
      const name = event.row === null ? null : spokenNameOf(event.row, titles);
      return {
        announce: name === null ? body : t(ANNOUNCE_KEYS[event.kind], { name }),
        title: t('shell.appTitle'),
        body,
      };
    },
    [t, titles],
  );
  const open = useCallback(
    (row: AttentionRow) => {
      if (row.terminal !== null) {
        void navigate(
          { pathname: '/', search: `?session=${encodeURIComponent(row.terminal)}` },
          { state: { focusTerminal: true } },
        );
      } else if (row.sessionId !== null) {
        void navigate(`/sessions/${encodeURIComponent(row.sessionId)}`);
      }
    },
    [navigate],
  );

  const terminal = pathname === '/' ? parseUrlState(workspaceSpec, searchParams).value.session : '';
  // the session page and whatever is routed below it
  const sessionId = matchPath({ path: '/sessions/:sessionId', end: false }, pathname)?.params.sessionId ?? null;
  const selected = useMemo(() => ({ terminal: terminal === '' ? null : terminal, sessionId }), [terminal, sessionId]);
  return useMemo(
    () => ({ text, open, selected, ...(seams === undefined ? {} : { seams }) }),
    [text, open, selected, seams],
  );
}

/** The tab icon follows the store; leaving the shell gives the plain icon back. */
function useFavicon(): void {
  const { icon } = useAttentionChrome();
  useEffect(() => {
    applyFavicon(document, icon);
  }, [icon]);
  useEffect(
    () => () => {
      applyFavicon(document, false);
    },
    [],
  );
}

/**
 * Asks for the terminals again every 30 s and whenever the page becomes visible or gets the focus, while the browser holds
 * the session. It only invalidates the query the Workspace shares; the events channel and its lock are not touched.
 */
function useTerminalRefresh(seams: AttentionSeams): void {
  const { iid } = useDataEnv();
  const queryClient = useQueryClient();
  const authenticated = useAuthSession().data?.authenticated === true;
  useEffect(() => {
    if (!authenticated) return undefined;
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: qk.terminalState(iid) });
    };
    const timer = window.setInterval(refresh, TERMINAL_REFRESH_MS);
    const off = seams.onPageActive(refresh);
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [authenticated, iid, queryClient, seams]);
}

interface HostProps {
  /** Default: the seams of the browser. */
  seams?: AttentionSeams | undefined;
  children: ReactNode;
}

function UserHost({ seams, children }: HostProps) {
  const value = useAttention(useHostOptions(seams));
  useFavicon();
  useTerminalRefresh(seams ?? browserAttentionSeams);
  return <AttentionContext value={value}>{children}</AttentionContext>;
}

/** A task instance has no terminals and no session of its own: every session of its list counts (scope `all`). */
function TaskHost({ seams, children }: HostProps) {
  const value = useTaskAttention(useHostOptions(seams));
  useFavicon();
  return <AttentionContext value={value}>{children}</AttentionContext>;
}

export interface AttentionHostProps extends HostProps {
  kind: InstanceInfo['kind'];
}

export function AttentionHost({ kind, seams, children }: AttentionHostProps) {
  return kind === 'user' ? (
    <UserHost seams={seams}>{children}</UserHost>
  ) : (
    <TaskHost seams={seams}>{children}</TaskHost>
  );
}
