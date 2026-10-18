// `scripts/ci.mjs` (05 section 8.1) driven with stub tools in a throw-away workspace: gate order, `--offline`, `--full`,
// `--keep-going`, the "cannot run yet" exit code 77, `--strict` and `--summary-json`. The second half checks the active GitHub
// workflow (ADR 0065): triggers, matrix, timeouts, pinned actions, token permissions and the commands it runs.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const SKILL = join(RUNTIME, '..');

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

// ---- the GitHub workflow ------------------------------------------------------------------------------------------------

type Yaml = unknown;
type YamlMap = Record<string, unknown>;

/** The string value of a parsed scalar, or an empty string for anything else. */
const text = (value: Yaml): string => (typeof value === 'string' ? value : '');

/**
 * Parses the YAML subset the workflow uses: comments, block maps and sequences, quoted and plain scalars, flow sequences.
 * Anything else (tabs, anchors, block scalars, odd indentation) throws, so "it parses" means the file stays in the subset.
 */
function parseYaml(text: string): Yaml {
  const lines: { indent: number; text: string }[] = [];
  for (const raw of text.split('\n')) {
    if (raw.includes('\t')) throw new Error('tab in YAML');
    const stripped = stripComment(raw).trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    if (indent % 2 !== 0) throw new Error(`odd indentation: ${raw}`);
    lines.push({ indent, text: stripped.trimStart() });
  }
  let index = 0;

  function parseBlock(indent: number): Yaml {
    const first = lines[index];
    if (first === undefined) throw new Error('unexpected end');
    return first.text.startsWith('- ') || first.text === '-' ? parseSequence(indent) : parseMap(indent);
  }

  function parseSequence(indent: number): Yaml {
    const items: Yaml[] = [];
    const itemAt = () => {
      const candidate = lines[index];
      return candidate?.indent === indent && candidate.text.startsWith('-') ? candidate : undefined;
    };
    for (let line = itemAt(); line !== undefined; line = itemAt()) {
      const rest = line.text.slice(1).trimStart();
      if (rest === '') {
        index += 1;
        items.push(parseBlock(indent + 2));
      } else if (/^[A-Za-z_][\w-]*:(\s|$)/.test(rest)) {
        // `- key: value` opens a map whose further keys sit at indent + 2
        lines[index] = { indent: indent + 2, text: rest };
        items.push(parseMap(indent + 2));
      } else {
        index += 1;
        items.push(parseScalar(rest));
      }
    }
    return items;
  }

  function parseMap(indent: number): Yaml {
    const map: YamlMap = {};
    const entryAt = () => {
      const candidate = lines[index];
      return candidate?.indent === indent ? candidate : undefined;
    };
    for (let line = entryAt(); line !== undefined; line = entryAt()) {
      const match = /^([^:\s][^:]*?):(?:\s+(.*))?$/.exec(line.text);
      if (match?.[1] === undefined) throw new Error(`not a map entry: ${line.text}`);
      const key = match[1];
      if (key in map) throw new Error(`duplicate key: ${key}`);
      index += 1;
      const value = match[2];
      if (value === undefined || value === '') {
        const next = lines[index];
        if (next !== undefined && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) {
          map[key] = parseBlock(next.indent);
        } else {
          map[key] = null;
        }
      } else {
        if (/^[|>&*!]/.test(value)) throw new Error(`unsupported YAML construct: ${value}`);
        map[key] = parseScalar(value);
      }
    }
    return map;
  }

  const result = parseBlock(0);
  if (index !== lines.length) throw new Error(`unparsed content near: ${lines[index]?.text ?? ''}`);
  return result;
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string): Yaml {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => parseScalar(part));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function asMap(value: Yaml, what: string): YamlMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not a map`);
  return value as YamlMap;
}

function asList(value: Yaml, what: string): Yaml[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}

const WORKFLOW = join(SKILL, '.github', 'workflows', 'ci.yml');
const ACTION_SHAS: Record<string, string> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node': '949feb2413d6458794dcd2491c4babbbce0c15c1',
  'actions/upload-artifact': 'cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'actions/download-artifact': '9000827ccba6bdab643e8b6fd33ac0654aef8333',
};
const JOBS = ['gates', 'gates-full', 'macos', 'e2e', 'report'];

function workflow(): YamlMap {
  return asMap(parseYaml(readFileSync(WORKFLOW, 'utf8')), 'workflow');
}

function job(name: string): YamlMap {
  return asMap(asMap(workflow()['jobs'], 'jobs')[name], name);
}

function allSteps(): { job: string; step: YamlMap }[] {
  const jobs = asMap(workflow()['jobs'], 'jobs');
  return Object.entries(jobs).flatMap(([name, body]) =>
    asList(asMap(body, name)['steps'], `${name}.steps`).map((step) => ({
      job: name,
      step: asMap(step, `${name} step`),
    })),
  );
}

function matrixCells(name: string): { os: string; node: string }[] {
  const strategy = job(name)['strategy'];
  if (strategy === undefined) return [];
  const matrix = asMap(asMap(strategy, 'strategy')['matrix'], 'matrix');
  if (matrix['include'] !== undefined) {
    return asList(matrix['include'], 'include').map((cell) => {
      const map = asMap(cell, 'cell');
      return { os: text(map['os']), node: text(map['node']) };
    });
  }
  const oses = asList(matrix['os'], 'os').map(text);
  const nodes = matrix['node'] === undefined ? [''] : asList(matrix['node'], 'node').map(text);
  return oses.flatMap((os) => nodes.map((node) => ({ os, node })));
}

describe('the YAML subset parser used below', () => {
  it('reads maps, sequences, flow lists, quotes and comments', () => {
    const parsed = parseYaml(
      ['a: 1 # c', 'b:', '  - x: "y # not a comment"', '    z: [1, "two"]', '  - plain', "c: 'q'", ''].join('\n'),
    );
    expect(parsed).toEqual({ a: 1, b: [{ x: 'y # not a comment', z: [1, 'two'] }, 'plain'], c: 'q' });
  });

  it.each([
    ['a tab', 'a:\n\tb: 1\n'],
    ['a block scalar', 'a: |\n  text\n'],
    ['a duplicate key', 'a: 1\na: 2\n'],
    ['odd indentation', 'a:\n   b: 1\n'],
  ])('rejects %s', (_label, source) => {
    expect(() => parseYaml(source)).toThrow();
  });
});

describe('the active workflow (ADR 0065)', () => {
  it('lives in .github/workflows; the inactive draft below runtime/ci is gone', () => {
    expect(existsSync(WORKFLOW)).toBe(true);
    expect(existsSync(join(RUNTIME, 'ci', 'github-actions-ci.yml'))).toBe(false);
  });

  it('parses and has the documented jobs, a read-only default token and the hook switch', () => {
    const doc = workflow();
    expect(doc['name']).toBe('ci');
    expect(Object.keys(asMap(doc['jobs'], 'jobs'))).toEqual(JOBS);
    expect(asMap(doc['permissions'], 'permissions')).toEqual({ contents: 'read' });
    expect(asMap(doc['env'], 'env')).toEqual({ MCS_HOOK_DISABLE: '1', TZ: 'UTC' });
  });

  it('runs on push to main and feat/** and on a manual dispatch with the boolean input full, never on pull requests', () => {
    const on = asMap(workflow()['on'], 'on');
    expect(Object.keys(on)).toEqual(['push', 'workflow_dispatch']);
    expect(asMap(on['push'], 'push')).toEqual({ branches: ['main', 'feat/**'] });
    const inputs = asMap(asMap(on['workflow_dispatch'], 'workflow_dispatch')['inputs'], 'inputs');
    expect(Object.keys(inputs)).toEqual(['full']);
    const full = asMap(inputs['full'], 'full');
    expect(full['type']).toBe('boolean');
    expect(full['default']).toBe(false);
    const code = readFileSync(WORKFLOW, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/pull_request|schedule:|repository_dispatch|workflow_run/);
  });

  it('cancels superseded runs of a ref and bounds every job to 20 minutes', () => {
    expect(asMap(workflow()['concurrency'], 'concurrency')).toEqual({
      group: 'ci-${{ github.ref }}',
      'cancel-in-progress': true,
    });
    for (const name of JOBS) expect(job(name)['timeout-minutes'], name).toBe(20);
  });

  it('has the matrix of each job: Ubuntu x Node 22.22/24/26 and Windows x 24 on push, the rest on demand', () => {
    expect(matrixCells('gates')).toEqual([
      { os: 'windows-latest', node: '24' },
      { os: 'ubuntu-latest', node: '22.22' },
      { os: 'ubuntu-latest', node: '24' },
      { os: 'ubuntu-latest', node: '26' },
    ]);
    expect(matrixCells('gates-full')).toEqual([
      { os: 'windows-latest', node: '22.22' },
      { os: 'windows-latest', node: '26' },
    ]);
    expect(job('macos')['runs-on']).toBe('macos-latest');
    expect(job('macos')['strategy']).toBeUndefined();
    expect(matrixCells('e2e').map((cell) => cell.os)).toEqual(['windows-latest', 'ubuntu-latest']);
    expect(job('report')['runs-on']).toBe('ubuntu-latest');
  });

  it('runs gates-full only on a full dispatch, e2e on a full dispatch or on main, report always but never for a pull request', () => {
    expect(job('gates')['if']).toBeUndefined();
    expect(job('macos')['if']).toBeUndefined();
    expect(job('gates-full')['if']).toBe("github.event_name == 'workflow_dispatch' && inputs.full");
    expect(job('e2e')['if']).toBe(
      "(github.event_name == 'workflow_dispatch' && inputs.full) || github.ref == 'refs/heads/main'",
    );
    expect(job('report')['if']).toBe(
      "always() && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    expect(job('report')['needs']).toEqual(['gates', 'gates-full', 'macos', 'e2e']);
    expect(job('report')['name']).toBe('ci-status');
  });

  it('pins every action by the verified 40-hex commit SHA and never persists credentials', () => {
    const uses = allSteps().filter(({ step }) => typeof step['uses'] === 'string');
    expect(uses.length).toBeGreaterThanOrEqual(10);
    for (const { job: name, step } of uses) {
      const ref = text(step['uses']);
      expect(ref, `${name}: ${ref}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      const [action, sha] = ref.split('@');
      expect(ACTION_SHAS[action ?? ''], `${name}: ${ref}`).toBe(sha);
      if (action === 'actions/checkout') {
        expect(asMap(step['with'], 'with')['persist-credentials'], `${name} checkout`).toBe(false);
      }
    }
  });

  it('uses no secret and gives write access only to the report job (contents: write, nothing else)', () => {
    const source = readFileSync(WORKFLOW, 'utf8');
    expect(source).not.toMatch(/secrets\./);
    expect(source.match(/:\s*write\b/g)).toEqual([': write']);
    for (const name of JOBS) {
      const permissions = job(name)['permissions'];
      if (name === 'report') expect(asMap(permissions, 'permissions')).toEqual({ contents: 'write' });
      else expect(permissions, name).toBeUndefined();
    }
    const publish = asList(job('report')['steps'], 'steps')
      .map((step) => asMap(step, 'step'))
      .find((step) => text(step['run']).includes('ci-status.mjs publish'));
    expect(asMap(publish?.['env'], 'env')).toEqual({ GITHUB_TOKEN: '${{ github.token }}' });
  });

  it('never expands an expression inside a run command (no script injection through refs or inputs)', () => {
    for (const { job: name, step } of allSteps()) {
      if (typeof step['run'] === 'string') expect(step['run'], name).not.toContain('${{');
    }
  });

  it('runs exactly the documented node, npm and npx commands', () => {
    const runs = allSteps().flatMap(({ job: name, step }) =>
      typeof step['run'] === 'string' ? [`${name}: ${step['run']}`] : [],
    );
    const summarizeGates = 'node scripts/ci-status.mjs summarize --in ci-summary.json --out ci-job.json';
    const summarizeOnly = 'node scripts/ci-status.mjs summarize --out ci-job.json';
    const gateRun = 'npm run ci -- --bundle --summary-json ci-summary.json';
    expect(runs).toEqual([
      'gates: npm ci',
      `gates: ${gateRun}`,
      `gates: ${summarizeGates}`,
      'gates-full: npm ci',
      `gates-full: ${gateRun}`,
      `gates-full: ${summarizeGates}`,
      'macos: npm ci',
      'macos: npm run build',
      'macos: npx vitest run --project unit packages/engine/src/platform',
      'macos: node scripts/smoke.mjs --bundle',
      `macos: ${summarizeOnly}`,
      'e2e: npm ci',
      'e2e: npx playwright install --with-deps chromium',
      'e2e: npx playwright install chromium',
      'e2e: npm run build',
      'e2e: npm run test:e2e',
      `e2e: ${summarizeOnly}`,
      'report: node scripts/ci-status.mjs publish --dir ../ci-jobs',
    ]);
    for (const run of runs) expect(run).toMatch(/^[\w-]+: (node|npm|npx) /);
    const scripts = (
      JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['ci']).toBe('node scripts/ci.mjs');
    expect(scripts['test:e2e']).toBe('playwright test -c packages/web/e2e/playwright.config.ts');
  });

  it('keeps macOS lean: no Playwright, only the platform tests and the bundle smoke', () => {
    const steps = asList(job('macos')['steps'], 'steps').map((step) => asMap(step, 'step'));
    expect(steps.some((step) => /playwright|test:e2e/.test(text(step['run'])))).toBe(false);
  });

  it('runs every job in the runtime folder and uploads one ci-job record per job for the report', () => {
    for (const name of JOBS) {
      const defaults = asMap(asMap(job(name)['defaults'], 'defaults')['run'], 'run');
      expect(defaults['working-directory'], name).toBe('runtime');
    }
    const uploads = allSteps().filter(
      ({ step }) =>
        text(step['uses']).startsWith('actions/upload-artifact@') &&
        text(asMap(step['with'], 'with')['name']).startsWith('ci-job-'),
    );
    expect(uploads.map(({ job: name }) => name)).toEqual(['gates', 'gates-full', 'macos', 'e2e']);
    for (const { step } of uploads) {
      expect(step['if']).toBe('always()');
      expect(asMap(step['with'], 'with')['path']).toBe('runtime/ci-job.json');
    }
    const download = allSteps().find(({ step }) => text(step['uses']).startsWith('actions/download-artifact@'));
    expect(download?.job).toBe('report');
    expect(asMap(download?.step['with'], 'with')).toEqual({ pattern: 'ci-job-*', path: 'ci-jobs' });
    const traces = allSteps().find(({ step }) =>
      text(asMap(step['with'] ?? {}, 'with')['name']).startsWith('e2e-traces'),
    );
    expect(traces?.step['if']).toBe('failure()');
    expect(asMap(traces?.step['with'], 'with')['path']).toBe('runtime/packages/web/e2e/test-results/');
    expect(readFileSync(join(SKILL, '.gitignore'), 'utf8')).toContain('runtime/packages/web/e2e/test-results/');
  });
});

