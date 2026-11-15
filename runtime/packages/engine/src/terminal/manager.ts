// The terminal service (design 01 sections 3.10, 4 and 7; ADR 0083): the MTOP `SessionManager`. It owns the session names, the
// slot count, the list, the change events, the child registry and the shutdown. Everything platform-specific is a dependency, so
// every rule runs on every host with a scripted backend.
//
// `create` takes the slot and the name in its synchronous part (steps 1 to 8), before the first await: two creates that race
// can neither overshoot `terminal.maxSessions` nor share a name. A failed start releases the slot and kills what it started.
//
// Nothing here logs a session name, a folder, an argument, an environment value, terminal output or the text of a native error:
// only the closed field list of the logger (`pid`, `code`, `count`, `phase`, `durationMs`) and plain event names.
import path from 'node:path';

import type { Clock, TerminalSection } from '@mcs/shared';

import type { Logger } from '../log/logger.ts';
import { isCaseInsensitive, type HostPlatform } from '../platform/host.ts';
import { buildLaunch, resolveClaudeCommand, type CommandFs } from './command.ts';
import { buildTerminalEnv, type EnvSource } from './env.ts';
import { TerminalError, type TerminalErrorCode } from './errors.ts';
import { normalizeFolder, type FolderFs } from './folder.ts';
import { DEFAULT_COLS, DEFAULT_ROWS, LIVENESS_PROBE_MS } from './limits.ts';
import { NameAllocator, sessionBase } from './names.ts';
import { Session, clampSessionSize } from './session.ts';
import type {
  ChildRegistry,
  CreateSessionRequest,
  Pty,
  PtyBackend,
  SessionExit,
  SessionInfo,
  SweepResult,
  TerminalChange,
  TerminalSession,
  TerminalStatus,
  Unsubscribe,
  UnsupportedReason,
} from './types.ts';

/** How long the descendants of a session root are reused (`claudePids`): the lookup is a process listing of the machine. */
export const CLAUDE_PIDS_TTL_MS = 5000;
/** Consecutive probes that find the root pid gone, without an exit event, before the session is ended as lost. */
export const WATCHDOG_MISSES = 2;
/** `shutdown()` waits at most `terminal.killTimeoutMs` plus this long for the sessions to end (the session's own tree-kill wait fits). */
export const SHUTDOWN_GRACE_MS = 3000;

/** The logger of the service: only the closed field list of the logger is used. */
export type TerminalLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

export interface TerminalDeps {
  readonly backend: PtyBackend;
  readonly config: TerminalSection;
  readonly logger: TerminalLogger;
  readonly clock: Clock;
  readonly platform: HostPlatform;
  /** The environment of the server, read at every `create` and `status` (`process.env`). */
  readonly env: () => EnvSource;
  readonly fs: FolderFs & CommandFs;
  /** `forceKillTree`: the escalation of a kill that did not end the process. */
  readonly killTree: (pid: number) => Promise<void>;
  /** `process.kill`, for the exit hook: the only kill that works while the process is exiting. */
  readonly killSync: (pid: number) => void;
  /** A probe of one pid (`pidAlive`): cheap, used by the watchdog and for processes that were declared lost. */
  readonly pidAlive: (pid: number) => boolean;
  /** The descendants of a root pid (`listDescendantPids`); null when the answer is unknown. */
  readonly descendants: (root: number) => Promise<readonly number[] | null>;
  /** The orphan registry; null when the backend is unsupported (nothing is ever started). */
  readonly registry: ChildRegistry | null;
  /** Only to shorten the program shown by `status()` to `~\...`; never logged. */
  readonly home: string;
}

export interface TerminalService {
  status(): TerminalStatus;
  /** Rejects with a TerminalError: the codes of design 01 section 3.2 that belong to a start. */
  create(req: CreateSessionRequest): Promise<SessionInfo>;
  /** Live sessions, sorted by (startedAt, name) as MTOP did. */
  list(): SessionInfo[];
  get(name: string): TerminalSession | undefined;
  /** False when the name is unknown. */
  kill(name: string): Promise<boolean>;
  /** Ends every live session in parallel; always resolves. */
  killAll(): Promise<void>;
  /** Starting, live and lost sessions: what `stop` and `restart` must refuse to drop (amendment A4). */
  liveCount(): number;
  /** From now on `create` rejects with SHUTTING_DOWN, and a create that is still starting is cancelled. Idempotent. */
  beginDrain(): void;
  onChange(listener: (change: TerminalChange) => void): Unsubscribe;
  /** The root pid plus its descendants (on the shim route cmd.exe -> claude.exe), ascending; cached 5 s. Empty for an unknown name and for a session the watchdog found gone. */
  claudePids(name: string): Promise<number[]>;
  sweepOrphans(): Promise<SweepResult>;
  /** Refuses new creates, ends every session, removes the registry file, stops the timers. Idempotent, never rejects. */
  shutdown(): Promise<void>;
  /** For `process.on('exit')`: a synchronous kill of every root pid that may still run. Starts nothing, never throws. */
  emergencyKillSync(): void;
}

