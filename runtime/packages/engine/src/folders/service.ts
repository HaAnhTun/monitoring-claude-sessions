// The folder service (CAW design 03 section 4.5): the one object that answers "which folders can a terminal start in". It owns
// the four sources, none of them new code: the DA memory reader (read-only, summary only), the catalog of the Claude home, the
// folders a person added (`data/folders.json`) and the statistics of the projects in the database (`ctx.queries.projectStats`,
// the one query layer). `mergeFolders` joins them.
//
//   - `list()` answers from caches. The DA reader reuses its own read for `daCacheMs`; the catalog rescans on its own interval and
//     a scan that is overdue starts behind the answer, never in front of it; "is this path a folder" is checked once per path in
//     a window (`existsRecheckMs`) and a stale value is renewed behind the answer. Only a value that was never known is waited for.
//   - `add` and `remove` are the user state: `FolderError` carries the code (`folder_invalid`, `folder_limit`, `folder_not_found`,
//     `state_unwritable`) and never a path.
//   - Nothing is logged here: a path, a summary or a key is private to the person.
//
//   - `resumeEligibility` and `planResume` (CAW-30, design 03 section 6, `resume.ts`) answer whether a session may be resumed in a
//     terminal. They read the database through the query layer (`resumeFacts`), the registry through a snapshot, and the linker for
//     the sessions that a terminal of this app holds; the folder is looked at when the question is asked, never from the caches of the
//     list, and only the plan asks whether the transcript is still on disk.
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  folderPathKey,
  isoMsZ,
  type Folder,
  type FolderListResponse,
  type ResumeEligibility,
  windowsFolderPath,
} from '@mcs/shared';

import type { RepoContext } from '../db/open.ts';
import { createRegistrySnapshot, type RegistryEntry, type RegistrySnapshot } from '../external/registry.ts';
import { errorCodeOf } from '../ingest/tail/file-identity.ts';
import { mapLimit, nodeDiscoveryFs, type DiscoveryFs } from '../ingest/transcripts/discovery.ts';
import type { TerminalLinker } from '../link/types.ts';
import { hostPlatform } from '../platform/host.ts';
import { pidAlive } from '../platform/process.ts';
import { folderKeyOfPath } from '../projects/folder-key.ts';
import { projectsRootOf } from '../projects/scope.ts';
import type { ProjectStat, ResumeFacts } from '../query/projects.ts';
import { createProjectCatalog, type ProjectCatalog } from './catalog.ts';
import { createDaMemoryReader, defaultDaMemoryDir, type DaFs, type DaMemoryReader } from './da-memory.ts';
import { mergeFolders } from './merge.ts';
import { decideResume, resumePlanOf, type ResumeEnvironment, type ResumePlan } from './resume.ts';
import { createUserFolders, type UserFolders } from './user-folders.ts';

/** How long "this path is a folder" is trusted. */
export const FOLDER_EXISTS_RECHECK_MS = 120_000;
/** Paths checked together. */
const CHECK_PARALLEL = 8;
const HOUR_MS = 3_600_000;

/** The part of the instance context the service reads (an `InstanceContext` has all of it); tests pass literals. */
export interface FolderServiceContext {
  /** `CLAUDE_CONFIG_DIR` or `<home>/.claude`: the catalog reads `projects` below it. */
  readonly claudeHome: string;
  /** The workspace folder: `data/folders.json` lives in it. */
  readonly instanceDir: string;
  readonly clock: { now(): number };
  readonly scope: RepoContext;
  readonly queries: {
    projectStats(ctx: RepoContext, o: { readonly windowFromMs: number | null }): ProjectStat[];
    /** The facts of one session, or null when the database does not know it (CAW design 03 2.8). */
    resumeFacts(ctx: RepoContext, sessionId: string): ResumeFacts | null;
  };
  readonly config: {
    readonly monitor: { readonly window_hours: number };
    readonly runtime: {
      readonly projects: {
        readonly daMemoryDir: string | null;
        readonly daCacheMs: number;
        readonly catalogIntervalMs: number;
        readonly userFoldersMax: number;
      };
    };
  };
}

/** What a test replaces; production passes nothing. */
export interface FolderServiceDeps {
  readonly daMemory?: DaMemoryReader;
  readonly catalog?: ProjectCatalog;
  readonly userFolders?: UserFolders;
  readonly fs?: DiscoveryFs;
  readonly daFs?: DaFs;
  /** Whether a path is a directory now (follows links); null when that could not be told. Default: `stat`. */
  readonly isDirectory?: (target: string) => Promise<boolean | null>;
  /** The row of an empty list (default the home directory of the person). */
  readonly homeDir?: string | null;
  /** Which spelling of a path is valid (default: the host). */
  readonly win32?: boolean;
  readonly existsRecheckMs?: number;
  /** The terminals of this app (`TerminalLinker`); default: no terminal owns anything. */
  readonly linker?: Pick<TerminalLinker, 'sessionOwner' | 'ownedPids'>;
  /** The registry of the Claude home; default: a snapshot over `ctx.claudeHome`. */
  readonly registry?: Pick<RegistrySnapshot, 'read'>;
  /** Whether a transcript file is on disk (the plan asks); default: `stat`, a file. */
  readonly fileExists?: (file: string) => Promise<boolean>;
}

