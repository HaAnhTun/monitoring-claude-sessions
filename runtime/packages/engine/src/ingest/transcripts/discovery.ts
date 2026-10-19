// Transcript discovery (02 5.1, port of `sessions.py` plus the survey facts): where the transcripts of a repository are, and
// which files below that folder the importer may track.
//
// Every path that is opened comes from a `readdir` of the transcripts folder or of a session folder inside it. Only regular
// files and real folders are used: a link or junction is counted (`SYMLINK_SKIPPED`) and not followed. Names that end in
// `.key`, the folders `tool-results`, `memory` and `workflows/scripts`, and every name that is not an id of the documented
// form are never touched. The file system is a parameter so that a test can see exactly which paths were looked at.
import { lstat as nodeLstat, open, readdir as nodeReaddir, realpath as nodeRealpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_RE,
  RUN_ID_RE,
  SID_RE,
  TOOL_ID_RE,
  normalizePath,
  redact,
  sanitizeProjectName,
} from '@mcs/shared/protocol';

import type { TranscriptFileKind } from '../../db/repos/transcript-files.ts';
import { clipCodePoints } from '../../platform/fsx.ts';
import { pathsCaseInsensitive } from '../../platform/host.ts';

export { sanitizeProjectName };

// ---- the file system the module looks at -----------------------------------------------------------------------------------

export interface EntryStat {
  /** `link` is a symbolic link or a junction; `other` is a device, pipe or socket. */
  readonly kind: 'file' | 'dir' | 'link' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
  /** Birth time where the platform has one. */
  readonly birthMs: number | null;
}

export interface DiscoveryFs {
  /** The names in a folder; rejects when it cannot be listed (missing, not a folder, no access). */
  readdir(dir: string): Promise<readonly string[]>;
  /** The entry itself (a link is not followed); null when it is gone or cannot be looked at. */
  lstat(file: string): Promise<EntryStat | null>;
  /** The whole text of a small file; null when it is gone, unreadable or larger than `maxBytes`. */
  readText(file: string, maxBytes: number): Promise<string | null>;
  /** At most `maxBytes` from the start of a file; null when it is gone or unreadable. */
  readHead(file: string, maxBytes: number): Promise<Buffer | null>;
  /** The real path of a folder (links resolved); null when it cannot be resolved. Optional: without it no real path is tried. */
  realpath?(file: string): Promise<string | null>;
}

export const nodeDiscoveryFs: DiscoveryFs = {
  readdir: (dir) => nodeReaddir(dir),
  async lstat(file) {
    try {
      const st = await nodeLstat(file);
      const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
      return {
        kind,
        size: st.size,
        mtimeMs: st.mtimeMs,
        birthMs: st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : null,
      };
    } catch {
      return null;
    }
  },
  async readText(file, maxBytes) {
    const read = await readFrom(file, maxBytes);
    return read === null || read.size > maxBytes ? null : read.bytes.toString('utf8');
  },
  async readHead(file, maxBytes) {
    return (await readFrom(file, maxBytes))?.bytes ?? null;
  },
  async realpath(file) {
    try {
      return await nodeRealpath(file);
    } catch {
      return null;
    }
  },
};

