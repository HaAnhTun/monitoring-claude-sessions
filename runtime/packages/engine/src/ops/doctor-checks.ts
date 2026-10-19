// The checks of `mcs doctor` (01 6.4, V4 decision 11, facts portability risk 8). Each check is a function of one
// `CheckEnv`: the operation context, the workspace (or `null`), the outside-world seams and the lazily computed facts several
// checks share (the probe, the configuration check). A check reads only: no file is written, no process is started (the
// port check binds and closes a socket, it never connects). Every failed check carries a stable `fix` text.
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open, readdir, stat, statfs } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { DoctorCheck } from '@mcs/shared';
import { resolveMcsHome } from '@mcs/shared/protocol';

import { openSqlite } from '../db/driver.ts';
import { claudeHomeOf, detectTranscriptsDir, projectsRoot } from '../ingest/transcripts/discovery.ts';
import { execFileText, resolveExecutable, type ChildResult } from '../platform/exec.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { layoutOfRuntimeDir, type RuntimeLayout } from '../platform/layout.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { check as configCheck, type CheckDeps, type CheckResult } from './config.ts';
import { readCodeStamp } from './instances.ts';
import { isLiveState, probeInstance, type ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

/** The Node floor of the launcher (01 5.1, V4 decision 3). */
export const NODE_FLOOR = '22.22.0';
/** Below this the disk check warns (01 6.4). */
export const DISK_FREE_MIN_BYTES = 1024 ** 3;
/** Newest transcript files the parse check reads, and the bytes it reads of each (from the end). */
const TRANSCRIPTS_SAMPLE = 5;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const LF = String.fromCharCode(10);

/** The outside world of the checks; tests replace any of them. */
export interface DoctorSeams {
  readonly nodeVersion: string;
  readonly platform: HostPlatform;
  /** Opens and closes a `:memory:` database through the driver seam; throws when `node:sqlite` is unusable. */
  readonly openMemoryDb: () => void;
  readonly layoutOf: (runtimeDir: string) => RuntimeLayout;
  readonly exists: (file: string) => Promise<boolean>;
  readonly readFile: (file: string) => Promise<Buffer>;
  /** The bytes at the end of a file, at most `maxBytes`. */
  readonly readTail: (file: string, maxBytes: number) => Promise<{ text: string; truncated: boolean }>;
  /** Every file below `dir`, as relative POSIX paths. */
  readonly listFiles: (dir: string) => Promise<string[]>;
  /** The `.jsonl` files of a folder, newest first. */
  readonly newestFiles: (dir: string, extension: string, limit: number) => Promise<string[]>;
  /** True when 127.0.0.1:<port> can be bound now (the socket is closed again at once). */
  readonly canBind: (port: number) => Promise<boolean>;
  readonly writable: (dir: string) => Promise<boolean>;
  readonly freeBytes: (dir: string) => Promise<number>;
  /** POSIX permission bits of a path. */
  readonly mode: (file: string) => Promise<number>;
  /** Runs a program through `execFileText`; `null` when the program is not installed. */
  readonly run: (kind: 'git' | 'icacls', args: readonly string[], cwd: string) => Promise<ChildResult | null>;
  readonly probe: (ws: WorkspaceRef, runtimeDir: string) => Promise<ProbeResult>;
  /** `PRAGMA quick_check` of a database opened read-only: `ok` or the first problem. */
  readonly quickCheck: (dbFile: string) => string;
  readonly codeStamp: (runtimeDir: string) => Promise<string | null>;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function listFilesBelow(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

export const nodeDoctorSeams: DoctorSeams = {
  nodeVersion: process.versions.node,
  platform: hostPlatform,
  openMemoryDb() {
    const db = openSqlite(':memory:', { readonly: false, fileMustExist: false, timeoutMs: 1000 });
    try {
      db.exec('SELECT 1');
    } finally {
      db.close();
    }
  },
  layoutOf: (runtimeDir) => layoutOfRuntimeDir(runtimeDir),
  exists: pathExists,
  readFile: async (file) => {
    const handle = await open(file, 'r');
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  },
  async readTail(file, maxBytes) {
    const handle = await open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return { text: buffer.toString('utf8'), truncated: size > maxBytes };
    } finally {
      await handle.close();
    }
  },
  listFiles: listFilesBelow,
  async newestFiles(dir, extension, limit) {
    const names = (await readdir(dir)).filter((name) => name.endsWith(extension));
    const dated = await Promise.all(
      names.map(async (name) => ({ file: path.join(dir, name), mtime: (await stat(path.join(dir, name))).mtimeMs })),
    );
    return dated
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((d) => d.file);
  },
  canBind: (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => {
        resolve(false);
      });
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close(() => {
          resolve(true);
        });
      });
    }),
  async writable(dir) {
    try {
      await access(dir, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  async freeBytes(dir) {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  },
  mode: async (file) => (await stat(file)).mode,
  async run(kind, args, cwd) {
    const file = await resolveExecutable(kind);
    if (file === null) return null;
    return execFileText({ kind, file, args, cwd, timeoutMs: 10_000, maxOutputBytes: 256 * 1024, encoding: 'utf8' });
  },
  probe: (ws, runtimeDir) => probeInstance(ws, { runtimeDir }),
  quickCheck(dbFile) {
    const db = openSqlite(dbFile, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
    try {
      const rows = db.prepare<{ quick_check: string }>('PRAGMA quick_check').all();
      const first = rows[0]?.quick_check ?? 'no answer';
      return first;
    } finally {
      db.close();
    }
  },
  codeStamp: readCodeStamp,
};

/** What a check sees. `probe()` and `config()` are computed once per run and shared. */
export interface CheckEnv {
  readonly ctx: OpContext;
  readonly ws: WorkspaceRef | null;
  readonly seams: DoctorSeams;
  readonly deps: CheckDeps;
  probe(): Promise<ProbeResult>;
  /** The configuration check of the task; it throws what `ops.config.check` throws. */
  config(): Promise<CheckResult>;
}

export type BuiltinCheck = (e: CheckEnv) => Promise<DoctorCheck>;

const ok = (id: string, detail: string): DoctorCheck => ({ id, ok: true, level: 'error', detail });
const fail = (id: string, level: DoctorCheck['level'], detail: string, fix: string): DoctorCheck => ({
  id,
  ok: false,
  level,
  detail,
  fix,
});

function versionAtLeast(version: string, floor: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const [a, b] = [parts(version), parts(floor)];
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- machine-wide checks

export const nodeVersion: BuiltinCheck = (e) =>
  Promise.resolve(
    versionAtLeast(e.seams.nodeVersion, NODE_FLOOR)
      ? ok('node.version', `node ${e.seams.nodeVersion} (floor ${NODE_FLOOR})`)
      : fail(
          'node.version',
          'error',
          `node ${e.seams.nodeVersion} is older than ${NODE_FLOOR}`,
          `install Node ${NODE_FLOOR} or newer`,
        ),
  );

export const nodeSqlite: BuiltinCheck = (e) => {
  try {
    e.seams.openMemoryDb();
    return Promise.resolve(ok('node.sqlite', 'node:sqlite opens a database'));
  } catch (error) {
    return Promise.resolve(
      fail(
        'node.sqlite',
        'error',
        `node:sqlite is not usable: ${messageOf(error)}`,
        `install Node ${NODE_FLOOR} or newer (node:sqlite is built in)`,
      ),
    );
  }
};

export const runtimeLayout: BuiltinCheck = async (e) => {
  const fix = 'reinstall the skill, or run `npm ci && npm run build` in the runtime folder of a checkout';
  let layout: RuntimeLayout;
  try {
    layout = e.seams.layoutOf(e.ctx.runtimeDir);
  } catch (error) {
    return fail('runtime.layout', 'error', messageOf(error), fix);
  }
  const missing: string[] = [];
  for (const file of [layout.serverEntry, layout.hookEntry, layout.migrationsDir]) {
    if (!(await e.seams.exists(file))) missing.push(path.basename(file));
  }
  return missing.length === 0
    ? ok('runtime.layout', `${layout.mode} layout`)
    : fail('runtime.layout', 'error', `${layout.mode} layout is missing ${missing.join(', ')}`, fix);
};

type StampFiles = Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;

function stampFilesOf(value: unknown): StampFiles | null {
  if (typeof value !== 'object' || value === null || !('files' in value)) return null;
  const files = value.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
  const out: Record<string, { bytes: number; sha256: string }> = {};
  const entries: [string, unknown][] = Object.entries(files);
  for (const [rel, entry] of entries) {
    if (typeof entry !== 'object' || entry === null || !('bytes' in entry) || !('sha256' in entry)) return null;
    const { bytes, sha256 } = entry;
    if (typeof bytes !== 'number' || typeof sha256 !== 'string') return null;
    out[rel] = { bytes, sha256 };
  }
  return out;
}

function listed(kind: string, names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, 5).join(', ');
  return `${kind}: ${shown}${names.length > 5 ? ` (+${String(names.length - 5)} more)` : ''}`;
}

/**
 * ADR 0062 item 5: the bundle's `.mcs-build.json` lists every other file of the bundle folder with its size and SHA-256. The
 * check recomputes them and names the changed, missing and extra files. The source layout has no file list: skipped.
 */
export const bundleIntegrity: BuiltinCheck = async (e) => {
  const id = 'runtime.bundle-integrity';
  const fix = 'reinstall the skill: the bundle folder differs from the one that was shipped';
  let layout: RuntimeLayout;
  try {
    layout = e.seams.layoutOf(e.ctx.runtimeDir);
  } catch (error) {
    return fail(id, 'error', `no runtime layout: ${messageOf(error)}`, fix);
  }
  if (layout.mode === 'source') return ok(id, 'source layout: no bundle to verify');
  let files: StampFiles | null;
  try {
    files = stampFilesOf(JSON.parse((await e.seams.readFile(layout.stampFile)).toString('utf8')));
  } catch (error) {
    return fail(id, 'error', `cannot read ${path.basename(layout.stampFile)}: ${messageOf(error)}`, fix);
  }
  if (files === null) return fail(id, 'error', `${path.basename(layout.stampFile)} has no file list`, fix);
  const present = new Set(
    (await e.seams.listFiles(layout.runtimeDir)).filter((rel) => rel !== path.basename(layout.stampFile)),
  );
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [rel, want] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!present.has(rel)) {
      missing.push(rel);
      continue;
    }
    present.delete(rel);
    const bytes = await e.seams.readFile(path.join(layout.runtimeDir, ...rel.split('/')));
    if (bytes.length !== want.bytes || createHash('sha256').update(bytes).digest('hex') !== want.sha256)
      changed.push(rel);
  }
  const extra = [...present].sort();
  const parts = [listed('changed', changed), listed('missing', missing), listed('extra', extra)].filter(
    (p): p is string => p !== null,
  );
  return parts.length === 0
    ? ok(id, `${String(Object.keys(files).length)} files match the build stamp`)
    : fail(id, 'error', parts.join('; '), fix);
};

export const claudeHome: BuiltinCheck = async (e) => {
  const home = claudeHomeOf(e.ctx.env);
  return (await e.seams.exists(home))
    ? ok('claude.home', 'Claude home found')
    : fail(
        'claude.home',
        'warn',
        'no Claude home folder',
        'start Claude Code once, or set CLAUDE_CONFIG_DIR to its folder',
      );
};

/** The transcripts folder of the task configuration, else the one auto-detection finds for the repository. */
async function transcriptsDirOf(e: CheckEnv): Promise<string | null> {
  if (e.ws !== null) {
    try {
      const configured = (await e.config()).transcripts;
      if (path.isAbsolute(configured) && (await e.seams.exists(configured))) return configured;
    } catch {
      // a broken configuration is the business of config.valid; fall back to auto-detection
    }
  }
  return detectTranscriptsDir(e.ctx.repo, projectsRoot(e.ctx.env));
}

export const transcriptsDir: BuiltinCheck = async (e) =>
  (await transcriptsDirOf(e)) === null
    ? fail(
        'transcripts.dir',
        'warn',
        'no transcripts folder for this repository',
        'run a Claude Code session in the repository, or set transcripts_dir with `mcs configure`',
      )
    : ok('transcripts.dir', 'transcripts folder found');

/** The legacy threshold (01 6.4): fine when no line is bad, or fewer than max(5, total / 100). */
export const transcriptsParse: BuiltinCheck = async (e) => {
  const id = 'transcripts.parse';
  const dir = await transcriptsDirOf(e);
  if (dir === null) return fail(id, 'warn', 'no transcripts folder to read', 'see transcripts.dir');
  const files = await e.seams.newestFiles(dir, '.jsonl', TRANSCRIPTS_SAMPLE);
  let total = 0;
  let bad = 0;
  for (const file of files) {
    const { text, truncated } = await e.seams.readTail(file, TRANSCRIPT_TAIL_BYTES);
    const lines = text.split(LF);
    if (truncated) lines.shift();
    for (const line of lines) {
      if (line.trim() === '') continue;
      total += 1;
      try {
        JSON.parse(line);
      } catch {
        bad += 1;
      }
    }
  }
  const detail = `${String(files.length)} files, ${String(total)} lines, ${String(bad)} unreadable`;
  return bad === 0 || bad < Math.max(5, Math.floor(total / 100))
    ? ok(id, detail)
    : fail(id, 'warn', detail, 'check that the transcripts folder holds Claude Code session files');
};

export const mcsHomeWritable: BuiltinCheck = async (e) => {
  const id = 'mcshome.writable';
  const fix = 'make the folder writable, or set MCS_HOME to a writable absolute folder';
  let home: string;
  try {
    home = resolveMcsHome(e.ctx.env, { win32: e.seams.platform === 'win32' });
  } catch (error) {
    return fail(id, 'error', messageOf(error), fix);
  }
  // a folder that does not exist yet is created on first use: its nearest existing parent must be writable
  let probe = home;
  while (!(await e.seams.exists(probe))) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  return (await e.seams.writable(probe))
    ? ok(id, probe === home ? 'MCS_HOME is writable' : 'MCS_HOME can be created')
    : fail(id, 'error', 'MCS_HOME is not writable', fix);
};

export const diskFree: BuiltinCheck = async (e) => {
  const free = await e.seams.freeBytes(e.ws?.dir ?? e.ctx.repo);
  const gib = (free / 1024 ** 3).toFixed(1);
  return free >= DISK_FREE_MIN_BYTES
    ? ok('disk.free', `${gib} GiB free`)
    : fail('disk.free', 'warn', `${gib} GiB free (below 1 GiB)`, 'free disk space on the drive of the workspace');
};

// ---- workspace checks (need a task)

function needsTask(id: string, ws: WorkspaceRef | null): DoctorCheck | null {
  return ws === null ? ok(id, 'no task selected (skipped)') : null;
}

export const configValid: BuiltinCheck = async (e) => {
  const id = 'config.valid';
  try {
    const result = await e.config();
    return ok(id, `configuration of ${result.source} is valid (${String(result.regex.checked)} regexes)`);
  } catch (error) {
    return fail(
      id,
      'error',
      messageOf(error),
      `mcs check --task ${e.ws?.slug ?? '<slug>'}, then fix the file it names`,
    );
  }
};

export const portFree: BuiltinCheck = async (e) => {
  const id = 'port.free';
  const skipped = needsTask(id, e.ws);
  if (skipped !== null || e.ws === null) return skipped ?? ok(id, 'skipped');
  let port: number;
  try {
    port = (await e.config()).effectivePort;
  } catch {
    return ok(id, 'no valid configuration (see config.valid)');
  }
  const probe = await e.probe();
  if (isLiveState(probe.state) && probe.port === port) return ok(id, `port ${String(port)} is held by this instance`);
  return (await e.seams.canBind(port))
    ? ok(id, `port ${String(port)} is free`)
    : fail(
        id,
        'warn',
        `port ${String(port)} is in use by another process`,
        `stop the other process, or choose another port: mcs configure --task ${e.ws.slug} --set port=<n>`,
      );
};

export const workspaceWritable: BuiltinCheck = async (e) => {
  const id = 'workspace.writable';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  return (await e.seams.writable(e.ws.dir))
    ? ok(id, 'workspace is writable')
    : fail(id, 'error', 'the workspace folder is not writable', 'give your user write access to the workspace folder');
};

export const instanceIdentity: BuiltinCheck = async (e) => {
  const id = 'instance.identity';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  try {
    const instance = await readInstanceFile(e.ws);
    return instance === null
      ? fail(id, 'warn', 'no instance.json (not initialized for the Node runtime)', `mcs init --slug ${e.ws.slug}`)
      : ok(id, `instance ${instance.instanceId.slice(0, 8)}`);
  } catch (error) {
    return fail(id, 'error', messageOf(error), `mcs instances repair --task ${e.ws.slug}`);
  }
};

export const databaseIntegrity: BuiltinCheck = async (e) => {
  const id = 'database.integrity';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  const file = workspacePath(e.ws, 'data', 'monitor.db');
  if (!(await e.seams.exists(file))) return ok(id, 'no database yet');
  const fix = `mcs stop --task ${e.ws.slug}, then restore a backup or rebuild the database`;
  try {
    const answer = e.seams.quickCheck(file);
    return answer === 'ok' ? ok(id, 'quick_check ok') : fail(id, 'error', `quick_check: ${answer}`, fix);
  } catch (error) {
    return fail(id, 'error', `cannot open the database read-only: ${messageOf(error)}`, fix);
  }
};

export const stateCurrent: BuiltinCheck = async (e) => {
  const id = 'state.current';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  const probe = await e.probe();
  switch (probe.state) {
    case 'running':
    case 'starting':
    case 'stopping':
    case 'stopped':
      return ok(id, probe.state);
    case 'unhealthy':
      return fail(id, 'warn', `unhealthy: ${probe.reason}`, `mcs restart --task ${e.ws.slug}`);
    case 'stale':
    case 'foreign-pid':
      return fail(id, 'warn', `${probe.state}: ${probe.reason}`, `mcs stop --task ${e.ws.slug}`);
    case 'unmanaged-running':
      return fail(id, 'warn', `${probe.state}: ${probe.reason}`, 'stop that monitor with the tool that started it');
  }
};

export const runtimeOutdated: BuiltinCheck = async (e) => {
  const id = 'runtime.outdated';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  const probe = await e.probe();
  const running = probe.identity?.codeStamp;
  if (!isLiveState(probe.state) || running === undefined) return ok(id, 'no running runtime');
  const stamp = await e.seams.codeStamp(e.ctx.runtimeDir);
  return stamp === null || stamp === running
    ? ok(id, 'the running runtime is current')
    : fail(id, 'warn', 'the runtime code changed since this instance started', `mcs restart --task ${e.ws.slug}`);
};

export const workspaceGitignored: BuiltinCheck = async (e) => {
  const id = 'workspace.gitignored';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  const result = await e.seams.run('git', ['check-ignore', '-q', e.ws.dir], e.ctx.repo);
  if (result === null) return fail(id, 'warn', 'git is not installed (not checked)', 'install git to check this');
  if (result.code === 0) return ok(id, 'workspace is git-ignored');
  if (result.code === 1)
    return fail(
      id,
      'warn',
      'the workspace is not git-ignored',
      'add .claude/monitor/ to the .gitignore of the repository',
    );
  return fail(
    id,
    'warn',
    'not a git repository, or git failed (not checked)',
    'run doctor inside a git repository to check this',
  );
};

const OPEN_GROUPS =
  /(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users):[^\r\n]*\((?:[^)]*,)?(?:M|F|W)(?:,[^)]*)?\)/i;

