// One terminal session (design 01 section 3.9): a started pty, the last megabyte of its output in RAM, any number of viewers,
// the last resize wins. The service (manager.ts) creates it after `Pty.started` and owns the name, the slot and the registry.
// Node is single-threaded, so no output can slip between the replay snapshot and the registration of a viewer: no lock.
import type { Clock } from '@mcs/shared';

import type { Logger } from '../log/logger.ts';
import { TerminalError } from './errors.ts';
import { MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, RESIZE_DEBOUNCE_MS, VIEWER_BACKLOG_LIMIT_BYTES } from './limits.ts';
import { ReplayBuffer, prepareReplay, replayFrames } from './replay.ts';
import type {
  Pty,
  PtyExit,
  SessionExit,
  SessionInfo,
  TerminalSession,
  Unsubscribe,
  Viewer,
  ViewerEnd,
} from './types.ts';

/** After the tree kill the session waits this long for the exit event before it is declared `lost`. */
export const KILL_TREE_WAIT_MS = 2000;

/** The logger of the session: only the closed field list of the logger is used (`pid`, `phase`, `code`, `durationMs`). */
export type SessionLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

export interface SessionOptions {
  /** Unique for the life of the service; it appears in URLs, never in a log line. */
  readonly name: string;
  /** The normalized working folder; never logged. */
  readonly cwd: string;
  /** Already started: `pid` is known and the first output has arrived. */
  readonly pty: Pty;
  /** Epoch milliseconds of the service clock. */
  readonly startedAt: number;
  /** The size the pty was spawned with (clamped here as well). */
  readonly cols: number;
  readonly rows: number;
  /** Replay buffer capacity (`terminal.replayBytes`). */
  readonly replayBytes: number;
  /** Largest single `write` (`terminal.maxInputBytes`). */
  readonly maxInputBytes: number;
  /** How long to wait for the exit after `pty.kill()` before the tree kill (`terminal.killTimeoutMs`). */
  readonly killTimeoutMs: number;
  readonly clock: Clock;
  /** The one tree-kill implementation (`forceKillTree`); its rejection is ignored. */
  readonly killTree: (pid: number) => Promise<void>;
  /** A viewer came, left or was evicted, or a resize was applied. Never called after the end. */
  readonly onUpdated: () => void;
  /** The session is over, with how; called once, before `kill()` resolves. */
  readonly onEnded: (exit: SessionExit) => void;
  readonly logger?: SessionLogger;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** A terminal size within 20..500 columns and 5..200 rows, fractions cut; null when a value is not a finite number. */
export function clampSessionSize(cols: number, rows: number): { cols: number; rows: number } | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return { cols: clamp(cols, MIN_COLS, MAX_COLS), rows: clamp(rows, MIN_ROWS, MAX_ROWS) };
}

function viewerReason(reason: SessionExit['reason']): 'exited' | 'killed' | 'shutdown' {
  // A session that was declared lost has no better word for a viewer than "exited"; `exit.reason` carries the detail.
  return reason === 'lost' ? 'exited' : reason;
}

export class Session implements TerminalSession {
  readonly #name: string;
  readonly #cwd: string;
  readonly #pty: Pty;
  readonly #startedAt: number;
  readonly #maxInputBytes: number;
  readonly #killTimeoutMs: number;
  readonly #clock: Clock;
  readonly #killTree: (pid: number) => Promise<void>;
  readonly #onUpdated: () => void;
  readonly #onEnded: (exit: SessionExit) => void;
  readonly #logger: SessionLogger | undefined;
  /** In attach order (a Map iterates in insertion order). */
  readonly #viewers = new Map<Viewer, true>();
  readonly #unsubscribe: Unsubscribe[] = [];
  readonly #ended: Promise<SessionExit>;
  #resolveEnded: (exit: SessionExit) => void = () => undefined;
  /** Null once the session is over: the replay is released, nothing can attach any more. */
  #replay: ReplayBuffer | null;
  #size: { cols: number; rows: number };
  #pendingSize: { cols: number; rows: number } | null = null;
  #resizeTimer: NodeJS.Timeout | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  #killReason: 'killed' | 'shutdown' | null = null;
  #exit: SessionExit | null = null;

