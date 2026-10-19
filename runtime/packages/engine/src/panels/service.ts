// The panel service (06 3.4, ADR 0059): `get(key)` assembles the `PanelResponse` of the six panels from the samplers of the
// panel sources (git, machine, files) and from the attempts table; `tickAttempts()` is the one periodic piece of work (the
// runtime drives it every 2 s and serializes it). Nothing here samples without a request: the samplers read their sources only
// when a `get` finds a value stale, and the caches inside them make N concurrent requests cost one refresh per stale source.
//
// What this module decides and the samplers do not: the response envelope (`key`, `status`, `generatedAt`, `sources`), the
// attempts panel (a cache per requested `limit`, whose `sourceState` is what the last tick said about the chain log), the
// tick serializer, the merged statistics for `HealthReport.panels`, and the shutdown (`close()` aborts what is running and
// drops the evidence the writer did not accept). Whether a panel is enabled is not decided here: `panels.*` gates the route.
import {
  McsError,
  isoMsZ,
  type AttemptsPanel,
  type PanelKey,
  type PanelResponse,
  type PanelSourceState,
  type PanelSourceStats,
  type PanelStats,
} from '@mcs/shared';

import type { InstanceContext } from '../runtime/context.ts';
import type { AttemptsTickResult, IngestWriter, PanelService } from '../runtime/instance-runtime.ts';
import { specFor } from './constants.ts';
import { createFilesSampler, type FilesSampler } from './files.ts';
import { createGitSampler, type GitSampler } from './git.ts';
import { createMachineSampler, type MachineSampler } from './machine.ts';
import { SourceCache, panelStatus, sourceState, type CacheRead, type PanelSample } from './source-cache.ts';
import { closeAttemptsState, createAttemptsState, tickAttempts, type AttemptsLimits } from './attempts/ingest.ts';
import { readAttemptsPanel } from './attempts/repo.ts';

/** The `limit` of the attempts panel when the request names none (06 3.4). */
export const ATTEMPTS_DEFAULT_LIMIT = 30;
/** The largest `limit` of the attempts panel (06 3.4). */
export const ATTEMPTS_MAX_LIMIT = 200;
/** Attempts caches kept at once, one per requested `limit`; the least recently used one is dropped. */
const ATTEMPTS_CACHES_MAX = 8;

/** The result of a tick once the service is closed, or when it was never asked to do anything. */
const IDLE_TICK: AttemptsTickResult = { state: 'not_configured', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 };

/** `get` after `close()`: the route maps it to 503 `shutting_down`. Recognised by its name, like the other engine errors. */
export class PanelServiceClosedError extends McsError {
  constructor() {
    super('INTERNAL', 'the panel service is closed');
    this.name = 'PanelServiceClosedError';
  }
}

/** What the service reads of the instance context (`InstanceContext` satisfies it; tests build a small object). */
export type PanelServiceContext = Pick<
  InstanceContext,
  'repoDir' | 'clock' | 'db' | 'scope' | 'logger' | 'errors' | 'exec' | 'config' | 'queries'
>;

/** The samplers behind the panels; the defaults are built from the configuration (tests replace them one by one). */
export interface PanelSamplers {
  readonly git: Pick<GitSampler, 'read' | 'abort' | 'stats'>;
  readonly machine: Pick<MachineSampler, 'read' | 'abort' | 'stats'>;
  readonly files: Pick<FilesSampler, 'ledger' | 'chainLog' | 'logs' | 'abort' | 'stats'>;
}

export interface PanelServiceOptions {
  /** The one writer of the ingest service: the attempts evidence goes through it (N-01). */
  readonly writer: IngestWriter;
  /** Test seam: replaces the samplers one by one. */
  readonly samplers?: Partial<PanelSamplers>;
  /** Test seam: smaller slices for the attempts tick. */
  readonly attemptsLimits?: Partial<AttemptsLimits>;
}