/** At most `maxBytes` of a file and its whole size; null when it cannot be opened or read. */
async function readFrom(file: string, maxBytes: number): Promise<{ bytes: Buffer; size: number } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const want = Math.min(maxBytes, size);
    const buffer = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await handle.read(buffer, filled, want - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { bytes: buffer.subarray(0, filled), size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// ---- the transcripts folder -------------------------------------------------------------------------------------------------

/**
 * The Claude home (Claude Code docs, 2026-10-18): `CLAUDE_CONFIG_DIR` when it is set and not empty (a relative value is
 * resolved against the current directory), else `~/.claude` on every OS (`os.homedir()`: `USERPROFILE` on Windows, `HOME`
 * elsewhere). The one definition: `runtime/context.ts` imports it.
 */
export function claudeHomeOf(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(os.homedir(), '.claude');
}

/** `<claude home>/projects` (legacy `projects_root`). */
export function projectsRoot(env: Readonly<Record<string, string | undefined>>): string {
  return path.join(claudeHomeOf(env), 'projects');
}

/** Characters of a project folder name before Claude Code cuts it and appends a hash of the full path. */
export const PROJECT_NAME_MAX = 200;

const SEPARATORS = new Set(['/', String.fromCharCode(92)]);

/**
 * The project folder name Claude Code derives from a working directory: trailing separators dropped (a working directory
 * never has one), every character outside `[A-Za-z0-9]` replaced by `-`. A name longer than 200 characters is cut to 200 and
 * followed by `-<hash of the full path>`; the hash is not reproduced here, so `truncated` marks `name` as that prefix.
 */
export function projectFolderName(directory: string): { readonly name: string; readonly truncated: boolean } {
  let end = directory.length;
  while (end > 1 && SEPARATORS.has(directory[end - 1] ?? '')) end -= 1;
  let trimmed = directory.slice(0, end);
  if (/^[A-Za-z]:$/.test(trimmed)) trimmed = directory.slice(0, end + 1);
  const name = sanitizeProjectName(trimmed);
  return name.length > PROJECT_NAME_MAX
    ? { name: name.slice(0, PROJECT_NAME_MAX), truncated: true }
    : { name, truncated: false };
}

export interface DetectOptions {
  /** Compare names and paths without case (default: the host, true on Windows and macOS, false on Linux). */
  readonly caseInsensitive?: boolean;
}

/** Lines of a file that the legacy `first_cwd` looks at (`i > 60` break). */
const FIRST_CWD_LINES = 61;
const FIRST_CWD_BYTES = 1024 * 1024;
/** Files of a folder whose first lines name a working directory (legacy `[:3]`). */
const NEWEST_FILES = 3;

function isPlain(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `cwd` of the first record with a truthy one within the first 61 lines of a file ('' when there is none). */
async function firstCwd(fs: DiscoveryFs, file: string): Promise<string> {
  const head = await fs.readHead(file, FIRST_CWD_BYTES);
  if (head === null) return '';
  const lines = head.toString('utf8').split('\n').slice(0, FIRST_CWD_LINES);
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isPlain(record)) {
      const cwd = record['cwd'];
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }
  }
  return '';
}

/** The entries of a folder with their stat, `.key` names left out; null when the folder cannot be listed. */
async function listNamed(fs: DiscoveryFs, dir: string): Promise<{ name: string; stat: EntryStat }[] | null> {
  let names: readonly string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const out: { name: string; stat: EntryStat }[] = [];
  for (const name of names) {
    if (name.endsWith('.key')) continue;
    const stat = await fs.lstat(path.join(dir, name));
    if (stat !== null) out.push({ name, stat });
  }
  return out;
}

/**
 * The project folder of a repository (legacy `detect_transcripts_dir`, extended for every OS): the folder named like the
 * repository path (also its lower-case form), then like the real path of the repository when it is reached through a link,
 * each in the cut form `<200 characters>-<hash>` when the name is longer than 200 characters; else the newest folder whose
 * three newest files start with a record whose `cwd` is the repository (this also finds a folder that
 * `CLAUDE_CODE_PROJECT_DIR_NAME` named). Names and paths ignore case where the file system does (Windows and macOS). Only
 * real folders are used: a link, a dangling one included, is never taken and never entered.
 */
export async function detectTranscriptsDir(
  repo: string,
  root: string,
  fs: DiscoveryFs = nodeDiscoveryFs,
  options: DetectOptions = {},
): Promise<string | null> {
  const insensitive = options.caseInsensitive ?? pathsCaseInsensitive;
  const fold = (value: string): string => (insensitive ? value.toLowerCase() : value);
  const pathKey = (value: string): string => fold(normalizePath(value));
  const entries = await listNamed(fs, root);
  if (entries === null) return null;
  const folders = entries.filter((entry) => entry.stat.kind === 'dir');
  const repos = [repo];
  const real = fs.realpath === undefined ? null : await fs.realpath(repo);
  if (real !== null && pathKey(real) !== pathKey(repo)) repos.push(real);
  for (const candidate of repos) {
    const { name, truncated } = projectFolderName(candidate);
    if (name === '') continue;
    const prefix = fold(`${name}-`);
    const hits = truncated
      ? folders.filter((entry) => entry.name.length > prefix.length && fold(entry.name).startsWith(prefix))
      : folders.filter(
          (entry) => entry.name === name || entry.name === name.toLowerCase() || fold(entry.name) === fold(name),
        );
    const exact = hits.find((entry) => entry.name === name) ?? hits.find((entry) => entry.name === name.toLowerCase());
    if (exact !== undefined) return path.join(root, exact.name);
    // several cut names that share the prefix: the content scan below decides between them
    const only = hits.length === 1 ? hits[0] : undefined;
    if (only !== undefined) return path.join(root, only.name);
  }
  const wanted = new Set(repos.map(pathKey));
  const newestFirst = [...folders].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const folder of newestFirst) {
    const dir = path.join(root, folder.name);
    const files = ((await listNamed(fs, dir)) ?? [])
      .filter((entry) => entry.stat.kind === 'file' && entry.name.endsWith('.jsonl'))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, NEWEST_FILES);
    for (const file of files) {
      const cwd = await firstCwd(fs, path.join(dir, file.name));
      if (cwd !== '' && wanted.has(pathKey(cwd))) return dir;
    }
  }
  return null;
}

