// The terminal host (CAW-31, design 02 section 8, design 03 5.4 and 6, ADR 0084): the engine object that the server's terminal
// ports are made of. It joins the terminal service (processes and replay), the linker (which monitored session a terminal is) and the
// folder service (the plan of a resume) into the shape the routes, the socket gateway and the event feed ask for:
//   - `sessions` is the list of rows (`TerminalSessionInfo`: the process facts of the service, the link of the linker, the folder
//     key), `get` the port of one session for the gateway, `create` and `kill`, and `subscribe` for membership, viewer and link changes;
//   - `attach` is one synchronous call: the replay frames that the service sends while attaching are collected into one snapshot, then
//     the same viewer is fed live (the single thread makes the hand-over lossless); size changes come from the service's change feed;
//   - `create` takes the link after the service created the process (`linker.track`), and the `ended` change forgets it;
//   - `resume` asks the folder service for the plan, then creates `claude --resume <id>` (`--fork-session` for a copy) and tracks it;
//   - `capabilities` says what this host can do, with the shared reasons; `census` is what a stop must not drop.
// The engine never imports the server: the types below mirror `server/src/terminal/ports.ts` member for member, and the host is
// assignable to its `TerminalPorts` (the server adapts nothing but names). A failure that the server shows is an `Error` named
// `TerminalError` with a `code`: the engine's own `TerminalError` (upper case codes, mapped there) or a `TerminalApiError` (the
// catalogue's lower case codes). Nothing here logs: a session name, a folder or a session id is private to the person.
import {
  isoMsZ,
  type Clock,
  type TerminalApiErrorCode,
  type TerminalCapabilities,
  type TerminalLink,
  type TerminalSessionInfo,
  type TerminalUnavailableReason,
} from '@mcs/shared';

import { ResumeRefusal, type ResumePlan } from '../folders/resume.ts';
import type { FolderService } from '../folders/service.ts';
import type { TerminalLinker } from '../link/types.ts';
import { folderKeyOfPath } from '../projects/folder-key.ts';
import type { TerminalCensus } from '../runtime/user-services.ts';
import { TerminalError } from './errors.ts';
import type { FolderPickerPort } from './folder-picker.ts';
import type { TerminalService } from './manager.ts';
import type {
  CreateSessionRequest,
  SessionInfo,
  TerminalChange,
  TerminalSession,
  TerminalStatus,
  Viewer,
  ViewerEnd,
} from './types.ts';

// ---- errors ---------------------------------------------------------------------------------------------------------------------

/** One entry of `details` of an error: where and why, never a value. */
export interface TerminalApiErrorDetail {
  readonly path: string;
  readonly issue: string;
}

const API_MESSAGES: Readonly<Record<TerminalApiErrorCode, string>> = {
  terminal_unavailable: 'The terminal is not available.',
  claude_not_found: 'The claude command was not found on the search path.',
  folder_invalid: 'The folder is not a valid working folder.',
  terminal_limit: 'The limit of terminal sessions is reached.',
  terminal_not_found: 'There is no terminal session with this name.',
  session_not_found: 'There is no monitored session with this id.',
  resume_unavailable: 'This session cannot be resumed in a terminal.',
  picker_busy: 'A folder dialog is already open.',
};

/**
 * A failure of the terminal in the vocabulary of the HTTP catalogue (lower case code). It is named `TerminalError` like the engine's
 * own class, which is how the server's error mapper recognises both (a source and a build copy of a class map alike); a code of
 * the catalogue passes through unchanged and `details` becomes the `details` of the envelope. The message is a fixed sentence of the
 * code: it never holds a path, a name, an id or the text of another error.
 */
export class TerminalApiError extends Error {
  readonly code: TerminalApiErrorCode;
  readonly details: readonly TerminalApiErrorDetail[] | undefined;

  constructor(code: TerminalApiErrorCode, details?: readonly TerminalApiErrorDetail[], options?: { cause?: unknown }) {
    super(API_MESSAGES[code], options);
    this.name = 'TerminalError';
    this.code = code;
    this.details = details;
  }
}

// ---- the ports (a copy of `server/src/terminal/ports.ts`, by member) -------------------------------------------------------------

/** How a process ended, as a viewer is told: the code, the signal (or why the view ended without the process), and the kill route. */
export interface HostExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly killed: boolean;
}

/** One viewer of a session. Called synchronously by the session. */
export interface HostViewer {
  onData(chunk: Uint8Array): void;
  onSize(cols: number, rows: number): void;
  onExit(exit: HostExit): void;
}

/** What `attach` returns: the replay snapshot and the size, and the way to leave. */
export interface HostAttachment {
  readonly replay: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** Stops the viewer. Idempotent. */
  detach(): void;
}

/** One live session as the socket gateway uses it. */
export interface HostSession {
  readonly name: string;
  attach(viewer: HostViewer): HostAttachment;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
}

