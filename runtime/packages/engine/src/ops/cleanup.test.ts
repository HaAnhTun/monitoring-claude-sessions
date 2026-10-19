// `ops.cleanup` (01 6.4, T-CLI-06 unit part): every scope is a dry run until `--yes`, what each scope may delete and what it must
// leave alone (live monitors, links, unfinished backups, spool segments that are still being read, active and pinned sessions),
// the backup that `data` makes before its first row goes, and the audit entry. Every workspace is a temp one, every database a
// real SQLite file; the probe is scripted so that no process is started.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError, type CleanupResult, type InstanceFile } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { openInstanceDb } from '../db/open.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from '../db/repos/spool-cursors.ts';
import { withWriteTx } from '../db/write.ts';
import type { Logger } from '../log/logger.ts';
import { resolveWorkspace } from '../workspace/paths.ts';
import { listBackups, make } from './backup.ts';
import { lines, run, type CleanupDeps, type CleanupInput } from './cleanup.ts';
import type { ProbeResult, ProbeState } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: ID };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const STATE_BYTES = Buffer.from('{"pid":4242,"FIXTURE":true}\n');

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

interface Fixture {
  readonly ctx: OpContext;
  readonly clock: FakeClock;
  readonly repo: string;
  readonly dir: string;
  readonly dbFile: string;
}

function setup(o: { db?: boolean; runtime?: Record<string, unknown>; instance?: Partial<InstanceFile> } = {}): Fixture {
  const { repo } = buildRepo(makeTemp('cleanup').path);
  const dir = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    ...(o.runtime === undefined ? {} : { runtime: o.runtime }),
    instance: { slug: 'demo', instanceId: ID, runtimeVersion: '4.0.0', dbSchemaVersion: 1, ...o.instance },
  });
  for (const sub of ['data', 'logs', 'run']) mkdirSync(path.join(dir, sub), { recursive: true });
  const dbFile = path.join(dir, 'data', 'monitor.db');
  if (o.db === true)
    openInstanceDb({ path: dbFile, expectedInstanceId: ID, mode: 'serve', runtimeVersion: '4.0.0' }).close();
  const clock = new FakeClock(NOW);
  const skillDir = defaultSkillDir();
  const ctx: OpContext = {
    repo,
    root: path.join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };
  return { ctx, clock, repo, dir, dbFile };
}

function probeResult(state: ProbeState, bytes: Uint8Array | null = null): ProbeResult {
  const live = state !== 'stopped' && state !== 'stale' && state !== 'foreign-pid';
  return {
    state,
    engine: state === 'stopped' ? null : 'node',
    pid: state === 'stopped' ? null : 4242,
    url: live ? 'http://127.0.0.1:18001' : null,
    port: live ? 18001 : null,
    identity: null,
    stateFile: null,
    stateFileBytes: bytes,
    reason: 'scripted',
  };
}

function probing(state: ProbeState, bytes: Uint8Array | null = null): CleanupDeps {
  return { probe: () => Promise.resolve(probeResult(state, bytes)) };
}

/** Writes a file of `size` bytes whose modification time is `ageMs` before the fixture clock. */
function put(file: string, ageMs: number, content: string | Buffer = 'x'): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const when = new Date(NOW - ageMs);
  utimesSync(file, when, when);
  return file;
}