function mergeStats(parts: readonly PanelSourceStats[], base: PanelSourceStats | null): PanelSourceStats | null {
  const all = base === null ? parts : [base, ...parts];
  const last = all.at(-1);
  if (last === undefined) return null;
  return {
    refreshes: all.reduce((sum, s) => sum + s.refreshes, 0),
    failures: all.reduce((sum, s) => sum + s.failures, 0),
    lastDurationMs: last.lastDurationMs,
    lastStatus: last.lastStatus,
  };
}

function createSamplers(ctx: PanelServiceContext, given: Partial<PanelSamplers> | undefined): PanelSamplers {
  const { monitor, runtime } = ctx.config;
  return {
    git:
      given?.git ??
      createGitSampler({
        repoDir: ctx.repoDir,
        stopFile: monitor.stop_file,
        clock: ctx.clock,
        errors: ctx.errors,
        exec: ctx.exec,
      }),
    machine:
      given?.machine ??
      createMachineSampler({
        clock: ctx.clock,
        errors: ctx.errors,
        exec: ctx.exec,
        watchedProcesses: monitor.watched_processes,
        docker: monitor.docker,
        processIntervalMs: runtime.panelOptions.machineProcessIntervalMs,
      }),
    files:
      given?.files ??
      createFilesSampler({
        repoDir: ctx.repoDir,
        ledger: monitor.ledger,
        chainLog: monitor.chain_log,
        stopFile: monitor.stop_file,
        liveLogGlobs: monitor.live_log_globs,
        clock: ctx.clock,
        errors: ctx.errors,
      }),
  };
}

