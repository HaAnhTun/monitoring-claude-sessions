// The rules that tie a terminal to the entry of the Claude registry that its `claude` wrote (CAW design 03 5.2, ADR 0090). Pure: no
// file, no clock and no process is touched here. The one question to the outside, the process table, is a function the caller
// passes in (and memoises), and it is asked only when a candidate exists that the pid test did not already decide.
//
// The pre-filter says which entries are worth looking at for a terminal; the ladder then decides, strongest evidence first:
//   A  the pid of the entry is the root pid of the terminal (`claude.exe` started directly)       registry-pid   high
//   B  the entry is a descendant of the root in the process table (`cmd.exe` shim to `claude.exe`) registry-tree  high
//   B- the table is readable and the entry is no descendant of any pending terminal: not ours, dropped
//   C  the table is unreadable; one terminal and one candidate in the folder      registry-cwd / resume-id        medium
//   D  the table is unreadable; k terminals and k candidates, paired by order     registry-order                 low
//   E  the table is unreadable; the counts differ                                 ambiguous, nothing is linked
// A candidate is published only after the ladder ran: there is no optimistic link that is taken back.
import { folderPathKey } from '@mcs/shared';
import { SID_RE } from '@mcs/shared/protocol';

import type { RegistryEntry } from '../external/registry.ts';
import type { LadderResult, LinkVerdict, RuleOptions, RuleTerminal, TreeLookup } from './types.ts';

/**
 * Whether a registry `cwd` is the folder of a terminal: the same key of the folder helpers (separators, case, a trailing separator,
 * the `/mnt/d` form) or, when the keys differ, the same real path. The real paths come from the caller (a junction or a short name
 * is only known after a file system call); an unknown real path never matches.
 */
export function cwdMatches(
  entryCwd: string | null,
  terminalCwd: string,
  realpathOf: (path: string) => string | null,
): boolean {
  if (entryCwd === null) return false;
  if (folderPathKey(entryCwd) === folderPathKey(terminalCwd)) return true;
  const entryReal = realpathOf(entryCwd);
  const terminalReal = realpathOf(terminalCwd);
  return entryReal !== null && terminalReal !== null && folderPathKey(entryReal) === folderPathKey(terminalReal);
}

/**
 * Whether an entry started after the terminal was spawned (less the tolerance of the clocks). An entry with no start time is not
 * proved old. The resume id exception: a terminal that resumes a session without a fork accepts the entry of that session whatever
 * its start time says, because the registry may carry the start of the original session.
 */
export function isNewSince(
  entry: RegistryEntry,
  terminal: Pick<RuleTerminal, 'spawnedAtMs' | 'resumeSessionId' | 'fork'>,
  toleranceMs: number,
): boolean {
  if (terminal.resumeSessionId !== null && !terminal.fork && entry.sessionId === terminal.resumeSessionId) return true;
  return entry.startedAtMs === null || entry.startedAtMs >= terminal.spawnedAtMs - toleranceMs;
}

/**
 * Whether an entry is worth testing for a terminal: its process lives and is not a background session, its id is a session id, no
 * linked terminal holds its pid, it is new, and it names the folder of the terminal (a terminal that says `ignoreCwd` skips that
 * last test, and only that one).
 */
export function preFilter(entry: RegistryEntry, terminal: RuleTerminal, options: RuleOptions): boolean {
  return (
    entry.alive &&
    entry.kind !== 'bg' &&
    SID_RE.test(entry.sessionId) &&
    !options.claimedPids.has(entry.pid) &&
    isNewSince(entry, terminal, options.startToleranceMs) &&
    (terminal.ignoreCwd || cwdMatches(entry.cwd, terminal.cwd, options.realpathOf))
  );
}

/** Oldest start first; an entry with no start time last; then the lowest pid. */
function byAge(a: RegistryEntry, b: RegistryEntry): number {
  const left = a.startedAtMs ?? Number.POSITIVE_INFINITY;
  const right = b.startedAtMs ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left < right ? -1 : 1;
  return a.pid - b.pid;
}

