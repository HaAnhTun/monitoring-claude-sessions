// The git panel sampler (06 3.8, ADR 0057). Lock free by construction: every call carries `--no-optional-locks`, status also
// `-c core.fsmonitor=false`, and the environment of kind `git` (built by `buildChildEnv`, not here) adds `GIT_OPTIONAL_LOCKS=0`
// and `GIT_TERMINAL_PROMPT=0`. The monitor therefore never takes `.git/index.lock` and never starts an fsmonitor daemon.
//   - one `status --porcelain=v2 --branch` per refresh (ttl 15 s): head oid, branch and the number of entries;
//   - `log -3` only when the head oid changed or after 120 s: a new log cache per head oid, so a stale log of another head is
//     never served;
//   - not a repository, git missing and "dubious ownership" are states of the panel, never errors of the instance.
// The arguments are constants; the only dynamic value is the resolved repository folder, passed as `cwd`. Nothing is written to
// stdout. Commit subjects and branch names are shown as git prints them (loopback API, owner's own repository).
import { stat } from 'node:fs/promises';

import { isoMsZ, type Clock, type GitPanel, type PanelStats } from '@mcs/shared';

import { firstLine, type ChildResult } from '../platform/exec.ts';
import { clipCodePoints } from '../platform/fsx.ts';
import type { ExecApi } from '../runtime/context.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import {
  GIT_COMMITS_SHOWN,
  GIT_LOG_MAX_BYTES,
  PANEL_SOURCE_TABLE,
  GIT_STATUS_MAX_BYTES,
  GIT_SUBJECT_MAX_CHARS,
  SOURCE_MESSAGE_MAX_CHARS,
  specFor,
  type SourceTiming,
} from './constants.ts';
import { createStopFileCache } from './files.ts';
import { SourceCache, sourceState, type CacheRead, type PanelSample, type SourceResult } from './source-cache.ts';

export type GitExec = Pick<ExecApi, 'execFileText' | 'resolveExecutable'>;

export interface GitSamplerDeps {
  /** `config.monitor.repo`, absolute: the `cwd` of every git call. */
  repoDir: string;
  /** `config.monitor.stop_file`: relative to the repository or absolute; `null` when not configured. */
  stopFile: string | null;
  clock: Clock;
  errors: ErrorRing;
  exec: GitExec;
  /** Default: `stat` succeeds. */
  fileExists?: (file: string) => Promise<boolean>;
  /** Default: `stat` says directory. Asked only to tell a missing folder from a missing git after `ENOENT`. */
  dirExists?: (dir: string) => Promise<boolean>;
  /** Replaces fields of the source table (tests use short waits). */
  timings?: Partial<Record<'git.status' | 'git.log' | 'stopFile', Partial<SourceTiming>>>;
}

export interface GitSampler {
  /** Reads the three sources (status, log, stop file) and shapes `GitPanel`; `data` is null only while nothing is known yet. */
  read(): Promise<PanelSample<GitPanel>>;
  /** Aborts the running calls (the panel service closes). */
  abort(): void;
  /** Counters of the sources read at least once. */
  stats(): PanelStats;
}

export interface StatusV2 {
  headOid: string | null;
  branch: string | null;
  detached: boolean;
  dirty: number;
}

/** Parses `status --porcelain=v2 --branch` (06 3.8): header lines start with `# `, every other non-empty line is one entry. */
export function parseStatusV2(stdout: string): StatusV2 {
  let headOid: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let dirty = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      headOid = oid === '(initial)' ? null : oid;
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      detached = head === '(detached)';
      branch = detached ? null : head;
    } else if (!line.startsWith('# ')) {
      dirty += 1;
    }
  }
  return { headOid, branch, detached, dirty };
}

export type GitCommit = GitPanel['commits'][number];

/** Parses `log --format=%h%x1f%aI%x1f%s`: at most three commits; a line without three fields is skipped. */
export function parseLogOutput(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const raw of stdout.split('\n')) {
    if (commits.length >= GIT_COMMITS_SHOWN) break;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    const parts = line.split('\u001f');
    const [hash, authored] = parts;
    if (parts.length < 3 || hash === undefined || authored === undefined) continue;
    const time = new Date(authored).getTime();
    commits.push({
      hash,
      subject: clipCodePoints(parts.slice(2).join('\u001f'), GIT_SUBJECT_MAX_CHARS),
      at: Number.isNaN(time) ? null : isoMsZ(time),
    });
  }
  return commits;
}

