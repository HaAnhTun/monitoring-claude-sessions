// Session grouping helpers of the shell and of the agent tree (04 section 4.4, ADR 0073 decision 4). Pure and generic over the
// session and agent shapes: the real `SessionSummary` and `AgentNode` of @mcs/shared satisfy them. The words are catalogue keys
// (`shell.*`); the `title` and `summary` strings of a group are English aliases for the consumers that are not converted yet.
import type { LegacyState } from '@mcs/shared';

import { formatMessage } from '../i18n/format-message.ts';
import { enMessages } from '../i18n/messages/en.ts';
import type { MessageKey, TFunction } from '../i18n/types.ts';
import { legacyStateOf, sidebarGroupOf } from './lifecycle-display.ts';

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

export type SummaryKey = Extract<MessageKey, `shell.agents.summary.${string}`>;

/** One part of "2 running, 5 completed": the message and its count. */
export interface SummaryPart {
  key: SummaryKey;
  count: number;
}

export interface AgentGroup<I> {
  /** The workflow run id; '' for plain subagents. */
  key: string;
  /** The workflow name, '' for plain subagents and for a run without a name. */
  name: string;
  /** The title as a message: `shell.agents.subagents`, or `shell.agents.workflow` with `titleArgs`. */
  titleKey: 'shell.agents.subagents' | 'shell.agents.workflow';
  /** `{ name }` of the workflow message: the workflow name, or its run id when it has none; null for plain subagents. */
  titleArgs: { name: string } | null;
  /** @deprecated English text computed from the catalogue; use `agentGroupTitle(group, t)`. */
  title: string;
  /** The state of the workflow run itself; null for plain subagents. */
  workflowState: string | null;
  agents: I[];
  /** The count of each legacy state present, in a stable order; render it with `stateSummaryText`. */
  summaryParts: SummaryPart[];
  /** @deprecated English text computed from the catalogue; use `stateSummaryText(group.summaryParts, t)`. */
  summary: string;
}

const SUMMARY_ORDER: readonly { state: LegacyState; key: SummaryKey }[] = [
  { state: 'RUNNING', key: 'shell.agents.summary.running' },
  { state: 'IDLE', key: 'shell.agents.summary.idle' },
  { state: 'COMPLETED', key: 'shell.agents.summary.completed' },
  { state: 'FAILED', key: 'shell.agents.summary.failed' },
  { state: 'UNKNOWN', key: 'shell.agents.summary.unknown' },
];

/** The counts of the five legacy states present in `items`, in a stable order. */
export function stateSummaryParts(items: readonly { state: { state: string } }[]): SummaryPart[] {
  const counts = new Map<LegacyState, number>();
  for (const it of items) {
    const s = legacyStateOf(it.state.state);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return SUMMARY_ORDER.flatMap(({ state, key }) => {
    const count = counts.get(state);
    return count === undefined ? [] : [{ key, count }];
  });
}

/** "2 running, 5 completed" in the language of `t`. */
export function stateSummaryText(parts: readonly SummaryPart[], t: TFunction): string {
  return parts.map((part) => t(part.key, { count: part.count })).join(', ');
}

/** The English text of a summary, for the deprecated aliases. */
function englishSummary(parts: readonly SummaryPart[]): string {
  return parts.map((part) => formatMessage(enMessages[part.key], { count: part.count }, 'en')).join(', ');
}

/** @deprecated English text; use `stateSummaryParts` with `stateSummaryText`. */
export function stateSummary(items: readonly { state: { state: string } }[]): string {
  return englishSummary(stateSummaryParts(items));
}

/** The title of an agent group in the language of `t`. */
export function agentGroupTitle<I>(group: AgentGroup<I>, t: TFunction): string {
  return group.titleArgs === null ? t('shell.agents.subagents') : t('shell.agents.workflow', group.titleArgs);
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
    const summaryParts = stateSummaryParts(plain.map(agentOf));
    groups.push({
      key: '',
      name: '',
      titleKey: 'shell.agents.subagents',
      titleArgs: null,
      title: enMessages['shell.agents.subagents'],
      workflowState: null,
      agents: plain,
      summaryParts,
      summary: englishSummary(summaryParts),
    });
  }
  for (const [runId, run] of runs) {
    const titleArgs = { name: run.name === '' ? runId : run.name };
    const summaryParts = stateSummaryParts(run.agents.map(agentOf));
    groups.push({
      key: runId,
      name: run.name,
      titleKey: 'shell.agents.workflow',
      titleArgs,
      title: formatMessage(enMessages['shell.agents.workflow'], titleArgs, 'en'),
      workflowState: run.state,
      agents: run.agents,
      summaryParts,
      summary: englishSummary(summaryParts),
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

// ---- the session switcher of the sidebar (ADR 0073 decision 4) ----------------------------------------------------------------

/** Rows the switcher shows at most; the rest is a "more" link to the Sessions page. */
export const SWITCHER_MAX_ROWS = 12;

export interface SwitcherSession extends ViewSession {
  errorCount: number;
}

export interface SwitcherGroup<S> {
  id: 'errors' | 'active';
  titleKey: 'shell.switcher.errors' | 'state.group.active';
  sessions: S[];
}

export interface SwitcherView<S> {
  groups: SwitcherGroup<S>[];
  /** Sessions that qualify but are not shown because of the cap. */
  hidden: number;
}

/**
 * The compact list of the sidebar on the session page: sessions with errors first, then the sessions that are active now, each
 * session once (an active session that has errors is in the first group). The list keeps the order it was given, shows at most
 * `max` rows and always keeps the open session when it qualifies, so that it can be marked.
 */
export function switcherView<S extends SwitcherSession>(
  list: readonly S[],
  max: number = SWITCHER_MAX_ROWS,
  currentId: string | null = null,
): SwitcherView<S> {
  const withErrors = list.filter((s) => s.errorCount > 0);
  const active = list.filter((s) => s.errorCount === 0 && sidebarGroupOf(s.state.state) === 'active');
  const eligible = [...withErrors, ...active];
  let shown = eligible.slice(0, Math.max(0, max));
  const current = currentId === null ? undefined : eligible.find((s) => s.id === currentId);
  if (current !== undefined && !shown.includes(current) && shown.length > 0) {
    shown = [...shown.slice(0, -1), current];
  }
  const groups: SwitcherGroup<S>[] = [
    { id: 'errors', titleKey: 'shell.switcher.errors', sessions: withErrors.filter((s) => shown.includes(s)) },
    { id: 'active', titleKey: 'state.group.active', sessions: active.filter((s) => shown.includes(s)) },
  ];
  return { groups: groups.filter((g) => g.sessions.length > 0), hidden: eligible.length - shown.length };
}
