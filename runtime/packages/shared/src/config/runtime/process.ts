// `process` section: timeouts of the server process (01 section 1.6). They live here and not in `lifecycle`, which holds
// the session-state thresholds of design 02.
import { intKey, sectionSchema } from './section.ts';

export const ProcessSectionKeys = {
  /** `start` health wait (01 4.7; legacy waited 12 s). */
  startTimeoutMs: intKey(1000, 300_000, 20_000),
  /** `stop` wait for process exit (01 4.9). */
  stopTimeoutMs: intKey(1000, 300_000, 10_000),
  /** The server re-checks `state.json` (01 4.6). */
  stateWatchdogMs: intKey(1000, 600_000, 15_000),
};

export const ProcessSectionSchema = sectionSchema(ProcessSectionKeys);