// ---- the files below it -----------------------------------------------------------------------------------------------------

export interface DiscoveredFile {
  readonly path: string;
  readonly kind: TranscriptFileKind;
  /** From the DIRECTORY (or the file name of a main transcript), never from a record. */
  readonly sessionId: string;
  /** From the file name `agent-<id>.jsonl`; null for the main file, a journal and a status file. */
  readonly agentId: string | null;
  /** Set for workflow agents, journals and status files, and only by their exact relative layout. */
  readonly runId: string | null;
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthMs: number | null;
}

export interface DiscoveredSession {
  readonly sessionId: string;
  readonly files: DiscoveredFile[];
  /** `<sid>/custom-title.json` when the session has one. */
  readonly customTitlePath: string | null;
}

export interface DiscoveryCounters {
  /** Links and junctions that were seen and not followed. */
  symlinksSkipped: number;
  /** Directory entries examined. */
  entries: number;
  /** The entry budget ran out: part of a folder was not looked at. */
  truncated: boolean;
}

export interface DiscoveryResult {
  readonly sessions: DiscoveredSession[];
  readonly counters: DiscoveryCounters;
  /** The transcripts folder itself could not be listed. */
  readonly missing: boolean;
}

export interface DiscoveryPolicy {
  readonly nowMs: number;
  /** `import.lookbackHours` in milliseconds. */
  readonly lookbackMs: number;
  /** `session_ids`. */
  readonly pinned: ReadonlySet<string>;
  /** The session has hook events or is already tracked. */
  readonly isKnown: (sessionId: string) => boolean;
}

/** Folders below `subagents/` that are entered (02 5.1.2: other depths, at most 4). */
const MAX_SUBAGENT_DEPTH = 4;
/** Directory entries examined in one pass (a guard against a pathological tree). */
const MAX_ENTRIES = 50_000;

const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const META_SUFFIX = '.meta.json';

function freshCounters(): DiscoveryCounters {
  return { symlinksSkipped: 0, entries: 0, truncated: false };
}

function over(counters: DiscoveryCounters): boolean {
  if (counters.entries < MAX_ENTRIES) return false;
  counters.truncated = true;
  return true;
}

