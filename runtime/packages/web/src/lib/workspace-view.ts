// The view model of the Workspace page (CAW design 04 section 5, ADR 0096). Pure: no React, no DOM and no clock. It joins the
// folder rows (`listFolders`), the live terminals (`terminalState`) and the monitor rows (`listSessions`) into what the sidebar
// draws, and it decides which of seven states the terminal pane is in. The wire shapes are Option A of design 03: the folder
// row and the terminal DTO with its `link` and `folderKey`; the two adapters at the top are the only place that reads them, so a
// different wire answer changes those two functions and nothing else.
import type {
  Folder,
  LifecycleState,
  SessionSummary,
  TerminalCapabilities,
  TerminalSessionInfo,
  TerminalUnavailableReason,
} from '@mcs/shared';

import type { ApiError } from '../data/api-errors.ts';

// ---- types ---------------------------------------------------------------------------------------------------------------

/** The mark of a folder row: the server decides it, the web never recomputes it. */
export type ActivityMark = 'full' | 'half' | 'none';

export interface FolderModel {
  key: string;
  name: string;
  /** `null` when the server could not recover it (the row cannot start a terminal). */
  path: string | null;
  canStart: boolean;
  userAdded: boolean;
  activity: ActivityMark;
  lastActivityAt: string | null;
  summary: string | null;
  /** Shown only together with a summary (as MTOP does). */
  counts: { brain: number; action: number } | null;
  /** False: the row says "no memory data". */
  hasMemory: boolean;
}

export interface LiveSession {
  name: string;
  path: string;
  folderKey: string | null;
  createdAt: string;
  cols: number;
  rows: number;
  viewers: number;
  link: {
    status: 'pending' | 'linked' | 'ambiguous';
    sessionId: string | null;
    transcript: 'none' | 'tracked';
    registryStatus: 'busy' | 'idle' | 'waiting' | null;
    waitingFor: string | null;
    reason: 'no_registry' | 'registry_unreadable' | 'ambiguous' | null;
  };
}

/** What a row says about the process (design 03 section 5.6). */
export type RowState =
  | { kind: 'starting' }
  | { kind: 'not-linked' }
  | { kind: 'ambiguous' }
  /** No transcript yet: the registry status of the process, as a lifecycle state. */
  | { kind: 'registry'; state: LifecycleState; waitingFor: string | null }
  /** The transcript is tracked: the monitor's own row. */
  | { kind: 'monitor'; summary: SessionSummary };

export interface SessionRowModel {
  session: LiveSession;
  row: RowState;
  selected: boolean;
}

export interface RecentRowModel {
  summary: SessionSummary;
}

export interface FolderRowModel {
  folder: FolderModel;
  live: SessionRowModel[];
  liveCount: number;
  /** The override of the person, else MTOP's default: open when the folder has live sessions or the full mark. */
  open: boolean;
}

export interface WorkspaceView {
  rows: FolderRowModel[];
  /** Every live session, also those of folders the filter hides. */
  liveTotal: number;
  /** How many folders the filter hides. */
  hiddenByFilter: number;
}

// ---- adapters from the wire ------------------------------------------------------------------------------------------------

/** A folder row of `GET /folders` as the view model reads it. */
export function folderModelOf(folder: Folder): FolderModel {
  const summary = folder.da !== null && folder.da.summary !== '' ? folder.da.summary : null;
  return {
    key: folder.key,
    name: folder.name,
    path: folder.path,
    canStart: folder.canStart,
    userAdded: folder.userAdded,
    activity: folder.activity,
    lastActivityAt: folder.lastActivityAt,
    summary,
    counts: folder.da !== null && summary !== null ? { brain: folder.da.brain, action: folder.da.action } : null,
    hasMemory: folder.da !== null,
  };
}

