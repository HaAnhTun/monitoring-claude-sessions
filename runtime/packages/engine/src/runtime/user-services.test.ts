// The user services seam (06 1.7, amendment A4, ADR 0093): the empty services a task instance and a user instance without a
// terminal host use, and the shutdown decision the server takes on the control channel. The census here is a scripted
// stand-in with the contract of the terminal service: `count()` is starting plus live plus lost sessions, `sessions()` lists
// only what a person can see, so the two differ exactly where the guard must not look at the list.
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  EMPTY_CENSUS,
  EMPTY_USER_SERVICES,
  decideShutdown,
  type ShutdownDecisionInput,
  type TerminalCensus,
  type TerminalCensusEntry,
  type UserServices,
} from './user-services.ts';

type SessionState = 'starting' | 'live' | 'lost' | 'ended';

interface ScriptedSession {
  readonly name: string;
  readonly startedAt: string;
  readonly state: SessionState;
}

interface ScriptedCensus extends TerminalCensus {
  readonly count: Mock<() => number>;
  readonly sessions: Mock<(limit: number) => readonly TerminalCensusEntry[]>;
  readonly beginDrain: Mock<() => void>;
}

function session(name: string, state: SessionState): ScriptedSession {
  return { name, startedAt: '2026-11-15T10:00:00.000Z', state };
}

/** What the terminal service reports: `count` includes the sessions that are starting and lost, `sessions` only the live ones. */
function censusOf(book: readonly ScriptedSession[]): ScriptedCensus {
  return {
    count: vi.fn(() => book.filter((s) => s.state !== 'ended').length),
    sessions: vi.fn((limit: number) =>
      book
        .filter((s) => s.state === 'live')
        .slice(0, limit)
        .map(({ name, startedAt }) => ({ name, startedAt })),
    ),
    beginDrain: vi.fn(() => undefined),
  };
}

function input(census: TerminalCensus, over: Partial<ShutdownDecisionInput> = {}): ShutdownDecisionInput {
  return { kind: 'user', reason: 'stop', force: false, stopping: false, census, ...over };
}

describe('EMPTY_CENSUS and EMPTY_USER_SERVICES', () => {
  it('count nothing, list nothing and accept beginDrain', () => {
    expect(EMPTY_CENSUS.count()).toBe(0);
    expect(EMPTY_CENSUS.sessions(50)).toEqual([]);
    expect(() => {
      EMPTY_CENSUS.beginDrain();
      EMPTY_CENSUS.beginDrain();
    }).not.toThrow();
  });

  it('have no access minter, no terminal host, no folder service and no components, and cannot be changed by a caller', () => {
    expect(EMPTY_USER_SERVICES.census).toBe(EMPTY_CENSUS);
    expect(EMPTY_USER_SERVICES.access).toBeNull();
    expect(EMPTY_USER_SERVICES.accessService).toBeNull();
    expect(EMPTY_USER_SERVICES.terminal).toBeNull();
    expect(EMPTY_USER_SERVICES.folders).toBeNull();
    expect(EMPTY_USER_SERVICES.components).toEqual([]);
    expect(Object.isFrozen(EMPTY_USER_SERVICES)).toBe(true);
    expect(Object.isFrozen(EMPTY_USER_SERVICES.components)).toBe(true);
    expect(Object.isFrozen(EMPTY_CENSUS)).toBe(true);
  });
});

describe('UserServices: the members the terminal and the folder list add', () => {
  it('may be built by hand without them (the lifecycle tests do): a reader treats a missing member as null', () => {
    const byHand: UserServices = { census: EMPTY_CENSUS, access: null, components: [] };
    expect(byHand.terminal ?? null).toBeNull();
    expect(byHand.folders ?? null).toBeNull();
    expect(byHand.accessService ?? null).toBeNull();
  });

  it('holds the terminal host, the folder service and the whole access service when the real services are built', () => {
    const real: UserServices = {
      ...EMPTY_USER_SERVICES,
      terminal: {
        capabilities: () => ({
          available: false,
          reason: 'unsupported_os',
          folderPicker: false,
          resume: false,
          maxSessions: 0,
        }),
        sessions: {
          list: () => [],
          get: () => null,
          create: () => Promise.reject(new Error('none')),
          kill: () => Promise.resolve(false),
          subscribe: () => () => undefined,
        },
        picker: null,
        resume: () => Promise.reject(new Error('none')),
        openNative: () => Promise.reject(new Error('none')),
        census: EMPTY_CENSUS,
        close: () => undefined,
      },
    };
    expect(real.terminal?.capabilities().available).toBe(false);
  });
});