type Failure = 'not_a_repository' | 'git_missing' | 'error';

const STATUS_ARGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'color.ui=never',
  'status',
  '--porcelain=v2',
  '--branch',
] as const;

const LOG_ARGS = [
  '--no-optional-locks',
  '-c',
  'color.ui=never',
  'log',
  `-${String(GIT_COMMITS_SHOWN)}`,
  '--no-color',
  '--format=%h%x1f%aI%x1f%s',
] as const;

async function defaultDirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The messages of a failed call, by the error code of the exec helper; never the arguments, never more than stderr's first line. */
function failureMessage(done: ChildResult, verb: 'status' | 'log'): string {
  switch (done.error) {
    case 'TIMEOUT':
      return `git ${verb} timed out`;
    case 'OUTPUT_LIMIT':
      return `git ${verb} output is too large`;
    case 'QUEUE_FULL':
      return 'too many child processes are running';
    case 'ABORTED':
      return `git ${verb} was cancelled`;
    case 'SPAWN_FAILED':
    case 'EACCES':
      return 'git could not be started';
    case 'NONZERO_EXIT': {
      const line = firstLine(done.stderr, SOURCE_MESSAGE_MAX_CHARS);
      return line === '' ? `git ${verb} failed with exit code ${String(done.code)}` : line;
    }
    case 'ENOENT':
    case null:
      return `git ${verb} failed`;
  }
}