export interface FolderService {
  /** Loads the added folders, starts the catalog timer and waits for its first scan. Safe to call twice. */
  start(): Promise<void>;
  /** Stops the catalog timer and waits for a scan that is running. */
  stop(): Promise<void>;
  /** The merged, ordered list with the status of the three sources; from caches, a stale cache refreshes behind the answer. */
  list(): Promise<FolderListResponse>;
  /** Idempotent and persisted: the row of the folder. Throws `FolderError('folder_invalid' | 'folder_limit' | 'state_unwritable')`. */
  add(rawPath: string): Promise<Folder>;
  /** Drops the `user` origin of the folder with this key. Throws `FolderError('folder_not_found' | 'state_unwritable')`. */
  remove(key: string): Promise<void>;
  /** Reads the state file and scans the catalog again, and forgets what is known about the paths. Never rejects. */
  refresh(): Promise<void>;
  /**
   * May this session be resumed in a terminal, may a copy be, and why not (design 03 section 6). A session the database does not
   * know is a `ResumeRefusal('session_not_found')`; every other answer is a value.
   */
  resumeEligibility(sessionId: string): Promise<ResumeEligibility>;
  /**
   * The plan of a resume (`fork` false or absent) or of a copy (`fork` true), asked again when the terminal is created, with a look at
   * the transcript file. Throws `ResumeRefusal` with the code of the first check that failed.
   */
  planResume(sessionId: string, options?: { readonly fork?: boolean }): Promise<ResumePlan>;
}