/** A terminal of `GET /terminal/state` as the view model reads it: the row and the part of the link the rows need. */
export function liveSessionOf(info: TerminalSessionInfo): LiveSession {
  const link = info.link;
  return {
    name: info.name,
    path: info.path,
    folderKey: info.folderKey,
    createdAt: info.createdAt,
    cols: info.cols,
    rows: info.rows,
    viewers: info.viewers,
    link: {
      status: link.status,
      sessionId: link.sessionId,
      transcript: link.transcript,
      registryStatus: link.registryStatus,
      waitingFor: link.waitingFor,
      reason: link.reason,
    },
  };
}

// ---- the key of a folder preference ------------------------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const MASK_52 = 0xfffffffffffffn;
const HASH_DIGITS = 13;

/** The low 52 bits of the 64-bit FNV-1a hash of the UTF-8 bytes of `text`, as 13 hex digits. */
function fnv52Hex(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return (hash & MASK_52).toString(16).padStart(HASH_DIGITS, '0');
}

/**
 * The key under which the preference `workspaceOpen` keeps the open or closed choice of a folder: `f_` and 13 hex digits, so a
 * key is short, never a path, and always inside the characters a preference key allows.
 */
export const folderPrefKey = (folderKey: string): string => `f_${fnv52Hex(folderKey)}`;

// ---- rows ------------------------------------------------------------------------------------------------------------------

const REGISTRY_STATES: Readonly<Record<'busy' | 'idle' | 'waiting', LifecycleState>> = {
  busy: 'working',
  idle: 'turn_ended',
  waiting: 'waiting_input',
};

/**
 * What the row of a live terminal says about its process. A pending link is `starting` until the server gives a reason (its 30 s
 * rule), then `not-linked`; a linked process without a transcript reads its registry status; a tracked transcript shows the
 * monitor's row, and `not-linked` until that row is loaded (one refresh).
 */
export function rowStateOf(session: LiveSession, monitor: ReadonlyMap<string, SessionSummary>): RowState {
  const link = session.link;
  if (link.status === 'ambiguous' || link.reason === 'ambiguous') return { kind: 'ambiguous' };
  if (link.status === 'pending') return link.reason === null ? { kind: 'starting' } : { kind: 'not-linked' };
  if (link.sessionId === null) return { kind: 'not-linked' };
  if (link.transcript === 'none') {
    if (link.registryStatus === null) return { kind: 'not-linked' };
    return { kind: 'registry', state: REGISTRY_STATES[link.registryStatus], waitingFor: link.waitingFor };
  }
  const summary = monitor.get(link.sessionId);
  return summary === undefined ? { kind: 'not-linked' } : { kind: 'monitor', summary };
}

