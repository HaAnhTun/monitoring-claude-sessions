// TC-GATE-03: the pty gate (`scripts/test-pty.mjs`) and its flake detector (`scripts/pty-soak.mjs`), design 08 section 4.1.
// The decision by platform and architecture, the required mode (a skipped test is a failure), the ratchet of distinct ids and the
// exit codes are checked with a stub vitest that writes a canned JSON report. No real terminal is started here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as gateModule from '../../scripts/test-pty.mjs';
// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as soakModule from '../../scripts/pty-soak.mjs';

interface PtyTest {
  key: string;
  file: string;
  title: string;
  status: string;
}
interface Judged {
  ok: boolean;
  ran: number;
  failed: number;
  skipped: number;
  reasons: string[];
}
interface GateIo {
  platform: string;
  arch: string;
  vitestBin: string;
  playwrightBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  minTests: number;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}
interface Decision {
  run: boolean;
  exitCode?: number;
  message?: string;
}
const gate = gateModule as unknown as {
  MIN_PTY_TESTS: number;
  SKIP_EXIT: number;
  decide: (platform: string, arch: string) => Decision;
  readPtyReport: (report: unknown) => PtyTest[];
  judgePtyReport: (tests: PtyTest[], options: { min: number }) => Judged;
  runPtyGate: (argv: string[], io: Partial<GateIo>) => Promise<number>;
};
type PerRun = Record<string, string>;
const soak = soakModule as unknown as {
  tally: (runs: PerRun[]) => { key: string; passes: number; runs: number; verdict: string }[];
  renderTable: (rows: { key: string; passes: number; runs: number; verdict: string }[]) => string;
  runSoak: (
    argv: string[],
    io: {
      runOnce: (index: number) => Promise<{ code: number; tests: PerRun | null }>;
      stdout: { write(text: string): unknown };
    },
  ) => Promise<number>;
  parseRuns: (argv: string[]) => number;
};

const RUNTIME = join(import.meta.dirname, '..', '..');
const STUB = `
import { appendFileSync, copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, required: process.env.QA_PTY_REQUIRED ?? null }) + '\\n');
const flag = args.find((arg) => arg.startsWith('--outputFile.json='));
if (flag !== undefined && process.env.STUB_REPORT) copyFileSync(process.env.STUB_REPORT, flag.slice('--outputFile.json='.length));
process.exit(Number(process.env.STUB_EXIT ?? 0));
`;

let root = '';
let stubLog = '';
let stdout = '';
let stderr = '';

