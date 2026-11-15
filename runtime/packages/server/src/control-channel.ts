// The instance control channel (01 4.3, 8.2; ADR 0005): a named pipe (a Unix socket on POSIX) that is at once the instance
// lock (INV-03), the identity probe of the CLI and the only way to stop the server gracefully on Windows. One request per
// connection, one UTF-8 JSON object per line, at most 4096 bytes, one reply line, then the connection closes; an idle
// connection is closed after 2 s. `identify` needs no token and returns no secret; `shutdown`, `backup`, `ingest-replay`,
// `terminals` and `access` need the instance id and the 256-bit token of `run/control.token`. Lifecycle operations are not on
// HTTP, which a browser can reach (DNS rebinding, CSRF); a browser cannot reach a pipe.
//
// The user instance adds two operations and one refusal (06 1.8, ADR 0093, ADR 0094). `terminals` answers the census of the
// terminal sessions (the count, the limit and at most 50 names with their start times) in every phase, but asks the census only
// while the phase is `ready`. `access` mints the one-use code of the login link, only when ready, and only where a minter is
// wired (a task instance answers `UNSUPPORTED`). `shutdown` carries an optional `force` and may be refused with
// `TERMINALS_LIVE`: the server decides, this module only passes the question on. No code and no session name is ever logged:
// the events carry a route and a status, nothing else.
//
// This module is the server half of the protocol of `@mcs/shared/protocol`. The client half at the end (`sendControlLine`,
// `requestControl`) is used by the integration tests of this package; the CLI has its own in the engine (WP-19).
import { timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { hostPlatform, isMissingFileError, samePath, type AccessMint, type Logger } from '@mcs/engine';
import {
  McsError,
  controlAddress as sharedControlAddress,
  isoMsZ,
  type AddressHost as SharedAddressHost,
} from '@mcs/shared';
import {
  CONTROL_IDLE_TIMEOUT_MS,
  CONTROL_REQUEST_MAX_BYTES,
  CONTROL_TERMINAL_SESSIONS_MAX,
  SPOOL_SEGMENT_RE,
  parseControlRequest,
  parseControlResponse,
  type ControlErrorCode,
  type ControlPhase,
  type ControlRequest,
  type ControlResponse,
  type ControlShutdownReason,
  type ControlTerminalSession,
} from '@mcs/shared/protocol';

// ---- the address ---------------------------------------------------------------------------------------------------------

/** What the address depends on; tests pass other hosts, the default is this one. */
export type AddressHost = SharedAddressHost;

function currentHost(): AddressHost {
  return {
    platform: hostPlatform,
    tmpdir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
}

const WINDOWS_PIPE_PREFIX = String.raw`\\.\pipe\mcs-`;

/**
 * The address of the control channel of an instance on this host: `controlAddress` of `@mcs/shared` (one rule for the server, the
 * engine probe and the CLI; 01 4.3) with the host this process runs on.
 */
export function controlAddress(instanceId: string, host: AddressHost = currentHost()): string {
  return sharedControlAddress(instanceId, host);
}

/** True for an address the OS frees by itself: a Windows pipe or a Linux abstract socket (no file to clean). */
function isKernelAddress(address: string): boolean {
  return address.startsWith(WINDOWS_PIPE_PREFIX) || address.startsWith('\0');
}

// ---- the services behind the channel --------------------------------------------------------------------------------------

/** What `identify` says about the process besides its phase. */
export interface ControlIdentity {
  readonly pid: number;
  readonly runtimeVersion: string;
  readonly codeStamp: string;
  /** `null` while the HTTP server is not bound yet. */
  readonly port: number | null;
  readonly url: string | null;
  /** ISO-8601 with milliseconds, UTC. */
  readonly startedAt: string;
}

export type BackupOutcome =
  | { readonly ok: true; readonly bytes: number; readonly dbSchemaVersion: number }
  | { readonly ok: false; readonly error: 'BAD_REQUEST' | 'BACKUP_FAILED' };

export type ReplayOutcome =
  | { readonly ok: true; readonly segments: number }
  | { readonly ok: false; readonly error: 'BAD_REQUEST' | 'NOT_READY' };

/** What `onShutdown` may answer after it decided: a refusal (06 3.2). Anything else, or nothing, means the shutdown was triggered. */
export type ShutdownAnswer = { readonly ok: true } | { readonly ok: false; readonly error: 'TERMINALS_LIVE' };

/** The census of the terminal sessions as the control op `terminals` reports it: `live` counts starting, live and lost sessions. */
export interface TerminalsOutcome {
  readonly live: number;
  readonly max: number;
  /** Oldest first; the channel keeps at most `CONTROL_TERMINAL_SESSIONS_MAX` and only the name and the start time of each. */
  readonly sessions: readonly ControlTerminalSession[];
}

export interface ControlChannelOptions {
  readonly address: string;
  readonly instanceId: string;
  /** The token of this boot, or `null` while there is none (every token operation is then FORBIDDEN). */
  readonly token: () => string | null;
  readonly phase: () => ControlPhase;
  readonly identity: () => ControlIdentity;
  /**
   * The shutdown decision and trigger; it returns at once (the server stops after the reply is written). `force` is true only
   * when the request carried `force: true`. It refuses with `{ ok: false, error: 'TERMINALS_LIVE' }` and has then triggered
   * nothing; with any other answer the channel replies `stopping`.
   */
  readonly onShutdown: (reason: ControlShutdownReason, o: { readonly force: boolean }) => ShutdownAnswer | undefined;
  /** The census (06 1.8). Absent: an empty census, which is what a task instance reports. Asked only while the phase is `ready`. */
  readonly onTerminals?: () => TerminalsOutcome;
  /**
   * Mints a one-use access code (ADR 0094); `null` when there is no access service. Absent: `UNSUPPORTED`, which is what a task
   * instance answers. Called only while the phase is `ready`. It must not log, and nothing here logs its result.
   */
  readonly onAccess?: () => AccessMint | null;
  /** Called with a destination the caller has not validated (see `validateBackupDest`). */
  readonly onBackup: (dest: string) => Promise<BackupOutcome>;
  /** Called with `null` (all segments) or a name that matches `SPOOL_SEGMENT_RE`. */
  readonly onIngestReplay: (fromSegment: string | null) => Promise<ReplayOutcome>;
  /** Never receives a token, a destination or request text: events `control_*` with a route, a status or a code only. */
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  /** Test hook T-LC-06: hold the name and answer nothing. */
  readonly ignoreRequests?: boolean;
  /** Default `CONTROL_IDLE_TIMEOUT_MS` (2 s). */
  readonly idleTimeoutMs?: number;
}

export interface ControlChannel {
  readonly address: string;
  /** Stops listening, ends every open connection and frees the name. Idempotent. */
  close(): Promise<void>;
}

// ---- opening ---------------------------------------------------------------------------------------------------------------

const MAX_CONNECTIONS = 32;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function listen(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

/** The folder of a socket file is ours and private: mode 0700, a real folder, owned by this user (T-SEC-01). */
async function prepareSocketFolder(folder: string): Promise<void> {
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!info.isDirectory() || info.isSymbolicLink() || (uid !== null && info.uid !== uid)) {
      throw new McsError('WORKSPACE_INVALID', 'the folder of the control socket is not a private folder of this user');
    }
    if ((info.mode & 0o077) !== 0) await chmod(folder, 0o700);
  } catch (error) {
    if (error instanceof McsError) throw error;
    throw new McsError(
      'WORKSPACE_INVALID',
      `cannot prepare the folder of the control socket (${errorCode(error) ?? 'error'})`,
      {
        cause: error,
      },
    );
  }
}

/** A socket file whose owner is gone: connecting is refused (01 4.3: unlink it and listen once more). */
function isStaleSocket(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(address);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', (error) => {
      probe.destroy();
      resolve(errorCode(error) === 'ECONNREFUSED');
    });
  });
}

