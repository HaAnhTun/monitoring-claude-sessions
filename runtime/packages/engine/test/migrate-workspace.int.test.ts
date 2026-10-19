// `migrate-workspace` on real temp workspaces (ADR 0068, plan WP-95): T-MW-01 to T-MW-10 over the four synthetic shapes of
// `fixtures/migrate-shapes.ts`, and the `--all` sweep of WP-140 over the same shapes. Everything runs in this process against
// temp copies built by the testkit; no monitor of the machine is read or touched.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McsError } from '@mcs/shared';
import {
  CANARY,
  FakeClock,
  allocatePort,
  buildRepo,
  buildTaskWorkspace,
  makeJunction,
  snapshotTree,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { resolveConfig } from '../src/config/resolve.ts';
import type { Logger } from '../src/log/logger.ts';
import {
  apply,
  plan,
  workspaceFormatCheck,
  type MigrateDeps,
  type MigrateInput,
} from '../src/ops/migrate-workspace.ts';
import type { OpContext } from '../src/ops/workspace.ts';
import { resolveWorkspace } from '../src/workspace/paths.ts';
import { D_END, D_START, buildShape, type ShapeName } from './fixtures/migrate-shapes.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 19, 10, 15, 0);
const STAMP_DIR = 'pre-migrate-20261019T101500Z';
const SHAPES: readonly ShapeName[] = ['A', 'B', 'C', 'D'];
const GOLDEN = fileURLToPath(new URL('./fixtures/regex-translator/regex-golden.frozen.json', import.meta.url));

/** A logger that keeps every call, so a test can scan what would have been logged. */
function recordingLogger(lines: string[]): Logger {
  const keep =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
    };
  return {
    debug: keep('debug'),
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

interface Sandbox {
  readonly repo: string;
  readonly ctx: OpContext;
  readonly log: string[];
}

function sandbox(): Sandbox {
  const { repo } = buildRepo(makeTemp('migrate-ws').path);
  const skillDir = defaultSkillDir();
  const log: string[] = [];
  return {
    repo,
    log,
    ctx: {
      repo,
      root: path.join(repo, '.claude', 'monitor', 'tasks'),
      skillDir,
      runtimeDir: path.join(skillDir, 'runtime'),
      launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
      env: {},
      clock: new FakeClock(NOW),
      log: recordingLogger(log),
    },
  };
}

const stopped: MigrateDeps = { probe: () => Promise.resolve({ state: 'stopped' }) };

function read(ws: string, ...parts: string[]): Buffer {
  return readFileSync(path.join(ws, ...parts));
}

function configOf(ws: string): Record<string, unknown> {
  return JSON.parse(read(ws, 'config.json').toString('utf8')) as Record<string, unknown>;
}

function changeEntries(ws: string): number {
  return (read(ws, 'audit', 'changes.md').toString('utf8').match(/^## /gmu) ?? []).length;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) =>
          s.close(() => {
            resolve();
          }),
        ),
    ),
  );
});