// ---- ci.mjs --summary-json ----------------------------------------------------------------------------------------------

describe('scripts/ci.mjs --summary-json (mcs.ci-run/1)', () => {
  interface Summary {
    schema: string;
    result: string;
    gates: { name: string; result: string; ms: number }[];
    failedGate: string | null;
    tail: string[];
  }
  const summary = (): Summary => JSON.parse(readFileSync(join(root, 'out', 'summary.json'), 'utf8')) as Summary;

  it('writes a passing summary with every gate and its duration', () => {
    const run = runCi(['--offline', '--summary-json', 'out/summary.json']);
    expect(run.status).toBe(0);
    const doc = summary();
    expect(doc.schema).toBe('mcs.ci-run/1');
    expect(doc.result).toBe('pass');
    expect(doc.gates.map((gate) => gate.name)).toEqual(GATES.filter((gate) => gate !== 'audit'));
    expect(doc.gates.every((gate) => gate.result === 'pass' && Number.isInteger(gate.ms))).toBe(true);
    expect(doc.failedGate).toBeNull();
    expect(doc.tail).toEqual([]);
  });

  it('writes a failing summary with the failing gate, the gates that did not run and the tail of its output', () => {
    const run = runCi(['--offline', '--summary-json', 'out/summary.json'], { eslint: 1 });
    expect(run.status).toBe(1);
    const doc = summary();
    expect(doc.result).toBe('fail');
    expect(doc.failedGate).toBe('lint');
    expect(doc.gates.slice(0, 3)).toEqual([
      expect.objectContaining({ name: 'format:check', result: 'pass' }),
      expect.objectContaining({ name: 'lint', result: 'fail' }),
      { name: 'typecheck', result: 'not-run', ms: 0 },
    ]);
    expect(doc.tail.length).toBeLessThanOrEqual(40);
    // the output is still teed to the console
    expect(run.stdout).toContain('=== lint');
  });

  it('marks a skipped gate as skipped and keeps the run green', () => {
    expect(runCi(['--offline', '--summary-json', 'out/summary.json'], { smoke: 77 }).status).toBe(0);
    const doc = summary();
    expect(doc.result).toBe('pass');
    expect(doc.gates.find((gate) => gate.name === 'smoke')?.result).toBe('skipped');
  });

  it('refuses --summary-json without a path', () => {
    expect(runCi(['--summary-json']).status).toBe(2);
  });
});
