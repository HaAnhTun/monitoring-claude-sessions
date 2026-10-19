// Transcript content search, the scanning half (03 7.4, ADR 0023): the match rules of the legacy `/api/search`, the prefilter
// that lets a block of a transcript be skipped without parsing it, and the block scan that reads whole lines in slices of about
// 1 MiB. A needle can never straddle two reads: a slice is a run of whole lines, and a line longer than the slice is one slice.
//
// The prefilter is a necessary condition, never a verdict: it may let a block through that has no match (the verification of
// `keeps` decides), but it must not hide a block that has one. So it tests the needle only in the forms the raw file can hold
// (the text as a JSON string, written raw or with `\uXXXX` escapes) and only for the characters whose raw form is certain.
// Characters that the display projection rewrites (quotes and backslashes inside the JSON text of a tool input, braces,
// colons and commas of the printer, control characters) cut the needle into runs, and the longest run is the prefilter; a
// needle without a usable run, or one that could match the synthetic truncation note, is not prefiltered at all.
//
// What is searched is the display text of the entries, as the transcript window shows it (the legacy `/api/search`): long texts are
// clipped at `limits.text_chars`, so a needle beyond the clip is not found, and the note ` ... [truncated K chars]` that the clip
// appends is part of that text. Case is folded with `toLowerCase` on both sides (simple folding: a sharp s does not match ss,
// and a search for i does not find U+0130).
//
// Everything here works on the bytes of a transcript file for the length of one request: no text is stored, cached or logged
// (ADR 0016, ADR 0022).
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { EntryKind } from '@mcs/shared';

import { readLines, type ReadResult } from '../ingest/tail/jsonl-tailer.ts';
import { countEntries, displayEntries, type DisplayEntry } from '../transcript/entries.ts';

const BACKSLASH = String.fromCharCode(92);
const WHITESPACE_RUN = `${BACKSLASH}s*`;

// ---- the prefilter ----------------------------------------------------------------------------------------------------------

const REGEX_SPECIALS: ReadonlySet<string> = new Set(`.*+?^\${}()|[]-/${BACKSLASH}`);

/** `text` as the source of a regular expression that matches it literally. */
export function escapeRegExp(text: string): string {
  let out = '';
  for (const char of text) out += REGEX_SPECIALS.has(char) ? `${BACKSLASH}${char}` : char;
  return out;
}

/** Characters whose raw form in the file is not the form the display projection shows (see the header). */
const UNSAFE_CHARS: ReadonlySet<string> = new Set(['"', BACKSLASH, '{', '}', '[', ']', ':', ',']);

function isUnsafe(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return UNSAFE_CHARS.has(char) || code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff);
}

/** The longest stretch of `text` without an unsafe character, with its spaces trimmed (a join space is not in the file). */
function longestSafeRun(text: string): string {
  let best = '';
  let current = '';
  const close = (): void => {
    const run = current.trim();
    if (run.length > best.length) best = run;
    current = '';
  };
  for (const char of text) {
    if (isUnsafe(char)) close();
    else current += char;
  }
  close();
  return best;
}

const CLIP_NOTE = 'truncated 0 chars';

/**
 * True when a lower-cased run could be text of the note ` ... [truncated K chars]` that the display projection appends to a
 * long entry. The note is not in the file, so a block cannot be skipped for such a run: it is matched on the display text.
 */
function mayBeInClipNote(runLower: string): boolean {
  if (/^[.\s]+$/.test(runLower) || /^[0-9]+$/.test(runLower)) return true;
  return CLIP_NOTE.includes(runLower.replace(/[0-9]+/g, '0'));
}

function hex4(unit: number): string {
  return unit.toString(16).padStart(4, '0');
}

/** `\uXXXX` for every UTF-16 unit of `char`, as the source of a literal match. */
function escapedUnits(char: string): string {
  let out = '';
  for (let i = 0; i < char.length; i += 1) out += `${BACKSLASH}${BACKSLASH}u${hex4(char.charCodeAt(i))}`;
  return out;
}

/** One character of the needle: ASCII as it is, any other as itself or as the `\uXXXX` of it, of its lower and of its upper case. */
function charPattern(char: string): string {
  if ((char.codePointAt(0) ?? 0) < 0x80) return escapeRegExp(char);
  const forms = new Set([char, char.toLowerCase(), char.toUpperCase()]);
  const alternatives = [escapeRegExp(char)];
  for (const form of forms) {
    if (Array.from(form).length === 1) alternatives.push(escapedUnits(form));
  }
  return `(?:${alternatives.join('|')})`;
}

