// Database constants shared by the engine and the tests (03 3.3, registry 2.6). Pure: no I/O, no Node built-ins.
// `MAX_LINE_BYTES` is deliberately not here: its single home is `protocol/limits.ts` (I-32).

/**
 * `PRAGMA application_id` of every monitor database. The designs call it "MCS3", but 0x4D434333 spells "MCC3" in ASCII:
 * the number is the contract (every design, probe and fixture uses it; CR-WP-09-2).
 */
export const APPLICATION_ID = 1296253747;

/** The sparse entry index of a transcript file keeps one checkpoint about every 256 display entries (03 7.2). */
export const CHECKPOINT_EVERY_ENTRIES = 256;

/** `PRAGMA journal_mode = WAL` on a file that several processes open at once can answer SQLITE_BUSY: retry (03 3.2 step 3). */
export const WAL_RETRY: Readonly<{ attempts: number; delayMs: number }> = Object.freeze({ attempts: 20, delayMs: 25 });
