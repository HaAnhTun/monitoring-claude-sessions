// The transcript window and locate reads over the full history (03 7.3, ADR 0016, ADR 0023): the legacy `/api/events` and
// `/api/locate` semantics, with entry indexes that are absolute and stable (the entry index of `index-service.ts`). A request
// resolves the session and the agent to one transcript file, makes sure the index reaches the end of the file (within a budget),
// seeks the checkpoint at or before the first wanted entry and reads forward from there, projecting the records with
// `displayEntries`. The text of the entries lives only in the response: nothing is cached or stored.
//
// The file is re-checked with `realpath` containment (`security/paths.ts`) in the transcripts folder before it is opened: the
// configured `transcripts_dir` when it is an absolute path; with `auto` the discovered project folder of the repository
// (resolved lazily and kept for 10 seconds, CR-WP-33-4 part b); else (nothing discovered) the folder that holds the session's
// main transcript.
import path from 'node:path';

import type {
  TranscriptEntry,
  TranscriptLocateQuery,
  TranscriptLocateResponse,
  TranscriptWindowQuery,
  TranscriptWindowResponse,
} from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { claudeHomeOf, detectTranscriptsDir } from '../ingest/transcripts/discovery.ts';
import { CheckpointsRepo } from '../db/repos/checkpoints.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { TranscriptFilesRepo, type TranscriptFileRow } from '../db/repos/transcript-files.ts';
import { readLines, type RawLine } from '../ingest/tail/jsonl-tailer.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { isContained } from '../security/paths.ts';
import { countEntries, displayEntries, recordTimestamp } from './entries.ts';
import {
  INDEX_CHUNK_BYTES,
  TranscriptError,
  createEntryIndexService,
  entryIndexServiceOf,
  type EntryIndexResult,
  type EntryIndexService,
} from './index-service.ts';

export { TranscriptError } from './index-service.ts';
export type { TranscriptErrorCode } from './index-service.ts';

/** What the route hands to the query layer: the parsed query and the session of the path (03 7.3 reads one session's file). */
export type TranscriptWindowRequest = TranscriptWindowQuery & { readonly sessionId: string };
export type TranscriptLocateRequest = TranscriptLocateQuery & { readonly sessionId: string };

/** The part of `TranscriptQueries` (03 12.1) that this module implements. */
export interface TranscriptWindowQueries {
  window(ctx: RepoContext, q: TranscriptWindowRequest, signal: AbortSignal): Promise<TranscriptWindowResponse>;
  locate(ctx: RepoContext, q: TranscriptLocateRequest, signal: AbortSignal): Promise<TranscriptLocateResponse>;
}

/** What decides the folder that a transcript file must stay inside (shared by the window and the content search). */
export interface TranscriptRootOptions {
  /** `monitor.transcripts_dir`: used as the containment root when it is an absolute path. */
  readonly transcriptsDir: string | null;
  /**
   * With `transcripts_dir: auto`: finds the project folder of the repository, the containment root while it answers a
   * folder. Called lazily, its answer (null included) is kept for `discoverTtlMs`.
   */
  readonly discoverRoot?: () => Promise<string | null>;
  /** How long an answer of `discoverRoot` is kept; production 10 s. */
  readonly discoverTtlMs?: number;
  /** The clock of that cache (default `Date.now`). */
  readonly now?: () => number;
}

/** The containment root of one file of a session (`null` = none can be named, so the file counts as out of reach). */
export type TranscriptRootResolver = (
  file: TranscriptFileRow,
  siblings: readonly TranscriptFileRow[],
) => Promise<string | null>;

export interface TranscriptWindowServiceOptions extends TranscriptRootOptions {
  /** `limits.text_chars` of the configuration: the clip of a window without `textChars`. */
  readonly defaultTextChars: number;
  readonly index?: EntryIndexService;
  /** Read size and step of a scan; production 1 MiB. */
  readonly chunkBytes?: number;
  /** Bytes a window may read from its first wanted entry on; production 8 MiB (03 7.3 step 4). The way to it is not counted. */
  readonly readBudgetBytes?: number;
  /** Time the index may take within one request; production 2000 ms (03 7.3 step 2). */
  readonly indexBudgetMs?: number;
}

