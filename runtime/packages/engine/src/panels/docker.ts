// The docker source of the machine panel (06 3.7.5): `docker ps --format '{{.Names}} ({{.Status}})'`, enabled by the
// configuration key `docker`. Disabled makes no call at all (not even an executable search). The arguments are constants;
// nothing from the configuration or from a transcript enters the command. A missing docker is an `unavailable` source that
// is looked for again after 5 minutes; a stopped daemon is an `error` that carries the first line of stderr.
import type { Clock, PanelSourceStats } from '@mcs/shared';

import { firstLine, type ChildResult } from '../platform/exec.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import { PANEL_SOURCE_TABLE, SOURCE_MESSAGE_MAX_CHARS, specFor, type SourceTiming } from './constants.ts';
import type { MachineExec } from './machine.ts';
import { SourceCache, type CacheRead, type SourceResult } from './source-cache.ts';

/** At most this many container lines are shown. */
export const DOCKER_LINES_MAX = 50;
export const DOCKER_OUTPUT_MAX_BYTES = 262_144;
const DOCKER_ARGS = ['ps', '--format', '{{.Names}} ({{.Status}})'] as const;

/** Trimmed, non-empty lines of `docker ps`, in the order docker printed them, at most 50. */
export function parseDockerLines(stdout: string): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    lines.push(line);
    if (lines.length >= DOCKER_LINES_MAX) break;
  }
  return lines;
}

function failure(done: ChildResult): SourceResult<never> {
  switch (done.error) {
    case 'ENOENT':
      return { status: 'unavailable', message: 'docker not found on PATH' };
    case 'TIMEOUT':
      return { status: 'error', message: 'docker ps timed out' };
    case 'OUTPUT_LIMIT':
      return { status: 'error', message: 'docker ps output is too large' };
    case 'QUEUE_FULL':
      return { status: 'error', message: 'too many child processes are running' };
    case 'ABORTED':
      return { status: 'error', message: 'docker ps was cancelled' };
    case 'SPAWN_FAILED':
    case 'EACCES':
      return { status: 'error', message: 'docker could not be started' };
    case 'NONZERO_EXIT':
    case null: {
      const line = firstLine(done.stderr, SOURCE_MESSAGE_MAX_CHARS);
      return { status: 'error', message: line === '' ? `docker ps failed with exit code ${String(done.code)}` : line };
    }
  }
}

export interface DockerSourceDeps {
  /** `config.docker`. */
  enabled: boolean;
  clock: Clock;
  errors: ErrorRing;
  exec: MachineExec;
  /** Replaces fields of the source table (tests use short waits). */
  timing?: Partial<SourceTiming>;
}

export interface DockerSource {
  readonly enabled: boolean;
  /** A disabled source answers `status: 'disabled'` with no value and never calls docker. */
  read(): Promise<CacheRead<string[]>>;
  abort(): void;
  /** `null` while disabled. */
  stats(): PanelSourceStats | null;
}

export function createDockerSource(deps: DockerSourceDeps): DockerSource {
  if (!deps.enabled) {
    return {
      enabled: false,
      read: () => Promise.resolve({ value: null, sampledAt: null, status: 'disabled', message: null }),
      abort: () => undefined,
      stats: () => null,
    };
  }
  const timeoutMs = deps.timing?.timeoutMs ?? PANEL_SOURCE_TABLE.docker.timeoutMs;
  const cache = new SourceCache<string[]>(
    specFor<string[]>(
      'docker',
      async (signal) => {
        const file = await deps.exec.resolveExecutable('docker');
        if (file === null) return { status: 'unavailable', message: 'docker not found on PATH' };
        const done = await deps.exec.execFileText(
          {
            kind: 'docker',
            file,
            args: DOCKER_ARGS,
            timeoutMs,
            maxOutputBytes: DOCKER_OUTPUT_MAX_BYTES,
            encoding: 'utf8',
          },
          signal,
        );
        return done.ok ? { status: 'ok', value: parseDockerLines(done.stdout) } : failure(done);
      },
      deps.timing,
    ),
    deps.clock,
    deps.errors,
  );
  return {
    enabled: true,
    read: () => cache.read(),
    abort: () => {
      cache.abort();
    },
    stats: () => cache.stats(),
  };
}
