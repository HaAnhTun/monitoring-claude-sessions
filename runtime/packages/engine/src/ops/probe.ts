// `probeInstance` (01 4.8, ADR 0006) and the two small clients it needs: the control-channel client (01 4.3) and a loopback
// HTTP GET. The classification of a workspace never needs the command line of a process: the control channel answers with
// the instance id and the pid, and a free channel with a live pid in `state.json` is by construction not our runtime. The
// command line is needed only to kill, and that is `stop`'s business (lifecycle.ts).
//
// The address of the control channel is `controlAddress` of `@mcs/shared`, the same function the server listens with
// (CR-WP-19-1); `controlAddressOf` below only supplies the host this process runs on.
import { request } from 'node:http';
import net from 'node:net';
import os from 'node:os';

import { StateFileSchema, controlAddress, type AddressHost as SharedAddressHost, type StateFile } from '@mcs/shared';
import {
  CONTROL_CLIENT_TIMEOUT_MS,
  parseControlResponse,
  type ControlErrorCode,
  type ControlRequest,
  type ControlResponse,
} from '@mcs/shared/protocol';

import { readSmallFile } from '../platform/fsx.ts';
import { hostPlatform } from '../platform/host.ts';
import { listRuntimeProcesses, type RuntimeProcess } from '../platform/markers.ts';
import { pidAlive } from '../platform/process.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';

const LF = String.fromCharCode(10);

// ---- the control address (01 4.3) ----------------------------------------------------------------------------------------

/** What the address depends on; tests pass other hosts, the default is this one. */
export type AddressHost = SharedAddressHost;

function currentHost(): AddressHost {
  return {
    platform: hostPlatform,
    tmpdir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
}

/** The control address of an instance on this host: the rule is `controlAddress` of `@mcs/shared`, which the server uses too. */
export function controlAddressOf(instanceId: string, host: AddressHost = currentHost()): string {
  return controlAddress(instanceId, host);
}

// ---- the control client ------------------------------------------------------------------------------------------------------

/** A reply that says yes. */
export type ControlReply = Extract<ControlResponse, { ok: true }>;

export type IdentifyResponse = Extract<ControlResponse, { ok: true; op: 'identify' }>;

/**
 * What one request to a control channel came to: `reply` (the server said yes), `refusal` (it said no, with its code),
 * `absent` (nobody holds the name: `ENOENT`, `ECONNREFUSED`) or `silent` (somebody holds it and does not answer as the
 * protocol says: a hung runtime, an impostor, a reset).
 */
export type ControlAttempt =
  | { readonly kind: 'reply'; readonly response: ControlReply }
  | { readonly kind: 'refusal'; readonly error: ControlErrorCode }
  | { readonly kind: 'absent' }
  | { readonly kind: 'silent'; readonly reason: string };

/** A reply is one short line; anything longer than this is not one. */
const CONTROL_REPLY_MAX_BYTES = 64 * 1024;

function judgeLine(line: string): ControlAttempt {
  const response = parseControlResponse(line.endsWith('\r') ? line.slice(0, -1) : line);
  if (response === null) return { kind: 'silent', reason: 'garbled' };
  return response.ok ? { kind: 'reply', response } : { kind: 'refusal', error: response.error };
}

function errnoOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'ERROR';
}

/**
 * One request to the control channel at `address`, one reply (01 4.3: one JSON line each way, then close). Never rejects:
 * every failure is an attempt of kind `absent` or `silent`. The connection is closed as soon as the first line has arrived.
 */