function fileOf(
  file: string,
  kind: TranscriptFileKind,
  sessionId: string,
  ids: { agentId?: string; runId?: string },
  stat: EntryStat,
): DiscoveredFile {
  return {
    path: file,
    kind,
    sessionId,
    agentId: ids.agentId ?? null,
    runId: ids.runId ?? null,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthMs: stat.birthMs,
  };
}

/** `subagents/**`: agents, their workflow layout and journals. `rel` holds the folder names below `subagents`. */
async function walkSubagents(
  fs: DiscoveryFs,
  dir: string,
  rel: readonly string[],
  sessionId: string,
  counters: DiscoveryCounters,
  out: DiscoveredFile[],
): Promise<void> {
  let names: readonly string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const inRun = rel.length === 2 && rel[0] === 'workflows' && RUN_ID_RE.test(rel[1] ?? '');
  const runId = inRun ? (rel[1] ?? null) : null;
  for (const name of names) {
    if (over(counters)) return;
    counters.entries += 1;
    if (name.endsWith('.key') || name.endsWith(META_SUFFIX)) continue;
    const full = path.join(dir, name);
    const agent = AGENT_FILE.exec(name);
    if (agent !== null) {
      const agentId = agent[1] ?? '';
      if (!AGENT_RE.test(agentId)) continue;
      const stat = await fs.lstat(full);
      if (stat === null) continue;
      if (stat.kind === 'link') counters.symlinksSkipped += 1;
      else if (stat.kind === 'file') {
        out.push(
          runId === null
            ? fileOf(full, 'subagent', sessionId, { agentId }, stat)
            : fileOf(full, 'workflow_agent', sessionId, { agentId, runId }, stat),
        );
      }
      continue;
    }
    if (name === 'journal.jsonl' && runId !== null) {
      const stat = await fs.lstat(full);
      if (stat === null) continue;
      if (stat.kind === 'link') counters.symlinksSkipped += 1;
      else if (stat.kind === 'file') out.push(fileOf(full, 'workflow_journal', sessionId, { runId }, stat));
      continue;
    }
    if (name.includes('.')) continue; // a file of another kind; a folder name with a dot is not part of the layout
    const stat = await fs.lstat(full);
    if (stat === null) continue;
    if (stat.kind === 'link') counters.symlinksSkipped += 1;
    else if (stat.kind === 'dir' && rel.length < MAX_SUBAGENT_DEPTH) {
      await walkSubagents(fs, full, [...rel, name], sessionId, counters, out);
    }
  }
}

/** `<sid>/workflows/<runId>.json` status files; `workflows/scripts` and every other name stay unopened. */
async function walkWorkflowStatus(
  fs: DiscoveryFs,
  dir: string,
  sessionId: string,
  counters: DiscoveryCounters,
  out: DiscoveredFile[],
): Promise<void> {
  let names: readonly string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (over(counters)) return;
    counters.entries += 1;
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -'.json'.length);
    if (!RUN_ID_RE.test(runId)) continue;
    const full = path.join(dir, name);
    const stat = await fs.lstat(full);
    if (stat === null) continue;
    if (stat.kind === 'link') counters.symlinksSkipped += 1;
    else if (stat.kind === 'file') out.push(fileOf(full, 'workflow_status', sessionId, { runId }, stat));
  }
}

