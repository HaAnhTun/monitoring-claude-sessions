// The decision part of `wait` (ADR 0108): a pure machine without a clock or I/O. The caller feeds what it read (the state
// of the session, or `missing`), passes the time as a number of milliseconds, asks the completion check when the machine
// says so and sleeps until `wakeAt` or the next change.
import type { CompletionOutcome } from './api/completion.ts';
import type { StateAssessment } from './api/entities.ts';
import { attentionOf } from './attention.ts';
import type { WaitOutcome, WaitUntil } from './cli/watch.ts';

/** What the machine reads of a session: a `StateAssessment` satisfies it. */
export type WaitSnapshot = Pick<
  StateAssessment,
  'state' | 'rule' | 'presence' | 'waitReason' | 'turnOutcome' | 'staleKind'
>;

export interface WaitMachineOptions {
  readonly until: WaitUntil;
  /** How long the condition must keep holding before it counts; never longer than `timeoutMs`. Not used by `completed`. */
  readonly holdMs: number;
  /** The condition must be seen false first and true afterwards. */
  readonly next: boolean;
  /** How long the session may stay missing before the wait ends with `missing`. */
  readonly appearMs: number;
  /** 0 checks once: the first `feed` or `proof` decides. */
  readonly timeoutMs: number;
}

export type WaitStep =
  | { readonly status: 'pending'; readonly wakeAt: number | null; readonly needsProof: boolean }
  | { readonly status: 'done'; readonly outcome: WaitOutcome; readonly alreadyTrue: boolean };

export interface WaitMachine {
  /** The state just read, or `missing` when there is no such session (never seen, or deleted). */
  feed(snapshot: WaitSnapshot | 'missing', now: number): WaitStep;
  /** Time passed and nothing changed. */
  tick(now: number): WaitStep;
  /**
   * The answer of the completion check, asked after a step with `needsProof: true`. Answer it before the next `tick`: a
   * tick at the deadline ends the wait with `timeout`.
   */
  proof(outcome: CompletionOutcome, now: number): WaitStep;
}

/** The rules of a finished turn. S-8a (background work goes on) and S-8f (nothing ran) do not count. */
const TURN_ENDED_RULES: ReadonlySet<string> = new Set(['S-8b', 'S-8c', 'S-8e']);

const sessionEnded = (s: WaitSnapshot): boolean =>
  s.presence === 'ended' || s.state === 'completed' || s.state === 'failed';
const processGone = (s: WaitSnapshot): boolean => s.state === 'stale' && s.staleKind === 'process_gone';

/**
 * `true`: the condition holds. `false`: not now. `over`: the session is over and the condition can no longer come true.
 * `proof`: only the completion check can say (a transcript alone never proves completion).
 */
function conditionOf(until: WaitUntil, s: WaitSnapshot): 'true' | 'false' | 'over' | 'proof' {
  const over = sessionEnded(s) || processGone(s);
  const otherwise = over ? 'over' : 'false';
  switch (until) {
    case 'needs_you':
      return attentionOf(s).posture === 'needs_you' ? 'true' : otherwise;
    case 'turn_ended':
      return TURN_ENDED_RULES.has(s.rule) || sessionEnded(s) ? 'true' : otherwise;
    case 'completed':
      return over ? 'proof' : 'false';
    case 'failed':
      return attentionOf(s).posture === 'failed' ? 'true' : otherwise;
    case 'ended':
      return s.presence === 'ended' ? 'true' : otherwise;
  }
}

export function createWaitMachine(o: WaitMachineOptions, startedAt: number): WaitMachine {
  const deadline = startedAt + o.timeoutMs;
  const appearDeadline = Math.min(startedAt + o.appearMs, deadline);
  const holdMs = Math.min(o.holdMs, o.timeoutMs);

  let done: WaitStep | null = null;
  let last: WaitSnapshot | null = null;
  /** The condition was seen false since the wait began (what `next` needs, and what `alreadyTrue` denies). */
  let sawFalse = false;
  /** Since when the condition holds without a break. */
  let heldSince: number | null = null;
  let awaitingProof = false;

  const finish = (outcome: WaitOutcome): WaitStep => {
    done = { status: 'done', outcome, alreadyTrue: outcome === 'met' && !sawFalse };
    return done;
  };

  /**
   * The step after the facts were applied: a hold that ran out, a deadline, or still pending. `proofGrace` keeps a wait
   * open at its deadline until the completion check it just asked for has answered (so that a timeout of 0 can be met).
   */
  const settle = (now: number, proofGrace = false): WaitStep => {
    if (heldSince !== null && now - heldSince >= holdMs) return finish('met');
    if (last === null && now >= appearDeadline) return finish('missing');
    if (now >= deadline && !(proofGrace && awaitingProof)) return finish('timeout');
    const wakes = [deadline];
    if (last === null) wakes.push(appearDeadline);
    if (heldSince !== null) wakes.push(heldSince + holdMs);
    return { status: 'pending', wakeAt: Math.min(...wakes), needsProof: awaitingProof };
  };

  return {
    feed(snapshot, now) {
      if (done !== null) return done;
      if (snapshot === 'missing') return last === null ? settle(now) : finish('ended');
      last = snapshot;
      awaitingProof = false;
      const condition = conditionOf(o.until, snapshot);
      if (condition === 'over') return finish('ended');
      if (condition === 'proof') {
        heldSince = null;
        awaitingProof = true;
      } else if (condition === 'false') {
        sawFalse = true;
        heldSince = null;
      } else if (o.next && !sawFalse) {
        // Already true and `next` wants a change: a session that is over can never show one.
        if (sessionEnded(snapshot) || processGone(snapshot)) return finish('ended');
      } else {
        heldSince ??= now;
      }
      return settle(now, true);
    },
    tick(now) {
      return done ?? settle(now);
    },
    proof(outcome, now) {
      if (done !== null) return done;
      if (!awaitingProof || last === null) return settle(now);
      awaitingProof = false;
      if (outcome === 'completed') return finish(o.next && !sawFalse ? 'ended' : 'met');
      // A failed session cannot complete; a session that is gone without proof cannot either.
      if (outcome === 'failed' || last.presence === 'ended' || processGone(last)) return finish('ended');
      sawFalse = true;
      return settle(now);
    },
  };
}