export function requestControl(
  address: string,
  message: ControlRequest,
  o: { readonly timeoutMs: number },
): Promise<ControlAttempt> {
  return new Promise((resolve) => {
    const socket = net.connect(address);
    const received: Buffer[] = [];
    let size = 0;
    let connected = false;
    let settled = false;
    const finish = (attempt: ControlAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(attempt);
    };
    const text = (): string => Buffer.concat(received).toString('utf8');
    const timer = setTimeout(() => {
      finish({ kind: 'silent', reason: 'timeout' });
    }, o.timeoutMs);
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(message)}${LF}`);
    });
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      size += chunk.length;
      const all = text();
      const end = all.indexOf(LF);
      if (end >= 0) finish(judgeLine(all.slice(0, end)));
      else if (size > CONTROL_REPLY_MAX_BYTES) finish({ kind: 'silent', reason: 'garbled' });
    });
    socket.on('error', (error) => {
      const code = errnoOf(error);
      if (size > 0) finish(judgeLine(text().split(LF)[0] ?? ''));
      else if (!connected && (code === 'ENOENT' || code === 'ECONNREFUSED')) finish({ kind: 'absent' });
      else finish({ kind: 'silent', reason: connected ? 'reset' : `error:${code}` });
    });
    socket.once('close', () => {
      finish(size === 0 ? { kind: 'silent', reason: 'closed' } : judgeLine(text().split(LF)[0] ?? ''));
    });
  });
}

/** `identify` needs no token (01 4.3). */
export function identifyInstance(address: string, timeoutMs: number): Promise<ControlAttempt> {
  return requestControl(address, { v: 1, op: 'identify' }, { timeoutMs });
}

// ---- the HTTP client ------------------------------------------------------------------------------------------------------------

export interface HttpReply {
  readonly status: number;
  readonly body: string;
}

export type HttpAttempt =
  | { readonly ok: true; readonly reply: HttpReply }
  | { readonly ok: false; readonly reason: 'refused' | 'timeout' | 'too-large' | 'error' };

/** A reply with its response headers (names in lower case; a header that repeats is joined with `, `). */
export interface HttpFullReply extends HttpReply {
  readonly headers: Readonly<Record<string, string>>;
}

export type HttpFullAttempt =
  | { readonly ok: true; readonly reply: HttpFullReply }
  | { readonly ok: false; readonly reason: 'refused' | 'timeout' | 'too-large' | 'error' };

const BASE_RE = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/;
const URL_RE = /^(http:\/\/127\.0\.0\.1:[0-9]{1,5})(\/[^\s]*)$/;
const HTTP_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** True for `http://127.0.0.1:<port>` and nothing else: the only address this module ever connects to. */
export function isLoopbackBase(url: string): boolean {
  const match = BASE_RE.exec(url);
  const port = Number(match?.[1] ?? '0');
  return match !== null && port >= 1 && port <= 65535;
}

/**
 * `GET <base><path>` on a fresh connection (`Connection: close`, no agent), with the `Host` of the URL. The whole exchange has
 * `timeoutMs`; the body is read up to `maxBytes`. A status other than 200 is a reply, not a failure. A URL that is not
 * `http://127.0.0.1:<port>/...` is a programming error: the state file and the control channel are untrusted, so every
 * caller checks with `isLoopbackBase` first, and this refuses anyway.
 */
export function httpGet(
  url: string,
  o: { readonly timeoutMs: number; readonly maxBytes?: number },
): Promise<HttpAttempt> {
  return httpGetWithHeaders(url, o).then((attempt) =>
    attempt.ok ? { ok: true, reply: { status: attempt.reply.status, body: attempt.reply.body } } : attempt,
  );
}

/** `httpGet` that also returns the response headers (the readers check `X-MCS-Instance`). Same limits and the same refusals. */
export function httpGetWithHeaders(
  url: string,
  o: { readonly timeoutMs: number; readonly maxBytes?: number },
): Promise<HttpFullAttempt> {
  return new Promise((resolve, reject) => {
    const match = URL_RE.exec(url);
    const base = match?.[1];
    const pathPart = match?.[2];
    if (base === undefined || pathPart === undefined || !isLoopbackBase(base)) {
      reject(new RangeError('httpGet: only http://127.0.0.1:<port>/... is allowed'));
      return;
    }
    const port = Number(BASE_RE.exec(base)?.[1] ?? '0');
    const maxBytes = o.maxBytes ?? HTTP_BODY_MAX_BYTES;
    let settled = false;
    const finish = (attempt: HttpFullAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(attempt);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout' });
    }, o.timeoutMs);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: pathPart,
        method: 'GET',
        agent: false,
        headers: { Host: `127.0.0.1:${String(port)}`, Accept: 'application/json', Connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            finish({ ok: false, reason: 'too-large' });
            return;
          }
          chunks.push(chunk);
        });
        res.once('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers[name.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
          }
          finish({
            ok: true,
            reply: { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers },
          });
        });
        res.once('error', () => {
          finish({ ok: false, reason: 'error' });
        });
      },
    );
    req.once('error', (error) => {
      finish({ ok: false, reason: errnoOf(error) === 'ECONNREFUSED' ? 'refused' : 'error' });
    });
    req.end();
  });
}

