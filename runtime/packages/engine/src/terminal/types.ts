// The interfaces of the terminal service (design 01 section 3.1). Types only: no value, no import of a module with effects.
// `Pty` and `PtyBackend` are the seam between the service and node-pty; everything above them is platform-neutral.

export type Unsubscribe = () => void;

/** How a pty child ended, as the OS gave it (Windows: a signed 32 bit code, for example -1073741510). */
export interface PtyExit {
  readonly code: number | null;
}

export interface Pty {
  /** 0 until `started` resolved. */
  readonly pid: number;
  /** Resolves when the child exists and its first output arrived; rejects with TerminalError SPAWN_FAILED or START_TIMEOUT. */
  readonly started: Promise<{ readonly pid: number }>;
  onData(listener: (chunk: Buffer) => void): Unsubscribe;
  onExit(listener: (exit: PtyExit) => void): Unsubscribe;
  /** Ignored after the exit. */
  write(data: string | Uint8Array): void;
  /** Never throws. */
  resize(cols: number, rows: number): void;
  /** Idempotent and never throws; `onExit` fires when the process tree is gone. */
  kill(): void;
}

export type UnsupportedReason = 'unsupported-os' | 'os-too-old' | 'native-missing' | 'native-load-failed';

export type TerminalSupport =
  { readonly supported: true } | { readonly supported: false; readonly reason: UnsupportedReason };

export interface PtyBackend {
  readonly name: 'node-pty' | 'unsupported' | 'fake';
  readonly support: TerminalSupport;
  /**
   * `args` as a string is the Windows pre-escaped command line tail, used only on the cmd.exe /s route; elsewhere it is an
   * argv array.
   */
  spawn(
    cmd: string,
    args: readonly string[] | string,
    cwd: string,
    cols: number,
    rows: number,
    env: Readonly<Record<string, string>>,
  ): Pty;
}

export interface SessionExit {
  readonly code: number | null;
  readonly reason: 'exited' | 'killed' | 'shutdown' | 'lost';
}

export interface ViewerEnd {
  readonly reason: 'exited' | 'killed' | 'shutdown' | 'slow' | 'error';
  readonly exit?: SessionExit;
}

export interface Viewer {
  /** May throw for a dead peer: the session then detaches the viewer. */
  send(chunk: Uint8Array): void;
  /** Bytes queued for the peer (the WebSocket `bufferedAmount`); drives the eviction of a slow viewer. */
  pendingBytes?(): number;
  /** Called once. */
  end(reason: ViewerEnd): void;
}

export interface SessionInfo {
  /** The MTOP pattern `^[A-Za-z0-9_-]{1,64}$`, unique for the life of the service. */
  readonly name: string;
  /** The normalized folder (`D:\x`), in the spelling the user gave. */
  readonly cwd: string;
  /** The root process: claude.exe, or cmd.exe on the shim route. */
  readonly pid: number;
  /** Epoch milliseconds of the service clock. */
  readonly startedAt: number;
  /** The size applied to the pty. */
  readonly cols: number;
  readonly rows: number;
  readonly viewers: number;
}

export interface TerminalSession {
  info(): SessionInfo;
  /** Throws SESSION_ENDED once the session is over. */
  attach(viewer: Viewer, opts?: { replay?: boolean }): { replayedBytes: number; cols: number; rows: number };
  detach(viewer: Viewer): void;
  /** MESSAGE_TOO_LARGE above `maxInputBytes`; ignored after the exit. */
  write(data: Uint8Array | string): void;
  /** The last call wins; clamped and debounced. */
  resize(cols: number, rows: number): void;
  kill(): Promise<SessionExit>;
}

export interface CreateSessionRequest {
  /** Any of `D:\x`, `D:/x`, `/mnt/d/x`. */
  readonly folder: string;
  /** Default 120 x 30 (MTOP), clamped. */
  readonly cols?: number;
  readonly rows?: number;
  /** A Claude session id: becomes `--resume <id>` after validation against RESUME_ID_RE. */
  readonly resume?: string;
}

export interface TerminalStatus {
  readonly supported: boolean;
  readonly reason: UnsupportedReason | null;
  readonly backend: PtyBackend['name'];
  /** `display` is the resolved program with the home folder shortened to `~`. */
  readonly claude: { readonly found: boolean; readonly kind: 'exe' | 'shim' | null; readonly display: string | null };
  readonly sessions: number;
  readonly maxSessions: number;
  readonly conptyDll: boolean;
}

export type TerminalChange =
  | { readonly type: 'created' | 'updated'; readonly session: SessionInfo; readonly version: number }
  | { readonly type: 'ended'; readonly session: SessionInfo; readonly exit: SessionExit; readonly version: number };

/** Implemented by the child registry (design 01 section 5); declared here so the service does not depend on that file. */
export interface ChildRegistry {
  add(pid: number, spawnedAtMs: number): void;
  remove(pid: number): void;
  /** Deletes this owner's file. */
  close(): Promise<void>;
  sweep(): Promise<SweepResult>;
}

export interface SweepResult {
  readonly files: number;
  readonly killed: number;
  readonly skipped: number;
}
