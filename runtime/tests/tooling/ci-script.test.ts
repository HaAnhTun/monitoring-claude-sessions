// `scripts/ci.mjs` (05 section 8.1) driven with stub tools in a throw-away workspace: gate order, `--offline`, `--full`,
// `--keep-going`, the "cannot run yet" exit code 77 and `--strict`. The second half checks the inactive GitHub workflow
// (05 section 8.2, A.41): it parses, its actions are pinned by commit SHA, and the commands it runs are the ones of `ci.mjs`.
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
 * name, with `@ARGS` replaced by `parity` or the first argument (so `vitest:run`, `vitest:parity`, `npm:run`, `npm:audit`).
 */
function stubSource(name: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `const key = ${JSON.stringify(name)}.replace('@ARGS', args.includes('parity') ? 'parity' : args[0] ?? '');`,
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

  it('--full adds the parity and e2e gates after the others', () => {
    const run = runCi(['--full', '--offline']);
    expect(run.order).toEqual([...GATES.filter((gate) => gate !== 'audit'), 'test:parity', 'test:e2e']);
    expect(run.calls.slice(-2)).toEqual([
      'vitest run --project parity',
      'playwright test -c packages/web/e2e/playwright.config.ts',
    ]);
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

// ---- the inactive GitHub workflow ---------------------------------------------------------------------------------------

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

const WORKFLOW_IN_CI_FOLDER = join(RUNTIME, 'ci', 'github-actions-ci.yml');
const WORKFLOW_ACTIVATED = join(SKILL, '.github', 'workflows', 'ci.yml');

function workflowPath(): string {
  return existsSync(WORKFLOW_IN_CI_FOLDER) ? WORKFLOW_IN_CI_FOLDER : WORKFLOW_ACTIVATED;
}

function workflow(): YamlMap {
  return asMap(parseYaml(readFileSync(workflowPath(), 'utf8')), 'workflow');
}

function allSteps(): { job: string; step: YamlMap }[] {
  const jobs = asMap(workflow()['jobs'], 'jobs');
  return Object.entries(jobs).flatMap(([job, body]) =>
    asList(asMap(body, job)['steps'], `${job}.steps`).map((step) => ({ job, step: asMap(step, `${job} step`) })),
  );
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
  ])('rejects %s', (_label, text) => {
    expect(() => parseYaml(text)).toThrow();
  });
});

describe('the inactive workflow (05 section 8.2, A.41)', () => {
  it('parses and has the documented shape', () => {
    const doc = workflow();
    expect(doc['name']).toBe('ci');
    expect(Object.keys(asMap(doc['jobs'], 'jobs'))).toEqual(['gates', 'e2e-and-parity']);
    expect(asMap(doc['permissions'], 'permissions')).toEqual({ contents: 'read' });
    expect(asMap(doc['env'], 'env')).toEqual({ MCS_HOOK_DISABLE: '1', TZ: 'UTC' });
    const on = asMap(doc['on'], 'on');
    expect(Object.keys(on)).toEqual(['push', 'pull_request']);
    expect(asMap(on['push'], 'push')['branches']).toEqual(['main', 'feat/**']);
    const gates = asMap(asMap(doc['jobs'], 'jobs')['gates'], 'gates');
    const matrix = asMap(asMap(gates['strategy'], 'strategy')['matrix'], 'matrix');
    expect(matrix['os']).toEqual(['windows-latest', 'ubuntu-latest']);
    expect(matrix['node']).toEqual(['22.22', '24', '26']);
    expect(asMap(asMap(asMap(gates['defaults'], 'defaults')['run'], 'run'), 'run')['working-directory']).toBe(
      'runtime',
    );
  });

  it('is shipped inactive: a draft below runtime/ci, not a workflow that GitHub would run', () => {
    if (existsSync(WORKFLOW_IN_CI_FOLDER)) {
      expect(existsSync(WORKFLOW_ACTIVATED)).toBe(false);
      const firstLine = readFileSync(WORKFLOW_IN_CI_FOLDER, 'utf8').split('\n')[0] ?? '';
      expect(firstLine).toMatch(/^# INACTIVE DRAFT\. Not executed remotely\./);
      expect(firstLine).toContain('git mv runtime/ci/github-actions-ci.yml .github/workflows/ci.yml');
    }
  });

  it('pins every action by a 40-hex commit SHA and never persists credentials', () => {
    const steps = allSteps();
    const uses = steps.filter(({ step }) => typeof step['uses'] === 'string');
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const { job, step } of uses) {
      const ref = text(step['uses']);
      expect(ref, `${job}: ${ref}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      if (ref.startsWith('actions/checkout@')) {
        expect(asMap(step['with'], 'with')['persist-credentials'], `${job} checkout`).toBe(false);
      }
    }
  });

  it('keeps the token read-only and uses no secret, no write permission and no pull_request_target', () => {
    const text = readFileSync(workflowPath(), 'utf8');
    expect(text).not.toMatch(/pull_request_target/);
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/:\s*write\b/);
    expect(text.match(/^permissions:/gm)?.length ?? 0).toBe(1);
  });

  it('runs exactly the commands of ci.mjs: npm ci, npm run ci, npm run ci:full, and the legacy suites', () => {
    const runs = allSteps().flatMap(({ job, step }) =>
      typeof step['run'] === 'string' ? [[job, step['run']] as const] : [],
    );
    expect(runs).toEqual([
      ['gates', 'npm ci'],
      ['gates', 'npm run ci'],
      ['e2e-and-parity', 'npm ci'],
      ['e2e-and-parity', 'python -m unittest discover -s tests'],
      ['e2e-and-parity', 'node --test "tests/frontend/*.test.mjs"'],
      ['e2e-and-parity', 'npm run ci:full'],
    ]);
    const scripts = (
      JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['ci']).toBe('node scripts/ci.mjs');
    expect(scripts['ci:full']).toBe('node scripts/ci.mjs --full');
  });

  it('names the gates that ci.mjs defines: the full run adds exactly test:parity and test:e2e', () => {
    const ciSource = readFileSync(join(RUNTIME, 'scripts', 'ci.mjs'), 'utf8');
    expect(ciSource).toContain("'test:parity'");
    expect(ciSource).toContain("'test:e2e'");
    const scripts = (
      JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['test:parity']).toBe('vitest run --project parity');
    expect(scripts['test:e2e']).toBe('playwright test -c packages/web/e2e/playwright.config.ts');
  });

  it('gives the legacy suites the skill root as working directory and the trace upload the gitignored e2e output', () => {
    const steps = allSteps();
    const legacy = steps.filter(({ step }) => typeof step['run'] === 'string' && !text(step['run']).startsWith('npm'));
    expect(legacy.length).toBe(2);
    for (const { step } of legacy) expect(step['working-directory']).toBe('.');
    const upload = steps.find(
      ({ step }) => typeof step['uses'] === 'string' && text(step['uses']).startsWith('actions/upload-artifact@'),
    );
    const target = asMap(upload?.step['with'], 'upload with')['path'];
    expect(target).toBe('runtime/packages/web/e2e/test-results/');
    expect(readFileSync(join(SKILL, '.gitignore'), 'utf8')).toContain('runtime/packages/web/e2e/test-results/');
    expect(upload?.step['if']).toBe('failure()');
  });
});
