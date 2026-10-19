// The exit codes of the server process (01 4.1, registry 7.3): the table exists once, here. The server boot, the lifecycle
// commands of the engine and the CLI read their names from it.
import { describe, expect, it } from 'vitest';

import { SERVER_EXIT_CODES, serverExitNameOf, type ServerExitName } from './server-exit.ts';

describe('server exit codes (01 4.1, registry 7.3)', () => {
  it('has exactly the documented table', () => {
    expect(SERVER_EXIT_CODES).toEqual({
      OK: 0,
      CONFIG_INVALID: 10,
      IDENTITY_MISMATCH: 11,
      INSTANCE_LOCKED: 12,
      PORT_EXHAUSTED: 13,
      DB_ERROR: 14,
      DB_NEWER_THAN_RUNTIME: 15,
      DB_UPGRADE_REQUIRED: 16,
      WORKSPACE_INVALID: 17,
      BUILD_INVALID: 18,
      INTERNAL: 70,
    });
  });

  it('never uses 1, which is what Windows reports for a forced termination', () => {
    expect(Object.values(SERVER_EXIT_CODES)).not.toContain(1);
  });

  it('gives every exit code its name, and no two names share a number', () => {
    const entries = Object.entries(SERVER_EXIT_CODES);
    for (const [name, code] of entries) expect(serverExitNameOf(code), name).toBe(name);
    expect(new Set(entries.map(([, code]) => code)).size).toBe(entries.length);
  });

  it('answers null for a number that is not one of ours', () => {
    for (const code of [1, 2, 9, 19, 69, 71, 99, 137, 255, -1, 12.5, Number.NaN]) {
      expect(serverExitNameOf(code), String(code)).toBeNull();
    }
  });

  it('keeps the name type in step with the table', () => {
    const name: ServerExitName = 'PORT_EXHAUSTED';
    expect(SERVER_EXIT_CODES[name]).toBe(13);
  });
});
