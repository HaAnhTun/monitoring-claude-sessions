// T-CLI-03 (config commands, 01 6.7, 3.5, 7.3): the Node CLI replays the frozen data of the pre-4.0 engine, ADR 0066: the
// golden session `test/fixtures/config-session.frozen.json`, captured from the legacy CLI under a frozen clock, goes through
// the real built CLI. Parity is on keys and values, not bytes, except for the workspace files and the audit text, which are
// byte-compatible after masking timestamps (INV-02). The `check` cases pin the line the legacy CLI printed for the same
// configuration, as literals.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRepo, hermeticEnv, runCli, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const GOLDEN = new URL('./fixtures/config-session.frozen.json', import.meta.url);
const BACKSLASH = String.fromCharCode(92);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TIMESTAMP = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/g;

// ---- helpers

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
}

function sandbox(name = 'repo'): Sandbox {
  const root = makeTemp('config-session').path;
  const { repo, tasksRoot } = buildRepo(join(root, name));
  return { root, repo, tasksRoot, env: hermeticEnv(root) };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function node(sb: Sandbox, args: readonly string[]): Promise<Run> {
  const mcsHome = sb.env['MCS_HOME'] ?? join(sb.root, 'mcs-home');
  return runCli([...args, '--repo', sb.repo], { mcsHome, env: sb.env });
}

const posix = (text: string): string => text.split(BACKSLASH).join('/');
const lfOnly = (text: string): string => text.split(CR + LF).join(LF);
const maskTimestamps = (text: string): string => text.replace(TIMESTAMP, '<TS>');

/** Normalised form for comparison: temp root to `<TMP>`, `/` separators, LF line ends, timestamps masked. */
function normaliser(sb: Sandbox): (text: string) => string {
  const root = posix(sb.root);
  return (text) => maskTimestamps(lfOnly(posix(text)).split(root).join('<TMP>'));
}

function deepMap(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') return f(value);
  if (Array.isArray(value)) return value.map((v: unknown) => deepMap(v, f));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepMap(v, f)]));
  }
  return value;
}

interface GoldenCommand {
  readonly argv: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GoldenSession {
  readonly commands: readonly GoldenCommand[];
  readonly files: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the shape of the frozen session (the CLI package has no schema library, so this is by hand). */
function parseGolden(value: unknown): GoldenSession {
  if (!isRecord(value) || !Array.isArray(value['commands']) || !isRecord(value['files'])) {
    throw new Error('config-session.frozen.json: unexpected shape');
  }
  const commands = value['commands'].map((entry: unknown): GoldenCommand => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry['argv']) ||
      !entry['argv'].every((arg: unknown) => typeof arg === 'string') ||
      typeof entry['exit'] !== 'number' ||
      typeof entry['stdout'] !== 'string' ||
      typeof entry['stderr'] !== 'string'
    ) {
      throw new Error('config-session.frozen.json: unexpected command');
    }
    return { argv: entry['argv'], exit: entry['exit'], stdout: entry['stdout'], stderr: entry['stderr'] };
  });
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(value['files'])) {
    if (typeof text !== 'string') throw new Error(`config-session.frozen.json: unexpected file ${name}`);
    files[name] = text;
  }
  return { commands, files };
}

/** What the Node report may carry beyond the legacy keys of the same command. */
const NODE_ONLY_KEYS: Readonly<Record<string, readonly string[]>> = {
  configure: ['files', 'isolation', 'restart_needed', 'dry_run'],
  inspect: ['instance', 'runtime_effective', 'effective_port', 'files', 'engine', 'probe'],
};

/** Keys whose values change by design (01 2.5, 6.4): the provenance tags, and the hash, which is a Node value. */
const DESIGNED_DIFFERENCES = ['provenance', 'overridden_keys', 'inherited_keys', 'config_hash'];

/** The `check` lines of the legacy CLI for the two configurations below, temp root as `<TMP>`, LF line ends. */
const CHECK_EXPLICIT =
  'title: Check task | repo: <TMP>/repo | transcripts: <TMP>/transcripts | rules: 0 | window: 8.0h | panels: machine,git,logs | source: task' +
  LF;
const CHECK_AUTO =
  'title: Auto task | repo: <TMP>/repo | transcripts: None | rules: 0 | window: 8h | panels: machine,git,logs | source: task' +
  LF;

