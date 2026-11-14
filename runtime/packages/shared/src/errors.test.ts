// The CLI error catalogue (errors.ts): the code a person sees when another command holds the task (WP-101).
import { describe, expect, it } from 'vitest';

import { CLI_ERROR_CODES, CliErrorCodeSchema, McsError, cliExitCode, isCliErrorCode } from './errors.ts';

describe('WORKSPACE_BUSY', () => {
  it('is in the catalogue and exits 1, not the usage code 2', () => {
    expect(CLI_ERROR_CODES).toContain('WORKSPACE_BUSY');
    expect(isCliErrorCode('WORKSPACE_BUSY')).toBe(true);
    expect(CliErrorCodeSchema.safeParse('WORKSPACE_BUSY').success).toBe(true);
    expect(cliExitCode('WORKSPACE_BUSY')).toBe(1);
  });

  it('can be raised with a hint and the mutex details', () => {
    const e = new McsError('WORKSPACE_BUSY', 'busy', {
      hint: 'try again',
      details: { reason: 'MUTEX_TIMEOUT', name: 'mcs-task-x', waitedMs: 50 },
    });
    expect(e.code).toBe('WORKSPACE_BUSY');
    expect(e.details).toEqual({ reason: 'MUTEX_TIMEOUT', name: 'mcs-task-x', waitedMs: 50 });
  });
});

describe('the launcher leftovers (ADR 0062 item 4)', () => {
  it('no longer lists the codes of the V3 bootstrap and runtime guard', () => {
    const codes: readonly string[] = CLI_ERROR_CODES;
    const removed = [
      ['BOOTSTRAP', 'FAILED'],
      ['RUNTIME', 'IN', 'USE'],
    ].map((parts) => parts.join('_'));
    for (const code of removed) {
      expect(codes, code).not.toContain(code);
      expect(isCliErrorCode(code), code).toBe(false);
    }
    expect(codes).toContain('NODE_TOO_OLD');
  });

  it('gives every remaining code an exit number, and an unknown code the internal-error exit', () => {
    for (const code of CLI_ERROR_CODES) expect([1, 2, 3], code).toContain(cliExitCode(code));
    expect(cliExitCode('USAGE')).toBe(2);
    expect(cliExitCode('NOT_A_CODE' as never)).toBe(1);
  });
});

describe('the user instance codes (06 1.8, 2.7)', () => {
  it('lists TERMINALS_LIVE and UNSUPPORTED_PLATFORM in the catalogue', () => {
    for (const code of ['TERMINALS_LIVE', 'UNSUPPORTED_PLATFORM']) {
      expect(CLI_ERROR_CODES, code).toContain(code);
      expect(isCliErrorCode(code), code).toBe(true);
      expect(CliErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('exits 3 for TERMINALS_LIVE and nothing else, so a script can tell "refused, terminals are live"', () => {
    expect(cliExitCode('TERMINALS_LIVE')).toBe(3);
    expect(CLI_ERROR_CODES.filter((code) => cliExitCode(code) === 3)).toEqual(['TERMINALS_LIVE']);
  });

  it('exits 1 for UNSUPPORTED_PLATFORM, 2 for USAGE', () => {
    expect(cliExitCode('UNSUPPORTED_PLATFORM')).toBe(1);
    expect(cliExitCode('USAGE')).toBe(2);
  });

  it('can be raised as an McsError', () => {
    const e = new McsError('TERMINALS_LIVE', 'terminals are open', { details: { live: 2 } });
    expect(e.code).toBe('TERMINALS_LIVE');
    expect(e.details).toEqual({ live: 2 });
  });
});