export interface TranscriptWindowService {
  read(ctx: RepoContext, q: TranscriptWindowRequest, signal: AbortSignal): Promise<TranscriptWindowResponse>;
  locate(ctx: RepoContext, q: TranscriptLocateRequest, signal: AbortSignal): Promise<TranscriptLocateResponse>;
}

const READ_BUDGET_BYTES = 8 * 1024 * 1024;
const DISCOVER_TTL_MS = 10_000;
const INDEX_BUDGET_MS = 2000;
const DEFAULT_LIMIT = 250;
const DEFAULT_AFTER_LIMIT = 2000;
/** The legacy compare of times is a string compare of ISO texts; a block is skipped only when its latest time is this far before. */
const TS_TOLERANCE_MS = 1000;

/** The folder that holds the session's files: the folder of its main transcript, else the folder above `<session id>/`. */
function derivedRoot(file: TranscriptFileRow, siblings: readonly TranscriptFileRow[]): string | null {
  const main = siblings.find((candidate) => candidate.kind === 'session');
  if (main !== undefined) return path.dirname(main.path);
  const parts = file.path.split(/[\\/]/);
  const at = parts.lastIndexOf(file.sessionUid);
  return at > 0 ? parts.slice(0, at).join(path.sep) || path.sep : null;
}

/**
 * The folder a transcript file must stay inside (03 7.3 step 1): the configured `transcripts_dir` when it is an absolute path;
 * with `auto` the discovered project folder of the repository (resolved lazily, kept for `discoverTtlMs`); else (nothing
 * discovered) the folder that holds the session's main transcript. One resolver keeps one cache.
 */
export function createTranscriptRootResolver(options: TranscriptRootOptions): TranscriptRootResolver {
  const configuredRoot =
    options.transcriptsDir !== null && path.isAbsolute(options.transcriptsDir) ? options.transcriptsDir : null;
  const discoverRoot = configuredRoot === null ? options.discoverRoot : undefined;
  const discoverTtlMs = options.discoverTtlMs ?? DISCOVER_TTL_MS;
  const now = options.now ?? Date.now;
  let discovered: { readonly at: number; readonly root: Promise<string | null> } | null = null;

  /** The discovered project folder (`auto`), cached; a failure counts as "not found". */
  function discoveredRoot(): Promise<string | null> {
    if (discoverRoot === undefined) return Promise.resolve(null);
    const at = now();
    if (discovered === null || at - discovered.at >= discoverTtlMs) {
      discovered = { at, root: discoverRoot().catch(() => null) };
    }
    return discovered.root;
  }

  return async (file, siblings) => configuredRoot ?? (await discoveredRoot()) ?? derivedRoot(file, siblings);
}

/** The root options of the instance: the configured folder, and with `auto` the discovery of the repository's project folder. */
export function transcriptRootOptionsOf(deps: QueryDeps): TranscriptRootOptions {
  const monitor = deps.config.monitor;
  const auto = monitor.transcripts_dir === null || monitor.transcripts_dir === '' || monitor.transcripts_dir === 'auto';
  return {
    transcriptsDir: monitor.transcripts_dir,
    // the server's own environment names the Claude home, as `buildInstanceContext` does
    ...(auto
      ? {
          discoverRoot: () => detectTranscriptsDir(monitor.repo, path.join(claudeHomeOf(process.env), 'projects')),
          now: deps.now,
        }
      : {}),
  };
}

interface Located {
  readonly file: TranscriptFileRow;
}

interface Scan {
  /** True when the byte budget stopped the scan before the end of the range. */
  readonly exhausted: boolean;
}

