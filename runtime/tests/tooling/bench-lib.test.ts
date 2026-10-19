// The benchmark library `bench/lib/*.mjs` (WP-68): statistics, the budget verdicts (PASS, FAIL, NOT MEASURED), the target check
// (missing launcher, stale bundle), and the instance helpers against a stub launcher that starts a real listener on a port of
// 18900-18949 (stopped when the measured callback throws, killed by pid when `stop` does nothing, reaped after a killed run).
// The modules are plain `.mjs`: they are loaded with a dynamic import and their exports are narrowed here, no declarations exist.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertPortClosed, hermeticEnv, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

const BENCH_LIB = resolve(import.meta.dirname, '..', '..', 'bench', 'lib');

interface Check {
  name: string;
  figure: number | null;
  limit: number;
  unit: string;
  ok: boolean | null;
}
interface Row {
  id: string;
  status: 'PASS' | 'FAIL' | 'NOT MEASURED';
  checks: Check[];
  note: string | null;
}
interface Host {
  platform: string;
  cpus: number;
  node: string;
}
interface Summary {
  asserted: boolean;
  rows: Row[];
  failed: string[];
  deviations: string[];
  exitCode: number;
}
interface StatsModule {
  percentile(samples: number[], p: number): number | null;
  median(samples: number[]): number | null;
  p95(samples: number[]): number | null;
  summarizeSamples(samples: number[]): { n: number; p50: number | null; p95: number | null; max: number | null };
  evaluateB4(runs: Record<string, number | null>[]): Row;
  evaluateB5(input: {
    idle: Record<string, { p95: number | null }>;
    during: { all: { p95: number | null }; note?: string | null };
  }): Row;
  evaluateB6(figures: number[]): Row;
  summarize(rows: Row[], host: Host, ids?: string[]): Summary;
}
interface TargetModule {
  TargetError: new (message: string) => Error;
  resolveTarget(opts: { launcher?: string }): Promise<{ launcher: string; version: Record<string, unknown> }>;
  parseVersionAnswer(stdout: string): Record<string, unknown>;
  describeHost(target: { launcher: string; version: Record<string, unknown> }): Record<string, unknown>;
  utcStamp(date: Date): string;
}
interface Started {
  port: number;
  healthyMs: number;
  stop(): Promise<void>;
}
interface StartOptions {
  launcher: string;
  root: string;
  repo: string;
  slug: string;
  port: number;
  env: Record<string, string>;
  stateDir: string;
  stopGraceMs: number;
}
interface InstanceModule {
  BENCH_PORTS: readonly [number, number];
  allocateBenchPort(): Promise<number>;
  releasePort(port: number): Promise<void>;
  portClosed(port: number): Promise<boolean>;
  startInstance(opts: StartOptions): Promise<Started>;
  withInstance<T>(opts: StartOptions, measured: (instance: Started) => Promise<T>): Promise<T>;
  reapStale(opts: {
    stateDir: string;
    envFor: (root: string) => Record<string, string>;
    stopGraceMs: number;
  }): Promise<{ reaped: number[]; stuck: number[] }>;
}

const stats = (await import(pathToFileURL(join(BENCH_LIB, 'stats.mjs')).href)) as StatsModule;
const target = (await import(pathToFileURL(join(BENCH_LIB, 'target.mjs')).href)) as TargetModule;
const instance = (await import(pathToFileURL(join(BENCH_LIB, 'instance.mjs')).href)) as InstanceModule;

const makeTemp = useTempDirs();
const REFERENCE: Host = { platform: 'win32', cpus: 12, node: '24.14.1' };
const OTHER: Host = { platform: 'linux', cpus: 4, node: '22.22.0' };

describe('statistics', () => {
  it('percentile is the nearest rank and ignores non-finite samples', () => {
    const samples = [15, 20, 35, 40, 50];
    expect(stats.percentile(samples, 0)).toBe(15);
    expect(stats.percentile(samples, 30)).toBe(20);
    expect(stats.percentile(samples, 40)).toBe(20);
    expect(stats.percentile(samples, 50)).toBe(35);
    expect(stats.percentile(samples, 100)).toBe(50);
    expect(stats.percentile([3, Number.NaN, 1, 2], 100)).toBe(3);
    expect(stats.percentile([], 50)).toBeNull();
    expect(() => stats.percentile(samples, 101)).toThrow(RangeError);
  });

  it('p95 of 1..100 is 95 and of 20 samples is the 19th', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(stats.p95(hundred)).toBe(95);
    expect(stats.p95(hundred.slice(0, 20).toReversed())).toBe(19);
  });

  it('median takes the middle, or the mean of the two middle values', () => {
    expect(stats.median([9, 1, 5])).toBe(5);
    expect(stats.median([4, 1, 3, 2])).toBe(2.5);
    expect(stats.median([])).toBeNull();
  });

  it('summarizeSamples reports n, p50, p95 and max', () => {
    const summary = stats.summarizeSamples([5, 1, 3, 2, 4]);
    expect(summary).toMatchObject({ n: 5, p50: 3, p95: 5, max: 5 });
    expect(stats.summarizeSamples([])).toMatchObject({ n: 0, p50: null, max: null });
  });
});

