// The panel service with fake samplers (06 3.4, 3.11): the response of each key, its status, the time of the response, the `limit`
// that reaches the attempts only, the serialized attempts tick, the statistics and the shutdown. The attempts run over a real
// database and a chain log in a temp folder (the harness of the attempts tests); the other five panels are fed by fakes.
import { rmSync } from 'node:fs';

import { PanelResponseSchema, isoMsZ, type PanelKey, type PanelSourceState, type PanelStats } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  BASE_MS,
  endLine,
  startLine,
  stubWriter,
  uid,
  useAttemptsHarness,
  type AttemptsHarness,
} from '../../test/fixtures/attempts-harness.ts';
import { createErrorRing } from '../runtime/error-ring.ts';
import type { IngestWriter } from '../runtime/instance-runtime.ts';
import {
  PanelServiceClosedError,
  createPanelService,
  type PanelSamplers,
  type PanelServiceContext,
} from './service.ts';
import type { PanelSample } from './source-cache.ts';

const harness = useAttemptsHarness();

const OK = (source: PanelSourceState['source'], at = BASE_MS): PanelSourceState => ({
  source,
  status: 'ok',
  sampledAt: isoMsZ(at),
  message: null,
});

const GIT = {
  branch: 'main',
  dirty: 0,
  stopFile: false,
  commits: [],
  headOid: null,
  detached: false,
  repoState: 'ok' as const,
};
const LINES = { lines: ['| a |'], file: 'ledger.md', exists: true, sizeBytes: 5, modifiedAt: isoMsZ(BASE_MS) };
const MACHINE = {
  sampledAt: isoMsZ(BASE_MS),
  freeGb: 1,
  totalGb: 2,
  usedPct: 50,
  cpuPct: null,
  procs: [],
  docker: [],
  platform: 'linux' as const,
  procsSampledAt: null,
  procsStatus: 'disabled' as const,
  dockerEnabled: false,
  dockerSampledAt: null,
  dockerStatus: 'disabled' as const,
};
const LOGS = { files: [], matchedFiles: 0 };

interface Fakes {
  readonly samplers: PanelSamplers;
  /** How often each fake was read. */
  readonly reads: Record<string, number>;
  readonly aborts: string[];
  /** The next sample of a key; set to change what the fake answers. */
  readonly next: Record<string, PanelSample<unknown>>;
  stats: PanelStats;
}

function fakes(): Fakes {
  const reads: Record<string, number> = {};
  const aborts: string[] = [];
  const next: Record<string, PanelSample<unknown>> = {
    git: { data: GIT, sources: [OK('git.status'), OK('git.log'), OK('stopFile')] },
    machine: { data: MACHINE, sources: [OK('memory'), OK('cpu')] },
    ledger: { data: LINES, sources: [OK('ledger')] },
    chainLog: { data: LINES, sources: [OK('chainLog')] },
    logs: { data: LOGS, sources: [OK('logs')] },
  };
  const state = { stats: {} as PanelStats };
  const read = (name: string) => (): Promise<never> => {
    reads[name] = (reads[name] ?? 0) + 1;
    return Promise.resolve(next[name] as never);
  };
  const result: Fakes = {
    reads,
    aborts,
    next,
    get stats() {
      return state.stats;
    },
    set stats(value) {
      state.stats = value;
    },
    samplers: {
      git: { read: read('git'), abort: () => aborts.push('git'), stats: () => state.stats },
      machine: { read: read('machine'), abort: () => aborts.push('machine'), stats: () => ({}) },
      files: {
        ledger: read('ledger'),
        chainLog: read('chainLog'),
        logs: read('logs'),
        abort: () => aborts.push('files'),
        stats: () => ({}),
      },
    },
  };
  return result;
}

interface Built {
  readonly h: AttemptsHarness;
  readonly f: Fakes;
  readonly writer: ReturnType<typeof stubWriter>;
  readonly service: ReturnType<typeof createPanelService>;
}

function build(over: { chainLog?: string | null; samplers?: (f: Fakes) => Partial<PanelSamplers> } = {}): Built {
  const h = harness();
  const f = fakes();
  const writer = stubWriter();
  const base = h.context();
  const ctx = {
    ...base,
    errors: createErrorRing(h.clock),
    queries: { sessionSummaries: () => [] },
    config: {
      ...base.config,
      monitor: { ...base.config.monitor, ...(over.chainLog === undefined ? {} : { chain_log: over.chainLog }) },
    },
  } as unknown as PanelServiceContext;
  const service = createPanelService(ctx, {
    writer: writer as unknown as IngestWriter,
    samplers: { ...f.samplers, ...over.samplers?.(f) },
  });
  return { h, f, writer, service };
}

const SIX_KEYS: PanelKey[] = ['git', 'machine', 'attempts', 'ledger', 'chainLog', 'logs'];