export const workspacePermissions: BuiltinCheck = async (e) => {
  const id = 'workspace.permissions';
  if (e.ws === null) return ok(id, 'no task selected (skipped)');
  const fix =
    e.seams.platform === 'win32'
      ? 'remove the write grants of Everyone, Users and Authenticated Users from the workspace folder (icacls)'
      : `chmod -R go-w ${path.basename(e.ws.dir)} (in the tasks folder)`;
  if (e.seams.platform === 'win32') {
    const result = await e.seams.run('icacls', [e.ws.dir], e.ctx.repo);
    if (result?.ok !== true)
      return fail(id, 'warn', 'icacls is not available (not checked)', 'run doctor on a system with icacls');
    const match = OPEN_GROUPS.exec(result.stdout);
    return match === null
      ? ok(id, 'workspace is not writable by other users')
      : fail(id, 'warn', `${match[1] ?? 'a group'} may write to the workspace`, fix);
  }
  const mode = await e.seams.mode(e.ws.dir);
  return (mode & 0o022) === 0
    ? ok(id, 'workspace is not writable by other users')
    : fail(id, 'warn', `mode ${(mode & 0o777).toString(8)} lets other users write`, fix);
};

/** The default line of the hooks area until it contributes its own provider (`extraChecks.hooks`). */
export const hooksDefault: BuiltinCheck = () =>
  Promise.resolve({
    id: 'hooks',
    ok: false,
    level: 'warn',
    detail: 'not installed or not checked',
    fix: 'hooks are opt-in: nothing to do unless you want live hook events',
  });