/**
 * The prefilter of a needle: a case-insensitive expression that matches the raw text of every line whose display entries can
 * contain the needle, or `null` when no prefilter is safe (every block is then parsed).
 */
export function buildPrefilter(needle: string): RegExp | null {
  const run = longestSafeRun(needle);
  if (run === '' || mayBeInClipNote(run.toLowerCase())) return null;
  let source = '';
  for (const char of run) source += charPattern(char);
  return new RegExp(source, 'i');
}

/** The prefilters of the relation pass: result entries that failed, and tool entries of one tool name. */
export function relationPatterns(criteria: Pick<Criteria, 'errors' | 'tool'>): RegExp[] {
  const patterns: RegExp[] = [];
  if (criteria.errors) patterns.push(new RegExp(`"is_error"${WHITESPACE_RUN}:${WHITESPACE_RUN}true`));
  if (criteria.tool !== null) {
    patterns.push(
      new RegExp(`"name"${WHITESPACE_RUN}:${WHITESPACE_RUN}${escapeRegExp(JSON.stringify(criteria.tool))}`),
    );
  }
  return patterns;
}

// ---- matching ---------------------------------------------------------------------------------------------------------------

export interface Criteria {
  /** The needle, lower-cased; the empty text matches every entry. */
  readonly needle: string;
  /** The entry kinds that may match; `null` = all five. */
  readonly kinds: ReadonlySet<EntryKind> | null;
  /** Keeps tool entries of this name and their results. */
  readonly tool: string | null;
  /** Keeps result entries that failed and their tool entries. */
  readonly errors: boolean;
}

/** The ids that tie a tool entry to its result (a tool call and its result are different records, often in different blocks). */
export interface Relation {
  /** Ids of the results that failed. */
  readonly badIds: ReadonlySet<string>;
  /** Ids of the tool entries named `criteria.tool`. */
  readonly toolIds: ReadonlySet<string>;
}

export const NO_RELATION: Relation = { badIds: new Set<string>(), toolIds: new Set<string>() };

/** The text the needle is looked for in: `text + ' ' + summary + ' ' + input + ' ' + name`, a missing field as the empty text. */
export function haystackOf(entry: DisplayEntry): string {
  return [entry.text ?? '', entry.summary ?? '', entry.input ?? '', entry.name ?? ''].join(' ');
}

/** The legacy `/api/search` predicate for one display entry (03 7.4). */
export function keeps(entry: DisplayEntry, criteria: Criteria, relation: Relation): boolean {
  if (criteria.kinds !== null && !criteria.kinds.has(entry.k)) return false;
  if (criteria.errors) {
    const failed = entry.k === 'result' && entry.err === true;
    const failedCall = entry.k === 'tool' && entry.id !== undefined && relation.badIds.has(entry.id);
    if (!failed && !failedCall) return false;
  }
  if (criteria.tool !== null) {
    const named = entry.k === 'tool' && entry.name === criteria.tool;
    const itsResult = entry.k === 'result' && entry.id !== undefined && relation.toolIds.has(entry.id);
    if (!named && !itsResult) return false;
  }
  return criteria.needle === '' || haystackOf(entry).toLowerCase().includes(criteria.needle);
}

const SNIPPET_BEFORE = 40;
const SNIPPET_CHARS = 160;

/** The first of the three texts that is not empty (the legacy `text or summary or input`). */
function sourceOf(entry: DisplayEntry): string {
  for (const candidate of [entry.text, entry.summary, entry.input]) {
    if (candidate !== undefined && candidate !== '') return candidate;
  }
  return '';
}

/** Up to 160 characters of the entry text, starting 40 characters before the first match (code points, as the legacy code). */
export function snippetOf(entry: DisplayEntry, needle: string): string {
  const source = sourceOf(entry);
  let start = 0;
  if (needle !== '') {
    const lowered = source.toLowerCase();
    const at = lowered.indexOf(needle);
    if (at > 0) start = Math.max(0, Array.from(lowered.slice(0, at)).length - SNIPPET_BEFORE);
  }
  return Array.from(source)
    .slice(start, start + SNIPPET_CHARS)
    .join('');
}

/** One match: the entry, its absolute index and the byte offset of the line that holds it (`locate` takes the offset). */
export interface Hit {
  readonly i: number;
  readonly k: EntryKind;
  readonly t: string;
  readonly name: string | null;
  readonly snippet: string;
  readonly offset: number;
}