async function failure(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const paths = (result: CleanupResult): string[] => result.targets.map((t) => t.path);
const changes = (f: Fixture): string => {
  const file = path.join(f.dir, 'audit', 'changes.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

function go(f: Fixture, input: CleanupInput, deps: CleanupDeps = probing('stopped')): Promise<CleanupResult> {
  return run(f.ctx, { task: 'demo', ...input }, deps);
}

// ---- the confirmation and usage rules -----------------------------------------------------------------------------------

describe('cleanup: usage and confirmation (T-CLI-06)', () => {
  it('needs a task for every scope but init-leftovers, and refuses a task there', async () => {
    const f = setup();
    for (const scope of ['stale-state', 'logs', 'backups', 'spool', 'data'] as const) {
      const error = await failure(run(f.ctx, { scope }));
      expect(error.code).toBe('USAGE');
      expect(error.message).toContain('--task');
    }
    const root = await failure(run(f.ctx, { scope: 'init-leftovers', task: 'demo' }));
    expect(root.code).toBe('USAGE');
  });

  it('refuses options that do not belong to the scope and values out of range, before looking at the workspace', async () => {
    const f = setup();
    expect((await failure(go(f, { scope: 'stale-state', olderThanDays: 3 }))).code).toBe('USAGE');
    expect((await failure(go(f, { scope: 'logs', keep: 3 }))).code).toBe('USAGE');
    expect((await failure(go(f, { scope: 'logs', olderThanDays: 0 }))).code).toBe('USAGE');
    expect((await failure(go(f, { scope: 'backups', keep: -1 }))).code).toBe('USAGE');
    expect((await failure(go(f, { scope: 'data', olderThanDays: 1.5 }))).code).toBe('USAGE');
  });

  it('every scope is a dry run without --yes, and --dry-run wins over --yes', async () => {
    const f = setup({ db: true });
    const old = put(path.join(f.dir, 'logs', 'runtime.log.1'), 40 * DAY);
    const before = readdirSync(path.join(f.dir, 'logs'));
    const dry = await go(f, { scope: 'logs' });
    expect(dry).toMatchObject({ applied: false, count: 1 });
    expect(paths(dry)).toEqual(['logs/runtime.log.1']);
    const both = await go(f, { scope: 'logs', yes: true, dryRun: true });
    expect(both.applied).toBe(false);
    expect(readdirSync(path.join(f.dir, 'logs'))).toEqual(before);
    expect(existsSync(old)).toBe(true);
    expect(changes(f)).toBe('');
  });

  it('data with --yes needs the task name typed again, exactly: nothing is probed, backed up or deleted otherwise', async () => {
    const f = setup({ db: true });
    for (const confirm of [undefined, '', 'DEMO', 'Demo', ' demo', 'demo ', 'other']) {
      const error = await failure(
        go(
          f,
          { scope: 'data', olderThanDays: 1, yes: true, ...(confirm === undefined ? {} : { confirm }) },
          {
            probe: () => Promise.reject(new Error('the probe must not run before the confirmation')),
          },
        ),
      );
      expect(error.code).toBe('CONFIRMATION_REQUIRED');
      expect(error.message).toContain('--confirm demo');
    }
    expect(existsSync(path.join(f.dir, 'data', 'backups'))).toBe(false);
  });
});

// ---- stale-state --------------------------------------------------------------------------------------------------------------

describe('cleanup --scope stale-state', () => {
  it('deletes state.json of a stale monitor and of a live impostor (foreign-pid), by compare-and-delete', async () => {
    for (const state of ['stale', 'foreign-pid'] as const) {
      const f = setup();
      put(path.join(f.dir, 'state.json'), HOUR, STATE_BYTES);
      const dry = await go(f, { scope: 'stale-state' }, probing(state, STATE_BYTES));
      expect(paths(dry)).toEqual(['state.json']);
      expect(existsSync(path.join(f.dir, 'state.json'))).toBe(true);
      const done = await go(f, { scope: 'stale-state', yes: true }, probing(state, STATE_BYTES));
      expect(done).toMatchObject({ applied: true, count: 1, remaining: [] });
      expect(existsSync(path.join(f.dir, 'state.json'))).toBe(false);
    }
  });

  it('keeps a state file that changed between the plan and the deletion', async () => {
    const f = setup();
    const state = path.join(f.dir, 'state.json');
    put(state, HOUR, STATE_BYTES);
    const result = await go(
      f,
      { scope: 'stale-state', yes: true },
      {
        ...probing('stale', STATE_BYTES),
        beforeStep: () => {
          writeFileSync(state, 'a new monitor started\n');
        },
      },
    );
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([{ path: 'state.json', reason: 'changed after the plan; kept' }]);
    expect(readFileSync(state, 'utf8')).toBe('a new monitor started\n');
  });

  it('keeps state.json and the token while a monitor runs, hangs, starts, stops or belongs to another runtime', async () => {
    for (const state of ['running', 'starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const) {
      const f = setup();
      put(path.join(f.dir, 'state.json'), HOUR, STATE_BYTES);
      put(path.join(f.dir, 'run', 'control.token'), HOUR, 'f'.repeat(64));
      const result = await go(f, { scope: 'stale-state', yes: true }, probing(state, STATE_BYTES));
      expect(result.targets).toEqual([]);
      expect(result.skipped.map((s) => s.path).sort()).toEqual(['run/control.token', 'state.json']);
      expect(existsSync(path.join(f.dir, 'state.json'))).toBe(true);
      expect(existsSync(path.join(f.dir, 'run', 'control.token'))).toBe(true);
    }
  });

  it('removes run/control.token only without a runtime', async () => {
    const f = setup();
    const token = put(path.join(f.dir, 'run', 'control.token'), 5 * MINUTE, 'f'.repeat(64));
    expect(paths(await go(f, { scope: 'stale-state', yes: true }, probing('stopped')))).toEqual(['run/control.token']);
    expect(existsSync(token)).toBe(false);
  });

  it('removes *.tmp and data/exports/.tmp-* older than ten minutes and nothing younger, nothing else, nothing in the backups', async () => {
    const f = setup();
    const keep = [
      put(path.join(f.dir, 'config.json.4242.ab12cd34.tmp'), 9 * MINUTE),
      put(path.join(f.dir, 'data', 'exports', '.tmp-young.db'), 9 * MINUTE),
      put(path.join(f.dir, 'data', 'exports', 'export-1.ndjson'), DAY),
      put(path.join(f.dir, 'data', 'exports', 'sub', '.tmp-nested.db'), DAY),
      put(path.join(f.dir, 'data', 'backups', '20261001T000000Z-manual.partial', 'manifest.json.1.aa.tmp'), DAY),
      put(path.join(f.dir, 'logs', 'runtime.log'), DAY),
    ];
    const old = [
      put(path.join(f.dir, 'instance.json.4242.ab12cd34.tmp'), 11 * MINUTE),
      put(path.join(f.dir, 'data', 'monitor.db.restore-abcd1234.tmp'), DAY),
      put(path.join(f.dir, 'data', 'exports', '.tmp-old.db'), 11 * MINUTE),
      put(path.join(f.dir, 'data', 'exports', '.tmp-old.db-wal'), 11 * MINUTE),
      put(path.join(f.dir, 'audit', 'changes.md.1.aa.tmp'), DAY),
    ];
    const result = await go(f, { scope: 'stale-state', yes: true });
    expect(paths(result).sort()).toEqual(
      [
        'audit/changes.md.1.aa.tmp',
        'data/exports/.tmp-old.db',
        'data/exports/.tmp-old.db-wal',
        'data/monitor.db.restore-abcd1234.tmp',
        'instance.json.4242.ab12cd34.tmp',
      ].sort(),
    );
    for (const file of old) expect(existsSync(file), file).toBe(false);
    for (const file of keep) expect(existsSync(file), file).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  it('never follows a link: a junction named like a temp file is reported and its target is untouched', async () => {
    const f = setup();
    const decoy = makeTemp('decoy').path;
    const canary = put(path.join(decoy, 'canary.txt'), DAY, 'canary');
    mkdirSync(path.join(f.dir, 'data', 'exports'), { recursive: true });
    makeJunction(path.join(f.dir, 'data', 'exports', '.tmp-link'), decoy);
    makeJunction(path.join(f.dir, 'stray.tmp'), decoy);
    const result = await go(f, { scope: 'stale-state', yes: true });
    expect(result.targets).toEqual([]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(['data/exports/.tmp-link', 'stray.tmp']);
    expect(readFileSync(canary, 'utf8')).toBe('canary');
  });

  it('is not audited, and the workspace files stay', async () => {
    const f = setup();
    put(path.join(f.dir, 'state.json'), HOUR, STATE_BYTES);
    await go(f, { scope: 'stale-state', yes: true }, probing('stale', STATE_BYTES));
    expect(changes(f)).toBe('');
    for (const name of ['task.json', 'config.json', 'instance.json', 'README.md']) {
      expect(existsSync(path.join(f.dir, name)), name).toBe(true);
    }
  });
});

// ---- init-leftovers -----------------------------------------------------------------------------------------------------------

describe('cleanup --scope init-leftovers', () => {
  const NAME = '.init-demo-99999999-abcdef01';

  it('removes dead staging folders older than ten minutes from the tasks root, nothing else', async () => {
    const f = setup();
    const dead = path.join(f.ctx.root, NAME);
    put(path.join(dead, 'task.json'), DAY, '{}');
    const young = path.join(f.ctx.root, '.init-demo-99999999-abcdef02');
    put(path.join(young, 'task.json'), MINUTE, '{}');
    utimesSync(young, new Date(NOW - MINUTE), new Date(NOW - MINUTE));
    utimesSync(dead, new Date(NOW - DAY), new Date(NOW - DAY));
    const alive = path.join(f.ctx.root, `.init-demo-${String(process.pid)}-abcdef03`);
    put(path.join(alive, 'task.json'), DAY, '{}');
    utimesSync(alive, new Date(NOW - DAY), new Date(NOW - DAY));
    const other = path.join(f.ctx.root, '.init-not-a-staging-folder');
    put(path.join(other, 'x'), DAY);
    utimesSync(other, new Date(NOW - DAY), new Date(NOW - DAY));

    const dry = await run(f.ctx, { scope: 'init-leftovers' });
    expect(dry).toMatchObject({ task: null, applied: false, count: 1 });
    expect(paths(dry)).toEqual([NAME]);
    expect(existsSync(dead)).toBe(true);

    const done = await run(f.ctx, { scope: 'init-leftovers', yes: true });
    expect(done).toMatchObject({ applied: true, count: 1, remaining: [] });
    expect(existsSync(dead)).toBe(false);
    for (const kept of [young, alive, other, f.dir]) expect(existsSync(kept), kept).toBe(true);
    expect(changes(f)).toBe('');
  });

  it('leaves a staging folder that holds a link alone and reports it', async () => {
    const f = setup();
    const staging = path.join(f.ctx.root, NAME);
    mkdirSync(staging, { recursive: true });
    const decoy = makeTemp('decoy').path;
    const canary = put(path.join(decoy, 'canary.txt'), DAY, 'canary');
    makeJunction(path.join(staging, 'data'), decoy);
    utimesSync(staging, new Date(NOW - DAY), new Date(NOW - DAY));
    const done = await run(f.ctx, { scope: 'init-leftovers', yes: true });
    expect(done.targets).toEqual([]);
    expect(done.skipped).toEqual([{ path: NAME, reason: 'holds a link; the folder is left alone' }]);
    expect(existsSync(staging)).toBe(true);
    expect(readFileSync(canary, 'utf8')).toBe('canary');
  });
});

// ---- logs ---------------------------------------------------------------------------------------------------------------------

describe('cleanup --scope logs', () => {
  it('deletes rotated logs and diagnostics older than the age, not the live logs, not younger files', async () => {
    const f = setup();
    const logs = path.join(f.dir, 'logs');
    const gone = [
      put(path.join(logs, 'runtime.log.1'), 31 * DAY),
      put(path.join(logs, 'runtime.log.5'), 90 * DAY),
      put(path.join(logs, 'boot.log.1'), 45 * DAY),
      put(path.join(logs, 'diagnostics-20260901T100000Z.json'), 40 * DAY),
    ];
    const kept = [
      put(path.join(logs, 'runtime.log'), 90 * DAY),
      put(path.join(logs, 'boot.log'), 90 * DAY),
      put(path.join(logs, 'runtime.log.2'), 29 * DAY),
      put(path.join(logs, 'diagnostics-20261019T100000Z.json'), DAY),
      put(path.join(logs, 'notes.txt'), 90 * DAY),
    ];
    const done = await go(f, { scope: 'logs', yes: true });
    expect(done).toMatchObject({ applied: true, count: 4, bytes: 4, remaining: [] });
    for (const file of gone) expect(existsSync(file), file).toBe(false);
    for (const file of kept) expect(existsSync(file), file).toBe(true);
  });

  it('--older-than changes the age: 1 day takes the 29-day file too, and nothing younger than a day', async () => {
    const f = setup();
    const logs = path.join(f.dir, 'logs');
    put(path.join(logs, 'runtime.log.2'), 29 * DAY);
    const young = put(path.join(logs, 'runtime.log.3'), 12 * HOUR);
    const done = await go(f, { scope: 'logs', olderThanDays: 1, yes: true });
    expect(paths(done)).toEqual(['logs/runtime.log.2']);
    expect(existsSync(young)).toBe(true);
  });

  it('skips a link inside logs/ that points out of the workspace and reports it', async () => {
    const f = setup();
    const decoy = makeTemp('decoy').path;
    const canary = put(path.join(decoy, 'canary.txt'), DAY, 'canary');
    makeJunction(path.join(f.dir, 'logs', 'runtime.log.9'), decoy);
    makeJunction(path.join(f.dir, 'logs', 'diagnostics-evil.json'), decoy);
    const real = put(path.join(f.dir, 'logs', 'runtime.log.1'), 40 * DAY);
    const done = await go(f, { scope: 'logs', yes: true });
    expect(paths(done)).toEqual(['logs/runtime.log.1']);
    expect(done.skipped.map((s) => s.path).sort()).toEqual(['logs/diagnostics-evil.json', 'logs/runtime.log.9']);
    expect(done.skipped.every((s) => s.reason.includes('link'))).toBe(true);
    expect(existsSync(real)).toBe(false);
    expect(readFileSync(canary, 'utf8')).toBe('canary');
    expect(statSync(decoy).isDirectory()).toBe(true);
  });

  it('writes the cleanup audit entry for an applied run only', async () => {
    const f = setup();
    put(path.join(f.dir, 'logs', 'runtime.log.1'), 40 * DAY, 'abc');
    put(path.join(f.dir, 'logs', 'runtime.log.2'), 40 * DAY, 'de');
    await go(f, { scope: 'logs' });
    expect(changes(f)).toBe('');
    await go(f, { scope: 'logs', yes: true });
    const text = changes(f);
    expect(text).toContain('| cleanup');
    expect(text).toContain('logs: deleted 2 files, 5 bytes');
    expect(text).toContain('2 files under logs');
    expect(text).toContain('targets re-listed');
    expect(text).toContain('applied');
    const again = await go(f, { scope: 'logs', yes: true });
    expect(again.count).toBe(0);
    expect(changes(f)).toBe(text);
  });
});

// ---- backups ------------------------------------------------------------------------------------------------------------------

describe('cleanup --scope backups', () => {
  async function backups(f: Fixture, reasons: readonly ('manual' | 'upgrade' | 'db-rebuild')[]): Promise<string[]> {
    const ws = resolveWorkspace(f.ctx.root, 'demo');
    const instance = JSON.parse(readFileSync(path.join(f.dir, 'instance.json'), 'utf8')) as InstanceFile;
    const ids: string[] = [];
    for (const reason of reasons) {
      f.clock.advance(MINUTE);
      ids.push((await make(f.ctx, ws, instance, { reason }, probing('stopped'))).id);
    }
    return ids;
  }

  const left = async (f: Fixture): Promise<string[]> =>
    (await listBackups(resolveWorkspace(f.ctx.root, 'demo'))).map((b) => b.id).reverse();

  it('removes the backups beyond --keep, oldest first, and keeps the newest upgrade backup however old', async () => {
    const f = setup();
    const ids = await backups(f, ['upgrade', 'manual', 'manual', 'manual', 'manual']);
    const dry = await go(f, { scope: 'backups', keep: 2 });
    expect(paths(dry)).toEqual(ids.slice(1, 3).map((id) => `data/backups/${id}`));
    expect(dry.skipped).toContainEqual({
      path: `data/backups/${ids[0] ?? ''}`,
      reason: 'the newest upgrade backup is always kept',
    });
    expect(await left(f)).toEqual(ids);
    const done = await go(f, { scope: 'backups', keep: 2, yes: true });
    expect(done).toMatchObject({ applied: true, count: 2, remaining: [] });
    expect(await left(f)).toEqual([ids[0], ids[3], ids[4]]);
    expect(changes(f)).toContain('backups: deleted 2 files');
  });

  it('--keep 0 removes every backup that is not a rollback point', async () => {
    const f = setup();
    const ids = await backups(f, ['manual', 'db-rebuild', 'manual', 'upgrade', 'manual']);
    const done = await go(f, { scope: 'backups', keep: 0, yes: true });
    expect(done.count).toBe(3);
    expect(await left(f)).toEqual([ids[1], ids[3]]);
  });

  it('defaults --keep to backup.keep and touches only valid backups: .partial, pre-migrate and unknown folders stay', async () => {
    const f = setup({ runtime: { backup: { keep: 1 } } });
    const ids = await backups(f, ['manual', 'manual', 'manual']);
    const dir = path.join(f.dir, 'data', 'backups');
    const strange = ['20261001T000000Z-manual.partial', 'pre-migrate-20261001T000000Z', 'orphaned-20261001T000000Z'];
    for (const name of strange) put(path.join(dir, name, 'monitor.db'), 90 * DAY, 'precious');
    const done = await go(f, { scope: 'backups', yes: true });
    expect(done.count).toBe(2);
    expect(await left(f)).toEqual([ids[2]]);
    for (const name of strange) {
      expect(readFileSync(path.join(dir, name, 'monitor.db'), 'utf8')).toBe('precious');
      expect(done.skipped.map((s) => s.path)).toContain(`data/backups/${name}`);
    }
  });

  it('does not follow a link: a backup folder that is a junction is not a backup and its target is untouched', async () => {
    const f = setup();
    const [id] = await backups(f, ['manual']);
    const decoy = makeTemp('decoy').path;
    const canary = put(path.join(decoy, 'canary.txt'), DAY, 'canary');
    const linked = path.join(f.dir, 'data', 'backups', '20250101T000000Z-manual');
    makeJunction(linked, decoy);
    const done = await go(f, { scope: 'backups', keep: 0, yes: true });
    expect(done.count).toBe(1);
    expect(paths(done)).toEqual([`data/backups/${id ?? ''}`]);
    expect(readFileSync(canary, 'utf8')).toBe('canary');
    expect(done.skipped.map((s) => s.path)).toContain('data/backups/20250101T000000Z-manual');
  });
});

// ---- the database scopes ----------------------------------------------------------------------------------------------------

const SEG = (hourBack: number): string => {
  const d = new Date(NOW - hourBack * HOUR);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `hooks-${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}Z.ndjson`;
};

function saveCursor(f: Fixture, over: Partial<NewSpoolCursor> & { segment: string }): void {
  const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'maintenance', runtimeVersion: '4.0.0' });
  try {
    withWriteTx(db, CTX, (tx) => {
      new SpoolCursorsRepo(db).save(CTX, tx, {
        offsetBytes: 0,
        sizeSeen: 0,
        ino: null,
        headHash: null,
        lines: 0,
        partialBytes: 0,
        sealed: false,
        errors: 0,
        oldestReceivedAt: null,
        newestReceivedAt: null,
        drainedAt: null,
        ...over,
      });
    });
  } finally {
    db.close();
  }
}

function cursorSegments(f: Fixture): string[] {
  const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'readonly', runtimeVersion: '4.0.0' });
  try {
    return new SpoolCursorsRepo(db).list(CTX).map((c) => c.segment);
  } finally {
    db.close();
  }
}

describe('cleanup --scope spool', () => {
  const spool = (f: Fixture, name: string): string => path.join(f.dir, 'data', 'spool', name);

  it('deletes fully drained segments past the retention and forgets their cursors; keeps everything still being read', async () => {
    const f = setup({ db: true });
    const drained = SEG(100);
    const torn = SEG(101);
    const unsealed = SEG(102);
    const grown = SEG(103);
    const unseen = SEG(104);
    const young = SEG(2);
    put(spool(f, drained), 100 * HOUR, 'aaaa\n');
    put(spool(f, torn), 100 * HOUR, 'bbb\ncc');
    put(spool(f, unsealed), 100 * HOUR, 'dddd\n');
    put(spool(f, grown), 100 * HOUR, 'eeee\nffff\n');
    put(spool(f, unseen), 100 * HOUR, 'gggg\n');
    put(spool(f, young), 2 * HOUR, 'hhhh\n');
    saveCursor(f, { segment: drained, offsetBytes: 5, sizeSeen: 5, sealed: true });
    saveCursor(f, { segment: torn, offsetBytes: 4, sizeSeen: 6, partialBytes: 2, sealed: true });
    saveCursor(f, { segment: unsealed, offsetBytes: 5, sizeSeen: 5, sealed: false });
    saveCursor(f, { segment: grown, offsetBytes: 5, sizeSeen: 5, sealed: true });
    saveCursor(f, { segment: young, offsetBytes: 5, sizeSeen: 5, sealed: true });

    const dry = await go(f, { scope: 'spool' });
    expect(paths(dry).sort()).toEqual([`data/spool/${drained}`, `data/spool/${torn}`].sort());
    expect(dry.skipped.map((s) => s.path).sort()).toEqual(
      [`data/spool/${unsealed}`, `data/spool/${grown}`, `data/spool/${unseen}`].sort(),
    );
    expect(existsSync(spool(f, drained))).toBe(true);

    const done = await go(f, { scope: 'spool', yes: true });
    expect(done).toMatchObject({ applied: true, count: 2, remaining: [] });
    for (const name of [drained, torn]) expect(existsSync(spool(f, name)), name).toBe(false);
    for (const name of [unsealed, grown, unseen, young]) expect(existsSync(spool(f, name)), name).toBe(true);
    expect(cursorSegments(f).sort()).toEqual([grown, unsealed, young].sort());
    expect(changes(f)).toContain('spool: deleted 2 files');
  });

  it('--older-than counts days from the end of the segment hour', async () => {
    const f = setup({ db: true });
    const name = SEG(60);
    put(spool(f, name), 60 * HOUR, 'aaaa\n');
    saveCursor(f, { segment: name, offsetBytes: 5, sizeSeen: 5, sealed: true });
    expect((await go(f, { scope: 'spool', olderThanDays: 3 })).count).toBe(0);
    expect((await go(f, { scope: 'spool', olderThanDays: 2 })).count).toBe(1);
  });

  it('lists nothing without a database: nothing can be shown to have been read', async () => {
    const f = setup();
    put(spool(f, SEG(100)), 100 * HOUR, 'aaaa\n');
    const result = await go(f, { scope: 'spool', yes: true });
    expect(result).toMatchObject({ applied: false, count: 0 });
    expect(result.note).toContain('no database');
    expect(existsSync(spool(f, SEG(100)))).toBe(true);
  });

  it('is blocked by a running monitor, also one of another runtime, and ignores a stale one', async () => {
    const f = setup({ db: true });
    const name = SEG(100);
    put(spool(f, name), 100 * HOUR, 'aaaa\n');
    saveCursor(f, { segment: name, offsetBytes: 5, sizeSeen: 5, sealed: true });
    for (const state of ['running', 'unmanaged-running', 'starting', 'stopping', 'unhealthy'] as const) {
      const error = await failure(go(f, { scope: 'spool', yes: true }, probing(state)));
      expect(error.code, state).toBe('INSTANCE_RUNNING');
    }
    expect(existsSync(spool(f, name))).toBe(true);
    expect((await go(f, { scope: 'spool', yes: true }, probing('foreign-pid'))).count).toBe(1);
  });

  it('does not delete a segment that is a link', async () => {
    const f = setup({ db: true });
    const decoy = makeTemp('decoy').path;
    const canary = put(path.join(decoy, 'canary.txt'), DAY, 'canary');
    const name = SEG(100);
    mkdirSync(path.dirname(spool(f, name)), { recursive: true });
    makeJunction(spool(f, name), decoy);
    saveCursor(f, { segment: name, offsetBytes: 0, sizeSeen: 0, sealed: true });
    const done = await go(f, { scope: 'spool', yes: true });
    expect(done.count).toBe(0);
    expect(readFileSync(canary, 'utf8')).toBe('canary');
  });
});

let sessionCounter = 0;

function addSession(f: Fixture, over: Record<string, string | number> = {}): number {
  sessionCounter += 1;
  const activity = typeof over['last_activity_at'] === 'number' ? over['last_activity_at'] : NOW - 40 * DAY;
  const row: Record<string, string | number> = {
    session_uid: `dddddddd-0000-4000-8000-${sessionCounter.toString(16).padStart(12, '0')}`,
    first_seen_at: activity - HOUR,
    started_at: activity - HOUR,
    last_activity_at: activity,
    updated_at: activity,
    state: 'completed',
    ...over,
  };
  const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'maintenance', runtimeVersion: '4.0.0' });
  try {
    const columns = Object.keys(row);
    return db.driver
      .prepare(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
      .run(row).lastInsertRowid;
  } finally {
    db.close();
  }
}

function count(f: Fixture, table: string): number {
  const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'readonly', runtimeVersion: '4.0.0' });
  try {
    return db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

describe('cleanup --scope data', () => {
  const apply = { scope: 'data', olderThanDays: 30, yes: true, confirm: 'demo' } as const;

  it('a dry run lists the plan, writes nothing and makes no backup', async () => {
    const f = setup({ db: true });
    addSession(f);
    addSession(f);
    addSession(f, { last_activity_at: NOW - DAY });
    const dry = await go(f, { scope: 'data', olderThanDays: 30 });
    expect(dry).toMatchObject({ applied: false, count: 2, backup: null });
    expect(dry.data).toMatchObject({ sessions: 2, freedBytes: null });
    expect(count(f, 'sessions')).toBe(3);
    expect(existsSync(path.join(f.dir, 'data', 'backups'))).toBe(false);
    expect(lines(dry).join('\n')).toContain('--yes --confirm demo');
  });

  it('makes the cleanup backup before the first row goes, then deletes old sessions; active and pinned survive, attempt runs stay', async () => {
    const f = setup({ db: true });
    const old = addSession(f);
    const pinned = addSession(f, { pinned: 1 });
    const active = addSession(f, { state: 'running' });
    const young = addSession(f, { last_activity_at: NOW - DAY });
    const dbHandle = openInstanceDb({
      path: f.dbFile,
      expectedInstanceId: ID,
      mode: 'maintenance',
      runtimeVersion: '4.0.0',
    });
    dbHandle.driver
      .prepare(
        `INSERT INTO attempt_runs (source_id, generation, start_offset, part, started_at, evidence, session_id, updated_at)
         VALUES (1, 1, 0, 'p1', :at, 'FIXTURE', :sid, :at)`,
      )
      .run({ at: NOW - 40 * DAY, sid: old });
    dbHandle.close();

    let seenAtDelete: { backups: string[]; sessions: number } | null = null;
    const result = await go(f, apply, {
      ...probing('stopped'),
      beforeStep: (step) => {
        if (step !== 'delete') return;
        const dir = path.join(f.dir, 'data', 'backups');
        seenAtDelete = { backups: existsSync(dir) ? readdirSync(dir) : [], sessions: count(f, 'sessions') };
      },
    });
    expect(seenAtDelete).toEqual({ backups: [expect.stringMatching(/-cleanup$/)], sessions: 4 });
    expect(result).toMatchObject({ applied: true, count: 1, data: { sessions: 1 } });
    expect(result.backup).toMatch(/-cleanup$/);
    const survivors = openInstanceDb({
      path: f.dbFile,
      expectedInstanceId: ID,
      mode: 'readonly',
      runtimeVersion: '4.0.0',
    });
    const ids = survivors.driver
      .prepare<{ id: number }>('SELECT id FROM sessions ORDER BY id')
      .all()
      .map((r) => r.id);
    survivors.close();
    expect(ids).toEqual([pinned, active, young]);
    expect(count(f, 'attempt_runs')).toBe(1);

    const backups = await listBackups(resolveWorkspace(f.ctx.root, 'demo'));
    expect(backups.map((b) => b.manifest.reason)).toEqual(['cleanup']);
    expect(backups[0]?.manifest.dbCopy).toBe('online');
    const text = changes(f);
    expect(text).toContain('| cleanup');
    expect(text).toContain('data: deleted 1 sessions');
    expect(text).toContain(`applied; backup ${result.backup ?? ''}`);
  });

  it('a failing backup stops the run before any row is deleted', async () => {
    const f = setup({ db: true });
    addSession(f);
    const error = await failure(
      go(f, apply, {
        ...probing('stopped'),
        beforeStep: (step) => {
          if (step === 'backup') throw new McsError('INTERNAL', 'scripted failure before the backup');
        },
      }),
    );
    expect(error.message).toContain('scripted failure');
    expect(count(f, 'sessions')).toBe(1);
  });

  it('needs a stopped instance, decided by the probe: running and unmanaged-running refuse, dry run too', async () => {
    const f = setup({ db: true });
    addSession(f);
    for (const state of ['running', 'unmanaged-running', 'unhealthy'] as const) {
      expect((await failure(go(f, apply, probing(state)))).code, state).toBe('INSTANCE_RUNNING');
      expect((await failure(go(f, { scope: 'data', olderThanDays: 30 }, probing(state)))).code, state).toBe(
        'INSTANCE_RUNNING',
      );
    }
    expect(count(f, 'sessions')).toBe(1);
    expect(existsSync(path.join(f.dir, 'data', 'backups'))).toBe(false);
  });

  it('without --older-than it follows the retention policy of runtime.json, and says so when there is none', async () => {
    const policy = setup({ db: true, runtime: { retention: { sessionsDays: 10 } } });
    addSession(policy, { last_activity_at: NOW - 11 * DAY });
    addSession(policy, { last_activity_at: NOW - 9 * DAY });
    expect((await go(policy, { scope: 'data' })).data).toMatchObject({ sessions: 1 });

    const none = setup({ db: true });
    addSession(none);
    const result = await go(none, { scope: 'data', yes: true, confirm: 'demo' });
    expect(result).toMatchObject({ applied: false, count: 0, data: null });
    expect(result.note).toContain('no retention policy');
    expect(count(none, 'sessions')).toBe(1);
    expect(existsSync(path.join(none.dir, 'data', 'backups'))).toBe(false);
  });

  it('with nothing older than the cutoff it makes no backup and deletes nothing', async () => {
    const f = setup({ db: true });
    addSession(f, { last_activity_at: NOW - DAY });
    const result = await go(f, apply);
    expect(result).toMatchObject({ applied: false, count: 0, backup: null });
    expect(result.note).toContain('nothing is older');
    expect(existsSync(path.join(f.dir, 'data', 'backups'))).toBe(false);
  });

  it('a workspace without a database has nothing to delete', async () => {
    const f = setup();
    const result = await go(f, apply);
    expect(result).toMatchObject({ applied: false, count: 0 });
    expect(result.note).toContain('no database');
  });

  it('prunes older backups after its own, which stays', async () => {
    const f = setup({ db: true, runtime: { backup: { keep: 1 } } });
    const ws = resolveWorkspace(f.ctx.root, 'demo');
    const instance = JSON.parse(readFileSync(path.join(f.dir, 'instance.json'), 'utf8')) as InstanceFile;
    await make(f.ctx, ws, instance, { reason: 'manual' }, probing('stopped'));
    f.clock.advance(MINUTE);
    addSession(f);
    const result = await go(f, apply);
    expect(result.pruned).toHaveLength(1);
    expect((await listBackups(ws)).map((b) => b.id)).toEqual([result.backup]);
  });
});

// ---- no scope removes a workspace ---------------------------------------------------------------------------------------------

describe('cleanup: removing a whole workspace is not possible', () => {
  it('every scope with --yes leaves task.json, config.json, instance.json, README.md and the audit trail', async () => {
    const f = setup({ db: true });
    put(path.join(f.dir, 'logs', 'runtime.log.1'), 90 * DAY);
    for (const scope of ['stale-state', 'logs', 'backups', 'spool'] as const) {
      await go(f, { scope, yes: true, ...(scope === 'backups' ? { keep: 0 } : {}) });
    }
    await go(f, { scope: 'data', olderThanDays: 1, yes: true, confirm: 'demo' });
    await run(f.ctx, { scope: 'init-leftovers', yes: true });
    for (const name of ['task.json', 'config.json', 'instance.json', 'README.md']) {
      expect(existsSync(path.join(f.dir, name)), name).toBe(true);
    }
  });
});
