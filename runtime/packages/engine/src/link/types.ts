// Engine-side types of the link between a terminal of this app and the session the monitor follows (CAW design 03 section 5, ADR 0090).
// None of it is wire data: the wire shape is `TerminalLink` of `@mcs/shared`, which `TerminalLinker.link` returns.
import type { LinkBasis, LinkConfidence, TerminalLink } from '@mcs/shared';

import type { RegistryEntry } from '../external/registry.ts';

/** What the terminal host tells the linker about a terminal it just created. */
export interface TerminalProbe {
  /** The name of the terminal session, `^[A-Za-z0-9_-]{1,64}$`. */
  readonly name: string;
  /** The root process of the terminal: `claude.exe` on the direct route, `cmd.exe` on the `.cmd` shim route. */
  readonly pid: number;
  /** The folder the terminal started in, as the terminal service normalised it. */
  readonly cwd: string;
  /** Epoch milliseconds taken just before the process was spawned. */
  readonly spawnedAtMs: number;
  /** The id given to `--resume`, or null for a new session. */
  readonly resumeSessionId: string | null;
  /** `--fork-session` was given: the resumed session continues under a new id. */
  readonly fork: boolean;
  /** Reserved for a `--name` value (design 03 PRJ-Q2); no rule reads it in this version. */
  readonly nameToken: string | null;
}

/**
 * The process table, behind one question: which processes below `rootPid`. The set does not hold `rootPid` itself; `null` means
 * the table could not be read (not Windows, the query failed). The real answer is `listDescendantPids` of `platform/process.ts`.
 */
export interface ProcessTreePort {
  descendants(rootPid: number): Promise<ReadonlySet<number> | null>;
}

export interface TerminalLinker {
  /** After the terminal service created the terminal. A name that is tracked already starts again from `pending`. */
  track(probe: TerminalProbe): void;
  /** On the `ended` change of the terminal. The monitored session stays where it is. */
  forget(name: string): void;
  link(name: string): TerminalLink | null;
  links(): ReadonlyMap<string, TerminalLink>;
  /** The terminal that owns a session id: the one that linked it first, or a terminal that resumes it and is not linked yet. */
  sessionOwner(sessionId: string): string | null;
  /** The registry pids of the processes that belong to linked terminals. */
  ownedPids(): ReadonlySet<number>;
  /** Called once per change of a link, never for the state a terminal is tracked in. Returns the function that removes the listener. */
  onChange(listener: (name: string, link: TerminalLink) => void): () => void;
  /** One resolution pass. The timers call it; tests call it. Never rejects; calls that overlap share one pass. */
  tick(): Promise<void>;
  /** Starts the polling timer (fast while a terminal is young, slow after). Safe to call twice. */
  start(): void;
  /** Stops the timer and waits for a pass that is running. */
  stop(): Promise<void>;
}

/** A terminal as the rules see it: the probe plus whether the folder test is dropped in this pass. */
export interface RuleTerminal {
  readonly name: string;
  readonly pid: number;
  readonly cwd: string;
  readonly spawnedAtMs: number;
  readonly resumeSessionId: string | null;
  readonly fork: boolean;
  /** After the fast window: the process tree alone decides (the registry `cwd` may be spelled in a way no comparison reads). */
  readonly ignoreCwd: boolean;
}

export interface RuleOptions {
  /** A registry entry may start this long before the spawn time and still count as new (`projects.linkStartToleranceMs`). */
  readonly startToleranceMs: number;
  /** The registry pids that belong to terminals already linked. */
  readonly claimedPids: ReadonlySet<number>;
  /** The real path of a folder when the caller knows it (junctions and short names), else null. */
  readonly realpathOf: (path: string) => string | null;
}

/** The answer of the process table for one root, memoised by the caller. */
export type TreeLookup = (rootPid: number) => Promise<ReadonlySet<number> | null>;

export type LinkVerdict =
  | {
      readonly kind: 'linked';
      readonly entry: RegistryEntry;
      readonly basis: LinkBasis;
      readonly confidence: LinkConfidence;
    }
  | { readonly kind: 'ambiguous' };

export interface LadderResult {
  /** By terminal name: only terminals the ladder linked or found ambiguous; a terminal that is not here stays as it was. */
  readonly verdicts: ReadonlyMap<string, LinkVerdict>;
  /** The pids of candidates that no pending terminal owns (rung B-): a `claude` started by hand in the same folder. */
  readonly foreign: ReadonlySet<number>;
}
