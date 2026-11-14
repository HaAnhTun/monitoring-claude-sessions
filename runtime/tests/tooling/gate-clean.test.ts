// TC-GATE-12: the clean-worktree gate (design 08 section 4.6). The pure half (`scripts/gate-clean-lib.mjs`: step plan, failure
// classes, parsers, leak deltas, report) is driven directly; the runner (`scripts/gate-clean.mjs`) is driven with a fake tool runner
// and fake machine probes, and once with real git on a throw-away repository. No real gate step is ever started here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as libModule from '../../scripts/gate-clean-lib.mjs';
// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as runnerModule from '../../scripts/gate-clean.mjs';

interface Action {
  type: string;
  tool?: string;
  args?: string[];
  cwd?: string;
  name?: string;
  skipOnExit77?: boolean;
  continueOnFailure?: boolean;
}
interface Step {
  id: string;
  key: string;
  title: string;
  actions: Action[];
  env: Record<string, string>;
  reportOnly: boolean;
  optional: boolean;
  environmentIsReportOnly: boolean;
  project: string | null;
  skipped: string | null;
}
interface Options {
  out: string;
  ref: string;
  worktree?: string;
  skip: Set<string>;
  keep: boolean;
  workers: number;
  withDocker: boolean;
  repo?: string;
}
interface LeakRow {
  name: string;
  before: number;
  after: number;
  delta: number;
  detail?: string;
}
interface Snapshot {
  counts?: Record<string, number>;
  listeners?: number[];
  tempFolders?: number;
}
interface Summary {
  files: { failed: number; passed: number; skipped: number; total: number };
  tests: { failed: number; passed: number; skipped: number; todo: number; total: number };
  failedFiles: { project: string | null; file: string }[];
}
interface ReportStep {
  id: string;
  status: string;
  note?: string;
  class?: string;
  counts?: Record<string, unknown>;
}
interface Report {
  schema: string;
  verdict: string;
  commit: { ref: string; sha: string; skill: string | null };
  options: { workers: number; timeScale?: number };
  steps: ReportStep[];
  failedFiles: { file: string; step: string; class: string; passesAlone: boolean | null }[];
  flakes: { step: string; file: string }[];
  leaks: LeakRow[];
  cleanup: { state: string; drift: string[] };
  machine: { start?: { cpuPercent: number; counts: Record<string, number> }; end?: unknown };
}

const lib = libModule as unknown as {
  REPORT_SCHEMA: string;
  STEP_IDS: string[];
  UsageError: new (message: string) => Error;
  parseArgs: (argv: string[]) => Options;
  planSteps: (options: Partial<Options>) => Step[];
  classifyFailure: (text: string) => string;
  parseVitestSummary: (text: string) => Summary | null;
  parseCiOutput: (text: string) => { rows: { name: string; result: string; ms: number }[]; notRun: string | null };
  evaluateCi: (
    parsed: { rows: { name: string; result: string; ms: number }[]; notRun: string | null },
    o: { platform: string },
  ) => { ok: boolean; problems: string[] };
  leakDelta: (before: Snapshot, after: Snapshot) => LeakRow[];
  parseListeners: (text: string) => number[];
  parseProcessList: (text: string) => { pid: number; name: string; command: string }[];
  countProcesses: (list: { pid: number; name: string; command: string }[], worktree?: string) => Record<string, number>;
  checkShotsIndex: (index: unknown) => { ok: boolean; records: number; problems: string[] };
  verdictOf: (result: object) => string;
  renderReport: (result: object) => string;
  cpuPercent: (before: object[], after: object[]) => number;
  nodeSupported: (version: string) => boolean;
  isInside: (child: string, parent: string) => boolean;
  aloneAction: (failure: { project: string | null; file: string }) => Action;
};