describe('T-CLI-03 config commands replay the legacy golden session (task-lifecycle)', () => {
  const golden = parseGolden(JSON.parse(readFileSync(GOLDEN, 'utf8')));

  it('init-task, configure, decide, inspect, audit and the two refused configures answer like the legacy CLI', async () => {
    const sb = sandbox('lifecycle-repo');
    const norm = normaliser(sb);
    const slug = 'nightly-build-steps-a-b';
    for (const expected of golden.commands) {
      const [command = '', ...rest] = expected.argv;
      // the golden argv carries `--repo <REPO>`; `node()` appends the real one
      const repoAt = rest.indexOf('--repo');
      const args = repoAt === -1 ? rest : [...rest.slice(0, repoAt), ...rest.slice(repoAt + 2)];
      const label = `${command} ${rest.join(' ')}`;
      const run = await node(sb, [command, ...args]);
      expect(run.code, `${label}: exit code (${run.stderr})`).toBe(expected.exit);
      expect(norm(run.stderr), `${label}: stderr`).toBe(norm(expected.stderr));
      if (expected.stdout === '') {
        expect(run.stdout, label).toBe('');
      } else if (expected.stdout.trimStart().startsWith('{') || expected.stdout.trimStart().startsWith('[')) {
        const want = deepMap(JSON.parse(expected.stdout), norm);
        const got = deepMap(JSON.parse(run.stdout), norm);
        compareJson(command, want, got, label);
      } else {
        expect(norm(run.stdout), `${label}: stdout`).toBe(norm(expected.stdout));
      }
    }
    // the workspace files: byte-compatible after masking timestamps
    const ws = join(sb.tasksRoot, slug);
    for (const [name, wantText] of Object.entries(golden.files)) {
      const gotText = readFileSync(join(ws, name), 'utf8');
      if (name === 'audit/changes.md') {
        // 7.2: the Node `init-task` entry also lists instance.json, the one designed difference of the audit trail
        expect(
          norm(gotText)
            .split('Files changed: task.json, config.json, README.md, instance.json')
            .join('Files changed: task.json, config.json, README.md'),
        ).toBe(norm(wantText));
      } else if (name === 'README.md') {
        // 1.1: the Node README text differs from the legacy one by design; only the title line is shared
        expect(norm(gotText).split(LF)[0], name).toBe(norm(wantText).split(LF)[0]);
      } else {
        expect(norm(gotText), name).toBe(norm(wantText));
      }
    }
  }, 60_000);

  function compareJson(command: string, want: unknown, got: unknown, label: string): void {
    if (Array.isArray(want)) {
      expect(got, label).toEqual(want);
      return;
    }
    const wantObject = want as Record<string, unknown>;
    const gotObject = got as Record<string, unknown>;
    const legacyKeys = Object.keys(wantObject);
    const extra = Object.keys(gotObject).filter((k) => !legacyKeys.includes(k));
    expect(NODE_ONLY_KEYS[command] ?? [], `${label}: keys beyond the legacy ones`).toEqual(
      expect.arrayContaining(extra),
    );
    expect(Object.keys(gotObject).slice(0, legacyKeys.length), `${label}: legacy keys come first, in order`).toEqual(
      legacyKeys,
    );
    for (const key of legacyKeys) {
      if (DESIGNED_DIFFERENCES.includes(key)) continue;
      expect(gotObject[key], `${label}: ${key}`).toEqual(wantObject[key]);
    }
    if (command === 'inspect') {
      // provenance values change from default|task to builtin|skill|config|... (01 2.5): the mapping is checked per key
      const wantProv = wantObject['provenance'] as Record<string, string>;
      const gotProv = gotObject['provenance'] as Record<string, string>;
      for (const [key, tag] of Object.entries(wantProv)) {
        expect(gotProv[key], `provenance of ${key}`).toBe(tag === 'task' ? 'config' : 'skill');
      }
      expect(gotObject['overridden_keys'], 'overridden_keys of the legacy keys').toEqual(
        expect.arrayContaining(wantObject['overridden_keys'] as string[]),
      );
      expect(gotObject['config_hash']).toMatch(/^[0-9a-f]{12}$/);
    }
  }
});

describe('check prints the line of the legacy CLI', () => {
  it('for an explicit transcripts_dir with window_hours=8.0', async () => {
    const sb = sandbox();
    const folder = join(sb.root, 'transcripts');
    mkdirSync(folder);
    expect((await node(sb, ['init', '--name', 'Check task', '--slug', 'chk'])).code).toBe(0);
    const set = await node(sb, [
      'configure',
      '--task',
      'chk',
      '--set',
      `transcripts_dir=${JSON.stringify(folder)}`,
      '--set',
      'window_hours=8.0',
    ]);
    expect(set.code, set.stderr).toBe(0);
    const run = await node(sb, ['check', '--task', 'chk']);
    expect(run.code, run.stderr).toBe(0);
    expect(normaliser(sb)(run.stdout)).toBe(CHECK_EXPLICIT);
  });

  it('prints transcripts: None for auto when a hermetic Claude home has no projects folder', async () => {
    const sb = sandbox();
    expect((await node(sb, ['init', '--name', 'Auto task', '--slug', 'auto'])).code).toBe(0);
    const run = await node(sb, ['check', '--task', 'auto']);
    expect(run.code, run.stderr).toBe(0);
    expect(normaliser(sb)(run.stdout)).toBe(CHECK_AUTO);
    expect(run.stdout).toContain('transcripts: None');
  });
});