// ---- what `claude` is ----------------------------------------------------------------------------------------------------

function stripTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && (text.charAt(end - 1) === '\\' || text.charAt(end - 1) === '/')) end -= 1;
  return text.slice(0, end);
}

/**
 * `text` with the home folder written as `~` when it starts with it (at a folder boundary; the case is ignored where the file
 * system ignores it). An empty home or the root of a drive leaves the text alone.
 */
export function shortenHome(text: string, home: string, platform: HostPlatform): string {
  const base = stripTrailingSeparators(home);
  if (base === '' || base.endsWith(':') || text.length < base.length) return text;
  const fold = isCaseInsensitive(platform) ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (fold(text.slice(0, base.length)) !== fold(base)) return text;
  const rest = text.slice(base.length);
  if (rest === '') return '~';
  const next = rest.charAt(0);
  return next === '\\' || next === '/' ? `~${rest}` : text;
}

function launchKindOf(program: string, platform: HostPlatform): 'exe' | 'shim' | null {
  if (platform !== 'win32') return 'exe';
  const ext = path.win32.extname(program).toLowerCase();
  if (ext === '.exe' || ext === '.com') return 'exe';
  if (ext === '.cmd' || ext === '.bat') return 'shim';
  return null;
}

/**
 * What the terminal knows about the program it would start, without starting anything (`status()` and `diagnoseTerminal`):
 * whether it is found, how it would be launched (`exe`, `shim`, or null for a kind that cannot be started) and its path with the
 * home folder shortened. Spawns nothing; about 40 `stat` calls.
 */
export function claudeFacts(o: {
  readonly command: string;
  readonly env: EnvSource;
  readonly platform: HostPlatform;
  readonly fs: CommandFs;
  readonly home: string;
}): TerminalStatus['claude'] {
  const resolved = resolveClaudeCommand({ command: o.command, env: o.env, platform: o.platform, fs: o.fs });
  if (resolved === null) return { found: false, kind: null, display: null };
  return {
    found: true,
    kind: launchKindOf(resolved.path, o.platform),
    display: shortenHome(resolved.path, o.home, o.platform),
  };
}

// ---- errors ----------------------------------------------------------------------------------------------------------------

const CODE_OF_REASON: Readonly<Record<UnsupportedReason, TerminalErrorCode>> = {
  'unsupported-os': 'UNSUPPORTED_OS',
  'os-too-old': 'UNSUPPORTED_OS',
  'native-missing': 'NATIVE_MISSING',
  'native-load-failed': 'NATIVE_LOAD_FAILED',
};

/**
 * What a failed spawn or start becomes. A TerminalError keeps its code (and nothing else of it is used); any other value is a
 * native or script error whose message may hold a file path, so it is dropped and the error is a plain SPAWN_FAILED.
 */
function startFailure(error: unknown): TerminalError {
  return error instanceof TerminalError ? error : new TerminalError('SPAWN_FAILED');
}

const NO_SWEEP: SweepResult = { files: 0, killed: 0, skipped: 0 };

function compareSessions(a: SessionInfo, b: SessionInfo): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  // Code units, not the locale: the order must be the same on every machine.
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** A create between the reservation of its slot and the registration of its session. */
interface Starting {
  pty: Pty | null;
  /** Rejects the wait for the first output; set while the create waits. */
  abort: (() => void) | null;
}

/** Resolves when `work` settles or after `ms`, whichever comes first; the timer never outlives the call. */
function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

function killQuietly(pty: Pty): void {
  try {
    pty.kill();
  } catch {
    // Never throws by contract; a process that is already gone is what we wanted.
  }
}

