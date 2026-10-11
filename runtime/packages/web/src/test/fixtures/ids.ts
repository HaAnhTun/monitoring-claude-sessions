// FIXTURE: invented data for tests
// Deterministic ids and times for fixtures: the same number gives the same id, nothing is random.
import { toIsoTime } from '@mcs/shared';

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** A valid session id (lowercase uuid shape). */
export function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${pad(n, 12)}`;
}

/** A valid agent id; `0` is the main agent. */
export function agentId(n: number): string {
  return n === 0 ? 'main' : `agent-${pad(n, 4)}`;
}

export function toolUseId(n: number): string {
  return `toolu_${pad(n, 6)}`;
}

export function runId(n: number): string {
  return `wf_${pad(n, 6)}`;
}

/** A valid instance id (uuid v4). */
export const FIXTURE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
/** A valid stream epoch. */
export const FIXTURE_EPOCH = '0a1b2c3d';

/** 2026-10-12 12:00:00 UTC, the "now" of every fixture. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 9, 12, 12, 0, 0);

/** The ISO time `offsetSec` seconds after the fixture "now" (negative: before). */
export function iso(offsetSec = 0): string {
  return toIsoTime(FIXTURE_NOW_MS + offsetSec * 1000);
}