describe('migrate-workspace on the four shapes', () => {
  it('T-MW-01: the dry run of each shape writes nothing and reports the right verdict and actions', async () => {
    const sb = sandbox();
    const expected: Record<ShapeName, string[]> = {
      A: ['add instance.json, audit/, data/ and logs/'],
      B: ['add instance.json, audit/, data/ and logs/'],
      C: ['translate session_rules[1].match to the JavaScript dialect', 'write config.json'],
      D: [
        'translate attempts.start to the JavaScript dialect',
        'translate attempts.end to the JavaScript dialect',
        'write config.json',
        'add instance.json, audit/, data/ and logs/',
      ],
    };
    for (const shape of SHAPES) {
      const ws = buildShape(sb.repo, shape);
      const before = snapshotTree(ws);
      const report = await plan(sb.ctx, { task: path.basename(ws) }, stopped);
      expect(snapshotTree(ws), shape).toBe(before);
      expect(report.verdict, shape).toBe('needs-migration');
      expect(report.mode).toBe('dry-run');
      expect(report.backup).toBeNull();
      expect(report.blockers).toEqual([]);
      for (const action of expected[shape]) expect(report.actions, shape).toContain(action);
      expect(report.actions.at(-1)).toBe('append one migrate-workspace entry to audit/changes.md');
    }
  });

  it('T-MW-02: apply on A adds the Node files, writes one audit entry and a byte-equal backup, keeps config.json', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    const originals = Object.fromEntries(
      ['task.json', 'config.json', 'README.md', 'audit/changes.md'].map((f) => [f, read(ws, f)]),
    );
    const report = await apply(sb.ctx, { task: 'shape-a' }, stopped);
    expect(report).toMatchObject({ verdict: 'needs-migration', mode: 'applied', backup: `data/backups/${STAMP_DIR}/` });
    for (const folder of ['audit', 'data', 'logs']) expect(existsSync(path.join(ws, folder))).toBe(true);
    expect(existsSync(path.join(ws, 'instance.json'))).toBe(true);
    expect(changeEntries(ws)).toBe(2);
    const changes = read(ws, 'audit', 'changes.md').toString('utf8');
    expect(changes).toContain('## 2026-10-19T10:15:00Z | migrate-workspace\n');
    expect(changes).not.toContain('adopt-instance');
    for (const [file, bytes] of Object.entries(originals)) {
      expect(read(ws, 'data', 'backups', STAMP_DIR, ...file.split('/')).equals(bytes), file).toBe(true);
    }
    expect(read(ws, 'config.json').equals(originals['config.json'] ?? Buffer.alloc(0))).toBe(true);
  });

  it('T-MW-03: apply on D translates the attempts patterns exactly and leaves every other key as it was', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'D');
    const before = configOf(ws);
    await apply(sb.ctx, { task: 'shape-d' }, stopped);
    const after = configOf(ws);
    const attempts = after['attempts'] as Record<string, unknown>;
    expect(attempts['start']).not.toBe(D_START);
    expect(attempts['end']).not.toBe(D_END);
    expect({ ...after, attempts: null }).toEqual({ ...before, attempts: null });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    const beforeAttempts = before['attempts'] as Record<string, unknown>;
    expect({ ...attempts, start: null, end: null }).toEqual({ ...beforeAttempts, start: null, end: null });

    const resolved = await resolveConfig({
      workspace: resolveWorkspace(sb.ctx.root, 'shape-d'),
      env: {},
      cli: {},
      skillDir: sb.ctx.skillDir,
    });
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
      cases: { kind: string; pattern: string; inputs: string[]; expected: (null | Record<string, unknown>)[] }[];
    };
    const v9 = golden.cases.filter((c) => c.kind === 'v9');
    const compiled = resolved.patterns.attempts;
    if (compiled === null) throw new Error('attempts not compiled');
    for (const [index, regex] of [compiled.start, compiled.end].entries()) {
      const corpus = v9[index];
      if (corpus === undefined) throw new Error('corpus case missing');
      expect(corpus.pattern).toBe(index === 0 ? D_START : D_END);
      corpus.inputs.forEach((input, i) => {
        const m = regex.exec(input);
        const got = m === null ? null : { span: [m.start, m.end], groups: m.groups(), groupdict: m.groupdict() };
        expect(got, `case ${String(index)} input ${String(i)}`).toEqual(corpus.expected[i]);
      });
    }
  });

  it('T-MW-04: a second apply on every shape is current and writes nothing', async () => {
    const sb = sandbox();
    for (const shape of SHAPES) {
      const ws = buildShape(sb.repo, shape);
      await apply(sb.ctx, { task: path.basename(ws) }, stopped);
      const tree = snapshotTree(ws);
      const backups = readdirSync(path.join(ws, 'data', 'backups'));
      const second = await apply(sb.ctx, { task: path.basename(ws) }, stopped);
      expect(second.verdict, shape).toBe('current');
      expect(second.actions).toEqual([]);
      expect(second.backup).toBeNull();
      expect(snapshotTree(ws), shape).toBe(tree);
      expect(readdirSync(path.join(ws, 'data', 'backups'))).toEqual(backups);
    }
  });

  it('T-MW-05: on C only the Python pattern is translated, the JavaScript one is kept with a warning', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'C');
    const before = configOf(ws);
    const report = await apply(sb.ctx, { task: 'shape-c' }, stopped);
    expect(report.patterns).toEqual([
      { where: 'session_rules[0].match', action: 'keep' },
      { where: 'session_rules[1].match', action: 'translate' },
    ]);
    expect(report.warnings.some((w) => w.startsWith('session_rules[0].match: kept'))).toBe(true);
    const rules = configOf(ws)['session_rules'] as { match: string }[];
    const oldRules = before['session_rules'] as { match: string }[];
    expect(rules[0]?.match).toBe(oldRules[0]?.match);
    expect(rules[1]?.match).not.toBe(oldRules[1]?.match);
  });
});

