// `configure` and `check` (01 6.4, T-CLI-04 unit part, T-ISO-07) and, because the plan lists no test file of its own for
// them, the workspace operations `init`, `discover` and `version` (`ops/workspace.ts`).
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McsError, type Clock } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, makeJunction, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { pathsCaseInsensitive } from '../platform/host.ts';
import { acquireMutex, mutexName } from '../platform/mutex.ts';
import type { Logger } from '../log/logger.ts';
import { pyJsonFileText, fromPlain } from '../pyjson/index.ts';
import type { writePyJsonFile } from '../workspace/fsio.ts';
import { resolveWorkspace } from '../workspace/paths.ts';
import { check, configure, inspect } from './config.ts';
import { discover, init, version, type OpContext } from './workspace.ts';

/** Makes the atomic write of one named workspace file fail (the sharing violation of a read-only or locked file). */
const writeFailure = vi.hoisted(() => ({ file: null as string | null }));
vi.mock('../workspace/fsio.ts', async (importOriginal) => {
  const actual = await importOriginal<{ writePyJsonFile: typeof writePyJsonFile }>();
  return {
    ...actual,
    writePyJsonFile: (...args: Parameters<typeof actual.writePyJsonFile>) => {
      const name = path.basename(args[0]);
      if (writeFailure.file === name) {
        return Promise.reject(new McsError('WORKSPACE_INVALID', `cannot replace ${name}: E_ATOMIC_WRITE_BUSY`));
      }
      return actual.writePyJsonFile(...args);
    },
  };
});

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const STAMP = '2026-10-11T14:05:07Z';
const LEGACY_FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

function contextFor(repo: string, clock: Clock = new FakeClock(NOW)): OpContext {
  const skillDir = defaultSkillDir();
  return {
    repo,
    root: path.join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };
}

function repoWith(...slugs: string[]): { repo: string; ctx: OpContext } {
  const { repo } = buildRepo(makeTemp('configure').path);
  for (const slug of slugs) {
    buildTaskWorkspace(repo, { slug, config: { title: `Fixture ${slug}` }, instance: { slug } });
  }
  return { repo, ctx: contextFor(repo) };
}

function wsPath(ctx: OpContext, slug: string, ...rel: string[]): string {
  return path.join(ctx.root, slug, ...rel);
}

function read(ctx: OpContext, slug: string, ...rel: string[]): string {
  return readFileSync(wsPath(ctx, slug, ...rel), 'utf8');
}

/** What a concurrent operation of another task leaves behind: an entry in its `audit/changes.md`. */
function appendConcurrentEntry(ctx: OpContext, slug: string): void {
  mkdirSync(wsPath(ctx, slug, 'audit'), { recursive: true });
  appendFileSync(wsPath(ctx, slug, 'audit', 'changes.md'), '## concurrent | configure\n');
}

function fileText(value: unknown): string {
  return pyJsonFileText(fromPlain(value));
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

describe('configure: a change of a legacy (L) key', () => {
  it('writes config.json with the legacy bytes, audits the change and reports the legacy keys then the new ones', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, { task: 'alpha', set: ['port=9000'], reason: 'free the port' });
    expect(report).toEqual({
      changed: true,
      changes: ['port: (default 8765) -> 9000'],
      unchanged: ['schema_version', 'title'],
      files: ['config.json'],
      isolation: 'ok',
      restart_needed: false,
    });
    expect(Object.keys(report)).toEqual(['changed', 'changes', 'unchanged', 'files', 'isolation', 'restart_needed']);
    expect(read(ctx, 'alpha', 'config.json')).toBe(fileText({ schema_version: 1, title: 'Fixture alpha', port: 9000 }));
    expect(existsSync(wsPath(ctx, 'alpha', 'runtime.json'))).toBe(false);
    expect(read(ctx, 'alpha', 'audit', 'changes.md')).toBe(
      `# Changes\n\n## ${STAMP} | configure\n- Summary: port: (default 8765) -> 9000\n- Reason: free the port\n` +
        '- Files changed: config.json\n- Validation: schema ok (strict)\n- Outcome: applied\n- Unresolved: none\n\n',
    );
  });

  it('parses the value as JSON and falls back to the raw text', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, {
      task: 'alpha',
      set: ['window_hours=12', 'title="Quoted"', 'stop_file=plain/text.txt', 'include_unmatched=true'],
    });
    expect(report.changes).toEqual([
      'window_hours: (default 8) -> 12',
      'title: "Fixture alpha" -> "Quoted"',
      'stop_file: (default null) -> "plain/text.txt"',
      'include_unmatched: (default false) -> true',
    ]);
    expect(read(ctx, 'alpha', 'config.json')).toBe(
      fileText({
        schema_version: 1,
        title: 'Quoted',
        window_hours: 12,
        stop_file: 'plain/text.txt',
        include_unmatched: true,
      }),
    );
  });

  it('sets a dotted key below an existing or new object', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, { task: 'alpha', set: ['panels.git=false', 'poll.events_ms=2500'] });
    expect(report.changes).toEqual(['panels.git: (default true) -> false', 'poll.events_ms: (default 1500) -> 2500']);
    expect(read(ctx, 'alpha', 'config.json')).toBe(
      fileText({ schema_version: 1, title: 'Fixture alpha', panels: { git: false }, poll: { events_ms: 2500 } }),
    );
  });

  it('uses the last value of a repeated key at the position of the first', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, { task: 'alpha', set: ['port=9000', 'window_hours=3', 'port=9100'] });
    expect(report.changes).toEqual(['port: (default 8765) -> 9100', 'window_hours: (default 8) -> 3']);
  });

  it('removes a key with --unset and says the default applies', async () => {
    const { ctx } = repoWith('alpha');
    await configure(ctx, { task: 'alpha', set: ['port=9000'] });
    const report = await configure(ctx, { task: 'alpha', unset: ['port'] });
    expect(report.changes).toEqual(['port: 9000 -> (removed, default applies)']);
    expect(report.unchanged).toEqual(['schema_version', 'title']);
    expect(read(ctx, 'alpha', 'config.json')).toBe(fileText({ schema_version: 1, title: 'Fixture alpha' }));
  });

  it('treats the removal of an absent key as no change', async () => {
    const { ctx } = repoWith('alpha');
    const before = read(ctx, 'alpha', 'config.json');
    const report = await configure(ctx, { task: 'alpha', unset: ['port', 'panels.git'] });
    expect(report.changed).toBe(false);
    expect(read(ctx, 'alpha', 'config.json')).toBe(before);
  });

  it('records a decision titled configuration when --decision is given', async () => {
    const { ctx } = repoWith('alpha');
    await configure(ctx, { task: 'alpha', set: ['port=9000'], decision: 'Port 9000 is free on all hosts.' });
    expect(read(ctx, 'alpha', 'audit', 'decisions.md')).toBe(
      `# Decisions\n\n## ${STAMP} | configuration\n- Decision: Port 9000 is free on all hosts.\n- Rejected alternatives: none recorded\n\n`,
    );
  });

  it('writes the file with a one-line audit entry even for a multi-line reason', async () => {
    const { ctx } = repoWith('alpha');
    await configure(ctx, { task: 'alpha', set: ['port=9000'], reason: 'one\n## forged | init-task' });
    const text = read(ctx, 'alpha', 'audit', 'changes.md');
    expect(text.split('\n').filter((line) => line.startsWith('## '))).toHaveLength(1);
    expect(text).toContain('- Reason: one ## forged | init-task\n');
  });
});

