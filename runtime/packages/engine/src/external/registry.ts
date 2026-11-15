// The Claude registry reader (02 7.10): `<claudeHome>/sessions/<pid>.json`, one small file per live Claude Code process.
// Only names of the form `<pid>.json` are ever opened (the folder also holds `.key` files that must never be read), each file is
// at most 64 KiB, and an entry counts only when its session id is one this instance knows. The pid is checked for liveness with
// `pidAlive` (06 4.2). An unchanged value is announced again every 60 s so that the registry evidence stays fresh.
//
// Two more readers sit on the same folder for the user instance (CAW design 03 2.2, 5.4). `listRegistryEntries` returns every
// entry with a loose schema, whatever session it names and whatever its status is, for the link between a terminal and its
// session and for the resume check; `createRegistrySnapshot` shares one read of it for a second. The strict event reader above
// stays as it was, and gets one option: `onUnknownSession` names a live process whose session this instance has not seen yet,
// so that the importer looks for that session at once instead of at the next sweep. The registry `name` field (it can carry
// text of a prompt) and `procStart` (a format nobody has verified) are never read.
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
/** A registry `cwd` is clipped to this many code points. */
export const REGISTRY_CWD_MAX_CHARS = 1024;
/** The hint for one unknown session is given again after this long. */
export const REGISTRY_HINT_REPEAT_MS = 30_000;
/** One read of the registry folder is shared for this long by `createRegistrySnapshot`. */
export const REGISTRY_SNAPSHOT_MEMO_MS = 1000;
const ENTRYPOINT_MAX_CHARS = 64;
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
  /**
   * Called for an entry whose process lives and whose session this instance does not know, with the session id and the
   * working folder of the entry (null when it has none). The same id is named again after `REGISTRY_HINT_REPEAT_MS`. A callback
   * that throws is ignored: the poll goes on.
   */
  readonly onUnknownSession?: (sessionUid: string, cwd: string | null) => void;
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

// ---- the loose reading of one file -----------------------------------------------------------------------------------------------

/** One entry of the registry as the link and the resume check read it (CAW design 03 5.4). */
export interface RegistryEntry {
  readonly pid: number;
  readonly sessionId: string;
  /** Null for a value this version does not know: a new status never hides the entry. */
  readonly status: 'busy' | 'idle' | 'waiting' | null;
  readonly waitingFor: string | null;
  readonly cwd: string | null;
  /** Epoch milliseconds, null when the file has none or says it otherwise. */
  readonly startedAtMs: number | null;
  readonly updatedAtMs: number | null;
  readonly kind: 'interactive' | 'bg' | null;
  readonly entrypoint: string | null;
  readonly alive: boolean;
}

type LooseFields = Omit<RegistryEntry, 'alive'>;

function plain(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' ? clipCodePoints(value, max) : null;
}

function epochMsOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The fields of a registry file that the link needs, or null when it has no usable pid and session id. Nothing else of the file
 * is read: not `name`, not `procStart`.
 */
function looseFieldsOf(value: unknown): LooseFields | null {
  if (!plain(value)) return null;
  const { pid, sessionId, status, kind } = value;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || !SID_RE.test(sessionId)) return null;
  return {
    pid,
    sessionId,
    status: status === 'busy' || status === 'idle' || status === 'waiting' ? status : null,
    waitingFor: textOf(value['waitingFor'], WAITING_FOR_MAX_CHARS),
    cwd: textOf(value['cwd'], REGISTRY_CWD_MAX_CHARS),
    startedAtMs: epochMsOf(value['startedAt']),
    updatedAtMs: epochMsOf(value['updatedAt']),
    kind: kind === 'interactive' || kind === 'bg' ? kind : null,
    entrypoint: textOf(value['entrypoint'], ENTRYPOINT_MAX_CHARS),
  };
}

function parseJson(bytes: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return value;
  } catch {
    return undefined;
  }
}

/** The names of the registry folder that may be opened, sorted. */
async function registryNames(dir: string, fs: ExternalFs): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => REGISTRY_FILE_RE.test(name)).slice(0, MAX_ENTRIES);
}

export interface RegistryListOptions {
  readonly claudeHome: string;
  readonly pidAlive: (pid: number) => boolean;
  readonly fs?: ExternalFs;
}

