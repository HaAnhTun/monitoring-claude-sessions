// Control channel protocol (01 section 4.3, ADR 0005). Zod-free: the CLI and the server both import it, and the
// protocol folder depends on nothing. One request per connection, one UTF-8 JSON object per line, request at most
// 4096 bytes, one reply line, then close.

export const CONTROL_OPS = ['identify', 'shutdown', 'backup', 'ingest-replay'] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export const CONTROL_PHASES = ['starting', 'ready', 'stopping'] as const;
export type ControlPhase = (typeof CONTROL_PHASES)[number];

export const CONTROL_SHUTDOWN_REASONS = ['stop', 'restart', 'upgrade', 'signal'] as const;
export type ControlShutdownReason = (typeof CONTROL_SHUTDOWN_REASONS)[number];

export const CONTROL_ERROR_CODES = [
  'BAD_REQUEST',
  'FORBIDDEN',
  'INSTANCE_MISMATCH',
  'NOT_READY',
  'BACKUP_FAILED',
  /** A service behind the channel threw: the reply carries no detail (the cause is in the log). */
  'INTERNAL',
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export type ControlRequest =
  | { v: 1; op: 'identify' }
  | { v: 1; op: 'shutdown'; instanceId: string; token: string; reason: ControlShutdownReason }
  | {
      v: 1;
      op: 'backup';
      instanceId: string;
      token: string;
      dest: string; /* absolute path of <ws>/data/backups/<id>.partial/monitor.db */
    }
  | {
      v: 1;
      op: 'ingest-replay';
      instanceId: string;
      token: string;
      fromSegment: string | null /* SPOOL_SEGMENT_RE (02 2.7) or null = all */;
    };

export type ControlResponse =
  | {
      v: 1;
      ok: true;
      op: 'identify';
      instanceId: string;
      pid: number;
      phase: ControlPhase;
      runtimeVersion: string;
      codeStamp: string;
      port: number | null;
      url: string | null;
      startedAt: string;
    }
  | { v: 1; ok: true; op: 'shutdown'; phase: 'stopping' }
  | { v: 1; ok: true; op: 'backup'; bytes: number; dbSchemaVersion: number }
  | { v: 1; ok: true; op: 'ingest-replay'; segments: number }
  | { v: 1; ok: false; error: ControlErrorCode };

/** A request is at most this many UTF-8 bytes. */
export const CONTROL_REQUEST_MAX_BYTES = 4096;
/** The server closes a connection that stays idle this long. */
export const CONTROL_IDLE_TIMEOUT_MS = 2000;
/** Client timeout for `identify` and `shutdown`. */
export const CONTROL_CLIENT_TIMEOUT_MS = 2000;
/** Client timeout for `backup`: the reply is sent when the copy finished. */
export const CONTROL_BACKUP_TIMEOUT_MS = 600_000;
/** Client timeout for `ingest-replay`: the reply is sent after the commit. */
export const CONTROL_REPLAY_TIMEOUT_MS = 30_000;

export function controlTimeoutMs(op: ControlOp): number {
  if (op === 'backup') return CONTROL_BACKUP_TIMEOUT_MS;
  if (op === 'ingest-replay') return CONTROL_REPLAY_TIMEOUT_MS;
  return CONTROL_CLIENT_TIMEOUT_MS;
}

type Json = Record<string, unknown>;

function parseObject(line: string): Json | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function onlyKeys(o: Json, keys: readonly string[]): boolean {
  const names = Object.keys(o);
  return names.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isMember<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && list.some((x) => x === v);
}

/** UTF-8 length of a string without `TextEncoder` (the protocol folder needs no globals beyond the language). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Parses one request line (without its terminator). Returns `null` for anything that is not exactly one valid
 * request: the server answers `BAD_REQUEST`. The segment name of `ingest-replay` is checked by the server against
 * `SPOOL_SEGMENT_RE`, not here.
 */
export function parseControlRequest(line: string): ControlRequest | null {
  if (line.includes('\n') || utf8Length(line) > CONTROL_REQUEST_MAX_BYTES) return null;
  const o = parseObject(line);
  if (o?.['v'] !== 1) return null;
  const { op, instanceId, token } = o;
  if (op === 'identify') return onlyKeys(o, ['v', 'op']) ? { v: 1, op } : null;
  if (!isNonEmptyString(instanceId) || !isNonEmptyString(token)) return null;
  if (op === 'shutdown') {
    const { reason } = o;
    return onlyKeys(o, ['v', 'op', 'instanceId', 'token', 'reason']) && isMember(CONTROL_SHUTDOWN_REASONS, reason)
      ? { v: 1, op, instanceId, token, reason }
      : null;
  }
  if (op === 'backup') {
    const { dest } = o;
    return onlyKeys(o, ['v', 'op', 'instanceId', 'token', 'dest']) && isNonEmptyString(dest)
      ? { v: 1, op, instanceId, token, dest }
      : null;
  }
  if (op === 'ingest-replay') {
    const { fromSegment } = o;
    return onlyKeys(o, ['v', 'op', 'instanceId', 'token', 'fromSegment']) &&
      (fromSegment === null || typeof fromSegment === 'string')
      ? { v: 1, op, instanceId, token, fromSegment }
      : null;
  }
  return null;
}

/** Parses one reply line. Returns `null` when it is not a valid `ControlResponse`. */
export function parseControlResponse(line: string): ControlResponse | null {
  const o = parseObject(line);
  if (o?.['v'] !== 1) return null;
  if (o['ok'] === false) {
    const { error } = o;
    return onlyKeys(o, ['v', 'ok', 'error']) && isMember(CONTROL_ERROR_CODES, error)
      ? { v: 1, ok: false, error }
      : null;
  }
  if (o['ok'] !== true) return null;
  const { op } = o;
  if (op === 'identify') {
    const { instanceId, pid, phase, runtimeVersion, codeStamp, port, url, startedAt } = o;
    const valid =
      onlyKeys(o, [
        'v',
        'ok',
        'op',
        'instanceId',
        'pid',
        'phase',
        'runtimeVersion',
        'codeStamp',
        'port',
        'url',
        'startedAt',
      ]) &&
      typeof instanceId === 'string' &&
      isCount(pid) &&
      isMember(CONTROL_PHASES, phase) &&
      typeof runtimeVersion === 'string' &&
      typeof codeStamp === 'string' &&
      (port === null || isCount(port)) &&
      (url === null || typeof url === 'string') &&
      typeof startedAt === 'string';
    return valid
      ? { v: 1, ok: true, op, instanceId, pid, phase, runtimeVersion, codeStamp, port, url, startedAt }
      : null;
  }
  if (op === 'shutdown') {
    return onlyKeys(o, ['v', 'ok', 'op', 'phase']) && o['phase'] === 'stopping'
      ? { v: 1, ok: true, op, phase: 'stopping' }
      : null;
  }
  if (op === 'backup') {
    const { bytes, dbSchemaVersion } = o;
    return onlyKeys(o, ['v', 'ok', 'op', 'bytes', 'dbSchemaVersion']) && isCount(bytes) && isCount(dbSchemaVersion)
      ? { v: 1, ok: true, op, bytes, dbSchemaVersion }
      : null;
  }
  if (op === 'ingest-replay') {
    const { segments } = o;
    return onlyKeys(o, ['v', 'ok', 'op', 'segments']) && isCount(segments) ? { v: 1, ok: true, op, segments } : null;
  }
  return null;
}
