// The Claude registry reader (02 7.10): `<claudeHome>/sessions/<pid>.json`, one small file per live Claude Code process.
// Only names of the form `<pid>.json` are ever opened (the folder also holds `.key` files that must never be read), each file is
// at most 64 KiB, and an entry counts only when its session id is one this instance knows. The pid is checked for liveness with
// `pidAlive` (06 4.2). An unchanged value is announced again every 60 s so that the registry evidence stays fresh.
import path from 'node:path';

import { SID_RE } from '@mcs/shared/protocol';
import { z } from 'zod';

import type { LogicalEvent } from '../ingest/event-row.ts';
import { clipCodePoints } from '../platform/fsx.ts';
import { isValidPid } from '../platform/process.ts';
import { nodeExternalFs, type ExternalFs, type ExternalPoll } from './fs.ts';

export type RegistryEvent = Extract<LogicalEvent, { k: 'external.registry' }>;

export const REGISTRY_FILE_MAX_BYTES = 64 * 1024;
/** An unchanged observation is announced again after this long. */
export const REGISTRY_REPEAT_MS = 60_000;
/** `waitingFor` is shown clipped to this many code points. */
export const WAITING_FOR_MAX_CHARS = 64;
const MAX_ENTRIES = 1000;
const REGISTRY_FILE_RE = /^[1-9][0-9]{0,9}\.json$/;

const RegistryFileSchema = z.looseObject({
  pid: z.number().int().positive(),
  sessionId: z.string().regex(SID_RE),
  status: z.enum(['busy', 'idle', 'waiting']),
  waitingFor: z.string().optional(),
});

export interface RegistryReaderOptions {
  /** `ctx.claudeHome` */
  readonly claudeHome: string;
  readonly now: () => number;
  /** True when this instance has a session with that id: an entry of another project's session is ignored. */
  readonly isKnownSession: (sessionUid: string) => boolean;
  readonly pidAlive: (pid: number) => boolean;
  readonly fs?: ExternalFs;
  readonly repeatMs?: number;
}

export interface RegistryReader {
  poll(): Promise<ExternalPoll<RegistryEvent>>;
}

interface Seen {
  readonly key: string;
  readonly at: number;
}

interface Candidate {
  readonly event: RegistryEvent;
  readonly key: string;
}

/** One file of the registry as an event, or null when it is not for this instance; `failed` when it cannot be used. */
function readEntry(
  bytes: Buffer,
  options: RegistryReaderOptions,
  now: number,
): { candidate: Candidate | null } | { failed: true } {
  let parsed: z.infer<typeof RegistryFileSchema>;
  try {
    const result = RegistryFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!result.success) return { failed: true };
    parsed = result.data;
  } catch {
    return { failed: true };
  }
  if (!isValidPid(parsed.pid) || !options.isKnownSession(parsed.sessionId)) return { candidate: null };
  const alive = options.pidAlive(parsed.pid);
  const waitingFor =
    parsed.waitingFor === undefined || parsed.waitingFor === ''
      ? undefined
      : clipCodePoints(parsed.waitingFor, WAITING_FOR_MAX_CHARS);
  const event: RegistryEvent = {
    k: 'external.registry',
    sessionId: parsed.sessionId,
    status: parsed.status,
    ...(waitingFor === undefined ? {} : { waitingFor }),
    pid: parsed.pid,
    pidAlive: alive,
    observedAt: now,
  };
  return { candidate: { event, key: `${parsed.status}|${waitingFor ?? ''}|${String(parsed.pid)}|${String(alive)}` } };
}

export function createRegistryReader(options: RegistryReaderOptions): RegistryReader {
  const fs = options.fs ?? nodeExternalFs;
  const repeatMs = options.repeatMs ?? REGISTRY_REPEAT_MS;
  const dir = path.join(options.claudeHome, 'sessions');
  const last = new Map<string, Seen>();

  return {
    async poll() {
      const now = options.now();
      const names = (await fs.readdir(dir)).filter((name) => REGISTRY_FILE_RE.test(name)).slice(0, MAX_ENTRIES);
      const found = new Map<string, Candidate>();
      let readFailures = 0;
      for (const name of names.sort()) {
        const bytes = await fs.readSmall(path.join(dir, name), REGISTRY_FILE_MAX_BYTES);
        if (bytes === null) {
          readFailures += 1;
          continue;
        }
        const entry = readEntry(bytes, options, now);
        if ('failed' in entry) {
          readFailures += 1;
          continue;
        }
        const { candidate } = entry;
        if (candidate === null) continue;
        const other = found.get(candidate.event.sessionId);
        // two files for one session (a restarted process): the live one wins
        const keep = other !== undefined && (other.event.pidAlive || !candidate.event.pidAlive);
        if (!keep) found.set(candidate.event.sessionId, candidate);
      }
      const events: RegistryEvent[] = [];
      const taken = new Map<string, Seen>();
      for (const [sessionId, { event, key }] of found) {
        const before = last.get(sessionId);
        if (before?.key === key && now - before.at < repeatMs) {
          taken.set(sessionId, before);
        } else {
          events.push(event);
          taken.set(sessionId, { key, at: now });
        }
      }
      return {
        events,
        readFailures,
        commit: () => {
          last.clear();
          for (const [sessionId, seen] of taken) last.set(sessionId, seen);
        },
      };
    },
  };
}