export function createTranscriptWindowService(
  db: InstanceDb,
  options: TranscriptWindowServiceOptions,
): TranscriptWindowService {
  const sessions = new SessionsRepo(db);
  const files = new TranscriptFilesRepo(db);
  const checkpoints = new CheckpointsRepo(db);
  const chunkBytes = options.chunkBytes ?? INDEX_CHUNK_BYTES;
  // one index service per database unless a test asks for its own sizes: a window and a search never run two passes over a file
  const index =
    options.index ??
    (options.chunkBytes === undefined ? entryIndexServiceOf(db) : createEntryIndexService(db, { chunkBytes }));
  const readBudget = options.readBudgetBytes ?? READ_BUDGET_BYTES;
  const indexBudgetMs = options.indexBudgetMs ?? INDEX_BUDGET_MS;
  const rootOf = createTranscriptRootResolver(options);

  /** Session and agent to the one file (7.3 step 1); every refusal is a `TranscriptError`. */
  async function resolve(ctx: RepoContext, sessionId: string, agent: string): Promise<Located> {
    const session = sessions.byUid(ctx, sessionId);
    if (session === undefined) throw new TranscriptError('session_not_found');
    const siblings = files.listForSession(ctx, sessionId);
    const file =
      agent === 'main'
        ? siblings.find((candidate) => candidate.kind === 'session')
        : siblings.find((candidate) => candidate.agentUid === agent && candidate.kind !== 'session');
    if (file === undefined) throw new TranscriptError('agent_not_found');
    if (file.state === 'missing') throw new TranscriptError('transcript_gone');
    const root = await rootOf(file, siblings);
    if (root === null || !isContained(root, file.path)) throw new TranscriptError('transcript_gone');
    return { file };
  }

  function check(signal: AbortSignal): void {
    if (signal.aborted) throw new TranscriptError('aborted');
  }

  /**
   * Reads whole lines of `[startByte, endByte)` in steps, calling `visit` with each parsed record and the index of its first
   * entry; `visit` answers true to stop. With `wanted` set, `readBudget` counts only the bytes read from the first line that
   * holds an entry at or after `wanted`: the way from the checkpoint to there is not bounded, so a call always returns the
   * first wanted line and a client that continues at `next` always progresses (03 7.3 step 4). Without `wanted` (locate) the
   * scan has no budget at all. `exhausted` is true when the budget stopped the scan before the end of the range.
   */
  async function scan(
    file: TranscriptFileRow,
    start: { byteOffset: number; entryIndex: number },
    endByte: number,
    signal: AbortSignal,
    wanted: number | undefined,
    visit: (line: RawLine, record: unknown, first: number, count: number) => boolean,
  ): Promise<Scan> {
    let offset = start.byteOffset;
    let entry = start.entryIndex;
    let budgetFrom: number | undefined;
    while (offset < endByte) {
      check(signal);
      if (budgetFrom !== undefined && offset - budgetFrom >= readBudget) return { exhausted: true };
      const result = await readLines(file.path, offset, endByte, Number.POSITIVE_INFINITY, {
        chunkBytes,
        sliceBytes: chunkBytes,
        acceptValidUnterminatedTail: false,
      });
      for (const line of result.lines) {
        let record: unknown;
        try {
          record = JSON.parse(line.bytes.toString('utf8'));
        } catch {
          continue;
        }
        const count = countEntries(record);
        if (budgetFrom === undefined && wanted !== undefined && count > 0 && entry + count > wanted) {
          budgetFrom = line.offset;
        }
        if (visit(line, record, entry, count)) return { exhausted: false };
        entry += count;
      }
      if (result.nextOffset <= offset || result.skipping) break;
      offset = result.nextOffset;
    }
    return { exhausted: false };
  }

  async function indexed(ctx: RepoContext, file: TranscriptFileRow, signal: AbortSignal): Promise<EntryIndexResult> {
    const result = await index.ensureIndexed(ctx, file.id, { budgetMs: indexBudgetMs, signal });
    check(signal);
    return result;
  }

  /** The entry `i` of the indexed part: its time. `undefined` when the bytes no longer produce it. */
  async function entryTime(
    ctx: RepoContext,
    file: TranscriptFileRow,
    i: number,
    indexOffset: number,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const from = checkpoints.seekByEntry(ctx, file.id, i) ?? { entryIndex: 0, byteOffset: 0 };
    let found: string | undefined;
    await scan(file, from, indexOffset, signal, undefined, (_line, record, first, count) => {
      if (i < first + count) {
        found = recordTimestamp(record);
        return true;
      }
      return false;
    });
    return found;
  }

  return {
    async read(ctx, q, signal) {
      db.assertScope(ctx);
      const { file } = await resolve(ctx, q.sessionId, q.agent);
      const state = await indexed(ctx, file, signal);
      const base = {
        sessionId: q.sessionId,
        agentId: q.agent,
        base: 0 as const,
        skippedBytes: 0,
        fileState: file.state,
      };
      const asOfSeq = db.headSeq();
      if (state.reset) {
        // the file was replaced: the client sees `total < next` and starts again (legacy)
        return {
          ...base,
          total: 0,
          from: 0,
          next: 0,
          partial: state.sizeBytes > 0,
          pendingBytes: state.sizeBytes,
          asOfSeq,
          events: [],
        };
      }
      const total = state.entriesTotal;
      const pendingBytes = Math.max(0, state.sizeBytes - state.indexOffset);
      const textChars = q.textChars ?? options.defaultTextChars;
      let start: number;
      let end: number;
      if (q.before !== undefined) {
        const limit = q.limit ?? DEFAULT_LIMIT;
        end = Math.min(q.before, total);
        start = Math.max(0, end - limit);
      } else if (q.after < 0) {
        const limit = q.limit ?? DEFAULT_LIMIT;
        start = Math.max(0, total - limit);
        end = total;
      } else {
        const limit = q.limit ?? DEFAULT_AFTER_LIMIT;
        start = Math.min(q.after, total);
        end = Math.min(total, start + limit);
      }

      const events: TranscriptEntry[] = [];
      let next = start;
      if (end > start) {
        const from = checkpoints.seekByEntry(ctx, file.id, start) ?? { entryIndex: 0, byteOffset: 0 };
        await scan(file, from, state.indexOffset, signal, start, (_line, record, first, count) => {
          if (count === 0 || first + count <= start) return false;
          if (first >= end) return true;
          displayEntries(record, { textChars }).forEach((entry, offset) => {
            const i = first + offset;
            if (i < start || i >= end) return;
            if (entry.k === 'think' && q.thinking !== true) return;
            events.push({ i, ...entry });
          });
          next = Math.min(first + count, end);
          return first + count >= end;
        });
      }
      return { ...base, total, from: start, next, partial: pendingBytes > 0, pendingBytes, asOfSeq, events };
    },

    async locate(ctx, q, signal) {
      db.assertScope(ctx);
      const { file } = await resolve(ctx, q.sessionId, q.agent);
      const state = await indexed(ctx, file, signal);
      const total = state.reset ? 0 : state.entriesTotal;
      if (total === 0) throw new TranscriptError('event_not_found');
      const done = (i: number, t: string): TranscriptLocateResponse => ({ i, t, base: 0, total });
      const last = async (): Promise<TranscriptLocateResponse> =>
        done(total - 1, (await entryTime(ctx, file, total - 1, state.indexOffset, signal)) ?? '');

      if (q.i !== undefined) {
        const i = Math.min(Math.max(q.i, 0), total - 1);
        const t = await entryTime(ctx, file, i, state.indexOffset, signal);
        if (t === undefined) throw new TranscriptError('event_not_found');
        return done(i, t);
      }

      if (q.ts !== undefined) {
        const wanted = q.ts;
        const block = checkpoints.firstReachingTs(ctx, file.id, Date.parse(wanted) - TS_TOLERANCE_MS);
        if (block === undefined) return last();
        let hit: TranscriptLocateResponse | undefined;
        await scan(file, block, state.indexOffset, signal, undefined, (_line, record, first, count) => {
          const t = recordTimestamp(record);
          if (count === 0 || t < wanted) return false;
          hit = done(first, t);
          return true;
        });
        return hit ?? last();
      }

      const wantedOffset = q.offset ?? 0;
      const from = checkpoints.seekByOffset(ctx, file.id, wantedOffset) ?? { entryIndex: 0, byteOffset: 0 };
      let hit: TranscriptLocateResponse | undefined;
      await scan(file, from, state.indexOffset, signal, undefined, (line, record, first, count) => {
        if (count === 0 || line.offset < wantedOffset) return false;
        hit = done(first, recordTimestamp(record));
        return true;
      });
      return hit ?? last();
    },
  };
}

/** The query part that `createQueries` registers (03 12.1): `window` and `locate` over this instance's database. */
export function createTranscriptQueryPart(db: InstanceDb, deps: QueryDeps): TranscriptWindowQueries {
  const service = createTranscriptWindowService(db, {
    ...transcriptRootOptionsOf(deps),
    defaultTextChars: deps.config.monitor.limits['text_chars'] ?? 6000,
  });
  return {
    window: (ctx, q, signal) => service.read(ctx, q, signal),
    locate: (ctx, q, signal) => service.locate(ctx, q, signal),
  };
}
