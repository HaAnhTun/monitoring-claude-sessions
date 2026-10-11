// `probeInstance` (01 4.8, ADR 0006) and the two small clients it needs: the control-channel client (01 4.3) and a loopback
// HTTP GET. The classification of a workspace never needs the command line of a process: the control channel answers with
// the instance id and the pid, and a free channel with a live pid in `state.json` is by construction not our runtime. The
// command line is needed only to kill, and that is `stop`'s business (lifecycle.ts).
//
// The address of the control channel has one more copy, in the server (`server/src/control-channel.ts`), because the
// engine cannot import the server and `@mcs/shared/protocol` is free of Node (CR-WP-19-1). The integration tests start a
// real server and talk to it through this module, so a drift between the two fails there.
import { request } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { StateFileSchema, UUID_V4_RE, stateEngine, type StateFile } from '@mcs/shared';
import {
  CONTROL_CLIENT_TIMEOUT_MS,
  parseControlResponse,
  type ControlErrorCode,
  type ControlRequest,
  type ControlResponse,
} from '@mcs/shared/protocol';

import { readSmallFile } from '../platform/fsx.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { listRuntimeProcesses, type RuntimeProcess } from '../platform/markers.ts';
import { pidAlive } from '../platform/process.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';

const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

// ---- the control address (01 4.3) ----------------------------------------------------------------------------------------

/** What the address depends on; tests pass other hosts, the default is this one. */
export interface AddressHost {
  readonly platform: HostPlatform;
  readonly tmpdir: string;
  /** The user id on POSIX, `null` on Windows. */
  readonly uid: number | null;
}

function currentHost(): AddressHost {
  return {
    platform: hostPlatform,
    tmpdir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
}

/**
 * Windows `\\.\pipe\mcs-<instanceId>`; Linux the abstract socket `\0mcs-<instanceId>`; other POSIX
 * `<tmpdir>/mcs-<uid>/<instanceId>.sock`. The id becomes part of a path, so only a version 4 uuid is accepted.
 */
export function controlAddressOf(instanceId: string, host: AddressHost = currentHost()): string {
  if (!UUID_V4_RE.test(instanceId)) throw new RangeError('controlAddressOf: the instance id is not a version 4 uuid');
  switch (host.platform) {
    case 'win32':
      return `${BACKSLASH}${BACKSLASH}.${BACKSLASH}pipe${BACKSLASH}mcs-${instanceId}`;
    case 'linux':
      return `${NUL}mcs-${instanceId}`;
    case 'darwin':
    case 'other':
      return path.join(host.tmpdir, `mcs-${String(host.uid ?? 0)}`, `${instanceId}.sock`);
  }
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
    const finish = (attempt: HttpAttempt): void => {
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
          finish({ ok: true, reply: { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') } });
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
  | 'legacy-running'
  | 'legacy-stale';

export interface ProbeResult {
  readonly state: ProbeState;
  /** The engine of the process that holds (or held) the instance; `null` when nothing is known. */
  readonly engine: 'node' | 'legacy' | null;
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
   * `<skill>/runtime`: needed only to find the pid of a hung runtime that `state.json` does not name (one process listing,
   * 0.3-0.5 s on Windows). Without it that pid stays unknown.
   */
  readonly runtimeDir?: string;
}

/** A state that has a live process of an engine behind it. */
export function isLiveState(state: ProbeState): boolean {
  return (
    state === 'running' ||
    state === 'starting' ||
    state === 'stopping' ||
    state === 'unhealthy' ||
    state === 'legacy-running'
  );
}

/** A monitor that serves: a healthy Node runtime or a live legacy viewer (`status` exits 0 for these). */
export function isRunningState(state: ProbeState): boolean {
  return state === 'running' || state === 'legacy-running';
}

/** What the probe needs from the outside world; tests pass scripted versions. */
export interface ProbeDeps {
  pidAlive(pid: number): boolean;
  identify(address: string, timeoutMs: number): Promise<ControlAttempt>;
  httpGet(url: string, o: { timeoutMs: number }): Promise<HttpAttempt>;
  listRuntimeProcesses(runtimeDir: string): Promise<readonly RuntimeProcess[]>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const LEGACY_HEALTH_TIMEOUT_MS = 3000;
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

/** `instance.json`, or `null` for a legacy workspace and for one whose identity cannot be read (the callers say why). */
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

    const fromState = (state: ProbeState, engine: 'node' | 'legacy' | null, reason: string): ProbeResult => ({
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
    if (stateEngine(stateFile) === 'node') {
      return deps.pidAlive(stateFile.pid)
        ? fromState('foreign-pid', 'node', 'the control channel is free but the pid of the state file is alive')
        : fromState('stale', 'node', 'the pid of the state file is gone');
    }
    if (!deps.pidAlive(stateFile.pid)) return fromState('legacy-stale', 'legacy', 'the pid of the state file is gone');
    const health = await deps.httpGet(`${stateFile.url}/api/health`, { timeoutMs: LEGACY_HEALTH_TIMEOUT_MS });
    const body = health.ok && health.reply.status === 200 ? recordOf(jsonBodyOf(health.reply)) : null;
    return body?.['pid'] === stateFile.pid
      ? fromState('legacy-running', 'legacy', 'the legacy viewer answers /api/health with the pid of the state file')
      : fromState('legacy-stale', 'legacy', 'the pid of the state file does not answer /api/health as that pid');
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
    const found = (await deps.listRuntimeProcesses(runtimeDir)).find((p) => p.instanceId === instanceId);
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
 * Classifies the instance of `ws` (01 4.8): `running`, `starting`, `stopping`, `unhealthy`, `stopped`, `stale`, `foreign-pid`,
 * `legacy-running` or `legacy-stale`. Fast path first: a control-channel round trip (about 60 ms) and one HTTP request; no
 * PowerShell unless a hung runtime has to be found. Never throws for a state of the workspace.
 */
export function probeInstance(ws: WorkspaceRef, o?: ProbeOptions): Promise<ProbeResult> {
  return realProbe(ws, o);
}