/** The sessions of the host. */
export interface HostSessions {
  list(): readonly TerminalSessionInfo[];
  get(name: string): HostSession | null;
  create(input: { readonly path: string }): Promise<TerminalSessionInfo>;
  kill(name: string): Promise<boolean>;
  /** `listener` runs when the membership, a viewer count, a size or a link changes (not on output). */
  subscribe(listener: () => void): () => void;
}

export interface TerminalHost {
  /** What the host can do here, and why not. Cheap: no process is started and no addon is loaded. */
  capabilities(): TerminalCapabilities;
  readonly sessions: HostSessions;
  /** `null` where there is no dialog. */
  readonly picker: FolderPickerPort | null;
  /** Plans the folder and the arguments from the monitor's facts, creates `claude --resume`, tracks it. */
  resume(input: { readonly sessionId: string; readonly fork: boolean }): Promise<TerminalSessionInfo>;
  /** The count and the list of what a stop would drop, and the drain; the shutdown decision of the control channel reads it. */
  readonly census: TerminalCensus;
  /** Takes the host off the service and the linker. Idempotent. */
  close(): void;
}

// ---- capabilities ---------------------------------------------------------------------------------------------------------------

/** What `capabilitiesOf` reads: the part of `TerminalStatus` and of `TerminalDiagnosis` that both hold. */
export interface CapabilityFacts {
  readonly supported: boolean;
  readonly reason: TerminalStatus['reason'];
  readonly claude: { readonly found: boolean };
}

const UNAVAILABLE_REASON: Readonly<Record<NonNullable<TerminalStatus['reason']>, TerminalUnavailableReason>> = {
  'unsupported-os': 'unsupported_os',
  'os-too-old': 'unsupported_os',
  'native-missing': 'addon_missing',
  'native-load-failed': 'addon_missing',
};

/**
 * The capabilities of a host for the shared reasons: a host that cannot run the terminal says why (`unsupported_os` for an operating
 * system that ships no addon or is too old, `addon_missing` for an addon that is missing or does not load); a host that can, but
 * finds no `claude`, says `claude_not_found`. An unavailable host offers nothing else (no picker, no resume, no sessions).
 */
export function capabilitiesOf(
  facts: CapabilityFacts,
  o: { readonly folderPicker: boolean; readonly maxSessions: number },
): TerminalCapabilities {
  const unavailable = (reason: TerminalUnavailableReason): TerminalCapabilities => ({
    available: false,
    reason,
    folderPicker: false,
    resume: false,
    maxSessions: 0,
  });
  if (!facts.supported) return unavailable(facts.reason === null ? 'addon_missing' : UNAVAILABLE_REASON[facts.reason]);
  if (!facts.claude.found) return unavailable('claude_not_found');
  return { available: true, reason: null, folderPicker: o.folderPicker, resume: true, maxSessions: o.maxSessions };
}

// ---- the host -------------------------------------------------------------------------------------------------------------------

export interface TerminalHostDeps {
  readonly service: TerminalService;
  readonly folders: Pick<FolderService, 'planResume'>;
  readonly linker: Pick<TerminalLinker, 'track' | 'forget' | 'link' | 'onChange'>;
  readonly picker: FolderPickerPort | null;
  /** The spawn time given to the linker is read here, just before the service creates the process. */
  readonly clock: Clock;
}

/** The link of a terminal that the linker does not know (yet): the state `track` starts in. */
function pendingLink(): TerminalLink {
  return {
    status: 'pending',
    sessionId: null,
    previousSessionIds: [],
    basis: null,
    confidence: null,
    since: null,
    claudePid: null,
    transcript: 'none',
    registryStatus: null,
    waitingFor: null,
    reason: null,
    shared: false,
  };
}

/** The engine's reason for ending a view, as a viewer is told. `slow` and `error` end the view, not the process: no code, the reason as the signal. */
function exitOf(end: ViewerEnd): HostExit {
  const evicted = end.reason === 'slow' || end.reason === 'error';
  return { code: end.exit?.code ?? null, signal: evicted ? end.reason : null, killed: end.reason === 'killed' };
}

/** What a viewer of the host is: the callbacks, the size it was last told, and the engine viewer that feeds it. */
interface Attached {
  readonly viewer: HostViewer;
  cols: number;
  rows: number;
}

function isoOf(ms: number): string {
  return isoMsZ(ms);
}