function hitOf(entry: DisplayEntry, i: number, offset: number, needle: string): Hit {
  return {
    i,
    k: entry.k,
    t: entry.t,
    name: entry.name === undefined || entry.name === '' ? null : entry.name,
    snippet: snippetOf(entry, needle),
    offset,
  };
}

// ---- reading ----------------------------------------------------------------------------------------------------------------

/** The size of one read and of one slice of lines; production 1 MiB (03 6.4). */
export const SLICE_BYTES = 1024 * 1024;
/** After this many milliseconds of synchronous work the scan lets the event loop run (DA-T-S-5: gaps stay below 20 ms). */
const BREATHE_MS = 4;

export interface ScanEnv {
  readonly path: string;
  readonly chunkBytes: number;
  /** `limits.text_chars`: the clip of the display entries, as in the window. */
  readonly textChars: number;
  readonly signal: AbortSignal;
  /** Monotonic milliseconds. */
  readonly clock: () => number;
}

/** One slice of whole lines of `[from, to)`: about `chunkBytes` of them, or one line when that line is longer. */
function readSlice(env: ScanEnv, from: number, to: number): Promise<ReadResult> {
  return readLines(env.path, from, to, Number.POSITIVE_INFINITY, {
    chunkBytes: env.chunkBytes,
    sliceBytes: env.chunkBytes,
    acceptValidUnterminatedTail: false,
  });
}

function textOf(result: ReadResult): string {
  return Buffer.concat(result.lines.map((line) => line.bytes)).toString('utf8');
}

/** Lets the event loop run when this turn has lasted a while; the caller checks the signal afterwards. */
function breather(env: ScanEnv): () => Promise<void> {
  let turnStart = env.clock();
  return async () => {
    if (env.clock() - turnStart < BREATHE_MS) return;
    await nextTurn();
    turnStart = env.clock();
  };
}

function parseText(text: string): unknown {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined; // an invalid line produces no entries (the importer counts it)
  }
  return record;
}

/** `signal.aborted` read afresh: a flag that an earlier check narrowed to false can be true again after an await. */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// ---- one block --------------------------------------------------------------------------------------------------------------

/** A range of whole lines that the entry index describes: it starts at an entry index and a line start. */
export interface BlockRange {
  readonly start: number;
  readonly end: number;
  /** The absolute index of the first entry produced at or after `start`. */
  readonly entryIndex: number;
  /** Matches of the first line that an earlier page delivered already. */
  readonly skip: number;
}

export interface ScanFilter {
  /** `null`: parse every line. */
  readonly prefilter: RegExp | null;
  readonly criteria: Criteria;
  readonly relation: Relation;
}

export interface CutPoint {
  /** Byte offset of the line that holds the last match taken. */
  readonly offset: number;
  /** The entry index at the start of that line. */
  readonly entryIndex: number;
  /** The position of that match among the matches of its line. */
  readonly skip: number;
}

export type BlockOutcome =
  /** The block was read to its end; `entries` is `null` when it was skipped unparsed (the caller counts from the checkpoints). */
  | { readonly status: 'done'; readonly bytes: number; readonly entries: number | null }
  /** The file ended before the range did: it changed under the search. */
  | { readonly status: 'short' }
  | { readonly status: 'cancelled' }
  /** `room` matches were taken; the last one is at `at`, where a later page resumes. */
  | { readonly status: 'cut'; readonly bytes: number; readonly entries: number; readonly at: CutPoint };

/** True when the slice made no progress although the range is not read to its end: the file is shorter than the index says. */
function stalled(slice: ReadResult, offset: number): boolean {
  return slice.nextOffset <= offset || slice.skipping;
}

/** Looks for the prefilter in the slices of a block. Returns the first slice when that one holds it (it is not read twice). */
async function probeBlock(
  env: ScanEnv,
  block: BlockRange,
  prefilter: RegExp,
): Promise<'miss' | 'cancelled' | 'short' | { readonly first: ReadResult | null }> {
  const breathe = breather(env);
  let offset = block.start;
  while (offset < block.end) {
    if (isAborted(env.signal)) return 'cancelled';
    const slice = await readSlice(env, offset, block.end);
    if (stalled(slice, offset)) return 'short';
    if (prefilter.test(textOf(slice))) return { first: offset === block.start ? slice : null };
    offset = slice.nextOffset;
    await breathe();
  }
  return 'miss';
}