  constructor(options: SessionOptions) {
    this.#name = options.name;
    this.#cwd = options.cwd;
    this.#pty = options.pty;
    this.#startedAt = options.startedAt;
    this.#maxInputBytes = options.maxInputBytes;
    this.#killTimeoutMs = options.killTimeoutMs;
    this.#clock = options.clock;
    this.#killTree = options.killTree;
    this.#onUpdated = options.onUpdated;
    this.#onEnded = options.onEnded;
    this.#logger = options.logger;
    this.#replay = new ReplayBuffer(options.replayBytes);
    this.#size = clampSessionSize(options.cols, options.rows) ?? { cols: MIN_COLS, rows: MIN_ROWS };
    this.#ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });
    this.#unsubscribe.push(
      this.#pty.onData((chunk) => {
        this.#pump(chunk);
      }),
      this.#pty.onExit((exit) => {
        this.#onPtyExit(exit);
      }),
    );
  }

  info(): SessionInfo {
    return {
      name: this.#name,
      cwd: this.#cwd,
      pid: this.#pty.pid,
      startedAt: this.#startedAt,
      cols: this.#size.cols,
      rows: this.#size.rows,
      viewers: this.#viewers.size,
    };
  }

  attach(viewer: Viewer, opts?: { replay?: boolean }): { replayedBytes: number; cols: number; rows: number } {
    if (this.#exit !== null || this.#replay === null) throw new TerminalError('SESSION_ENDED');
    if (this.#viewers.has(viewer)) return { replayedBytes: 0, cols: this.#size.cols, rows: this.#size.rows };
    let replayedBytes = 0;
    if (opts?.replay !== false) {
      const bytes = prepareReplay(this.#replay.snapshot(), this.#replay.trimmed);
      try {
        for (const frame of replayFrames(bytes)) {
          viewer.send(frame);
          replayedBytes += frame.length;
        }
      } catch {
        // The peer is gone before it saw the replay: it is never registered.
        this.#end(viewer, { reason: 'error' });
        this.#logger?.warn('terminal.viewer_evicted', { code: 'error' });
        return { replayedBytes, cols: this.#size.cols, rows: this.#size.rows };
      }
    }
    this.#viewers.set(viewer, true);
    this.#updated();
    return { replayedBytes, cols: this.#size.cols, rows: this.#size.rows };
  }

  detach(viewer: Viewer): void {
    if (this.#viewers.delete(viewer)) this.#updated();
  }

  write(data: Uint8Array | string): void {
    if (this.#exit !== null) return;
    const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    if (size > this.#maxInputBytes) throw new TerminalError('MESSAGE_TOO_LARGE');
    if (size === 0) return;
    try {
      this.#pty.write(data);
    } catch {
      // A write that fails means the process is already ending; its exit event follows. The caller has no use for the cause.
    }
  }

  resize(cols: number, rows: number): void {
    if (this.#exit !== null) return;
    const wanted = clampSessionSize(cols, rows);
    if (wanted === null) return;
    const pending = this.#pendingSize;
    if (pending !== null && pending.cols === wanted.cols && pending.rows === wanted.rows) return;
    if (wanted.cols === this.#size.cols && wanted.rows === this.#size.rows) {
      // Back to the size the process already has: whatever was pending is void.
      this.#pendingSize = null;
      this.#clearResizeTimer();
      return;
    }
    this.#pendingSize = wanted;
    this.#clearResizeTimer();
    this.#resizeTimer = setTimeout(() => {
      this.#applyResize();
    }, RESIZE_DEBOUNCE_MS);
    // A pending resize alone must not keep the process alive.
    this.#resizeTimer.unref();
  }

  /**
   * Ends the process. Idempotent: every call returns the same promise, and the first `reason` wins (`shutdown` is the service
   * going down, `killed` everything else). Steps: `pty.kill()`, wait `killTimeoutMs` for the exit, then the injected tree kill,
   * wait {@link KILL_TREE_WAIT_MS}, then give up and finalise as `lost`.
   */
  kill(reason: 'killed' | 'shutdown' = 'killed'): Promise<SessionExit> {
    if (this.#exit === null && this.#killReason === null) {
      this.#killReason = reason;
      this.#logger?.info('terminal.kill', { pid: this.#pty.pid, phase: 'request' });
      // The timer first: a pty may report its exit from inside kill().
      this.#killTimer = setTimeout(() => {
        this.#escalate();
      }, this.#killTimeoutMs);
      try {
        this.#pty.kill();
      } catch {
        // Never throws by contract; a process that is already dead is what we wanted.
      }
    }
    return this.#ended;
  }

  // ---- output ----------------------------------------------------------------------------------------------------------

  #pump(chunk: Buffer): void {
    if (this.#exit !== null || this.#replay === null) return;
    this.#replay.append(chunk);
    const evicted: { viewer: Viewer; reason: 'slow' | 'error' }[] = [];
    // A snapshot: a viewer that attaches from inside `send` got this chunk through its replay and must not get it again, and
    // one that detached meanwhile (or that the session ended) is skipped.
    for (const viewer of [...this.#viewers.keys()]) {
      if (!this.#viewers.has(viewer)) continue;
      try {
        viewer.send(chunk);
        if ((viewer.pendingBytes?.() ?? 0) > VIEWER_BACKLOG_LIMIT_BYTES) evicted.push({ viewer, reason: 'slow' });
      } catch {
        evicted.push({ viewer, reason: 'error' });
      }
    }
    // The pty is never paused for a slow viewer: that would freeze the others (node-pty on Windows has no flow control).
    for (const { viewer, reason } of evicted) {
      if (!this.#viewers.delete(viewer)) continue;
      this.#end(viewer, { reason });
      this.#logger?.warn('terminal.viewer_evicted', { code: reason });
    }
    if (evicted.length > 0) this.#updated();
  }

  #end(viewer: Viewer, reason: ViewerEnd): void {
    try {
      viewer.end(reason);
    } catch {
      // The peer is already gone.
    }
  }

  #updated(): void {
    try {
      this.#onUpdated();
    } catch {
      // The owner's listener must not break the session.
    }
  }

  // ---- resize ----------------------------------------------------------------------------------------------------------

  #clearResizeTimer(): void {
    if (this.#resizeTimer === null) return;
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = null;
  }

  #applyResize(): void {
    this.#resizeTimer = null;
    const wanted = this.#pendingSize;
    this.#pendingSize = null;
    if (this.#exit !== null || wanted === null) return;
    try {
      this.#pty.resize(wanted.cols, wanted.rows);
    } catch {
      // Never throws by contract.
    }
    this.#size = wanted;
    this.#updated();
  }

  // ---- end -------------------------------------------------------------------------------------------------------------

  #escalate(): void {
    this.#killTimer = null;
    if (this.#exit !== null) return;
    const pid = this.#pty.pid;
    this.#logger?.warn('terminal.kill', { pid, phase: 'escalate' });
    if (pid > 0) {
      try {
        this.#killTree(pid).catch(() => undefined);
      } catch {
        // The tree kill could not even start; the wait below still ends the session.
      }
    }
    this.#killTimer = setTimeout(() => {
      this.#lose();
    }, KILL_TREE_WAIT_MS);
  }

  #lose(): void {
    this.#killTimer = null;
    if (this.#exit !== null) return;
    this.#logger?.error('terminal.kill', { pid: this.#pty.pid, phase: 'lost' });
    this.#finalise({ code: null, reason: 'lost' });
  }

  #onPtyExit(exit: PtyExit): void {
    this.#finalise({ code: exit.code, reason: this.#killReason ?? 'exited' });
  }

  #finalise(exit: SessionExit): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    this.#clearResizeTimer();
    this.#pendingSize = null;
    if (this.#killTimer !== null) {
      clearTimeout(this.#killTimer);
      this.#killTimer = null;
    }
    for (const stop of this.#unsubscribe) stop();
    this.#unsubscribe.length = 0;
    // Nothing can attach any more: release the replay.
    this.#replay = null;
    const viewers = [...this.#viewers.keys()];
    this.#viewers.clear();
    const reason: ViewerEnd = { reason: viewerReason(exit.reason), exit };
    for (const viewer of viewers) this.#end(viewer, reason);
    this.#logger?.info('terminal.exited', {
      pid: this.#pty.pid,
      ...(exit.code === null ? {} : { code: exit.code }),
      durationMs: Math.max(0, this.#clock.now() - this.#startedAt),
    });
    try {
      this.#onEnded(exit);
    } catch {
      // The owner's listener must not keep kill() from resolving.
    }
    this.#resolveEnded(exit);
  }
}
