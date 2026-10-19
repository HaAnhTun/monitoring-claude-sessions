// `scripts/ci.mjs` (05 section 8.1) driven with stub tools in a throw-away workspace: gate order, `--offline`, `--full`,
// `--keep-going`, the "cannot run yet" exit code 77 and `--strict`. CI is local only (ADR 0078): there is no workflow file to check.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');

// ---- stub workspace -------------------------------------------------------------------------------------------------

/**
 * A tool stub: logs `<tool> <args>` to the log file and exits with the code configured for its key. The key is the tool
 * name, with `@ARGS` replaced by `slow` or the first argument (so `vitest:run`, `vitest:slow`, `npm:run`, `npm:audit`).
 */
function stubSource(name: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `const key = ${JSON.stringify(name)}.replace('@ARGS', args.includes('slow') ? 'slow' : args[0] ?? '');`,
    "appendFileSync(process.env.STUB_LOG, `${key.split(':')[0]} ${args.join(' ')}\\n`);",
    "const codes = JSON.parse(process.env.STUB_CODES ?? '{}');",
    'process.exit(codes[key] ?? 0);',
    '',
  ].join('\n');
}

const TOOLS: readonly (readonly [dir: string, bin: string, key: string])[] = [
  ['prettier', 'bin/prettier.js', 'prettier'],
  ['eslint', 'bin/eslint.js', 'eslint'],
  ['vitest', 'vitest.mjs', 'vitest:@ARGS'],
];

let root = '';
let logFile = '';

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'mcs-ci-script-'));
  logFile = join(root, 'stub.log');
  writeFileSync(logFile, '');
  mkdirSync(join(root, 'scripts'));
  for (const name of ['ci.mjs', 'lib.mjs']) cpSync(join(RUNTIME, 'scripts', name), join(root, 'scripts', name));
  for (const [dir, bin, key] of TOOLS) {
    mkdirSync(dirname(join(root, 'node_modules', dir, bin)), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', dir, 'package.json'),
      JSON.stringify({ name: dir, type: 'module', bin: bin }),
    );
    writeFileSync(join(root, 'node_modules', dir, bin), stubSource(key));
  }
  mkdirSync(join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '@playwright', 'test', 'package.json'),
    JSON.stringify({ name: '@playwright/test', type: 'module', bin: { playwright: 'cli.js' } }),
  );
  writeFileSync(join(root, 'node_modules', '@playwright', 'test', 'cli.js'), stubSource('playwright'));
  writeFileSync(join(root, 'scripts', 'typecheck.mjs'), stubSource('typecheck'));
  writeFileSync(join(root, 'scripts', 'check-deps.mjs'), stubSource('check-deps'));
  writeFileSync(join(root, 'scripts', 'smoke.mjs'), stubSource('smoke'));
  writeFileSync(join(root, 'scripts', 'bundle.mjs'), stubSource('bundle'));
  mkdirSync(join(root, 'npm'));
  writeFileSync(join(root, 'npm', 'npm-cli.mjs'), stubSource('npm:@ARGS'));
  return root;
}

interface CiRun {
  status: number | null;
  rows: Map<string, string>;
  order: string[];
  notRun: string | null;
  calls: string[];
  stdout: string;
}

function runCi(args: readonly string[], codes: Record<string, number> = {}): CiRun {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'ci.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      // Windows environment names are case-insensitive: drop every spelling of npm_execpath that the parent has.
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'npm_execpath')),
      npm_execpath: join(root, 'npm', 'npm-cli.mjs'),
      STUB_LOG: logFile,
      STUB_CODES: JSON.stringify(codes),
    },
  });
  const rows = new Map<string, string>();
  const order: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\| (\S+) \| (.+) \| (\d+) \|$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[1] !== 'gate') {
      rows.set(match[1], match[2]);
      order.push(match[1]);
    }
  }
  const notRun = /^not run: (.*)$/m.exec(result.stdout)?.[1] ?? null;
  const calls = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  return { status: result.status, rows, order, notRun, calls, stdout: result.stdout };
}