export function createTerminalService(deps: TerminalDeps): TerminalService {
  const { config, logger, clock, platform } = deps;
  const names = new NameAllocator();
  const live = new Map<string, Session>();
  const starting = new Map<string, Starting>();
  /** Sessions that ended as `lost` while their process was still alive: they stay counted until it is gone. */
  const lost = new Map<string, number>();
  /** Consecutive failed probes per live session. */
  const misses = new Map<string, number>();
  /** Sessions the watchdog found dead: their pid may be reused, so no tree kill is sent to it. */
  const deadByWatchdog = new Set<string>();
  const pidsCache = new Map<string, { at: number; pids: Promise<number[]> }>();
  const listeners = new Set<(change: TerminalChange) => void>();
  const inflight = new Set<Promise<unknown>>();
  let draining = false;
  /** A read that the compiler does not narrow: `draining` changes from other calls while a create awaits its child. */
  const isDraining = (): boolean => draining;
  let version = 0;
  let watchdog: NodeJS.Timeout | null = null;
  let shutdownPromise: Promise<void> | null = null;

  // ---- events --------------------------------------------------------------------------------------------------------------

  function emit(change: TerminalChange): void {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch {
        try {
          // The code is fixed: the text of a listener's error may hold anything.
          logger.warn('terminal.listener_failed', { code: 'listener_threw' });
        } catch {
          // A logging failure must not change anything.
        }
      }
    }
  }

  function emitSession(type: 'created' | 'updated', session: SessionInfo): void {
    version += 1;
    emit({ type, session, version });
  }

  function emitEnded(session: SessionInfo, exit: SessionExit): void {
    version += 1;
    emit({ type: 'ended', session, exit, version });
  }

  // ---- watchdog (section 4.3) ------------------------------------------------------------------------------------------------

  function pruneLost(): void {
    for (const [name, pid] of [...lost]) {
      if (deps.pidAlive(pid)) continue;
      lost.delete(name);
      deps.registry?.remove(pid);
    }
  }

  function stopWatchdog(): void {
    if (watchdog === null) return;
    clearInterval(watchdog);
    watchdog = null;
  }

  function stopWatchdogWhenIdle(): void {
    if (live.size === 0 && lost.size === 0) stopWatchdog();
  }

  function probe(): void {
    for (const [name, session] of [...live]) {
      if (deps.pidAlive(session.info().pid)) {
        misses.delete(name);
        continue;
      }
      const count = (misses.get(name) ?? 0) + 1;
      misses.set(name, count);
      if (count >= WATCHDOG_MISSES && !deadByWatchdog.has(name)) {
        // The process is gone and no exit event came. Ending the session through its own kill path tells the viewers and frees
        // the slot; with no exit event it falls back to `lost`. The tree kill is skipped for this pid: it may be reused by now.
        deadByWatchdog.add(name);
        void session.kill('killed');
      }
    }
    pruneLost();
    stopWatchdogWhenIdle();
  }

  function ensureWatchdog(): void {
    if (watchdog !== null) return;
    watchdog = setInterval(probe, LIVENESS_PROBE_MS);
    // An idle probe alone must not keep the process alive.
    watchdog.unref();
  }

  // ---- sessions ------------------------------------------------------------------------------------------------------------

  function onSessionEnded(name: string, session: Session, exit: SessionExit): void {
    if (live.get(name) !== session) return;
    live.delete(name);
    misses.delete(name);
    // Asked before the flag is cleared: a pid that the watchdog found gone is not ours any more, whatever answers for it now.
    const foundDead = deadByWatchdog.delete(name);
    pidsCache.delete(name);
    const info = session.info();
    if (exit.reason === 'lost' && !foundDead && deps.pidAlive(info.pid)) {
      // A process we could not end: it stays counted, and its registry entry stays so that a later start can sweep it.
      lost.set(name, info.pid);
    } else {
      deps.registry?.remove(info.pid);
    }
    emitEnded(info, exit);
    stopWatchdogWhenIdle();
  }

  function register(name: string, cwd: string, pty: Pty, size: { cols: number; rows: number }): SessionInfo {
    const startedAt = clock.now();
    const session = new Session({
      name,
      cwd,
      pty,
      startedAt,
      cols: size.cols,
      rows: size.rows,
      replayBytes: config.replayBytes,
      maxInputBytes: config.maxInputBytes,
      killTimeoutMs: config.killTimeoutMs,
      clock,
      killTree: (pid) => (deadByWatchdog.has(name) ? Promise.resolve() : deps.killTree(pid)),
      onUpdated: () => {
        emitSession('updated', session.info());
      },
      onEnded: (exit) => {
        onSessionEnded(name, session, exit);
      },
      logger,
    });
    live.set(name, session);
    starting.delete(name);
    deps.registry?.add(pty.pid, startedAt);
    ensureWatchdog();
    const info = session.info();
    emitSession('created', info);
    logger.info('terminal.started', { pid: pty.pid, count: live.size });
    return info;
  }

  /** Waits for the first output of the child, the start timeout and a cancellation by `shutdown`, whichever comes first. */
  async function awaitStart(entry: Starting, pty: Pty): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        entry.abort = () => {
          reject(new TerminalError('SHUTTING_DOWN'));
        };
        timer = setTimeout(() => {
          reject(new TerminalError('START_TIMEOUT'));
        }, config.startTimeoutMs);
        pty.started.then(
          () => {
            resolve();
          },
          (error: unknown) => {
            reject(startFailure(error));
          },
        );
      });
    } finally {
      clearTimeout(timer);
      entry.abort = null;
    }
  }

  function logSpawnFailure(error: TerminalError): void {
    // A cancelled create is not a failure of the child.
    if (error.code !== 'SHUTTING_DOWN') logger.warn('terminal.spawn_failed', { code: error.code });
  }

  async function start(req: CreateSessionRequest): Promise<SessionInfo> {
    // Steps 1 to 8: synchronous, so the count check and the reservation of the name and the slot cannot race.
    if (draining) throw new TerminalError('SHUTTING_DOWN');
    const { support } = deps.backend;
    if (!support.supported) throw new TerminalError(CODE_OF_REASON[support.reason]);
    if (starting.size + live.size >= config.maxSessions) throw new TerminalError('SESSION_LIMIT');
    const folder = normalizeFolder(req.folder, platform);
    if (folder === null) throw new TerminalError('FOLDER_INVALID');
    if (!deps.fs.isDirectory(folder)) throw new TerminalError('FOLDER_NOT_FOUND');
    const env = deps.env();
    const resolved = resolveClaudeCommand({ command: config.command, env, platform, fs: deps.fs });
    if (resolved === null) throw new TerminalError('CLAUDE_NOT_FOUND');
    const launch = buildLaunch(resolved, config.args, {
      env,
      platform,
      fs: deps.fs,
      ...(req.resume === undefined ? {} : { resume: req.resume }),
      ...(req.fork === undefined ? {} : { fork: req.fork }),
    });
    const childEnv = buildTerminalEnv(env, { keep: config.envKeep, platform });
    const size = clampSessionSize(
      req.cols !== undefined && Number.isFinite(req.cols) ? req.cols : DEFAULT_COLS,
      req.rows !== undefined && Number.isFinite(req.rows) ? req.rows : DEFAULT_ROWS,
    ) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const name = names.next(sessionBase(folder));
    const entry: Starting = { pty: null, abort: null };
    starting.set(name, entry);

    // Step 9: the spawn. Its error is dropped: a native message holds file paths.
    let pty: Pty;
    try {
      pty = deps.backend.spawn(launch.file, launch.args, folder, size.cols, size.rows, childEnv);
    } catch (error) {
      starting.delete(name);
      const failure = startFailure(error);
      logSpawnFailure(failure);
      throw failure;
    }
    entry.pty = pty;

    // Step 10: the first output proves the child exists. A failure kills the child and frees the slot.
    try {
      await awaitStart(entry, pty);
      // The service started to go down while the child was starting: it must not outlive the decision.
      if (isDraining()) throw new TerminalError('SHUTTING_DOWN');
    } catch (error) {
      killQuietly(pty);
      starting.delete(name);
      const failure = startFailure(error);
      logSpawnFailure(failure);
      throw failure;
    }

    // Steps 11 and 12.
    return register(name, folder, pty, size);
  }

  function create(req: CreateSessionRequest): Promise<SessionInfo> {
    const attempt = start(req);
    inflight.add(attempt);
    const settled = (): void => {
      inflight.delete(attempt);
    };
    void attempt.then(settled, settled);
    return attempt;
  }

  // ---- queries ---------------------------------------------------------------------------------------------------------------

  function status(): TerminalStatus {
    const { support } = deps.backend;
    return {
      supported: support.supported,
      reason: support.supported ? null : support.reason,
      backend: deps.backend.name,
      claude: claudeFacts({ command: config.command, env: deps.env(), platform, fs: deps.fs, home: deps.home }),
      sessions: starting.size + live.size,
      maxSessions: config.maxSessions,
      conptyDll: config.conptyDll,
    };
  }

  function list(): SessionInfo[] {
    return [...live.values()].map((session) => session.info()).sort(compareSessions);
  }

  function liveCount(): number {
    pruneLost();
    stopWatchdogWhenIdle();
    return starting.size + live.size + lost.size;
  }

  async function lookupPids(root: number): Promise<number[]> {
    let found: readonly number[] | null;
    try {
      found = await deps.descendants(root);
    } catch {
      found = null;
    }
    const all = new Set<number>([root]);
    for (const pid of found ?? []) if (Number.isInteger(pid) && pid > 0) all.add(pid);
    return [...all].sort((a, b) => a - b);
  }

  function claudePids(name: string): Promise<number[]> {
    const session = live.get(name);
    // A session the watchdog found gone has no processes to list: its pid may belong to another program now.
    if (session === undefined || deadByWatchdog.has(name)) return Promise.resolve([]);
    const now = clock.now();
    const cached = pidsCache.get(name);
    if (cached !== undefined && now - cached.at < CLAUDE_PIDS_TTL_MS) return cached.pids;
    const pids = lookupPids(session.info().pid);
    pidsCache.set(name, { at: now, pids });
    return pids;
  }

  // ---- ending ----------------------------------------------------------------------------------------------------------------

  async function kill(name: string): Promise<boolean> {
    const session = live.get(name);
    if (session === undefined) return false;
    await session.kill('killed');
    return true;
  }

  async function killEverything(reason: 'killed' | 'shutdown'): Promise<void> {
    // All kills are asked in this tick; each session escalates on its own clock.
    await Promise.all([...live.values()].map((session) => session.kill(reason).catch(() => undefined)));
  }

  function beginDrain(): void {
    draining = true;
  }

  async function sweepOrphans(): Promise<SweepResult> {
    const { registry } = deps;
    if (registry === null) return NO_SWEEP;
    let result: SweepResult;
    try {
      result = await registry.sweep();
    } catch {
      return NO_SWEEP;
    }
    if (result.files > 0) {
      logger.info('terminal.sweep', { phase: 'files', count: result.files });
      logger.info('terminal.sweep', { phase: 'killed', count: result.killed });
      logger.info('terminal.sweep', { phase: 'skipped', count: result.skipped });
    }
    return result;
  }

  async function doShutdown(): Promise<void> {
    stopWatchdog();
    for (const entry of starting.values()) entry.abort?.();
    // An aborted create settles in microtasks; the bound only guards against a create that never does.
    await settleWithin(Promise.allSettled([...inflight]), config.startTimeoutMs);
    await settleWithin(killEverything('shutdown'), config.killTimeoutMs + SHUTDOWN_GRACE_MS);
    try {
      await deps.registry?.close();
    } catch {
      // The file is removed by the next sweep: a failure here must not keep the server from stopping.
    }
  }

  function shutdown(): Promise<void> {
    draining = true;
    shutdownPromise ??= doShutdown();
    return shutdownPromise;
  }

  function emergencyKillSync(): void {
    draining = true;
    const roots: number[] = [];
    // A session the watchdog found gone is only waiting for its end to be recorded: its pid may belong to another program now.
    for (const [name, session] of live) if (!deadByWatchdog.has(name)) roots.push(session.info().pid);
    for (const pid of lost.values()) if (deps.pidAlive(pid)) roots.push(pid);
    for (const entry of starting.values()) if (entry.pty !== null) roots.push(entry.pty.pid);
    for (const pid of roots) {
      // 0 is a child that has not reported its pid yet: nothing to address.
      if (pid <= 0) continue;
      try {
        deps.killSync(pid);
      } catch {
        // The process is gone or not ours to end; the next pid still gets its turn.
      }
    }
  }

  return {
    status,
    create,
    list,
    get: (name) => live.get(name),
    kill,
    killAll: () => killEverything('killed'),
    liveCount,
    beginDrain,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    claudePids,
    sweepOrphans,
    shutdown,
    emergencyKillSync,
  };
}