/** The default check: a directory, links followed; only "gone" counts as false, any other failure is "not known". */
async function nodeIsDirectory(target: string): Promise<boolean | null> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    const code = errorCodeOf(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

/** The default check for a transcript file: a file, links followed. */
async function nodeFileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Without a terminal host nothing is owned by a terminal. */
const NO_TERMINALS: Pick<TerminalLinker, 'sessionOwner' | 'ownedPids'> = {
  sessionOwner: () => null,
  ownedPids: () => new Set<number>(),
};

interface Checked {
  readonly value: boolean;
  readonly at: number;
}

export function createFolderService(ctx: FolderServiceContext, deps: FolderServiceDeps = {}): FolderService {
  const projects = ctx.config.runtime.projects;
  const win32 = deps.win32 ?? hostPlatform === 'win32';
  const recheckMs = deps.existsRecheckMs ?? FOLDER_EXISTS_RECHECK_MS;
  const isDirectory = deps.isDirectory ?? nodeIsDirectory;
  const daMemory =
    deps.daMemory ??
    createDaMemoryReader({
      dir: projects.daMemoryDir ?? defaultDaMemoryDir(),
      cacheMs: projects.daCacheMs,
      win32,
      ...(deps.daFs === undefined ? {} : { fs: deps.daFs }),
    });
  const catalog =
    deps.catalog ??
    createProjectCatalog({
      projectsRoot: projectsRootOf(ctx.claudeHome),
      intervalMs: projects.catalogIntervalMs,
      now: () => ctx.clock.now(),
      win32,
      fs: deps.fs ?? nodeDiscoveryFs,
    });
  const userFolders =
    deps.userFolders ??
    createUserFolders({
      file: path.join(ctx.instanceDir, 'data', 'folders.json'),
      max: projects.userFoldersMax,
      now: () => ctx.clock.now(),
      win32,
    });
  const homeDir = deps.homeDir === undefined ? os.homedir() : deps.homeDir;
  const linker = deps.linker ?? NO_TERMINALS;
  const registry =
    deps.registry ?? createRegistrySnapshot({ claudeHome: ctx.claudeHome, pidAlive, now: () => ctx.clock.now() });
  const fileExists = deps.fileExists ?? nodeFileExists;

  const known = new Map<string, Checked>();
  let loading: Promise<void> | null = null;
  let renewing = false;
  let started = false;

  /** The state file is read once, before the first list, add or remove. */
  function loaded(): Promise<void> {
    loading ??= userFolders.load();
    return loading;
  }

  async function check(target: string): Promise<boolean | null> {
    try {
      return await isDirectory(target);
    } catch {
      return null;
    }
  }

  /** The paths whose existence the list shows: those of the DA memory and of the added folders. */
  function pathsOf(da: readonly { readonly path: string | null }[]): Map<string, string> {
    const paths = new Map<string, string>();
    for (const entry of [...da.map((folder) => folder.path), ...userFolders.list().map((folder) => folder.path)]) {
      if (entry === null) continue;
      const normalized = windowsFolderPath(entry, win32);
      if (normalized !== null) paths.set(folderPathKey(normalized), normalized);
    }
    return paths;
  }

  async function measure(entries: readonly [string, string][], nowMs: number): Promise<void> {
    await mapLimit(entries, CHECK_PARALLEL, async ([key, target]) => {
      const value = await check(target);
      if (value === null) return;
      known.set(key, { value, at: nowMs });
    });
  }

  /** Waits for the paths never checked; renews the stale ones behind the answer. */
  async function existence(paths: Map<string, string>, nowMs: number): Promise<Map<string, boolean>> {
    for (const key of known.keys()) if (!paths.has(key)) known.delete(key);
    const fresh: [string, string][] = [];
    const stale: [string, string][] = [];
    for (const [key, target] of paths) {
      const entry = known.get(key);
      if (entry === undefined) fresh.push([key, target]);
      else if (nowMs - entry.at >= recheckMs) stale.push([key, target]);
    }
    await measure(fresh, nowMs);
    if (stale.length > 0 && !renewing) {
      renewing = true;
      void measure(stale, nowMs).finally(() => {
        renewing = false;
      });
    }
    const result = new Map<string, boolean>();
    for (const key of paths.keys()) {
      const entry = known.get(key);
      if (entry !== undefined) result.set(key, entry.value);
    }
    return result;
  }

  /** The merged rows and the sources they come from. */
  async function snapshot(): Promise<{ list: FolderListResponse; nowMs: number }> {
    await loaded();
    const status0 = catalog.status();
    if (status0.scannedAt === null) await catalog.refresh();
    else if (ctx.clock.now() - status0.scannedAt >= 2 * projects.catalogIntervalMs) void catalog.refresh();
    const nowMs = ctx.clock.now();
    const daResult = await daMemory.read(nowMs);
    const stats = ctx.queries.projectStats(ctx.scope, {
      windowFromMs: nowMs - ctx.config.monitor.window_hours * HOUR_MS,
    });
    const exists = await existence(pathsOf(daResult.folders), nowMs);
    const folders = mergeFolders({
      da: daResult.folders,
      catalog: catalog.entries(),
      user: userFolders.list(),
      stats,
      nowMs,
      exists,
      homeDir,
      win32,
    });
    const claude = catalog.status();
    const added = userFolders.status();
    return {
      nowMs,
      list: {
        folders,
        sources: {
          daMemory: { status: daResult.status, folders: daResult.folders.length, readAt: isoMsZ(daResult.readAtMs) },
          claudeHome: {
            status: claude.state,
            folders: catalog.entries().length,
            scannedAt: claude.scannedAt === null ? null : isoMsZ(claude.scannedAt),
            truncated: claude.truncated,
          },
          userFolders: { status: added.state, count: added.count },
        },
        asOf: isoMsZ(nowMs),
      },
    };
  }

  /**
   * What the resume decision reads, gathered now: the facts of the session, the root of its project in the catalog (scanned first
   * when nobody did), the registry (an unreadable one is an empty list: nothing is shown live that cannot be proved) and the linker.
   */
  async function resumeEnvironment(sessionId: string, withTranscript: boolean): Promise<ResumeEnvironment> {
    const facts = ctx.queries.resumeFacts(ctx.scope, sessionId);
    let catalogRoot: string | null = null;
    let entries: readonly RegistryEntry[] = [];
    if (facts !== null) {
      if (facts.projectKey !== null) {
        if (catalog.status().scannedAt === null) await catalog.refresh();
        catalogRoot = catalog.entries().find((entry) => entry.key === facts.projectKey)?.root ?? null;
      }
      try {
        entries = (await registry.read()).entries;
      } catch {
        entries = [];
      }
    }
    return {
      facts,
      catalogRoot,
      registry: entries,
      sessionOwner: (id) => linker.sessionOwner(id),
      ownedPids: linker.ownedPids(),
      isDirectory: check,
      transcriptExists: withTranscript ? fileExists : null,
      knowsSession: (id) => ctx.queries.resumeFacts(ctx.scope, id) !== null,
      win32,
    };
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await loaded();
      catalog.start();
      await Promise.all([catalog.refresh(), daMemory.read(ctx.clock.now())]);
    },
    async stop() {
      if (!started) return;
      started = false;
      await catalog.stop();
    },
    async list() {
      return (await snapshot()).list;
    },
    async add(rawPath) {
      await loaded();
      const added = await userFolders.add(rawPath);
      const { list } = await snapshot();
      const cut = folderKeyOfPath(added.path).prefix;
      const row = list.folders.find(
        (candidate) =>
          candidate.userAdded && (candidate.key === added.key || (cut && candidate.key.startsWith(`${added.key}-`))),
      );
      if (row !== undefined) return row;
      // the list is full and the row did not make it: the folder itself, as the merge would show it alone
      const [alone] = mergeFolders({
        da: [],
        catalog: [],
        user: [added],
        stats: [],
        nowMs: ctx.clock.now(),
        homeDir: null,
        win32,
      });
      if (alone === undefined) throw new Error('the folder that was just added has no row');
      return alone;
    },
    async remove(key) {
      await loaded();
      await userFolders.remove(key);
    },
    async refresh() {
      known.clear();
      await userFolders.load();
      await catalog.refresh();
    },
    async resumeEligibility(sessionId) {
      return decideResume(sessionId, await resumeEnvironment(sessionId, false));
    },
    async planResume(sessionId, options) {
      const decision = await decideResume(sessionId, await resumeEnvironment(sessionId, true));
      return resumePlanOf(decision, options?.fork === true);
    },
  };
}
