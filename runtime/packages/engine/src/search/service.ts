// Transcript content search (03 7.4, 6.4, ADR 0023, 0016, 0022): one session (`searchTranscript`) or the whole instance
// (`searchTranscripts`). The transcript files are read block by block over the entry index of the transcript service; a block
// without a hit for the prefilter is skipped unparsed, the others are verified with the legacy rules. The work is bounded by a
// time budget, a match limit, two concurrent searches per instance and the abort signal of the client, and every answer says what
// was searched (`SearchCoverage`) without ever claiming more.
//
// Honesty rules kept here:
//  - `complete` needs every file in scope scanned to the end of its indexed bytes, no byte left unindexed, no missing or
//    unreadable file, and no early stop;
//  - the numbers of a continued search add up over its pages (the chain remembers them), so the last page says what all
//    pages together searched;
//  - the answer is the only place where text of a transcript goes: nothing here stores, caches or logs a query, a snippet or a
//    result. A continuation remembers file ids, a position and the hash of the filter, never the query itself.
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';

import {
  ENTRY_KINDS,
  filterHash,
  type EntryKind,
  type HealthReport,
  type InstanceSearchQuery,
  type InstanceSearchResponse,
  type SearchCoverage,
  type TranscriptSearchQuery,
  type TranscriptSearchResponse,
} from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { CheckpointsRepo, type Checkpoint } from '../db/repos/checkpoints.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { TranscriptFilesRepo, type TranscriptFileRow } from '../db/repos/transcript-files.ts';
import { classifyFsError, errorCodeOf } from '../ingest/tail/file-identity.ts';
import { filterSql } from '../query/sessions.ts';
import { Binder, QueryRefusal, filterOf, idsParam, resolveWindow } from '../query/transitions.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { isContained } from '../security/paths.ts';
import {
  TranscriptError,
  createEntryIndexService,
  entryIndexServiceOf,
  type EntryIndexResult,
  type EntryIndexService,
} from '../transcript/index-service.ts';
import {
  createTranscriptRootResolver,
  transcriptRootOptionsOf,
  type TranscriptRootResolver,
} from '../transcript/window.ts';
import {
  SLICE_BYTES,
  buildPrefilter,
  isAborted,
  relationPatterns,
  scanBlock,
  scanRelation,
  type Criteria,
  type Hit,
  type RelationSets,
  type ScanEnv,
} from './scan.ts';

export type SearchStats = HealthReport['runtime']['search'];
type StoppedBy = SearchCoverage['stoppedBy'];

/** Two searches run at once per instance; the third is refused (03 6.4). */
const MAX_CONCURRENT = 2;
/** Continuation handles kept per instance, and how long one lives (03 7.4). */
const MAX_CONTINUATIONS = 20;
const CONTINUATION_TTL_MS = 5 * 60_000;
/** Sessions in the scope of an instance search; beyond this the scope is cut and the coverage says so. */
const MAX_SESSIONS = 5000;
/** Blocks of checkpoints fetched at a time. */
const CHECKPOINT_PAGE = 512;
/** Problems remembered for the note of the coverage; the counters are exact. */
const MAX_PROBLEMS = 20;
const NAMED_PROBLEMS = 3;
const MIB = 1024 * 1024;
/** The kinds of file that hold a Claude conversation (the journal and status files of a workflow do not). */
const TRANSCRIPT_KINDS = [
  'session',
  'subagent',
  'workflow_agent',
] as const satisfies readonly TranscriptFileRow['kind'][];

/** The refusal of a third concurrent search; the route turns it into `429 search_busy` (recognised by its name). */
export class SearchBusyError extends Error {
  readonly code = 'search_busy' as const;

  constructor() {
    super('search_busy');
    this.name = 'SearchBusyError';
  }
}

export interface SearchQueries {
  searchSession(ctx: RepoContext, q: TranscriptSearchQuery, signal: AbortSignal): Promise<TranscriptSearchResponse>;
  searchInstance(ctx: RepoContext, q: InstanceSearchQuery, signal: AbortSignal): Promise<InstanceSearchResponse>;
  /** The counters of `HealthReport.runtime.search`. */
  searchStats(): SearchStats;
}