describe('migrate-workspace safety', () => {
  it('T-MW-06: a refused pattern and an unsupported time_format block, and --apply leaves the tree byte-equal', async () => {
    const sb = sandbox();
    const ws = buildTaskWorkspace(sb.repo, {
      slug: 'blocked',
      config: { title: 'FIXTURE', attempts: { start: '(?x) a b', end: '^(?P<a>x)', time_format: '%U' } },
    });
    const before = snapshotTree(ws);
    const report = await apply(sb.ctx, { task: 'blocked' }, stopped);
    expect(report.verdict).toBe('blocked');
    expect(report.backup).toBeNull();
    expect(report.blockers.some((b) => b.startsWith('REGEX_UNSUPPORTED: attempts.start'))).toBe(true);
    expect(report.blockers.some((b) => b.startsWith('CONFIG_INVALID: attempts.time_format'))).toBe(true);
    expect(report.patterns.find((p) => p.where === 'attempts.start')).toMatchObject({
      action: 'blocked',
      code: 'UNSUPPORTED_FLAG',
    });
    expect(snapshotTree(ws)).toBe(before);
  });

  it('a config.json with a byte order mark is blocked with CONFIG_INVALID and nothing is written', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    writeFileSync(path.join(ws, 'config.json'), String.fromCharCode(0xfeff) + read(ws, 'config.json').toString('utf8'));
    const before = snapshotTree(ws);
    const report = await apply(sb.ctx, { task: 'shape-a' }, stopped);
    expect(report.verdict).toBe('blocked');
    expect(report.blockers[0]).toMatch(/^CONFIG_INVALID: /u);
    expect(snapshotTree(ws)).toBe(before);
  });

  it('T-MW-07: a live legacy viewer (state.json and /api/health) blocks; nothing is written', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    const port = await allocatePort();
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', () => {
        resolve();
      }),
    );
    writeFileSync(
      path.join(ws, 'state.json'),
      JSON.stringify({
        pid: process.pid,
        url: `http://127.0.0.1:${String(port)}`,
        port,
        started: 1_700_000_000.5,
        version: '2.9.0',
        task: 'shape-a',
        config: null,
      }),
    );
    const before = snapshotTree(ws);
    const dry = await plan(sb.ctx, { task: 'shape-a' });
    expect(dry.verdict).toBe('blocked');
    expect(dry.blockers[0]).toMatch(/^INSTANCE_RUNNING: .*not started by this runtime.*unmanaged-running/u);
    const applied = await apply(sb.ctx, { task: 'shape-a' });
    expect(applied.verdict).toBe('blocked');
    expect(snapshotTree(ws)).toBe(before);
  });

  it('T-MW-07: a running Node instance blocks too (probe seam)', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'C');
    const before = snapshotTree(ws);
    const report = await apply(sb.ctx, { task: 'shape-c' }, { probe: () => Promise.resolve({ state: 'running' }) });
    expect(report.verdict).toBe('blocked');
    expect(snapshotTree(ws)).toBe(before);
  });

  it('T-MW-08: a failing re-resolve restores config.json byte-equal and reports the failure', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'C');
    const original = read(ws, 'config.json');
    const report = await apply(
      sb.ctx,
      { task: 'shape-c' },
      { ...stopped, resolve: () => Promise.reject(new McsError('CONFIG_INVALID', 'injected')) },
    );
    expect(report.verdict).toBe('blocked');
    expect(report.blockers.at(-1)).toMatch(/^CONFIG_INVALID: the converted configuration did not resolve/u);
    expect(read(ws, 'config.json').equals(original)).toBe(true);
    expect(changeEntries(ws)).toBe(1);
    expect(readdirSync(ws).filter((n) => /tmp/iu.test(n))).toEqual([]);
  });

  it('T-MW-09: a workspace that is a link or junction is refused', async () => {
    const sb = sandbox();
    const outside = makeTemp('migrate-outside').path;
    const { repo: otherRepo } = buildRepo(outside);
    const target = buildShape(otherRepo, 'A');
    const link = path.join(sb.ctx.root, 'linked');
    mkdirSync(sb.ctx.root, { recursive: true });
    makeJunction(link, target);
    const before = snapshotTree(target);
    for (const op of [plan, apply]) {
      const error = await op(sb.ctx, { task: 'linked' }, stopped).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McsError);
      expect(['WORKSPACE_ESCAPE', 'WORKSPACE_SYMLINK']).toContain((error as McsError).code);
    }
    expect(snapshotTree(target)).toBe(before);
  });

  it('T-MW-10: a canary in a blocked pattern never reaches the audit trail, the report or the log', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    const config = configOf(ws);
    writeFileSync(
      path.join(ws, 'config.json'),
      `${JSON.stringify({ ...config, session_rules: [{ match: `(?x) ${CANARY.key}`, label: 'x' }] }, null, 2)}\n`,
    );
    const report = await apply(sb.ctx, { task: 'shape-a' }, stopped);
    expect(report.verdict).toBe('blocked');
    expect(JSON.stringify(report)).not.toContain(CANARY.key);
    expect(read(ws, 'audit', 'changes.md').toString('utf8')).not.toContain(CANARY.key);
    expect(sb.log.join('\n')).not.toContain(CANARY.key);
  });

  it('two concurrent applies on one workspace: one migrates, the other finds it current', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'D');
    const [first, second] = await Promise.all([
      apply(sb.ctx, { task: 'shape-d' }, stopped),
      apply(sb.ctx, { task: 'shape-d' }, stopped),
    ]);
    expect([first.verdict, second.verdict].sort()).toEqual(['current', 'needs-migration']);
    expect(readdirSync(path.join(ws, 'data', 'backups'))).toEqual([STAMP_DIR]);
    expect(changeEntries(ws)).toBe(2);
  });

  it('the new files reach no process signal', () => {
    const sources = ['ops/migrate-workspace.ts', 'migrate/patterns.ts', 'migrate/backup.ts', 'migrate/report.ts'];
    for (const file of sources) {
      const text = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
      expect(text, file).not.toMatch(/process\.kill|forceKill|taskkill/u);
    }
  });
});

