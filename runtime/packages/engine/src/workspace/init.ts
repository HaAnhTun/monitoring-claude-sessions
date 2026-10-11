// The init transaction (01 4.12): a workspace is built in a staging folder next to its final place and moved there with one
// rename, so neither engine ever sees a half-made workspace. An existing workspace is reused (nothing overwritten) and
// adopted when it has no `instance.json`. All of it runs under the task mutex of the workspace.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { McsError, isoSecondsZ, systemClock, type Clock, type InstanceFile } from '@mcs/shared';
import { z } from 'zod';

import { CHANGES_HEADER, changeEntryText } from '../audit/writer.ts';
import { checkSchemaVersion, getEntry, type PyObject } from '../config/defaults.ts';
import { LEGACY_KEYS, compileConfigPatterns, validateLegacy } from '../config/validate-legacy.ts';
import { pidAlive } from '../platform/process.ts';
import { fromPlain, pyEquals, pyRepr, toPlain, type PyJsonValue } from '../pyjson/index.ts';
import {
  adoptWorkspace,
  ensureWorkspaceDir,
  instanceFileToPy,
  newInstanceFile,
  readInstanceFile,
  readTaskFile,
  type EngineName,
} from './adopt.ts';
import { isMissingFileError, readJsonFile, writePyJsonFile, writeWorkspaceFile } from './fsio.ts';
import {
  checkSlug,
  resolveWorkspace,
  slugify,
  tasksRootOf,
  withTaskMutex,
  workspacePath,
  type WorkspaceRef,
} from './paths.ts';

export interface InitOptions {
  /** The repository the task monitors; the tasks root defaults to `<repo>/.claude/monitor/tasks`. */
  readonly repo: string;
  /** Another tasks root (the legacy `--root`). */
  readonly root?: string;
  /** The task name: the title of `config.json`, the name of `task.json`, and the source of the slug. */
  readonly name: string;
  /** The slug; absent or empty: `slugify(name)` (legacy `slug or slugify(name)`). */
  readonly slug?: string;
  readonly description?: string;
  /** `--port`: an integer 1..65535 written into `config.json`. */
  readonly port?: number;
  /** `--config FILE`: a seed of legacy (L) keys for `config.json`. */
  readonly seedConfig?: string;
  /** The engine of a new `instance.json` (default `node`). */
  readonly engine?: EngineName;
  readonly clock?: Clock;
  /** Test seam: the instance id. */
  readonly newId?: () => string;
  /**
   * Called once the staging folder is complete and before it is renamed into place. The init crash test hook of 01 2.10
   * (value `before-rename`) ends the process here (exit 70); the operations layer passes it.
   */
  readonly beforeRename?: () => void | Promise<void>;
  /** Longest wait for another command on the same workspace (default `TASK_MUTEX_TIMEOUT_MS`). */
  readonly mutexTimeoutMs?: number;
}

export interface InitResult {
  /** True when this call made the workspace. */
  readonly created: boolean;
  /** True when an existing legacy workspace gained its `instance.json` (always false when `created`). */
  readonly adopted: boolean;
  readonly ws: WorkspaceRef;
  readonly instance: InstanceFile;
}

/** Staging folders of an init in progress: `.init-<slug>-<pid>-<rand8>` (01 4.12 step 5). */
const STAGING_RE = /^\.init-[a-z0-9-]+-(\d+)-[0-9a-f]{8}$/;
const STAGING_MAX_AGE_MS = 10 * 60_000;
const RENAME_BUDGET_MS = 2000;
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY']);

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function invalid(message: string, cause?: unknown): McsError {
  return new McsError('WORKSPACE_INVALID', message, cause === undefined ? {} : { cause });
}

// ---- step 3: leftovers of crashed inits

/**
 * Removes staging folders of crashed inits from `root`: names that match `.init-<slug>-<pid>-<rand8>`, whose pid is not
 * alive and that are older than 10 minutes. Only folders of that name inside the root, never through a link. Returns the
 * names removed.
 */
