// The ports of the terminal (CAW design 02 section 8, ADR 0084): types only. The server never starts a process and never opens
// the driver, so everything that spawns, attaches or touches the disk lives behind these interfaces; the engine (areas pty and
// projects) implements them and `boot.ts` adapts names where they differ. Routes call the port and nothing else.
//
// The vocabulary of a failure is the engine's `TerminalError` (a `name` of `TerminalError` and a `code`): `mapError` of
// `errors.ts` recognises it by name and answers the code of the catalogue, so a port throws it and the route adds no mapping.
// A port never puts a folder path, a session name or an argument into an error message (the message is a fixed sentence).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { TerminalCapabilities, TerminalSessionInfo } from '@mcs/shared';

/** How a process ended: the exit code (or the signal) and whether the kill route ended it. */
export interface TerminalExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly killed: boolean;
}

/** One viewer of a session: what the session tells it. Called synchronously by the session; a viewer never throws. */
export interface TerminalViewer {
  onData(chunk: Uint8Array): void;
  onSize(cols: number, rows: number): void;
  onExit(exit: TerminalExit): void;
}

/** What `attach` returns: the replay snapshot and the size, and the way to leave. */
export interface TerminalAttachment {
  readonly replay: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** Stops the viewer. Idempotent. */
  detach(): void;
}

/** One live session as the socket gateway uses it. */
export interface TerminalSessionPort {
  readonly name: string;
  /** The snapshot and the subscription of the viewer in one synchronous call: no byte is lost or doubled between them. */
  attach(viewer: TerminalViewer): TerminalAttachment;
  /** Input bytes for the process, unchanged. */
  write(data: Uint8Array): void;
  /** A size already clamped by the caller (`clampTerminalSize`). */
  resize(cols: number, rows: number): void;
}

/** The sessions of the host. */
export interface TerminalSessionsPort {
  /** The live sessions, at most the cap of the host. */
  list(): readonly TerminalSessionInfo[];
  /** The session of a name that matched `TERMINAL_NAME_RE`, or `null`. */
  get(name: string): TerminalSessionPort | null;
  /** Starts `claude` in a folder (the engine normalises the path and checks the directory); names are `<folder>-<n>`. */
  create(input: { readonly path: string }): Promise<TerminalSessionInfo>;
  /** Kills the process of a session; `false` for an unknown name. Its viewers get `onExit` with `killed: true`. */
  kill(name: string): Promise<boolean>;
  /** `listener` runs when the membership or a link changes (not on output). Returns the way to stop listening. */
  subscribe(listener: () => void): () => void;
}

/** The folder dialog (PowerShell and WinForms, engine only). */
export interface FolderPickerPort {
  /**
   * Waits for the person to choose a folder: the path, or `null` when the dialog was closed. `signal` aborts when the client
   * leaves: the engine closes the dialog. A second concurrent call throws a `TerminalError` of `picker_busy`.
   */
  pick(signal: AbortSignal): Promise<string | null>;
}

/** Everything the terminal routes and the event feed ask of the host. */
export interface TerminalPorts {
  /** What the host can do here, and why not (`available: false` makes every terminal route answer `terminal_unavailable`). */
  readonly capabilities: () => TerminalCapabilities;
  readonly sessions: TerminalSessionsPort;
  /** `null` where there is no dialog (a platform without one). */
  readonly picker: FolderPickerPort | null;
  /** Plans the folder and the arguments from the monitor's facts, links and spawns `claude --resume`; throws `TerminalError`. */
  resume(input: { readonly sessionId: string; readonly fork: boolean }): Promise<TerminalSessionInfo>;
}

/** What the gateway of the socket route needs to be handed (design 02 5.3; the implementation is the WS-SOCKET package). */
export interface TerminalSocketRequest {
  readonly req: IncomingMessage;
  readonly socket: Duplex;
  /** The bytes read after the upgrade request. */
  readonly head: Buffer;
  readonly name: string;
  readonly session: TerminalSessionPort;
  /** The credential the access guard admitted: a revocation closes the socket with 4003. */
  readonly credentialId: string;
}

/** The WebSocket side of the terminal: counted sockets, one per upgrade, closed by credential or all at once. */
export interface TerminalGateway {
  /** Throws `ApiError('stream_limit')` above the caps (total sockets, viewers of one session). */
  admit(name: string): void;
  /** Completes the upgrade and starts the protocol on the socket. */
  accept(request: TerminalSocketRequest): void;
  /** Closes the sockets of one credential; returns how many. */
  closeByCredential(credentialId: string, code: number, reason: string): number;
  /** Closes every socket (shutdown) and waits for the grace period. */
  closeAll(code: number, reason: string): Promise<void>;
  /** The number of open sockets. */
  readonly size: number;
}
