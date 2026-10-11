import { describe, expect, it } from 'vitest';

import { APPLICATION_ID, CHECKPOINT_EVERY_ENTRIES, WAL_RETRY } from './db-constants.ts';

describe('db-constants (03 3.3, registry 2.6)', () => {
  it('APPLICATION_ID is the number 1296253747 (0x4D434333) every design, fixture and probe uses', () => {
    // The designs call it "MCS3" (03 3.3, registry 5.1) but the number reads "MCC3" in ASCII; the NUMBER is the contract (CR-WP-09-2).
    expect(APPLICATION_ID).toBe(1296253747);
    expect(APPLICATION_ID).toBe(0x4d434333);
  });

  it('fits the signed 32-bit range of PRAGMA application_id', () => {
    expect(Number.isInteger(APPLICATION_ID)).toBe(true);
    expect(APPLICATION_ID).toBeGreaterThan(0);
    expect(APPLICATION_ID).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('indexes one transcript checkpoint every 256 display entries', () => {
    expect(CHECKPOINT_EVERY_ENTRIES).toBe(256);
  });

  it('retries a busy WAL switch 20 times, 25 ms apart', () => {
    expect(WAL_RETRY).toEqual({ attempts: 20, delayMs: 25 });
  });

  it('keeps the retry policy frozen at runtime', () => {
    expect(Object.isFrozen(WAL_RETRY)).toBe(true);
  });
});