describe('decideShutdown: the census counts starting, live and lost sessions (A4)', () => {
  it('refuses while a live session exists, naming how many, and never starts the drain', () => {
    const census = censusOf([session('api-1', 'live'), session('web-1', 'live')]);
    expect(decideShutdown(input(census))).toEqual({ allow: false, live: 2 });
    expect(census.beginDrain).not.toHaveBeenCalled();
  });

  it('refuses for a session that is still starting although the list does not show it yet', () => {
    const census = censusOf([session('api-1', 'starting')]);
    expect(census.sessions(50)).toEqual([]);
    expect(decideShutdown(input(census))).toEqual({ allow: false, live: 1 });
    expect(census.beginDrain).not.toHaveBeenCalled();
  });

  it('refuses for a lost session (its process may still run) although the list does not show it', () => {
    const census = censusOf([session('api-1', 'lost')]);
    expect(census.sessions(50)).toEqual([]);
    expect(decideShutdown(input(census))).toEqual({ allow: false, live: 1 });
  });

  it('counts the three states together and ignores an ended session', () => {
    const census = censusOf([
      session('a-1', 'starting'),
      session('b-1', 'live'),
      session('c-1', 'lost'),
      session('d-1', 'ended'),
    ]);
    expect(decideShutdown(input(census))).toEqual({ allow: false, live: 3 });
  });

  it('allows when every session has ended, and starts the drain once', () => {
    const census = censusOf([session('api-1', 'ended')]);
    expect(decideShutdown(input(census))).toEqual({ allow: true, drained: true });
    expect(census.beginDrain).toHaveBeenCalledTimes(1);
  });

  it('allows an empty census for every reason, and starts the drain each time', () => {
    for (const reason of ['stop', 'restart', 'upgrade', 'signal'] as const) {
      const census = censusOf([]);
      expect(decideShutdown(input(census, { reason })), reason).toEqual({ allow: true, drained: true });
      expect(census.beginDrain, reason).toHaveBeenCalledTimes(1);
    }
  });
});

describe('decideShutdown: what is never guarded', () => {
  it('allows every reason with force, over live sessions, and starts the drain once', () => {
    for (const reason of ['stop', 'restart', 'upgrade', 'signal'] as const) {
      const census = censusOf([session('api-1', 'live')]);
      expect(decideShutdown(input(census, { reason, force: true })), reason).toEqual({ allow: true, drained: true });
      expect(census.beginDrain, reason).toHaveBeenCalledTimes(1);
    }
  });

  it('never guards the reason signal (logoff, Ctrl+C, SIGTERM), with or without force, and does not even count', () => {
    for (const force of [false, true]) {
      const census = censusOf([session('api-1', 'live'), session('web-1', 'starting')]);
      expect(decideShutdown(input(census, { reason: 'signal', force })), String(force)).toEqual({
        allow: true,
        drained: true,
      });
      expect(census.count).not.toHaveBeenCalled();
      expect(census.beginDrain).toHaveBeenCalledTimes(1);
    }
  });

  it('never guards a task instance, which has no terminal to protect, and does not count', () => {
    const census = censusOf([session('api-1', 'live')]);
    expect(decideShutdown(input(census, { kind: 'task' }))).toEqual({ allow: true, drained: true });
    expect(census.count).not.toHaveBeenCalled();
  });

  it('allows a request that arrives while the instance is already stopping, without a second drain', () => {
    const census = censusOf([session('api-1', 'live')]);
    expect(decideShutdown(input(census, { stopping: true }))).toEqual({ allow: true, drained: true });
    expect(census.count).not.toHaveBeenCalled();
    expect(census.beginDrain).not.toHaveBeenCalled();
  });
});

describe('decideShutdown: the drain', () => {
  it('starts the drain before it answers (the same tick: no session can start between the count and the stop)', () => {
    const order: string[] = [];
    const census: TerminalCensus = {
      count: () => {
        order.push('count');
        return 0;
      },
      sessions: () => [],
      beginDrain: () => {
        order.push('beginDrain');
      },
    };
    const decision = decideShutdown(input(census));
    order.push('answered');
    expect(decision.allow).toBe(true);
    expect(order).toEqual(['count', 'beginDrain', 'answered']);
  });

  it('still allows the shutdown when the census cannot start its drain, and says so', () => {
    const census = censusOf([]);
    census.beginDrain.mockImplementation(() => {
      throw new Error('a message with a secret-looking value');
    });
    const decision = decideShutdown(input(census));
    expect(decision).toEqual({ allow: true, drained: false });
    expect(JSON.stringify(decision)).not.toContain('secret-looking');
  });

  it('fails closed on a count that is not a number: only exactly zero is "no terminals"', () => {
    const census = censusOf([]);
    census.count.mockReturnValue(Number.NaN);
    expect(decideShutdown(input(census))).toMatchObject({ allow: false });
    expect(census.beginDrain).not.toHaveBeenCalled();
    census.count.mockReturnValue(0);
    expect(decideShutdown(input(census))).toEqual({ allow: true, drained: true });
  });
});