function openFailure(error: unknown): McsError {
  return new McsError('WORKSPACE_INVALID', `cannot open the control channel (${errorCode(error) ?? 'error'})`, {
    cause: error,
  });
}

/**
 * Listens on the control address: the instance lock. `null` when the name is taken (another runtime of this instance, exit
 * 12); any other failure is an `McsError` `WORKSPACE_INVALID`. Nothing is read or written besides the socket itself.
 */
export async function openControlChannel(o: ControlChannelOptions): Promise<ControlChannel | null> {
  const idleMs = o.idleTimeoutMs ?? CONTROL_IDLE_TIMEOUT_MS;
  const sockets = new Set<net.Socket>();
  const server = new ChannelServer(o, sockets, idleMs);
  if (!isKernelAddress(o.address)) await prepareSocketFolder(path.dirname(o.address));
  try {
    await listen(server.net, o.address);
  } catch (error) {
    if (errorCode(error) !== 'EADDRINUSE') throw openFailure(error);
    if (isKernelAddress(o.address) || !(await isStaleSocket(o.address))) return null;
    await unlink(o.address);
    const again = new ChannelServer(o, sockets, idleMs);
    try {
      await listen(again.net, o.address);
    } catch (second) {
      if (errorCode(second) === 'EADDRINUSE') return null;
      throw openFailure(second);
    }
    return again.channel();
  }
  return server.channel();
}

