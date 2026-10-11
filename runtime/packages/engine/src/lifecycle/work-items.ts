// Work items for the board (02 7.11, D14): which sessions belong together and which board column the group sits in.
// Pure: sessions with their lifecycle state, the attempts rows and the declared items go in, derived items come out. The
// data layer adds the row id, the sequence number and the token usage (`WorkItem` of `@mcs/shared`).
import type { BoardItem, BoardState, LifecycleState } from '@mcs/shared';

/** What the rules need to know about one session (its view reduced to state and rule). */
export interface WorkItemSession {
  readonly sessionId: string;
  readonly label: string | null;
  /** The session matched a `session_rules` entry (an unmatched session only appears in the explorer). */
  readonly matched: boolean;
  readonly ruleIndex: number | null;
  readonly state: LifecycleState;
  readonly ruleId: string;
  /** `first_seen_at`, epoch ms. */
  readonly startedAt: number | null;
  readonly lastActivityAt: number | null;
}

/** One row of `attempt_runs` (03 3.5). */
export interface WorkItemAttempt {
  readonly part: string;
  readonly startedAt: number;
  readonly endReason: 'open' | 'ended' | 'superseded';
  readonly state: 'COMPLETED' | 'FAILED' | 'RUNNING' | 'UNKNOWN';
  /** The provider id of the matched session; null = not matched. */
  readonly sessionId: string | null;
}

export interface WorkItemInput {
  readonly sessions: readonly WorkItemSession[];
  readonly attempts: readonly WorkItemAttempt[];
  /** `board.items` of `runtime.json`, in declaration order. */
  readonly declared: readonly BoardItem[];
  /** The `label_prefix` of the attempts config, put before the part in the title of an attempt item. */
  readonly labelPrefix: string;
}

export interface WorkItemMember {
  readonly sessionId: string;
  readonly state: LifecycleState;
  readonly ruleId: string;
}

export interface DerivedWorkItem {
  readonly key: string;
  readonly title: string;
  readonly rule: 'W-DECL' | 'W-ATT' | 'W-LBL';
  readonly source: 'declared' | 'attempts' | 'label';
  readonly state: BoardState;
  /** Which of the seven board rules decided (1 to 7). */
  readonly boardRule: number;
  readonly boardReason: string;
  readonly evidence: readonly WorkItemMember[];
  readonly sessionIds: readonly string[];
  readonly since: number | null;
  readonly lastActivityAt: number | null;
}

const WORKING_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'working',
  'running',
  'waiting_tool',
  'waiting_agent',
]);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function minOf(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) if (value !== null && (best === null || value < best)) best = value;
  return best;
}

function maxOf(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) if (value !== null && (best === null || value > best)) best = value;
  return best;
}

/** The latest row by start; ties break on the other columns so the choice never depends on the input order. */
function latestRow(rows: readonly WorkItemAttempt[]): WorkItemAttempt | null {
  let best: WorkItemAttempt | null = null;
  for (const row of rows) {
    if (best === null) {
      best = row;
      continue;
    }
    const order =
      row.startedAt - best.startedAt ||
      compareText(row.endReason, best.endReason) ||
      compareText(row.state, best.state) ||
      compareText(row.sessionId ?? '', best.sessionId ?? '');
    if (order > 0) best = row;
  }
  return best;
}

interface BoardDecision {
  readonly state: BoardState;
  readonly rule: number;
  readonly reason: string;
}

function boardStateOf(members: readonly WorkItemSession[], rows: readonly WorkItemAttempt[]): BoardDecision {
  // 1: an attempt item whose latest row (by start) has ended
  const latest = latestRow(rows);
  if (latest !== null && latest.endReason === 'ended') {
    const state: BoardState =
      latest.state === 'COMPLETED' ? 'completed' : latest.state === 'FAILED' ? 'failed' : 'unknown';
    return {
      state,
      rule: 1,
      reason: `latest attempt of ${latest.part === '' ? '(no part)' : latest.part} ended: ${latest.state}`,
    };
  }
  const ordered = [...members].sort((a, b) => compareText(a.sessionId, b.sessionId));
  // 2: any member is working
  const working = ordered.find((member) => WORKING_STATES.has(member.state));
  if (working !== undefined)
    return { state: 'working', rule: 2, reason: `member session ${working.sessionId} is ${working.state}` };
  // 3: any member waits for input
  const waiting = ordered.find((member) => member.state === 'waiting_input');
  if (waiting !== undefined)
    return { state: 'waiting', rule: 3, reason: `member session ${waiting.sessionId} waits for input` };
  // 4: the most recently started member is completed or failed
  const newest = [...ordered].sort(
    (a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) || compareText(a.sessionId, b.sessionId),
  )[0];
  if (newest !== undefined && (newest.state === 'completed' || newest.state === 'failed')) {
    return { state: newest.state, rule: 4, reason: `the latest session ${newest.sessionId} is ${newest.state}` };
  }
  // 5: any member is stale
  const stale = ordered.find((member) => member.state === 'stale');
  if (stale !== undefined)
    return { state: 'stale', rule: 5, reason: `member session ${stale.sessionId} is stale and needs investigation` };
  // 6: all non-terminal members ended their turn
  const open = ordered.filter((member) => member.state !== 'completed' && member.state !== 'failed');
  if (open.length > 0 && open.every((member) => member.state === 'turn_ended')) {
    return {
      state: 'waiting',
      rule: 6,
      reason: 'all open member sessions ended their turn: finished or waiting cannot be told',
    };
  }
  // 7: otherwise
  return {
    state: 'unknown',
    rule: 7,
    reason: members.length === 0 ? 'no member session' : 'the member sessions give no clear state',
  };
}