describe('get: the response of each key', () => {
  it('answers a body that parses with PanelResponseSchema for each of the six keys', async () => {
    const { service } = build();
    for (const key of SIX_KEYS) {
      const response = await service.get(key);
      expect(response.key).toBe(key);
      expect(response.status, key).toBe('ok');
      expect(PanelResponseSchema.safeParse(response).success, key).toBe(true);
    }
  });

  it('takes generatedAt from the clock, not from the time of the sources', async () => {
    const { service, h } = build();
    h.clock.advance(5000);
    const response = await service.get('git');
    expect(response.generatedAt).toBe(isoMsZ(BASE_MS + 5000));
    expect(response.sources[0]?.sampledAt).toBe(isoMsZ(BASE_MS));
  });

  it('is partial when a source is pending, unavailable or in error but data is there', async () => {
    const { service, f } = build();
    for (const status of ['pending', 'unavailable', 'unsupported', 'error'] as const) {
      f.next['git'] = {
        data: GIT,
        sources: [OK('git.status'), { source: 'git.log', status, sampledAt: null, message: 'x' }],
      };
      expect((await service.get('git')).status, status).toBe('partial');
    }
  });

  it('is ok when the other sources are disabled', async () => {
    const { service, f } = build();
    f.next['machine'] = {
      data: MACHINE,
      sources: [OK('memory'), { source: 'docker', status: 'disabled', sampledAt: null, message: null }],
    };
    expect((await service.get('machine')).status).toBe('ok');
  });

  it('is error with data null when no source produced data', async () => {
    const { service, f } = build();
    f.next['logs'] = {
      data: null,
      sources: [{ source: 'logs', status: 'error', sampledAt: null, message: 'the logs could not be read' }],
    };
    const response = await service.get('logs');
    expect(response).toMatchObject({ key: 'logs', status: 'error', data: null });
    expect(response.sources).toHaveLength(1);
  });

  it('reads only the sampler of the key that was asked for', async () => {
    const { service, f } = build();
    await service.get('ledger');
    await service.get('ledger');
    expect(f.reads).toEqual({ ledger: 2 });
  });
});

describe('get: the limit', () => {
  function threeRuns(h: AttemptsHarness): void {
    h.writeLog(
      [startLine(BASE_MS, 'A'), startLine(BASE_MS + 1000, 'B'), startLine(BASE_MS + 2000, 'C'), ''].join('\n'),
    );
  }

  it('reaches the attempts only: the default is 30, a smaller one cuts to the newest rows, 200 is the ceiling', async () => {
    const { service, h } = build();
    threeRuns(h);
    await service.tickAttempts();
    const all = await service.get('attempts');
    expect(all.data?.rows.map((r) => r.part)).toEqual(['A', 'B', 'C']);
    h.clock.advance(5000);
    const two = await service.get('attempts', { limit: 2 });
    expect(two.data?.rows.map((r) => r.part)).toEqual(['B', 'C']);
    h.clock.advance(5000);
    const wild = await service.get('attempts', { limit: 100_000 });
    expect(wild.data?.rows).toHaveLength(3);
    h.clock.advance(5000);
    const zero = await service.get('attempts', { limit: 0 });
    expect(zero.data?.rows).toHaveLength(1);
  });

  it('is ignored by the other keys', async () => {
    const { service } = build();
    for (const key of ['git', 'machine', 'ledger', 'chainLog', 'logs'] as const) {
      const response = await service.get(key, { limit: 1 });
      expect(response.status, key).toBe('ok');
    }
  });

  it('serves two requests inside the ttl from one read of the table, per limit', async () => {
    const { service, h } = build();
    threeRuns(h);
    await service.tickAttempts();
    await Promise.all(Array.from({ length: 50 }, () => service.get('attempts')));
    expect(service.stats().attempts?.refreshes).toBe(1);
    await service.get('attempts', { limit: 2 });
    expect(service.stats().attempts?.refreshes).toBe(2);
    h.clock.advance(2001);
    await service.get('attempts');
    expect(service.stats().attempts?.refreshes).toBe(3);
  });
});

