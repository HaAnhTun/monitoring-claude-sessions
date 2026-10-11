// The Claude Code pid evidence (02 7.10, E7, ADR 0019): the sweeper probes the pid of a session whose view is due. A dead
// process is trusted (high confidence), a live one is only medium evidence (pids are reused), which the lifecycle model
// decides; this module only reports what the probe saw.
import type { LogicalEvent } from '../ingest/event-row.ts';
import { isValidPid } from '../platform/process.ts';

export type PidEvent = Extract<LogicalEvent, { k: 'external.pid' }>;

export interface PidTarget {
  readonly sessionUid: string;
  readonly pid: number;
}

/**
 * One `external.pid` event per target whose pid is a valid process id. A target with an invalid pid is skipped: nothing is
 * probed, no operating system call is made for it. `alive` is `pidAlive` of 06 4.2 (signal 0, EPERM counts as alive).
 */
export function pidEvents(targets: readonly PidTarget[], now: number, alive: (pid: number) => boolean): PidEvent[] {
  const events: PidEvent[] = [];
  for (const target of targets) {
    if (!isValidPid(target.pid)) continue;
    events.push({
      k: 'external.pid',
      sessionId: target.sessionUid,
      pid: target.pid,
      alive: alive(target.pid),
      checkedAt: now,
    });
  }
  return events;
}
