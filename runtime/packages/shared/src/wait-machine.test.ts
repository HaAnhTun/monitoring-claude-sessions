// The wait machine (ADR 0108) against sequences of snapshots: every `until`, hold, next, appear, timeouts, proof.
import { describe, expect, it } from 'vitest';

import type { CompletionOutcome } from './api/completion.ts';
import type { WaitUntil } from './cli/watch.ts';
import { type WaitMachineOptions, type WaitSnapshot, type WaitStep, createWaitMachine } from './wait-machine.ts';

const snap = (rule: string, state: WaitSnapshot['state'], patch: Partial<WaitSnapshot> = {}): WaitSnapshot => ({
  rule,
  state,
  presence: 'open',
  waitReason: null,
  turnOutcome: null,
  staleKind: null,
  ...patch,
});

const WORKING = snap('S-7b', 'working');
const NEEDS_YOU = snap('S-6b', 'waiting_input', { waitReason: 'permission' });
const TURN_DONE = snap('S-8b', 'waiting_input', { waitReason: 'user' });
const TURN_FAILED = snap('S-8e', 'turn_ended', { turnOutcome: 'error' });
const BACKGROUND = snap('S-8a', 'waiting_agent');
const FIRST_PROMPT = snap('S-8f', 'waiting_input', { waitReason: 'user' });
const COMPLETED = snap('S-4a', 'completed', { presence: 'ended' });
const FAILED = snap('S-4b', 'failed', { presence: 'ended' });
const ATTEMPT_DONE = snap('S-1', 'completed', { presence: 'unknown' });
const GONE = snap('S-5', 'stale', { staleKind: 'process_gone', presence: 'unknown' });

type Action = ['feed', WaitSnapshot | 'missing', number] | ['tick', number] | ['proof', CompletionOutcome, number];

function run(options: Partial<WaitMachineOptions> & { until: WaitUntil }, actions: Action[]): WaitStep[] {
  const machine = createWaitMachine({ holdMs: 0, next: false, appearMs: 30_000, timeoutMs: 60_000, ...options }, 0);
  return actions.map((action) => {
    if (action[0] === 'feed') return machine.feed(action[1], action[2]);
    if (action[0] === 'tick') return machine.tick(action[1]);
    return machine.proof(action[1], action[2]);
  });
}

const last = (steps: WaitStep[]): string => {
  const step = steps.at(-1);
  if (step === undefined) return 'none';
  if (step.status === 'pending') return `pending@${String(step.wakeAt)}${step.needsProof ? '+proof' : ''}`;
  return `${step.outcome}${step.alreadyTrue ? '+already' : ''}`;
};

