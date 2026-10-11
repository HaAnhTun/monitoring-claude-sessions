// Pure filter and search helpers over timeline units (port of legacy modules/filters.js, 04 section 10).
import type { EntryKind, TranscriptEntry } from '@mcs/shared';

import type { Unit } from './timeline-model.ts';

export type { TranscriptEntry } from '@mcs/shared';
export type { Unit } from './timeline-model.ts';

export const KINDS = ['prompt', 'say', 'think', 'tool', 'result'] as const satisfies readonly EntryKind[];
export const KIND_LABELS: Readonly<Record<EntryKind, string>> = {
  prompt: 'Prompts',
  say: 'Claude',
  think: 'Thinking',
  tool: 'Tool calls',
  result: 'Results',
};

export interface TranscriptFilters {
  q: string;
  tool: string;
  errorsOnly: boolean;
  kinds: Readonly<Record<EntryKind, boolean>>;
}

/** The `ui` defaults of the instance info (03 6.2) that matter here. */
export interface FilterUiDefaults {
  showPrompts?: boolean | undefined;
  showThinking?: boolean | undefined;
  showTools?: boolean | undefined;
}

export function defaultFilters(ui: FilterUiDefaults = {}): TranscriptFilters {
  return {
    q: '',
    tool: '',
    errorsOnly: false,
    kinds: {
      prompt: ui.showPrompts === true,
      say: true,
      think: ui.showThinking === true,
      tool: ui.showTools !== false,
      result: true,
    },
  };
}

const textCache = new WeakMap<TranscriptEntry, string>();

function entryText(ev: TranscriptEntry): string {
  let t = textCache.get(ev);
  if (t === undefined) {
    t = [ev.text, ev.name, ev.summary, ev.input]
      .filter((x): x is string => typeof x === 'string')
      .join('\n')
      .toLowerCase();
    textCache.set(ev, t);
  }
  return t;
}

/** Lower-case searchable text of a unit (a tool unit includes its result). */
export function unitText(u: Unit): string {
  return u.result === null ? entryText(u.ev) : `${entryText(u.ev)}\n${entryText(u.result)}`;
}

/** Does the unit pass the kind, tool, errors-only and text filters? */
export function unitVisible(u: Unit, f: TranscriptFilters): boolean {
  const hasResult = u.result !== null;
  if (u.kind === 'tool') {
    if (!(f.kinds.tool || (f.kinds.result && hasResult))) return false;
    if (f.tool !== '' && u.ev.name !== f.tool) return false;
    if (f.errorsOnly && u.status !== 'failed') return false;
  } else if (u.kind === 'result') {
    if (!f.kinds.result) return false;
    if (f.tool !== '') return false;
    if (f.errorsOnly && u.ev.err !== true) return false;
  } else {
    if (!f.kinds[u.kind]) return false;
    if (f.tool !== '' || f.errorsOnly) return false;
  }
  const q = f.q.trim().toLowerCase();
  if (q !== '' && !unitText(u).includes(q)) return false;
  return true;
}

export function hasActiveFilters(f: TranscriptFilters): boolean {
  return f.q.trim() !== '' || f.tool !== '' || f.errorsOnly;
}

/** Sorted distinct tool names of the units. */
export function collectToolNames(units: readonly Unit[]): string[] {
  const names = new Set<string>();
  for (const u of units) if (u.kind === 'tool' && u.ev.name !== undefined && u.ev.name !== '') names.add(u.ev.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The query of `GET /sessions/:id/transcript/search` (03 6.1), as typed values: the data layer serialises it. */
export interface TranscriptSearchParams {
  session: string;
  agent?: string;
  q?: string;
  kinds?: EntryKind[];
  tool?: string;
  errors?: true;
  limit: number;
}

/** The search query that mirrors the current filters; empty parts are omitted and "all kinds" is no `kinds` filter. */
export function searchQuery(
  f: TranscriptFilters,
  session: string,
  agent: string | null | undefined,
  limit = 200,
): TranscriptSearchParams {
  const params: TranscriptSearchParams = { session, limit };
  if (agent !== null && agent !== undefined && agent !== '') params.agent = agent;
  const q = f.q.trim();
  if (q !== '') params.q = q;
  const kinds = KINDS.filter((k) => f.kinds[k]);
  if (kinds.length > 0 && kinds.length < KINDS.length) params.kinds = kinds;
  if (f.tool !== '') params.tool = f.tool;
  if (f.errorsOnly) params.errors = true;
  return params;
}