export function createGitSampler(deps: GitSamplerDeps): GitSampler {
  const { repoDir, clock, errors, exec } = deps;
  const dirExists = deps.dirExists ?? defaultDirExists;
  const statusTimeoutMs = deps.timings?.['git.status']?.timeoutMs ?? PANEL_SOURCE_TABLE['git.status'].timeoutMs;
  const logTimeoutMs = deps.timings?.['git.log']?.timeoutMs ?? PANEL_SOURCE_TABLE['git.log'].timeoutMs;
  // The reason of the last failed status call, for the shape of `data` when there is no value to show.
  let failure: Failure = 'error';

  async function run(
    args: readonly string[],
    verb: 'status' | 'log',
    signal: AbortSignal,
  ): Promise<{ done: ChildResult } | { result: SourceResult<never>; failure: Failure }> {
    const file = await exec.resolveExecutable('git');
    if (file === null) {
      return {
        result: { status: 'unavailable', message: 'git is not installed or not on PATH' },
        failure: 'git_missing',
      };
    }
    const done = await exec.execFileText(
      {
        kind: 'git',
        file,
        args,
        cwd: repoDir,
        timeoutMs: verb === 'status' ? statusTimeoutMs : logTimeoutMs,
        maxOutputBytes: verb === 'status' ? GIT_STATUS_MAX_BYTES : GIT_LOG_MAX_BYTES,
        encoding: 'utf8',
      },
      signal,
    );
    if (done.ok) return { done };
    if (done.error === 'ENOENT') {
      return (await dirExists(repoDir))
        ? { result: { status: 'unavailable', message: 'git is not installed or not on PATH' }, failure: 'git_missing' }
        : {
            result: { status: 'unavailable', message: 'the repository folder was not found' },
            failure: 'not_a_repository',
          };
    }
    if (done.error === 'NONZERO_EXIT' && done.code === 128 && done.stderr.includes('not a git repository')) {
      return {
        result: { status: 'unavailable', message: 'the repository folder is not a git repository' },
        failure: 'not_a_repository',
      };
    }
    return { result: { status: 'error', message: failureMessage(done, verb) }, failure: 'error' };
  }

  const statusCache = new SourceCache<StatusV2>(
    specFor<StatusV2>(
      'git.status',
      async (signal) => {
        const outcome = await run(STATUS_ARGS, 'status', signal);
        if ('result' in outcome) {
          failure = outcome.failure;
          return outcome.result;
        }
        return { status: 'ok', value: parseStatusV2(outcome.done.stdout) };
      },
      deps.timings?.['git.status'],
    ),
    clock,
    errors,
  );

  // One log cache per head oid: a head that moved starts from nothing and never serves the commits of the old head.
  let logOid: string | null = null;
  let logCache: SourceCache<GitCommit[]> | null = null;
  let retired: { refreshes: number; failures: number } = { refreshes: 0, failures: 0 };

  function logCacheFor(oid: string): SourceCache<GitCommit[]> {
    if (logCache !== null && logOid === oid) return logCache;
    if (logCache !== null) {
      const old = logCache.stats();
      retired = { refreshes: retired.refreshes + old.refreshes, failures: retired.failures + old.failures };
      logCache.abort();
    }
    logOid = oid;
    logCache = new SourceCache<GitCommit[]>(
      specFor<GitCommit[]>(
        'git.log',
        async (signal) => {
          const outcome = await run(LOG_ARGS, 'log', signal);
          if ('result' in outcome) return outcome.result;
          return { status: 'ok', value: parseLogOutput(outcome.done.stdout) };
        },
        deps.timings?.['git.log'],
      ),
      clock,
      errors,
    );
    return logCache;
  }

  const stopCache =
    deps.stopFile === null
      ? null
      : createStopFileCache({
          repoDir,
          stopFile: deps.stopFile,
          clock,
          errors,
          ...(deps.fileExists === undefined ? {} : { exists: deps.fileExists }),
          ...(deps.timings?.stopFile === undefined ? {} : { timing: deps.timings.stopFile }),
        });

  function emptyData(repoState: GitPanel['repoState'], stopFile: boolean): GitPanel {
    return { branch: null, dirty: null, stopFile, commits: [], headOid: null, detached: false, repoState };
  }

  return {
    async read(): Promise<PanelSample<GitPanel>> {
      const [status, stop] = await Promise.all([statusCache.read(), stopCache?.read() ?? Promise.resolve(null)]);
      const stopFile = stop?.value === true;
      const stopState = stop === null ? disabledStopFile() : sourceState('stopFile', stop);

      // the status decides what is known; 'unavailable' means the old value (if any) no longer describes the folder
      const known = status.status === 'unavailable' ? null : status.value;
      let commits: GitCommit[] = [];
      let logRead: CacheRead<GitCommit[]>;
      if (known === null) {
        logRead = { value: null, sampledAt: null, status: status.status, message: status.message };
      } else if (known.headOid === null) {
        logRead = { value: [], sampledAt: status.sampledAt, status: 'ok', message: null };
      } else {
        logRead = await logCacheFor(known.headOid).read();
        commits = logRead.value ?? [];
      }

      let data: GitPanel | null;
      if (known !== null) {
        data = {
          branch: known.branch,
          dirty: known.dirty,
          stopFile,
          commits,
          headOid: known.headOid,
          detached: known.detached,
          repoState: 'ok',
        };
      } else if (status.status === 'unavailable' || status.status === 'error') {
        data = emptyData(status.status === 'unavailable' ? failure : 'error', stopFile);
      } else {
        data = null;
      }
      return { data, sources: [sourceState('git.status', status), sourceState('git.log', logRead), stopState] };
    },

    abort(): void {
      statusCache.abort();
      logCache?.abort();
      stopCache?.abort();
    },

    stats(): PanelStats {
      const out: PanelStats = {};
      const status = statusCache.stats();
      if (status.refreshes > 0) out['git.status'] = status;
      const live = logCache?.stats();
      const logRefreshes = retired.refreshes + (live?.refreshes ?? 0);
      if (logRefreshes > 0) {
        out['git.log'] = {
          refreshes: logRefreshes,
          failures: retired.failures + (live?.failures ?? 0),
          lastDurationMs: live?.lastDurationMs ?? null,
          lastStatus: live?.lastStatus ?? null,
        };
      }
      const stop = stopCache?.stats();
      if (stop !== undefined && stop.refreshes > 0) out.stopFile = stop;
      return out;
    },
  };
}

function disabledStopFile(): ReturnType<typeof sourceState> {
  return { source: 'stopFile', status: 'disabled', sampledAt: null, message: null };
}
