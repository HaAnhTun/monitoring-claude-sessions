// The one logger of the runtime (05 5.3 S-LOG-1, S-LOG-2, S-LOG-6). JSON lines, four levels, a closed list of fields
// and a closed shape for values: nothing a caller passes can put a prompt, a search text, a token or the message of a
// parse error into the log, because only allow-listed names with short plain values get through (`droppedFields`
// counts what did not). Calls return at once; one async writer appends in call order and rotates `runtime.log` into
// `runtime.log.1` .. `.5` (10 MiB each) with the retry schedule of ADR 0058. The logger never throws into a caller.
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { isoMsZ, type Clock } from '@mcs/shared';

import { retryBusy } from '../platform/fsx.ts';

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const LOG_KEEP = 5; // runtime.log.1 .. runtime.log.5
export const LOG_ROTATE_RETRY_BUDGET_MS = 3000; // ADR 0058 budget, counted over one whole rotation
/** Lines that may wait for the writer; further lines are refused and counted in `stats.writeFailures`. */
export const LOG_MAX_QUEUED_LINES = 10_000;
/** After a rotation that ran out of budget the next attempt waits this long (by the logger clock). */
const ROTATION_PAUSE_MS = 60_000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The closed field list of S-LOG-1. `event` is the first argument of every call. */
export const LOG_FIELD_NAMES = [
  'event',
  'instanceId',
  'sessionId',
  'agentId',
  'code',
  'count',
  'durationMs',
  'bytes',
  'offset',
  'port',
  'pid',
  'status',
  'method',
  'route',
  'version',
  'schemaVersion',
  'phase',
  /** The request id of an HTTP request (`r-` and 12 base36 characters; 03 5.1). */
  'requestId',
  /** The kind of a spawned child process (`ChildKind`; 06 3.6 rule 9). */
  'kind',
] as const;

/** What a caller may pass: anything. The logger keeps the allow-listed names whose values are safe. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  /** `<workspace>/logs/runtime.log` for the server; null = stderr sink only (CLI). */
  file: string | null;
  /** runtime.json `logLevel`, env `MCS_LOG_LEVEL`, CLI `--log-level` (01 1.6). */
  level: LogLevel;
  /** True only in the process that holds the instance lock (the server, 01 INV-03). */
  rotate: boolean;
  clock: Clock;
  /** Tests only; default `LOG_ROTATE_BYTES`. */
  rotateBytes?: number;
}

export interface LoggerStats {
  droppedFields: number;
  rotations: number;
  rotateFailures: number;
  writeFailures: number;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  readonly stats: Readonly<LoggerStats>;
  /** Flushes the queue and closes the file. Calls made after it are ignored. */
  close(): Promise<void>;
}

// ---- file system seam (tests pass an in-memory one; the real one is below) --------------------------------------------