/** The session folder `<tdir>/<sid>/`: subagent, workflow and title files. A folder that is a link is not entered. */
async function scanSessionFolder(
  fs: DiscoveryFs,
  tdir: string,
  sessionId: string,
  counters: DiscoveryCounters,
  out: DiscoveredFile[],
): Promise<string | null> {
  const dir = path.join(tdir, sessionId);
  const stat = await fs.lstat(dir);
  if (stat === null) return null;
  if (stat.kind === 'link') {
    counters.symlinksSkipped += 1;
    return null;
  }
  if (stat.kind !== 'dir') return null;
  let names: readonly string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  let title: string | null = null;
  for (const name of names) {
    if (over(counters)) break;
    counters.entries += 1;
    if (name === 'custom-title.json') {
      const found = await fs.lstat(path.join(dir, name));
      if (found?.kind === 'file') title = path.join(dir, name);
      else if (found?.kind === 'link') counters.symlinksSkipped += 1;
    } else if (name === 'subagents' || name === 'workflows') {
      // like every other path: looked at before it is opened, and a link or junction is counted and not entered
      const sub = path.join(dir, name);
      const found = await fs.lstat(sub);
      if (found?.kind === 'link') counters.symlinksSkipped += 1;
      else if (found?.kind === 'dir') {
        if (name === 'subagents') await walkSubagents(fs, sub, [], sessionId, counters, out);
        else await walkWorkflowStatus(fs, sub, sessionId, counters, out);
      }
    }
  }
  return title;
}

/** The main transcript `<tdir>/<sid>.jsonl`: a regular file, never a link. */
async function mainFile(
  fs: DiscoveryFs,
  tdir: string,
  sessionId: string,
  counters: DiscoveryCounters,
): Promise<DiscoveredFile | null> {
  const full = path.join(tdir, `${sessionId}.jsonl`);
  const stat = await fs.lstat(full);
  if (stat === null) return null;
  if (stat.kind === 'link') {
    counters.symlinksSkipped += 1;
    return null;
  }
  return stat.kind === 'file' ? fileOf(full, 'session', sessionId, {}, stat) : null;
}

/**
 * The tracked sessions below `tdir` (02 5.1.2): a session is tracked when its main file was written within the look-back
 * window, or it is pinned, or it has hook events or is already tracked. Subagent and workflow files follow their session.
 */
export async function discoverTranscripts(
  tdir: string,
  policy: DiscoveryPolicy,
  fs: DiscoveryFs = nodeDiscoveryFs,
): Promise<DiscoveryResult> {
  const counters = freshCounters();
  let names: readonly string[];
  try {
    names = await fs.readdir(tdir);
  } catch {
    return { sessions: [], counters, missing: true };
  }
  const candidates = new Set<string>();
  for (const name of names) {
    if (name.endsWith('.key')) continue;
    const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
    if (SID_RE.test(id)) candidates.add(id);
  }
  const sessions: DiscoveredSession[] = [];
  for (const sessionId of [...candidates].sort()) {
    if (over(counters)) break;
    counters.entries += 1;
    const main = await mainFile(fs, tdir, sessionId, counters);
    const recent = main !== null && main.mtimeMs >= policy.nowMs - policy.lookbackMs;
    if (!(recent || policy.pinned.has(sessionId) || policy.isKnown(sessionId))) continue;
    const files: DiscoveredFile[] = main === null ? [] : [main];
    const customTitlePath = await scanSessionFolder(fs, tdir, sessionId, counters, files);
    if (files.length > 0 || customTitlePath !== null) sessions.push({ sessionId, files, customTitlePath });
  }
  return { sessions, counters, missing: false };
}

/**
 * One session folder at once (a hint from a hook, 02 5.1.2), whatever the age policy says. The id is validated first: a path
 * from a hook payload is a hint, never something to open. Null when the id is not a session id or nothing is there.
 */
export async function discoverSession(
  tdir: string,
  sessionId: string,
  fs: DiscoveryFs = nodeDiscoveryFs,
): Promise<DiscoveredSession | null> {
  if (!SID_RE.test(sessionId)) return null;
  const counters = freshCounters();
  const main = await mainFile(fs, tdir, sessionId, counters);
  const files: DiscoveredFile[] = main === null ? [] : [main];
  const customTitlePath = await scanSessionFolder(fs, tdir, sessionId, counters, files);
  return files.length > 0 || customTitlePath !== null ? { sessionId, files, customTitlePath } : null;
}

// ---- the small files beside the transcripts -----------------------------------------------------------------------------------

