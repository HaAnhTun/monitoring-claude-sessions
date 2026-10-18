// `migrate-workspace` on real temp workspaces (ADR 0068, plan WP-95): T-MW-01 to T-MW-10 over the four synthetic shapes of
// `fixtures/migrate-shapes.ts`. Everything runs in this process against temp copies built by the testkit; no monitor of the
// machine is read or touched.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { apply, plan, type MigrateDeps } from '../src/ops/migrate-workspace.ts';
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
    expect(dry.blockers[0]).toMatch(/^INSTANCE_RUNNING: .*legacy-running/u);
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