export interface RegistryListing {
  readonly entries: readonly RegistryEntry[];
  /** Files that could not be read or have no usable pid and session id. */
  readonly readFailures: number;
}

/**
 * Every entry of the registry (CAW design 03 5.4): the loose reading, no filter on the session. A file that cannot be read, is
 * damaged, or lacks a usable pid or session id counts in `readFailures` and is left out. Sorted by pid.
 */
export async function listRegistryEntries(options: RegistryListOptions): Promise<RegistryListing> {
  const fs = options.fs ?? nodeExternalFs;
  const dir = path.join(options.claudeHome, 'sessions');
  const entries: RegistryEntry[] = [];
  let readFailures = 0;
  for (const name of await registryNames(dir, fs)) {
    const bytes = await fs.readSmall(path.join(dir, name), REGISTRY_FILE_MAX_BYTES);
    const fields = bytes === null ? null : looseFieldsOf(parseJson(bytes));
    if (fields === null) {
      readFailures += 1;
      continue;
    }
    if (!isValidPid(fields.pid)) continue;
    entries.push({ ...fields, alive: options.pidAlive(fields.pid) });
  }
  entries.sort((a, b) => a.pid - b.pid);
  return { entries, readFailures };
}

export interface RegistrySnapshotOptions extends RegistryListOptions {
  readonly now: () => number;
  /** How long a read is shared; production `REGISTRY_SNAPSHOT_MEMO_MS`. */
  readonly memoMs?: number;
}

export interface RegistrySnapshot {
  /** The entries of the registry: one read of the folder is shared by every caller of the same second. */
  read(): Promise<RegistryListing>;
}

/** `listRegistryEntries` memoised: the link, the resume check and the lifecycle poller do not each read the folder. */
export function createRegistrySnapshot(options: RegistrySnapshotOptions): RegistrySnapshot {
  const memoMs = options.memoMs ?? REGISTRY_SNAPSHOT_MEMO_MS;
  let memo: { readonly at: number; readonly listing: Promise<RegistryListing> } | null = null;
  return {
    read() {
      const at = options.now();
      if (memo !== null && at - memo.at < memoMs) return memo.listing;
      const listing = listRegistryEntries(options);
      const mine = { at, listing };
      memo = mine;
      // a read that failed is forgotten, so that the next caller reads again
      listing.catch(() => {
        if (memo === mine) memo = null;
      });
      return listing;
    },
  };
}

// ---- the strict reader of the known sessions -------------------------------------------------------------------------------------

/** One file of the registry as an event, or null when it is not for this instance; `failed` when it cannot be used. */
function readEntry(
  value: unknown,
  options: RegistryReaderOptions,
  now: number,
): { candidate: Candidate | null } | { failed: true } {
  const result = RegistryFileSchema.safeParse(value);
  if (!result.success) return { failed: true };
  const parsed = result.data;
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
  /** The sessions that were named to `onUnknownSession`, and when. */
  const hinted = new Map<string, number>();

  /** The hint of one file: a live process of a session this instance does not know is named, once per 30 s. */
  function hintOf(value: unknown, now: number): void {
    const callback = options.onUnknownSession;
    if (callback === undefined) return;
    const fields = looseFieldsOf(value);
    if (fields === null || !isValidPid(fields.pid) || options.isKnownSession(fields.sessionId)) return;
    const before = hinted.get(fields.sessionId);
    if (before !== undefined && now - before < REGISTRY_HINT_REPEAT_MS) return;
    if (!options.pidAlive(fields.pid)) return;
    hinted.set(fields.sessionId, now);
    try {
      callback(fields.sessionId, fields.cwd);
    } catch {
      // a hint is only a hint: whatever the callback does, the registry poll goes on
    }
  }

  return {
    async poll() {
      const now = options.now();
      const names = await registryNames(dir, fs);
      const found = new Map<string, Candidate>();
      let readFailures = 0;
      for (const name of names.sort()) {
        const bytes = await fs.readSmall(path.join(dir, name), REGISTRY_FILE_MAX_BYTES);
        if (bytes === null) {
          readFailures += 1;
          continue;
        }
        const value = parseJson(bytes);
        hintOf(value, now);
        const entry = readEntry(value, options, now);
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
      for (const [sessionId, at] of hinted) {
        if (now - at >= REGISTRY_HINT_REPEAT_MS) hinted.delete(sessionId);
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
