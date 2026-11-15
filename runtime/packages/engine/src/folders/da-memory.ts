// The DA memory reader (CAW design 03 section 3, D5): the folders that the memory hook of the reference product keeps under
// `<home>/.claude/memory`, read by TypeScript and never written.
//
// `<slug>/meta.json` is the authority (one folder each); `index.json` is a cache that is read only when no `meta.json` could be.
// Only a redacted summary of 120 code points, two counts and a time leave this module. `brain.md` and `action.md` hold prompts
// and answers verbatim, `da-memory.py` is a script and `*.key` are secrets: none of them is ever opened, and the `sessions`
// array, `created`, `status` and `last_kind` of a `meta.json` are parsed and dropped. Nothing is logged here.
import { readdir as nodeReaddir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { folderPathKey, parseDaTimestamp, windowsFolderPath } from '@mcs/shared';
import { redact } from '@mcs/shared/protocol';

import { clipCodePoints } from '../platform/fsx.ts';
import { hostPlatform } from '../platform/host.ts';
import { classifyFsError, errorCodeOf } from '../ingest/tail/file-identity.ts';
import { mapLimit, nodeDiscoveryFs } from '../ingest/transcripts/discovery.ts';

/** The reader opens no `meta.json` larger than this: `sessions` grows without bound. */
export const DA_META_MAX_BYTES = 512 * 1024;
/** The reader opens no `index.json` larger than this. */
export const DA_INDEX_MAX_BYTES = 1024 * 1024;
/** Folders returned at most. */
export const DA_MAX_FOLDERS = 500;
/** Names looked at in one scan; a memory folder with more entries than this is not a memory folder anybody keeps by hand. */
const MAX_CANDIDATES = 5000;
/** Index entries looked at. */
const MAX_INDEX_ENTRIES = 5000;
const SUMMARY_MAX_CODE_POINTS = 120;
const READ_PARALLEL = 16;
const DEFAULT_CACHE_MS = 3000;

/** A name that can be a folder of the memory (the slug rule of the hook is `[A-Za-z0-9-]`; a dot is tolerated). */
const CANDIDATE_RE = /^[A-Za-z0-9._-]{1,255}$/;
/** Entries of the memory folder that are known not to be folders: never a candidate, never counted. */
const NOT_A_FOLDER = (name: string): boolean =>
  name === '.' || name === '..' || name === 'index.json' || name.endsWith('.key') || name.endsWith('.py');

/** The two operations the reader needs from the file system; a test passes a spy. */
export interface DaFs {
  /** The names in a folder, or the error code when it cannot be listed. */
  readdir(dir: string): Promise<readonly string[] | { readonly code: string }>;
  /** The whole text of a small file; null when it is gone, unreadable or larger than `maxBytes`. */
  readText(file: string, maxBytes: number): Promise<string | null>;
}

export const nodeDaFs: DaFs = {
  async readdir(dir) {
    try {
      return await nodeReaddir(dir);
    } catch (error) {
      return { code: errorCodeOf(error) };
    }
  },
  readText: (file, maxBytes) => nodeDiscoveryFs.readText(file, maxBytes),
};

export interface DaFolder {
  /** The folder name of the memory, informational: a DA slug is never a Claude project key. */
  readonly slug: string;
  /** `meta.path` as the hook wrote it. */
  readonly rawPath: string;
  /** `windowsFolderPath(rawPath)`; null when it cannot be a folder on this host (UNC, device path, relative, ...). */
  readonly path: string | null;
  /** The `last_updated` of the hook (local time); null when absent or not exactly the documented format. */
  readonly lastUpdatedMs: number | null;
  /** Redacted, whitespace collapsed, at most 120 code points. */
  readonly summary: string;
  readonly brain: number;
  readonly action: number;
  /** Other entries of the memory folded into this one (same folder, other spelling). */
  readonly merged: number;
}

export interface DaMemoryResult {
  readonly status: 'ok' | 'absent' | 'unreadable';
  /** Newest first, `null` times last, ties by slug; at most `maxFolders`. */
  readonly folders: DaFolder[];
  /** Entries without a usable `meta.json`. */
  readonly skipped: number;
  readonly readAtMs: number;
}

export interface DaMemoryReader {
  read(nowMs: number): Promise<DaMemoryResult>;
}

export interface DaMemoryReaderOptions {
  readonly dir: string;
  readonly fs?: DaFs;
  /** How long a result is reused (single flight in any case). */
  readonly cacheMs?: number;
  readonly maxFolders?: number;
  /** Which spelling of a path a folder may have (default: the host). */
  readonly win32?: boolean;
}

/** `<home>/.claude/memory`: where the hook writes, even when `CLAUDE_CONFIG_DIR` points elsewhere. */
export function defaultDaMemoryDir(): string {
  return path.join(os.homedir(), '.claude', 'memory');
}

// ---- parsing ------------------------------------------------------------------------------------------------------------------

function isPlain(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Control characters, format characters (the right-to-left override among them) and line separators become nothing or one space. */
function cleanSummary(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) text += ' ';
    else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(char)) continue;
    else text += char;
  }
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return clipCodePoints(redact(collapsed), SUMMARY_MAX_CODE_POINTS).trim();
}

interface RawFolder {
  readonly slug: string;
  readonly rawPath: string;
  readonly lastUpdatedMs: number | null;
  readonly summary: string;
  readonly brain: number;
  readonly action: number;
}