function build(
  key: string,
  title: string,
  rule: DerivedWorkItem['rule'],
  source: DerivedWorkItem['source'],
  members: readonly WorkItemSession[],
  rows: readonly WorkItemAttempt[],
): DerivedWorkItem {
  const decision = boardStateOf(members, rows);
  const ordered = [...members].sort((a, b) => compareText(a.sessionId, b.sessionId));
  return {
    key,
    title,
    rule,
    source,
    state: decision.state,
    boardRule: decision.rule,
    boardReason: decision.reason,
    evidence: ordered.map((member) => ({ sessionId: member.sessionId, state: member.state, ruleId: member.ruleId })),
    sessionIds: ordered.map((member) => member.sessionId),
    since: minOf([...members.map((member) => member.startedAt), ...rows.map((row) => row.startedAt)]),
    lastActivityAt: maxOf(members.map((member) => member.lastActivityAt)),
  };
}

/**
 * The work items of the board: declared items first (W-DECL), then one item per attempt part (W-ATT), then one per label
 * (W-LBL). A session is a member of at most one item, the first that claims it; unmatched sessions without an explicit
 * declaration belong to none.
 */
export function deriveWorkItems(input: WorkItemInput): DerivedWorkItem[] {
  const sessions = [...input.sessions].sort((a, b) => compareText(a.sessionId, b.sessionId));
  const claimed = new Set<string>();
  const items: DerivedWorkItem[] = [];
  const declaredParts = new Set(input.declared.flatMap((item) => item.match.attemptParts ?? []));

  // W-DECL
  for (const declaration of input.declared) {
    const match = declaration.match;
    const rows = input.attempts.filter((row) => match.attemptParts?.includes(row.part) === true);
    const rowSessions = new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId])));
    const members = sessions.filter((candidate) => {
      if (claimed.has(candidate.sessionId)) return false;
      if (match.sessionIds?.includes(candidate.sessionId) === true) return true;
      if (rowSessions.has(candidate.sessionId)) return true;
      if (!candidate.matched || candidate.label === null) return false;
      if (match.labels?.includes(candidate.label) === true) return true;
      return match.labelPrefix !== undefined && candidate.label.startsWith(match.labelPrefix);
    });
    for (const member of members) claimed.add(member.sessionId);
    items.push(build(declaration.key, declaration.title, 'W-DECL', 'declared', members, rows));
  }

  // W-ATT
  const parts = new Map<string, WorkItemAttempt[]>();
  for (const row of input.attempts) {
    if (declaredParts.has(row.part)) continue;
    const group = parts.get(row.part);
    if (group === undefined) parts.set(row.part, [row]);
    else group.push(row);
  }
  const partOrder = [...parts.entries()]
    .map(([part, rows]) => ({ part, rows, first: minOf(rows.map((row) => row.startedAt)) ?? 0 }))
    .sort((a, b) => a.first - b.first || compareText(a.part, b.part));
  for (const { part, rows } of partOrder) {
    const rowSessions = new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId])));
    const members = sessions.filter(
      (candidate) => !claimed.has(candidate.sessionId) && rowSessions.has(candidate.sessionId),
    );
    for (const member of members) claimed.add(member.sessionId);
    items.push(build(`attempt:${part}`, `${input.labelPrefix}${part}`, 'W-ATT', 'attempts', members, rows));
  }

  // W-LBL
  const labels = new Map<string, WorkItemSession[]>();
  for (const candidate of sessions) {
    if (claimed.has(candidate.sessionId) || !candidate.matched || candidate.label === null) continue;
    const group = labels.get(candidate.label);
    if (group === undefined) labels.set(candidate.label, [candidate]);
    else group.push(candidate);
  }
  for (const [label, members] of [...labels.entries()].sort(([a], [b]) => compareText(a, b))) {
    items.push(build(`label:${label}`, label, 'W-LBL', 'label', members, []));
  }
  return items;
}