describe('budget verdicts', () => {
  const B4_OK = { wallMs: 6000, eventLoopP99MaxMs: 30, rssPeakBytes: 300e6, rssIdleBytes: 120e6 };

  it('B4 passes inside the three limits and judges the worst run', () => {
    expect(stats.evaluateB4([B4_OK]).status).toBe('PASS');
    const slow = stats.evaluateB4([B4_OK, { ...B4_OK, wallMs: 8500 }]);
    expect(slow.status).toBe('FAIL');
    expect(slow.checks.find((c) => c.ok === false)).toMatchObject({ figure: 8500, limit: 8000 });
    expect(stats.evaluateB4([{ ...B4_OK, eventLoopP99MaxMs: 51 }]).status).toBe('FAIL');
    expect(stats.evaluateB4([{ ...B4_OK, rssPeakBytes: 340e6 }]).status).toBe('FAIL');
  });

  it('B4 without a run, or without an RSS reading, is NOT MEASURED and never PASS', () => {
    expect(stats.evaluateB4([]).status).toBe('NOT MEASURED');
    expect(stats.evaluateB4([{ ...B4_OK, rssIdleBytes: null }]).status).toBe('NOT MEASURED');
  });

  const IDLE_OK = {
    sessions: { p95: 20 },
    transcript: { p95: 10 },
    'panel:ledger': { p95: 5 },
    'panel:git': { p95: null },
  };

  it('B5 needs the sessions page, the transcript page and a panel at 50 ms idle and 250 ms during the import', () => {
    expect(stats.evaluateB5({ idle: IDLE_OK, during: { all: { p95: 240 } } }).status).toBe('PASS');
    const slowIdle = stats.evaluateB5({ idle: { ...IDLE_OK, sessions: { p95: 51 } }, during: { all: { p95: 10 } } });
    expect(slowIdle.status).toBe('FAIL');
    expect(slowIdle.checks.find((c) => c.ok === false)?.figure).toBe(51);
    expect(stats.evaluateB5({ idle: IDLE_OK, during: { all: { p95: 251 } } }).status).toBe('FAIL');
  });

  it('B5 without any panel (no panels route) is NOT MEASURED, unless another endpoint fails', () => {
    const noPanel = { sessions: IDLE_OK.sessions, transcript: IDLE_OK.transcript };
    const missing = stats.evaluateB5({ idle: noPanel, during: { all: { p95: 10 } } });
    expect(missing.status).toBe('NOT MEASURED');
    expect(missing.note).toContain('no panel');
    const failing = stats.evaluateB5({ idle: { ...noPanel, sessions: { p95: 80 } }, during: { all: { p95: 10 } } });
    expect(failing.status).toBe('FAIL');
  });

  it('B5 with too few requests during the import is NOT MEASURED', () => {
    const row = stats.evaluateB5({ idle: IDLE_OK, during: { all: { p95: null }, note: 'only 3 requests completed' } });
    expect(row.status).toBe('NOT MEASURED');
    expect(row.note).toContain('only 3 requests');
  });

  it('B6 judges the worst start against 3 s', () => {
    expect(stats.evaluateB6([900, 2900]).status).toBe('PASS');
    expect(stats.evaluateB6([900, 3100]).status).toBe('FAIL');
    expect(stats.evaluateB6([]).status).toBe('NOT MEASURED');
  });

  it('the summary has one row per budget B1..B7 and exits 1 only for a FAIL on the reference host', () => {
    const rows = [stats.evaluateB6([900]), stats.evaluateB4([{ ...B4_OK, wallMs: 9000 }])];
    const summary = stats.summarize(rows, REFERENCE);
    expect(summary.rows.map((r) => r.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
    expect(summary.rows.map((r) => r.status)).toEqual([
      'NOT MEASURED',
      'NOT MEASURED',
      'NOT MEASURED',
      'FAIL',
      'NOT MEASURED',
      'PASS',
      'NOT MEASURED',
    ]);
    expect(summary).toMatchObject({ asserted: true, failed: ['B4'], deviations: [], exitCode: 1 });
    expect(stats.summarize([stats.evaluateB6([900])], REFERENCE).exitCode).toBe(0);
  });

  it('on another host class the figures stay but the budgets are not asserted', () => {
    const rows = [stats.evaluateB4([{ ...B4_OK, wallMs: 9000 }])];
    const summary = stats.summarize(rows, OTHER);
    expect(summary).toMatchObject({ asserted: false, failed: ['B4'], deviations: ['B4'], exitCode: 0 });
    expect(summary.rows[3]?.status).toBe('FAIL');
    expect(stats.summarize(rows, { ...REFERENCE, cpus: 8 }).asserted).toBe(false);
    expect(stats.summarize(rows, { ...REFERENCE, node: '22.22.0' }).asserted).toBe(false);
  });

  it('a script summary can be narrowed to its own budget', () => {
    const summary = stats.summarize([stats.evaluateB6([900])], REFERENCE, ['B6']);
    expect(summary.rows.map((r) => r.id)).toEqual(['B6']);
  });
});

/** A launcher script that answers `version --json` with `answer` (an object, or raw text). */
function writeVersionStub(dir: string, answer: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'mcs.mjs');
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  writeFileSync(file, `process.stdout.write(${JSON.stringify(text)});\n`);
  return file;
}

const VERSION_DATA = {
  runtimeVersion: '4.0.0',
  codeStamp: 'abcdef0123',
  buildCurrent: true,
  node: '24.14.1',
  platform: 'win32',
  arch: 'x64',
};

describe('target', () => {
  it('refuses a launcher that does not exist', async () => {
    const dir = makeTemp('bench-target').path;
    await expect(target.resolveTarget({ launcher: join(dir, 'missing', 'mcs.mjs') })).rejects.toThrow(
      /launcher not found/,
    );
  });

  it('refuses an answer whose buildCurrent is false (a stale bundle)', async () => {
    const dir = makeTemp('bench-target').path;
    const launcher = writeVersionStub(dir, { ok: true, data: { ...VERSION_DATA, buildCurrent: false } });
    await expect(target.resolveTarget({ launcher })).rejects.toThrow(/not current/);
  });

  it('refuses output that is not the version document, and a failing launcher', async () => {
    const dir = makeTemp('bench-target').path;
    await expect(target.resolveTarget({ launcher: writeVersionStub(dir, 'not json') })).rejects.toThrow(
      /JSON document/,
    );
    const failing = join(dir, 'fail.mjs');
    writeFileSync(failing, 'process.stderr.write("ERROR: no runtime\\n"); process.exitCode = 1;\n');
    await expect(target.resolveTarget({ launcher: failing })).rejects.toThrow(/exit 1/);
    expect(() => target.parseVersionAnswer(JSON.stringify({ ok: false, data: null }))).toThrow(target.TargetError);
  });

  it('accepts a current build and records node, platform, arch, stamp and CPU count', async () => {
    const dir = makeTemp('bench-target').path;
    const launcher = writeVersionStub(dir, { ok: true, data: VERSION_DATA });
    const resolved = await target.resolveTarget({ launcher });
    const host = target.describeHost(resolved);
    expect(host).toMatchObject({ node: '24.14.1', platform: 'win32', arch: 'x64', codeStamp: 'abcdef0123' });
    expect(host['cpus']).toBeGreaterThan(0);
    expect(host['launcher']).toBe('<custom launcher>');
  });

  it('uses an unknown build state (null) as recorded, not as stale', () => {
    expect(
      target.parseVersionAnswer(JSON.stringify({ ok: true, data: { ...VERSION_DATA, buildCurrent: null } })),
    ).toMatchObject({
      buildCurrent: null,
    });
  });

  it('stamps result files in UTC', () => {
    expect(target.utcStamp(new Date('2026-10-20T10:15:30.456Z'))).toBe('20261020T101530Z');
  });
});

// A stub of the real launcher for `start` and `stop`: `start` runs a detached listener on --port that answers 200, and records
// its pid in state.json of the task, like the real runtime; `stop` kills that pid unless STUB_IGNORE_STOP is set; STUB_FAIL_START
// makes `start` exit 1.
const INSTANCE_STUB = `
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const opt = (name) => argv[argv.indexOf(name) + 1];
const dir = join(opt('--repo'), '.claude', 'monitor', 'tasks', opt('--task'));
const stateFile = join(dir, 'state.json');
if (argv[0] === 'start') {
  if (process.env.STUB_FAIL_START === '1') {
    process.stderr.write('ERROR: stub start failed\\n');
    process.exit(1);
  }
  const code = 'require("node:http").createServer((q,r)=>{r.writeHead(200,{"content-type":"application/json"});r.end("{}")}).listen(' + Number(opt('--port')) + ',"127.0.0.1")';
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid }));
} else if (argv[0] === 'stop' && process.env.STUB_IGNORE_STOP !== '1') {
  try {
    process.kill(JSON.parse(readFileSync(stateFile, 'utf8')).pid);
  } catch {}
}
`;

interface Rig {
  opts: StartOptions;
  stateDir: string;
  repo: string;
}

async function rig(extraEnv: Record<string, string> = {}): Promise<Rig> {
  const root = makeTemp('bench-inst').path;
  const repo = join(root, 'repo');
  const stateDir = join(root, 'state');
  mkdirSync(repo, { recursive: true });
  const launcher = join(root, 'stub.mjs');
  writeFileSync(launcher, INSTANCE_STUB);
  const port = await instance.allocateBenchPort();
  return {
    stateDir,
    repo,
    opts: {
      launcher,
      root,
      repo,
      slug: 'bench',
      port,
      env: { ...hermeticEnv(root), ...extraEnv },
      stateDir,
      stopGraceMs: 300,
    },
  };
}

const liveFile = (stateDir: string): string => join(stateDir, '.live.json');

describe('instances', () => {
  it('allocates ports inside 18900-18949 only', async () => {
    const ports: number[] = [];
    try {
      for (let i = 0; i < 3; i += 1) ports.push(await instance.allocateBenchPort());
    } finally {
      for (const port of ports) await instance.releasePort(port);
    }
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(instance.BENCH_PORTS[0]);
      expect(port).toBeLessThanOrEqual(instance.BENCH_PORTS[1]);
    }
    expect(instance.BENCH_PORTS).toEqual([18900, 18949]);
  });

  it('starts through the launcher, waits for health and stops with the port closed', async () => {
    const { opts, stateDir } = await rig();
    const started = await instance.startInstance(opts);
    expect(await instance.portClosed(opts.port)).toBe(false);
    expect(started.healthyMs).toBeGreaterThan(0);
    expect(existsSync(liveFile(stateDir))).toBe(true);
    await started.stop();
    await started.stop();
    expect(await instance.portClosed(opts.port)).toBe(true);
    expect(existsSync(liveFile(stateDir))).toBe(false);
    await assertPortClosed(opts.port);
  });

  it('stops what it started when the measured callback throws', async () => {
    const { opts, stateDir } = await rig();
    await expect(
      instance.withInstance(opts, async () => {
        expect(await instance.portClosed(opts.port)).toBe(false);
        throw new Error('measured callback failed');
      }),
    ).rejects.toThrow('measured callback failed');
    expect(await instance.portClosed(opts.port)).toBe(true);
    expect(existsSync(liveFile(stateDir))).toBe(false);
    await assertPortClosed(opts.port);
  });

  it('kills the process by the pid of state.json when the launcher stop does nothing', async () => {
    const { opts } = await rig({ STUB_IGNORE_STOP: '1' });
    const started = await instance.startInstance(opts);
    expect(await instance.portClosed(opts.port)).toBe(false);
    await started.stop();
    expect(await instance.portClosed(opts.port)).toBe(true);
    await assertPortClosed(opts.port);
  });

  it('a failed start leaves no listener and no record', async () => {
    const { opts, stateDir } = await rig({ STUB_FAIL_START: '1' });
    await expect(instance.startInstance(opts)).rejects.toThrow(/start exited 1/);
    expect(await instance.portClosed(opts.port)).toBe(true);
    expect(existsSync(liveFile(stateDir))).toBe(false);
    await assertPortClosed(opts.port);
  });

  it('reaps an instance that a killed script left behind, and removes its temp root', async () => {
    const { opts, stateDir } = await rig();
    await instance.startInstance(opts);
    // the script died here: nothing calls stop, the record names the instance
    expect(JSON.parse(readFileSync(liveFile(stateDir), 'utf8'))).toHaveLength(1);
    const result = await instance.reapStale({ stateDir, envFor: hermeticEnv, stopGraceMs: 300 });
    expect(result).toEqual({ reaped: [opts.port], stuck: [] });
    expect(await instance.portClosed(opts.port)).toBe(true);
    expect(existsSync(liveFile(stateDir))).toBe(false);
    expect(existsSync(opts.root)).toBe(false);
    await assertPortClosed(opts.port);
  });

  it('reaping with an unusable launcher path leaves nothing running and keeps no stale record', async () => {
    const { opts, stateDir } = await rig();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      liveFile(stateDir),
      JSON.stringify([
        { launcher: join(opts.root, 'gone.mjs'), root: opts.root, repo: opts.repo, slug: 'bench', port: opts.port },
      ]),
    );
    const result = await instance.reapStale({ stateDir, envFor: hermeticEnv, stopGraceMs: 300 });
    expect(result).toEqual({ reaped: [opts.port], stuck: [] });
    await assertPortClosed(opts.port);
  });
});