describe('configure: nothing changes, nothing is written', () => {
  it('writes nothing, audits nothing and returns exactly the legacy report for a pure no-op', async () => {
    const { ctx } = repoWith('alpha');
    const file = wsPath(ctx, 'alpha', 'config.json');
    const past = new Date(NOW - 3_600_000);
    utimesSync(file, past, past);
    const before = {
      text: read(ctx, 'alpha', 'config.json'),
      mtime: statSync(file).mtimeMs,
      tree: snapshotTree(wsPath(ctx, 'alpha')),
    };
    const report = await configure(ctx, { task: 'alpha', set: ['title=Fixture alpha'] });
    expect(report).toEqual({ changed: false, changes: [], unchanged: ['schema_version', 'title'] });
    expect(read(ctx, 'alpha', 'config.json')).toBe(before.text);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(snapshotTree(wsPath(ctx, 'alpha'))).toBe(before.tree);
    expect(existsSync(wsPath(ctx, 'alpha', 'audit'))).toBe(false);
    expect(existsSync(wsPath(ctx, 'alpha', 'runtime.json'))).toBe(false);
  });

  it('does not create runtime.json for a no-op on a runtime key either', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, { task: 'alpha', unset: ['server.port'] });
    expect(report.changed).toBe(false);
    expect(existsSync(wsPath(ctx, 'alpha', 'runtime.json'))).toBe(false);
  });

  it('rejects an invalid change with nothing written', async () => {
    const { ctx } = repoWith('alpha');
    const before = snapshotTree(wsPath(ctx, 'alpha'));
    const error = await failure(configure(ctx, { task: 'alpha', set: ['port=0', 'window_hours=-1'] }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe(
      'rejected, nothing written: port: expected integer 1-65535, got 0; window_hours: expected positive number, got -1',
    );
    expect(snapshotTree(wsPath(ctx, 'alpha'))).toBe(before);
  });

  it('rejects a pattern the translator cannot render exactly with nothing written', async () => {
    const { ctx } = repoWith('alpha');
    const before = snapshotTree(wsPath(ctx, 'alpha'));
    const error = await failure(
      configure(ctx, { task: 'alpha', set: ['session_rules=[{"match": "(?>a)b", "label": "x"}]'] }),
    );
    expect(error.message.startsWith('rejected, nothing written: ')).toBe(true);
    expect(snapshotTree(wsPath(ctx, 'alpha'))).toBe(before);
  });

  it('refuses a dotted key below something that is not an object', async () => {
    const { ctx } = repoWith('alpha');
    const before = snapshotTree(wsPath(ctx, 'alpha'));
    const error = await failure(configure(ctx, { task: 'alpha', set: ['title.x=1'] }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe('cannot set title.x: title is not an object');
    expect(snapshotTree(wsPath(ctx, 'alpha'))).toBe(before);
  });

  it('refuses to change or remove schema_version with the legacy wording', async () => {
    const { ctx } = repoWith('alpha');
    expect((await failure(configure(ctx, { task: 'alpha', set: ['schema_version=2'] }))).message).toBe(
      'schema_version cannot be changed with configure',
    );
    expect((await failure(configure(ctx, { task: 'alpha', set: ['schema_version.x=1'] }))).message).toBe(
      'schema_version cannot be changed with configure',
    );
    expect((await failure(configure(ctx, { task: 'alpha', unset: ['schema_version'] }))).message).toBe(
      'schema_version cannot be removed',
    );
  });

  it('is a usage error when --set has no equals sign', async () => {
    const { ctx } = repoWith('alpha');
    const error = await failure(configure(ctx, { task: 'alpha', set: ['port9000'] }));
    expect(error.code).toBe('USAGE');
    expect(error.message).toBe("--set expects KEY=JSON_VALUE, got 'port9000'");
  });

  it('refuses a task without task.json and an invalid slug', async () => {
    const { ctx } = repoWith('alpha');
    expect((await failure(configure(ctx, { task: 'nope', set: ['port=9000'] }))).code).toBe('TASK_NOT_FOUND');
    expect((await failure(configure(ctx, { task: '../alpha', set: ['port=9000'] }))).code).toBe('SLUG_INVALID');
  });

  it('refuses a config.json without schema_version', async () => {
    const { ctx } = repoWith('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'config.json'), '{"title": "x"}\n');
    expect((await failure(configure(ctx, { task: 'alpha', set: ['port=9000'] }))).code).toBe('CONFIG_SCHEMA_MISSING');
  });
});

describe('configure: keys that try to leave the configuration (T-ISO-07)', () => {
  it.each(['../b', 'a/../../b', '__proto__.x', 'constructor.prototype.x', 'prototype.x', 'a\\b'])(
    'rejects %s as an unknown key and writes nothing',
    async (key) => {
      const { ctx } = repoWith('alpha', 'b');
      const before = snapshotTree(ctx.root);
      const error = await failure(configure(ctx, { task: 'alpha', set: [`${key}=1`] }));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message.startsWith('rejected, nothing written: unknown key ')).toBe(true);
      expect(snapshotTree(ctx.root)).toBe(before);
      expect(Object.hasOwn(Object.prototype, 'x')).toBe(false);
      expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    },
  );

  it('rejects the same keys for --unset', async () => {
    const { ctx } = repoWith('alpha');
    const error = await failure(configure(ctx, { task: 'alpha', unset: ['__proto__.x'] }));
    expect(error.message).toBe("rejected, nothing written: unknown key '__proto__.x'");
  });
});

describe('configure: runtime (R) keys', () => {
  it('creates runtime.json on demand, leaves config.json alone and audits the file', async () => {
    const { ctx } = repoWith('alpha');
    const configBefore = read(ctx, 'alpha', 'config.json');
    const report = await configure(ctx, { task: 'alpha', set: ['server.port=19000'] });
    expect(report.changes).toEqual(['server.port: (default null) -> 19000']);
    expect(report.files).toEqual(['runtime.json']);
    expect(read(ctx, 'alpha', 'runtime.json')).toBe(fileText({ schema_version: 1, server: { port: 19000 } }));
    expect(read(ctx, 'alpha', 'config.json')).toBe(configBefore);
    expect(read(ctx, 'alpha', 'audit', 'changes.md')).toContain('- Files changed: runtime.json\n');
  });

  it('merges into an existing runtime.json and keeps its other keys', async () => {
    const { repo } = repoWith();
    buildTaskWorkspace(repo, {
      slug: 'beta',
      config: { title: 'B' },
      runtime: { logLevel: 'warn', server: { port: 19001 } },
      instance: { slug: 'beta' },
    });
    const ctx = contextFor(repo);
    const report = await configure(ctx, { task: 'beta', set: ['server.port=19002', 'health.backlogWarnMs=20000'] });
    expect(report.files).toEqual(['runtime.json']);
    expect(report.changes[0]).toBe('server.port: 19001 -> 19002');
    const parsed: unknown = JSON.parse(read(ctx, 'beta', 'runtime.json'));
    expect(parsed).toMatchObject({
      schema_version: 1,
      logLevel: 'warn',
      server: { port: 19002 },
      health: { backlogWarnMs: 20000 },
    });
  });

  it('writes both files and lists both in the audit entry when a call changes keys of both kinds', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, { task: 'alpha', set: ['port=9000', 'logLevel="debug"'] });
    expect(report.files).toEqual(['config.json', 'runtime.json']);
    expect(read(ctx, 'alpha', 'audit', 'changes.md')).toContain('- Files changed: config.json, runtime.json\n');
  });

  it('rejects an unknown runtime sub-key and a wrong type with nothing written, creating no runtime.json', async () => {
    const { ctx } = repoWith('alpha');
    const before = snapshotTree(wsPath(ctx, 'alpha'));
    const unknown = await failure(configure(ctx, { task: 'alpha', set: ['server.nope=1'] }));
    expect(unknown.code).toBe('CONFIG_INVALID');
    expect(unknown.message).toContain('rejected, nothing written: runtime.json: server');
    const wrong = await failure(configure(ctx, { task: 'alpha', set: ['server.port="x"'] }));
    expect(wrong.message).toContain('rejected, nothing written: runtime.json: server.port');
    expect(snapshotTree(wsPath(ctx, 'alpha'))).toBe(before);
    expect(existsSync(wsPath(ctx, 'alpha', 'runtime.json'))).toBe(false);
  });
});

