// T-CLI-03 (config commands), T-XE-01, T-XE-02 and T-AU-01 (01 6.7, 3.5, 7.3): the Node CLI against the legacy engine `$V`
// (`template/viewer.py`). T-CLI-03 replays the committed golden session `golden/cli/task-lifecycle.json` (captured from `$V`
// under a frozen clock) through the real built CLI; the cross-engine rows run `$V` live and are reported as skipped with a
// reason when Python >= 3.8 is missing (never a silent pass). Parity is on keys and values, not bytes, except for the
// workspace files and the audit text, which are byte-compatible after masking timestamps (INV-02).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRepo, hermeticEnv, runCli, useTempDirs } from '@mcs/testkit';
import { describe, expect, it, type TestContext } from 'vitest';
import { z } from 'zod';

const makeTemp = useTempDirs();
const SKILL = fileURLToPath(new URL('../../../', import.meta.url));
const VIEWER = join(SKILL, 'template', 'viewer.py');
const GOLDEN = join(SKILL, 'tests', 'legacy-parity', 'golden', 'cli', 'task-lifecycle.json');
const BACKSLASH = String.fromCharCode(92);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TIMESTAMP = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/g;

// ---- Python discovery (01 6.5: MCS_PYTHON, then python, python3; version >= 3.8)

function pythonVersionOk(exe: string): boolean {
  const probe = spawnSync(exe, ['-c', "import sys; print('%d.%d' % sys.version_info[:2])"], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.status !== 0) return false;
  const [major, minor] = probe.stdout.trim().split('.').map(Number);
  return major !== undefined && minor !== undefined && (major > 3 || (major === 3 && minor >= 8));
}

function findPython(): string | null {
  const candidates = [process.env['MCS_PYTHON'], 'python', 'python3'].filter(
    (c): c is string => c !== undefined && c !== '',
  );
  return candidates.find(pythonVersionOk) ?? null;
}

const PYTHON = findPython();
const NO_PYTHON_REASON = 'Python >= 3.8 not found (MCS_PYTHON, python, python3): the legacy engine cannot be run';

/** Skips the running test with a recorded reason when the legacy engine is not available. */
function requirePython(ctx: TestContext): string {
  if (PYTHON === null) ctx.skip(NO_PYTHON_REASON);
  return PYTHON;
}

// ---- helpers

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
}

