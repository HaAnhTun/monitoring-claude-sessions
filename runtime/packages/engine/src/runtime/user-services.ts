// The seam between the instance runtime and what only the user instance has (06 1.7, ADR 0091, ADR 0093, ADR 0094): the census of
// the terminal sessions that the stop guard and the control op `terminals` read, the minter of the one-use access code that the
// control op `access` calls, and the components that start with the runtime (the terminal host, the folder picker). A task
// instance has none of it: `InstanceRuntime.user` is `null` there.
//
// The real services are made by `createUserServices` (`create-user-services.ts`, CAW-31) and registered as
// `RuntimeFactories.createUserServices`; `EMPTY_USER_SERVICES` stands in where none is wanted (tests): no sessions, no minter, no
// components. This module holds the contract, the empty services and the one rule the server applies to a shutdown request
// (`decideShutdown`). It imports no HTTP, no child process and no terminal code (types only): the terminal service is adapted to
// `TerminalCensus` by the terminal host.
import type { InstanceKind } from '@mcs/shared';
import type { ControlShutdownReason } from '@mcs/shared/protocol';

import type { FolderService } from '../folders/service.ts';
import type { TerminalHost } from '../terminal/host.ts';
import type { AccessMint, AccessService } from './access-service.ts';
import type { RuntimeComponent } from './instance-runtime.ts';

/** One session as the control op `terminals` shows it: its name and when it started. Nothing else about a terminal leaves the engine. */
export interface TerminalCensusEntry {
  /** `^[A-Za-z0-9_-]{1,64}$`. Shown on the person's own terminal; never logged. */
  readonly name: string;
  /** ISO-8601 with milliseconds, UTC. */
  readonly startedAt: string;
}

/**
 * What a stop must not drop (amendment A4). `count()` covers every session that has, or may still get, a process: the ones that
 * are starting, the live ones and the lost ones (a process that is no longer watched but may still run). `sessions()` lists what
 * a person can see, oldest first, at most `limit`; it is shorter than the count while a session starts or is lost, so a guard
 * reads `count()` and never the length of the list.
 */
export interface TerminalCensus {
  count(): number;
  sessions(limit: number): readonly TerminalCensusEntry[];
  /** From now on no session may start; one that is starting is cancelled. Idempotent, and it ends nothing that runs. */
  beginDrain(): void;
}

/** The control op `access` asks for a code: one-use, short-lived, in memory only (ADR 0094). `AccessService.mint` is one. */
export interface AccessMinter {
  mint(): AccessMint;
}

/** Everything the runtime needs of the user instance besides the monitoring services. */
export interface UserServices {
  readonly census: TerminalCensus;
  /** `null` while there is no access service: the control op `access` then answers `UNSUPPORTED`. */
  readonly access: AccessMinter | null;
  /** Started after the alert components, stopped before them; the terminal host kills every session in its `stop`. */
  readonly components: readonly RuntimeComponent[];
  /**
   * The whole access service (tickets, credentials, the Bearer check): the server's access verifier, the auth routes and the
   * reader routes use it. It is the same object as `access` in a real user instance. Absent in a hand-built value: read it as
   * `null`, and boot then refuses to start a user instance (a session route without it would fail open).
   */
  readonly accessService?: AccessService | null;
  /**
   * The terminal host: the sessions, the capabilities, the folder picker and the resume of the terminal routes, the gateway and the
   * event feed (assignable to the server's `TerminalPorts`). `null` or absent: no terminal (every terminal route says so).
   */
  readonly terminal?: TerminalHost | null;
  /** The folder service of the sidebar (`listFolders`, `addFolder`, `removeFolder`, `sessionResume`). `null` or absent: none. */
  readonly folders?: FolderService | null;
}

/** No terminal can exist: nothing to protect, nothing to drain. */
export const EMPTY_CENSUS: TerminalCensus = Object.freeze({
  count: (): number => 0,
  sessions: (): readonly TerminalCensusEntry[] => [],
  beginDrain: (): void => undefined,
});

/** What a runtime uses until the real services are registered: no sessions, no minter, no components. */
export const EMPTY_USER_SERVICES: UserServices = Object.freeze({
  census: EMPTY_CENSUS,
  access: null,
  accessService: null,
  terminal: null,
  folders: null,
  components: Object.freeze([]),
});

// ---- the shutdown decision (06 3.2, ADR 0093) --------------------------------------------------------------------------------------

export interface ShutdownDecisionInput {
  readonly kind: InstanceKind;
  readonly reason: ControlShutdownReason;
  /** The request carried `force: true`. */
  readonly force: boolean;
  /** A shutdown was already accepted: the drain has begun and there is nothing left to guard. */
  readonly stopping: boolean;
  readonly census: TerminalCensus;
}

export type ShutdownDecision =
  /** `drained` is false when the census could not start its drain (the shutdown goes on; the terminal service also refuses new sessions outside the phase ready). */
  | { readonly allow: true; readonly drained: boolean }
  /** `live` is the count that made the refusal. */
  | { readonly allow: false; readonly live: number };

/**
 * The server's decision on a `shutdown` request, and the one place that starts the drain. A shutdown of a user instance is
 * refused while the census counts a session, unless the request forces it. Never guarded: a task instance (no terminal), the
 * reason `signal` (logoff, Ctrl+C and SIGTERM end the process anyway, and refusing them would hang a logoff) and a request that
 * arrives while the instance is already stopping. The count is read once; `beginDrain()` runs in this same call on every allow
 * decision (so that no session can start between the count and the stop) and never on a refusal. Only exactly zero means "no
 * terminals": a count that is not a number refuses.
 */
export function decideShutdown(i: ShutdownDecisionInput): ShutdownDecision {
  if (i.stopping) return { allow: true, drained: true };
  if (i.kind === 'user' && i.reason !== 'signal' && !i.force) {
    const live = i.census.count();
    if (live !== 0) return { allow: false, live };
  }
  try {
    i.census.beginDrain();
  } catch {
    return { allow: true, drained: false };
  }
  return { allow: true, drained: true };
}