/** Lower case, `/` as `\`, no trailing separator: the way two spellings of one Windows folder compare equal. */
function normalisedPath(path: string): string {
  return path.toLowerCase().replaceAll('/', '\\').replace(/\\+$/, '');
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/** The folder of a session that no known folder claims: named after its last path segment, never lost. */
function syntheticFolder(key: string, session: LiveSession): FolderModel {
  return {
    key,
    name: lastSegment(session.path),
    path: session.path,
    canStart: true,
    userAdded: false,
    activity: 'none',
    lastActivityAt: null,
    summary: null,
    counts: null,
    hasMemory: false,
  };
}

interface Group {
  folder: FolderModel;
  sessions: LiveSession[];
}

/** Puts every session into a folder: by key, then by normalised path, else into a synthetic folder of its own. */
function groupSessions(folders: readonly FolderModel[], sessions: readonly LiveSession[]): Group[] {
  const groups: Group[] = folders.map((folder) => ({ folder, sessions: [] }));
  const byKey = new Map(groups.map((group) => [group.folder.key, group]));
  const byPath = new Map<string, Group>();
  for (const group of groups) {
    if (group.folder.path === null) continue;
    const normalised = normalisedPath(group.folder.path);
    if (!byPath.has(normalised)) byPath.set(normalised, group);
  }
  const synthetic: Group[] = [];
  const syntheticByKey = new Map<string, Group>();
  for (const session of sessions) {
    const known =
      (session.folderKey === null ? undefined : byKey.get(session.folderKey)) ??
      byPath.get(normalisedPath(session.path));
    if (known !== undefined) {
      known.sessions.push(session);
      continue;
    }
    const key = session.folderKey ?? `path:${normalisedPath(session.path)}`;
    let group = syntheticByKey.get(key);
    if (group === undefined) {
      group = { folder: syntheticFolder(key, session), sessions: [] };
      syntheticByKey.set(key, group);
      synthetic.push(group);
    }
    group.sessions.push(session);
  }
  return [...groups, ...synthetic];
}

function filterMatches(group: Group, needle: string): boolean {
  const { folder } = group;
  return (
    folder.name.toLowerCase().includes(needle) ||
    folder.path?.toLowerCase().includes(needle) === true ||
    group.sessions.some((session) => session.name.toLowerCase().includes(needle))
  );
}

export interface WorkspaceViewInput {
  folders: readonly FolderModel[];
  sessions: readonly LiveSession[];
  /** Monitor rows by session id, for the tracked transcripts. */
  monitor: ReadonlyMap<string, SessionSummary>;
  /** Case-insensitive substring over folder name, folder path and live session names; blank shows everything. */
  filter: string;
  /** The preference `workspaceOpen`, by `folderPrefKey`. */
  open: Readonly<Record<string, boolean>>;
  /** The selected terminal name, '' for none. */
  selected: string;
  /** Keep a folder with a starting session visible whatever the filter says (a session the person just started). */
  pinStartingFolders?: boolean;
}

/**
 * The folder rows of the sidebar. Folders with live sessions come first, the others keep the order of the server, so the list
 * moves only when a live set changes (which the person causes); the sessions of a folder keep the order they came in.
 */
export function buildWorkspaceView(input: WorkspaceViewInput): WorkspaceView {
  const groups = groupSessions(input.folders, input.sessions);
  const withLive = groups.filter((group) => group.sessions.length > 0);
  const withoutLive = groups.filter((group) => group.sessions.length === 0);
  const needle = input.filter.trim().toLowerCase();
  const pin = input.pinStartingFolders === true;
  const rows: FolderRowModel[] = [];
  let hidden = 0;
  for (const group of [...withLive, ...withoutLive]) {
    const live: SessionRowModel[] = group.sessions.map((session) => ({
      session,
      row: rowStateOf(session, input.monitor),
      selected: session.name === input.selected,
    }));
    const shown =
      needle === '' || filterMatches(group, needle) || (pin && live.some((entry) => entry.row.kind === 'starting'));
    if (!shown) {
      hidden += 1;
      continue;
    }
    const prefKey = folderPrefKey(group.folder.key);
    const override = Object.hasOwn(input.open, prefKey) ? input.open[prefKey] : undefined;
    rows.push({
      folder: group.folder,
      live,
      liveCount: live.length,
      open: override ?? (live.length > 0 || group.folder.activity === 'full'),
    });
  }
  return { rows, liveTotal: input.sessions.length, hiddenByFilter: hidden };
}

const RECENT_LIMIT = 5;

/**
 * The "Recent sessions" rows of a folder: the monitor sessions that are not open as a terminal (their `link.sessionId`), at most
 * five, and whether a sixth exists (the query asks for six, so "All sessions" is shown only when it is honest).
 */
export function recentRowsOf(
  summaries: readonly SessionSummary[],
  live: readonly LiveSession[],
): { rows: RecentRowModel[]; more: boolean } {
  const open = new Set<string>();
  for (const session of live) if (session.link.sessionId !== null) open.add(session.link.sessionId);
  const remaining = summaries.filter((summary) => !open.has(summary.id));
  return {
    rows: remaining.slice(0, RECENT_LIMIT).map((summary) => ({ summary })),
    more: remaining.length > RECENT_LIMIT,
  };
}

// ---- the pane --------------------------------------------------------------------------------------------------------------

/** The part of an access outcome the pane needs: the richer `AccessOutcome` of the access flow is assignable to it. */
export interface AccessOutcomeShape {
  readonly kind: 'idle' | 'exchanging' | 'granted' | 'cookie-not-kept' | 'invalid' | 'rate-limited' | 'failed';
}

/** A session that ended in this window: the banner and the frozen screen stay until another one is selected. */
export interface EndedInfo {
  name: string;
  /** What the list said about it before it left, so the pane can still draw its header. */
  session: LiveSession;
  /** `null` when the exit frame carried no code (a stop). */
  exitCode: number | null;
  /** The session was stopped (close 4001), not exited. */
  killed: boolean;
}

/** The terminal data the pane reads: the capabilities and the live sessions. */
export interface PaneTerminalState {
  capabilities: TerminalCapabilities;
  sessions: readonly LiveSession[];
}

/** The fields of a query result the pane reads (a TanStack `UseQueryResult` is assignable to it). */
export interface PaneQuery<T> {
  readonly data: T | undefined;
  readonly error: ApiError | null;
}

export type PaneUnavailableReason = Extract<
  TerminalUnavailableReason,
  'unsupported_os' | 'addon_missing' | 'claude_not_found'
>;

export type PaneState<O extends AccessOutcomeShape = AccessOutcomeShape> =
  | { kind: 'locked'; outcome: O }
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiError }
  | { kind: 'unavailable'; reason: PaneUnavailableReason }
  | { kind: 'none-selected' }
  | { kind: 'not-found'; name: string }
  | { kind: 'terminal'; session: LiveSession; row: RowState; focus: boolean; ended: EndedInfo | null };