/** The built-in checks in output order. */
export const BUILTIN_CHECKS: readonly (readonly [id: string, run: BuiltinCheck])[] = [
  ['node.version', nodeVersion],
  ['node.sqlite', nodeSqlite],
  ['runtime.layout', runtimeLayout],
  ['runtime.bundle-integrity', bundleIntegrity],
  ['claude.home', claudeHome],
  ['transcripts.dir', transcriptsDir],
  ['transcripts.parse', transcriptsParse],
  ['config.valid', configValid],
  ['port.free', portFree],
  ['workspace.writable', workspaceWritable],
  ['mcshome.writable', mcsHomeWritable],
  ['instance.identity', instanceIdentity],
  ['database.integrity', databaseIntegrity],
  ['state.current', stateCurrent],
  ['runtime.outdated', runtimeOutdated],
  ['disk.free', diskFree],
  ['workspace.gitignored', workspaceGitignored],
  ['workspace.permissions', workspacePermissions],
  ['hooks', hooksDefault],
];

/** The configuration check of doctor: `ops.config.check` of the task, or of the defaults without one (it reads only). */
export function configOf(ctx: OpContext, ws: WorkspaceRef | null, deps: CheckDeps): Promise<CheckResult> {
  return configCheck(ctx, ws === null ? {} : { task: ws.slug }, deps);
}
