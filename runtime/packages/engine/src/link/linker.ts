// The linker (CAW design 03 5.3 to 5.5, ADR 0090): which session the monitor follows for each terminal of this app. `claude` cannot be
// told its session id, so the link is read from evidence: the Claude registry (`<home>/sessions/<pid>.json`: pid, session id, folder,
// start time) checked against the process tree, with the database as a weak fallback. The decision itself is `rules.ts` (pure); this
// file owns the state and the clock around it:
//   - `track` after the terminal service created a terminal, `forget` when it ended; a terminal is `pending` until the ladder links it;
//   - a pass (`tick`) reads the registry once, follows the entry of every linked terminal (a `/clear` gives the same pid a new session
//     id, the old id is remembered), runs the ladder for the terminals that are not linked, then the fallback, then asks the importer
//     for the transcript of a session the monitor has no row for yet;
//   - the process table is asked once per pending terminal and decision, the answer is kept for 1.5 s (longer when it failed) and
//     passes that overlap share one look, so a poll every 250 ms costs at most one query per 1.5 s;
//   - the timer polls every `linkPollMs` while a terminal that is not linked is younger than `linkFastWindowMs`, else every
//     `linkSlowPollMs`; it sleeps while nothing is tracked;
//   - a real path is asked of the file system only for a folder that `windowsFolderPath` accepts: the `cwd` of a registry entry is
//     data from a file any process of the person may write, and a UNC or device path makes Windows contact another machine.
// Nothing here logs a terminal name, a folder or a message of an error: a line carries a pid and a code at most.
import { realpath } from 'node:fs/promises';

import {
  folderPathKey,
  isoMsZ,
  windowsFolderPath,
  type Clock,
  type LinkBasis,
  type LinkConfidence,
  type LinkReason,
  type LinkStatus,
  type ProjectsSection,
  type TerminalLink,
} from '@mcs/shared';

import type { RegistryEntry, RegistrySnapshot } from '../external/registry.ts';
import type { Logger } from '../log/logger.ts';
import { hostPlatform } from '../platform/host.ts';
import { folderKeyOfPath, type FolderKey } from '../projects/folder-key.ts';
import { decideLinks } from './rules.ts';
import type { ProcessTreePort, RuleTerminal, TerminalLinker, TerminalProbe, TreeLookup } from './types.ts';

/** An answer of the process table is reused for this long. */
export const PROCESS_TREE_MEMO_MS = 1500;
/** A failure of the process table is remembered for this long: a machine that cannot list processes is not asked every second. */
export const PROCESS_TREE_FAILURE_MEMO_MS = 5000;
/** The old session ids a link remembers after `/clear` or `/resume`. */
export const PREVIOUS_SESSION_IDS_MAX = 8;
/** A real path is reused for this long. */
export const REALPATH_MEMO_MS = 60_000;
const REALPATH_MEMO_MAX = 256;

/** The keys of `projects` the linker reads. */
export type LinkerConfig = Pick<
  ProjectsSection,
  'linkPollMs' | 'linkSlowPollMs' | 'linkFastWindowMs' | 'linkStartToleranceMs'
>;