describe('createWaitMachine', () => {
  it('TC-EVW-04 decides every until from the snapshots it is fed', () => {
    const cases: [string, Partial<WaitMachineOptions> & { until: WaitUntil }, Action[], string][] = [
      // needs_you: hold, a flip that breaks the hold, a session that ended first
      [
        'needs_you held',
        { until: 'needs_you', holdMs: 3000 },
        [
          ['feed', NEEDS_YOU, 0],
          ['tick', 3000],
        ],
        'met+already',
      ],
      ['needs_you holding', { until: 'needs_you', holdMs: 3000 }, [['feed', NEEDS_YOU, 100]], 'pending@3100'],
      [
        'needs_you flip',
        { until: 'needs_you', holdMs: 3000 },
        [
          ['feed', NEEDS_YOU, 0],
          ['feed', WORKING, 2000],
          ['tick', 3000],
          ['feed', NEEDS_YOU, 4000],
          ['tick', 6999],
        ],
        'pending@7000',
      ],
      [
        'needs_you after a flip',
        { until: 'needs_you', holdMs: 3000 },
        [
          ['feed', WORKING, 0],
          ['feed', NEEDS_YOU, 4000],
          ['tick', 7000],
        ],
        'met',
      ],
      ['needs_you not for S-8b', { until: 'needs_you' }, [['feed', TURN_DONE, 0]], 'pending@60000'],
      [
        'needs_you after the end',
        { until: 'needs_you' },
        [
          ['feed', WORKING, 0],
          ['feed', COMPLETED, 10],
        ],
        'ended',
      ],
      ['needs_you, process gone', { until: 'needs_you' }, [['feed', GONE, 0]], 'ended'],
      // turn_ended
      [
        'turn_ended S-8b',
        { until: 'turn_ended' },
        [
          ['feed', WORKING, 0],
          ['feed', TURN_DONE, 10],
        ],
        'met',
      ],
      ['turn_ended S-8e error', { until: 'turn_ended' }, [['feed', TURN_FAILED, 0]], 'met+already'],
      ['turn_ended not S-8a', { until: 'turn_ended' }, [['feed', BACKGROUND, 0]], 'pending@60000'],
      ['turn_ended not S-8f', { until: 'turn_ended' }, [['feed', FIRST_PROMPT, 0]], 'pending@60000'],
      [
        'turn_ended, session ended',
        { until: 'turn_ended' },
        [
          ['feed', WORKING, 0],
          ['feed', FAILED, 10],
        ],
        'met',
      ],
      ['turn_ended, process gone', { until: 'turn_ended' }, [['feed', GONE, 0]], 'ended'],
      // failed
      [
        'failed session',
        { until: 'failed' },
        [
          ['feed', WORKING, 0],
          ['feed', FAILED, 10],
        ],
        'met',
      ],
      ['failed turn', { until: 'failed' }, [['feed', TURN_FAILED, 0]], 'met+already'],
      ['failed, completed instead', { until: 'failed' }, [['feed', COMPLETED, 0]], 'ended'],
      // ended
      [
        'ended',
        { until: 'ended' },
        [
          ['feed', WORKING, 0],
          ['feed', COMPLETED, 10],
        ],
        'met',
      ],
      ['ended, process gone', { until: 'ended' }, [['feed', GONE, 0]], 'ended'],
      [
        'ended, row deleted',
        { until: 'ended' },
        [
          ['feed', WORKING, 0],
          ['feed', 'missing', 10],
        ],
        'ended',
      ],
      // next: the condition must be seen false first
      ['next, still true', { until: 'turn_ended', next: true }, [['feed', TURN_DONE, 0]], 'pending@60000'],
      [
        'next, false then true',
        { until: 'turn_ended', next: true },
        [
          ['feed', TURN_DONE, 0],
          ['feed', WORKING, 10],
          ['feed', TURN_DONE, 20],
        ],
        'met',
      ],
      ['next, over already', { until: 'ended', next: true }, [['feed', COMPLETED, 0]], 'ended'],
      // appear and timeout
      [
        'appears late',
        { until: 'turn_ended' },
        [
          ['feed', 'missing', 0],
          ['feed', TURN_DONE, 29_000],
        ],
        'met+already',
      ],
      ['waiting to appear', { until: 'turn_ended' }, [['feed', 'missing', 0]], 'pending@30000'],
      [
        'never appears',
        { until: 'turn_ended' },
        [
          ['feed', 'missing', 0],
          ['tick', 30_000],
        ],
        'missing',
      ],
      [
        'timeout',
        { until: 'turn_ended' },
        [
          ['feed', WORKING, 0],
          ['tick', 59_999],
          ['tick', 60_000],
        ],
        'timeout',
      ],
      ['timeout 0, no session', { until: 'turn_ended', timeoutMs: 0 }, [['feed', 'missing', 5]], 'missing'],
      ['timeout 0, not met', { until: 'turn_ended', timeoutMs: 0 }, [['feed', WORKING, 5]], 'timeout'],
      ['timeout 0, met', { until: 'needs_you', holdMs: 3000, timeoutMs: 0 }, [['feed', NEEDS_YOU, 5]], 'met+already'],
    ];
    for (const [name, options, actions, expected] of cases) expect(last(run(options, actions)), name).toBe(expected);
  });

  it('TC-EVW-07 meets completed only on the proof of the completion check', () => {
    const cases: [string, Partial<WaitMachineOptions>, Action[], string][] = [
      ['a finished turn is no proof', {}, [['feed', TURN_DONE, 0]], 'pending@60000'],
      ['asks for proof', {}, [['feed', COMPLETED, 0]], 'pending@60000+proof'],
      [
        'proof completed',
        {},
        [
          ['feed', WORKING, 0],
          ['feed', COMPLETED, 10],
          ['proof', 'completed', 11],
        ],
        'met',
      ],
      [
        'already completed',
        {},
        [
          ['feed', ATTEMPT_DONE, 0],
          ['proof', 'completed', 1],
        ],
        'met+already',
      ],
      [
        'proof failed',
        {},
        [
          ['feed', FAILED, 0],
          ['proof', 'failed', 1],
        ],
        'ended',
      ],
      [
        'gone without proof',
        {},
        [
          ['feed', GONE, 0],
          ['proof', 'not_terminal', 1],
        ],
        'ended',
      ],
      [
        'inferred, not proven',
        {},
        [
          ['feed', ATTEMPT_DONE, 0],
          ['proof', 'not_terminal', 1],
        ],
        'pending@60000',
      ],
      [
        'an unasked proof is ignored',
        {},
        [
          ['feed', WORKING, 0],
          ['proof', 'completed', 1],
        ],
        'pending@60000',
      ],
      [
        'timeout 0 waits for the proof',
        { timeoutMs: 0 },
        [
          ['feed', COMPLETED, 5],
          ['proof', 'completed', 9],
        ],
        'met+already',
      ],
      [
        'timeout 0, no proof',
        { timeoutMs: 0 },
        [
          ['feed', ATTEMPT_DONE, 5],
          ['proof', 'not_terminal', 9],
        ],
        'timeout',
      ],
      [
        'next, completed before',
        { next: true },
        [
          ['feed', COMPLETED, 0],
          ['proof', 'completed', 1],
        ],
        'ended',
      ],
    ];
    for (const [name, options, actions, expected] of cases) {
      expect(last(run({ until: 'completed', ...options }, actions)), name).toBe(expected);
    }
  });

  it('keeps its answer once it is done', () => {
    const steps = run({ until: 'ended' }, [
      ['feed', COMPLETED, 0],
      ['feed', WORKING, 1],
      ['tick', 99_999],
      ['proof', 'failed', 2],
    ]);
    expect(new Set(steps.map((step) => last([step])))).toEqual(new Set(['met+already']));
  });
});