/** The four shapes plus a workspace that cannot be converted, named so that the blocked one sits in the middle of the list. */
function buildSweep(sb: Sandbox): Record<'a' | 'b' | 'blocked' | 'c' | 'd', string> {
  return {
    a: buildShape(sb.repo, 'A'),
    b: buildShape(sb.repo, 'B'),
    blocked: buildTaskWorkspace(sb.repo, {
      slug: 'shape-blocked',
      config: { title: 'FIXTURE', attempts: { start: '(?x) a b', end: '^(?P<a>x)', time_format: '%U' } },
    }),
    c: buildShape(sb.repo, 'C'),
    d: buildShape(sb.repo, 'D'),
  };
}

const SWEEP_SLUGS = ['shape-a', 'shape-b', 'shape-blocked', 'shape-c', 'shape-d'];

describe('migrate-workspace --all (WP-140)', () => {
  it('the dry run lists every workspace in slug order and writes nothing anywhere', async () => {
    const sb = sandbox();
    buildSweep(sb);
    const before = snapshotTree(sb.ctx.root);
    const sweep = await plan(sb.ctx, { all: true }, stopped);
    expect(snapshotTree(sb.ctx.root)).toBe(before);
    expect(sweep.mode).toBe('dry-run');
    expect(sweep.workspaces.map((w) => [w.slug, w.verdict, w.mode])).toEqual(
      SWEEP_SLUGS.map((slug) => [slug, slug === 'shape-blocked' ? 'blocked' : 'needs-migration', 'dry-run']),
    );
    expect(sweep.counts).toEqual({ total: 5, current: 0, needsMigration: 4, blocked: 1 });
    expect(sweep.skipped).toEqual([]);
    const single = await plan(sb.ctx, { task: 'shape-d' }, stopped);
    expect(sweep.workspaces.find((w) => w.slug === 'shape-d')).toEqual(single);
  });

  it('apply converts the others, leaves the blocked workspace in the middle byte-identical, and a second run is current', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const blockedBefore = snapshotTree(dirs.blocked);
    const sweep = await apply(sb.ctx, { all: true }, stopped);
    expect(sweep.mode).toBe('applied');
    expect(sweep.workspaces.map((w) => w.slug)).toEqual(SWEEP_SLUGS);
    expect(sweep.workspaces.map((w) => w.verdict)).toEqual([
      'needs-migration',
      'needs-migration',
      'blocked',
      'needs-migration',
      'needs-migration',
    ]);
    expect(sweep.counts).toEqual({ total: 5, current: 0, needsMigration: 4, blocked: 1 });
    const blocked = sweep.workspaces.find((w) => w.slug === 'shape-blocked');
    expect(blocked?.backup).toBeNull();
    expect(blocked?.blockers.some((b) => b.startsWith('REGEX_UNSUPPORTED: attempts.start'))).toBe(true);
    expect(snapshotTree(dirs.blocked)).toBe(blockedBefore);
    for (const key of ['a', 'b', 'c', 'd'] as const) {
      const ws = dirs[key];
      expect(existsSync(path.join(ws, 'instance.json')), key).toBe(true);
      expect(readdirSync(path.join(ws, 'data', 'backups')), key).toEqual([STAMP_DIR]);
      expect(changeEntries(ws), key).toBe(2);
    }
    const attempts = configOf(dirs.d)['attempts'] as Record<string, unknown>;
    expect(attempts['start']).not.toBe(D_START);

    const tree = snapshotTree(sb.ctx.root);
    const again = await apply(sb.ctx, { all: true }, stopped);
    expect(again.workspaces.map((w) => w.verdict)).toEqual(['current', 'current', 'blocked', 'current', 'current']);
    expect(again.counts).toEqual({ total: 5, current: 4, needsMigration: 0, blocked: 1 });
    expect(snapshotTree(sb.ctx.root)).toBe(tree);
  });

  it('each workspace is handled like a single task: the sweep report equals the report of the single call', async () => {
    const sweepBox = sandbox();
    const singleBox = sandbox();
    buildSweep(sweepBox);
    buildSweep(singleBox);
    const sweep = await apply(sweepBox.ctx, { all: true }, stopped);
    for (const slug of SWEEP_SLUGS) {
      const single = await apply(singleBox.ctx, { task: slug }, stopped);
      expect(
        sweep.workspaces.find((w) => w.slug === slug),
        slug,
      ).toEqual(single);
    }
    // everything but the random instance id of instance.json is the same
    for (const slug of SWEEP_SLUGS) {
      const same = { exclude: ['instance.json'] };
      expect(snapshotTree(path.join(sweepBox.ctx.root, slug), same), slug).toBe(
        snapshotTree(path.join(singleBox.ctx.root, slug), same),
      );
      expect(existsSync(path.join(sweepBox.ctx.root, slug, 'instance.json')), slug).toBe(
        existsSync(path.join(singleBox.ctx.root, slug, 'instance.json')),
      );
    }
  });

  it('a running monitor blocks its own workspace only', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const runningBefore = snapshotTree(dirs.c);
    const probed: string[] = [];
    const sweep = await apply(
      sb.ctx,
      { all: true },
      {
        probe: (ws) => {
          probed.push(ws.slug);
          return Promise.resolve({ state: ws.slug === 'shape-c' ? 'running' : 'stopped' });
        },
      },
    );
    expect(probed).toEqual(SWEEP_SLUGS);
    const running = sweep.workspaces.find((w) => w.slug === 'shape-c');
    expect(running?.verdict).toBe('blocked');
    expect(running?.blockers[0]).toMatch(/^INSTANCE_RUNNING: .*mcs stop --task shape-c/u);
    expect(snapshotTree(dirs.c)).toBe(runningBefore);
    expect(sweep.counts).toEqual({ total: 5, current: 0, needsMigration: 3, blocked: 2 });
    expect(existsSync(path.join(dirs.a, 'instance.json'))).toBe(true);
    expect(existsSync(path.join(dirs.d, 'instance.json'))).toBe(true);
  });

  it('an error thrown for one workspace is reported for it and the sweep goes on', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const busyBefore = snapshotTree(dirs.b);
    const sweep = await apply(
      sb.ctx,
      { all: true },
      {
        probe: (ws) =>
          ws.slug === 'shape-b'
            ? Promise.reject(new McsError('WORKSPACE_BUSY', 'another mcs command is changing this task'))
            : Promise.resolve({ state: 'stopped' }),
      },
    );
    const failed = sweep.workspaces.find((w) => w.slug === 'shape-b');
    expect(failed).toMatchObject({
      verdict: 'blocked',
      mode: 'applied',
      actions: [],
      patterns: [],
      backup: null,
      blockers: ['WORKSPACE_BUSY: another mcs command is changing this task'],
    });
    expect(snapshotTree(dirs.b)).toBe(busyBefore);
    expect(sweep.counts.needsMigration).toBe(3);
  });

  it('a workspace that holds a link, or whose task.json names another folder, is reported blocked and left alone', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const decoy = makeTemp('migrate-decoy').path;
    writeFileSync(path.join(decoy, 'changes.md'), `FIXTURE ${CANARY.key}\n`);
    rmSync(path.join(dirs.b, 'audit'), { recursive: true });
    makeJunction(path.join(dirs.b, 'audit'), decoy);
    const decoyBefore = snapshotTree(decoy);
    const linkedBefore = snapshotTree(dirs.b);
    const copy = path.join(sb.ctx.root, 'copied');
    mkdirSync(copy);
    for (const file of ['task.json', 'config.json', 'README.md']) {
      writeFileSync(path.join(copy, file), read(dirs.a, file));
    }
    const copyBefore = snapshotTree(copy);

    const sweep = await apply(sb.ctx, { all: true }, stopped);
    const bySlug = new Map(sweep.workspaces.map((w) => [w.slug, w]));
    expect(bySlug.get('shape-b')?.blockers[0]).toMatch(/^WORKSPACE_SYMLINK: /u);
    expect(bySlug.get('copied')?.blockers[0]).toMatch(/^IDENTITY_MISMATCH: /u);
    expect(bySlug.get('shape-a')?.verdict).toBe('needs-migration');
    expect(bySlug.get('shape-d')?.verdict).toBe('needs-migration');
    expect(snapshotTree(dirs.b)).toBe(linkedBefore);
    expect(snapshotTree(copy)).toBe(copyBefore);
    expect(snapshotTree(decoy)).toBe(decoyBefore);
  });

  it('a task folder that is a link or junction inside the tasks root is refused, skipped and never followed', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const outside = makeTemp('migrate-outside').path;
    const { repo: otherRepo } = buildRepo(outside);
    const target = buildShape(otherRepo, 'A', 'outside-task');
    makeJunction(path.join(sb.ctx.root, 'linked'), target);
    // not workspaces, so not even listed: a plain file, a staging folder and a folder without task.json
    writeFileSync(path.join(sb.ctx.root, 'notes.txt'), 'FIXTURE');
    mkdirSync(path.join(sb.ctx.root, '.init-staging'));
    mkdirSync(path.join(sb.ctx.root, 'empty-folder'));
    const targetBefore = snapshotTree(target);

    for (const op of [plan, apply]) {
      const sweep = await op(sb.ctx, { all: true }, stopped);
      expect(sweep.workspaces.map((w) => w.slug)).toEqual(SWEEP_SLUGS);
      expect(sweep.skipped).toHaveLength(1);
      expect(sweep.skipped[0]).toMatchObject({ slug: 'linked' });
      expect(sweep.skipped[0]?.reason).toMatch(/link/u);
      expect(snapshotTree(target)).toBe(targetBefore);
    }
    expect(existsSync(path.join(dirs.a, 'instance.json'))).toBe(true);
    expect(existsSync(path.join(target, 'instance.json'))).toBe(false);
    const direct = await apply(sb.ctx, { task: 'linked' }, stopped).catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(McsError);
  });

  it('over zero workspaces it returns an empty sweep and writes nothing, also when the tasks root does not exist', async () => {
    const sb = sandbox();
    const empty = await apply(sb.ctx, { all: true }, stopped);
    expect(empty).toEqual({
      mode: 'applied',
      workspaces: [],
      skipped: [],
      counts: { total: 0, current: 0, needsMigration: 0, blocked: 0 },
    });
    expect(readdirSync(sb.ctx.root)).toEqual([]);
    const absent = { ...sb.ctx, root: path.join(sb.repo, 'no-such-root') };
    for (const op of [plan, apply]) {
      const sweep = await op(absent, { all: true }, stopped);
      expect(sweep.workspaces).toEqual([]);
      expect(sweep.counts.total).toBe(0);
    }
    expect(existsSync(absent.root)).toBe(false);
  });

  it('a leftover backup folder of an interrupted run neither blocks the sweep nor is overwritten', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const leftover = path.join(dirs.a, 'data', 'backups', STAMP_DIR);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(path.join(leftover, 'task.json'), 'FIXTURE half-copied backup of a killed run');
    const sweep = await apply(sb.ctx, { all: true }, stopped);
    expect(sweep.workspaces.find((w) => w.slug === 'shape-a')?.backup).toBe(`data/backups/${STAMP_DIR}-2/`);
    expect(readFileSync(path.join(leftover, 'task.json'), 'utf8')).toBe('FIXTURE half-copied backup of a killed run');
    expect(read(dirs.a, 'data', 'backups', `${STAMP_DIR}-2`, 'task.json').equals(read(dirs.a, 'task.json'))).toBe(true);
  });

  it('a read-only config.json is reported for its workspace, keeps its bytes, and the other workspaces are converted', async () => {
    // A replace by rename over a read-only file fails on Windows only; elsewhere the file mode does not matter.
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const file = path.join(dirs.d, 'config.json');
    const original = read(dirs.d, 'config.json');
    chmodSync(file, 0o444);
    try {
      const sweep = await apply(sb.ctx, { all: true }, stopped);
      expect(sweep.workspaces.find((w) => w.slug === 'shape-a')?.verdict).toBe('needs-migration');
      const d = sweep.workspaces.find((w) => w.slug === 'shape-d');
      if (process.platform === 'win32') {
        expect(d?.verdict).toBe('blocked');
        expect(d?.blockers[0]).toMatch(/^WORKSPACE_INVALID: cannot replace config\.json/u);
        expect(d?.backup).toBe(`data/backups/${STAMP_DIR}/`);
        expect(read(dirs.d, 'config.json').equals(original)).toBe(true);
        expect(existsSync(path.join(dirs.d, 'instance.json'))).toBe(false);
        expect(readdirSync(dirs.d).filter((n) => /tmp/iu.test(n))).toEqual([]);
      } else {
        expect(d?.verdict).toBe('needs-migration');
      }
    } finally {
      chmodSync(file, 0o666);
    }
  }, 20_000);

  it('rejects an input that names neither a task nor --all, or both', async () => {
    const sb = sandbox();
    buildSweep(sb);
    const before = snapshotTree(sb.ctx.root);
    for (const input of [{}, { task: '' }, { all: true, task: 'shape-a' }] as unknown as MigrateInput[]) {
      for (const op of [plan, apply]) {
        const error = await op(sb.ctx, input as never, stopped).catch((e: unknown) => e);
        expect(error, JSON.stringify(input)).toBeInstanceOf(McsError);
        expect((error as McsError).code).toBe('USAGE');
      }
    }
    expect(snapshotTree(sb.ctx.root)).toBe(before);
  });

  it('two sweeps at once: every workspace is converted exactly once, the other sweep finds it current', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const [first, second] = await Promise.all([
      apply(sb.ctx, { all: true }, stopped),
      apply(sb.ctx, { all: true }, stopped),
    ]);
    expect(first.counts.needsMigration + second.counts.needsMigration).toBe(4);
    expect(first.counts.current + second.counts.current).toBe(4);
    expect([first.counts.blocked, second.counts.blocked]).toEqual([1, 1]);
    for (const key of ['a', 'b', 'c', 'd'] as const) {
      expect(readdirSync(path.join(dirs[key], 'data', 'backups')), key).toEqual([STAMP_DIR]);
      expect(changeEntries(dirs[key]), key).toBe(2);
    }
  });

  it('a pattern shaped for catastrophic backtracking is only translated and compiled, never run: the sweep stays fast', async () => {
    const sb = sandbox();
    const ws = buildTaskWorkspace(sb.repo, {
      slug: 'redos',
      config: { title: 'FIXTURE', session_rules: [{ match: '(?P<x>(a+)+)$', label: 'x' }] },
    });
    const started = Date.now();
    const dry = await plan(sb.ctx, { all: true }, stopped);
    const applied = await apply(sb.ctx, { all: true }, stopped);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(dry.workspaces[0]?.verdict).toBe('needs-migration');
    expect(applied.workspaces[0]?.verdict).toBe('needs-migration');
    expect(JSON.stringify(configOf(ws)['session_rules'])).toContain('(?<x>');
  });

  it('an interrupted sweep is finished by the next one: converted workspaces are current, the rest are converted', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    await apply(sb.ctx, { task: 'shape-a' }, stopped);
    await apply(sb.ctx, { task: 'shape-c' }, stopped);
    const doneA = snapshotTree(dirs.a);
    const doneC = snapshotTree(dirs.c);
    const sweep = await apply(sb.ctx, { all: true }, stopped);
    expect(sweep.workspaces.map((w) => w.verdict)).toEqual([
      'current',
      'needs-migration',
      'blocked',
      'current',
      'needs-migration',
    ]);
    expect(snapshotTree(dirs.a)).toBe(doneA);
    expect(snapshotTree(dirs.c)).toBe(doneC);
  });
});