export async function cleanupStaging(root: string, clock: Clock = systemClock): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw invalid(`cannot list the tasks root ${root}`, error);
  }
  const removed: string[] = [];
  for (const name of names.sort()) {
    const match = STAGING_RE.exec(name);
    if (match === null) continue;
    const full = path.join(root, name);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(full);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw invalid(`cannot inspect ${name}`, error);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    if (pidAlive(Number(match[1]))) continue;
    if (clock.now() - stats.mtimeMs <= STAGING_MAX_AGE_MS) continue;
    await rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    removed.push(name);
  }
  return removed;
}

// ---- step 1: validate the request and create nothing

interface Request {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The candidate `config.json`. */
  readonly candidate: PyObject;
  /** Keys and values an existing `config.json` must already hold (the seed keys and the port), or none. */
  readonly requested: readonly (readonly [string, PyJsonValue])[];
}

function setEntry(entries: [string, PyJsonValue][], key: string, value: PyJsonValue): void {
  const at = entries.findIndex(([k]) => k === key);
  if (at === -1) entries.push([key, value]);
  else entries[at] = [key, value];
}

async function readSeed(file: string): Promise<PyObject> {
  const { value } = await readJsonFile(file);
  if (value.k !== 'obj') {
    throw new McsError('CONFIG_INVALID', `invalid seed config ${file}: config must be a JSON object`);
  }
  if (getEntry(value, 'schema_version') !== undefined) checkSchemaVersion(value, file, 'config.json');
  const unknown = value.v.map(([key]) => key).filter((key) => !key.startsWith('_') && !LEGACY_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new McsError(
      'CONFIG_INVALID',
      `invalid seed config ${file}: unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map(pyRepr).join(', ')}`,
      { hint: 'init takes the keys of config.json only; set runtime keys with `mcs configure` afterwards.' },
    );
  }
  return value;
}

/** What the regex step needs of a validated candidate. */
const PatternSourceSchema = z.looseObject({
  session_rules: z.array(z.looseObject({ match: z.string() })).default([]),
  attempts: z.looseObject({ start: z.string(), end: z.string() }).nullable().default(null),
});

/** A lone surrogate cannot be written to a UTF-8 file (Python could not write it either), so it is refused up front. */
function assertWellFormed(label: string, text: string): void {
  if (!text.isWellFormed()) throw new McsError('CONFIG_INVALID', `${label}: expected text without lone surrogates`);
}

async function prepareRequest(o: InitOptions, root: string): Promise<Request> {
  assertWellFormed('name', o.name);
  assertWellFormed('description', o.description ?? '');
  const slug = checkSlug(o.slug !== undefined && o.slug !== '' ? o.slug : slugify(o.name));
  const name = o.name === '' ? slug : o.name;
  const entries: [string, PyJsonValue][] = [
    ['schema_version', { k: 'int', v: 1n }],
    ['title', { k: 'str', v: name }],
  ];
  const requested: [string, PyJsonValue][] = [];
  if (o.seedConfig !== undefined) {
    for (const [key, value] of (await readSeed(o.seedConfig)).v) {
      if (key === 'schema_version') continue;
      setEntry(entries, key, value);
      requested.push([key, value]);
    }
  }
  if (o.port !== undefined) {
    const port: PyJsonValue = Number.isInteger(o.port) ? { k: 'int', v: BigInt(o.port) } : { k: 'float', v: o.port };
    setEntry(entries, 'port', port);
    requested.push(['port', port]);
  }
  const candidate: PyObject = { k: 'obj', v: entries };
  const problems = validateLegacy(candidate, { strict: true });
  if (problems.length > 0) {
    const where = path.join(root, slug, 'config.json');
    throw new McsError('CONFIG_INVALID', `invalid task config ${where}: ${problems.join('; ')}`);
  }
  compileConfigPatterns(PatternSourceSchema.parse(toPlain(candidate)));
  return { slug, name, description: o.description ?? '', candidate, requested };
}

// ---- step 5: the files of a new workspace

const README_NOTES =
  '- `task.json` identity, `config.json` overrides of the shared defaults (shared with the legacy engine), `runtime.json` Node runtime overrides, `instance.json` runtime identity, `audit/` change and decision log, `data/` database and hook spool, `logs/` runtime logs.\n';