/** Oldest spawn first, then the name. */
function bySpawn(a: RuleTerminal, b: RuleTerminal): number {
  if (a.spawnedAtMs !== b.spawnedAtMs) return a.spawnedAtMs - b.spawnedAtMs;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The ladder over every pending terminal and every entry of the registry. Terminals are compared one folder at a time (the folder
 * key of their `cwd`); an entry given to one terminal is not given to another. The answer holds only the terminals that were linked
 * or found ambiguous: one that is missing stays as it was. The same facts give the same answer in whatever order they come.
 */
export async function decideLinks(
  terminals: readonly RuleTerminal[],
  entries: readonly RegistryEntry[],
  options: RuleOptions,
  tree: TreeLookup,
): Promise<LadderResult> {
  const verdicts = new Map<string, LinkVerdict>();
  const foreign = new Set<number>();
  const taken = new Set<number>();
  const ordered = [...terminals].sort(bySpawn);
  const sorted = [...entries].sort((a, b) => a.pid - b.pid);

  function give(
    terminal: RuleTerminal,
    entry: RegistryEntry,
    basis: 'registry-pid' | 'registry-tree' | 'registry-cwd' | 'resume-id' | 'registry-order',
  ): void {
    const confidence =
      basis === 'registry-pid' || basis === 'registry-tree' ? 'high' : basis === 'registry-order' ? 'low' : 'medium';
    verdicts.set(terminal.name, { kind: 'linked', entry, basis, confidence });
    taken.add(entry.pid);
  }

  const free = (entry: RegistryEntry): boolean => !taken.has(entry.pid);

  // Rung A: an entry whose pid is the root pid is ours by construction, so the folder test is skipped; the rest of the pre-filter
  // stays, because the system may have reused the pid of a process that left a stale file.
  for (const terminal of ordered) {
    const entry = sorted.find((candidate) => candidate.pid === terminal.pid);
    if (entry !== undefined && free(entry) && preFilter(entry, { ...terminal, ignoreCwd: true }, options)) {
      give(terminal, entry, 'registry-pid');
    }
  }

  const groups = new Map<string, RuleTerminal[]>();
  for (const terminal of ordered) {
    if (verdicts.has(terminal.name)) continue;
    const key = folderPathKey(terminal.cwd);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [terminal]);
    else group.push(terminal);
  }

  for (const group of groups.values()) {
    const candidates = new Map(
      group.map((terminal) => [
        terminal.name,
        sorted.filter((entry) => free(entry) && preFilter(entry, terminal, options)),
      ]),
    );
    if (![...candidates.values()].some((list) => list.length > 0)) continue;

    // one question per terminal of the folder; a root the table cannot answer for makes the whole folder weak
    const answers = await Promise.all(group.map((terminal) => tree(terminal.pid)));
    const trees: ReadonlySet<number>[] = [];
    for (const answer of answers) if (answer !== null) trees.push(answer);

    if (trees.length === group.length) {
      // Rungs B and B-
      const reachable = new Set<number>();
      for (const reach of trees) for (const pid of reach) reachable.add(pid);
      group.forEach((terminal, at) => {
        const reach = trees[at];
        const own = (candidates.get(terminal.name) ?? []).filter(
          (entry) => free(entry) && reach?.has(entry.pid) === true,
        );
        const first = own.sort(byAge)[0];
        if (first !== undefined) give(terminal, first, 'registry-tree');
      });
      for (const list of candidates.values())
        for (const entry of list) if (!reachable.has(entry.pid)) foreign.add(entry.pid);
      continue;
    }

    // Rungs C, D and E: the folder is the only evidence, so the relaxed pass does not apply here
    const pool = new Map<number, RegistryEntry>();
    for (const terminal of group) {
      for (const entry of sorted) {
        if (free(entry) && preFilter(entry, { ...terminal, ignoreCwd: false }, options)) pool.set(entry.pid, entry);
      }
    }
    const found = [...pool.values()].sort(byAge);
    const [only] = group;
    const [one] = found;
    if (found.length === 0) continue;
    if (only !== undefined && one !== undefined && group.length === 1 && found.length === 1) {
      const resumes = only.resumeSessionId !== null && !only.fork && one.sessionId === only.resumeSessionId;
      give(only, one, resumes ? 'resume-id' : 'registry-cwd');
    } else if (found.length === group.length) {
      group.forEach((terminal, at) => {
        const entry = found[at];
        if (entry !== undefined) give(terminal, entry, 'registry-order');
      });
    } else {
      for (const terminal of group) verdicts.set(terminal.name, { kind: 'ambiguous' });
    }
  }

  return { verdicts, foreign };
}