// ---- one server and its connections --------------------------------------------------------------------------------------------

const BAD_REQUEST: ControlResponse = { v: 1, ok: false, error: 'BAD_REQUEST' };
const NO_TERMINALS: TerminalsOutcome = { live: 0, max: 0, sessions: [] };
const refusal = (error: ControlErrorCode): ControlResponse => ({ v: 1, ok: false, error });

function tokenMatches(expected: string | null, given: string): boolean {
  if (expected === null) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** More than this many bytes after a refusal and the connection is dropped: a client must not stream into a refused request. */
const REFUSED_DISCARD_LIMIT = 64 * 1024;

/** A reply that is being written when the channel closes (the reply to `shutdown` is the common case) gets this long to leave. */
const CLOSE_GRACE_MS = 250;

class ChannelServer {
  readonly net: net.Server;
  private readonly o: ControlChannelOptions;
  private readonly sockets: Set<net.Socket>;
  private readonly idleMs: number;
  private closing: Promise<void> | null = null;
  /** Connections whose request was read and whose reply is not written yet. */
  private readonly serving = new Set<net.Socket>();

  constructor(o: ControlChannelOptions, sockets: Set<net.Socket>, idleMs: number) {
    this.o = o;
    this.sockets = sockets;
    this.idleMs = idleMs;
    // a client that ends its side after the request still gets its reply: the server ends its side itself
    this.net = net.createServer({ allowHalfOpen: true });
    this.net.maxConnections = MAX_CONNECTIONS;
    this.net.on('connection', (socket) => {
      this.accept(socket);
    });
    this.net.on('error', () => {
      this.o.logger.warn('control_failed', { code: 'SERVER_ERROR' });
    });
  }

  channel(): ControlChannel {
    return { address: this.o.address, close: () => this.close() };
  }

  private close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      this.net.close(() => {
        if (grace !== undefined) clearTimeout(grace);
        resolve();
      });
      for (const socket of this.sockets) if (!this.serving.has(socket)) socket.destroy();
      if (this.serving.size > 0) {
        grace = setTimeout(() => {
          for (const socket of this.sockets) socket.destroy();
        }, CLOSE_GRACE_MS);
      }
    });
    return this.closing;
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => {
      this.sockets.delete(socket);
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.setTimeout(this.idleMs);
    socket.once('timeout', () => {
      socket.destroy();
    });

    const pending: Buffer[] = [];
    let size = 0;
    let discarded = 0;
    let handled = false;
    const handle = (line: Buffer): void => {
      if (handled) return;
      handled = true;
      if (this.o.ignoreRequests === true) return; // the idle timeout ends the connection
      socket.setTimeout(0); // a backup may take minutes: no idle close while the request runs
      this.serving.add(socket);
      void this.serve(socket, line).finally(() => {
        this.serving.delete(socket);
      });
    };
    socket.on('data', (chunk: Buffer) => {
      if (handled) {
        discarded += chunk.length;
        if (discarded > REFUSED_DISCARD_LIMIT) socket.destroy();
        return;
      }
      const newline = chunk.indexOf(0x0a);
      const lineEnd = newline === -1 ? chunk.length : newline;
      if (size + lineEnd > CONTROL_REQUEST_MAX_BYTES + 1) {
        // more than the largest request without a newline in sight, or a longer line: refuse without reading on
        handled = true;
        this.refuse(socket, BAD_REQUEST, 'bad');
        return;
      }
      pending.push(chunk.subarray(0, lineEnd));
      size += lineEnd;
      if (newline !== -1) handle(Buffer.concat(pending));
    });
    socket.once('end', () => {
      // the client is done writing: a line that was never finished is not a request
      if (!handled) socket.end();
    });
  }

  /** Writes the one reply line and ends the connection (the idle timeout is the safety net for a client that never closes). */
  private reply(socket: net.Socket, response: ControlResponse, label: string): void {
    const level = label === 'identify' ? 'debug' : 'info';
    this.o.logger[level]('control_request', { route: `control:${label}`, status: 'ok' });
    socket.setTimeout(this.idleMs);
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private refuse(socket: net.Socket, response: ControlResponse, label: string): void {
    this.o.logger.warn('control_refused', { route: `control:${label}`, status: response.ok ? 'ok' : response.error });
    socket.setTimeout(this.idleMs);
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async serve(socket: net.Socket, bytes: Buffer): Promise<void> {
    let text = bytes.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    const request = parseControlRequest(text);
    if (request === null) {
      this.refuse(socket, BAD_REQUEST, 'bad');
      return;
    }
    try {
      const response = await this.answer(request);
      if (response.ok) this.reply(socket, response, request.op);
      else this.refuse(socket, response, request.op);
    } catch (error) {
      // a service that threw: the client gets INTERNAL and nothing else (no message, no detail), the log names the failure by code
      this.o.logger.warn('control_failed', { route: `control:${request.op}`, code: errorCode(error) ?? 'INTERNAL' });
      socket.setTimeout(this.idleMs);
      socket.end(`${JSON.stringify(refusal('INTERNAL'))}\n`);
    }
  }

  private async answer(request: ControlRequest): Promise<ControlResponse> {
    const o = this.o;
    if (request.op === 'identify') {
      const identity = o.identity();
      return { v: 1, ok: true, op: 'identify', instanceId: o.instanceId, phase: o.phase(), ...identity };
    }
    if (request.instanceId !== o.instanceId) return refusal('INSTANCE_MISMATCH');
    if (!tokenMatches(o.token(), request.token)) return refusal('FORBIDDEN');
    if (request.op === 'shutdown') {
      const outcome = o.onShutdown(request.reason, { force: request.force === true });
      if (outcome !== undefined && !outcome.ok) return refusal(outcome.error);
      return { v: 1, ok: true, op: 'shutdown', phase: 'stopping' };
    }
    if (request.op === 'terminals') {
      // while starting no terminal can exist yet, and while stopping they are going down: the census is not asked
      const census = o.onTerminals !== undefined && o.phase() === 'ready' ? o.onTerminals() : NO_TERMINALS;
      return {
        v: 1,
        ok: true,
        op: 'terminals',
        live: census.live,
        max: census.max,
        sessions: census.sessions
          .slice(0, CONTROL_TERMINAL_SESSIONS_MAX)
          .map(({ name, startedAt }) => ({ name, startedAt })),
      };
    }
    if (request.op === 'access' && o.onAccess === undefined) return refusal('UNSUPPORTED');
    if (o.phase() !== 'ready') return refusal('NOT_READY');
    if (request.op === 'backup') {
      let outcome: BackupOutcome;
      try {
        outcome = await o.onBackup(request.dest);
      } catch (error) {
        o.logger.warn('control_failed', { route: 'control:backup', code: errorCode(error) ?? 'INTERNAL' });
        return refusal('BACKUP_FAILED');
      }
      return outcome.ok
        ? { v: 1, ok: true, op: 'backup', bytes: outcome.bytes, dbSchemaVersion: outcome.dbSchemaVersion }
        : refusal(outcome.error);
    }
    if (request.op === 'ingest-replay') {
      if (request.fromSegment !== null && !SPOOL_SEGMENT_RE.test(request.fromSegment)) return refusal('BAD_REQUEST');
      const outcome = await o.onIngestReplay(request.fromSegment);
      return outcome.ok ? { v: 1, ok: true, op: 'ingest-replay', segments: outcome.segments } : refusal(outcome.error);
    }
    // what is left is `access`, in the phase ready, with a minter wired; a minter that has no access service answers null
    const minted = o.onAccess?.() ?? null;
    if (minted === null) return refusal('UNSUPPORTED');
    return {
      v: 1,
      ok: true,
      op: 'access',
      code: minted.code,
      expiresAt: isoMsZ(minted.expiresAtMs),
      ttlSeconds: minted.ttlSeconds,
    };
  }
}

// ---- the destination of a backup -------------------------------------------------------------------------------------------

/**
 * 01 4.3: `dest` is `<backupsDir>/<id>.partial/monitor.db`: absolute, the file named `monitor.db`, in a folder that already
 * exists, is a direct child of the (real) backups folder, whose name ends in `.partial`, and the file does not exist yet.
 * The real path of the folder decides, so a link that leads out of the backups folder does not pass (T-SEC-03).
 */
export async function validateBackupDest(backupsDir: string, dest: string): Promise<boolean> {
  if (dest === '' || dest.includes('\0') || !path.isAbsolute(dest)) return false;
  const file = path.resolve(dest);
  if (path.basename(file) !== 'monitor.db') return false;
  let realFolder: string;
  let realBackups: string;
  try {
    realFolder = await realpath(path.dirname(file));
    realBackups = await realpath(backupsDir);
  } catch {
    return false;
  }
  const name = path.basename(realFolder);
  if (!name.endsWith('.partial') || name === '.partial') return false;
  if (!samePath(path.dirname(realFolder), realBackups)) return false;
  try {
    await lstat(path.join(realFolder, 'monitor.db'));
    return false;
  } catch (error) {
    return isMissingFileError(error);
  }
}

// ---- the client half (tests) -----------------------------------------------------------------------------------------------

export interface ControlClientOptions {
  /** Default 2000, the client timeout of `identify` and `shutdown` (01 4.3). */
  readonly timeoutMs?: number;
}

/**
 * Sends one line and returns the first line of the reply, or `null` when the server closed the connection without one.
 * Rejects on a connection error or when nothing happened within the timeout.
 */
export function sendControlLine(address: string, line: string, o: ControlClientOptions = {}): Promise<string | null> {
  const timeoutMs = o.timeoutMs ?? 2000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const received: Buffer[] = [];
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const replyOrNull = (): string | null => {
      const first = Buffer.concat(received).toString('utf8').split('\n')[0] ?? '';
      return first === '' ? null : first;
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error('the control request timed out'));
      });
    }, timeoutMs);
    socket.once('connect', () => {
      socket.write(`${line}\n`);
    });
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('error', (error) => {
      // the server may close right after its reply: what it said still counts
      finish(() => {
        if (received.length > 0) resolve(replyOrNull());
        else reject(error);
      });
    });
    socket.once('close', () => {
      finish(() => {
        resolve(replyOrNull());
      });
    });
  });
}

/** One request and its parsed reply; rejects when there is no reply or it is not a `ControlResponse`. */
export async function requestControl(
  address: string,
  request: ControlRequest,
  o: ControlClientOptions = {},
): Promise<ControlResponse> {
  const line = await sendControlLine(address, JSON.stringify(request), o);
  if (line === null) throw new Error('the control channel closed the connection with no reply');
  const response = parseControlResponse(line);
  if (response === null) throw new Error('the control channel answered something that is not a reply');
  return response;
}