beforeEach(() => {
  makeRoot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// `build` runs before `test`: about 150 tests spawn `dist/main.js`, `dist/hook.js` or `dist/boot.js` and read `.mcs-build.json`.
const GATES = ['format:check', 'lint', 'typecheck', 'check:deps', 'build', 'test', 'smoke', 'audit'];

describe('scripts/ci.mjs', () => {
  it('runs the gates of 05 section 8.1 in order and exits 0 when all pass', () => {
    const run = runCi([]);
    expect(run.order).toEqual(GATES);
    expect([...run.rows.values()]).toEqual(GATES.map(() => 'PASS'));
    expect(run.notRun).toBeNull();
    expect(run.status).toBe(0);
  });

  it('passes each tool its documented arguments', () => {
    const run = runCi([]);
    expect(run.calls).toEqual([
      'prettier --check . --log-level warn',
      'eslint . --max-warnings 0',
      'typecheck ',
      'check-deps ',
      'npm run build',
      'vitest run --project unit --project web --project integration --project isolation --project resilience',
      'smoke ',
      'npm audit --audit-level=low',
    ]);
  });

  it('--offline leaves out the audit', () => {
    const run = runCi(['--offline']);
    expect(run.order).toEqual(GATES.filter((gate) => gate !== 'audit'));
    expect(run.status).toBe(0);
  });

  it('--full adds the slow and e2e gates after the others, ending test:slow, test:e2e', () => {
    const run = runCi(['--full', '--offline']);
    expect(run.order).toEqual([...GATES.filter((gate) => gate !== 'audit'), 'test:slow', 'test:e2e']);
    expect(run.order).not.toContain('test:parity');
    expect(run.calls.slice(-2)).toEqual([
      'vitest run --project slow',
      'playwright test -c packages/web/e2e/playwright.config.ts',
    ]);
    expect(run.status).toBe(0);
  });

  it('--bundle adds bundle:check and the smoke through the bundle after smoke', () => {
    const run = runCi(['--bundle', '--offline']);
    expect(run.order).toEqual([...GATES.filter((gate) => gate !== 'audit'), 'bundle:check', 'smoke:bundle']);
    expect(run.calls.slice(-2)).toEqual(['bundle --check', 'smoke --bundle']);
    expect(run.status).toBe(0);
  });

  it('stops at the first failure and lists the gates that did not run', () => {
    const run = runCi([], { eslint: 1 });
    expect(run.order).toEqual(['format:check', 'lint']);
    expect(run.rows.get('lint')).toBe('FAIL (exit 1)');
    expect(run.notRun).toBe('typecheck, check:deps, build, test, smoke, audit');
    expect(run.status).toBe(1);
    expect(run.calls).toHaveLength(2);
  });

  it('--keep-going runs every gate, shows each failure with its exit code and still exits 1', () => {
    const run = runCi(['--keep-going', '--offline'], { eslint: 1, 'vitest:run': 3 });
    expect(run.order).toEqual(GATES.filter((gate) => gate !== 'audit'));
    expect(run.rows.get('lint')).toBe('FAIL (exit 1)');
    expect(run.rows.get('test')).toBe('FAIL (exit 3)');
    expect(run.rows.get('build')).toBe('PASS');
    expect(run.notRun).toBeNull();
    expect(run.status).toBe(1);
  });

  it('shows exit 77 of the smoke as SKIPPED, never as PASS, and still exits 0', () => {
    const run = runCi([], { smoke: 77 });
    expect(run.rows.get('smoke')).toBe('SKIPPED (exit 77)');
    expect(run.rows.get('audit')).toBe('PASS');
    expect(run.status).toBe(0);
  });

  it('--strict counts a skipped gate as a failure', () => {
    const run = runCi(['--strict'], { smoke: 77 });
    expect(run.rows.get('smoke')).toBe('SKIPPED (exit 77)');
    expect(run.status).toBe(1);
  });

  it('--strict passes when nothing is skipped', () => {
    expect(runCi(['--strict']).status).toBe(0);
  });

  it('reports a failing audit as FAIL with its exit code and a failing build as a stop', () => {
    const audit = runCi([], { 'npm:audit': 4 });
    expect(audit.rows.get('audit')).toBe('FAIL (exit 4)');
    expect(audit.status).toBe(1);
    const build = runCi([], { 'npm:run': 2 });
    expect(build.rows.get('build')).toBe('FAIL (exit 2)');
    expect(build.notRun).toBe('test, smoke, audit');
    expect(build.status).toBe(1);
  });

  it('builds before it tests: the tests that spawn dist/ need the build and its stamp', () => {
    const run = runCi(['--offline']);
    expect(run.order.indexOf('build')).toBeGreaterThan(-1);
    expect(run.order.indexOf('build')).toBeLessThan(run.order.indexOf('test'));
    expect(run.order.indexOf('test')).toBeLessThan(run.order.indexOf('smoke'));
    const vitestCall = run.calls.findIndex((call) => call.startsWith('vitest run --project unit'));
    expect(run.calls.indexOf('npm run build')).toBeLessThan(vitestCall);
  });

  it('under --keep-going a failed build is followed by a note that explains the dist-dependent test failures', () => {
    const failed = runCi(['--keep-going', '--offline'], { 'npm:run': 2 });
    expect(failed.rows.get('build')).toBe('FAIL (exit 2)');
    expect(failed.rows.has('test')).toBe(true);
    expect(failed.stdout).toMatch(/note: the build gate failed; tests that spawn dist\/ fail because of that/);
    const passed = runCi(['--keep-going', '--offline']);
    expect(passed.stdout).not.toMatch(/note: the build gate failed/);
  });
});
