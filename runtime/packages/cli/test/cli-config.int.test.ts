// T-CLI-01, T-CLI-02, T-CLI-04 and T-SEC-04 for the kernel and the config commands (discover, init, inspect, configure, decide,
// audit, check, version, help), through the real built entry `packages/cli/dist/main.js` (01 6.2-6.4, 6.7, 8.3). Every call
// passes `--repo <temp repo>` and runs with a hermetic environment; no instance is started. The integration gate builds first.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_ERROR_CODES, CliEnvelopeSchema, cliExitCode, type CliEnvelope } from '@mcs/shared';
import {
  buildRepo,
  buildTaskWorkspace,
  hermeticEnv,
  killAllTracked,
  makeJunction,
  runCli,
  snapshotTree,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every test starts the real CLI (some also a real instance): on a loaded machine one needs far more than the 10 s default.
// A test with its own limit keeps it.
vi.setConfig({ testTimeout: 120_000 });

const makeTemp = useTempDirs();

// Runs before the temp-folder removal of `useTempDirs` (hooks run in stack order): a command still running when a test times
// out is ended first, so it cannot hold the folder (EPERM on Windows).
afterEach(async () => {
  await killAllTracked();
}, 120_000);

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(7);
const BACKSLASH = String.fromCharCode(92);
const LF = String.fromCharCode(10);

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = makeTemp('cli-config').path;
  const { repo, tasksRoot } = buildRepo(join(root, 'repo'));
  return { root, repo, tasksRoot, env: hermeticEnv(root) };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function mcsHomeOf(sb: Sandbox): string {
  return sb.env['MCS_HOME'] ?? join(sb.root, 'mcs-home');
}

/** Runs the real CLI; `--repo` is always passed (plan section 2 rule 5). */
function mcs(sb: Sandbox, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return runCli([...args, '--repo', sb.repo], { mcsHome: mcsHomeOf(sb), env: { ...sb.env, ...extraEnv } });
}

async function initTask(sb: Sandbox, name = 'Alpha task', extra: readonly string[] = []): Promise<string> {
  const result = await mcs(sb, ['init', '--name', name, ...extra]);
  expect(result.code, result.stderr).toBe(0);
  const slug = /created task '([a-z0-9-]+)'/.exec(result.stdout)?.[1];
  if (slug === undefined) throw new Error(`init printed no slug: ${result.stdout}`);
  return slug;
}

function readText(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Parses stdout as exactly one `mcs.cli/1` envelope (the shared contract schema, which also checks exit code and ok). */
function parseEnvelope(run: Run): CliEnvelope<unknown> {
  const parsed: unknown = JSON.parse(run.stdout);
  return CliEnvelopeSchema.parse(parsed);
}

/** The `data` of an envelope as a record. */
function dataOf(envelope: CliEnvelope<unknown>): Record<string, unknown> {
  const data = envelope.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('data is not an object');
  return Object.fromEntries(Object.entries(data));
}

/** Asymmetric matchers are typed `any` by the test library; these keep them `unknown` for the lint rules. */
const anyString: unknown = expect.any(String);
const anyNumber: unknown = expect.any(Number);
const anyBoolean: unknown = expect.any(Boolean);
const anyArray: unknown = expect.any(Array);
const anyObject: unknown = expect.any(Object);
const matching = (re: RegExp): unknown => expect.stringMatching(re);
const containing = (o: object): unknown => expect.objectContaining(o);
const arrayHaving = (items: readonly unknown[]): unknown => expect.arrayContaining([...items]);

const GLOBAL_OPTIONS = ['--repo', '--root', '--json', '--help'];

const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  discover: [],
  init: ['--name', '--slug', '--description', '--port', '--config'],
  inspect: ['--task'],
  configure: ['--task', '--set', '--unset', '--reason', '--decision', '--dry-run'],
  decide: ['--task', '--title', '--decision', '--rejected'],
  audit: ['--task'],
  check: ['--task'],
  version: ['--short'],
  help: [],
};

describe('T-CLI-01 every command: --help lists its options, an unknown option is a usage error', () => {
  let sb!: Sandbox;
  beforeEach(() => {
    sb = sandbox();
  });

  for (const [command, options] of Object.entries(COMMAND_OPTIONS)) {
    it(`${command} --help exits 0 and lists its options on stdout`, async () => {
      const run = await mcs(sb, [command, '--help']);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe('');
      for (const option of [...options, ...GLOBAL_OPTIONS]) {
        expect(run.stdout, `${command} lists ${option}`).toContain(option);
      }
      expect(run.stdout).toContain(`mcs ${command}`);
    });

    it(`${command} --bogus exits 2 with USAGE in the --json envelope and ERROR on stderr in text mode`, async () => {
      const json = await mcs(sb, [command, '--bogus', '--json']);
      expect(json.code).toBe(2);
      expect(json.stderr).toBe('');
      const envelope = parseEnvelope(json);
      expect(envelope).toMatchObject({ schema: 'mcs.cli/1', command, ok: false, exitCode: 2, data: null });
      expect(envelope.error?.code).toBe('USAGE');
      expect(envelope.error?.message).toContain('--bogus');

      const text = await mcs(sb, [command, '--bogus']);
      expect(text.code).toBe(2);
      expect(text.stdout).toBe('');
      expect(text.stderr.startsWith('ERROR: ')).toBe(true);
      expect(text.stderr).toContain('--bogus');
    });
  }

  it('init-task is an alias of init', async () => {
    const run = await mcs(sb, ['init-task', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('mcs init');
  });

  it('--help in --json mode is one envelope with the option table', async () => {
    const run = await mcs(sb, ['configure', '--help', '--json']);
    expect(run.code).toBe(0);
    const data = dataOf(parseEnvelope(run));
    expect(data).toMatchObject({ command: 'configure', usage: anyString, summary: anyString });
    expect(data['options']).toEqual(
      arrayHaving(
        ['task', 'set', 'unset', 'reason', 'decision', 'dry-run'].map((name) =>
          containing({
            name,
            type: matching(/^(string|boolean)$/),
            description: anyString,
          }),
        ),
      ),
    );
  });

  it('an unknown command exits 2 and names the command; no command prints the help and exits 2', async () => {
    const unknown = await mcs(sb, ['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("ERROR: unknown command 'frobnicate'");
    const json = parseEnvelope(await mcs(sb, ['frobnicate', '--json']));
    expect(json.error?.code).toBe('USAGE');
    expect(json.command).toBe('frobnicate');

    const none = await runCli([], { mcsHome: mcsHomeOf(sb), env: sb.env });
    expect(none.code).toBe(2);
    expect(none.stdout).toContain('commands:');
    const top = await runCli(['--help'], { mcsHome: mcsHomeOf(sb), env: sb.env });
    expect(top.code).toBe(0);
    expect(top.stdout).toContain('commands:');
    for (const command of Object.keys(COMMAND_OPTIONS)) expect(top.stdout).toContain(command);
  });

  it('help <command> prints that command; help <unknown> is a usage error', async () => {
    const known = await mcs(sb, ['help', 'decide']);
    expect(known.code).toBe(0);
    expect(known.stdout).toContain('--rejected');
    const unknown = await mcs(sb, ['help', 'nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('ERROR:');
  });

  it('a missing required option or a bad value is a usage error (exit 2), not a failure (exit 1)', async () => {
    const task = await mcs(sb, ['configure', '--set', 'window_hours=3']);
    expect(task.code).toBe(2);
    expect(task.stderr).toContain('ERROR: configure needs --task SLUG');
    const title = await mcs(sb, ['decide', '--task', 'x', '--decision', 'd']);
    expect(title.code).toBe(2);
    expect(title.stderr).toContain('--title');
    const engine = await mcs(sb, ['init', '--name', 'x', '--engine', 'rust']);
    expect(engine.code).toBe(2);
    expect(engine.stderr).toContain('--engine');
    const port = await mcs(sb, ['init', '--name', 'x', '--port', 'abc']);
    expect(port.code).toBe(2);
    expect(port.stderr).toContain('--port');
    const positional = await mcs(sb, ['check', 'extra']);
    expect(positional.code).toBe(2);
    const noValue = await mcs(sb, ['inspect', '--task']);
    expect(noValue.code).toBe(2);
    const noName = await mcs(sb, ['init']);
    expect(noName.code).toBe(2);
  });

  it('--option=value and --option value are the same', async () => {
    const slug = await initTask(sb);
    const a = await mcs(sb, ['check', `--task=${slug}`]);
    const b = await mcs(sb, ['check', '--task', slug]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe('exit codes and streams', () => {
  it('success is 0 with results on stdout only; a failure is 1 with ERROR on stderr and nothing on stdout', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ok = await mcs(sb, ['check', '--task', slug]);
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe('');
    const missing = await mcs(sb, ['check', '--task', 'no-such-task']);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr.startsWith('ERROR: ')).toBe(true);
    const badSlug = await mcs(sb, ['inspect', '--task', '../escape']);
    expect(badSlug.code).toBe(1);
    expect(badSlug.stderr.startsWith('ERROR: invalid task slug')).toBe(true);
  });

  it('a failure in --json mode is one envelope with the code, the exit code of the code and an empty stderr', async () => {
    const sb = sandbox();
    const run = await mcs(sb, ['inspect', '--task', 'no-such-task', '--json']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('');
    const envelope = parseEnvelope(run);
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(1);
    const code = envelope.error?.code;
    expect(CLI_ERROR_CODES).toContain(code);
    expect(code === undefined ? 0 : cliExitCode(code)).toBe(1);
    expect(envelope.error?.code).toBe('TASK_NOT_FOUND');
  });

  it('the hint of TASK_NOT_FOUND is a command that works: mcs init --slug <slug> (WP-101)', async () => {
    const sb = sandbox();
    const failed = await mcs(sb, ['inspect', '--task', 'nope', '--json']);
    expect(failed.code).toBe(1);
    const envelope = parseEnvelope(failed);
    expect(envelope.error?.code).toBe('TASK_NOT_FOUND');
    const hint = envelope.error?.hint ?? '';
    expect(hint).toBe('mcs init --slug nope');
    // run the hint as written, plus the --repo and --port that every test call carries
    const words = hint.split(' ');
    expect(words.slice(0, 2)).toEqual(['mcs', 'init']);
    const ran = await mcs(sb, [...words.slice(1), '--port', '18151']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(existsSync(join(sb.tasksRoot, 'nope', 'task.json'))).toBe(true);
    const inspected = await mcs(sb, ['inspect', '--task', 'nope', '--json']);
    expect(inspected.code, inspected.stderr).toBe(0);
  });

  it('text output neutralises terminal control sequences in untrusted text (ADR 0046)', async () => {
    const sb = sandbox();
    const slug = await initTask(sb, `Hostile ${ESC}]52;c;AAAA${BEL} title`);
    const text = await mcs(sb, ['check', '--task', slug]);
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain(ESC);
    expect(text.stdout).toContain(`${BACKSLASH}u001b]52;c;AAAA${BACKSLASH}u0007`);
    const json = await mcs(sb, ['check', '--task', slug, '--json']);
    expect(json.stdout).not.toContain(ESC);
    expect(parseEnvelope(json).ok).toBe(true);
  });
});

// the `data` shape of every command, as matchers (the per-command data types of the config commands are the engine result
// types of 98 2.1; shared/cli/results.ts holds no schema for them, CR-WP-15-1)
const BUILD = matching(/^(current|stale|unknown)$/);
const ENGINE = matching(/^(node|legacy)$/);
const DiscoverData = {
  repo: anyString,
  tasksRoot: anyString,
  tasks: anyArray,
  runtime: { version: '4.0.0', build: BUILD },
  lines: anyArray,
};
const InitData = {
  created: anyBoolean,
  adopted: anyBoolean,
  slug: anyString,
  dir: anyString,
  instanceId: anyString,
  engine: ENGINE,
  message: anyArray,
};
const InspectData = {
  task: anyObject,
  dir: anyString,
  effective: anyObject,
  provenance: anyObject,
  overridden_keys: anyArray,
  inherited_keys: anyArray,
  effective_port: anyNumber,
  engine: ENGINE,
  inspection: {
    entries: anyArray,
    files: anyArray,
    effectivePort: anyNumber,
    engine: ENGINE,
  },
};
const InspectTasksData = { tasks: anyArray, line: anyString };
const ConfigureData = { changed: anyBoolean, changes: anyArray, unchanged: anyArray };
const DecideData = { path: anyString, message: anyString };
const CheckData = {
  line: anyString,
  title: anyString,
  rules: anyNumber,
  source: matching(/^(task|defaults)$/),
  effectivePort: anyNumber,
  engine: ENGINE,
  regex: { checked: anyNumber, ok: true },
};
const VersionData = {
  runtimeVersion: '4.0.0',
  node: anyString,
  platform: anyString,
  arch: anyString,
};
const HelpData = {
  commands: arrayHaving([containing({ name: 'init', summary: anyString })]),
};

describe('T-CLI-02 --json: one envelope per command, validated against the envelope contract and the data shape', () => {
  it('every command prints exactly one mcs.cli/1 document whose command name is the canonical one', async () => {
    const sb = sandbox();
    const init = parseEnvelope(await mcs(sb, ['init-task', '--name', 'Beta task', '--json']));
    expect(init).toMatchObject({ schema: 'mcs.cli/1', command: 'init', ok: true, exitCode: 0, error: null });
    expect(init.data).toMatchObject(InitData);
    const slug = dataOf(init)['slug'];
    expect(slug).toBe('beta-task');
    if (typeof slug !== 'string') throw new Error('no slug');

    const cases: readonly (readonly [string, readonly string[], object])[] = [
      ['discover', ['discover'], DiscoverData],
      ['inspect', ['inspect', '--task', slug], InspectData],
      ['inspect', ['inspect'], InspectTasksData],
      ['configure', ['configure', '--task', slug, '--set', 'window_hours=12', '--reason', 'test'], ConfigureData],
      ['configure', ['configure', '--task', slug, '--set', 'window_hours=12'], ConfigureData],
      [
        'decide',
        ['decide', '--task', slug, '--title', 'Use X', '--decision', 'because', '--rejected', 'Y'],
        DecideData,
      ],
      ['audit', ['audit'], [{ task: 'beta-task', ok: true, problems: [] }]],
      ['audit', ['audit', '--task', slug], [{ task: 'beta-task', ok: true, problems: [] }]],
      ['check', ['check', '--task', slug], CheckData],
      ['version', ['version'], VersionData],
      ['help', ['help'], HelpData],
    ];
    for (const [command, args, data] of cases) {
      const run = await mcs(sb, [...args, '--json']);
      expect(run.code, `${args.join(' ')}: ${run.stderr}`).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout.endsWith(LF)).toBe(true);
      expect(() => CliEnvelopeSchema.parse(JSON.parse(run.stdout))).not.toThrow();
      const envelope = parseEnvelope(run);
      expect(envelope.command, args.join(' ')).toBe(command);
      expect(envelope.ok).toBe(true);
      expect(envelope.data, args.join(' ')).toMatchObject(data);
    }
  }, 300_000);

  it('a problem found by audit is exit 1 with the findings as data and no error object', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    writeFileSync(join(sb.tasksRoot, slug, 'copy.jsonl'), '{}' + LF);
    const run = await mcs(sb, ['audit', '--task', slug, '--json']);
    expect(run.code).toBe(1);
    const envelope = parseEnvelope(run);
    expect(envelope).toMatchObject({ ok: false, exitCode: 1, error: null });
    const items: unknown = envelope.data;
    expect(items).toMatchObject([{ task: slug, ok: false }]);
    expect(JSON.stringify(items)).toContain('transcript copy found (never copy transcripts): copy.jsonl');
    const text = await mcs(sb, ['audit', '--task', slug]);
    expect(text.code).toBe(1);
    expect(JSON.parse(text.stdout)).toEqual(items);
  });

  it('inspect --json carries the legacy report keys and data.inspection', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const data = dataOf(parseEnvelope(await mcs(sb, ['inspect', '--task', slug, '--json'])));
    expect(data).toMatchObject(InspectData);
    const inspection = data['inspection'] as { entries: { key: string }[]; effectivePort: number };
    expect(inspection.entries.length).toBeGreaterThan(10);
    expect(inspection.effectivePort).toBe(data['effective_port']);
    expect(inspection.entries.map((e) => e.key)).toContain('window_hours');
  });

  it('version prints the registry line; --short prints the version only; --json has the stamp fields', async () => {
    const sb = sandbox();
    const full = await mcs(sb, ['version']);
    expect(full.code).toBe(0);
    const line = full.stdout.trimEnd();
    expect(line.startsWith('mcs 4.0.0 (code ')).toBe(true);
    expect(line).toContain(', node ');
    expect(line.endsWith('build current)') || line.endsWith('build stale)') || line.endsWith('build unknown)')).toBe(
      true,
    );
    const short = await mcs(sb, ['version', '--short']);
    expect(short.stdout).toBe(`mcs 4.0.0${LF}`);
    const json = parseEnvelope(await mcs(sb, ['version', '--json']));
    expect(json.data).toMatchObject(VersionData);
    const stamps = dataOf(json);
    expect(['string', 'object']).toContain(typeof stamps['codeStamp']);
    expect(['boolean', 'object']).toContain(typeof stamps['buildCurrent']);
  });
});

describe('legacy-shaped default output (01 6.2): pretty JSON for inspect, configure and audit, text for the others', () => {
  it('inspect, configure and audit print JSON with two-space indentation; init, decide and check print text', async () => {
    const sb = sandbox();
    const init = await mcs(sb, ['init', '--name', 'Gamma task']);
    expect(init.stdout.startsWith("created task 'gamma-task' at ")).toBe(true);
    expect(init.stdout.endsWith(LF)).toBe(true);
    const again = await mcs(sb, ['init', '--name', 'Gamma task']);
    expect(again.stdout.startsWith("reused (nothing overwritten) task 'gamma-task' at ")).toBe(true);
    const inspect = await mcs(sb, ['inspect', '--task', 'gamma-task']);
    expect(inspect.stdout.startsWith(`{${LF}  "task": {`)).toBe(true);
    const keys = Object.keys(JSON.parse(inspect.stdout) as Record<string, unknown>);
    expect(keys.slice(0, 10)).toEqual([
      'task',
      'dir',
      'effective',
      'provenance',
      'runtime',
      'last_change',
      'config_hash',
      'recent_audit',
      'overridden_keys',
      'inherited_keys',
    ]);
    const list = await mcs(sb, ['inspect']);
    expect(list.stdout).toBe(`tasks: gamma-task${LF}`);
    const decide = await mcs(sb, ['decide', '--task', 'gamma-task', '--title', 'T', '--decision', 'D']);
    expect(decide.stdout).toBe(
      `recorded decision in ${join(sb.tasksRoot, 'gamma-task', 'audit', 'decisions.md')}${LF}`,
    );
    const audit = await mcs(sb, ['audit']);
    expect(audit.stdout.startsWith(`[${LF}  {${LF}    "task": "gamma-task"`)).toBe(true);
    const check = await mcs(sb, ['check', '--task', 'gamma-task']);
    expect(check.stdout.startsWith('title: Gamma task | repo: ')).toBe(true);
    expect(check.stdout).toContain(' | rules: 0 | window: 8h | panels: ');
    expect(check.stdout.trimEnd().endsWith(' | source: task')).toBe(true);
  });

  it('discover prints the legacy lines first and the Node lines after them, with no legacy-engine line', async () => {
    const sb = sandbox();
    await initTask(sb);
    const run = await mcs(sb, ['discover']);
    expect(run.code).toBe(0);
    const lines = run.stdout.split(LF);
    expect(lines[0]).toBe(`repo: ${sb.repo}`);
    const at = (prefix: string): number => lines.findIndex((l) => l.startsWith(prefix));
    expect(at('transcripts: ')).toBe(1);
    expect(at('tasks: ')).toBeGreaterThan(1);
    expect(at('runtime: mcs 4.0.0')).toBeGreaterThan(at('tasks: '));
    expect(at('legacy engine')).toBe(-1);
    expect(at('hooks: ')).toBeGreaterThan(at('runtime: '));
    expect(at('instances:')).toBeGreaterThan(at('hooks: '));
    expect(run.stdout).toContain('alpha-task engine=node state=stopped');
  });

  it('init creates instance.json with engine node (there is no --engine); --port and --description reach the files', async () => {
    const sb = sandbox();
    const slug = await initTask(sb, 'Delta task', ['--port', '18950', '--description', 'about it']);
    const ws = join(sb.tasksRoot, slug);
    expect(JSON.parse(readText(ws, 'instance.json'))).toMatchObject({ engine: 'node' });
    const legacy = await mcs(sb, ['init', '--name', 'Echo task', '--engine', 'legacy']);
    expect(legacy.code).toBe(2);
    expect(legacy.stderr).toContain('--engine');
    expect(JSON.parse(readText(ws, 'config.json'))).toMatchObject({ port: 18950 });
    expect(JSON.parse(readText(ws, 'task.json'))).toMatchObject({ description: 'about it' });
  });

  it('--root selects another tasks root', async () => {
    const sb = sandbox();
    const other = join(sb.root, 'other-root');
    const created = await mcs(sb, ['init', '--name', 'Epsilon', '--root', other]);
    expect(created.code, created.stderr).toBe(0);
    expect(existsSync(join(other, 'epsilon', 'task.json'))).toBe(true);
    expect(existsSync(join(sb.tasksRoot, 'epsilon'))).toBe(false);
  });
});

describe('T-CLI-04 configure semantics through the CLI', () => {
  function fileState(dir: string): string {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = join(e.parentPath, e.name);
        const stat = statSync(full);
        return `${full}:${String(stat.mtimeMs)}:${String(stat.size)}`;
      })
      .sort()
      .join(LF);
  }

  it('a change is applied, audited and reported; the same call again is a no-op that writes and audits nothing', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    const first = await mcs(sb, [
      'configure',
      '--task',
      slug,
      '--set',
      'window_hours=12',
      '--set',
      'panels.git=false',
      '--reason',
      'tune',
    ]);
    expect(first.code, first.stderr).toBe(0);
    const report = JSON.parse(first.stdout) as {
      changed: boolean;
      changes: string[];
      isolation?: string;
      files?: string[];
    };
    expect(report).toMatchObject(ConfigureData);
    expect(report.changed).toBe(true);
    expect(report.changes).toEqual(['window_hours: (default 8) -> 12', 'panels.git: (default true) -> false']);
    expect(report.isolation).toBe('ok');
    expect(report.files).toEqual(['config.json']);
    expect(readText(ws, 'audit', 'changes.md')).toContain('configure');

    const before = fileState(ws);
    const auditBefore = readText(ws, 'audit', 'changes.md');
    const again = await mcs(sb, ['configure', '--task', slug, '--set', 'window_hours=12', '--set', 'panels.git=false']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ changed: false, changes: [] });
    expect(fileState(ws)).toBe(before);
    expect(readText(ws, 'audit', 'changes.md')).toBe(auditBefore);
  });

  it('an invalid change is rejected with nothing written (exit 1, bytes and mtimes unchanged)', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    const before = fileState(ws);
    const bad = await mcs(sb, ['configure', '--task', slug, '--set', 'window_hours="soon"']);
    expect(bad.code).toBe(1);
    expect(bad.stderr.startsWith('ERROR: rejected, nothing written: ')).toBe(true);
    expect(fileState(ws)).toBe(before);
    const badRegex = await mcs(sb, ['configure', '--task', slug, '--set', 'session_rules=[{"match":"(","label":"x"}]']);
    expect(badRegex.code).toBe(1);
    expect(fileState(ws)).toBe(before);
  });

  it('--unset removes a key and says the default applies; a value that is not JSON is kept as text', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    await mcs(sb, ['configure', '--task', slug, '--set', 'window_hours=12']);
    const unset = await mcs(sb, ['configure', '--task', slug, '--unset', 'window_hours']);
    expect(JSON.parse(unset.stdout)).toMatchObject({
      changed: true,
      changes: ['window_hours: 12 -> (removed, default applies)'],
    });
    expect(readText(ws, 'config.json')).not.toContain('window_hours');
    const text = await mcs(sb, ['configure', '--task', slug, '--set', 'title=plain words']);
    expect(text.code, text.stderr).toBe(0);
    expect(JSON.parse(readText(ws, 'config.json'))).toMatchObject({ title: 'plain words' });
  });

  it('a dotted key below a value that is not an object is refused; schema_version and unsafe keys are refused', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    const before = fileState(ws);
    const notObject = await mcs(sb, ['configure', '--task', slug, '--set', 'title.sub=1']);
    expect(notObject.code).toBe(1);
    expect(notObject.stderr).toContain('cannot set title.sub: title is not an object');
    const version = await mcs(sb, ['configure', '--task', slug, '--set', 'schema_version=2']);
    expect(version.code).toBe(1);
    expect(version.stderr).toContain('schema_version');
    for (const key of ['__proto__.x', 'constructor.prototype.x', '../b', 'a/../../b']) {
      const run = await mcs(sb, ['configure', '--task', slug, '--set', `${key}=1`]);
      expect(run.code, key).toBe(1);
    }
    expect(fileState(ws)).toBe(before);
    const noEquals = await mcs(sb, ['configure', '--task', slug, '--set', 'window_hours']);
    expect(noEquals.code).toBe(2);
    expect(noEquals.stderr).toContain("--set expects KEY=JSON_VALUE, got 'window_hours'");
  });

  it('a runtime (R) key is routed to runtime.json, which is created with schema_version 1', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    expect(existsSync(join(ws, 'runtime.json'))).toBe(false);
    const run = await mcs(sb, ['configure', '--task', slug, '--set', 'logLevel="debug"', '--set', 'server.portScan=5']);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(readText(ws, 'runtime.json'))).toMatchObject({
      schema_version: 1,
      logLevel: 'debug',
      server: { portScan: 5 },
    });
    expect(JSON.parse(readText(ws, 'config.json'))).not.toHaveProperty('logLevel');
    expect(JSON.parse(run.stdout)).toMatchObject({ changed: true, files: ['runtime.json'] });
  });

  it('--dry-run reports dry_run true and writes nothing; --decision records a decision titled configuration', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    const before = fileState(ws);
    const dry = await mcs(sb, ['configure', '--task', slug, '--set', 'window_hours=3', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ changed: true, dry_run: true });
    expect(fileState(ws)).toBe(before);
    const decided = await mcs(sb, [
      'configure',
      '--task',
      slug,
      '--set',
      'window_hours=3',
      '--decision',
      'shorter window',
    ]);
    expect(decided.code, decided.stderr).toBe(0);
    expect(readText(ws, 'audit', 'decisions.md')).toContain(`| configuration${LF}- Decision: shorter window`);
  });

  it('decide appends one entry per call under the legacy header', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const file = join(sb.tasksRoot, slug, 'audit', 'decisions.md');
    await mcs(sb, ['decide', '--task', slug, '--title', 'One', '--decision', 'a']);
    await mcs(sb, ['decide', '--task', slug, '--title', 'Two', '--decision', 'b', '--rejected', 'c']);
    const text = readText(file);
    expect(text.match(/^## /gm)).toHaveLength(2);
    expect(text).toContain('- Rejected alternatives: none recorded');
    expect(text).toContain('- Rejected alternatives: c');
  });
});