export function createPanelService(ctx: PanelServiceContext, options: PanelServiceOptions): PanelService {
  const { clock } = ctx;
  const samplers = createSamplers(ctx, options.samplers);
  let closed = false;

  // ---- the attempts tick (06 3.10) ---------------------------------------------------------------------------------------

  const attemptsState = createAttemptsState();
  let tickInFlight: Promise<AttemptsTickResult> | null = null;
  /** What the last tick said about the chain log; `undefined` until the first tick finished. */
  let lastTickState: AttemptsPanel['sourceState'] | undefined;

  function tick(): Promise<AttemptsTickResult> {
    if (closed) return Promise.resolve(IDLE_TICK);
    if (tickInFlight !== null) return tickInFlight;
    const current = tickAttempts(ctx, {
      writer: options.writer,
      state: attemptsState,
      ...(options.attemptsLimits === undefined ? {} : { limits: options.attemptsLimits }),
    })
      .then((result) => {
        lastTickState = result.state;
        return result;
      })
      .finally(() => {
        tickInFlight = null;
      });
    tickInFlight = current;
    return current;
  }

  // ---- the attempts panel: one cache per requested limit -----------------------------------------------------------------

  const attemptsCaches = new Map<number, SourceCache<AttemptsPanel>>();
  /** The counters of the caches that were dropped, so that the statistics do not go back. */
  let retiredAttempts: PanelSourceStats | null = null;

  function attemptsCache(limit: number): SourceCache<AttemptsPanel> {
    const known = attemptsCaches.get(limit);
    if (known !== undefined) {
      attemptsCaches.delete(limit);
      attemptsCaches.set(limit, known); // most recently used last
      return known;
    }
    const created = new SourceCache<AttemptsPanel>(
      specFor<AttemptsPanel>('attempts', () => Promise.resolve({ status: 'ok', value: readAttemptsPanel(ctx, limit) })),
      clock,
      ctx.errors,
    );
    attemptsCaches.set(limit, created);
    if (attemptsCaches.size > ATTEMPTS_CACHES_MAX) {
      const oldest = [...attemptsCaches][0];
      if (oldest !== undefined) {
        // no abort: a load of the attempts is one synchronous query, there is nothing to cancel
        retiredAttempts = mergeStats([oldest[1].stats()], retiredAttempts);
        attemptsCaches.delete(oldest[0]);
      }
    }
    return created;
  }

  /** The state of the `attempts` source: the cache read, refined by what the last tick said about the chain log. */
  function attemptsSource(read: CacheRead<AttemptsPanel>, state: AttemptsPanel['sourceState']): PanelSourceState {
    if (read.value === null || read.status !== 'ok') return sourceState('attempts', read);
    switch (state) {
      case 'ok':
        return sourceState('attempts', read);
      case 'not_configured':
        return sourceState('attempts', {
          ...read,
          status: 'disabled',
          message: 'attempts and chain_log are not both configured',
        });
      case 'missing':
        return sourceState('attempts', {
          ...read,
          status: 'unavailable',
          message: 'the chain log file is missing; the stored rows are shown',
        });
      case 'error':
        return sourceState('attempts', { ...read, status: 'error', message: 'the chain log could not be read' });
    }
  }

  async function attemptsSample(limit: number): Promise<PanelSample<AttemptsPanel>> {
    const read = await attemptsCache(limit).read();
    const cached = read.value;
    const data =
      cached === null ? null : lastTickState === undefined ? cached : { ...cached, sourceState: lastTickState };
    return { data, sources: [attemptsSource(read, data?.sourceState ?? 'ok')] };
  }

  // ---- the response ------------------------------------------------------------------------------------------------------

  /** The members of the envelope that every panel shares. */
  function envelope(sample: PanelSample<unknown>): Pick<PanelResponse, 'status' | 'generatedAt' | 'sources'> {
    return {
      status: panelStatus(sample.sources, sample.data !== null),
      generatedAt: isoMsZ(clock.now()),
      sources: sample.sources,
    };
  }

  function limitOf(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested)) return ATTEMPTS_DEFAULT_LIMIT;
    return Math.min(ATTEMPTS_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
  }

  /** One maker per key, each with a literal key: the response of a key has the data type of that key. */
  const makers: { [K in PanelKey]: (limit: number) => Promise<PanelResponse<K>> } = {
    git: async () => {
      const sample = await samplers.git.read();
      return { key: 'git', ...envelope(sample), data: sample.data };
    },
    machine: async () => {
      const sample = await samplers.machine.read();
      return { key: 'machine', ...envelope(sample), data: sample.data };
    },
    ledger: async () => {
      const sample = await samplers.files.ledger();
      return { key: 'ledger', ...envelope(sample), data: sample.data };
    },
    chainLog: async () => {
      const sample = await samplers.files.chainLog();
      return { key: 'chainLog', ...envelope(sample), data: sample.data };
    },
    logs: async () => {
      const sample = await samplers.files.logs();
      return { key: 'logs', ...envelope(sample), data: sample.data };
    },
    attempts: async (limit) => {
      const sample = await attemptsSample(limit);
      return { key: 'attempts', ...envelope(sample), data: sample.data };
    },
  };

  return {
    get<K extends PanelKey>(key: K, opts?: { limit?: number }): Promise<PanelResponse<K>> {
      if (closed) return Promise.reject(new PanelServiceClosedError());
      return makers[key](limitOf(opts?.limit));
    },

    tickAttempts: tick,

    stats(): PanelStats {
      const out: PanelStats = {
        ...samplers.git.stats(),
        ...samplers.machine.stats(),
        ...samplers.files.stats(),
      };
      const attempts = mergeStats(
        [...attemptsCaches.values()].map((cache) => cache.stats()).filter((s) => s.refreshes > 0),
        retiredAttempts,
      );
      if (attempts !== null && attempts.refreshes > 0) out.attempts = attempts;
      return out;
    },

    close(): void {
      if (closed) return;
      closed = true;
      samplers.git.abort();
      samplers.machine.abort();
      samplers.files.abort();
      for (const cache of attemptsCaches.values()) cache.abort();
      closeAttemptsState(attemptsState);
    },
  };
}