export interface TerminalLinkerDeps {
  /** The registry of the Claude home, read at most once a second (`createRegistrySnapshot`). */
  readonly registry: Pick<RegistrySnapshot, 'read'>;
  /** The process table; the real one is `listDescendantPids` of `platform/process.ts`. */
  readonly tree: ProcessTreePort;
  readonly clock: Clock;
  readonly config: LinkerConfig;
  /** True when the monitor has a session row for this id. */
  readonly sessionKnown: (sessionUid: string) => boolean;
  /** The ids of the sessions of a project first seen at or after `sinceMs` (the fallback on the database). */
  readonly sessionsSince: (projectKey: string, sinceMs: number) => readonly string[];
  /** Asks the importer to look for the transcript of a session at once (`IngestService.hintSession`). */
  readonly hintSession: (sessionUid: string) => void;
  /** Checks a candidate again at the moment of the decision (the snapshot may be a second old). Default: the entry is trusted. */
  readonly pidAlive?: (pid: number) => boolean;
  /**
   * The real path of a folder, or null when it cannot be resolved. Default: `fs.realpath`. It is asked only about a folder that
   * `windowsFolderPath` accepts, in the spelling that function returns.
   */
  readonly realpath?: (path: string) => Promise<string | null>;
  /** Which spelling of a path is valid (default: the host). */
  readonly win32?: boolean;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

/** What the linker keeps for one terminal. */
interface Tracked {
  readonly probe: TerminalProbe;
  /** When `track` was called: the age of the terminal for the fast window. */
  readonly trackedAt: number;
  readonly folder: FolderKey;
  lastRelaxedAt: number | null;
  lastHintAt: number | null;
  status: LinkStatus;
  sessionId: string | null;
  previous: string[];
  basis: LinkBasis | null;
  confidence: LinkConfidence | null;
  sinceMs: number | null;
  claudePid: number | null;
  transcript: 'none' | 'tracked';
  registryStatus: 'busy' | 'idle' | 'waiting' | null;
  waitingFor: string | null;
  reason: LinkReason | null;
  shared: boolean;
  /** The JSON of the link as the listeners last saw it. */
  published: string;
}

interface TreeMemo {
  readonly at: number;
  ttl: number;
  settled: boolean;
  promise: Promise<ReadonlySet<number> | null>;
}

async function nodeRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function toLink(t: Tracked): TerminalLink {
  return {
    status: t.status,
    sessionId: t.sessionId,
    previousSessionIds: [...t.previous],
    basis: t.basis,
    confidence: t.confidence,
    since: t.sinceMs === null ? null : isoMsZ(t.sinceMs),
    claudePid: t.claudePid,
    transcript: t.transcript,
    registryStatus: t.registryStatus,
    waitingFor: t.waitingFor,
    reason: t.reason,
    shared: t.shared,
  };
}

/** Whether the ladder may still change the link of this terminal: not linked, or linked only by a guess that has no process. */
const unresolved = (t: Tracked): boolean => t.status !== 'linked' || t.claudePid === null;

export function createTerminalLinker(deps: TerminalLinkerDeps): TerminalLinker {
  const { config, clock, logger } = deps;
  const terminals = new Map<string, Tracked>();
  const listeners = new Set<(name: string, link: TerminalLink) => void>();
  const treeMemo = new Map<number, TreeMemo>();
  const realMemo = new Map<string, { readonly at: number; readonly value: string | null }>();
  const realpathOf = deps.realpath ?? nodeRealpath;
  const win32 = deps.win32 ?? hostPlatform === 'win32';
  let running: Promise<void> | null = null;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** A logger that never throws into the pass: the line is optional, the link is not. */
  function note(level: 'debug' | 'warn', event: string, fields: Record<string, unknown>): void {
    try {
      logger[level](event, fields);
    } catch {
      // a broken logger must not break the link
    }
  }

  function known(sessionId: string): boolean {
    try {
      return deps.sessionKnown(sessionId);
    } catch {
      return false;
    }
  }

  function alive(entry: RegistryEntry): boolean {
    return entry.alive && (deps.pidAlive === undefined || deps.pidAlive(entry.pid));
  }

  // ---- the process table: one question per root, remembered --------------------------------------------------------------------

  const lookupTree: TreeLookup = (root) => {
    const now = clock.now();
    const memo = treeMemo.get(root);
    if (memo !== undefined && (!memo.settled || now - memo.at < memo.ttl)) return memo.promise;
    const record: TreeMemo = { at: now, ttl: PROCESS_TREE_MEMO_MS, settled: false, promise: Promise.resolve(null) };
    record.promise = Promise.resolve()
      .then(() => deps.tree.descendants(root))
      .catch(() => null)
      .then((answer) => {
        record.settled = true;
        if (answer === null) record.ttl = PROCESS_TREE_FAILURE_MEMO_MS;
        return answer;
      });
    treeMemo.set(root, record);
    return record.promise;
  };

  // ---- real paths ---------------------------------------------------------------------------------------------------------------

  async function resolveReal(path: string, now: number): Promise<void> {
    // The file system is asked about the spelling that passed the folder rules, never about the raw text: a path that cannot be a
    // local folder (UNC, device, relative, stream, reserved name, control or format character) is not asked about at all, and is not
    // remembered either (nothing was learned, and a flood of them must not push the good answers out). The rules read it as unknown.
    const local = windowsFolderPath(path, win32);
    if (local === null) return;
    const memo = realMemo.get(path);
    if (memo !== undefined && now - memo.at < REALPATH_MEMO_MS) return;
    let value: string | null;
    try {
      value = await realpathOf(local);
    } catch {
      value = null;
    }
    if (realMemo.size >= REALPATH_MEMO_MAX) realMemo.clear();
    realMemo.set(path, { at: now, value });
  }

  /** The real paths a pass needs: the folders of the terminals, and the folder of every entry no terminal names by key. */
  async function primeRealPaths(
    pending: readonly Tracked[],
    entries: readonly RegistryEntry[],
    now: number,
  ): Promise<void> {
    const keys = new Set(pending.map((t) => folderPathKey(t.probe.cwd)));
    const wanted = new Set(pending.map((t) => t.probe.cwd));
    const claimed = ownedPids();
    for (const entry of entries) {
      if (entry.cwd === null || !alive(entry) || entry.kind === 'bg' || claimed.has(entry.pid)) continue;
      if (!keys.has(folderPathKey(entry.cwd))) wanted.add(entry.cwd);
    }
    for (const path of wanted) await resolveReal(path, now);
  }

  // ---- state changes ------------------------------------------------------------------------------------------------------------

  /** Gives the terminal a session id; an id it had is remembered (at most eight, the oldest dropped) and one it returns to is current again. */
  function setSession(t: Tracked, sessionId: string): void {
    const old = t.sessionId;
    const kept = t.previous.filter((id) => id !== sessionId && id !== old);
    if (old !== null && old !== sessionId) kept.push(old);
    t.previous = kept.slice(-PREVIOUS_SESSION_IDS_MAX);
    t.sessionId = sessionId;
    t.lastHintAt = null;
    t.transcript = known(sessionId) ? 'tracked' : 'none';
  }

  function applyLink(
    t: Tracked,
    entry: RegistryEntry,
    basis: LinkBasis,
    confidence: LinkConfidence,
    now: number,
  ): void {
    setSession(t, entry.sessionId);
    t.status = 'linked';
    t.basis = basis;
    t.confidence = confidence;
    t.sinceMs = now;
    t.claudePid = entry.pid;
    t.registryStatus = entry.status;
    t.waitingFor = entry.waitingFor;
    t.reason = null;
    note('debug', 'link.linked', { pid: entry.pid, code: basis, status: confidence });
  }

  function applyGuess(t: Tracked, sessionId: string, now: number): void {
    setSession(t, sessionId);
    t.status = 'linked';
    t.basis = 'transcript-time';
    t.confidence = 'low';
    t.sinceMs = now;
    t.claudePid = null;
    t.registryStatus = null;
    t.waitingFor = null;
    t.reason = null;
    note('debug', 'link.linked', { code: 'transcript-time', status: 'low' });
  }

  function applyAmbiguous(t: Tracked): void {
    t.status = 'ambiguous';
    t.reason = 'ambiguous';
  }

  function reasonOf(t: Tracked, now: number, unreadable: boolean): LinkReason | null {
    if (unreadable) return 'registry_unreadable';
    return now - t.trackedAt >= config.linkFastWindowMs ? 'no_registry' : null;
  }

  // ---- one pass -----------------------------------------------------------------------------------------------------------------

  /** A terminal that is linked to a process follows the entry of that pid: its status, and a new session id after `/clear`. */
  function follow(entries: readonly RegistryEntry[], now: number): void {
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    for (const t of terminals.values()) {
      if (t.status !== 'linked' || t.claudePid === null) continue;
      const entry = byPid.get(t.claudePid);
      if (entry === undefined || !alive(entry)) {
        t.registryStatus = null;
        t.waitingFor = null;
        continue;
      }
      if (entry.sessionId !== t.sessionId) {
        setSession(t, entry.sessionId);
        t.sinceMs = now;
        note('debug', 'link.session_changed', { pid: entry.pid });
      }
      t.registryStatus = entry.status;
      t.waitingFor = entry.waitingFor;
    }
  }

  async function climb(entries: readonly RegistryEntry[], now: number, unreadable: boolean): Promise<void> {
    const asked = new Map<string, Tracked>();
    for (const t of terminals.values()) if (unresolved(t)) asked.set(t.probe.name, t);
    if (asked.size === 0) return;
    const pending = [...asked.values()];
    /** The terminals this pass found ambiguous. */
    const decided = new Set<string>();

    // After the fast window the folder test is dropped for the tree rung, at most once per slow tick (also when there is nothing to look at)
    const ruleTerminals: RuleTerminal[] = pending.map((t) => {
      const relaxed =
        now - t.trackedAt >= config.linkFastWindowMs &&
        (t.lastRelaxedAt === null || now - t.lastRelaxedAt >= config.linkSlowPollMs);
      if (relaxed) t.lastRelaxedAt = now;
      return {
        name: t.probe.name,
        pid: t.probe.pid,
        cwd: t.probe.cwd,
        spawnedAtMs: t.probe.spawnedAtMs,
        resumeSessionId: t.probe.resumeSessionId,
        fork: t.probe.fork,
        ignoreCwd: relaxed,
      };
    });

    if (!unreadable && entries.length > 0) {
      await primeRealPaths(pending, entries, now);
      const result = await decideLinks(
        ruleTerminals,
        entries.filter(alive),
        {
          startToleranceMs: config.linkStartToleranceMs,
          claimedPids: ownedPids(),
          realpathOf: (path) => realMemo.get(path)?.value ?? null,
        },
        lookupTree,
      );
      for (const [name, verdict] of result.verdicts) {
        const t = terminals.get(name);
        // a terminal that was forgotten, or tracked again, while the pass waited is not touched
        if (t === undefined || t !== asked.get(name)) continue;
        if (verdict.kind === 'linked') {
          applyLink(t, verdict.entry, verdict.basis, verdict.confidence, now);
        } else {
          applyAmbiguous(t);
          decided.add(name);
        }
      }
    }

    // not linked and not ambiguous after this pass: pending (an ambiguous terminal whose candidates left is pending again)
    for (const [name, t] of asked) {
      if (terminals.get(name) !== t || t.status === 'linked' || decided.has(name)) continue;
      t.status = 'pending';
      t.reason = reasonOf(t, now, unreadable);
    }
  }

  function fallback(entries: readonly RegistryEntry[], now: number): void {
    const live = new Set(entries.filter(alive).map((entry) => entry.sessionId));
    for (const t of terminals.values()) {
      if (t.status !== 'pending' || now - t.trackedAt < config.linkFastWindowMs || t.folder.prefix) continue;
      const rivals = [...terminals.values()].some(
        (other) => other !== t && other.folder.key === t.folder.key && unresolved(other),
      );
      if (rivals) continue;
      let ids: readonly string[];
      try {
        ids = deps.sessionsSince(t.folder.key, t.probe.spawnedAtMs - config.linkStartToleranceMs);
      } catch {
        continue;
      }
      const candidates = ids.filter((id) => sessionOwner(id) === null && !live.has(id));
      const [only] = candidates;
      if (candidates.length === 1 && only !== undefined) applyGuess(t, only, now);
    }
  }

  function settleShared(): void {
    const counts = new Map<string, number>();
    for (const t of terminals.values()) {
      if (t.status === 'linked' && t.sessionId !== null) counts.set(t.sessionId, (counts.get(t.sessionId) ?? 0) + 1);
    }
    for (const t of terminals.values()) {
      t.shared = t.status === 'linked' && t.sessionId !== null && (counts.get(t.sessionId) ?? 0) > 1;
    }
  }

  function askForTranscripts(now: number): void {
    const slow = config.linkSlowPollMs;
    for (const t of terminals.values()) {
      if (t.status !== 'linked' || t.sessionId === null) continue;
      t.transcript = known(t.sessionId) ? 'tracked' : 'none';
      if (t.transcript === 'tracked') continue;
      if (t.lastHintAt !== null && now - t.lastHintAt < slow) continue;
      t.lastHintAt = now;
      try {
        deps.hintSession(t.sessionId);
      } catch {
        // a hint is only a hint
      }
    }
  }

  /** Tells the listeners about every link that is not what they last saw. */
  function publish(): void {
    const changed: [string, TerminalLink][] = [];
    for (const [name, t] of terminals) {
      const link = toLink(t);
      const text = JSON.stringify(link);
      if (text === t.published) continue;
      t.published = text;
      changed.push([name, link]);
    }
    for (const [name, link] of changed) {
      for (const listener of listeners) {
        try {
          listener(name, link);
        } catch {
          // a listener that fails does not stop the others
        }
      }
    }
  }

  function forgetOldMemos(now: number): void {
    for (const [pid, memo] of treeMemo) if (memo.settled && now - memo.at >= memo.ttl) treeMemo.delete(pid);
  }

  async function pass(): Promise<void> {
    if (terminals.size === 0) return;
    let entries: readonly RegistryEntry[] = [];
    let unreadable = false;
    try {
      entries = (await deps.registry.read()).entries;
    } catch {
      unreadable = true;
      note('warn', 'link.registry_unreadable', { code: 'registry_unreadable' });
    }
    const now = clock.now();
    if (!unreadable) follow(entries, now);
    await climb(entries, now, unreadable);
    fallback(entries, now);
    askForTranscripts(now);
    settleShared();
    forgetOldMemos(now);
    publish();
  }

  function tick(): Promise<void> {
    if (running !== null) return running;
    const mine: Promise<void> = pass()
      .catch(() => {
        note('warn', 'link.pass_failed', { code: 'pass_failed' });
      })
      .finally(() => {
        if (running === mine) running = null;
      });
    running = mine;
    return mine;
  }

  // ---- the timer ----------------------------------------------------------------------------------------------------------------

  function nextDelay(): number {
    const now = clock.now();
    for (const t of terminals.values()) {
      if (unresolved(t) && now - t.trackedAt < config.linkFastWindowMs) return config.linkPollMs;
    }
    return config.linkSlowPollMs;
  }

  function schedule(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!started || terminals.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().then(schedule);
    }, nextDelay());
    timer.unref();
  }

  // ---- the interface ------------------------------------------------------------------------------------------------------------

  function ownedPids(): ReadonlySet<number> {
    const pids = new Set<number>();
    for (const t of terminals.values()) if (t.status === 'linked' && t.claudePid !== null) pids.add(t.claudePid);
    return pids;
  }

  function sessionOwner(sessionId: string): string | null {
    let best: Tracked | null = null;
    for (const t of terminals.values()) {
      if (t.status !== 'linked' || t.sessionId !== sessionId) continue;
      if (
        best === null ||
        (t.sinceMs ?? 0) < (best.sinceMs ?? 0) ||
        ((t.sinceMs ?? 0) === (best.sinceMs ?? 0) && t.probe.name < best.probe.name)
      ) {
        best = t;
      }
    }
    if (best !== null) return best.probe.name;
    // a terminal that resumes this very session will own it as soon as it links
    for (const t of terminals.values()) {
      if (t.status !== 'linked' && t.probe.resumeSessionId === sessionId && !t.probe.fork) return t.probe.name;
    }
    return null;
  }

  return {
    track(probe) {
      const fresh: Tracked = {
        probe,
        trackedAt: clock.now(),
        folder: folderKeyOfPath(probe.cwd),
        lastRelaxedAt: null,
        lastHintAt: null,
        status: 'pending',
        sessionId: null,
        previous: [],
        basis: null,
        confidence: null,
        sinceMs: null,
        claudePid: null,
        transcript: 'none',
        registryStatus: null,
        waitingFor: null,
        reason: null,
        shared: false,
        published: '',
      };
      fresh.published = JSON.stringify(toLink(fresh));
      const old = terminals.get(probe.name);
      if (old !== undefined) treeMemo.delete(old.probe.pid);
      terminals.set(probe.name, fresh);
      settleShared();
      publish();
      schedule();
    },
    forget(name) {
      const old = terminals.get(name);
      if (old === undefined) return;
      terminals.delete(name);
      treeMemo.delete(old.probe.pid);
      settleShared();
      publish();
      schedule();
    },
    link(name) {
      const t = terminals.get(name);
      return t === undefined ? null : toLink(t);
    },
    links() {
      return new Map([...terminals].map(([name, t]) => [name, toLink(t)]));
    },
    sessionOwner,
    ownedPids,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    tick,
    start() {
      if (started) return;
      started = true;
      schedule();
    },
    async stop() {
      started = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (running !== null) await running;
    },
  };
}
