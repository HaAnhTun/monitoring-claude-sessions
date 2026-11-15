// Query keys (04-ui.md 5.2). Every key except the boot key is prefixed by the instance id, so two instances can never share a
// cache entry (UI-I11). `ApiQuery` is the canonical query record produced by the shared `toQuery(filter)`: equal filters hash
// equally and the key holds exactly what is sent.
import type { PanelKey } from '@mcs/shared';

export type ApiQuery = Readonly<Record<string, string>>;

export const qk = {
  root: (iid: string) => ['mcs', iid] as const,
  /** The only key without an instance id: it discovers it. */
  instance: () => ['mcs', 'boot', 'instance'] as const,
  health: (iid: string) => ['mcs', iid, 'health'] as const,
  overview: (iid: string) => ['mcs', iid, 'overview'] as const,
  sessions: (iid: string, q: ApiQuery) => ['mcs', iid, 'sessions', q] as const,
  sidebarSessions: (iid: string, showAll: boolean) => ['mcs', iid, 'sessions', { sidebar: true, showAll }] as const,
  session: (iid: string, sid: string) => ['mcs', iid, 'session', sid] as const,
  agents: (iid: string, sid: string) => ['mcs', iid, 'session', sid, 'agents'] as const,
  timeline: (iid: string, sid: string, q: ApiQuery) => ['mcs', iid, 'session', sid, 'timeline', q] as const,
  toolCalls: (iid: string, sid: string, q: ApiQuery) => ['mcs', iid, 'session', sid, 'toolCalls', q] as const,
  activity: (iid: string, q: ApiQuery) => ['mcs', iid, 'activity', q] as const,
  transcriptSearch: (iid: string, q: ApiQuery) => ['mcs', iid, 'transcriptSearch', q] as const,
  instanceSearch: (iid: string, q: ApiQuery) => ['mcs', iid, 'instanceSearch', q] as const,
  workItems: (iid: string) => ['mcs', iid, 'workItems'] as const,
  analytics: (iid: string, kind: 'usage' | 'series' | 'tools', q: ApiQuery) =>
    ['mcs', iid, 'analytics', kind, q] as const,
  config: (iid: string) => ['mcs', iid, 'config'] as const,
  panel: (iid: string, key: PanelKey) => ['mcs', iid, 'panel', key] as const,
  // ---- access, terminal, folders and resume (ADR 0099, design 04 4.2) ---------------------------------------------------
  /** `GET /auth/session`: whether this browser holds the session cookie. Set to `false` by `markLocked`. */
  authSession: (iid: string) => ['mcs', iid, 'auth'] as const,
  terminalState: (iid: string) => ['mcs', iid, 'terminal'] as const,
  folders: (iid: string) => ['mcs', iid, 'folders'] as const,
  /** The monitor rows of the live terminals (`ids`: the sorted session ids, comma-joined). Under `sessions`: the stream patches them in place. */
  linkedSessions: (iid: string, ids: string) => ['mcs', iid, 'sessions', { linked: true, ids }] as const,
  /** The recent sessions of one folder row (`folderKey`: the project key). Under `sessions`, like `linkedSessions`. */
  folderSessions: (iid: string, folderKey: string) =>
    ['mcs', iid, 'sessions', { recent: true, folder: folderKey }] as const,
  resumeEligibility: (iid: string, sid: string) => ['mcs', iid, 'resume', sid] as const,
};
