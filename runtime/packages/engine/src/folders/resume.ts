// The resume decision (CAW design 03 section 6, ADR 0090): may `claude --resume <id>` run for this session, may a copy
// (`--fork-session`) run, in which folder, and if not why not. One function over what the database knows about the session
// (`resumeFacts`), the registry and the linker; the folder service wires them (`FolderService.resumeEligibility` and `planResume`).
// The checks run in this order and the first that fails answers:
//   1  no session row                                   refusal `session_not_found` (the route answers 404)
//   2  no main transcript, or it is missing or retired  `transcript_gone` (the plan also asks the file system)
//   3  the launch folder of the project is not a folder `folder_missing` when candidates exist, else `folder_unknown`
//   4  a terminal of this app holds the session         `live_in_terminal`, a copy is refused too
//   5  another program holds it (registry, not ours)    `live_elsewhere`, a copy is allowed: two writers on one file would interleave
//   6  otherwise                                        allowed, a copy allowed
// `redirectTo` is informational: the session that carried this one on, when the database knows it.
// A message never holds an id, a path or a terminal name; the terminal is a field of the refusal.
import { windowsFolderPath, type ResumeEligibility, type ResumeReason } from '@mcs/shared';

import type { RegistryEntry } from '../external/registry.ts';
import { dirMatchesKey, folderKeyOfPath } from '../projects/folder-key.ts';
import type { ResumeFacts } from '../query/projects.ts';

export type ResumeRefusalCode = 'session_not_found' | ResumeReason;

/** A resume or a copy that may not run. `code` is the first check that failed; the message says only that. */
export class ResumeRefusal extends Error {
  readonly code: ResumeRefusalCode;
  /** For `live_in_terminal`: the terminal that holds the session. */
  readonly liveTerminal: string | null;

  constructor(code: ResumeRefusalCode, liveTerminal: string | null = null) {
    super(`resume refused: ${code}`);
    this.name = 'ResumeRefusal';
    this.code = code;
    this.liveTerminal = liveTerminal;
  }
}

/** What a terminal is started from to resume a session. */
export interface ResumePlan {
  readonly sessionId: string;
  /** The folder the terminal starts in. */
  readonly folderPath: string;
  /** The project key of that folder. */
  readonly folderKey: string;
  /** The arguments after the program: `['--resume', id]`, and `--fork-session` for a copy. */
  readonly args: readonly string[];
  readonly mode: 'resume' | 'fork';
  /** A resume continues the same session id; a copy gets a new one. */
  readonly expectsSameId: boolean;
  readonly redirectTo: string | null;
}

/** Everything the decision reads, gathered by the caller: no file, database or clock is touched here. */
export interface ResumeEnvironment {
  /** `ctx.queries.resumeFacts` for the session; null when the database does not know it. */
  readonly facts: ResumeFacts | null;
  /** The root of the catalog entry of the project of the session, when it has one. */
  readonly catalogRoot: string | null;
  /** The entries of the registry (an unreadable registry is an empty list). */
  readonly registry: readonly RegistryEntry[];
  /** `TerminalLinker.sessionOwner`. */
  readonly sessionOwner: (sessionId: string) => string | null;
  /** `TerminalLinker.ownedPids`. */
  readonly ownedPids: ReadonlySet<number>;
  /** Whether a path is a directory now; null when that could not be told. */
  readonly isDirectory: (path: string) => Promise<boolean | null>;
  /** The plan asks whether the transcript file is still on disk (`cleanupPeriodDays` may have removed it); the plain eligibility passes null. */
  readonly transcriptExists: ((file: string) => Promise<boolean>) | null;
  /** True when the database has a session with this id. */
  readonly knowsSession: (sessionId: string) => boolean;
  /** Which spelling of a path is valid (the host). */
  readonly win32: boolean;
}

type LaunchFolder =
  { readonly key: string; readonly path: string } | { readonly absent: 'folder_missing' | 'folder_unknown' };

