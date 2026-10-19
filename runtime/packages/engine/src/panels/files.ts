// The file panels (06 3.9): ledger, chain log, live logs and the stop file. All of them are read when a client asks and only
// then; every file function arrives through `FilesIo`, so the logic is the same on Windows, Linux and macOS and tests inject
// fakes.
//   - ledger: the lines that start with `|` among the last 30; chain log: the last 10 lines (what `tailLines` gives, nothing
//     more); live logs: the newest four files of `live_log_globs`, a tail for the first two (16 lines, 220 code points each).
//   - Privacy: the panels show the configured files as written, without redaction, because the owner chose them in the
//     configuration and the API is loopback only (ADR 0059). A configured path is used as it is: relative ones against the
//     repository folder (`..` included), absolute ones unchanged.
//   - A configured file that is missing, is a folder or cannot be read is an `unavailable` source with empty data, never an
//     error of the instance; a path the file system rejects is an `error` source.
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { isoMsZ, type Clock, type LinesPanel, type LogsPanel, type PanelSource, type PanelStats } from '@mcs/shared';

import { firstLine } from '../platform/exec.ts';
import { clipCodePoints, tailLines } from '../platform/fsx.ts';
import { globFiles, type GlobOptions, type GlobResult } from '../platform/glob.ts';
import { canonicalPath, toPosixRel } from '../platform/paths.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import {
  CHAIN_LOG_TAIL_LINES,
  LEDGER_TAIL_LINES,
  LOG_CAPPED_MESSAGE,
  LOG_FILES_SHOWN,
  LOG_FILES_WITH_TAIL,
  LOG_GLOB_MAX_DEPTH,
  LOG_GLOB_MAX_MATCHES,
  LOG_LINE_MAX_CODE_POINTS,
  LOG_TAIL_LINES,
  SOURCE_MESSAGE_MAX_CHARS,
  specFor,
  type SourceTiming,
} from './constants.ts';
import { SourceCache, sourceState, type CacheRead, type PanelSample, type SourceResult } from './source-cache.ts';

/** What the file panels need from the file system. */
export interface FilesIo {
  /** Follows links; rejects with the errno error when the path cannot be stat'ed. */
  stat(file: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }>;
  /** `platform/fsx.ts` `tailLines`: an unreadable file gives `[]`. */
  tailLines(file: string, n: number): Promise<string[]>;
  globFiles(pattern: string, base: string, opts: GlobOptions): Promise<GlobResult>;
}

export const realFilesIo: FilesIo = {
  stat: async (file) => {
    const s = await stat(file);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  },
  tailLines,
  globFiles,
};

type FileSource = 'ledger' | 'chainLog' | 'logs' | 'stopFile';

export interface FilesSamplerDeps {
  /** `config.monitor.repo`, absolute. */
  repoDir: string;
  /** `config.monitor.ledger`, `chain_log`, `stop_file`: relative to the repository or absolute; `null` when not configured. */
  ledger: string | null;
  chainLog: string | null;
  stopFile: string | null;
  /** `config.monitor.live_log_globs`. */
  liveLogGlobs: readonly string[];
  clock: Clock;
  errors: ErrorRing;
  io?: FilesIo;
  /** Replaces fields of the source table (tests use short waits). */
  timings?: Partial<Record<FileSource, Partial<SourceTiming>>>;
}

export interface FilesSampler {
  ledger(): Promise<PanelSample<LinesPanel>>;
  chainLog(): Promise<PanelSample<LinesPanel>>;
  logs(): Promise<PanelSample<LogsPanel>>;
  /** `data` is whether the stop file exists (false when not configured). */
  stopFile(): Promise<PanelSample<boolean>>;
  abort(): void;
  stats(): PanelStats;
}