describe('configure: dry run, isolation and the running instance', () => {
  it('prints the report with dry_run and writes nothing', async () => {
    const { ctx } = repoWith('alpha');
    const before = snapshotTree(wsPath(ctx, 'alpha'));
    const report = await configure(ctx, { task: 'alpha', set: ['port=9000'], dryRun: true });
    expect(report).toEqual({
      changed: true,
      changes: ['port: (default 8765) -> 9000'],
      unchanged: ['schema_version', 'title'],
      files: ['config.json'],
      restart_needed: false,
      dry_run: true,
    });
    expect(snapshotTree(wsPath(ctx, 'alpha'))).toBe(before);
  });

  it('keeps the legacy no-op report and adds dry_run for a dry run without changes', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(ctx, { task: 'alpha', set: ['title=Fixture alpha'], dryRun: true });
    expect(report).toEqual({ changed: false, changes: [], unchanged: ['schema_version', 'title'], dry_run: true });
  });

  it('leaves every other workspace byte for byte alone and reports isolation ok', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const before = snapshotTree(wsPath(ctx, 'beta'));
    const report = await configure(ctx, { task: 'alpha', set: ['port=9000', 'server.port=19000'] });
    expect(report.isolation).toBe('ok');
    expect(snapshotTree(wsPath(ctx, 'beta'))).toBe(before);
  });

  it('fails with ISOLATION_VIOLATION when another workspace changes during the call, after the write', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const error = await failure(
      configure(
        ctx,
        { task: 'alpha', set: ['port=9000'] },
        {
          onWritten: () => {
            writeFileSync(wsPath(ctx, 'beta', 'README.md'), 'changed by another writer\n');
          },
        },
      ),
    );
    expect(error.code).toBe('ISOLATION_VIOLATION');
    expect(error.message).toBe('isolation violated: another task changed during configure (this is a bug)');
    expect(read(ctx, 'alpha', 'config.json')).toContain('"port": 9000');
  });

  it('ignores the files a running instance changes by itself in other workspaces', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const report = await configure(
      ctx,
      { task: 'alpha', set: ['port=9000'] },
      {
        onWritten: () => {
          mkdirSync(wsPath(ctx, 'beta', 'data'), { recursive: true });
          writeFileSync(wsPath(ctx, 'beta', 'data', 'monitor.db'), 'busy');
          writeFileSync(wsPath(ctx, 'beta', 'state.json'), '{}');
        },
      },
    );
    expect(report.isolation).toBe('ok');
  });

  it('does not fail for a task whose audit trail changed in the same window, and logs only the slug at debug level', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const debug = vi.fn();
    const logged: OpContext = { ...ctx, log: { ...silent, debug } };
    const report = await configure(
      logged,
      { task: 'alpha', set: ['port=9000'] },
      {
        onWritten: () => {
          writeFileSync(
            wsPath(ctx, 'beta', 'config.json'),
            fileText({ schema_version: 1, title: 'Fixture beta', port: 9100 }),
          );
          appendConcurrentEntry(ctx, 'beta');
        },
      },
    );
    expect(report.isolation).toBe('ok');
    expect(debug).toHaveBeenCalledWith('configure.isolation.concurrent', { tasks: ['beta'] });
    expect(read(ctx, 'alpha', 'config.json')).toContain('"port": 9000');
  });

  it('does not fail for a task whose task mutex is held while it changes (its operation is under way)', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const held = await acquireMutex(mutexName('task', resolveWorkspace(ctx.root, 'beta').realDir), { timeoutMs: 1000 });
    try {
      const report = await configure(
        ctx,
        { task: 'alpha', set: ['port=9000'] },
        {
          onWritten: () => {
            writeFileSync(wsPath(ctx, 'beta', 'README.md'), 'written by a task that holds its mutex\n');
          },
        },
      );
      expect(report.isolation).toBe('ok');
    } finally {
      await held.release();
    }
  });

  it('still fails when a task changed without its audit trail changing and without its mutex held', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const debug = vi.fn();
    const logged: OpContext = { ...ctx, log: { ...silent, debug } };
    const error = await failure(
      configure(
        logged,
        { task: 'alpha', set: ['port=9000'] },
        {
          onWritten: () => {
            writeFileSync(
              wsPath(ctx, 'beta', 'config.json'),
              fileText({ schema_version: 1, title: 'Edited', port: 9100 }),
            );
          },
        },
      ),
    );
    expect(error.code).toBe('ISOLATION_VIOLATION');
    expect(error.details).toEqual({ tasks: ['beta'] });
    expect(debug).not.toHaveBeenCalledWith('configure.isolation.concurrent', expect.anything());
  });

  it('reports every task that changed without an explanation and none that has one', async () => {
    const { ctx } = repoWith('alpha', 'beta', 'gamma');
    const error = await failure(
      configure(
        ctx,
        { task: 'alpha', set: ['port=9000'] },
        {
          onWritten: () => {
            writeFileSync(wsPath(ctx, 'beta', 'README.md'), 'changed\n');
            writeFileSync(wsPath(ctx, 'gamma', 'README.md'), 'changed with an audit entry\n');
            appendConcurrentEntry(ctx, 'gamma');
          },
        },
      ),
    );
    expect(error.details).toEqual({ tasks: ['beta'] });
  });

  it('never reports a false violation for concurrent configure calls on different tasks (50 rounds)', async () => {
    const { ctx } = repoWith('alpha', 'beta');
    const rounds = 50;
    for (let round = 0; round < rounds; round += 1) {
      const [a, b] = await Promise.all([
        configure(ctx, { task: 'alpha', set: [`port=${String(9000 + round)}`], reason: `alpha ${String(round)}` }),
        configure(ctx, { task: 'beta', set: [`window_hours=${String(1 + round)}`], reason: `beta ${String(round)}` }),
      ]);
      expect(a.isolation).toBe('ok');
      expect(b.isolation).toBe('ok');
    }
    expect(read(ctx, 'alpha', 'config.json')).toContain(`"port": ${String(9000 + rounds - 1)}`);
    expect(read(ctx, 'beta', 'config.json')).toContain(`"window_hours": ${String(rounds)}`);
    expect(read(ctx, 'alpha', 'audit', 'changes.md').match(/^## /gm)).toHaveLength(rounds);
    expect(read(ctx, 'beta', 'audit', 'changes.md').match(/^## /gm)).toHaveLength(rounds);
  }, 120_000);

  it('says a restart is needed when the instance runs', async () => {
    const { ctx } = repoWith('alpha');
    const report = await configure(
      ctx,
      { task: 'alpha', set: ['port=9000'] },
      { isRunning: () => Promise.resolve(true) },
    );
    expect(report.restart_needed).toBe(true);
  });

  it('detects a live instance from the state file when no probe is injected', async () => {
    const { ctx } = repoWith('alpha');
    const state = {
      pid: process.pid,
      url: 'http://127.0.0.1:18999',
      port: 18999,
      started: 1,
      version: '3.0.0',
      task: 'alpha',
      config: null,
    };
    writeFileSync(wsPath(ctx, 'alpha', 'state.json'), JSON.stringify(state));
    expect((await configure(ctx, { task: 'alpha', set: ['port=9000'] })).restart_needed).toBe(true);
  });

  it('says that the files were written but not audited when the audit append fails', async () => {
    const { ctx } = repoWith('alpha');
    mkdirSync(wsPath(ctx, 'alpha', 'audit', 'changes.md'), { recursive: true });
    const error = await failure(configure(ctx, { task: 'alpha', set: ['port=9001'] }));
    expect(error.code).toBe('WORKSPACE_INVALID');
    expect(error.message).toContain('cannot append to changes.md');
    expect(error.message).toContain('config.json was written but the change is not audited');
    expect(error.details).toEqual({ written: ['config.json'] });
    expect(JSON.parse(read(ctx, 'alpha', 'config.json'))).toMatchObject({ port: 9001 });
  });

  it('names the written file when the second file cannot be written, and keeps the code', async () => {
    const { ctx } = repoWith('alpha');
    writeFailure.file = 'runtime.json';
    try {
      const error = await failure(configure(ctx, { task: 'alpha', set: ['title=Changed', 'server.port=9999'] }));
      expect(error.code).toBe('WORKSPACE_INVALID');
      expect(error.message).toContain('cannot replace runtime.json: E_ATOMIC_WRITE_BUSY');
      expect(error.message).toContain('config.json was written but the change is not audited');
      expect(error.message).toContain('failed at: writing runtime.json');
      expect(error.details).toEqual({ written: ['config.json'] });
      expect(JSON.parse(read(ctx, 'alpha', 'config.json'))).toMatchObject({ title: 'Changed' });
      expect(existsSync(wsPath(ctx, 'alpha', 'runtime.json'))).toBe(false);
    } finally {
      writeFailure.file = null;
    }
  });

  it('passes the original error on unchanged when the first write already fails', async () => {
    const { ctx } = repoWith('alpha');
    writeFailure.file = 'config.json';
    try {
      const error = await failure(configure(ctx, { task: 'alpha', set: ['title=Changed'] }));
      expect(error.message).toBe('cannot replace config.json: E_ATOMIC_WRITE_BUSY');
      expect(error.details).toBeUndefined();
    } finally {
      writeFailure.file = null;
    }
  });

  it('says what was written when the route-file hook fails, for an error of the engine and for any other', async () => {
    const { ctx } = repoWith('alpha');
    const sessionIds = 'session_ids=["11111111-2222-4333-8444-555555555555"]';
    const first = await failure(
      configure(
        ctx,
        { task: 'alpha', set: [sessionIds] },
        { onRoutingChanged: () => Promise.reject(new McsError('WORKSPACE_INVALID', 'cannot replace route.json')) },
      ),
    );
    expect(first.code).toBe('WORKSPACE_INVALID');
    expect(first.message).toContain('cannot replace route.json');
    expect(first.message).toContain('config.json was written but the change is not audited');
    expect(first.message).toContain('failed at: rewriting the route file');
    expect(first.details).toEqual({ written: ['config.json'] });
    expect(JSON.parse(read(ctx, 'alpha', 'config.json'))).toMatchObject({
      session_ids: ['11111111-2222-4333-8444-555555555555'],
    });
    const second = await failure(
      configure(
        ctx,
        { task: 'alpha', set: ['repo="."'] },
        { onRoutingChanged: () => Promise.reject(new Error('EPERM: operation not permitted')) },
      ),
    );
    expect(second.code).toBe('INTERNAL');
    expect(second.message).toContain('EPERM: operation not permitted');
    expect(second.message).toContain('failed at: rewriting the route file');
    expect(second.details).toEqual({ written: ['config.json'] });
  });

  it('says what was written when the after-write hook throws something that is not an engine error', async () => {
    const { ctx } = repoWith('alpha');
    const error = await failure(
      configure(
        ctx,
        { task: 'alpha', set: ['port=9001'] },
        {
          onWritten: () => {
            throw new Error('boom');
          },
        },
      ),
    );
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('boom; config.json was written but the change is not audited');
  });

  it('tells that the change is audited when only the decision cannot be appended', async () => {
    const { ctx } = repoWith('alpha');
    mkdirSync(wsPath(ctx, 'alpha', 'audit', 'decisions.md'), { recursive: true });
    const error = await failure(configure(ctx, { task: 'alpha', set: ['port=9001'], decision: 'use 9001' }));
    expect(error.code).toBe('WORKSPACE_INVALID');
    expect(error.message).toContain('cannot append to decisions.md');
    expect(error.message).toContain('config.json was written and the change is audited in changes.md');
    expect(error.message).toContain('the decision is not recorded');
    expect(error.message).not.toContain('is not audited');
    expect(error.hint).toContain('decide');
    expect(error.details).toEqual({ written: ['config.json'], audited: true });
    expect(read(ctx, 'alpha', 'audit', 'changes.md')).toContain('port: (default 8765) -> 9001');
  });

  it('serializes two calls on the same workspace: both changes survive', async () => {
    const { ctx } = repoWith('alpha');
    await Promise.all([
      configure(ctx, { task: 'alpha', set: ['port=9000'] }),
      configure(ctx, { task: 'alpha', set: ['window_hours=3'] }),
      configure(ctx, { task: 'alpha', set: ['server.port=19000'] }),
    ]);
    const config: unknown = JSON.parse(read(ctx, 'alpha', 'config.json'));
    expect(config).toMatchObject({ port: 9000, window_hours: 3 });
    expect(read(ctx, 'alpha', 'runtime.json')).toBe(fileText({ schema_version: 1, server: { port: 19000 } }));
    expect(read(ctx, 'alpha', 'audit', 'changes.md').match(/^## /gm)).toHaveLength(3);
  });

  it('removes an explicit null silently, as the legacy command does, and writes nothing for it alone', async () => {
    const { repo } = repoWith();
    buildTaskWorkspace(repo, { slug: 'nully', config: { title: 'N', stop_file: null } });
    const ctx = contextFor(repo);
    const before = read(ctx, 'nully', 'config.json');
    const report = await configure(ctx, { task: 'nully', unset: ['stop_file'] });
    expect(report.changed).toBe(false);
    expect(read(ctx, 'nully', 'config.json')).toBe(before);
    const mixed = await configure(ctx, { task: 'nully', unset: ['stop_file'], set: ['port=9000'] });
    expect(mixed.changes).toEqual(['port: (default 8765) -> 9000']);
    expect(read(ctx, 'nully', 'config.json')).not.toContain('stop_file');
  });

  it('calls the route-file hook only when repo, transcripts_dir or session_ids changed', async () => {
    const { ctx } = repoWith('alpha');
    const rewrite = vi.fn(() => Promise.resolve());
    await configure(ctx, { task: 'alpha', set: ['port=9000'] }, { onRoutingChanged: rewrite });
    expect(rewrite).not.toHaveBeenCalled();
    await configure(
      ctx,
      { task: 'alpha', set: ['session_ids=["11111111-2222-4333-8444-555555555555"]'] },
      { onRoutingChanged: rewrite },
    );
    expect(rewrite).toHaveBeenCalledTimes(1);
  });
});

describe('a workspace written by the legacy engine', () => {
  function legacyRepo(): OpContext {
    const { repo } = buildRepo(makeTemp('legacy').path);
    const ctx = contextFor(repo);
    cpSync(LEGACY_FIXTURE, wsPath(ctx, 'legacy-demo'), { recursive: true });
    return ctx;
  }

  it('is left byte for byte alone by a configure that sets what the legacy engine already set', async () => {
    const ctx = legacyRepo();
    const before = snapshotTree(wsPath(ctx, 'legacy-demo'));
    const report = await configure(ctx, { task: 'legacy-demo', set: ['window_hours=12', 'title=Legacy demo task'] });
    expect(report).toEqual({ changed: false, changes: [], unchanged: ['schema_version', 'title', 'window_hours'] });
    expect(snapshotTree(wsPath(ctx, 'legacy-demo'))).toBe(before);
  });

  it('is configured with the legacy bytes: the old audit text stays a prefix of the new one', async () => {
    const ctx = legacyRepo();
    const oldAudit = read(ctx, 'legacy-demo', 'audit', 'changes.md');
    const report = await configure(ctx, { task: 'legacy-demo', set: ['window_hours=24'], reason: 'longer window' });
    expect(report.changes).toEqual(['window_hours: 12 -> 24']);
    expect(read(ctx, 'legacy-demo', 'config.json')).toBe(
      fileText({ schema_version: 1, title: 'Legacy demo task', window_hours: 24 }),
    );
    expect(read(ctx, 'legacy-demo', 'audit', 'changes.md').startsWith(oldAudit)).toBe(true);
    expect(existsSync(wsPath(ctx, 'legacy-demo', 'runtime.json'))).toBe(false);
    expect(existsSync(wsPath(ctx, 'legacy-demo', 'instance.json'))).toBe(false);
  });

  it('is inspected with the last change and recent audit of the legacy parser', async () => {
    const ctx = legacyRepo();
    const { report } = await inspect(ctx, { task: 'legacy-demo' });
    expect(report.last_change).toEqual({ t: '2026-10-11T16:38:28Z', summary: 'window_hours: (default 8) -> 12' });
    expect(report.recent_audit).toBe(read(ctx, 'legacy-demo', 'audit', 'changes.md'));
    expect(report.engine).toBe('legacy');
    expect(report.instance).toBeNull();
    expect(report.effective['window_hours']).toBe(12);
    expect(report.overridden_keys).toEqual(expect.arrayContaining(['title', 'window_hours']));
  });
});

describe('check', () => {
  it('prints the legacy line for a workspace', async () => {
    const { repo, ctx } = repoWith('alpha');
    buildTaskWorkspace(repo, { slug: 'beta', config: { title: 'B', panels: { git: false, logs: false } } });
    const result = await check(ctx, { task: 'alpha' });
    expect(result.line).toBe(
      `title: Fixture alpha | repo: ${path.resolve(repo)} | transcripts: auto | rules: 0 | window: 8h | panels: machine,git,logs | source: task`,
    );
    expect(result.source).toBe('task');
    const second = await check(ctx, { task: 'beta' });
    expect(second.panels).toEqual(['machine']);
    expect(second.line).toContain('| panels: machine | source: task');
  });

  it('prints a float window_hours as Python does, an integer one without a fraction', async () => {
    const { ctx } = repoWith('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'config.json'), '{"schema_version": 1, "title": "t", "window_hours": 8.0}');
    const floated = await check(ctx, { task: 'alpha' });
    expect(floated.line).toContain('| window: 8.0h |');
    expect(floated.windowHours).toBe(8);
    writeFileSync(wsPath(ctx, 'alpha', 'config.json'), '{"schema_version": 1, "title": "t", "window_hours": 6}');
    expect((await check(ctx, { task: 'alpha' })).line).toContain('| window: 6h |');
  });

  it('adds the effective port, the engine and the number of patterns checked', async () => {
    const { ctx } = repoWith('alpha');
    await configure(ctx, {
      task: 'alpha',
      set: [
        'session_rules=[{"match": "^deploy", "label": "d"}]',
        'attempts={"start": "^go", "end": "^done"}',
        'server.port=19000',
      ],
    });
    const result = await check(ctx, { task: 'alpha' });
    expect(result.effectivePort).toBe(19000);
    expect(result.engine).toBe('node');
    expect(result.regex).toEqual({ checked: 3, ok: true });
    expect(result.rules).toBe(1);
  });

  it('uses the default workspace when no task is given and it exists', async () => {
    const { ctx } = repoWith('default');
    expect((await check(ctx, {})).line).toContain('title: Fixture default |');
  });

  it('validates the shared defaults only when there is no task and no default workspace', async () => {
    const { ctx } = repoWith('alpha');
    const result = await check(ctx, {});
    expect(result.source).toBe('defaults');
    expect(result.title).toBe('Claude sessions monitor');
    expect(result.line).toContain('| source: defaults');
  });

  it('prints the resolved transcripts folder of the injected discovery', async () => {
    const { ctx } = repoWith('alpha');
    const result = await check(
      ctx,
      { task: 'alpha' },
      { transcriptsDir: () => Promise.resolve('C:/claude/projects/x') },
    );
    expect(result.line).toContain('| transcripts: C:/claude/projects/x |');
  });

  it('fails with the config error for an invalid config', async () => {
    const { ctx } = repoWith('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'config.json'), '{"schema_version": 1, "title": ""}\n');
    const error = await failure(check(ctx, { task: 'alpha' }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('title: expected non-empty string');
  });
});

describe('init', () => {
  it('creates a workspace and prints the legacy line', async () => {
    const { repo } = buildRepo(makeTemp('init').path);
    const ctx = contextFor(repo);
    const result = await init(ctx, { name: 'Nightly build', description: 'Checks it.', port: 9100 });
    expect(result).toMatchObject({ created: true, adopted: false, slug: 'nightly-build', engine: 'node' });
    expect(result.message).toEqual([`created task 'nightly-build' at ${path.join(ctx.root, 'nightly-build')}`]);
    expect(read(ctx, 'nightly-build', 'config.json')).toBe(
      fileText({ schema_version: 1, title: 'Nightly build', port: 9100 }),
    );
    expect(read(ctx, 'nightly-build', 'audit', 'changes.md')).toContain(`## ${STAMP} | init-task\n`);
  });

  it('reuses an existing workspace without writing and says so', async () => {
    const { repo } = buildRepo(makeTemp('init').path);
    const ctx = contextFor(repo);
    await init(ctx, { name: 'Nightly build' });
    const before = snapshotTree(ctx.root);
    const again = await init(ctx, { name: 'Nightly build' });
    expect(again.created).toBe(false);
    expect(again.message).toEqual([
      `reused (nothing overwritten) task 'nightly-build' at ${path.join(ctx.root, 'nightly-build')}`,
    ]);
    expect(snapshotTree(ctx.root)).toBe(before);
  });

  it('adopts a legacy workspace and adds the Node line', async () => {
    const { repo } = buildRepo(makeTemp('init').path);
    buildTaskWorkspace(repo, { slug: 'old-task', config: { title: 'Old' } });
    const ctx = contextFor(repo);
    const result = await init(ctx, { name: 'Old', slug: 'old-task' });
    expect(result).toMatchObject({ created: false, adopted: true });
    expect(result.message[1]).toBe('added Node runtime files: instance.json');
    expect(read(ctx, 'old-task', 'audit', 'changes.md')).toContain('| adopt-instance\n');
  });

  it('uses the slug as the name when only a slug is given and requires one of them', async () => {
    const { repo } = buildRepo(makeTemp('init').path);
    const ctx = contextFor(repo);
    expect((await init(ctx, { slug: 'only-slug' })).slug).toBe('only-slug');
    expect(read(ctx, 'only-slug', 'config.json')).toContain('"title": "only-slug"');
    expect((await failure(init(ctx, {}))).code).toBe('USAGE');
  });

  it('refuses a differing config for an existing workspace and an invalid slug', async () => {
    const { repo } = buildRepo(makeTemp('init').path);
    const ctx = contextFor(repo);
    await init(ctx, { name: 'Nightly build', port: 9100 });
    expect((await failure(init(ctx, { name: 'Nightly build', port: 9200 }))).code).toBe(
      'WORKSPACE_EXISTS_CONFIG_DIFFERS',
    );
    expect((await failure(init(ctx, { name: 'x', slug: 'Bad Slug' }))).code).toBe('SLUG_INVALID');
  });

  it('passes the engine and runs the before-rename hook once', async () => {
    const { repo } = buildRepo(makeTemp('init').path);
    const ctx = contextFor(repo);
    const hook = vi.fn();
    const result = await init(ctx, { name: 'Legacy engine', engine: 'legacy' }, { beforeRename: hook });
    expect(result.engine).toBe('legacy');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(readdirSync(ctx.root).filter((name) => name.startsWith('.init-'))).toEqual([]);
  });
});

describe('discover', () => {
  it('prints the legacy lines and the Node lines for a repo without transcripts', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    mkdirSync(path.join(repo, 'logs'), { recursive: true });
    writeFileSync(path.join(repo, 'logs', 'build.log'), 'x');
    writeFileSync(path.join(repo, 'server.log'), 'x');
    writeFileSync(path.join(repo, 'PROJECT-status.md'), 'x');
    mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'pkg', 'build-status.md'), 'x');
    const ctx = contextFor(repo);
    await init(ctx, { name: 'Alpha' });
    const result = await discover(ctx);
    expect(result.lines).toEqual([
      `repo: ${repo}`,
      'transcripts: (not found: pass transcripts_dir explicitly)',
      'log candidate: logs/build.log',
      'log candidate: server.log',
      'ledger candidate: PROJECT-status.md',
      `tasks: alpha  [${ctx.root}]`,
      expect.stringMatching(/^runtime: mcs \d+\.\d+\.\d+ \(build unknown\)$/),
      'legacy engine: not found',
      'hooks: not installed',
      'instances:',
      '  alpha engine=node state=stopped -',
    ]);
    expect(result.tasks).toEqual(['alpha']);
    expect(result.instances).toEqual([{ slug: 'alpha', engine: 'node', state: 'stopped', url: null }]);
  });

  it('lists mixed-case log and ledger names the way the host file system matches them', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    mkdirSync(path.join(repo, 'logs'), { recursive: true });
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'logs', 'RUN.LOG'), 'x');
    writeFileSync(path.join(repo, 'STATUS.md'), 'x');
    writeFileSync(path.join(repo, 'docs', 'Project-Status.md'), 'x');
    writeFileSync(path.join(repo, 'docs', 'release-status.md'), 'x');
    const result = await discover(contextFor(repo));
    const candidates = result.lines.filter((l) => /^(log|ledger) candidate: /.test(l));
    expect(candidates).toEqual(
      pathsCaseInsensitive
        ? [
            'log candidate: logs/RUN.LOG',
            'ledger candidate: STATUS.md',
            'ledger candidate: docs/Project-Status.md',
            'ledger candidate: docs/release-status.md',
          ]
        : ['ledger candidate: docs/release-status.md'],
    );
  });

  it('does not list hidden files or anything below a hidden folder', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    mkdirSync(path.join(repo, '.hid'), { recursive: true });
    mkdirSync(path.join(repo, 'logs'), { recursive: true });
    writeFileSync(path.join(repo, '.hid', 'status.md'), 'x');
    writeFileSync(path.join(repo, '.hid', 'x.log'), 'x');
    writeFileSync(path.join(repo, '.hidden.log'), 'x');
    writeFileSync(path.join(repo, 'logs', '.hidden.log'), 'x');
    const result = await discover(contextFor(repo));
    expect(result.lines.filter((l) => /^(log|ledger) candidate: /.test(l))).toEqual([]);
  });

  it('does not follow a folder link, so a link loop lists each file once', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    mkdirSync(path.join(repo, 'logs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'real-status.md'), 'x');
    writeFileSync(path.join(repo, 'logs', 'a.log'), 'x');
    makeJunction(path.join(repo, 'docs', 'loop'), repo);
    makeJunction(path.join(repo, 'logs', 'again'), repo);
    const result = await discover(contextFor(repo));
    expect(result.lines.filter((l) => /^(log|ledger) candidate: /.test(l))).toEqual([
      'log candidate: logs/a.log',
      'ledger candidate: docs/real-status.md',
    ]);
  });

  it('keeps at most five ledger candidates and drops those below node_modules like the legacy filter', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    for (let i = 0; i < 7; i += 1) writeFileSync(path.join(repo, 'a' + String(i) + '-status.md'), 'x');
    const result = await discover(contextFor(repo));
    const ledgers = result.lines.filter((l) => l.startsWith('ledger candidate: '));
    expect(ledgers).toEqual([0, 1, 2, 3, 4].map((i) => 'ledger candidate: a' + String(i) + '-status.md'));
  });

  it('prints recent sessions in the legacy format from the injected discovery', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    const ctx = contextFor(repo);
    const result = await discover(ctx, {
      transcripts: {
        detectDir: () => Promise.resolve('C:/claude/projects/x'),
        recentSessions: (_dir, limit) => {
          expect(limit).toBe(15);
          return Promise.resolve([
            { id: 'aaaa-1111', ageSeconds: 12.4, bytes: 2048, firstPrompt: '  Please\nrun the tests  ' },
            { id: 'bbbb-2222', ageSeconds: 86_400, bytes: 7, firstPrompt: 'x'.repeat(200) },
          ]);
        },
      },
      buildStatus: () => Promise.resolve('stale'),
      legacyEngine: () => Promise.resolve({ version: '3.14.3', exe: 'C:/python/python.exe' }),
      hooksSummary: () => Promise.resolve('installed (project-local)'),
    });
    expect(result.lines.slice(0, 5)).toEqual([
      `repo: ${repo}`,
      'transcripts: C:/claude/projects/x',
      'recent sessions (newest first):',
      '  aaaa-1111     12s ago      2048 B  Please run the tests',
      `  bbbb-2222  86400s ago         7 B  ${'x'.repeat(110)}`,
    ]);
    expect(result.lines).toContain('legacy engine: python 3.14.3 at C:/python/python.exe');
    expect(result.lines).toContain('hooks: installed (project-local)');
    expect(result.runtime.build).toBe('stale');
    expect(result.lines).toContain('tasks: (none)  [' + ctx.root + ']');
    expect(result.lines.at(-1)).toBe('instances: (none)');
  });

  it('shows a legacy-only workspace with engine=legacy and uses an injected probe', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    buildTaskWorkspace(repo, { slug: 'old-task', config: { title: 'Old' } });
    const ctx = contextFor(repo);
    const result = await discover(ctx, { probeState: () => Promise.resolve('legacy-running') });
    expect(result.lines.at(-1)).toBe('  old-task engine=legacy state=legacy-running -');
  });

  it('reports a workspace whose identity cannot be used as invalid, not as a stopped legacy one', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    buildTaskWorkspace(repo, { slug: 'alpha', config: { title: 'A' }, instance: { slug: 'alpha' } });
    buildTaskWorkspace(repo, { slug: 'copied', config: { title: 'C' }, instance: { slug: 'alpha' } });
    buildTaskWorkspace(repo, { slug: 'garbled', config: { title: 'G' } });
    const root = path.join(repo, '.claude', 'monitor', 'tasks');
    writeFileSync(path.join(root, 'garbled', 'instance.json'), '{ not json');
    writeFileSync(
      path.join(root, 'garbled', 'state.json'),
      JSON.stringify({
        pid: process.pid,
        url: 'http://127.0.0.1:18999',
        port: 18999,
        started: 1,
        version: '3.0.0',
        task: 'garbled',
        config: null,
      }),
    );
    const result = await discover(contextFor(repo));
    expect(result.instances).toEqual([
      { slug: 'alpha', engine: 'node', state: 'stopped', url: null },
      { slug: 'copied', engine: 'unknown', state: 'invalid', url: null },
      { slug: 'garbled', engine: 'unknown', state: 'invalid', url: null },
    ]);
    expect(result.lines.slice(-3)).toEqual([
      '  alpha engine=node state=stopped -',
      '  copied engine=unknown state=invalid -',
      '  garbled engine=unknown state=invalid -',
    ]);
  });

  describe('when an optional piece cannot be read, it reports the piece as missing and never fails', () => {
    function recordingContext(repo: string): { ctx: OpContext; events: unknown[] } {
      const events: unknown[] = [];
      const log: Logger = { ...silent, debug: (event, fields) => void events.push({ event, fields }) };
      return { ctx: { ...contextFor(repo), log }, events };
    }
    const denied = (): Promise<never> => Promise.reject(new Error('EPERM: C:/Users/someone/secret/first prompt text'));

    it('transcript folder detection', async () => {
      const { repo } = buildRepo(makeTemp('discover').path);
      const { ctx, events } = recordingContext(repo);
      const result = await discover(ctx, {
        transcripts: { detectDir: denied, recentSessions: () => Promise.resolve([]) },
      });
      expect(result.transcriptsDir).toBeNull();
      expect(result.lines).toContain('transcripts: (not found: pass transcripts_dir explicitly)');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('secret');
    });

    it('the recent sessions', async () => {
      const { repo } = buildRepo(makeTemp('discover').path);
      const { ctx, events } = recordingContext(repo);
      const result = await discover(ctx, {
        transcripts: { detectDir: () => Promise.resolve('C:/claude/projects/x'), recentSessions: denied },
      });
      expect(result.transcriptsDir).toBe('C:/claude/projects/x');
      expect(result.recentSessions).toEqual([]);
      expect(result.lines).toContain('transcripts: C:/claude/projects/x');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('secret');
    });

    it('the build status', async () => {
      const { repo } = buildRepo(makeTemp('discover').path);
      const { ctx, events } = recordingContext(repo);
      const result = await discover(ctx, { buildStatus: denied });
      expect(result.runtime.build).toBe('unknown');
      expect(events).toHaveLength(1);
    });

    it('the legacy engine', async () => {
      const { repo } = buildRepo(makeTemp('discover').path);
      const { ctx, events } = recordingContext(repo);
      const result = await discover(ctx, { legacyEngine: denied });
      expect(result.legacyEngine).toBeNull();
      expect(result.lines).toContain('legacy engine: not found');
      expect(events).toHaveLength(1);
    });

    it('the hooks summary', async () => {
      const { repo } = buildRepo(makeTemp('discover').path);
      const { ctx, events } = recordingContext(repo);
      const result = await discover(ctx, { hooksSummary: denied });
      expect(result.hooks).toBeNull();
      expect(result.lines).toContain('hooks: not installed');
      expect(events).toHaveLength(1);
    });

    it('the probe of an instance', async () => {
      const { repo } = buildRepo(makeTemp('discover').path);
      buildTaskWorkspace(repo, { slug: 'alpha', config: { title: 'A' }, instance: { slug: 'alpha' } });
      const { ctx, events } = recordingContext(repo);
      const result = await discover(ctx, { probeState: denied });
      expect(result.instances).toEqual([{ slug: 'alpha', engine: 'node', state: 'unknown', url: null }]);
      expect(result.lines.at(-1)).toBe('  alpha engine=node state=unknown -');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('secret');
    });
  });

  it('reads nothing outside the repo and creates nothing', async () => {
    const { repo } = buildRepo(makeTemp('discover').path);
    const before = snapshotTree(repo);
    await discover(contextFor(repo));
    expect(snapshotTree(repo)).toBe(before);
  });
});