/** The fields of one folder from a `meta.json` object or an `index.json` entry; null without a non-empty string `path`. */
function rawFolderOf(slug: string, value: unknown): RawFolder | null {
  if (!isPlain(value)) return null;
  const rawPath = value['path'];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
  const counts = isPlain(value['counts']) ? value['counts'] : {};
  return {
    slug,
    rawPath,
    lastUpdatedMs: parseDaTimestamp(value['last_updated']),
    summary: cleanSummary(value['summary']),
    brain: count(counts['brain']),
    action: count(counts['action']),
  };
}

function compareSlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first, a missing time last, then the smaller slug. */
function newerFirst(
  a: { lastUpdatedMs: number | null; slug: string },
  b: { lastUpdatedMs: number | null; slug: string },
): number {
  if (a.lastUpdatedMs !== b.lastUpdatedMs) {
    if (a.lastUpdatedMs === null) return 1;
    if (b.lastUpdatedMs === null) return -1;
    return b.lastUpdatedMs - a.lastUpdatedMs;
  }
  return compareSlug(a.slug, b.slug);
}

function addCounts(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

/** Folds the entries that name one folder (`folderPathKey`) into the newest of them. */
function dedupe(raw: readonly RawFolder[], win32: boolean): DaFolder[] {
  const groups = new Map<string, RawFolder[]>();
  for (const entry of raw) {
    const usable = windowsFolderPath(entry.rawPath, win32);
    // an entry without a usable path has no identity: it is only ever equal to itself
    const key = usable === null ? `raw:${entry.slug}` : folderPathKey(usable);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  const out: DaFolder[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(newerFirst);
    const winner = ordered[0];
    if (winner === undefined) continue;
    out.push({
      slug: winner.slug,
      rawPath: winner.rawPath,
      path: windowsFolderPath(winner.rawPath, win32),
      lastUpdatedMs: winner.lastUpdatedMs,
      summary: winner.summary,
      brain: group.reduce((sum, entry) => addCounts(sum, entry.brain), 0),
      action: group.reduce((sum, entry) => addCounts(sum, entry.action), 0),
      merged: group.length - 1,
    });
  }
  return out.sort(newerFirst);
}

// ---- the reader -----------------------------------------------------------------------------------------------------------------

async function scan(dir: string, fs: DaFs, maxFolders: number, win32: boolean, nowMs: number): Promise<DaMemoryResult> {
  const names = await fs.readdir(dir);
  if ('code' in names) {
    return {
      status: classifyFsError(names.code) === 'missing' ? 'absent' : 'unreadable',
      folders: [],
      skipped: 0,
      readAtMs: nowMs,
    };
  }
  const candidates = names
    .filter((name) => CANDIDATE_RE.test(name) && !NOT_A_FOLDER(name))
    .sort(compareSlug)
    .slice(0, MAX_CANDIDATES);
  const parsed = await mapLimit(candidates, READ_PARALLEL, async (slug) => {
    const text = await fs.readText(path.join(dir, slug, 'meta.json'), DA_META_MAX_BYTES);
    return text === null ? null : rawFolderOf(slug, parseJson(text));
  });
  const raw = parsed.filter((entry): entry is RawFolder => entry !== null);
  const skipped = parsed.length - raw.length;
  if (raw.length === 0) {
    // degraded mode: the cache of the hook, only when no folder could be read from its own file
    const fromIndex = await readIndex(dir, fs);
    return {
      status: 'ok',
      folders: dedupe(fromIndex, win32).slice(0, maxFolders),
      skipped,
      readAtMs: nowMs,
    };
  }
  return { status: 'ok', folders: dedupe(raw, win32).slice(0, maxFolders), skipped, readAtMs: nowMs };
}

async function readIndex(dir: string, fs: DaFs): Promise<RawFolder[]> {
  const text = await fs.readText(path.join(dir, 'index.json'), DA_INDEX_MAX_BYTES);
  if (text === null) return [];
  const parsed = parseJson(text);
  const folders = isPlain(parsed) ? parsed['folders'] : undefined;
  if (!Array.isArray(folders)) return [];
  const out: RawFolder[] = [];
  const entries: unknown[] = folders.slice(0, MAX_INDEX_ENTRIES);
  for (const entry of entries) {
    const slug = isPlain(entry) && typeof entry['slug'] === 'string' ? entry['slug'] : '';
    const folder = rawFolderOf(slug, entry);
    if (folder !== null) out.push(folder);
  }
  return out;
}

export function createDaMemoryReader(options: DaMemoryReaderOptions): DaMemoryReader {
  const fs = options.fs ?? nodeDaFs;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const maxFolders = options.maxFolders ?? DA_MAX_FOLDERS;
  const win32 = options.win32 ?? hostPlatform === 'win32';
  let cached: DaMemoryResult | null = null;
  let inFlight: Promise<DaMemoryResult> | null = null;

  async function run(nowMs: number): Promise<DaMemoryResult> {
    try {
      return await scan(options.dir, fs, maxFolders, win32, nowMs);
    } catch {
      return { status: 'unreadable', folders: [], skipped: 0, readAtMs: nowMs };
    }
  }

  return {
    read(nowMs) {
      if (cached !== null) {
        const age = nowMs - cached.readAtMs;
        if (age >= 0 && age < cacheMs) return Promise.resolve(cached);
      }
      if (inFlight !== null) return inFlight;
      const flight = run(nowMs).then((result) => {
        cached = result;
        inFlight = null;
        return result;
      });
      inFlight = flight;
      return flight;
    },
  };
}