function readmeText(name: string, description: string, slug: string): string {
  return (
    `# Monitoring task: ${name}\n\n${description}\n\n${README_NOTES}` +
    `- Inspect: \`node <skill>/scripts/mcs.mjs inspect --task ${slug}\` (legacy engine: \`python <skill>/template/viewer.py inspect --task ${slug}\`)\n` +
    '- Never copy transcripts here; they are read in place.\n'
  );
}

/** `repo` of `task.json`: relative to the workspace with `/`; on another Windows drive there is none: the absolute path with `/`. */
function repoField(finalDir: string, repo: string): string {
  const relative = path.relative(finalDir, path.resolve(repo));
  return (path.isAbsolute(relative) ? path.resolve(repo) : relative).split(path.sep).join('/');
}

function taskFile(request: Request, finalDir: string, repo: string, nowMs: number): PyJsonValue {
  return fromPlain({
    schema_version: 1,
    id: request.slug,
    name: request.name,
    description: request.description,
    created: isoSecondsZ(nowMs),
    repo: repoField(finalDir, repo),
    links: [],
  });
}

function stagingPath(ws: WorkspaceRef): string {
  return path.join(ws.root, `.init-${ws.slug}-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
}

async function buildStaging(
  ws: WorkspaceRef,
  staging: string,
  request: Request,
  o: InitOptions,
  clock: Clock,
): Promise<void> {
  const nowMs = clock.now();
  const instance = newInstanceFile(ws.slug, {
    nowMs,
    ...(o.engine === undefined ? {} : { engine: o.engine }),
    ...(o.newId === undefined ? {} : { instanceId: o.newId() }),
  });
  await mkdir(staging);
  const there = { dir: staging };
  await writePyJsonFile(workspacePath(there, 'task.json'), taskFile(request, ws.dir, o.repo, nowMs));
  await writePyJsonFile(workspacePath(there, 'config.json'), request.candidate);
  await writeWorkspaceFile(workspacePath(there, 'README.md'), readmeText(request.name, request.description, ws.slug));
  await writePyJsonFile(workspacePath(there, 'instance.json'), instanceFileToPy(instance));
  await ensureWorkspaceDir(there, 'audit');
  await writeWorkspaceFile(
    workspacePath(there, 'audit', 'changes.md'),
    CHANGES_HEADER +
      changeEntryText(
        {
          action: 'init-task',
          summary: `created task workspace '${ws.slug}'`,
          reason: 'monitoring requested for this task',
          files: ['task.json', 'config.json', 'README.md', 'instance.json'],
          validation: 'schema ok',
          outcome: 'created',
        },
        nowMs,
      ),
  );
  await ensureWorkspaceDir(there, 'data');
  await ensureWorkspaceDir(there, 'logs');
}

// ---- steps 4 and 6: the target place

async function isTaskFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw invalid(`cannot inspect ${path.basename(file)}`, error);
  }
}

/**
 * `taken` when a workspace (a `task.json`) is there. An empty folder is removed (Windows cannot rename onto it, even an
 * empty one); a folder with other content and no `task.json` is refused.
 */
async function prepareTarget(dir: string): Promise<'free' | 'taken'> {
  if (await isTaskFile(path.join(dir, 'task.json'))) return 'taken';
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissingFileError(error)) return 'free';
    throw invalid(`cannot inspect ${dir}`, error);
  }
  if (entries.length > 0) {
    throw invalid(`${dir} exists, has no task.json and is not empty; move it away or choose another slug`);
  }
  try {
    await rmdir(dir);
  } catch (error) {
    if (!isMissingFileError(error)) throw invalid(`cannot remove the empty folder ${dir}`, error);
  }
  return 'free';
}

/** Moves the staging folder into place (retrying what antivirus scanners cause, E5); `lost` when another writer was first. */
async function moveIntoPlace(staging: string, dir: string): Promise<'renamed' | 'lost'> {
  const started = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    if ((await prepareTarget(dir)) === 'taken') return 'lost';
    try {
      await rename(staging, dir);
      return 'renamed';
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !RETRY_CODES.has(code)) {
        throw invalid(`cannot move the new workspace into place: ${code ?? 'error'}`, error);
      }
      if (performance.now() - started >= RENAME_BUDGET_MS) {
        throw invalid(`cannot move the new workspace into place: ${code} (held open by another program?)`, error);
      }
      await sleepMs(Math.min(50 * 2 ** Math.min(attempt, 10), 250));
    }
  }
}

async function removeStaging(staging: string): Promise<void> {
  try {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // The folder is ours and unique; if it cannot be removed now, the cleanup of step 3 removes it later.
  }
}

// ---- the transaction

/** The requested keys whose value the existing `config.json` lacks or holds differently (Python `==`). */
async function differingKeys(ws: WorkspaceRef, requested: Request['requested']): Promise<string[]> {
  const { value } = await readJsonFile(workspacePath(ws, 'config.json'));
  if (value.k !== 'obj') return requested.map(([key]) => key);
  return requested
    .filter(([key, wanted]) => {
      const have = getEntry(value, key);
      return have === undefined || !pyEquals(have, wanted);
    })
    .map(([key]) => key);
}

async function reuse(ws: WorkspaceRef, request: Request, o: InitOptions, clock: Clock): Promise<InitResult> {
  await readTaskFile(ws);
  if (request.requested.length > 0) {
    const differing = await differingKeys(ws, request.requested);
    if (differing.length > 0) {
      throw new McsError(
        'WORKSPACE_EXISTS_CONFIG_DIFFERS',
        `task '${ws.slug}' already exists and its config.json differs from the requested options (${differing.join(', ')})`,
        { hint: `use mcs configure --task ${ws.slug}`, details: { keys: differing } },
      );
    }
  }
  const adoption = await adoptWorkspace(ws, {
    clock,
    ...(o.engine === undefined ? {} : { engine: o.engine }),
    ...(o.newId === undefined ? {} : { newId: o.newId }),
  });
  return { created: false, adopted: adoption.adopted, ws, instance: adoption.instance };
}

/** Step 7: reads the new files back and validates them. */
async function readBack(ws: WorkspaceRef): Promise<InstanceFile> {
  await readTaskFile(ws);
  const { value: config } = await readJsonFile(workspacePath(ws, 'config.json'));
  const problems = validateLegacy(config, { strict: true });
  if (problems.length > 0) throw invalid(`the new config.json of '${ws.slug}' is invalid: ${problems.join('; ')}`);
  const instance = await readInstanceFile(ws);
  if (instance === null) throw invalid(`the new instance.json of '${ws.slug}' is missing after the rename`);
  return instance;
}

async function transaction(ws: WorkspaceRef, request: Request, o: InitOptions, clock: Clock): Promise<InitResult> {
  await cleanupStaging(ws.root, clock);
  for (;;) {
    if ((await prepareTarget(ws.dir)) === 'taken') return reuse(ws, request, o, clock);
    const staging = stagingPath(ws);
    let outcome: 'renamed' | 'lost';
    try {
      await buildStaging(ws, staging, request, o, clock);
      await o.beforeRename?.();
      outcome = await moveIntoPlace(staging, ws.dir);
    } catch (error) {
      await removeStaging(staging);
      throw error;
    }
    if (outcome === 'lost') {
      // Another writer made the workspace first (the legacy `init-task` takes no mutex): drop ours and reuse theirs.
      await removeStaging(staging);
      continue;
    }
    return { created: true, adopted: false, ws, instance: await readBack(ws) };
  }
}

/**
 * `ops.workspace.init` at the engine level (01 4.12). Validation first (slug, seed file, port, candidate `config.json`
 * strict and its regexes) with nothing created on failure; then, under the task mutex, the cleanup of old staging folders,
 * the reuse or adoption of an existing workspace, or the build of a new one in a staging folder and its rename.
 * The messages of the legacy command (`created task ...`, `reused (nothing overwritten) task ...`) are the caller's.
 */
export async function initWorkspace(o: InitOptions): Promise<InitResult> {
  const clock = o.clock ?? systemClock;
  const root = path.resolve(o.root ?? tasksRootOf(o.repo));
  const request = await prepareRequest(o, root);
  await mkdir(root, { recursive: true });
  const ws = resolveWorkspace(root, request.slug);
  return withTaskMutex(ws, () => transaction(ws, request, o, clock), {
    ...(o.mutexTimeoutMs === undefined ? {} : { timeoutMs: o.mutexTimeoutMs }),
  });
}