describe('the attempts source', () => {
  it('shows what the last tick said about the chain log', async () => {
    const { service, h } = build();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n`);
    const before = await service.get('attempts');
    expect(before.data?.sourceState).toBe('ok');
    expect(before.sources).toEqual([expect.objectContaining({ source: 'attempts', status: 'ok' })]);

    await service.tickAttempts();
    h.clock.advance(3000);
    expect((await service.get('attempts')).data?.sourceState).toBe('ok');

    // the file disappears: the stored rows stay, the source is unavailable and the panel is partial
    rmSync(h.logFile);
    await service.tickAttempts();
    h.clock.advance(3000);
    const missing = await service.get('attempts');
    expect(missing.data?.sourceState).toBe('missing');
    expect(missing.data?.rows.map((r) => r.part)).toEqual(['A']);
    expect(missing.sources[0]).toMatchObject({ source: 'attempts', status: 'unavailable' });
    expect(missing.status).toBe('partial');
  });

  it('is disabled, with the panel still ok and no rows, when the chain log is not configured', async () => {
    const { service } = build({ chainLog: null });
    expect(await service.tickAttempts()).toEqual({
      state: 'not_configured',
      linesRead: 0,
      rowsChanged: 0,
      eventsSubmitted: 0,
    });
    const response = await service.get('attempts');
    expect(response.data).toEqual({ rows: [], sourceState: 'not_configured' });
    expect(response.sources[0]).toMatchObject({ source: 'attempts', status: 'disabled' });
    expect(response.status).toBe('ok');
  });
});

describe('tickAttempts', () => {
  it('returns the same promise while a tick runs, so that one ingestion happens', async () => {
    const { service, h } = build();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${endLine(BASE_MS + 1000, 'A', 0, 'PASS')}\n`);
    const first = service.tickAttempts();
    const second = service.tickAttempts();
    expect(second).toBe(first);
    const result = await first;
    expect(result).toMatchObject({ state: 'ok', linesRead: 2 });
    // the next call starts a new tick, which finds nothing new
    const third = service.tickAttempts();
    expect(third).not.toBe(first);
    expect(await third).toMatchObject({ state: 'ok', linesRead: 0, rowsChanged: 0 });
  });

  it('rejects for a database failure and allows the next tick', async () => {
    const { service, h } = build();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n`);
    h.db.close();
    await expect(service.tickAttempts()).rejects.toBeDefined();
    // the serializer is free again: a second call is a new tick, not the failed one
    await expect(service.tickAttempts()).rejects.toBeDefined();
  });
});

describe('stats', () => {
  it('lists only the sources that were read, merged from the samplers and the attempts', async () => {
    const { service, f, h } = build();
    expect(service.stats()).toEqual({});
    f.stats = { 'git.status': { refreshes: 2, failures: 1, lastDurationMs: 7, lastStatus: 'ok' } };
    expect(service.stats()).toEqual({
      'git.status': { refreshes: 2, failures: 1, lastDurationMs: 7, lastStatus: 'ok' },
    });
    h.writeLog(`${startLine(BASE_MS, 'A')}\n`);
    await service.tickAttempts();
    await service.get('attempts');
    expect(Object.keys(service.stats()).sort()).toEqual(['attempts', 'git.status']);
    expect(service.stats().attempts).toMatchObject({ refreshes: 1, failures: 0, lastStatus: 'ok' });
  });

  it('keeps the counters of an attempts cache that was dropped', async () => {
    const { service, h } = build();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n`);
    await service.tickAttempts();
    for (let limit = 1; limit <= 12; limit += 1) await service.get('attempts', { limit });
    expect(service.stats().attempts?.refreshes).toBe(12);
  });
});

describe('close', () => {
  it('aborts what is running in every sampler and refuses later requests', async () => {
    const { service, f } = build();
    service.close();
    expect(f.aborts.sort()).toEqual(['files', 'git', 'machine']);
    await expect(service.get('git')).rejects.toBeInstanceOf(PanelServiceClosedError);
    await expect(service.get('attempts')).rejects.toMatchObject({ name: 'PanelServiceClosedError' });
    // closing twice does no harm and tickAttempts answers without work
    service.close();
    expect(f.aborts).toHaveLength(3);
    expect(await service.tickAttempts()).toEqual({
      state: 'not_configured',
      linesRead: 0,
      rowsChanged: 0,
      eventsSubmitted: 0,
    });
  });

  it('drops a batch of evidence that the writer did not accept', async () => {
    const { service, h, writer } = build();
    h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 500 });
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${endLine(BASE_MS + 1000, 'A', 0, 'PASS')}\n`);
    writer.accept = false;
    const result = await service.tickAttempts();
    expect(result.state).toBe('ok');
    expect(writer.calls.filter((c) => !c.accepted)).toHaveLength(1);
    service.close();
    writer.accept = true;
    writer.fireDrain();
    // nothing is offered again after the close
    expect(writer.calls).toHaveLength(1);
  });

  it('lets a request that is in flight finish without an error', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, f } = build({
      samplers: (fake) => ({
        git: {
          ...fake.samplers.git,
          read: async () => {
            await gate;
            return fake.next['git'] as never;
          },
        },
      }),
    });
    const pending = service.get('git');
    service.close();
    expect(f.aborts).toContain('git');
    release();
    await expect(pending).resolves.toMatchObject({ key: 'git', status: 'ok' });
  });
});