/** The JSON body of a reply, or `undefined` when it is not JSON. */
export function jsonBodyOf(reply: HttpReply): unknown {
  try {
    return JSON.parse(reply.body);
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

// ---- the classification (01 4.8) -----------------------------------------------------------------------------------------------------

export type ProbeState =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'unhealthy'
  | 'stopped'
  | 'stale'
  | 'foreign-pid'
  /** A live monitor that this runtime did not start: a `state.json` without `engine: node` whose pid answers `/api/health`. */
  | 'unmanaged-running';

export interface ProbeResult {
  readonly state: ProbeState;
  /** `node` when this runtime holds (or held) the instance; `null` when nothing is known or the state file is not ours. */
  readonly engine: 'node' | null;
  readonly pid: number | null;
  readonly url: string | null;
  readonly port: number | null;
  /** The answer of `identify`, when the control channel answered. */
  readonly identity: IdentifyResponse | null;
  readonly stateFile: StateFile | null;
  /** The exact bytes of `state.json` as read: what `stop` compares against before it deletes the file. */
  readonly stateFileBytes: Uint8Array | null;
  /** One line that says why the state is what it is (for the messages of `status` and the errors of `stop`). */
  readonly reason: string;
}

export interface ProbeOptions {
  /** Default 2000. */
  readonly httpTimeoutMs?: number;
  /** Default 2000 (`CONTROL_CLIENT_TIMEOUT_MS`). */
  readonly controlTimeoutMs?: number;
  /**
   * The runtime folder of this install: given, it enables the lookup of the pid of a hung runtime that `state.json` does not
   * name (one process listing, 0.3-0.5 s on Windows). The listing covers every runtime folder (a server started from a
   * previous plugin version directory is found) and matches by instance id. Without it that pid stays unknown.
   */
  readonly runtimeDir?: string;
}

/** A state that has a live monitor process behind it (ours or one this runtime did not start). */
export function isLiveState(state: ProbeState): boolean {
  return (
    state === 'running' ||
    state === 'starting' ||
    state === 'stopping' ||
    state === 'unhealthy' ||
    state === 'unmanaged-running'
  );
}

/** A monitor of this runtime that serves (`status` exits 0 for it). */
export function isRunningState(state: ProbeState): boolean {
  return state === 'running';
}

/** What the probe needs from the outside world; tests pass scripted versions. */
export interface ProbeDeps {
  pidAlive(pid: number): boolean;
  identify(address: string, timeoutMs: number): Promise<ControlAttempt>;
  httpGet(url: string, o: { timeoutMs: number }): Promise<HttpAttempt>;
  /** `null`: the runtimes of every folder. */
  listRuntimeProcesses(runtimeDir: string | null): Promise<readonly RuntimeProcess[]>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const UNMANAGED_HEALTH_TIMEOUT_MS = 3000;
const STATE_FILE_MAX_BYTES = 64 * 1024;

export interface StateSnapshot {
  readonly stateFile: StateFile | null;
  readonly bytes: Uint8Array | null;
}

/** `state.json` as it is: the parsed file and its bytes, or nothing for a missing, damaged or foreign-shaped file. */
export async function readStateSnapshot(ws: Pick<WorkspaceRef, 'dir'>): Promise<StateSnapshot> {
  let bytes: Buffer;
  try {
    bytes = await readSmallFile(workspacePath(ws, 'state.json'), STATE_FILE_MAX_BYTES);
  } catch {
    // missing, too large or unreadable: there is no state to speak of
    return { stateFile: null, bytes: null };
  }
  try {
    const parsed = StateFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? { stateFile: parsed.data, bytes } : { stateFile: null, bytes: null };
  } catch {
    return { stateFile: null, bytes: null };
  }
}

/** `instance.json`, or `null` for a pre-4.0 workspace and for one whose identity cannot be read (the callers say why). */
async function readInstanceId(ws: WorkspaceRef): Promise<string | null> {
  try {
    return (await readInstanceFile(ws))?.instanceId ?? null;
  } catch {
    return null;
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Builds `probeInstance` over `deps`. The export below is the instance over the real operating system. */
export function createProbe(deps: ProbeDeps): (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult> {
  return async (ws, o = {}) => {
    const controlTimeoutMs = o.controlTimeoutMs ?? CONTROL_CLIENT_TIMEOUT_MS;
    const httpTimeoutMs = o.httpTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { stateFile, bytes } = await readStateSnapshot(ws);
    const instanceId = await readInstanceId(ws);

    const fromState = (state: ProbeState, engine: 'node' | null, reason: string): ProbeResult => ({
      state,
      engine,
      pid: stateFile?.pid ?? null,
      url: stateFile?.url ?? null,
      port: stateFile?.port ?? null,
      identity: null,
      stateFile,
      stateFileBytes: bytes,
      reason,
    });
    const fromIdentity = (
      state: ProbeState,
      identity: IdentifyResponse,
      reason: string,
      pid: number | null = identity.pid,
    ): ProbeResult => ({
      state,
      engine: 'node',
      pid,
      url: identity.url,
      port: identity.port,
      identity,
      stateFile,
      stateFileBytes: bytes,
      reason,
    });

    // step 2: the control channel, when the instance has an identity
    if (instanceId !== null) {
      const attempt = await deps.identify(controlAddressOf(instanceId), controlTimeoutMs);
      if (attempt.kind === 'refusal') {
        return fromState('unhealthy', 'node', `the control channel refused identify (${attempt.error})`);
      }
      if (attempt.kind === 'silent') {
        const hung = await pidOfHungRuntime(deps, instanceId, stateFile, o.runtimeDir);
        return {
          state: 'unhealthy',
          engine: 'node',
          pid: hung.pid,
          url: hung.fromState ? (stateFile?.url ?? null) : null,
          port: hung.fromState ? (stateFile?.port ?? null) : null,
          identity: null,
          stateFile,
          stateFileBytes: bytes,
          reason: `a runtime holds the control channel but does not answer (${attempt.reason})`,
        };
      }
      if (attempt.kind === 'reply') {
        const identity = attempt.response.op === 'identify' ? attempt.response : null;
        if (identity === null) {
          return fromState('unhealthy', 'node', 'the control channel answered identify with another reply');
        }
        if (identity.instanceId !== instanceId) {
          return fromIdentity(
            'unhealthy',
            identity,
            `the control channel of this instance answers for another instance (${shortId(identity.instanceId)})`,
          );
        }
        if (identity.phase === 'starting') return fromIdentity('starting', identity, 'the runtime is starting');
        if (identity.phase === 'stopping') return fromIdentity('stopping', identity, 'the runtime is stopping');
        const unhealthy = (why: string): ProbeResult => fromIdentity('unhealthy', identity, why);
        if (identity.url === null || identity.port === null || !isLoopbackBase(identity.url)) {
          return unhealthy('the runtime is ready but reports no usable loopback address; HTTP health was not asked');
        }
        const health = await deps.httpGet(`${identity.url}/api/v3/health`, { timeoutMs: httpTimeoutMs });
        if (!health.ok) return unhealthy(`HTTP health did not answer (${health.reason})`);
        if (health.reply.status !== 200) {
          return unhealthy(`HTTP health answered status ${String(health.reply.status)}`);
        }
        const body = recordOf(jsonBodyOf(health.reply));
        if (body?.['instanceId'] !== instanceId) {
          return unhealthy('HTTP health answered with no instance id or with another instance');
        }
        return fromIdentity('running', identity, 'the control channel answered ready and HTTP health matched');
      }
      // absent: nobody holds the name; the state file decides
    }

    // steps 3 to 5: the state file
    if (stateFile === null) return fromState('stopped', null, 'there is no usable state file');
    if (stateFile.engine === 'node') {
      return deps.pidAlive(stateFile.pid)
        ? fromState('foreign-pid', 'node', 'the control channel is free but the pid of the state file is alive')
        : fromState('stale', 'node', 'the pid of the state file is gone');
    }
    // a state file that this runtime did not write: never ours to signal; a live one that answers as its pid blocks start
    if (!deps.pidAlive(stateFile.pid)) return fromState('stale', null, 'the pid of the state file is gone');
    const health = await deps.httpGet(`${stateFile.url}/api/health`, { timeoutMs: UNMANAGED_HEALTH_TIMEOUT_MS });
    const body = health.ok && health.reply.status === 200 ? recordOf(jsonBodyOf(health.reply)) : null;
    return body?.['pid'] === stateFile.pid
      ? fromState(
          'unmanaged-running',
          null,
          'a monitor that this runtime did not start answers /api/health with the pid of the state file',
        )
      : fromState(
          'foreign-pid',
          null,
          'the pid of the state file is alive but does not answer /api/health as that pid',
        );
  };
}

/** 01 4.8 step 2: the state file when it is ours, else one listing of the runtime processes, else nobody. */
async function pidOfHungRuntime(
  deps: ProbeDeps,
  instanceId: string,
  stateFile: StateFile | null,
  runtimeDir: string | undefined,
): Promise<{ pid: number | null; fromState: boolean }> {
  if (stateFile?.instanceId === instanceId) return { pid: stateFile.pid, fromState: true };
  if (runtimeDir === undefined) return { pid: null, fromState: false };
  try {
    // Any folder: the instance id decides, so a runtime of this install started from another folder is found.
    const found = (await deps.listRuntimeProcesses(null)).find((p) => p.instanceId === instanceId);
    return { pid: found?.pid ?? null, fromState: false };
  } catch {
    return { pid: null, fromState: false };
  }
}

const REAL_DEPS: ProbeDeps = {
  pidAlive,
  identify: identifyInstance,
  httpGet,
  listRuntimeProcesses,
};

const realProbe = createProbe(REAL_DEPS);

/**
 * Classifies the instance of `ws` (01 4.8): `running`, `starting`, `stopping`, `unhealthy`, `stopped`, `stale`, `foreign-pid`
 * or `unmanaged-running`. Fast path first: a control-channel round trip (about 60 ms) and one HTTP request; no
 * PowerShell unless a hung runtime has to be found. Never throws for a state of the workspace.
 */
export function probeInstance(ws: WorkspaceRef, o?: ProbeOptions): Promise<ProbeResult> {
  return realProbe(ws, o);
}