describe('the doctor check workspace.format (WP-140)', () => {
  it('warns on an old-format workspace with the fix text, is ok once converted, and writes nothing', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const ws = resolveWorkspace(sb.ctx.root, 'shape-d');
    const before = snapshotTree(sb.ctx.root);
    const old = await workspaceFormatCheck(sb.ctx, ws);
    expect(old).toMatchObject({
      id: 'workspace.format',
      ok: false,
      level: 'warn',
      fix: 'mcs migrate-workspace --task shape-d',
    });
    expect(old.detail).toMatch(/before 4\.0/u);
    expect(snapshotTree(sb.ctx.root)).toBe(before);

    await apply(sb.ctx, { task: 'shape-d' }, stopped);
    const converted = await workspaceFormatCheck(sb.ctx, ws);
    expect(converted).toMatchObject({ id: 'workspace.format', ok: true });
    expect(converted.fix).toBeUndefined();
    expect(existsSync(path.join(dirs.d, 'instance.json'))).toBe(true);
  });

  it('a running monitor does not make a converted workspace look old, and the check never asks for the process state', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    const ws = resolveWorkspace(sb.ctx.root, 'shape-c');
    await apply(sb.ctx, { task: 'shape-c' }, stopped);
    const port = await allocatePort();
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', () => {
        resolve();
      }),
    );
    writeFileSync(
      path.join(dirs.c, 'state.json'),
      JSON.stringify({
        pid: process.pid,
        url: `http://127.0.0.1:${String(port)}`,
        port,
        started: 1_700_000_000.5,
        version: '2.9.0',
        task: 'shape-c',
        config: null,
      }),
    );
    const before = snapshotTree(dirs.c);
    // the real probe sees a live monitor, so the command itself would refuse; the doctor check is about the format only
    expect((await plan(sb.ctx, { task: 'shape-c' })).verdict).toBe('blocked');
    const check = await workspaceFormatCheck(sb.ctx, ws);
    expect(check).toMatchObject({ id: 'workspace.format', ok: true });
    expect(snapshotTree(dirs.c)).toBe(before);
  });

  it('is ok without a task, and says why when the workspace cannot be converted automatically', async () => {
    const sb = sandbox();
    const dirs = buildSweep(sb);
    expect(await workspaceFormatCheck(sb.ctx, null)).toEqual({
      id: 'workspace.format',
      ok: true,
      level: 'warn',
      detail: 'no task selected (skipped)',
    });
    const blocked = await workspaceFormatCheck(sb.ctx, resolveWorkspace(sb.ctx.root, 'shape-blocked'));
    expect(blocked).toMatchObject({ ok: false, level: 'warn', fix: 'mcs migrate-workspace --task shape-blocked' });
    expect(blocked.detail).toMatch(/cannot be converted automatically: REGEX_UNSUPPORTED/u);
    expect(blocked.detail).not.toContain('(?x)');
    expect(existsSync(path.join(dirs.blocked, 'instance.json'))).toBe(false);
  });
});