describe('version', () => {
  it('reports the runtime version, the node version and an unknown build without build info', async () => {
    const { ctx } = repoWith();
    const result = await version(ctx);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.node).toBe(process.versions.node);
    expect(result.code).toBeNull();
    expect(result.text).toBe(`mcs ${result.version} (code unknown, node ${process.versions.node}, build unknown)`);
  });

  it('reports an unknown build when the build info cannot be read, and never fails (01 6.3)', async () => {
    const { ctx } = repoWith();
    const debug = vi.fn();
    const result = await version(
      { ...ctx, log: { ...silent, debug } },
      { buildInfo: () => Promise.reject(new McsError('INTERNAL', 'cannot read C:/private/path/build.json')) },
    );
    expect(result.code).toBeNull();
    expect(result.build).toBe('unknown');
    expect(result.text).toBe(`mcs ${result.version} (code unknown, node ${process.versions.node}, build unknown)`);
    expect(debug).toHaveBeenCalledWith('version.degraded', { phase: 'build-info', code: 'INTERNAL' });
  });

  it('uses the injected build info', async () => {
    const { ctx } = repoWith();
    const result = await version(ctx, { buildInfo: () => Promise.resolve({ code: 'abcdef0123', build: 'current' }) });
    expect(result.text).toBe(`mcs ${result.version} (code abcdef0123, node ${process.versions.node}, build current)`);
  });
});
