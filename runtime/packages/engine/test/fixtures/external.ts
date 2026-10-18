// External evidence fixtures (02 9.1): the registry files of `<claudeHome>/sessions/`, the daemon job files of
// `<claudeHome>/jobs/<id>/state.json` and a `.key` decoy that nothing may ever open. Placeholder values only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CANARY } from '@mcs/testkit';

export type RegistryStatus = 'busy' | 'idle' | 'waiting';

export interface RegistryEntryOptions {
  readonly pid: number;
  readonly sessionId: string;
  readonly status?: RegistryStatus;
  readonly waitingFor?: string;
  /** `kind` of the entry (`interactive` or `bg`). */
  readonly kind?: 'interactive' | 'bg';
  readonly updatedAt?: number;
}

/** One registry entry with the keys the survey saw (`pid, sessionId, cwd, startedAt, kind, status, updatedAt`). */
export function registryEntry(o: RegistryEntryOptions): Record<string, unknown> {
  return {
    pid: o.pid,
    sessionId: o.sessionId,
    cwd: 'FIXTURE/project',
    startedAt: 1_790_000_000_000,
    version: '0.0.0-fixture',
    kind: o.kind ?? 'interactive',
    entrypoint: 'cli',
    status: o.status ?? 'idle',
    statusUpdatedAt: o.updatedAt ?? 1_790_000_000_000,
    updatedAt: o.updatedAt ?? 1_790_000_000_000,
    ...(o.waitingFor === undefined ? {} : { waitingFor: o.waitingFor }),
  };
}

export interface WriteRegistryOptions {
  /** Also write `<pid>.key` next to every entry, holding the canary: it must never be read. */
  readonly keyDecoys?: boolean;
}

/** Writes `<claudeHome>/sessions/<pid>.json` for every entry (the pid is the file name). Returns the folder. */
export function writeRegistry(
  claudeHome: string,
  entries: readonly Record<string, unknown>[],
  options: WriteRegistryOptions = {},
): string {
  const dir = path.join(claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const pid = entry['pid'];
    if (typeof pid !== 'number') throw new RangeError('writeRegistry: every entry needs a numeric pid');
    writeFileSync(path.join(dir, `${String(pid)}.json`), JSON.stringify(entry));
    if (options.keyDecoys === true) writeFileSync(path.join(dir, `${String(pid)}.key`), CANARY.key);
  }
  return dir;
}

export interface JobStateOptions {
  readonly state: 'working' | 'done' | 'failed';
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
  /** `createdAt` in epoch ms (default `JOB_FIXTURE_TIME`). */
  readonly createdAt?: number;
  /** `updatedAt` in epoch ms (default `createdAt`). */
  readonly updatedAt?: number;
  /** `firstTerminalAt` and `lastTerminalAt` of a `done` or `failed` job in epoch ms (default `updatedAt`). */
  readonly terminalAt?: number;
  /** Write the times as epoch milliseconds instead of ISO-8601 text (the shape of the V3 fixture). */
  readonly epochMs?: boolean;
}

/** The default time of a fixture job file (epoch ms). */
export const JOB_FIXTURE_TIME = 1_790_000_000_000;

/**
 * The `state.json` of a daemon job in the shape of the real files (`state, backend, sessionId, resumeSessionId, createdAt,
 * updatedAt`, and `firstTerminalAt`/`lastTerminalAt` once the job ended), times as ISO-8601 UTC text with milliseconds.
 */
export function jobState(o: JobStateOptions): Record<string, unknown> {
  const createdAt = o.createdAt ?? JOB_FIXTURE_TIME;
  const updatedAt = o.updatedAt ?? createdAt;
  const terminalAt = o.terminalAt ?? updatedAt;
  const time = (ms: number): string | number => (o.epochMs === true ? ms : new Date(ms).toISOString());
  return {
    state: o.state,
    backend: 'daemon',
    tempo: 'fixture',
    ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }),
    ...(o.resumeSessionId === undefined ? {} : { resumeSessionId: o.resumeSessionId }),
    cwd: 'FIXTURE/project',
    createdAt: time(createdAt),
    updatedAt: time(updatedAt),
    ...(o.state === 'working' ? {} : { firstTerminalAt: time(terminalAt), lastTerminalAt: time(terminalAt) }),
  };
}

/** Writes `<claudeHome>/jobs/<jobId>/state.json`, plus a few unrelated temp files of the job that nothing may read. */
export function writeJob(claudeHome: string, jobId: string, state: Record<string, unknown>): string {
  const dir = path.join(claudeHome, 'jobs', jobId);
  mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(path.join(dir, 'tmp', 'work-1.txt'), 'FIXTURE temp file of a job');
  return dir;
}