function resolveConfigured(repoDir: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(repoDir, configured);
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function readableMessage(error: unknown, what: string): string {
  const code = errnoCode(error);
  if (code !== undefined) return `the ${what} could not be read (${code})`;
  const line = error instanceof Error ? firstLine(error.message, SOURCE_MESSAGE_MAX_CHARS) : '';
  return line === '' ? `the ${what} could not be read` : line;
}

// ---- stop file -------------------------------------------------------------------------------------------------------

export interface StopFileCacheDeps {
  repoDir: string;
  stopFile: string;
  clock: Clock;
  errors: ErrorRing;
  /** Default: `stat` succeeds. Any failure is "does not exist" (the legacy `os.path.exists`). */
  exists?: (file: string) => Promise<boolean>;
  timing?: Partial<SourceTiming>;
}

/** The cache of the `stopFile` source; the git panel shows the same fact (`GitPanel.stopFile`). */
export function createStopFileCache(deps: StopFileCacheDeps): SourceCache<boolean> {
  const exists =
    deps.exists ??
    (async (file: string): Promise<boolean> => {
      try {
        await stat(file);
        return true;
      } catch {
        return false;
      }
    });
  const file = resolveConfigured(deps.repoDir, deps.stopFile);
  return new SourceCache<boolean>(
    specFor<boolean>('stopFile', async () => ({ status: 'ok', value: await exists(file) }), deps.timing),
    deps.clock,
    deps.errors,
  );
}

// ---- ledger and chain log --------------------------------------------------------------------------------------------

function emptyLines(file: string | null): LinesPanel {
  return { lines: [], file, exists: false, sizeBytes: null, modifiedAt: null };
}

function linesCache(
  deps: FilesSamplerDeps,
  io: FilesIo,
  source: 'ledger' | 'chainLog',
  configured: string,
): SourceCache<LinesPanel> {
  const what = source === 'ledger' ? 'ledger' : 'chain log';
  const count = source === 'ledger' ? LEDGER_TAIL_LINES : CHAIN_LOG_TAIL_LINES;
  const file = resolveConfigured(deps.repoDir, configured);
  const load = async (signal: AbortSignal): Promise<SourceResult<LinesPanel>> => {
    let info;
    try {
      info = await io.stat(file);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return { status: 'unavailable', message: `the ${what} file was not found` };
      if (code === 'EACCES' || code === 'EPERM') {
        return { status: 'unavailable', message: `the ${what} file cannot be read (permission denied)` };
      }
      return { status: 'error', message: readableMessage(error, `${what} file`) };
    }
    if (!info.isFile) return { status: 'unavailable', message: `the ${what} path is a folder, not a file` };
    if (signal.aborted) return { status: 'error', message: 'the read was cancelled' };
    const tail = await io.tailLines(file, count);
    return {
      status: 'ok',
      value: {
        lines: source === 'ledger' ? tail.filter((line) => line.startsWith('|')) : tail,
        file: configured,
        exists: true,
        sizeBytes: info.size,
        modifiedAt: isoMsZ(Math.trunc(info.mtimeMs)),
      },
    };
  };
  return new SourceCache<LinesPanel>(specFor(source, load, deps.timings?.[source]), deps.clock, deps.errors);
}

function linesSample(
  source: 'ledger' | 'chainLog',
  configured: string | null,
  read: CacheRead<LinesPanel> | null,
): PanelSample<LinesPanel> {
  if (read === null) {
    return { data: emptyLines(null), sources: [{ source, status: 'disabled', sampledAt: null, message: null }] };
  }
  // 'unavailable' means the file is not usable now: the lines of an earlier read no longer describe it
  const data = read.status === 'unavailable' ? emptyLines(configured) : read.value;
  return { data, sources: [sourceState(source, read)] };
}

// ---- live logs -------------------------------------------------------------------------------------------------------

interface LogsValue {
  panel: LogsPanel;
  /** Shown as the message of the source when the glob walk was capped. */
  note: string | null;
}

interface Found {
  file: string;
  size: number;
  mtimeMs: number;
}

function logsCache(deps: FilesSamplerDeps, io: FilesIo): SourceCache<LogsValue> {
  const globs = [...deps.liveLogGlobs];
  const load = async (signal: AbortSignal): Promise<SourceResult<LogsValue>> => {
    let capped = false;
    const unique: string[] = [];
    const seen = new Set<string>();
    try {
      for (const pattern of globs) {
        if (signal.aborted) return { status: 'error', message: 'the read was cancelled' };
        const found = await io.globFiles(pattern, deps.repoDir, {
          maxMatches: LOG_GLOB_MAX_MATCHES,
          maxDepth: LOG_GLOB_MAX_DEPTH,
        });
        capped ||= found.truncated;
        for (const file of found.files) {
          const canonical = canonicalPath(file);
          if (seen.has(canonical)) continue;
          seen.add(canonical);
          unique.push(canonical);
        }
      }
    } catch (error) {
      return { status: 'error', message: readableMessage(error, 'log files') };
    }
    if (unique.length > LOG_GLOB_MAX_MATCHES) {
      capped = true;
      unique.length = LOG_GLOB_MAX_MATCHES;
    }

    // a file that vanished between the glob and the stat is skipped (the legacy poll crashed here)
    const stats = await Promise.all(
      unique.map(async (file): Promise<Found | null> => {
        try {
          const info = await io.stat(file);
          return info.isFile ? { file, size: info.size, mtimeMs: info.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
    );
    const existing = stats.filter((s): s is Found => s !== null);
    existing.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const now = deps.clock.now();
    const shown = await Promise.all(
      existing.slice(0, LOG_FILES_SHOWN).map(async (entry, index) => {
        let tail: string[] = [];
        if (index < LOG_FILES_WITH_TAIL) {
          try {
            tail = (await io.tailLines(entry.file, LOG_TAIL_LINES)).map((line) =>
              clipCodePoints(line, LOG_LINE_MAX_CODE_POINTS),
            );
          } catch {
            tail = [];
          }
        }
        return {
          name: path.basename(entry.file),
          ageS: Math.max(0, Math.trunc((now - entry.mtimeMs) / 1000)),
          sizeBytes: entry.size,
          tail,
          relPath: toPosixRel(entry.file, deps.repoDir),
          modifiedAt: isoMsZ(Math.trunc(entry.mtimeMs)),
        };
      }),
    );
    return {
      status: 'ok',
      value: { panel: { files: shown, matchedFiles: existing.length }, note: capped ? LOG_CAPPED_MESSAGE : null },
    };
  };
  return new SourceCache<LogsValue>(specFor('logs', load, deps.timings?.logs), deps.clock, deps.errors);
}

// ---- the sampler -----------------------------------------------------------------------------------------------------

export function createFilesSampler(deps: FilesSamplerDeps): FilesSampler {
  const io = deps.io ?? realFilesIo;
  const ledger = deps.ledger === null ? null : linesCache(deps, io, 'ledger', deps.ledger);
  const chainLog = deps.chainLog === null ? null : linesCache(deps, io, 'chainLog', deps.chainLog);
  const logs = deps.liveLogGlobs.length === 0 ? null : logsCache(deps, io);
  const stop =
    deps.stopFile === null
      ? null
      : createStopFileCache({
          repoDir: deps.repoDir,
          stopFile: deps.stopFile,
          clock: deps.clock,
          errors: deps.errors,
          ...(deps.timings?.stopFile === undefined ? {} : { timing: deps.timings.stopFile }),
        });
  const named: [PanelSource, { stats(): ReturnType<SourceCache<unknown>['stats']> } | null][] = [
    ['ledger', ledger],
    ['chainLog', chainLog],
    ['logs', logs],
    ['stopFile', stop],
  ];

  return {
    async ledger() {
      return linesSample('ledger', deps.ledger, ledger === null ? null : await ledger.read());
    },
    async chainLog() {
      return linesSample('chainLog', deps.chainLog, chainLog === null ? null : await chainLog.read());
    },
    async logs() {
      if (logs === null) {
        return {
          data: { files: [], matchedFiles: 0 },
          sources: [{ source: 'logs', status: 'disabled', sampledAt: null, message: null }],
        };
      }
      const read = await logs.read();
      const state = sourceState('logs', read);
      const note = read.value?.note ?? null;
      if (note !== null && read.status === 'ok') state.message = note;
      return { data: read.value?.panel ?? null, sources: [state] };
    },
    async stopFile() {
      if (stop === null) {
        return { data: false, sources: [{ source: 'stopFile', status: 'disabled', sampledAt: null, message: null }] };
      }
      const read = await stop.read();
      return { data: read.value === true, sources: [sourceState('stopFile', read)] };
    },
    abort() {
      ledger?.abort();
      chainLog?.abort();
      logs?.abort();
      stop?.abort();
    },
    stats() {
      const out: PanelStats = {};
      for (const [source, cache] of named) {
        const s = cache?.stats();
        if (s !== undefined && s.refreshes > 0) out[source] = s;
      }
      return out;
    },
  };
}