/** Metadata of an agent (`agent-<id>.meta.json`, at most 64 KiB, scalars only). */
export interface AgentMeta {
  agentType?: string;
  description?: string;
  model?: string;
  requestShape?: string;
  spawnDepth?: number;
  spawnToolUseId?: string;
  workflowPhase?: string;
}

const META_MAX_BYTES = 64 * 1024;
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
const TITLE_MAX_CP = 120;
const DESCRIPTION_MAX_CP = 160;

function text(value: unknown, max: number, redacted: boolean): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return clipCodePoints(redacted ? redact(value) : value, max);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readObject(
  fs: DiscoveryFs,
  file: string,
  maxBytes: number,
): Promise<Readonly<Record<string, unknown>> | null> {
  const body = await fs.readText(file, maxBytes);
  if (body === null) return null;
  try {
    const value: unknown = JSON.parse(body);
    return isPlain(value) ? value : null;
  } catch {
    return null;
  }
}

/** The metadata beside `agent-<id>.jsonl`; null when the file is missing, invalid, not an object or too large. */
export async function readAgentMeta(
  transcriptPath: string,
  fs: DiscoveryFs = nodeDiscoveryFs,
): Promise<AgentMeta | null> {
  const metaPath = `${transcriptPath.replace(/\.jsonl$/, '')}${META_SUFFIX}`;
  const doc = await readObject(fs, metaPath, META_MAX_BYTES);
  if (doc === null) return null;
  const meta: AgentMeta = {};
  const set = <K extends keyof AgentMeta>(key: K, value: AgentMeta[K] | undefined): void => {
    if (value !== undefined) meta[key] = value;
  };
  set('agentType', text(doc['agentType'], 64, false));
  set('description', text(doc['description'], DESCRIPTION_MAX_CP, true));
  set('model', text(doc['model'], 128, false));
  set('requestShape', text(doc['requestShape'], 32, false));
  set('spawnDepth', count(doc['spawnDepth']));
  const toolUseId = doc['toolUseId'];
  set('spawnToolUseId', typeof toolUseId === 'string' && TOOL_ID_RE.test(toolUseId) ? toolUseId : undefined);
  set('workflowPhase', text(doc['workflowPhase'], 120, true));
  return meta;
}

/** `customTitle` of `custom-title.json`, redacted and cut at 120 code points; null when there is none. */
export async function readCustomTitle(file: string, fs: DiscoveryFs = nodeDiscoveryFs): Promise<string | null> {
  const doc = await readObject(fs, file, META_MAX_BYTES);
  return doc === null ? null : (text(doc['customTitle'], TITLE_MAX_CP, true) ?? null);
}

/** The scalars of `workflows/<runId>.json` (never `script`, `result`, `logs` or `phases[].detail`). */
export interface WorkflowStatusFile {
  runId?: string;
  status?: string;
  workflowName?: string;
  agentCount?: number;
  durationMs?: number;
  startTime?: number;
}

export async function readWorkflowStatus(
  file: string,
  fs: DiscoveryFs = nodeDiscoveryFs,
): Promise<WorkflowStatusFile | null> {
  const doc = await readObject(fs, file, STATUS_MAX_BYTES);
  if (doc === null) return null;
  const status: WorkflowStatusFile = {};
  const runId = doc['runId'];
  if (typeof runId === 'string' && RUN_ID_RE.test(runId)) status.runId = runId;
  const state = text(doc['status'], 32, false);
  if (state !== undefined) status.status = state;
  const name = text(doc['workflowName'], 120, true);
  if (name !== undefined) status.workflowName = name;
  const agents = count(doc['agentCount']);
  if (agents !== undefined) status.agentCount = agents;
  const duration = count(doc['durationMs']);
  if (duration !== undefined) status.durationMs = duration;
  const started = count(doc['startTime']);
  if (started !== undefined) status.startTime = started;
  return status;
}