export interface SearchServiceOptions {
  readonly deps: QueryDeps;
  /** The containment root of a file; default: the rule of the transcript window (`transcripts_dir`, discovery, the folder of the main file). */
  readonly roots?: TranscriptRootResolver;
  readonly index?: EntryIndexService;
  /** Size of a read and of a slice of lines; production 1 MiB. Tests use a small one. */
  readonly chunkBytes?: number;
  /** Entries per block of the index; production `CHECKPOINT_EVERY_ENTRIES`. */
  readonly checkpointEvery?: number;
  readonly maxConcurrent?: number;
  readonly maxContinuations?: number;
  readonly continuationTtlMs?: number;
  readonly maxSessions?: number;
  /** Monotonic milliseconds for the budget; default `performance.now`. */
  readonly clock?: () => number;
}

// ---- state of a search ---------------------------------------------------------------------------------------------------------

interface Target {
  readonly fileId: number;
  readonly sessionUid: string;
  readonly agentId: string;
}

/** Where a search goes on: the next file, and inside it the line, its entry index and the matches of the line already delivered. */
interface Position {
  readonly fileIndex: number;
  readonly byteOffset: number;
  readonly entryIndex: number;
  readonly skip: number;
}

/** A row of the one statement that lists the transcript files of the sessions in scope. */
interface FileOfSession {
  readonly id: number;
  readonly uid: string;
  readonly kind: TranscriptFileRow['kind'];
  readonly agentUid: string | null;
}

interface Problem {
  readonly sessionUid: string;
  readonly agentId: string;
  readonly kind: 'missing' | 'unreadable';
}

/** What has been searched so far; a continued search starts from the tally of the page before. */
interface Tally {
  filesScanned: number;
  filesMissing: number;
  filesUnreadable: number;
  /** Size of the files that are finished (the others are counted from their rows when the answer is made). */
  finishedBytes: number;
  bytesScanned: number;
  /** Bytes after the last complete line of the finished files. */
  bytesNotIndexed: number;
  entriesScanned: number;
  problems: Problem[];
}

function emptyTally(): Tally {
  return {
    filesScanned: 0,
    filesMissing: 0,
    filesUnreadable: 0,
    finishedBytes: 0,
    bytesScanned: 0,
    bytesNotIndexed: 0,
    entriesScanned: 0,
    problems: [],
  };
}

function cloneTally(tally: Tally): Tally {
  return { ...tally, problems: [...tally.problems] };
}

/** The server-side record behind a continuation handle (03 7.4). */
interface Chain {
  readonly targets: readonly Target[];
  readonly position: Position;
  readonly tally: Tally;
  readonly hash: string;
  readonly sessions: number;
  readonly scopeTruncated: boolean;
  readonly expiresAt: number;
}

const FIRST_FILE: Position = { fileIndex: 0, byteOffset: 0, entryIndex: 0, skip: 0 };

function startOfFile(fileIndex: number): Position {
  return { fileIndex, byteOffset: 0, entryIndex: 0, skip: 0 };
}

function isResume(position: Position): boolean {
  return position.byteOffset > 0 || position.entryIndex > 0 || position.skip > 0;
}

interface Collected {
  readonly target: Target;
  readonly hit: Hit;
}

interface Execution {
  readonly collected: Collected[];
  readonly stoppedBy: StoppedBy;
  /** Where a continuation goes on; `null` when there is nothing more to search or the search was cancelled. */
  readonly next: Position | null;
  /** The first file that is not finished: the files from here on are counted from their rows. */
  readonly stoppedAtFile: number;
  readonly elapsedMs: number;
}

interface ExecInput {
  readonly ctx: RepoContext;
  readonly targets: readonly Target[];
  readonly start: Position;
  readonly tally: Tally;
  readonly criteria: Criteria;
  readonly prefilter: RegExp | null;
  /** `true`: fill the relation sets with a pass over the file first (the `tool` and `errors` filters). */
  readonly relate: boolean;
  readonly limit: number;
  readonly budgetMs: number;
  readonly signal: AbortSignal;
  /** A single-file search: a file that is gone is a `transcript_gone`, not a line of the coverage. */
  readonly strict: boolean;
}

