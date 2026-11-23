// The rows the attention center reads (ADR 0107, design attention-trust 3.2). Pure: it joins the live terminals with the
// monitor rows and classifies each one with the shared classifier. A row carries ids, a class and a time; the label travels
// with it only for the title rules of the Workspace (`titleOf`), never into a notification.
import {
  attentionOf,
  attentionOfLink,
  levelOf,
  type AttentionClass,
  type AttentionLevel,
  type SessionSummary,
} from '@mcs/shared';

import type { LiveSession } from './workspace-view.ts';

/** `here`: the terminals this app started. `all`: also every session of the monitor's list. */
export type AttentionScope = 'here' | 'all';

export interface AttentionRow {
  /** `s:<session id>` once the session id is known, else `t:<terminal name>`. */
  key: string;
  sessionId: string | null;
  /** The terminal that runs it, else `null`. */
  terminal: string | null;
  /** The folder of the terminal (the rollup); `null` for a session that was not started here. */
  folderKey: string | null;
  cls: AttentionClass;
  since: string | null;
  label: string | null;
  labelSource: SessionSummary['labelSource'] | null;
}

/** A row with the level it is shown at: `failed` and `done` hold only while `unseen`. */
export interface AttentionItem extends AttentionRow {
  level: AttentionLevel;
  unseen: boolean;
}

export const sessionRowKey = (sessionId: string): string => `s:${sessionId}`;
export const terminalRowKey = (name: string): string => `t:${name}`;

/** One preference for title, favicon and notification; a task instance has no terminals, so it always reads `all`. */
export function effectiveScope(pref: AttentionScope | undefined, kind: 'user' | 'task' | undefined): AttentionScope {
  return kind === 'task' ? 'all' : (pref ?? 'here');
}

function summaryRow(summary: SessionSummary, terminal: LiveSession | null): AttentionRow {
  return {
    key: sessionRowKey(summary.id),
    sessionId: summary.id,
    terminal: terminal?.name ?? null,
    folderKey: terminal?.folderKey ?? null,
    cls: attentionOf(summary.state),
    since: summary.state.since,
    label: summary.label,
    labelSource: summary.labelSource,
  };
}

/** A terminal whose `claude` has no monitor row (yet): classified from its link, no time and no label. */
function linkRow(terminal: LiveSession): AttentionRow {
  const sessionId = terminal.link.sessionId;
  return {
    key: sessionId === null ? terminalRowKey(terminal.name) : sessionRowKey(sessionId),
    sessionId,
    terminal: terminal.name,
    folderKey: terminal.folderKey,
    cls: attentionOfLink(terminal.link),
    since: null,
    label: null,
    labelSource: null,
  };
}

/**
 * One row per live terminal, in the order of `terminals`; with scope `all` the other sessions of `sessions` follow in their
 * order. A session that is also a terminal appears once, with its terminal name. A terminal that is gone is simply absent:
 * nothing here remembers it, so it can produce no event.
 */
export function buildAttentionRows(input: {
  sessions: readonly SessionSummary[];
  terminals: readonly LiveSession[];
  scope: AttentionScope;
}): AttentionRow[] {
  const byId = new Map<string, SessionSummary>();
  for (const summary of input.sessions) if (!byId.has(summary.id)) byId.set(summary.id, summary);
  const rows = new Map<string, AttentionRow>();
  for (const terminal of input.terminals) {
    const id = terminal.link.sessionId;
    const summary = id === null ? undefined : byId.get(id);
    const row = summary === undefined ? linkRow(terminal) : summaryRow(summary, terminal);
    if (!rows.has(row.key)) rows.set(row.key, row);
  }
  if (input.scope === 'all') {
    for (const summary of byId.values()) {
      const key = sessionRowKey(summary.id);
      if (!rows.has(key)) rows.set(key, summaryRow(summary, null));
    }
  }
  return [...rows.values()];
}

/** The key of the row the person looks at: the selected terminal wins, then the open session page. */
export function selectedKeyOf(
  rows: readonly AttentionRow[],
  selected: { terminal: string | null; sessionId: string | null },
): string | null {
  if (selected.terminal !== null) {
    const row = rows.find((candidate) => candidate.terminal === selected.terminal);
    if (row !== undefined) return row.key;
  }
  return selected.sessionId === null ? null : sessionRowKey(selected.sessionId);
}

/** The rows with their levels; the order is kept. */
export function itemsOf(rows: readonly AttentionRow[], unseen: (row: AttentionRow) => boolean): AttentionItem[] {
  return rows.map((row) => {
    const rowUnseen = unseen(row);
    return { ...row, level: levelOf(row.cls, rowUnseen), unseen: rowUnseen };
  });
}