export interface LogFile {
  /** Size in bytes when the file was opened (fstat). */
  readonly size: number;
  append(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface LoggerDeps {
  /** Opens `file` for appending, creating it (and its folder) when missing. */
  open(file: string): Promise<LogFile>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** A monotonic clock in ms: the retry budget is real elapsed time, not the logger clock. */
  monotonicMs(): number;
  writeStderr(text: string): void;
}

const realDeps: LoggerDeps = {
  open: async (file) => {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, 'a');
    try {
      const { size } = await handle.stat();
      return {
        size,
        append: (text) => handle.appendFile(text, 'utf8'),
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  },
  rename,
  unlink,
  sleep: (ms) => sleepMs(ms),
  monotonicMs: () => performance.now(),
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

// ---- fields -----------------------------------------------------------------------------------------------------------

const SAFE_STRING = /^[\w.:/@-]{0,128}$/;
const ALLOWED: ReadonlySet<string> = new Set(LOG_FIELD_NAMES);
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

type LogValue = string | number | boolean;

function safeValue(value: unknown): value is LogValue {
  if (typeof value === 'string') return SAFE_STRING.test(value);
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'boolean';
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

// ---- the logger -------------------------------------------------------------------------------------------------------

/** Builds a logger over `deps`. `createLogger` is this over the real file system and `process.stderr`. */
export function createLoggerWith(o: LoggerOptions, deps: LoggerDeps): Logger {
  const rotateBytes = o.rotateBytes ?? LOG_ROTATE_BYTES;
  const stats: LoggerStats = { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 };
  const queue: string[] = [];
  let draining: Promise<void> | null = null;
  let closed = false;
  let handle: LogFile | null = null;
  let size = 0;
  /** Logger-clock time before which no rotation is attempted (set after a rotation ran out of budget). */
  let nextRotationAt = Number.NEGATIVE_INFINITY;

  /** One JSON line for a call, with every field that is not allowed or not safe dropped and counted. */
  function serialize(level: LogLevel, event: string, fields: LogFields | undefined): string {
    const record: Record<string, LogValue> = { ts: isoMsZ(o.clock.now()), level };
    if (event !== '' && SAFE_STRING.test(event)) {
      record['event'] = event;
    } else {
      record['event'] = 'invalid_event';
      stats.droppedFields += 1;
    }
    if (fields !== undefined) {
      for (const key of Object.keys(fields)) {
        if (!ALLOWED.has(key) || key === 'event') stats.droppedFields += 1;
      }
      for (const name of LOG_FIELD_NAMES) {
        if (name === 'event' || !Object.hasOwn(fields, name)) continue;
        try {
          const value = fields[name];
          if (value === undefined) continue;
          if (safeValue(value)) record[name] = value;
          else stats.droppedFields += 1;
        } catch {
          // A getter that throws is a dropped field, never an error for the caller.
          stats.droppedFields += 1;
        }
      }
    }
    return `${JSON.stringify(record)}\n`;
  }

  // -- file sink --

  async function reopen(): Promise<void> {
    if (o.file === null) return;
    const file = await deps.open(o.file);
    handle = file;
    size = file.size;
  }

  async function abandonHandle(): Promise<void> {
    const old = handle;
    handle = null;
    if (old === null) return;
    try {
      await old.close();
    } catch {
      // The handle is being dropped after another failure; that failure is the one counted.
    }
  }

  /** One unlink or rename with the retry rule of ADR 0058 (`retryBusy`); ENOENT means "nothing in this slot". */
  async function step(operation: () => Promise<void>, started: number): Promise<void> {
    try {
      await retryBusy(operation, {
        startedAt: started,
        budgetMs: LOG_ROTATE_RETRY_BUDGET_MS,
        now: () => deps.monotonicMs(),
        sleep: (ms) => deps.sleep(ms),
      });
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  }

  async function rotate(file: string): Promise<void> {
    const started = deps.monotonicMs();
    await abandonHandle();
    try {
      await step(() => deps.unlink(`${file}.${String(LOG_KEEP)}`), started);
      for (let k = LOG_KEEP - 1; k >= 1; k -= 1) {
        await step(() => deps.rename(`${file}.${String(k)}`, `${file}.${String(k + 1)}`), started);
      }
      await step(() => deps.rename(file, `${file}.1`), started);
      stats.rotations += 1;
    } catch {
      // A partially shifted chain is valid: every step is one rename and the next rotation starts again from `.5`.
      stats.rotateFailures += 1;
      nextRotationAt = o.clock.now() + ROTATION_PAUSE_MS;
    }
    await reopen();
  }

  async function writeLine(line: string): Promise<void> {
    const file = o.file;
    if (file === null) return;
    try {
      if (handle === null) await reopen();
      const bytes = Buffer.byteLength(line, 'utf8');
      if (o.rotate && size > 0 && size + bytes > rotateBytes && o.clock.now() >= nextRotationAt) {
        await rotate(file);
      }
      const target = handle;
      if (target === null) throw new Error('log file is not open');
      await target.append(line);
      size += bytes;
    } catch {
      // The line is lost and counted; the next line starts from a fresh handle.
      stats.writeFailures += 1;
      await abandonHandle();
    }
  }

  async function drain(): Promise<void> {
    for (let line = queue.shift(); line !== undefined; line = queue.shift()) {
      await writeLine(line);
    }
  }

  function kick(): void {
    if (draining !== null) return;
    draining = drain().finally(() => {
      draining = null;
      if (queue.length > 0) kick();
    });
  }

  function emit(line: string): void {
    if (o.file === null) {
      try {
        deps.writeStderr(line);
      } catch {
        stats.writeFailures += 1;
      }
      return;
    }
    if (queue.length >= LOG_MAX_QUEUED_LINES) {
      stats.writeFailures += 1;
      return;
    }
    queue.push(line);
    kick();
  }

  function log(level: LogLevel, event: string, fields?: LogFields): void {
    if (closed || LEVEL_RANK[level] < LEVEL_RANK[o.level]) return;
    try {
      emit(serialize(level, event, fields));
    } catch {
      // No time value, an unreadable field object: the line cannot be produced; the caller is never told.
      stats.writeFailures += 1;
    }
  }

  return {
    debug: (event, fields) => {
      log('debug', event, fields);
    },
    info: (event, fields) => {
      log('info', event, fields);
    },
    warn: (event, fields) => {
      log('warn', event, fields);
    },
    error: (event, fields) => {
      log('error', event, fields);
    },
    stats,
    close: async () => {
      closed = true;
      if (draining !== null) await draining;
      await abandonHandle();
    },
  };
}

/** The logger of a process: `file` null writes to stderr (CLI), otherwise appends to `file` and rotates when asked to. */
export function createLogger(o: LoggerOptions): Logger {
  return createLoggerWith(o, realDeps);
}