describe('init crash hook (01 2.10): the CLI passes MCS_TEST_INIT_CRASH=before-rename to the init operation', () => {
  it('exits 70 between staging and rename: no workspace, one staging folder; the next init succeeds', async () => {
    const sb = sandbox();
    const crashed = await mcs(sb, ['init', '--name', 'Crash task'], {
      MCS_TEST: '1',
      MCS_TEST_INIT_CRASH: 'before-rename',
    });
    expect(crashed.code).toBe(70);
    const entries = readdirSync(sb.tasksRoot);
    expect(entries.some((name) => name === 'crash-task')).toBe(false);
    expect(entries.filter((name) => name.startsWith('.init-crash-task-'))).toHaveLength(1);
    const ok = await mcs(sb, ['init', '--name', 'Crash task']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(existsSync(join(sb.tasksRoot, 'crash-task', 'task.json'))).toBe(true);
  });

  it('is ignored without test mode', async () => {
    const sb = sandbox();
    const run = await mcs(sb, ['init', '--name', 'No crash'], { MCS_TEST: '', MCS_TEST_INIT_CRASH: 'before-rename' });
    expect(run.code, run.stderr).toBe(0);
  });
});

describe('T-SEC-04 a link planted as audit/ or data/ makes every writing command refuse (nothing is written through it)', () => {
  function outsideFolder(sb: Sandbox): string {
    const outside = join(sb.root, 'outside');
    mkdirSync(outside);
    return outside;
  }

  it('decide and configure refuse when audit/ is a link', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const ws = join(sb.tasksRoot, slug);
    const outside = outsideFolder(sb);
    renameSync(join(ws, 'audit'), join(sb.root, 'audit-moved'));
    makeJunction(join(ws, 'audit'), outside);

    const decide = await mcs(sb, ['decide', '--task', slug, '--title', 'T', '--decision', 'D', '--json']);
    expect(decide.code).toBe(1);
    expect(parseEnvelope(decide).error?.code).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(outside)).toEqual([]);

    const configure = await mcs(sb, ['configure', '--task', slug, '--set', 'window_hours=3', '--json']);
    expect(configure.code).toBe(1);
    expect(parseEnvelope(configure).error?.code).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('init refuses to adopt a legacy workspace whose data/ is a link', async () => {
    const sb = sandbox();
    const ws = buildTaskWorkspace(sb.repo, { slug: 'legacy-one', config: { title: 'Legacy one' } });
    mkdirSync(join(ws, 'audit'));
    writeFileSync(join(ws, 'audit', 'changes.md'), '# Changes' + LF);
    const outside = outsideFolder(sb);
    makeJunction(join(ws, 'data'), outside);
    const before = snapshotTree(ws);
    const run = await mcs(sb, ['init', '--name', 'Legacy one', '--slug', 'legacy-one', '--json']);
    expect(run.code).toBe(1);
    expect(parseEnvelope(run).error?.code).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(outside)).toEqual([]);
    expect(snapshotTree(ws)).toBe(before);
  });
});