interface Call {
  tool: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
interface Probe {
  cpu: () => Promise<number>;
  freeMemMb: () => number;
  listeners: () => number[];
  processes: () => { pid: number; name: string; command: string }[];
  tempFolders: () => number;
}
interface RunnerIo {
  run: (spec: Call & { logFile?: string }) => Promise<{ code: number; text: string; ms: number }>;
  probe: Probe;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  platform: string;
  findSkill: (root: string) => string | null;
  listPython: (root: string) => string[];
  signals: { on(name: string, fn: () => void): void; off(name: string, fn: () => void): void };
}
const runner = runnerModule as unknown as {
  runGateClean: (argv: string[], io?: Partial<RunnerIo>) => Promise<number>;
  findSkillFolder: (root: string) => string | null;
  listPythonFiles: (root: string) => string[];
  makeRunner: () => { run: RunnerIo['run'] };
};

const j = (...parts: string[]): string => parts.join('');
const SHA = 'a'.repeat(40);

// ---- pure half ------------------------------------------------------------------------------------------------------------------

describe('options', () => {
  it('requires --out and defaults the rest', () => {
    expect(() => lib.parseArgs([])).toThrow(/--out/);
    const opts = lib.parseArgs(['--out', 'o']);
    expect(opts).toMatchObject({ out: 'o', ref: 'HEAD', keep: false, workers: 3, withDocker: false });
    expect(opts.skip.size).toBe(0);
  });

  it('reads every flag, accepting step ids and step keys in --skip', () => {
    const opts = lib.parseArgs([
      '--out',
      'o',
      '--ref',
      'v1',
      '--worktree',
      'w',
      '--keep',
      '--workers',
      '2',
      '--with-docker',
      '--skip',
      'G3,bench,Docker',
    ]);
    expect(opts).toMatchObject({ ref: 'v1', worktree: 'w', keep: true, workers: 2, withDocker: true });
    expect([...opts.skip].sort()).toEqual(['G11', 'G12', 'G3']);
  });

  it('refuses an unknown flag, a missing value, a bad worker count, an unknown step and a skipped G0 or G1', () => {
    for (const argv of [
      ['--out', 'o', '--nope'],
      ['--out'],
      ['--out', 'o', '--workers', '0'],
      ['--out', 'o', '--workers', 'x'],
      ['--out', 'o', '--skip', 'G99'],
      ['--out', 'o', '--skip', 'G0'],
      ['--out', 'o', '--skip', 'worktree'],
    ]) {
      expect(() => lib.parseArgs(argv), argv.join(' ')).toThrow(lib.UsageError);
    }
  });

  it('isInside tells a folder below another from a sibling', () => {
    expect(lib.isInside(join('a', 'b', 'c'), join('a', 'b'))).toBe(true);
    expect(lib.isInside(join('a', 'b'), join('a', 'b'))).toBe(true);
    expect(lib.isInside(join('a', 'bc'), join('a', 'b'))).toBe(false);
    expect(lib.isInside('a', join('a', 'b'))).toBe(false);
  });
});

describe('planSteps', () => {
  const options = { out: join('x', 'out'), skip: new Set<string>(), workers: 3, withDocker: false };
  const byId = (steps: Step[], id: string): Step => steps.find((s) => s.id === id)!;
  const line = (action: Action): string => `${action.tool ?? action.name} ${(action.args ?? []).join(' ')}`.trim();

  it('has the fourteen steps G0 to G13 in order', () => {
    const steps = lib.planSteps(options);
    expect(steps.map((s) => s.id)).toEqual([
      'G0',
      'G1',
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G7',
      'G8',
      'G9',
      'G10',
      'G11',
      'G12',
      'G13',
    ]);
    expect(steps.map((s) => s.id)).toEqual(lib.STEP_IDS);
  });

  it('gives every command step the worker cap and the required pty mode', () => {
    for (const step of lib.planSteps({ ...options, workers: 2 })) {
      expect(step.env['VITEST_MAX_WORKERS']).toBe('2');
      expect(step.env['QA_PTY_REQUIRED']).toBe('1');
    }
  });

  it('plans the commands of the design table', () => {
    const steps = lib.planSteps(options);
    expect(byId(steps, 'G2').actions.map(line)).toEqual(['npm ci --prefer-offline']);
    expect(byId(steps, 'G3').actions.map(line)).toEqual(['node scripts/ci.mjs --offline --bundle --keep-going']);
    expect(byId(steps, 'G4').actions.map(line)).toEqual(['npm run test:tooling']);
    expect(byId(steps, 'G5').actions.map(line)).toEqual(['npm run test:isolation']);
    expect(byId(steps, 'G6').actions.map(line)).toEqual(['npm run test:resilience']);
    expect(byId(steps, 'G7').actions.map(line)).toEqual([
      'node scripts/test-pty.mjs',
      'node scripts/pty-soak.mjs --runs 3',
    ]);
    expect(byId(steps, 'G8').actions.map(line)).toEqual(['npm run schemas:check', 'noPython']);
    expect(byId(steps, 'G9').actions.map(line)).toEqual([
      'node node_modules/@playwright/test/cli.js test -c packages/web/e2e/playwright.config.ts',
      'npm run test:e2e:terminal',
    ]);
    expect(byId(steps, 'G10').actions.map(line)[0]).toBe(
      'node node_modules/@playwright/test/cli.js test -c packages/web/e2e/qa/playwright.config.ts',
    );
    expect(byId(steps, 'G11').actions.map(line)).toEqual(['npm run bench:terminal -- --minutes 2 --report-only']);
    expect(byId(steps, 'G12').actions.map(line)).toEqual([
      'npm run docker:posix -- --targets node22,node24,alpine24 --platform amd64',
    ]);
  });

  it('runs every command in the runtime folder of the worktree', () => {
    for (const step of lib.planSteps(options)) {
      for (const action of step.actions) if (action.type === 'command') expect(action.cwd).toBe('runtime');
    }
  });

  it('runs G4 to G6 as one vitest project each, so the flake rule can re-run them', () => {
    const steps = lib.planSteps(options);
    expect(['G4', 'G5', 'G6'].map((id) => byId(steps, id).project)).toEqual(['tooling', 'isolation', 'resilience']);
    expect(byId(steps, 'G3').project).toBeNull();
  });

  it('sends the shots outside the repository, to a folder of the report folder', () => {
    expect(byId(lib.planSteps(options), 'G10').env['MCS_SHOTS_DIR']).toBe('x/out/shots');
  });

  it('marks the bench report-only and the bench and Docker optional', () => {
    const steps = lib.planSteps(options);
    expect(byId(steps, 'G11')).toMatchObject({ reportOnly: true, optional: true });
    expect(byId(steps, 'G12')).toMatchObject({ optional: true, environmentIsReportOnly: true });
    expect(byId(steps, 'G3')).toMatchObject({ reportOnly: false, optional: false });
  });

  it('skips Docker unless requested and reports --skip with its reason', () => {
    expect(byId(lib.planSteps(options), 'G12').skipped).toMatch(/--with-docker/);
    expect(byId(lib.planSteps({ ...options, withDocker: true }), 'G12').skipped).toBeNull();
    const skipped = lib.planSteps({ ...options, skip: new Set(['G4']) });
    expect(byId(skipped, 'G4').skipped).toBe('--skip G4');
    expect(byId(skipped, 'G5').skipped).toBeNull();
  });

  it('re-runs one failed file alone through the project it came from', () => {
    expect(lib.aloneAction({ project: 'unit', file: 'a/b.test.ts' }).args).toEqual([
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      'unit',
      'a/b.test.ts',
    ]);
    expect(lib.aloneAction({ project: null, file: 'a/b.test.ts' }).args).toEqual([
      'node_modules/vitest/vitest.mjs',
      'run',
      'a/b.test.ts',
    ]);
  });
});

describe('classifyFailure', () => {
  it('T: a test or hook timeout', () => {
    expect(lib.classifyFailure('Error: Test timed out in 10000ms.')).toBe('T');
    expect(lib.classifyFailure('Error: Hook timed out in 20000ms.')).toBe('T');
    expect(lib.classifyFailure('Test timeout of 60000ms exceeded.')).toBe('T');
  });

  it('A: any other assertion, and the default', () => {
    expect(lib.classifyFailure('AssertionError: expected 1 to be 2')).toBe('A');
    expect(lib.classifyFailure('')).toBe('A');
  });

  it('L: a latency or budget assertion', () => {
    expect(lib.classifyFailure('AssertionError: the first frame arrived after 900 ms, over the latency budget')).toBe(
      'L',
    );
    expect(lib.classifyFailure('expected 5000 to be below the budget')).toBe('L');
  });

  it('P: a port collision or a leaked process', () => {
    expect(lib.classifyFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:18004')).toBe('P');
    expect(lib.classifyFailure('1 leaked process still running after the test')).toBe('P');
  });

  it('X: an environment error (no browser, no Docker)', () => {
    expect(lib.classifyFailure("browserType.launch: Executable doesn't exist at C:/chrome")).toBe('X');
    expect(lib.classifyFailure('Cannot connect to the Docker daemon at npipe')).toBe('X');
  });

  it('prefers the cause over the symptom: a collision or a missing tool before a timeout', () => {
    expect(lib.classifyFailure('EADDRINUSE ... Test timed out in 30000ms')).toBe('P');
    expect(lib.classifyFailure("Executable doesn't exist ... Test timed out")).toBe('X');
  });

  it('ignores terminal colour codes', () => {
    const esc = String.fromCharCode(27);
    expect(lib.classifyFailure(`${esc}[31mTest timed out${esc}[39m`)).toBe('T');
  });
});

describe('parseVitestSummary', () => {
  const text = [
    ' FAIL  |tooling| tests/tooling/a.test.ts > suite > one',
    ' FAIL  |tooling| tests/tooling/a.test.ts > suite > two',
    ' FAIL  packages/engine/test/b.int.test.ts [ packages/engine/test/b.int.test.ts ]',
    '',
    ' Test Files  2 failed | 10 passed | 1 skipped (13)',
    '      Tests  3 failed | 120 passed | 2 skipped | 1 todo (126)',
  ].join('\n');

  it('reads the counts of both summary lines', () => {
    const summary = lib.parseVitestSummary(text);
    expect(summary?.files).toEqual({ failed: 2, passed: 10, skipped: 1, todo: 0, total: 13 });
    expect(summary?.tests).toEqual({ failed: 3, passed: 120, skipped: 2, todo: 1, total: 126 });
  });

  it('lists each failed file once with the project it ran in', () => {
    expect(lib.parseVitestSummary(text)?.failedFiles).toEqual([
      { project: 'tooling', file: 'tests/tooling/a.test.ts' },
      { project: null, file: 'packages/engine/test/b.int.test.ts' },
    ]);
  });

  it('reads the real vitest 5 forms: pipes without colour, a bare project name with colour', () => {
    const esc = String.fromCharCode(27);
    const plain = [
      ' FAIL  |tooling| a.test.js > fails',
      ' FAIL  |other| sub/b.test.js > boom',
      ' FAIL  |tooling| c.test.js [ c.test.js ]',
    ].join('\n');
    // The coloured form paints the project name on a background and prints no pipes (vitest 5.0.3, CI=1 or FORCE_COLOR=1).
    const name = (project: string) => `${esc}[30m${esc}[46m ${project} ${esc}[49m${esc}[39m`;
    const coloured = [
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m ${name('tooling')} a.test.js${esc}[2m > ${esc}[22mfails`,
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m ${name('other')} sub/b.test.js${esc}[2m > ${esc}[22mboom`,
      `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m ${name('tooling')} c.test.js${esc}[2m [ c.test.js ]${esc}[22m`,
    ].join('\n');
    const bare =
      ' FAIL  tooling a.test.js > fails\n FAIL  tooling a.test.js > fails two\n FAIL  other sub/b.test.js > boom';
    const summary = '\n Test Files  3 failed (3)\n      Tests  3 failed | 1 passed (4)\n';
    const expected = [
      { project: 'tooling', file: 'a.test.js' },
      { project: 'other', file: 'sub/b.test.js' },
    ];
    const withC = [...expected, { project: 'tooling', file: 'c.test.js' }];
    expect(lib.parseVitestSummary(plain + summary)?.failedFiles).toEqual(withC);
    expect(lib.parseVitestSummary(coloured + summary)?.failedFiles).toEqual(withC);
    expect(lib.parseVitestSummary(bare + summary)?.failedFiles).toEqual(expected);
  });

  it('reads a green run and returns null for text without a summary', () => {
    const green = lib.parseVitestSummary(' Test Files  4 passed (4)\n      Tests  9 passed (9)\n');
    expect(green?.tests).toMatchObject({ passed: 9, failed: 0, total: 9 });
    expect(green?.failedFiles).toEqual([]);
    expect(lib.parseVitestSummary('no summary here')).toBeNull();
  });

  it('strips colour codes before it reads', () => {
    const esc = String.fromCharCode(27);
    const colored = ` ${esc}[2mTest Files${esc}[22m  ${esc}[1m${esc}[31m1 failed${esc}[39m${esc}[22m${esc}[2m | ${esc}[22m3 passed (4)`;
    expect(lib.parseVitestSummary(colored)?.files).toMatchObject({ failed: 1, passed: 3, total: 4 });
  });
});

describe('the ci table', () => {
  const ROWS = [
    'format:check',
    'lint',
    'typecheck',
    'check:deps',
    'build',
    'test',
    'test:pty',
    'smoke',
    'bundle:check',
    'smoke:bundle',
  ];
  const table = (overrides: Record<string, string> = {}, extra = ''): string =>
    [
      'noise',
      '| gate | result | ms |',
      '|---|---|---|',
      ...ROWS.map((r) => `| ${r} | ${overrides[r] ?? 'PASS'} | 5 |`),
      extra,
    ].join('\n');

  it('parses the rows and the not-run line of the last table', () => {
    const parsed = lib.parseCiOutput(`${table({ lint: 'FAIL (exit 1)' })}\nnot run: audit`);
    expect(parsed.rows).toHaveLength(10);
    expect(parsed.rows[1]).toEqual({ name: 'lint', result: 'FAIL (exit 1)', ms: 5 });
    expect(parsed.notRun).toBe('audit');
  });

  it('accepts a table where every row passes', () => {
    expect(lib.evaluateCi(lib.parseCiOutput(table()), { platform: 'win32' })).toEqual({ ok: true, problems: [] });
  });

  it('fails a FAIL row, a missing required row and a not-run line', () => {
    const failed = lib.evaluateCi(lib.parseCiOutput(table({ build: 'FAIL (exit 2)' })), { platform: 'win32' });
    expect(failed.ok).toBe(false);
    expect(failed.problems).toContain('row build: FAIL (exit 2)');
    const missing = lib.evaluateCi(lib.parseCiOutput(table().replace('| bundle:check | PASS | 5 |', '')), {
      platform: 'win32',
    });
    expect(missing.problems).toContain('row bundle:check is missing');
    const notRun = lib.evaluateCi(lib.parseCiOutput(`${table()}\nnot run: smoke`), { platform: 'win32' });
    expect(notRun.problems).toContain('not run: smoke');
  });

  it('lets test:pty be SKIPPED off Windows only, and no other row ever', () => {
    const skipped = table({ 'test:pty': 'SKIPPED (exit 77)' });
    expect(lib.evaluateCi(lib.parseCiOutput(skipped), { platform: 'linux' }).ok).toBe(true);
    expect(lib.evaluateCi(lib.parseCiOutput(skipped), { platform: 'win32' }).ok).toBe(false);
    expect(lib.evaluateCi(lib.parseCiOutput(table({ smoke: 'SKIPPED (exit 77)' })), { platform: 'linux' }).ok).toBe(
      false,
    );
  });
});

describe('machine probes (pure parts)', () => {
  it('parseListeners keeps the listening ports of the test range and the product default, from netstat and ss', () => {
    const text = [
      '  TCP    0.0.0.0:18000          0.0.0.0:0              LISTENING       100',
      '  TCP    [::]:18001             [::]:0                 LISTENING       100',
      '  TCP    127.0.0.1:7690         0.0.0.0:0              LISTENING       101',
      '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       102',
      '  TCP    127.0.0.1:18002        127.0.0.1:50000        ESTABLISHED     103',
      'LISTEN 0      511          127.0.0.1:18999      0.0.0.0:*',
      'LISTEN 0      511                  *:19000            *:*',
    ].join('\n');
    expect(lib.parseListeners(text)).toEqual([7690, 18000, 18001, 18999]);
  });

  it('parseProcessList reads CIM lines and ps lines; countProcesses counts the families', () => {
    const list = lib.parseProcessList(
      [
        '10|OpenConsole.exe|"C:/x/OpenConsole.exe" --server 0x1',
        '11|conhost.exe|\\??\\C:\\Windows\\system32\\conhost.exe 0x4',
        '12|conhost.exe|conhost.exe 0x4',
        'garbage',
        '13|node.exe|"node.exe" D:\\caw-qa-wt\\runtime\\scripts\\x.mjs',
        '14|node.exe|"node.exe" D:\\elsewhere\\y.mjs',
        '15|node.exe|node C:/t/fake-claude.mjs --mode ok',
        ' 16 /usr/bin/node /opt/caw-qa-wt/runtime/a.mjs',
      ].join('\n'),
    );
    expect(list).toHaveLength(7);
    expect(lib.countProcesses(list, 'D:/caw-qa-wt')).toEqual({
      OpenConsole: 1,
      conhost: 2,
      'node (worktree)': 1,
      'fake-claude': 1,
    });
    expect(lib.countProcesses(list, '/opt/caw-qa-wt')['node (worktree)']).toBe(1);
  });

  it('cpuPercent is the busy share between two samples', () => {
    const t = (idle: number, busy: number) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
    expect(lib.cpuPercent([t(0, 0), t(0, 0)], [t(50, 50), t(25, 75)])).toBe(62.5);
    expect(lib.cpuPercent([t(1, 1)], [t(1, 1)])).toBe(0);
  });

  it('nodeSupported follows engines.node (^22.22.0, ^24, 26 and up)', () => {
    expect(['v22.22.0', 'v24.14.1', 'v26.0.0', '24.0.0'].map(lib.nodeSupported)).toEqual([true, true, true, true]);
    expect(['v22.21.9', 'v23.0.0', 'v20.1.0', 'v25.1.0', 'nope'].map(lib.nodeSupported)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('leakDelta', () => {
  const base = {
    counts: { OpenConsole: 2, conhost: 3, 'node (worktree)': 0, 'fake-claude': 0 },
    listeners: [7690],
    tempFolders: 4,
  };

  it('has all deltas zero for an unchanged machine', () => {
    const rows = lib.leakDelta(base, structuredClone(base));
    expect(rows.every((r) => r.delta === 0)).toBe(true);
    expect(rows.map((r) => r.name)).toEqual([
      'OpenConsole',
      'conhost',
      'node (worktree)',
      'fake-claude',
      'temp folders mcs-*',
      'listeners 18000-18999, 7690',
    ]);
  });

  it('shows a leaked console host, a leftover temp folder and a new listener', () => {
    const after = {
      counts: { ...base.counts, conhost: 5, 'fake-claude': 1 },
      listeners: [7690, 18004],
      tempFolders: 6,
    };
    const rows = Object.fromEntries(lib.leakDelta(base, after).map((r) => [r.name, r]));
    expect(rows['conhost']).toMatchObject({ before: 3, after: 5, delta: 2 });
    expect(rows['fake-claude']?.delta).toBe(1);
    expect(rows['temp folders mcs-*']?.delta).toBe(2);
    expect(rows['listeners 18000-18999, 7690']).toMatchObject({ delta: 1, detail: 'new ports 18004' });
  });

  it('counts a replaced listener as new even when the number of listeners is the same', () => {
    const rows = lib.leakDelta({ listeners: [18000] }, { listeners: [18001] });
    expect(rows.at(-1)?.delta).toBe(1);
  });

  it('treats a missing snapshot part as zero', () => {
    expect(lib.leakDelta({}, {}).every((r) => r.delta === 0)).toBe(true);
  });
});

describe('checkShotsIndex', () => {
  const record = (extra: object = {}, measure: object | null = {}) => ({
    view: 'home',
    viewport: '1440x900',
    theme: 'light',
    status: 'ok',
    consoleErrors: 0,
    measure,
    ...extra,
  });

  it('accepts clean records, and records without the newer measurements', () => {
    expect(lib.checkShotsIndex({ version: 1, files: [record(), record({}, null)] })).toMatchObject({
      ok: true,
      records: 2,
    });
    const full = {
      pageOverflowX: 0,
      clippedColumns: 0,
      lowContrastTexts: 0,
      nonMonoText: [],
      tinyText: 0,
      clippedText: 0,
      terminal: { cols: 80 },
    };
    expect(lib.checkShotsIndex({ version: 1, files: [record({}, full)] }).ok).toBe(true);
  });

  it('flags a failed picture, a console error, a horizontal scroll, low contrast, a non-mono run and a narrow terminal', () => {
    const bad = lib.checkShotsIndex({
      version: 1,
      files: [
        record({ status: 'failed' }),
        record({ consoleErrors: 2 }),
        record({}, { pageOverflowX: 12 }),
        record({}, { lowContrastTexts: 3 }),
        record({}, { nonMonoText: ['x'] }),
        record({}, { terminal: { cols: 79 } }),
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems).toHaveLength(6);
    expect(bad.problems.join('\n')).toMatch(/terminal\.cols 79 is below 80/);
  });

  it('refuses an empty or damaged index', () => {
    expect(lib.checkShotsIndex({ version: 1, files: [] }).ok).toBe(false);
    expect(lib.checkShotsIndex(null).ok).toBe(false);
    expect(lib.checkShotsIndex({}).ok).toBe(false);
  });
});

describe('verdict and report', () => {
  const step = (id: string, status: string, extra: object = {}) => ({
    id,
    key: id,
    title: `title ${id}`,
    status,
    ms: 10,
    ...extra,
  });
  const result = (steps: object[], extra: object = {}) => ({
    commit: { ref: 'HEAD', sha: SHA, treeClean: true, skill: 'skills/demo' },
    tools: { node: 'v24.14.1', npm: '11.0.0', git: '2.45.0', platform: 'win32-x64' },
    options: { workers: 3, withDocker: false },
    machine: {
      start: { cpuPercent: 12.5, freeMemMb: 2048, listeners: [], tempFolders: 1, counts: { conhost: 2 } },
      end: { cpuPercent: 10, freeMemMb: 2000, listeners: [], tempFolders: 1, counts: { conhost: 2 } },
    },
    steps,
    failedFiles: [],
    flakes: [],
    leaks: [],
    cleanup: { worktree: 'D:/caw-qa-wt', state: 'removed', drift: [] },
    ...extra,
  });

  it('PASS when every step passed, a warn or an optional skip changes nothing', () => {
    expect(
      lib.verdictOf(result([step('G3', 'PASS'), step('G11', 'WARN'), step('G12', 'SKIPPED', { optional: true })])),
    ).toBe('PASS');
  });

  it('FAIL on a failed or not-run step, a leak delta, tracked drift or an interrupted run', () => {
    expect(lib.verdictOf(result([step('G3', 'FAIL')]))).toBe('FAIL');
    expect(lib.verdictOf(result([step('G3', 'PASS'), step('G4', 'NOT RUN')]))).toBe('FAIL');
    expect(lib.verdictOf(result([step('G3', 'PASS')], { leaks: [{ name: 'x', before: 0, after: 1, delta: 1 }] }))).toBe(
      'FAIL',
    );
    expect(lib.verdictOf(result([step('G3', 'PASS')], { cleanup: { drift: [' M a'] } }))).toBe('FAIL');
    expect(lib.verdictOf(result([step('G3', 'PASS')], { interrupted: true }))).toBe('FAIL');
  });

  it('INCOMPLETE when nothing failed but a required step was skipped', () => {
    expect(lib.verdictOf(result([step('G3', 'PASS'), step('G4', 'SKIPPED')]))).toBe('INCOMPLETE');
  });

  it('renders the sections of the report with the verdict line', () => {
    const text = lib.renderReport(
      result(
        [
          step('G3', 'FAIL', { class: 'T', note: 'one row', counts: { tests: { passed: 5, failed: 1, skipped: 0 } } }),
          step('G7', 'SKIPPED', { note: '--skip G7' }),
        ],
        {
          failedFiles: [{ file: 'a.test.ts', step: 'G3', class: 'T', passesAlone: true, owner: '' }],
          flakes: [{ step: 'G4', file: 'b.test.ts', class: 'T' }],
          leaks: [{ name: 'conhost', before: 2, after: 3, delta: 1 }],
        },
      ),
    );
    for (const heading of [
      '## Commit',
      '## Tool versions',
      '## Machine state',
      '## Gates',
      '## Failed files',
      '## Flakes',
      '## Leaks',
      '## Cleanup',
      '## Verdict',
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain(SHA);
    expect(text).toContain('| G3 | title G3 | FAIL [class T] (one row) | tests 5 passed, 1 failed, 0 skipped | 10 |');
    expect(text).toContain('| a.test.ts | G3 | T | yes | unassigned |');
    expect(text).toContain('| conhost | 2 | 3 | 1 |');
    expect(text).toContain('Verdict: FAIL');
    expect(text).toContain('skills/demo');
  });

  it('renders a clean run: no failed files, a PASS verdict, no personal paths of the report folder', () => {
    const text = lib.renderReport(result([step('G3', 'PASS')]));
    expect(text).toContain('Verdict: PASS');
    expect(text).toMatch(/## Failed files\s+none/);
  });
});

// ---- the runner with a fake tool runner -------------------------------------------------------------------------------------------

const CI_ROWS = [
  'format:check',
  'lint',
  'typecheck',
  'check:deps',
  'build',
  'test',
  'test:pty',
  'smoke',
  'bundle:check',
  'smoke:bundle',
];
const ciText = (overrides: Record<string, string> = {}): string =>
  ['| gate | result | ms |', '|---|---|---|', ...CI_ROWS.map((r) => `| ${r} | ${overrides[r] ?? 'PASS'} | 3 |`)].join(
    '\n',
  );

let root = '';
let repo = '';
let out = '';
let stdout = '';
let stderr = '';
let calls: Call[] = [];
let machine: { cpu: number; listeners: number[]; conhost: number; temp: number };

type Answer = { code?: number; text?: string } | undefined;
type Script = (call: Call, nth: number) => Answer;

function fakeIo(script: Script = () => undefined, extra: Partial<RunnerIo> = {}): Partial<RunnerIo> {
  const seen = new Map<string, number>();
  return {
    run: (spec) =>
      Promise.resolve(
        ((): { code: number; text: string; ms: number } => {
          const call: Call = { tool: spec.tool, args: spec.args, cwd: spec.cwd, env: spec.env };
          calls.push(call);
          const key = `${call.tool} ${call.args.join(' ')} @${call.cwd}`;
          const nth = (seen.get(key) ?? 0) + 1;
          seen.set(key, nth);
          const scripted = script(call, nth);
          if (scripted !== undefined) return { code: scripted.code ?? 0, text: scripted.text ?? '', ms: 1 };
          const line = `${call.tool} ${call.args.join(' ')}`;
          if (line.startsWith('git rev-parse')) return { code: 0, text: `${SHA}\n`, ms: 1 };
          if (line === 'npm --version') return { code: 0, text: '11.0.0\n', ms: 1 };
          if (line === 'git --version') return { code: 0, text: 'git version 2.45.0.windows.1\n', ms: 1 };
          if (call.args[0] === 'scripts/ci.mjs') return { code: 0, text: ciText(), ms: 1 };
          if (call.env['MCS_SHOTS_DIR'] !== undefined && line.includes('playwright')) {
            mkdirSync(call.env['MCS_SHOTS_DIR'], { recursive: true });
            writeFileSync(
              join(call.env['MCS_SHOTS_DIR'], 'index.json'),
              JSON.stringify({
                version: 1,
                files: [
                  {
                    view: 'home',
                    viewport: '1440x900',
                    theme: 'light',
                    status: 'ok',
                    consoleErrors: 0,
                    measure: { pageOverflowX: 0 },
                  },
                ],
              }),
            );
          }
          return { code: 0, text: '', ms: 1 };
        })(),
      ),
    probe: {
      cpu: () => Promise.resolve(machine.cpu),
      freeMemMb: () => 4096,
      listeners: () => [...machine.listeners],
      processes: () =>
        Array.from({ length: machine.conhost }, (_, i) => ({
          pid: i + 1,
          name: 'conhost.exe',
          command: 'conhost.exe 0x4',
        })),
      tempFolders: () => machine.temp,
    },
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    platform: 'win32',
    findSkill: () => 'skills/demo',
    listPython: () => [],
    signals: { on: () => undefined, off: () => undefined },
    ...extra,
  };
}

async function gate(args: string[], io: Partial<RunnerIo>): Promise<number> {
  return runner.runGateClean(['--out', out, '--repo', repo, ...args], io);
}

function report(): Report {
  return JSON.parse(readFileSync(join(out, 'gate-report.json'), 'utf8')) as Report;
}
const statuses = (): Record<string, string> => Object.fromEntries(report().steps.map((s) => [s.id, s.status]));
const WORKTREE = (): string => join(root, 'caw-qa-wt');
const lines = (): string[] => calls.map((c) => `${c.tool} ${c.args.join(' ')}`);
/** The calls of the plan's commands: not git and not the version probes of the preflight. */
const stepCalls = (): Call[] => calls.filter((c) => c.tool !== 'git' && c.args[0] !== '--version');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcs-gate-clean-'));
  repo = join(root, 'repo');
  out = join(root, 'out');
  mkdirSync(repo, { recursive: true });
  stdout = '';
  stderr = '';
  calls = [];
  machine = { cpu: 10, listeners: [7690], conhost: 2, temp: 3 };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runGateClean with a fake tool runner', () => {
  it('runs G0 to G13 in the worktree and writes a PASS report (exit 0)', async () => {
    expect(await gate([], fakeIo())).toBe(0);
    const r = report();
    expect(r.schema).toBe(lib.REPORT_SCHEMA);
    expect(r.schema).toBe('caw.gate/1');
    expect(r.verdict).toBe('PASS');
    expect(statuses()).toEqual({
      G0: 'PASS',
      G1: 'PASS',
      G2: 'PASS',
      G3: 'PASS',
      G4: 'PASS',
      G5: 'PASS',
      G6: 'PASS',
      G7: 'PASS',
      G8: 'PASS',
      G9: 'PASS',
      G10: 'PASS',
      G11: 'PASS',
      G12: 'SKIPPED',
      G13: 'PASS',
    });
    expect(r.commit).toMatchObject({ ref: 'HEAD', sha: SHA, skill: 'skills/demo' });
    expect(existsSync(join(out, 'gate-report.md'))).toBe(true);
    expect(readFileSync(join(out, 'gate-report.md'), 'utf8')).toContain('Verdict: PASS');
    expect(existsSync(join(out, 'G3-ci.log'))).toBe(true);
  });

  it('adds the worktree at the resolved commit, runs the plan in worktree/runtime, then removes the worktree', async () => {
    await gate([], fakeIo());
    const all = lines();
    expect(all).toContain(`git worktree add --detach ${WORKTREE()} ${SHA}`);
    expect(all.indexOf('npm ci --prefer-offline')).toBeGreaterThan(
      all.indexOf(`git worktree add --detach ${WORKTREE()} ${SHA}`),
    );
    const order = [
      'npm ci --prefer-offline',
      'node scripts/ci.mjs --offline --bundle --keep-going',
      'npm run test:tooling',
      'npm run test:isolation',
      'npm run test:resilience',
      'node scripts/test-pty.mjs',
      'node scripts/pty-soak.mjs --runs 3',
      'npm run schemas:check',
    ];
    expect(order.map((l) => all.indexOf(l))).toEqual([...order.map((l) => all.indexOf(l))].sort((a, b) => a - b));
    for (const call of stepCalls()) {
      expect(call.cwd).toBe(join(WORKTREE(), 'runtime'));
      expect(call.env['VITEST_MAX_WORKERS']).toBe('3');
      expect(call.env['QA_PTY_REQUIRED']).toBe('1');
    }
    expect(all.at(-2)).toBe(`git worktree remove --force ${WORKTREE()}`);
    expect(all.at(-1)).toBe('git worktree prune');
    expect(report().cleanup.state).toBe('removed');
  });

  it('--keep leaves the worktree and says so; --workers reaches every command; --worktree names the folder', async () => {
    const wt = join(root, 'elsewhere');
    await gate(['--keep', '--workers', '2', '--worktree', wt], fakeIo());
    expect(lines().filter((l) => l.startsWith('git worktree remove'))).toHaveLength(0);
    expect(stepCalls().every((c) => c.env['VITEST_MAX_WORKERS'] === '2')).toBe(true);
    expect(report().cleanup.state).toMatch(/kept/);
  });

  it('a dry run that skips every heavy step writes an INCOMPLETE report, exit 3, and runs no tool but git and the version probes', async () => {
    const skip = 'install,ci,tooling,isolation,resilience,pty,contracts,browser,shots,bench,docker,leaks';
    expect(await gate(['--skip', skip], fakeIo())).toBe(3);
    const r = report();
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.steps.filter((s) => s.status === 'SKIPPED')).toHaveLength(12);
    expect(calls.filter((c) => c.tool === 'node' || (c.tool === 'npm' && c.args[0] !== '--version'))).toEqual([]);
    expect(readFileSync(join(out, 'gate-report.md'), 'utf8')).toContain('Verdict: INCOMPLETE');
  });

  it('stops after a failed install: the later steps are NOT RUN, the verdict is FAIL (exit 1)', async () => {
    const code = await gate(
      [],
      fakeIo((c) => (c.tool === 'npm' && c.args[0] === 'ci' ? { code: 1, text: 'npm error code E500' } : undefined)),
    );
    expect(code).toBe(1);
    expect(statuses()).toMatchObject({ G2: 'FAIL', G3: 'NOT RUN', G13: 'NOT RUN' });
    expect(lines()).toContain(`git worktree remove --force ${WORKTREE()}`);
  });

  it('G3 fails on a FAIL row of the ci table but the run goes on with G4 to G13', async () => {
    const code = await gate(
      [],
      fakeIo((c) =>
        c.args[0] === 'scripts/ci.mjs' ? { code: 1, text: ciText({ lint: 'FAIL (exit 1)' }) } : undefined,
      ),
    );
    expect(code).toBe(1);
    expect(statuses()).toMatchObject({ G3: 'FAIL', G4: 'PASS', G13: 'PASS' });
    expect(report().steps.find((s) => s.id === 'G3')?.note).toMatch(/row lint: FAIL/);
  });

  it('G3 fails when ci exits 0 but a required row is missing', async () => {
    await gate(
      [],
      fakeIo((c) =>
        c.args[0] === 'scripts/ci.mjs' ? { text: ciText().replace('| smoke:bundle | PASS | 3 |', '') } : undefined,
      ),
    );
    expect(statuses()['G3']).toBe('FAIL');
  });

  it('records the counts of the vitest summary in the step', async () => {
    await gate(
      [],
      fakeIo((c) =>
        c.args.join(' ') === 'run test:tooling'
          ? { text: ' Test Files  2 passed (2)\n      Tests  7 passed (7)\n' }
          : undefined,
      ),
    );
    expect(report().steps.find((s) => s.id === 'G4')?.counts).toMatchObject({
      tests: { passed: 7, failed: 0, total: 7 },
    });
  });

  it('off Windows the pty step is SKIPPED (exit 77), the ci row may be SKIPPED, the verdict is INCOMPLETE', async () => {
    const code = await gate(
      [],
      fakeIo(
        (c) => {
          if (c.args[0] === 'scripts/test-pty.mjs') return { code: 77, text: 'test:pty: SKIPPED on linux-x64' };
          if (c.args[0] === 'scripts/ci.mjs') return { text: ciText({ 'test:pty': 'SKIPPED (exit 77)' }) };
          if (c.args.join(' ') === 'run test:e2e:terminal') return { code: 77 };
          return undefined;
        },
        { platform: 'linux' },
      ),
    );
    expect(code).toBe(3);
    expect(statuses()).toMatchObject({ G3: 'PASS', G7: 'SKIPPED', G9: 'PASS' });
    expect(lines()).not.toContain('node scripts/pty-soak.mjs --runs 3');
  });

  it('on Windows an exit 77 of the pty gate is a FAIL, and zero skipped is the gate itself', async () => {
    await gate(
      [],
      fakeIo((c) => (c.args[0] === 'scripts/test-pty.mjs' ? { code: 77 } : undefined)),
    );
    expect(statuses()['G7']).toBe('FAIL');
  });

  it('runs both Playwright configs even when the first fails', async () => {
    await gate(
      [],
      fakeIo((c) =>
        c.args.includes('packages/web/e2e/playwright.config.ts')
          ? { code: 1, text: 'Error: browserType.launch: Executable' }
          : undefined,
      ),
    );
    expect(statuses()['G9']).toBe('FAIL');
    expect(report().steps.find((s) => s.id === 'G9')?.class).toBe('X');
    expect(lines()).toContain('npm run test:e2e:terminal');
  });

  describe('the flake rule (4.5)', () => {
    const failingTooling =
      (alone: number, second: number): Script =>
      (c, nth) => {
        if (c.args.join(' ') === 'run test:tooling') {
          return nth === 1
            ? {
                code: 1,
                text: ' FAIL  |tooling| tests/tooling/x.test.ts > suite > case\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 9 passed (10)\n Error: Test timed out in 10000ms.',
              }
            : { code: second };
        }
        if (c.args.includes('tests/tooling/x.test.ts')) return { code: alone };
        return undefined;
      };

    it('re-runs a failed file alone with its project, then the project once: green twice is PASS with the flake in the report', async () => {
      expect(await gate([], fakeIo(failingTooling(0, 0)))).toBe(0);
      const r = report();
      expect(r.steps.find((s) => s.id === 'G4')).toMatchObject({ status: 'PASS' });
      expect(r.steps.find((s) => s.id === 'G4')?.note).toMatch(/flaky/);
      expect(r.flakes).toEqual([{ step: 'G4', file: 'tests/tooling/x.test.ts', class: 'T' }]);
      expect(r.failedFiles).toEqual([
        { file: 'tests/tooling/x.test.ts', step: 'G4', class: 'T', passesAlone: true, owner: '' },
      ]);
      expect(lines()).toContain('node node_modules/vitest/vitest.mjs run --project tooling tests/tooling/x.test.ts');
      expect(lines().filter((l) => l === 'npm run test:tooling')).toHaveLength(2);
      expect(readFileSync(join(out, 'gate-report.md'), 'utf8')).toContain('## Flakes');
    });

    it('the same file failing again in the second whole run is a FAIL', async () => {
      expect(await gate([], fakeIo(failingTooling(0, 1)))).toBe(1);
      expect(statuses()['G4']).toBe('FAIL');
      expect(report().flakes).toEqual([]);
    });

    it('a file that fails alone is a plain failure: no second whole run', async () => {
      expect(await gate([], fakeIo(failingTooling(1, 0)))).toBe(1);
      expect(statuses()['G4']).toBe('FAIL');
      expect(report().failedFiles[0]).toMatchObject({ passesAlone: false, class: 'T' });
      expect(lines().filter((l) => l === 'npm run test:tooling')).toHaveLength(1);
    });
  });

  it('leaks: a new listener, a console host or a temp folder after the run fails G13 and the verdict', async () => {
    const code = await gate(
      [],
      fakeIo((c) => {
        if (c.args[0] === 'scripts/pty-soak.mjs') {
          machine.listeners.push(18004);
          machine.conhost += 1;
          machine.temp += 2;
        }
        return undefined;
      }),
    );
    expect(code).toBe(1);
    expect(statuses()['G13']).toBe('FAIL');
    const rows = Object.fromEntries(report().leaks.map((r) => [r.name, r.delta]));
    expect(rows).toMatchObject({ conhost: 1, 'temp folders mcs-*': 2, 'listeners 18000-18999, 7690': 1 });
    expect(report().steps.find((s) => s.id === 'G13')?.note).toMatch(/conhost \+1/);
  });

  it('a tracked file changed by the run is a FAIL of G13 (the worktree must stay clean)', async () => {
    const code = await gate(
      [],
      fakeIo((c) =>
        c.tool === 'git' && c.args[0] === 'status' && c.cwd === WORKTREE()
          ? { text: ' M skills/demo/bundle/mcs-cli.mjs\n' }
          : undefined,
      ),
    );
    expect(code).toBe(1);
    expect(report().cleanup.drift).toEqual(['M skills/demo/bundle/mcs-cli.mjs']);
  });

  it('a dirty tracked tree at the start fails G0 and nothing else runs', async () => {
    const code = await gate(
      [],
      fakeIo((c) => (c.tool === 'git' && c.args[0] === 'status' ? { text: ' M a.txt\n' } : undefined)),
    );
    expect(code).toBe(1);
    expect(statuses()).toMatchObject({ G0: 'FAIL', G1: 'NOT RUN', G13: 'NOT RUN' });
    expect(lines().some((l) => l.startsWith('git worktree add'))).toBe(false);
  });

  it('an unknown ref fails G0 with its name', async () => {
    const code = await gate(
      ['--ref', 'nope'],
      fakeIo((c) => (c.args[0] === 'rev-parse' ? { code: 1 } : undefined)),
    );
    expect(code).toBe(1);
    expect(report().steps[0]?.note).toMatch(/unknown ref nope/);
  });

  it('runs the commands with QA_TIME_SCALE=2 when the CPU mean is above 60 percent', async () => {
    machine.cpu = 75;
    await gate([], fakeIo());
    expect(report().options.timeScale).toBe(2);
    expect(stepCalls().every((c) => c.env['QA_TIME_SCALE'] === '2')).toBe(true);
    expect(report().machine.start?.cpuPercent).toBe(75);
  });

  it('leaves QA_TIME_SCALE unset on a quiet machine', async () => {
    await gate([], fakeIo());
    expect(stepCalls().some((c) => c.env['QA_TIME_SCALE'] !== undefined)).toBe(false);
  });

  it('G8 fails when a Python file is tracked, and says which', async () => {
    await gate([], fakeIo(undefined, { listPython: () => ['tools/a' + '.py'] }));
    expect(statuses()['G8']).toBe('FAIL');
    expect(report().steps.find((s) => s.id === 'G8')?.note).toContain('tools/a' + '.py');
  });

  it('G10 reads index.json of the shots folder: a failed picture fails the step, a missing index too', async () => {
    await gate(
      [],
      fakeIo((c) => {
        if (c.env['MCS_SHOTS_DIR'] !== undefined && c.tool === 'node') {
          mkdirSync(c.env['MCS_SHOTS_DIR'], { recursive: true });
          writeFileSync(
            join(c.env['MCS_SHOTS_DIR'], 'index.json'),
            JSON.stringify({
              version: 1,
              files: [{ view: 'home', status: 'failed', consoleErrors: 0, measure: null }],
            }),
          );
          return { code: 0 };
        }
        return undefined;
      }),
    );
    expect(statuses()['G10']).toBe('FAIL');
    rmSync(out, { recursive: true, force: true });
    await gate(
      [],
      fakeIo((c) => (c.env['MCS_SHOTS_DIR'] !== undefined && c.tool === 'node' ? { code: 0 } : undefined)),
    );
    expect(report().steps.find((s) => s.id === 'G10')).toMatchObject({ status: 'FAIL' });
    expect(report().steps.find((s) => s.id === 'G10')?.note).toMatch(/index\.json/);
  });

  it('a failing bench is WARN (report only) and does not fail the verdict', async () => {
    expect(
      await gate(
        [],
        fakeIo((c) => (c.args[1] === 'bench:terminal' ? { code: 1, text: 'budget exceeded' } : undefined)),
      ),
    ).toBe(0);
    expect(statuses()['G11']).toBe('WARN');
    expect(report().verdict).toBe('PASS');
  });

  it('--with-docker runs the harness; a Docker that is down is WARN, any other failure is FAIL', async () => {
    const docker =
      (text: string): Script =>
      (c) =>
        c.args[1] === 'docker:posix' ? { code: 1, text } : undefined;
    expect(await gate(['--with-docker'], fakeIo(docker('Cannot connect to the Docker daemon')))).toBe(0);
    expect(statuses()['G12']).toBe('WARN');
    rmSync(out, { recursive: true, force: true });
    expect(await gate(['--with-docker'], fakeIo(docker('AssertionError: a gate failed in the container')))).toBe(1);
    expect(statuses()['G12']).toBe('FAIL');
  });

  it('refuses a missing --out, an --out inside the repository, a worktree inside the repository and a skipped G0 (exit 2)', async () => {
    expect(await runner.runGateClean(['--repo', repo], fakeIo())).toBe(2);
    expect(stderr).toMatch(/--out/);
    expect(await runner.runGateClean(['--repo', repo, '--out', join(repo, 'out')], fakeIo())).toBe(2);
    expect(stderr).toMatch(/outside the repository/);
    expect(await gate(['--worktree', join(repo, 'wt')], fakeIo())).toBe(2);
    expect(await gate(['--skip', 'G0'], fakeIo())).toBe(2);
    expect(calls).toEqual([]);
  });

  it('cleans up and exits 130 when interrupted', async () => {
    const listeners = new Map<string, () => void>();
    const code = await gate(
      [],
      fakeIo(
        (c) => {
          if (c.args[0] === 'scripts/ci.mjs') listeners.get('SIGINT')?.();
          return undefined;
        },
        {
          signals: {
            on: (name: string, fn: () => void) => void listeners.set(name, fn),
            off: () => undefined,
          },
        },
      ),
    );
    expect(code).toBe(130);
    expect(report().verdict).toBe('FAIL');
    expect(statuses()['G13']).toBe('NOT RUN');
    expect(report().cleanup.state).toBe('removed');
  });

  it('keeps no secret or home path in the report: tool versions only, the worktree path and relative log names', async () => {
    await gate([], fakeIo());
    const text = readFileSync(join(out, 'gate-report.md'), 'utf8');
    expect(text).not.toContain(out);
  });
});

// ---- helpers on the file system and the real runner --------------------------------------------------------------------------------

describe('file system helpers', () => {
  it('findSkillFolder scans skills/*/SKILL.md, whatever the folder is called', () => {
    mkdirSync(join(root, 'skills', 'zeta'), { recursive: true });
    mkdirSync(join(root, 'skills', 'alpha-skill'), { recursive: true });
    mkdirSync(join(root, 'skills', 'no-skill-file'), { recursive: true });
    writeFileSync(join(root, 'skills', 'alpha-skill', 'SKILL.md'), '---\n---\n');
    writeFileSync(join(root, 'skills', 'zeta', 'SKILL.md'), '---\n---\n');
    expect(runner.findSkillFolder(root)).toBe('skills/alpha-skill');
    expect(runner.findSkillFolder(join(root, 'missing'))).toBeNull();
    expect(runner.findSkillFolder(join(root, 'skills', 'no-skill-file'))).toBeNull();
  });

  it('listPythonFiles finds Python files below the root and skips node_modules and .git', () => {
    for (const dir of ['a/b', 'node_modules/p', '.git/x', 'runtime']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'a', 'b', j('t', '.py')), '');
    writeFileSync(join(root, 'node_modules', 'p', j('t', '.py')), '');
    writeFileSync(join(root, '.git', 'x', j('t', '.py')), '');
    writeFileSync(join(root, 'runtime', 'ok.mjs'), '');
    expect(runner.listPythonFiles(root)).toEqual(['a/b/' + j('t', '.py')]);
    expect(runner.listPythonFiles(join(root, 'missing'))).toEqual([]);
  });

  it('makeRunner runs a tool, appends its output to the log and returns the code and the output', async () => {
    const logFile = join(root, 'step.log');
    const result = await runner.makeRunner().run({
      tool: 'node',
      args: ['-e', 'console.log("hello"); process.exit(3)'],
      cwd: root,
      env: {},
      logFile,
    });
    expect(result.code).toBe(3);
    expect(result.text.trim()).toBe('hello');
    expect(readFileSync(logFile, 'utf8').trim()).toBe('hello');
  });

  it('makeRunner answers 127 for a tool that does not exist', async () => {
    const result = await runner.makeRunner().run({ tool: 'mcs-no-such-tool', args: [], cwd: root, env: {} });
    expect(result.code).toBe(127);
  });
});

// ---- real git on a throw-away repository -------------------------------------------------------------------------------------------

describe('runGateClean with real git on a throw-away repository', () => {
  function git(args: string[], cwd = repo): string {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function makeRepo(): string {
    mkdirSync(join(repo, 'runtime'), { recursive: true });
    mkdirSync(join(repo, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(repo, 'runtime', 'package.json'), '{}\n');
    writeFileSync(join(repo, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo\n---\n');
    git(['init', '-q']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    return git(['rev-parse', 'HEAD']);
  }

  const heavy = 'install,ci,tooling,isolation,resilience,pty,contracts,browser,shots,bench,docker';
  const realIo = (): Partial<RunnerIo> => ({
    probe: fakeIo().probe!,
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    signals: { on: () => undefined, off: () => undefined },
  });

  it('checks the commit out, finds the skill folder, runs the leak step and removes the worktree', async () => {
    const sha = makeRepo();
    const wt = join(root, 'wt');
    expect(await gate(['--skip', heavy, '--worktree', wt], realIo())).toBe(3);
    const r = report();
    expect(r.verdict).toBe('INCOMPLETE');
    expect(statuses()).toMatchObject({ G0: 'PASS', G1: 'PASS', G13: 'PASS' });
    expect(r.commit).toMatchObject({ sha, skill: 'skills/demo-skill' });
    expect(r.cleanup.state).toBe('removed');
    expect(existsSync(wt)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'])).not.toContain('wt');
  }, 60_000);

  it('--keep leaves the checkout of the commit in place; a second run replaces that registered worktree', async () => {
    makeRepo();
    const wt = join(root, 'wt');
    expect(await gate(['--skip', heavy, '--worktree', wt, '--keep'], realIo())).toBe(3);
    expect(existsSync(join(wt, 'runtime', 'package.json'))).toBe(true);
    expect(await gate(['--skip', heavy, '--worktree', wt], realIo())).toBe(3);
    expect(existsSync(wt)).toBe(false);
  }, 60_000);

  it('refuses a worktree folder that exists, holds files and is not a worktree of the repository', async () => {
    makeRepo();
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, 'precious.txt'), 'keep');
    expect(await gate(['--skip', heavy, '--worktree', wt], realIo())).toBe(1);
    expect(report().steps.find((s) => s.id === 'G1')?.note).toMatch(/not a worktree of this repository/);
    expect(readFileSync(join(wt, 'precious.txt'), 'utf8')).toBe('keep');
  }, 60_000);

  it('a repository with an uncommitted change to a tracked file fails the preflight', async () => {
    makeRepo();
    writeFileSync(join(repo, 'runtime', 'package.json'), '{"changed":true}\n');
    expect(await gate(['--skip', heavy, '--worktree', join(root, 'wt')], realIo())).toBe(1);
    expect(statuses()['G0']).toBe('FAIL');
  }, 60_000);
});
