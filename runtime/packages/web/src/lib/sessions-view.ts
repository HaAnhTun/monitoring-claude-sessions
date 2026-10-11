// Session list grouping and filtering (logic half of legacy modules/sessions.js, 04 sections 4.4 and 10). Pure and
// generic over the session and agent shapes: the real `SessionSummary` and `AgentNode` of @mcs/shared satisfy them.
import type { LegacyState } from '@mcs/shared';

import {
  SIDEBAR_GROUPS,
  legacyStateOf,
  sidebarGroupOf,
  type SidebarGroup,
  type SidebarGroupId,
} from './lifecycle-display.ts';

export const LAZY_AGENT_THRESHOLD = 30;
export const AGENT_PAGE = 100;

export interface ViewState {
  state: string;
  evidence?: readonly { text: string }[];
}

export interface ViewSession {
  id: string;
  label: string;
  state: ViewState;
}

export interface ViewWorkflow {
  runId: string;
  name: string | null;
  phase?: string | null;
  state: string;
}

export interface GroupableAgent {
  workflow: ViewWorkflow | null;
  state: { state: string };
}

export interface ViewAgent extends GroupableAgent {
  id: string;
  label: string;
  model: string | null;
  state: ViewState;
}

const lc = (v: string | null | undefined): string => (v ?? '').toLowerCase();

function sessionHaystack(s: ViewSession): string {
  return [s.label, s.id, s.state.state, ...(s.state.evidence ?? []).map((e) => e.text)].map(lc).join(' ');
}

function agentHaystack(a: ViewAgent): string {
  return [a.label, a.id, a.workflow?.name, a.workflow?.runId, a.model, a.state.state].map(lc).join(' ');
}

export interface SessionViewEntry<S, A> {
  s: S;
  agents: A[];
  /** The session itself did not match; it is listed because some of its agents did. */
  viaAgents: boolean;
}

export interface SessionViewGroup<S, A> extends SidebarGroup {
  entries: SessionViewEntry<S, A>[];
}

/**
 * Filters and groups sessions into the sidebar groups (Active, Needs input, Idle, Done, Stale or unknown), without empty
 * groups. Filter tokens are ANDed; a session whose own fields do not match but some agent does is kept with only those
 * agents.
 */
export function buildSessionView<S extends ViewSession, A extends ViewAgent = ViewAgent>(
  list: readonly S[],
  filterText = '',
  agentsOf: (s: S) => readonly A[] = () => [],
): SessionViewGroup<S, A>[] {
  const tokens = lc(filterText).split(/\s+/).filter(Boolean);
  const entries: SessionViewEntry<S, A>[] = [];
  for (const s of list) {
    const agents = [...agentsOf(s)];
    if (tokens.length === 0) {
      entries.push({ s, agents, viaAgents: false });
      continue;
    }
    const sh = sessionHaystack(s);
    if (tokens.every((t) => sh.includes(t))) {
      entries.push({ s, agents, viaAgents: false });
      continue;
    }
    const hit = agents.filter((a) => {
      const h = `${sh} ${agentHaystack(a)}`;
      return tokens.every((t) => h.includes(t));
    });
    if (hit.length > 0) entries.push({ s, agents: hit, viaAgents: true });
  }
  return SIDEBAR_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    entries: entries.filter((e) => sidebarGroupOf(e.s.state.state) === g.id),
  })).filter((g) => g.entries.length > 0);
}

export interface AgentGroup<I> {
  /** The workflow run id; '' for plain subagents. */
  key: string;
  /** The workflow name, '' for plain subagents and for a run without a name. */
  name: string;
  title: string;
  /** The state of the workflow run itself; null for plain subagents. */
  workflowState: string | null;
  agents: I[];
  summary: string;
}

const LEGACY_ORDER: readonly LegacyState[] = ['RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN'];

/** "2 running, 5 completed" in a stable order of the five legacy states. */
export function stateSummary(items: readonly { state: { state: string } }[]): string {
  const counts = new Map<LegacyState, number>();
  for (const it of items) {
    const s = legacyStateOf(it.state.state);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return LEGACY_ORDER.flatMap((s) => {
    const n = counts.get(s);
    return n === undefined ? [] : [`${String(n)} ${s.toLowerCase()}`];
  }).join(', ');
}

/** Groups items by workflow run (plain subagents first as "Subagents", then one group per run in order of appearance). */
export function groupItems<I>(items: readonly I[], agentOf: (item: I) => GroupableAgent): AgentGroup<I>[] {
  const plain: I[] = [];
  const runs = new Map<string, { name: string; state: string; agents: I[] }>();
  for (const item of items) {
    const workflow = agentOf(item).workflow;
    if (workflow === null) {
      plain.push(item);
      continue;
    }
    const run = runs.get(workflow.runId);
    if (run === undefined)
      runs.set(workflow.runId, { name: workflow.name ?? '', state: workflow.state, agents: [item] });
    else run.agents.push(item);
  }
  const groups: AgentGroup<I>[] = [];
  if (plain.length > 0) {
    groups.push({
      key: '',
      name: '',
      title: 'Subagents',
      workflowState: null,
      agents: plain,
      summary: stateSummary(plain.map(agentOf)),
    });
  }
  for (const [runId, run] of runs) {
    groups.push({
      key: runId,
      name: run.name,
      title: `Workflow ${run.name === '' ? runId : run.name}`,
      workflowState: run.state,
      agents: run.agents,
      summary: stateSummary(run.agents.map(agentOf)),
    });
  }
  return groups;
}

export function groupAgents<A extends GroupableAgent>(agents: readonly A[]): AgentGroup<A>[] {
  return groupItems(agents, (a) => a);
}

export interface StateMapEntry {
  state: LegacyState;
  label: string;
}

/** Key -> five-state value for every session (`<id>|`) and agent (`<id>|<agentId>`), used to announce changes. */
export function stateMap<S extends ViewSession>(
  list: readonly S[],
  agentsOf: (s: S) => readonly ViewAgent[] = () => [],
): Map<string, StateMapEntry> {
  const m = new Map<string, StateMapEntry>();
  for (const s of list) {
    m.set(`${s.id}|`, { state: legacyStateOf(s.state.state), label: s.label });
    for (const a of agentsOf(s)) {
      m.set(`${s.id}|${a.id}`, { state: legacyStateOf(a.state.state), label: `${s.label} / ${a.label}` });
    }
  }
  return m;
}

export interface StateChange {
  key: string;
  label: string;
  from: LegacyState;
  to: LegacyState;
}

/** Items present in both maps whose five-state value changed. */
export function diffStates(
  prev: ReadonlyMap<string, StateMapEntry>,
  next: ReadonlyMap<string, StateMapEntry>,
): StateChange[] {
  const changes: StateChange[] = [];
  for (const [key, v] of next) {
    const p = prev.get(key);
    if (p !== undefined && p.state !== v.state) changes.push({ key, label: v.label, from: p.state, to: v.state });
  }
  return changes;
}

/**
 * The session the sidebar's "jump to first active" link opens: the first active one, else the first that needs input,
 * else the first listed; null for an empty list (selection itself is the URL since v3).
 */
export function pickDefaultSession<S>(view: readonly { id: SidebarGroupId; entries: readonly { s: S }[] }[]): S | null {
  for (const id of ['active', 'needs-input'] as const) {
    const first = view.find((g) => g.id === id)?.entries[0];
    if (first !== undefined) return first.s;
  }
  return view.find((g) => g.entries.length > 0)?.entries[0]?.s ?? null;
}
