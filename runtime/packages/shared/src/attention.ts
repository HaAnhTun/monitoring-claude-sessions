// The attention classifier (ADR 0107): what a session asks of the person, read from the lifecycle rule that decided its
// state. One table for the web (badges, the strip, notifications) and the CLI (`events`, `wait`). Pure and isomorphic: no
// clock, no I/O, no zod.
//
// Three rules of reading:
// - the class follows the RULE of the assessment (`S-6` needs you, `S-8b` is ready), never the state or the wait reason
//   alone: `S-6b` and `S-8b` are both `waiting_input` with `waitReason: user`, and only the first blocks an agent;
// - `unknown` and `stale` are never promoted, whatever the rule says;
// - a rule this table does not know is classified by its state, and a `waiting_input` of an unknown rule is `unknown`.
import type { StateAssessment } from './api/entities.ts';
import type { TerminalLink } from './api/folders.ts';

export const ATTENTION_POSTURES = ['needs_you', 'failed', 'ready', 'working', 'ended', 'unknown'] as const;
export type AttentionPosture = (typeof ATTENTION_POSTURES)[number];

export const ATTENTION_REASONS = [
  /** S-6 with `waitReason: permission`. */
  'permission',
  /** S-6 with any other wait reason (a question, an elicitation, an agent that asks for input). */
  'question',
  /** A terminal whose link is still pending after the server's 30 s rule. */
  'not_linked',
  /** State `failed`. */
  'session_failed',
  /** S-8e with `turnOutcome: error`. */
  'turn_failed',
  /** S-8b, S-8c, S-8e with outcome ok. */
  'turn_done',
  /** State `completed`. */
  'session_done',
  /** S-8e with `turnOutcome: interrupted`. */
  'interrupted',
  /** S-8f: ready for the first prompt, nothing ran yet. */
  'first_prompt',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface AttentionClass {
  readonly posture: AttentionPosture;
  readonly reason: AttentionReason | null;
  /** `S-6`, `S-8`, ... the family of the rule; `link` for a terminal row classified from its link. */
  readonly family: string;
}

/** How one rule id is classified. */
export type AttentionRuleKind =
  /** `completed` is ended, `failed` is failed, anything else is unknown (S-1: the state comes from the attempt row). */
  | 'by_state'
  | 'session_done'
  | 'session_failed'
  | 'needs_you'
  | 'working'
  | 'turn_done'
  /** S-8e: the turn outcome decides (ok, error, interrupted). */
  | 'turn_outcome'
  | 'first_prompt'
  | 'unknown';

/**
 * Every rule id the lifecycle can answer (`ruleId` literals of `engine/src/lifecycle/derive-session.ts`) and how it is
 * classified. `attention-rules.test.ts` of the engine fails when the two id sets differ, so a new rule cannot ship
 * unclassified.
 */
export const ATTENTION_RULES = {
  'S-1': 'by_state',
  'S-2': 'unknown',
  'S-3a': 'session_failed',
  'S-3b': 'session_done',
  'S-4a': 'session_done',
  'S-4b': 'session_failed',
  'S-5': 'unknown',
  'S-6a': 'needs_you',
  'S-6b': 'needs_you',
  'S-6c': 'needs_you',
  'S-7a': 'working',
  'S-7b': 'working',
  'S-7c': 'working',
  'S-7d': 'unknown',
  'S-7e': 'working',
  'S-7f': 'unknown',
  'S-8a': 'working',
  'S-8b': 'turn_done',
  'S-8c': 'turn_done',
  'S-8d': 'unknown',
  'S-8e': 'turn_outcome',
  'S-8f': 'first_prompt',
  'S-9a': 'working',
  'S-9b': 'working',
  'S-9c': 'working',
  'S-10': 'unknown',
} as const satisfies Readonly<Record<string, AttentionRuleKind>>;
export type AttentionRuleId = keyof typeof ATTENTION_RULES;

/** What the classifier reads of a monitored session: `SessionSummary['state']` satisfies it. */
export type AttentionInput = Pick<StateAssessment, 'state' | 'rule' | 'waitReason' | 'turnOutcome'>;

/** What the classifier reads of a terminal row that has no monitor row yet. */
export type AttentionLinkInput = Pick<
  TerminalLink,
  'status' | 'reason' | 'transcript' | 'registryStatus' | 'waitingFor'
>;

const RULE_FAMILY_RE = /^(S-\d+)[a-z]$/;

/** `S-8b` is `S-8`, `S-10` is `S-10`; an id of another shape is its own family. */
export function ruleFamily(rule: string): string {
  return RULE_FAMILY_RE.exec(rule)?.[1] ?? rule;
}

const RULE_KINDS: Readonly<Record<string, AttentionRuleKind | undefined>> = ATTENTION_RULES;

function kindOfRule(rule: string): AttentionRuleKind | null {
  return Object.hasOwn(RULE_KINDS, rule) ? (RULE_KINDS[rule] ?? null) : null;
}

/** The kind of a rule the table does not know: read from the state, and a `waiting_input` stays unknown. */
function kindOfState(state: AttentionInput['state']): AttentionRuleKind {
  switch (state) {
    case 'completed':
      return 'session_done';
    case 'failed':
      return 'session_failed';
    case 'running':
    case 'working':
    case 'waiting_tool':
    case 'waiting_agent':
      return 'working';
    case 'turn_ended':
      return 'turn_outcome';
    case 'waiting_input':
    case 'stale':
    case 'unknown':
      return 'unknown';
  }
}

export function attentionOf(input: AttentionInput): AttentionClass {
  const family = ruleFamily(input.rule);
  const cls = (posture: AttentionPosture, reason: AttentionReason | null = null): AttentionClass => ({
    posture,
    reason,
    family,
  });
  // Never promoted: an unknown or stale state says nothing a person should act on.
  if (input.state === 'unknown' || input.state === 'stale') return cls('unknown');
  let kind = kindOfRule(input.rule) ?? kindOfState(input.state);
  if (kind === 'by_state') {
    kind = input.state === 'completed' ? 'session_done' : input.state === 'failed' ? 'session_failed' : 'unknown';
  }
  switch (kind) {
    case 'session_done':
      return cls('ended', 'session_done');
    case 'session_failed':
      return cls('failed', 'session_failed');
    case 'needs_you':
      return cls('needs_you', input.waitReason === 'permission' ? 'permission' : 'question');
    case 'working':
      return cls('working');
    case 'turn_done':
      return cls('ready', 'turn_done');
    case 'turn_outcome':
      if (input.turnOutcome === 'error') return cls('failed', 'turn_failed');
      return cls('ready', input.turnOutcome === 'interrupted' ? 'interrupted' : 'turn_done');
    case 'first_prompt':
      return cls('ready', 'first_prompt');
    case 'unknown':
      return cls('unknown');
  }
}

/**
 * The class of a terminal row whose `claude` has no monitor row yet (family `link`). The 30 s of "needs a look" are the
 * server's: this reads `link.reason`, it never measures time.
 */
export function attentionOfLink(link: AttentionLinkInput): AttentionClass {
  const cls = (posture: AttentionPosture, reason: AttentionReason | null = null): AttentionClass => ({
    posture,
    reason,
    family: 'link',
  });
  if (link.status === 'pending') return link.reason === 'no_registry' ? cls('needs_you', 'not_linked') : cls('unknown');
  if (link.status !== 'linked' || link.transcript !== 'none') return cls('unknown');
  switch (link.registryStatus) {
    case 'waiting':
      // The same test as rule S-6b of the engine.
      return cls('needs_you', link.waitingFor?.includes('permission') === true ? 'permission' : 'question');
    case 'idle':
      return cls('ready', 'first_prompt');
    case 'busy':
      return cls('working');
    case null:
      return cls('unknown');
  }
}

/** Highest first. */
export const ATTENTION_LEVELS = ['needs_you', 'failed', 'done', 'working', 'idle', 'unknown'] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

/**
 * The level a row is shown at. `needs_you` holds while the posture holds; `failed` and `done` hold only until the person
 * has seen them (`unseen`), then the row is `idle`. Only a finished turn and a finished session are `done`: an interrupted
 * turn and a session that waits for its first prompt are `idle`.
 */
export function levelOf(cls: AttentionClass, unseen: boolean): AttentionLevel {
  switch (cls.posture) {
    case 'needs_you':
      return 'needs_you';
    case 'failed':
      return unseen ? 'failed' : 'idle';
    case 'ready':
      return unseen && cls.reason === 'turn_done' ? 'done' : 'idle';
    case 'ended':
      return unseen && cls.reason === 'session_done' ? 'done' : 'idle';
    case 'working':
      return 'working';
    case 'unknown':
      return 'unknown';
  }
}

export interface AttentionOrderKey {
  readonly level: AttentionLevel;
  /** An API time (`YYYY-MM-DDTHH:MM:SS.mmmZ`, so text order is time order) or `null`. */
  readonly since: string | null;
}

/**
 * Sort order of attention rows: by level, highest first; inside `needs_you` the oldest `since` first (the longest blocked),
 * inside the other levels the newest first; `null` last.
 */
export function compareAttention(a: AttentionOrderKey, b: AttentionOrderKey): number {
  const byLevel = ATTENTION_LEVELS.indexOf(a.level) - ATTENTION_LEVELS.indexOf(b.level);
  if (byLevel !== 0) return byLevel;
  if (a.since === b.since) return 0;
  if (a.since === null) return 1;
  if (b.since === null) return -1;
  const oldestFirst = a.since < b.since ? -1 : 1;
  return a.level === 'needs_you' ? oldestFirst : -oldestFirst;
}

export type AttentionEventKind = 'needs_you' | 'failed' | 'done';

const isDone = (cls: AttentionClass): boolean =>
  (cls.posture === 'ready' && cls.reason === 'turn_done') || (cls.posture === 'ended' && cls.reason === 'session_done');

/**
 * The event of a transition from `prev` to `next`, or `null`. `prev` is `null` for an id the client did not know:
 * silent when `baseline` (the first snapshot a client ever sees), otherwise a session that is already `needs_you` or
 * `failed` fires. `done` needs a previous posture that was active (`working` or `needs_you`): a session first seen ready
 * never produces it. The same posture again is no event.
 */
export function attentionEventOf(
  prev: AttentionClass | null,
  next: AttentionClass,
  options: { readonly baseline: boolean },
): AttentionEventKind | null {
  if (prev === null) {
    if (options.baseline) return null;
    return next.posture === 'needs_you' || next.posture === 'failed' ? next.posture : null;
  }
  if (next.posture === 'needs_you' || next.posture === 'failed') {
    return prev.posture === next.posture ? null : next.posture;
  }
  if (isDone(next) && (prev.posture === 'working' || prev.posture === 'needs_you')) return 'done';
  return null;
}
