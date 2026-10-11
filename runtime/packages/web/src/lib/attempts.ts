// Attempt state (logic half of legacy modules/panels.js `attemptState`, 04 section 10).
import type { LegacyState } from '@mcs/shared';

import { normalizeState } from './connection-health.ts';

/** The fields of an `AttemptsPanel` row the state is derived from. */
export interface AttemptStateInput {
  state: string | null;
  endedAt: string | null;
  status: string | null;
  exit: number | null;
}

/**
 * The reported state when there is one, else derived like the old page did: an open attempt is RUNNING; a finished PASS
 * is COMPLETED; any other status or a non-zero exit is FAILED; everything else is UNKNOWN.
 */
export function attemptState(r: AttemptStateInput): LegacyState {
  if (r.state !== null && r.state !== '') return normalizeState(r.state);
  if (r.endedAt === null) return 'RUNNING';
  if (r.status === 'PASS') return 'COMPLETED';
  if ((r.status !== null && r.status !== '') || (r.exit !== null && r.exit !== 0)) return 'FAILED';
  return 'UNKNOWN';
}