export function createTerminalHost(deps: TerminalHostDeps): TerminalHost {
  const { service, linker, picker, clock } = deps;
  /** The viewers of each live session, for the size changes. */
  const attached = new Map<string, Set<Attached>>();
  const listeners = new Set<() => void>();
  let closed = false;

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a listener that throws must not keep the others from hearing the change, nor break the service
      }
    }
  }

  function rowOf(info: SessionInfo): TerminalSessionInfo {
    const key = folderKeyOfPath(info.cwd);
    return {
      name: info.name,
      path: info.cwd,
      createdAt: isoOf(info.startedAt),
      cols: info.cols,
      rows: info.rows,
      viewers: info.viewers,
      link: linker.link(info.name) ?? pendingLink(),
      // a name that Claude cut at 200 characters has a hash after it that is unknown here: no key is better than a partial one
      folderKey: key.prefix || key.key === '' ? null : key.key,
    };
  }

  const stopService = service.onChange((change: TerminalChange) => {
    if (change.type === 'ended') {
      // the link first, so that a list read by a listener is already without the session
      linker.forget(change.session.name);
      attached.delete(change.session.name);
    } else if (change.type === 'updated') {
      const viewers = attached.get(change.session.name);
      if (viewers !== undefined) {
        for (const entry of [...viewers]) {
          if (entry.cols === change.session.cols && entry.rows === change.session.rows) continue;
          entry.cols = change.session.cols;
          entry.rows = change.session.rows;
          entry.viewer.onSize(entry.cols, entry.rows);
        }
      }
    }
    notify();
  });
  const stopLinker = linker.onChange(() => {
    notify();
  });

  async function createTracked(request: CreateSessionRequest): Promise<TerminalSessionInfo> {
    const spawnedAtMs = clock.now();
    let info: SessionInfo;
    try {
      info = await service.create(request);
    } catch (error) {
      if (error instanceof TerminalError && error.code === 'SESSION_LIMIT') {
        throw new TerminalApiError('terminal_limit', undefined, { cause: error });
      }
      throw error;
    }
    linker.track({
      name: info.name,
      pid: info.pid,
      cwd: info.cwd,
      spawnedAtMs,
      resumeSessionId: request.resume ?? null,
      fork: request.fork === true,
      nameToken: null,
    });
    return rowOf(info);
  }

  function portOf(name: string, session: TerminalSession): HostSession {
    return {
      name,
      attach(viewer): HostAttachment {
        const frames: Uint8Array[] = [];
        let collecting = true;
        // read through the object: the compiler does not see that `end` changes it while `attach` runs
        const state = { detached: false };
        const entry: Attached = { viewer, cols: 0, rows: 0 };
        const engineViewer: Viewer = {
          send(chunk) {
            // the frames of the replay come inside `session.attach`; everything after that is live output
            if (collecting) frames.push(chunk);
            else viewer.onData(chunk);
          },
          end(reason) {
            attached.get(name)?.delete(entry);
            state.detached = true;
            viewer.onExit(exitOf(reason));
          },
        };
        const applied = session.attach(engineViewer, { replay: true });
        collecting = false;
        entry.cols = applied.cols;
        entry.rows = applied.rows;
        if (!state.detached) {
          const set = attached.get(name) ?? new Set<Attached>();
          set.add(entry);
          attached.set(name, set);
        }
        return {
          replay: Buffer.concat(frames),
          cols: applied.cols,
          rows: applied.rows,
          detach() {
            if (state.detached) return;
            state.detached = true;
            attached.get(name)?.delete(entry);
            session.detach(engineViewer);
          },
        };
      },
      write: (data) => {
        session.write(data);
      },
      resize: (cols, rows) => {
        session.resize(cols, rows);
      },
    };
  }

  const sessions: HostSessions = {
    list: () => service.list().map(rowOf),
    get: (name) => {
      const session = service.get(name);
      return session === undefined ? null : portOf(name, session);
    },
    create: (input) => createTracked({ folder: input.path }),
    kill: (name) => service.kill(name),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  async function planOf(sessionId: string, fork: boolean): Promise<ResumePlan> {
    try {
      return await deps.folders.planResume(sessionId, { fork });
    } catch (error) {
      if (!(error instanceof ResumeRefusal)) throw error;
      // the reason is the issue; the terminal that holds the session is not named (the person sees it in the list)
      if (error.code === 'session_not_found')
        throw new TerminalApiError('session_not_found', undefined, { cause: error });
      throw new TerminalApiError('resume_unavailable', [{ path: 'sessionId', issue: error.code }], { cause: error });
    }
  }

  const census: TerminalCensus = {
    count: () => service.liveCount(),
    sessions: (limit) =>
      service
        .list()
        .slice(0, Math.max(0, limit))
        .map((info) => ({ name: info.name, startedAt: isoOf(info.startedAt) })),
    beginDrain: () => {
      service.beginDrain();
    },
  };

  return {
    capabilities: () => {
      const status = service.status();
      return capabilitiesOf(status, { folderPicker: picker !== null, maxSessions: status.maxSessions });
    },
    sessions,
    picker,
    resume: async ({ sessionId, fork }) => {
      const plan = await planOf(sessionId, fork);
      return createTracked({ folder: plan.folderPath, resume: plan.sessionId, ...(fork ? { fork: true } : {}) });
    },
    census,
    close: () => {
      if (closed) return;
      closed = true;
      stopService();
      stopLinker();
      listeners.clear();
      attached.clear();
    },
  };
}