/**
 * The folder to resume in: the first directory among the root the project reported, the working directory the session reported and
 * the root of the catalog, whose key is the key of the project. That is the launch folder, not a later `cd`: a folder with another
 * key is never a candidate. Two spellings of one path are asked about once.
 */
async function launchFolderOf(facts: ResumeFacts, env: ResumeEnvironment): Promise<LaunchFolder> {
  const key = facts.projectKey;
  if (key === null) return { absent: 'folder_unknown' };
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of [facts.rootPath, facts.sessionCwd, env.catalogRoot]) {
    if (raw === null) continue;
    const path = windowsFolderPath(raw, env.win32);
    if (path === null || !dirMatchesKey(key, folderKeyOfPath(path))) continue;
    const identity = env.win32 ? path.toLowerCase() : path;
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push(path);
  }
  if (candidates.length === 0) return { absent: 'folder_unknown' };
  for (const path of candidates) {
    if ((await env.isDirectory(path)) === true) return { key, path };
  }
  return { absent: 'folder_missing' };
}

/** The decision for one session. Throws `ResumeRefusal('session_not_found')` for a session the database does not know. */
export async function decideResume(sessionId: string, env: ResumeEnvironment): Promise<ResumeEligibility> {
  const { facts } = env;
  if (facts === null) throw new ResumeRefusal('session_not_found');
  const redirectTo =
    facts.continuedIn !== null && facts.continuedIn !== sessionId && env.knowsSession(facts.continuedIn)
      ? facts.continuedIn
      : null;
  const refused = (reason: ResumeReason, rest: Partial<ResumeEligibility> = {}): ResumeEligibility => ({
    sessionId,
    allowed: false,
    forkAllowed: false,
    reason,
    folder: null,
    liveElsewhere: false,
    liveTerminal: null,
    redirectTo,
    ...rest,
  });

  // 2
  const file = facts.mainFile;
  if (file === null || file.state === 'missing' || file.state === 'retired') return refused('transcript_gone');
  if (env.transcriptExists !== null && !(await env.transcriptExists(file.path))) return refused('transcript_gone');

  // 3
  const launch = await launchFolderOf(facts, env);
  if ('absent' in launch) return refused(launch.absent);
  const folder = { key: launch.key, path: launch.path };

  // 4
  const owner = env.sessionOwner(sessionId);
  if (owner !== null) return refused('live_in_terminal', { folder, liveTerminal: owner });

  // 5
  const elsewhere = env.registry.some(
    (entry) => entry.sessionId === sessionId && entry.alive && !env.ownedPids.has(entry.pid),
  );
  if (elsewhere) return refused('live_elsewhere', { forkAllowed: true, folder, liveElsewhere: true });

  // 6
  return {
    sessionId,
    allowed: true,
    forkAllowed: true,
    reason: null,
    folder,
    liveElsewhere: false,
    liveTerminal: null,
    redirectTo,
  };
}

/**
 * The plan of a resume (`fork` false: it needs `allowed`) or of a copy (`fork` true: it needs `forkAllowed`). Throws
 * `ResumeRefusal` with the reason of the decision when it does not.
 */
export function resumePlanOf(decision: ResumeEligibility, fork: boolean): ResumePlan {
  const permitted = fork ? decision.forkAllowed : decision.allowed;
  if (!permitted || decision.folder === null) {
    throw new ResumeRefusal(decision.reason ?? 'folder_unknown', decision.liveTerminal);
  }
  return {
    sessionId: decision.sessionId,
    folderPath: decision.folder.path,
    folderKey: decision.folder.key,
    args: fork ? ['--resume', decision.sessionId, '--fork-session'] : ['--resume', decision.sessionId],
    mode: fork ? 'fork' : 'resume',
    expectsSameId: !fork,
    redirectTo: decision.redirectTo,
  };
}