/**
 * Scans one block: the prefilter first (a block without a hit is skipped and read once), then every line is parsed in order,
 * numbered from the checkpoint of the block, and the entries of the lines that hold the prefilter are verified. Appends at most
 * `room` matches to `out`; when the last of them is taken the scan stops there (`cut`).
 */
export async function scanBlock(
  env: ScanEnv,
  block: BlockRange,
  filter: ScanFilter,
  out: Hit[],
  room: number,
): Promise<BlockOutcome> {
  let first: ReadResult | null = null;
  if (filter.prefilter !== null) {
    const probed = await probeBlock(env, block, filter.prefilter);
    if (probed === 'cancelled' || probed === 'short') return { status: probed };
    if (probed === 'miss') return { status: 'done', bytes: block.end - block.start, entries: null };
    first = probed.first;
  }

  const { criteria, relation, prefilter } = filter;
  const breathe = breather(env);
  const taken = out.length;
  let offset = block.start;
  let entry = block.entryIndex;
  let slice: ReadResult | null = first;
  while (offset < block.end) {
    if (isAborted(env.signal)) return { status: 'cancelled' };
    slice ??= await readSlice(env, offset, block.end);
    if (stalled(slice, offset)) return { status: 'short' };
    for (const line of slice.lines) {
      await breathe();
      if (isAborted(env.signal)) return { status: 'cancelled' };
      const text = line.bytes.toString('utf8');
      const record = parseText(text);
      if (record === undefined) continue;
      if (prefilter !== null && !prefilter.test(text)) {
        entry += countEntries(record);
        continue;
      }
      const entries = displayEntries(record, { textChars: env.textChars });
      const found: Hit[] = [];
      entries.forEach((candidate, index) => {
        if (keeps(candidate, criteria, relation)) {
          found.push(hitOf(candidate, entry + index, line.offset, criteria.needle));
        }
      });
      for (let at = line.offset === block.start ? block.skip : 0; at < found.length; at += 1) {
        const hit = found[at];
        if (hit === undefined) continue;
        out.push(hit);
        if (out.length - taken >= room) {
          return {
            status: 'cut',
            bytes: line.offset - block.start,
            entries: entry - block.entryIndex,
            at: { offset: line.offset, entryIndex: entry, skip: at },
          };
        }
      }
      entry += entries.length;
    }
    offset = slice.nextOffset;
    slice = null;
  }
  return { status: 'done', bytes: block.end - block.start, entries: entry - block.entryIndex };
}

// ---- the relation pass --------------------------------------------------------------------------------------------------------

export type RelationOutcome = 'done' | 'cancelled' | 'time_budget' | 'short';

/** What the relation pass fills: the ids that tie a tool entry to its result. */
export interface RelationSets {
  readonly badIds: Set<string>;
  readonly toolIds: Set<string>;
}

/**
 * Reads `[0, end)` once and collects, from the lines that hold one of the `patterns`, the ids of the results that failed and of
 * the tool entries named `criteria.tool`. A tool entry and its result are different records, so a block cannot tell by itself
 * whether its tool entry belongs to a failed call; this pass answers it before the blocks are verified.
 */
export async function scanRelation(
  env: ScanEnv,
  end: number,
  patterns: readonly RegExp[],
  criteria: Pick<Criteria, 'tool'>,
  into: RelationSets,
  interrupt: () => 'cancelled' | 'time_budget' | null,
): Promise<RelationOutcome> {
  const breathe = breather(env);
  let offset = 0;
  while (offset < end) {
    const stop = interrupt();
    if (stop !== null) return stop;
    const slice = await readSlice(env, offset, end);
    if (stalled(slice, offset)) return 'short';
    const text = textOf(slice);
    if (patterns.some((pattern) => pattern.test(text))) {
      for (const line of slice.lines) {
        const lineText = line.bytes.toString('utf8');
        if (!patterns.some((pattern) => pattern.test(lineText))) continue;
        const record = parseText(lineText);
        if (record === undefined) continue;
        for (const candidate of displayEntries(record, { textChars: 0 })) {
          if (candidate.id === undefined) continue;
          if (candidate.k === 'result' && candidate.err === true) into.badIds.add(candidate.id);
          if (candidate.k === 'tool' && criteria.tool !== null && candidate.name === criteria.tool) {
            into.toolIds.add(candidate.id);
          }
        }
      }
    }
    offset = slice.nextOffset;
    await breathe();
  }
  return 'done';
}