export interface PaneInput<O extends AccessOutcomeShape = AccessOutcomeShape> {
  auth: PaneQuery<{ readonly authenticated: boolean }>;
  terminal: PaneQuery<PaneTerminalState>;
  /** Monitor rows by session id, for the row state of the selected session. */
  monitor: ReadonlyMap<string, SessionSummary>;
  /** The selected terminal name, '' for none. */
  selected: string;
  endedLocal: EndedInfo | null;
  focusRequested: boolean;
  accessOutcome: O;
}

function unavailableReason(reason: TerminalUnavailableReason | null): PaneUnavailableReason {
  // `not_configured` never reaches the page (an instance without terminals redirects away); a missing reason reads as the same
  // thing: the terminal component is not there.
  return reason === 'unsupported_os' || reason === 'claude_not_found' ? reason : 'addon_missing';
}

/**
 * What the terminal pane shows, by priority: locked, unavailable, loading, error, terminal, not-found, none-selected. A failed
 * refresh with data in hand is not an error here: the terminal stays and the page shows a stale hint of its own.
 */
export function paneStateOf<O extends AccessOutcomeShape>(input: PaneInput<O>): PaneState<O> {
  const { auth, terminal, selected, accessOutcome } = input;
  const outcome = accessOutcome.kind;
  if (auth.data?.authenticated === false || (outcome !== 'idle' && outcome !== 'granted')) {
    return { kind: 'locked', outcome: accessOutcome };
  }
  const data = terminal.data;
  if (data !== undefined && !data.capabilities.available) {
    return { kind: 'unavailable', reason: unavailableReason(data.capabilities.reason) };
  }
  if (data === undefined) {
    const error = terminal.error ?? auth.error;
    return error === null ? { kind: 'loading' } : { kind: 'error', error };
  }
  if (selected === '') return { kind: 'none-selected' };
  const ended = input.endedLocal !== null && input.endedLocal.name === selected ? input.endedLocal : null;
  const session = data.sessions.find((candidate) => candidate.name === selected) ?? ended?.session;
  if (session === undefined) return { kind: 'not-found', name: selected };
  return {
    kind: 'terminal',
    session,
    row: rowStateOf(session, input.monitor),
    focus: input.focusRequested,
    ended,
  };
}