type Prepared =
  | { readonly kind: 'ready'; readonly row: TranscriptFileRow; readonly index: EntryIndexResult }
  | { readonly kind: 'missing' | 'outside' | 'unreadable' | 'cancelled' }
  /** The index grew but is not at the end: the time ran out inside it. */
  | { readonly kind: 'more_index' };

/** An error of the file system (the code is an errno name), as against a database error or a bug. */
function isFsError(error: unknown): boolean {
  return error instanceof Error && /^E[A-Z0-9]+$/.test(errorCodeOf(error));
}

function mb(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MB`;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function describeFiles(problems: readonly Problem[], kind: Problem['kind'], count: number): string {
  const named = problems
    .filter((problem) => problem.kind === kind)
    .slice(0, NAMED_PROBLEMS)
    .map((problem) => `session ${problem.sessionUid}, agent ${problem.agentId}`);
  if (named.length === 0) return '';
  const more = count > named.length ? ` and ${String(count - named.length)} more` : '';
  return ` (${named.join('; ')}${more})`;
}

interface Facts {
  readonly scope: SearchCoverage['scope'];
  readonly filesInScope: number;
  readonly sessions: number;
  readonly tally: Tally;
  readonly bytesInScope: number;
  readonly bytesNotIndexed: number;
  readonly scopeTruncated: boolean;
  readonly stoppedBy: StoppedBy;
  readonly complete: boolean;
}

/** The plain-English note of the coverage: every number in it is a counter of the report. */
function noteOf(f: Facts): string {
  const t = f.tally;
  const size = t.bytesScanned >= f.bytesInScope ? mb(t.bytesScanned) : `${mb(t.bytesScanned)} of ${mb(f.bytesInScope)}`;
  const where = f.scope === 'instance' ? ` of ${plural(f.sessions, 'session', 'sessions')}` : '';
  const parts = [
    `Searched ${String(t.filesScanned)} of ${plural(f.filesInScope, 'transcript file', 'transcript files')} (${size})${where}.`,
  ];
  if (t.filesMissing > 0) {
    parts.push(
      `${plural(t.filesMissing, 'file was', 'files were')} deleted by Claude Code and could not be searched${describeFiles(t.problems, 'missing', t.filesMissing)}.`,
    );
  }
  if (t.filesUnreadable > 0) {
    parts.push(
      `${plural(t.filesUnreadable, 'file', 'files')} could not be read${describeFiles(t.problems, 'unreadable', t.filesUnreadable)}.`,
    );
  }
  if (f.bytesNotIndexed > 0) {
    parts.push(
      `${mb(f.bytesNotIndexed)} of newly written or oversized lines are not indexed yet and were not searched.`,
    );
  }
  if (f.scopeTruncated)
    parts.push('Only the most recently active sessions are in scope; narrow the filters to reach the others.');
  if (f.stoppedBy === 'time_budget') parts.push('The time budget ended the search; continue it to search the rest.');
  else if (f.stoppedBy === 'match_limit')
    parts.push('The match limit ended the search; continue it to see more matches.');
  else if (f.stoppedBy === 'cancelled') parts.push('The search was cancelled.');
  return parts.join(' ');
}

function criteriaOf(q: {
  readonly q?: string | undefined;
  readonly kinds?: readonly EntryKind[] | undefined;
  readonly tool?: string | undefined;
  readonly errors?: true | undefined;
}): Criteria {
  return {
    needle: (q.q ?? '').toLowerCase(),
    kinds: q.kinds === undefined ? null : new Set(q.kinds),
    tool: q.tool ?? null,
    errors: q.errors === true,
  };
}

function kindsOf(kinds: readonly EntryKind[] | undefined): EntryKind[] {
  return [...new Set(kinds ?? ENTRY_KINDS)];
}

export interface SearchService {
  searchSession(ctx: RepoContext, q: TranscriptSearchQuery, signal: AbortSignal): Promise<TranscriptSearchResponse>;
  searchInstance(ctx: RepoContext, q: InstanceSearchQuery, signal: AbortSignal): Promise<InstanceSearchResponse>;
  stats(): SearchStats;
}

export function createSearchService(db: InstanceDb, options: SearchServiceOptions): SearchService {
  const { deps } = options;
  const sessions = new SessionsRepo(db);
  const files = new TranscriptFilesRepo(db);
  const checkpoints = new CheckpointsRepo(db);
  const chunkBytes = options.chunkBytes ?? SLICE_BYTES;
  const index =
    options.index ??
    (options.chunkBytes === undefined && options.checkpointEvery === undefined
      ? entryIndexServiceOf(db)
      : createEntryIndexService(db, {
          chunkBytes,
          ...(options.checkpointEvery === undefined ? {} : { checkpointEvery: options.checkpointEvery }),
        }));
  const roots = options.roots ?? createTranscriptRootResolver(transcriptRootOptionsOf(deps));
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;
  const maxContinuations = options.maxContinuations ?? MAX_CONTINUATIONS;
  const continuationTtlMs = options.continuationTtlMs ?? CONTINUATION_TTL_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const clock = options.clock ?? ((): number => performance.now());
  const textChars = deps.config.monitor.limits['text_chars'] ?? 6000;

  // ---- the two slots and the counters ------------------------------------------------------------------------------------------

  let active = 0;
  const counters: SearchStats = {
    total: 0,
    byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 },
  };

  /** Takes a slot or refuses; the returned function gives it back once, however the search ends. */
  function acquire(): () => void {
    if (active >= maxConcurrent) throw new SearchBusyError();
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  }

  function record(stoppedBy: StoppedBy): void {
    counters.total += 1;
    counters.byStoppedBy[stoppedBy] += 1;
  }

  // ---- continuation handles ----------------------------------------------------------------------------------------------------

  const chains = new Map<string, Chain>();

  function dropExpired(): void {
    const at = deps.now();
    for (const [handle, chain] of chains) if (chain.expiresAt <= at) chains.delete(handle);
  }

  function remember(chain: Omit<Chain, 'expiresAt'>): string {
    dropExpired();
    while (chains.size >= maxContinuations) {
      const oldest = chains.keys().next();
      if (oldest.done === true) break;
      chains.delete(oldest.value);
    }
    const handle = `c-${randomBytes(16).toString('base64url')}`;
    chains.set(handle, { ...chain, expiresAt: deps.now() + continuationTtlMs });
    return handle;
  }

  /** The record of a handle of this instance, for this very query; anything else is `cursor_invalid`. */
  function resume(handle: string, hash: string): Chain {
    dropExpired();
    const chain = chains.get(handle);
    if (chain?.hash !== hash) throw new QueryRefusal('cursor_invalid');
    chains.delete(handle);
    chains.set(handle, chain); // most recently used
    return chain;
  }

  // ---- one file ----------------------------------------------------------------------------------------------------------------

  async function ensure(
    ctx: RepoContext,
    fileId: number,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<EntryIndexResult> {
    return index.ensureIndexed(ctx, fileId, { budgetMs: Math.max(1, Math.floor(budgetMs)), signal });
  }

  /** Re-checks the file (state, containment, the index up to its last complete line) before any byte of it is read. */
  async function prepare(
    ctx: RepoContext,
    target: Target,
    remainingMs: () => number,
    signal: AbortSignal,
  ): Promise<Prepared> {
    const row = files.get(ctx, target.fileId);
    if (row === undefined || row.state === 'retired' || row.state === 'untracked') return { kind: 'unreadable' };
    if (row.state === 'missing') return { kind: 'missing' };
    const root = await roots(row, files.listForSession(ctx, row.sessionUid));
    if (root === null || !isContained(root, row.path)) return { kind: 'outside' };
    try {
      let state = await ensure(ctx, row.id, remainingMs(), signal);
      if (state.reset && !isAborted(signal)) state = await ensure(ctx, row.id, remainingMs(), signal); // the file was replaced: index it anew
      if (isAborted(signal)) return { kind: 'cancelled' };
      if (!state.complete && state.indexOffset > row.indexOffset) return { kind: 'more_index' };
      return { kind: 'ready', row, index: state };
    } catch (error: unknown) {
      if (error instanceof TranscriptError) {
        if (error.code === 'aborted') return { kind: 'cancelled' };
        return { kind: error.code === 'transcript_gone' ? 'missing' : 'unreadable' };
      }
      if (isFsError(error)) return { kind: classifyFsError(errorCodeOf(error)) };
      throw error;
    }
  }

  function noteProblem(tally: Tally, target: Target, kind: Problem['kind']): void {
    if (kind === 'missing') tally.filesMissing += 1;
    else tally.filesUnreadable += 1;
    if (tally.problems.length < MAX_PROBLEMS) {
      tally.problems.push({ sessionUid: target.sessionUid, agentId: target.agentId, kind });
    }
  }

  // ---- the search loop -----------------------------------------------------------------------------------------------------------

  async function execute(input: ExecInput): Promise<Execution> {
    const { ctx, targets, tally, criteria, signal } = input;
    const startedAt = clock();
    const cap = input.limit + 1; // one more than asked: it proves there is more and is where the next page begins
    const collected: Collected[] = [];
    const relation: RelationSets = { badIds: new Set<string>(), toolIds: new Set<string>() };
    let progress = 0;
    // a call always does some work, so a continuation with a tiny budget still moves on
    const timeUp = (): boolean => progress > 0 && clock() - startedAt >= input.budgetMs;
    const remainingMs = (): number => input.budgetMs - (clock() - startedAt);
    const finish = (stoppedBy: StoppedBy, next: Position | null, stoppedAtFile: number): Execution => {
      if (collected.length > input.limit) collected.length = input.limit;
      return { collected, stoppedBy, next, stoppedAtFile, elapsedMs: Math.max(0, Math.round(clock() - startedAt)) };
    };

    for (let fileIndex = input.start.fileIndex; fileIndex < targets.length; fileIndex += 1) {
      const target = targets[fileIndex];
      if (target === undefined) continue;
      const at = fileIndex === input.start.fileIndex && isResume(input.start) ? input.start : startOfFile(fileIndex);
      if (isAborted(signal)) return finish('cancelled', null, fileIndex);
      if (timeUp()) return finish('time_budget', at, fileIndex);

      const prepared = await prepare(ctx, target, remainingMs, signal);
      if (prepared.kind === 'cancelled') return finish('cancelled', null, fileIndex);
      if (prepared.kind === 'more_index') return finish('time_budget', at, fileIndex);
      if (prepared.kind !== 'ready') {
        if (input.strict && (prepared.kind === 'missing' || prepared.kind === 'outside')) {
          throw new TranscriptError('transcript_gone');
        }
        noteProblem(tally, target, prepared.kind === 'missing' ? 'missing' : 'unreadable');
        progress += 1;
        continue;
      }

      const { row, index: state } = prepared;
      const env: ScanEnv = { path: row.path, chunkBytes, textChars, signal, clock };
      let failure: Problem['kind'] | null = null;
      let changed = false;
      try {
        if (input.relate) {
          const outcome = await scanRelation(
            env,
            state.indexOffset,
            relationPatterns(criteria),
            criteria,
            relation,
            () => (isAborted(signal) ? 'cancelled' : clock() - startedAt >= input.budgetMs ? 'time_budget' : null),
          );
          if (outcome === 'cancelled') return finish('cancelled', null, fileIndex);
          if (outcome === 'time_budget') return finish('time_budget', at, fileIndex);
          if (outcome === 'short') {
            noteProblem(tally, target, 'unreadable');
            progress += 1;
            continue;
          }
        }

        if (at.byteOffset > state.indexOffset || at.entryIndex > state.entriesTotal) {
          noteProblem(tally, target, 'unreadable'); // the file is not what the continuation saw: it was replaced
          progress += 1;
          continue;
        }

        // the blocks from the position on: a block is the range between two checkpoints, the last one runs to the indexed end
        const first = checkpoints.seekByOffset(ctx, row.id, at.byteOffset);
        let afterEntry = first?.entryIndex ?? -1;
        let page: Checkpoint[] = checkpoints.list(ctx, row.id, afterEntry, CHECKPOINT_PAGE);
        let cursor = 0;
        let blockStart = { byteOffset: at.byteOffset, entryIndex: at.entryIndex, skip: at.skip };
        const filter = { prefilter: input.prefilter, criteria, relation };
        for (;;) {
          if (cursor >= page.length && page.length === CHECKPOINT_PAGE) {
            afterEntry = page[page.length - 1]?.entryIndex ?? afterEntry;
            page = checkpoints.list(ctx, row.id, afterEntry, CHECKPOINT_PAGE);
            cursor = 0;
          }
          const nextBlock = page[cursor];
          const blockEnd = Math.min(nextBlock?.byteOffset ?? state.indexOffset, state.indexOffset);
          if (blockEnd > blockStart.byteOffset || nextBlock !== undefined) {
            if (isAborted(signal)) return finish('cancelled', null, fileIndex);
            if (timeUp()) {
              return finish('time_budget', { fileIndex, ...blockStart }, fileIndex);
            }
            const block = {
              start: blockStart.byteOffset,
              end: blockEnd,
              entryIndex: blockStart.entryIndex,
              skip: blockStart.skip,
            };
            const fresh: Hit[] = [];
            const outcome = await scanBlock(env, block, filter, fresh, cap - collected.length);
            for (const hit of fresh) collected.push({ target, hit });
            if (outcome.status === 'cancelled') return finish('cancelled', null, fileIndex);
            if (outcome.status === 'short') {
              changed = true;
              break;
            }
            tally.bytesScanned += outcome.bytes;
            progress += 1;
            if (outcome.status === 'cut') {
              tally.entriesScanned += outcome.entries;
              return finish(
                'match_limit',
                { fileIndex, byteOffset: outcome.at.offset, entryIndex: outcome.at.entryIndex, skip: outcome.at.skip },
                fileIndex,
              );
            }
            tally.entriesScanned +=
              outcome.entries ?? (nextBlock?.entryIndex ?? state.entriesTotal) - blockStart.entryIndex;
          }
          if (nextBlock === undefined) break;
          blockStart = { byteOffset: nextBlock.byteOffset, entryIndex: nextBlock.entryIndex, skip: 0 };
          cursor += 1;
        }

        if (!changed) {
          // the file must still reach the end of what was searched: a shorter file was replaced while the search ran
          try {
            changed = (await stat(row.path)).size < state.indexOffset;
          } catch {
            changed = true;
          }
        }
      } catch (error: unknown) {
        if (!isFsError(error)) throw error;
        failure = classifyFsError(errorCodeOf(error));
      }
      if (failure !== null) {
        noteProblem(tally, target, failure);
        progress += 1;
        continue;
      }
      if (changed) {
        noteProblem(tally, target, 'unreadable');
      } else {
        tally.filesScanned += 1;
        tally.finishedBytes += state.sizeBytes;
        tally.bytesNotIndexed += Math.max(0, state.sizeBytes - state.indexOffset);
      }
      progress += 1;
    }
    return finish('complete', null, targets.length);
  }

  // ---- the coverage ----------------------------------------------------------------------------------------------------------------

  function coverageOf(
    scope: SearchCoverage['scope'],
    run: {
      readonly targets: readonly Target[];
      readonly tally: Tally;
      readonly sessions: number;
      readonly scopeTruncated: boolean;
    },
    ctx: RepoContext,
    result: Execution,
  ): SearchCoverage {
    const { tally } = run;
    let bytesInScope = tally.finishedBytes;
    let bytesNotIndexed = tally.bytesNotIndexed;
    for (let i = result.stoppedAtFile; i < run.targets.length; i += 1) {
      const target = run.targets[i];
      const row = target === undefined ? undefined : files.get(ctx, target.fileId);
      if (row === undefined) continue;
      bytesInScope += row.sizeSeen;
      bytesNotIndexed += Math.max(0, row.sizeSeen - row.indexOffset);
    }
    const complete =
      result.stoppedBy === 'complete' &&
      tally.filesMissing === 0 &&
      tally.filesUnreadable === 0 &&
      bytesNotIndexed === 0 &&
      !run.scopeTruncated;
    const facts: Facts = {
      scope,
      filesInScope: run.targets.length,
      sessions: run.sessions,
      tally,
      bytesInScope,
      bytesNotIndexed,
      scopeTruncated: run.scopeTruncated,
      stoppedBy: result.stoppedBy,
      complete,
    };
    return {
      scope,
      filesInScope: run.targets.length,
      filesScanned: tally.filesScanned,
      filesMissing: tally.filesMissing,
      filesUnreadable: tally.filesUnreadable,
      bytesInScope,
      bytesScanned: tally.bytesScanned,
      bytesNotIndexed,
      entriesScanned: tally.entriesScanned,
      complete,
      stoppedBy: result.stoppedBy,
      elapsedMs: result.elapsedMs,
      note: noteOf(facts),
    };
  }

  // ---- one session ---------------------------------------------------------------------------------------------------------------

  /** The one transcript file a session search reads: the main file, or the file of the agent that was asked for. */
  function sessionTarget(ctx: RepoContext, sessionId: string, agent: string | undefined): Target {
    if (sessions.byUid(ctx, sessionId) === undefined) throw new TranscriptError('session_not_found');
    const siblings = files.listForSession(ctx, sessionId);
    const wanted = agent ?? 'main';
    const file =
      wanted === 'main'
        ? siblings.find((candidate) => candidate.kind === 'session')
        : siblings.find((candidate) => candidate.agentUid === wanted && candidate.kind !== 'session');
    if (file === undefined) throw new TranscriptError('agent_not_found');
    return { fileId: file.id, sessionUid: sessionId, agentId: wanted };
  }

  async function searchSession(
    ctx: RepoContext,
    q: TranscriptSearchQuery,
    signal: AbortSignal,
  ): Promise<TranscriptSearchResponse> {
    db.assertScope(ctx);
    const release = acquire();
    try {
      const target = sessionTarget(ctx, q.session, q.agent);
      const criteria = criteriaOf(q);
      const tally = emptyTally();
      const result = await execute({
        ctx,
        targets: [target],
        start: FIRST_FILE,
        tally,
        criteria,
        prefilter: criteria.needle === '' ? null : buildPrefilter(q.q ?? ''),
        relate: criteria.errors || criteria.tool !== null,
        limit: q.limit,
        budgetMs: q.budgetMs,
        signal,
        strict: true,
      });
      const coverage = coverageOf(
        q.agent === undefined ? 'session' : 'agent',
        { targets: [target], tally, sessions: 1, scopeTruncated: false },
        ctx,
        result,
      );
      record(result.stoppedBy);
      const matches = result.collected.map((entry) => entry.hit);
      return {
        matches,
        count: matches.length,
        truncated: result.stoppedBy === 'match_limit',
        partial: !coverage.complete,
        complete: coverage.complete,
        searchedEntries: coverage.entriesScanned,
        query: { q: q.q ?? '', kinds: kindsOf(q.kinds), tool: q.tool ?? null, errors: q.errors === true },
        coverage,
      };
    } finally {
      release();
    }
  }

  // ---- the instance --------------------------------------------------------------------------------------------------------------

  interface Scope {
    readonly targets: readonly Target[];
    readonly sessions: number;
    readonly truncated: boolean;
  }

  /** The files of the sessions the filters select, most recently active session first, the main file before the agent files. */
  function scopeOf(q: InstanceSearchQuery): Scope {
    const window = resolveWindow(deps, q, 'window', null);
    const bind = new Binder();
    const where = filterSql(deps, { project: q.project, workItem: q.workItem }, window, bind);
    if (q.session !== undefined) where.push(`s.session_uid IN ${bind.list(q.session)}`);
    const rows = db.driver
      .prepare<{ uid: string }>(
        `SELECT s.session_uid AS uid FROM sessions s WHERE ${where.join(' AND ')}
          ORDER BY s.last_activity_at DESC, s.id DESC LIMIT ${bind.bind(maxSessions + 1)}`,
      )
      .all(bind.params);
    const truncated = rows.length > maxSessions;
    const selected = rows.slice(0, maxSessions);
    // the files of all those sessions in one statement; a session keeps its main file first, then its agent files in id order
    const kinds = TRANSCRIPT_KINDS.map((kind) => `'${kind}'`).join(', ');
    const own = new Map<string, FileOfSession[]>();
    for (const file of db.driver
      .prepare<FileOfSession>(
        `SELECT id, session_uid AS uid, kind, agent_uid AS agentUid FROM transcript_files
          WHERE session_uid IN (SELECT value FROM json_each(:uids)) AND kind IN (${kinds}) ORDER BY id`,
      )
      .all({ uids: idsParam(selected.map((row) => row.uid)) })) {
      const list = own.get(file.uid);
      if (list === undefined) own.set(file.uid, [file]);
      else list.push(file);
    }
    const targets: Target[] = [];
    for (const { uid } of selected) {
      const mine = own.get(uid) ?? [];
      for (const file of [...mine.filter((f) => f.kind === 'session'), ...mine.filter((f) => f.kind !== 'session')]) {
        targets.push({
          fileId: file.id,
          sessionUid: uid,
          agentId: file.kind === 'session' ? 'main' : (file.agentUid ?? 'unknown'),
        });
      }
    }
    return { targets, sessions: selected.length, truncated };
  }

  async function searchInstance(
    ctx: RepoContext,
    q: InstanceSearchQuery,
    signal: AbortSignal,
  ): Promise<InstanceSearchResponse> {
    db.assertScope(ctx);
    const release = acquire();
    try {
      const hash = filterHash(filterOf(q, {}, ['limit', 'budgetMs', 'continue']));
      const chain = q.continue === undefined ? undefined : resume(q.continue, hash);
      const scope: Scope =
        chain === undefined
          ? scopeOf(q)
          : { targets: chain.targets, sessions: chain.sessions, truncated: chain.scopeTruncated };
      const tally = chain === undefined ? emptyTally() : cloneTally(chain.tally);
      const criteria = criteriaOf(q);
      const result = await execute({
        ctx,
        targets: scope.targets,
        start: chain?.position ?? FIRST_FILE,
        tally,
        criteria,
        prefilter: buildPrefilter(q.q),
        relate: false,
        limit: q.limit,
        budgetMs: q.budgetMs,
        signal,
        strict: false,
      });
      const coverage = coverageOf(
        'instance',
        { targets: scope.targets, tally, sessions: scope.sessions, scopeTruncated: scope.truncated },
        ctx,
        result,
      );
      record(result.stoppedBy);
      const continuation =
        result.next === null
          ? null
          : remember({
              targets: scope.targets,
              position: result.next,
              tally: cloneTally(tally),
              hash,
              sessions: scope.sessions,
              scopeTruncated: scope.truncated,
            });
      const labels = new Map<string, string>();
      const labelOf = (uid: string): string => {
        let label = labels.get(uid);
        if (label === undefined) {
          label = sessions.byUid(ctx, uid)?.label ?? '';
          labels.set(uid, label);
        }
        return label;
      };
      return {
        query: { q: q.q, kinds: kindsOf(q.kinds) },
        matches: result.collected.map(({ target, hit }) => ({
          sessionId: target.sessionUid,
          sessionLabel: labelOf(target.sessionUid),
          agentId: target.agentId,
          i: hit.i,
          k: hit.k,
          t: hit.t,
          name: hit.name,
          snippet: hit.snippet,
        })),
        truncated: result.stoppedBy === 'match_limit',
        coverage,
        continuation,
      };
    } finally {
      release();
    }
  }

  return {
    searchSession,
    searchInstance,
    stats: () => ({ total: counters.total, byStoppedBy: { ...counters.byStoppedBy } }),
  };
}

/** The query part that `createQueries` registers (03 12.1): the two searches and the counters of the health report. */
export function createSearchQueryPart(db: InstanceDb, deps: QueryDeps): SearchQueries {
  const service = createSearchService(db, { deps });
  return {
    searchSession: (ctx, q, signal) => service.searchSession(ctx, q, signal),
    searchInstance: (ctx, q, signal) => service.searchInstance(ctx, q, signal),
    searchStats: () => service.stats(),
  };
}