function report(tests: { file: string; title: string; status: string }[]): object {
  const byFile = new Map<string, { title: string; status: string }[]>();
  for (const t of tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  return {
    numTotalTests: tests.length,
    testResults: [...byFile].map(([name, list]) => ({
      name,
      assertionResults: list.map((t) => ({
        title: t.title,
        fullName: `suite ${t.title}`,
        ancestorTitles: ['suite'],
        status: t.status,
      })),
    })),
  };
}

function ioFor(extra: Partial<GateIo> = {}, reportBody?: object, exit = 0): Partial<GateIo> {
  const reportFile = join(root, 'report.json');
  if (reportBody !== undefined) writeFileSync(reportFile, JSON.stringify(reportBody));
  return {
    platform: 'win32',
    arch: 'x64',
    vitestBin: join(root, 'stub-vitest.mjs'),
    playwrightBin: join(root, 'stub-vitest.mjs'),
    cwd: root,
    minTests: 0,
    env: {
      ...process.env,
      STUB_LOG: stubLog,
      STUB_REPORT: reportBody === undefined ? '' : reportFile,
      STUB_EXIT: String(exit),
    },
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    ...extra,
  };
}

function calls(): { args: string[]; required: string | null }[] {
  return readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; required: string | null });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-pty-gate-'));
  stubLog = join(root, 'stub.log');
  writeFileSync(stubLog, '');
  writeFileSync(join(root, 'stub-vitest.mjs'), STUB);
  stdout = '';
  stderr = '';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('decide(platform, arch)', () => {
  it('runs on Windows x64 and arm64 only', () => {
    expect(gate.decide('win32', 'x64')).toMatchObject({ run: true });
    expect(gate.decide('win32', 'arm64')).toMatchObject({ run: true });
    for (const [platform, arch] of [
      ['win32', 'ia32'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
    ] as const) {
      expect(gate.decide(platform, arch)).toMatchObject({ run: false, exitCode: 77 });
    }
  });

  it('names the platform and the reason in the skip message (spec Q1)', () => {
    expect(gate.decide('linux', 'x64').message).toBe(
      'test:pty: SKIPPED on linux-x64: terminals are Windows-only in this release (spec Q1)',
    );
    expect(gate.decide('darwin', 'arm64').message).toContain('SKIPPED on darwin-arm64');
  });

  it('uses the exit code of "cannot run yet", the one ci.mjs shows as SKIPPED', () => {
    expect(gate.SKIP_EXIT).toBe(77);
  });
});

describe('the report reader and the ratchet', () => {
  it('counts distinct ids: the same TC id in two titles is one test, a title without an id is its file and name', () => {
    const tests = gate.readPtyReport(
      report([
        { file: 'a.pty.test.ts', title: 'TC-PTY-01 first row', status: 'passed' },
        { file: 'a.pty.test.ts', title: 'TC-PTY-01 second row', status: 'passed' },
        { file: 'b.pty.test.ts', title: 'no id here', status: 'passed' },
        { file: 'c.pty.test.ts', title: 'no id here', status: 'passed' },
      ]),
    );
    expect(new Set(tests.map((t) => t.key)).size).toBe(3);
  });

  it('judges a green report with at least the floor as ok', () => {
    const tests = gate.readPtyReport(report([{ file: 'a', title: 'TC-PTY-01 x', status: 'passed' }]));
    expect(gate.judgePtyReport(tests, { min: 1 })).toMatchObject({
      ok: true,
      ran: 1,
      failed: 0,
      skipped: 0,
      reasons: [],
    });
  });

  it('fails on a failed test, on any skipped, pending or todo test and on fewer ids than the floor', () => {
    const one = (status: string) => gate.readPtyReport(report([{ file: 'a', title: 'TC-PTY-01 x', status }]));
    expect(gate.judgePtyReport(one('failed'), { min: 0 }).ok).toBe(false);
    for (const status of ['skipped', 'pending', 'todo']) {
      const judged = gate.judgePtyReport(one(status), { min: 0 });
      expect(judged.ok).toBe(false);
      expect(judged.skipped).toBe(1);
    }
    const few = gate.judgePtyReport(one('passed'), { min: 2 });
    expect(few.ok).toBe(false);
    expect(few.reasons.join(' ')).toMatch(/1 of at least 2/);
  });

  it('ships a ratchet that is a non-negative integer', () => {
    expect(Number.isInteger(gate.MIN_PTY_TESTS)).toBe(true);
    expect(gate.MIN_PTY_TESTS).toBeGreaterThanOrEqual(0);
  });
});

describe('runPtyGate', () => {
  it('off Windows prints the skip message, starts nothing and exits 77', async () => {
    const code = await gate.runPtyGate([], ioFor({ platform: 'linux', arch: 'x64' }));
    expect(code).toBe(77);
    expect(stdout).toContain('test:pty: SKIPPED on linux-x64: terminals are Windows-only in this release (spec Q1)');
    expect(calls()).toEqual([]);
  });

  it('on Windows runs the pty project with the required mode, the JSON reporter and passWithNoTests', async () => {
    const body = report([{ file: 'a.pty.test.ts', title: 'TC-PTY-01 x', status: 'passed' }]);
    const code = await gate.runPtyGate([], ioFor({}, body));
    expect(code).toBe(0);
    const [call] = calls();
    expect(call?.required).toBe('1');
    expect(call?.args.slice(0, 3)).toEqual(['run', '--project', 'pty']);
    expect(call?.args).toEqual(expect.arrayContaining(['--reporter=default', '--reporter=json', '--passWithNoTests']));
    expect(call?.args.some((arg) => /^--outputFile\.json=.+/.test(arg))).toBe(true);
  });

  it('is green when no pty file exists yet and the floor is 0 (the gate may land before the first file)', async () => {
    expect(await gate.runPtyGate([], ioFor({}, report([])))).toBe(0);
  });

  it('exits 1 when a test failed, naming the count', async () => {
    const body = report([
      { file: 'a', title: 'TC-PTY-01 x', status: 'failed' },
      { file: 'a', title: 'TC-PTY-02 y', status: 'passed' },
    ]);
    expect(await gate.runPtyGate([], ioFor({}, body, 1))).toBe(1);
    expect(stdout + stderr).toMatch(/1 failed/);
  });

  it('exits 1 for a skipped test even when vitest itself exits 0: required mode fails a skip', async () => {
    const body = report([{ file: 'a', title: 'TC-PTY-01 x', status: 'skipped' }]);
    expect(await gate.runPtyGate([], ioFor({}, body, 0))).toBe(1);
    expect(stdout + stderr).toMatch(/skipped/);
  });

  it('exits 1 below the ratchet, so a deleted or silently excluded file turns the gate red', async () => {
    const body = report([{ file: 'a', title: 'TC-PTY-01 x', status: 'passed' }]);
    expect(await gate.runPtyGate([], ioFor({ minTests: 2 }, body))).toBe(1);
    expect(stdout + stderr).toMatch(/at least 2/);
  });

  it('exits 1 when vitest fails without a report (a crash or a config error)', async () => {
    expect(await gate.runPtyGate([], ioFor({}, undefined, 1))).toBe(1);
    expect(stdout + stderr).toMatch(/no JSON report|exit 1/);
  });

  it('exits 1 when vitest exits non-zero although the report is green', async () => {
    const body = report([{ file: 'a', title: 'TC-PTY-01 x', status: 'passed' }]);
    expect(await gate.runPtyGate([], ioFor({}, body, 2))).toBe(1);
  });

  it('keeps the JSON report at --json-out for the soak', async () => {
    const body = report([{ file: 'a', title: 'TC-PTY-01 x', status: 'passed' }]);
    const target = join(root, 'kept.json');
    expect(await gate.runPtyGate(['--json-out', target], ioFor({}, body))).toBe(0);
    expect((JSON.parse(readFileSync(target, 'utf8')) as { numTotalTests: number }).numTotalTests).toBe(1);
  });

  it('forwards the remaining arguments to vitest (a file filter)', async () => {
    const body = report([{ file: 'a', title: 'TC-PTY-01 x', status: 'passed' }]);
    await gate.runPtyGate(['packages/engine/test/x.pty.test.ts'], ioFor({}, body));
    expect(calls()[0]?.args).toContain('packages/engine/test/x.pty.test.ts');
  });

  it('--e2e off Windows is the same skip; on Windows it runs the terminal Playwright config', async () => {
    expect(await gate.runPtyGate(['--e2e'], ioFor({ platform: 'darwin', arch: 'arm64' }))).toBe(77);
    expect(calls()).toEqual([]);
    mkdirSync(join(root, 'packages', 'web', 'e2e', 'terminal'), { recursive: true });
    writeFileSync(join(root, 'packages', 'web', 'e2e', 'terminal', 'playwright.config.ts'), '');
    expect(await gate.runPtyGate(['--e2e'], ioFor())).toBe(0);
    expect(calls()[0]?.args).toEqual(['test', '-c', 'packages/web/e2e/terminal/playwright.config.ts']);
    expect(calls()[0]?.required).toBe('1');
  });

  it('--e2e exits 1 with a clear message while the terminal Playwright config does not exist', async () => {
    expect(await gate.runPtyGate(['--e2e'], ioFor())).toBe(1);
    expect(stdout + stderr).toMatch(/playwright\.config\.ts/);
    expect(calls()).toEqual([]);
  });
});

describe('package.json scripts', () => {
  const scripts = (
    JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  ).scripts;

  it('has the pty, soak, terminal e2e, clean gate and terminal bench scripts', () => {
    expect(scripts['test:pty']).toBe('node scripts/test-pty.mjs');
    expect(scripts['test:pty:soak']).toBe('node scripts/pty-soak.mjs --runs 3');
    expect(scripts['test:e2e:terminal']).toBe('node scripts/test-pty.mjs --e2e');
    expect(scripts['gate:clean']).toBe('node scripts/gate-clean.mjs');
    expect(scripts['bench:terminal']).toBe('node bench/bench-terminal.mjs');
  });

  it('keeps the pty project out of npm test and the other combined scripts', () => {
    for (const name of ['test', 'test:unit', 'test:int', 'test:coverage']) expect(scripts[name]).not.toMatch(/pty/);
  });
});

describe('pty-soak', () => {
  it('tally: a test that passed in some but not all runs is FLAKY, one that failed in all is FAILED', () => {
    const rows = soak.tally([
      { a: 'passed', b: 'passed', c: 'failed', d: 'skipped' },
      { a: 'passed', b: 'failed', c: 'failed', d: 'skipped' },
      { a: 'passed', b: 'passed', c: 'failed', d: 'skipped' },
    ]);
    const verdicts = Object.fromEntries(rows.map((r) => [r.key, `${r.passes}/${r.runs} ${r.verdict}`]));
    expect(verdicts).toEqual({ a: '3/3 ok', b: '2/3 FLAKY', c: '0/3 FAILED', d: '0/3 SKIPPED' });
  });

  it('renderTable prints one row per test with its passes', () => {
    const table = soak.renderTable(soak.tally([{ a: 'passed' }, { a: 'failed' }]));
    expect(table).toContain('| a | 1/2 | FLAKY |');
  });

  it('parseRuns reads --runs and defaults to 3', () => {
    expect(soak.parseRuns([])).toBe(3);
    expect(soak.parseRuns(['--runs', '5'])).toBe(5);
    expect(() => soak.parseRuns(['--runs', '0'])).toThrow(/positive integer/);
  });

  const sink = () => ({ write: (t: string) => (stdout += t) });

  it('exits 0 when every test passed in every run', async () => {
    const code = await soak.runSoak(['--runs', '3'], {
      stdout: sink(),
      runOnce: () => Promise.resolve({ code: 0, tests: { a: 'passed' } }),
    });
    expect(code).toBe(0);
    expect(stdout).toContain('| a | 3/3 | ok |');
  });

  it('lists a test that failed in one run as FLAKY and exits 1', async () => {
    const code = await soak.runSoak(['--runs', '3'], {
      stdout: sink(),
      runOnce: (i) => Promise.resolve({ code: i === 1 ? 1 : 0, tests: { a: i === 1 ? 'failed' : 'passed' } }),
    });
    expect(code).toBe(1);
    expect(stdout).toContain('FLAKY');
  });

  it('exits 77 and runs once when the first run says the gate cannot run here', async () => {
    let runs = 0;
    const code = await soak.runSoak(['--runs', '3'], {
      stdout: sink(),
      runOnce: () => {
        runs += 1;
        return Promise.resolve({ code: 77, tests: null });
      },
    });
    expect(code).toBe(77);
    expect(runs).toBe(1);
  });

  it('exits 1 when a run has no report', async () => {
    const code = await soak.runSoak(['--runs', '2'], {
      stdout: sink(),
      runOnce: () => Promise.resolve({ code: 1, tests: null }),
    });
    expect(code).toBe(1);
    expect(stdout).toMatch(/no report/);
  });
});