function sandbox(name = 'repo'): Sandbox {
  const root = makeTemp('parity-cli').path;
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

/** `$V <args> --repo <repo>` with bytecode off and a hermetic environment (plan section 2 rule 8). */
function legacy(python: string, sb: Sandbox, args: readonly string[]): Run {
  mkdirSync(join(sb.root, 'claude-home'), { recursive: true });
  const result = spawnSync(python, ['-B', VIEWER, ...args, '--repo', sb.repo], {
    cwd: sb.root,
    env: { ...sb.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
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

const Golden = z.object({
  commands: z.array(z.object({ argv: z.array(z.string()), exit: z.number(), stdout: z.string(), stderr: z.string() })),
  files: z.record(z.string(), z.string()),
});

/** What the Node report may carry beyond the legacy keys of the same command. */
const NODE_ONLY_KEYS: Readonly<Record<string, readonly string[]>> = {
  configure: ['files', 'isolation', 'restart_needed', 'dry_run'],
  inspect: ['instance', 'runtime_effective', 'effective_port', 'files', 'engine', 'probe'],
};

/** Keys whose values change by design (01 2.5, 6.4): the provenance tags, and the hash, which is a Node value. */
const DESIGNED_DIFFERENCES = ['provenance', 'overridden_keys', 'inherited_keys', 'config_hash'];

describe('T-CLI-03 config commands replay the legacy golden session (task-lifecycle)', () => {
  const golden = Golden.parse(JSON.parse(readFileSync(GOLDEN, 'utf8')));

  it('init-task, configure, decide, inspect, audit and the two refused configures answer like $V', async () => {
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
  });

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

describe('T-XE-01 / T-XE-02 / T-AU-01 against the live legacy engine', () => {
  async function bothSequences(python: string): Promise<{ a: Sandbox; b: Sandbox }> {
    // the same sequence by `$V` on one copy and by `$MCS` on the other; same repo folder name, so repo-relative values agree
    const a = sandbox('twin');
    const b = sandbox('twin');
    const steps: readonly (readonly string[])[] = [
      ['configure', '--task', 'twin', '--set', 'window_hours=12', '--set', 'panels.git=false', '--reason', 'parity'],
      ['configure', '--task', 'twin', '--unset', 'window_hours', '--reason', 'parity'],
      ['configure', '--task', 'twin', '--set', 'title="Twin renamed"', '--decision', 'rename it'],
      ['configure', '--task', 'twin', '--set', 'session_rules=[{"match":"STEP=([A-Z])","label":"step {1}"}]'],
      ['decide', '--task', 'twin', '--title', 'Use attempts', '--decision', 'chain log', '--rejected', 'none'],
      ['decide', '--task', 'twin', '--title', 'Second', '--decision', 'plain'],
    ];
    const made = legacy(python, a, ['init-task', '--name', 'Twin', '--slug', 'twin']);
    expect(made.code, made.stderr).toBe(0);
    const made2 = await node(b, ['init', '--name', 'Twin', '--slug', 'twin']);
    expect(made2.code, made2.stderr).toBe(0);
    for (const step of steps) {
      const viaLegacy = legacy(python, a, step);
      const viaNode = await node(b, step);
      expect(viaNode.code, `${step.join(' ')}: ${viaNode.stderr}`).toBe(viaLegacy.code);
    }
    return { a, b };
  }

  it('T-XE-01: configure by the Node CLI, then `$V check --task a` exits 0', async (ctx) => {
    const python = requirePython(ctx);
    const sb = sandbox();
    expect((await node(sb, ['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const configured = await node(sb, [
      'configure',
      '--task',
      'a',
      '--set',
      'window_hours=3',
      '--set',
      'panels.git=false',
    ]);
    expect(configured.code, configured.stderr).toBe(0);
    const check = legacy(python, sb, ['check', '--task', 'a']);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).toContain('window: 3h');
    const audit = legacy(python, sb, ['audit', '--task', 'a']);
    expect(audit.code, audit.stdout + audit.stderr).toBe(0);
  });

  it('T-XE-02: the same configure sequence by `$V` and by `$MCS` gives a byte-identical config.json and identical audit entries', async (ctx) => {
    const python = requirePython(ctx);
    const { a, b } = await bothSequences(python);
    const wsA = join(a.tasksRoot, 'twin');
    const wsB = join(b.tasksRoot, 'twin');
    expect(readFileSync(join(wsB, 'config.json'))).toEqual(readFileSync(join(wsA, 'config.json')));
    const normA = normaliser(a);
    const normB = normaliser(b);
    const initLine = 'Files changed: task.json, config.json, README.md, instance.json';
    const legacyInitLine = 'Files changed: task.json, config.json, README.md';
    expect(
      normB(readFileSync(join(wsB, 'audit', 'changes.md'), 'utf8'))
        .split(initLine)
        .join(legacyInitLine),
    ).toBe(normA(readFileSync(join(wsA, 'audit', 'changes.md'), 'utf8')));
  });

  it('T-AU-01: init + configure + decide give identical workspace files after masking timestamps', async (ctx) => {
    const python = requirePython(ctx);
    const { a, b } = await bothSequences(python);
    const wsA = join(a.tasksRoot, 'twin');
    const wsB = join(b.tasksRoot, 'twin');
    const normA = normaliser(a);
    const normB = normaliser(b);
    for (const name of ['task.json', 'config.json', join('audit', 'decisions.md')]) {
      expect(normB(readFileSync(join(wsB, name), 'utf8')), name).toBe(normA(readFileSync(join(wsA, name), 'utf8')));
    }
    // the README text differs by design (01 1.1); the title line is shared
    const titleOf = (norm: (t: string) => string, ws: string): string | undefined =>
      norm(readFileSync(join(ws, 'README.md'), 'utf8')).split(LF)[0];
    expect(titleOf(normB, wsB)).toBe(titleOf(normA, wsA));
    // byte level for the two audit files: the header, the separators and the line ends (CRLF stays CRLF on both sides)
    const bytesA = readFileSync(join(wsA, 'audit', 'decisions.md'));
    const bytesB = readFileSync(join(wsB, 'audit', 'decisions.md'));
    expect(bytesB.includes(Buffer.from(CR + LF))).toBe(bytesA.includes(Buffer.from(CR + LF)));
    // the Node instance file is the only file `$V` does not know; the legacy audit accepts a Node workspace (T-XE-06 in brief)
    expect(existsSync(join(wsB, 'instance.json'))).toBe(true);
    const audit = legacy(python, b, ['audit', '--task', 'twin']);
    expect(audit.code, audit.stdout + audit.stderr).toBe(0);
  });

  it('check prints the same line as `$V check` for the same configuration (explicit transcripts_dir)', async (ctx) => {
    const python = requirePython(ctx);
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
    const viaNode = await node(sb, ['check', '--task', 'chk']);
    const viaLegacy = legacy(python, sb, ['check', '--task', 'chk']);
    expect(viaNode.code).toBe(0);
    expect(viaLegacy.code, viaLegacy.stderr).toBe(0);
    expect(lfOnly(posix(viaNode.stdout))).toBe(lfOnly(posix(viaLegacy.stdout)));
  });

  it('check without detection support: a hermetic Claude home has no projects folder, `$V` prints None for auto', async (ctx) => {
    const python = requirePython(ctx);
    const sb = sandbox();
    expect((await node(sb, ['init', '--name', 'Auto task', '--slug', 'auto'])).code).toBe(0);
    const viaNode = await node(sb, ['check', '--task', 'auto']);
    const viaLegacy = legacy(python, sb, ['check', '--task', 'auto']);
    expect(viaLegacy.code, viaLegacy.stderr).toBe(0);
    // Python prints CRLF line ends on Windows (text mode); the line itself is the same
    expect(lfOnly(viaNode.stdout)).toBe(lfOnly(viaLegacy.stdout));
    expect(viaNode.stdout).toContain('transcripts: None');
  });
});
