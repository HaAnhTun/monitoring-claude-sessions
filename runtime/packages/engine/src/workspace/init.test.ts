// The init transaction (01 4.12): validation first, staging folder, rename, reuse and adoption, cleanup of leftovers.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InstanceFileSchema, McsError } from '@mcs/shared';
import { FakeClock, makeJunction, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { mutexName, tryAcquireMutex } from '../platform/mutex.ts';
import { readInstanceFile } from './adopt.ts';
import { cleanupStaging, initWorkspace, type InitOptions } from './init.ts';
import { resolveWorkspace, tasksRootOf } from './paths.ts';

const makeTemp = useTempDirs();
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';

/** A repo folder with nothing in it but the testkit marker; `init` creates `.claude/monitor/tasks` itself. */
function bareRepo(): string {
  return makeTemp('init').path;
}

function opts(repo: string, over: Partial<InitOptions> = {}): InitOptions {
  return { repo, name: 'Nightly build', clock: new FakeClock(NOW), newId: () => ID, ...over };
}

function wsDir(repo: string, slug: string): string {
  return path.join(tasksRootOf(repo), slug);
}

function read(repo: string, slug: string, ...rel: string[]): string {
  return readFileSync(path.join(wsDir(repo, slug), ...rel), 'utf8');
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'RESOLVED';
}

function leftovers(repo: string): string[] {
  const root = tasksRootOf(repo);
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('.init-')) : [];
}

/** A pid that certainly belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (child.pid === 0) throw new Error('could not start a child to learn a dead pid');
  return child.pid;
}

function backdate(dir: string, minutes: number): void {
  const when = new Date(NOW - minutes * 60_000);
  utimesSync(dir, when, when);
}

describe('initWorkspace: a new workspace', () => {
  it('creates exactly the files of 01 1.1 with the bytes of 01 1.3, 1.8, 7.2', async () => {
    const repo = bareRepo();
    const result = await initWorkspace(opts(repo, { description: 'Checks the nightly build.' }));
    expect(result.created).toBe(true);
    expect(result.adopted).toBe(false);
    expect(result.ws.slug).toBe('nightly-build');
    expect(result.ws.dir).toBe(wsDir(repo, 'nightly-build'));
    expect(result.instance.instanceId).toBe(ID);

    const dir = wsDir(repo, 'nightly-build');
    expect(readdirSync(dir).sort()).toEqual([
      'README.md',
      'audit',
      'config.json',
      'data',
      'instance.json',
      'logs',
      'task.json',
    ]);
    expect(readdirSync(path.join(dir, 'audit'))).toEqual(['changes.md']);
    expect(readdirSync(path.join(dir, 'data'))).toEqual([]);
    expect(readdirSync(path.join(dir, 'logs'))).toEqual([]);
    expect(readdirSync(tasksRootOf(repo))).toEqual(['nightly-build']);

    expect(read(repo, 'nightly-build', 'task.json')).toBe(
      '{\n' +
        '  "schema_version": 1,\n' +
        '  "id": "nightly-build",\n' +
        '  "name": "Nightly build",\n' +
        '  "description": "Checks the nightly build.",\n' +
        '  "created": "2026-10-11T14:05:07Z",\n' +
        '  "repo": "../../../..",\n' +
        '  "links": []\n' +
        '}\n',
    );
    expect(read(repo, 'nightly-build', 'config.json')).toBe(
      '{\n  "schema_version": 1,\n  "title": "Nightly build"\n}\n',
    );
    expect(read(repo, 'nightly-build', 'README.md')).toBe(
      '# Monitoring task: Nightly build\n\nChecks the nightly build.\n\n' +
        '- `task.json` identity, `config.json` overrides of the shared defaults, `runtime.json` Node runtime overrides, `instance.json` runtime identity, `audit/` change and decision log, `data/` database and hook spool, `logs/` runtime logs.\n' +
        '- Inspect: `node <skill>/scripts/caw.mjs inspect --task nightly-build` (`<skill>` is the installed skill folder that holds `SKILL.md`)\n' +
        '- Never copy transcripts here; they are read in place.\n',
    );
    expect(read(repo, 'nightly-build', 'audit', 'changes.md')).toBe(
      '# Changes\n\n' +
        '## 2026-10-11T14:05:07Z | init-task\n' +
        "- Summary: created task workspace 'nightly-build'\n" +
        '- Reason: monitoring requested for this task\n' +
        '- Files changed: task.json, config.json, README.md, instance.json\n' +
        '- Validation: schema ok\n' +
        '- Outcome: created\n' +
        '- Unresolved: none\n' +
        '\n',
    );
    const instance = await readInstanceFile(resolveWorkspace(tasksRootOf(repo), 'nightly-build'));
    expect(InstanceFileSchema.safeParse(instance).success).toBe(true);
    expect(instance).toMatchObject({
      slug: 'nightly-build',
      engine: 'node',
      hooks: { enabled: false },
      dbSchemaVersion: 0,
    });
  });

  it('derives the slug from the name with the legacy slugify and uses the slug as the title of an unnamed task', async () => {
    const repo = bareRepo();
    const named = await initWorkspace(opts(repo, { name: 'Nightly build: Steps A/B' }));
    expect(named.ws.slug).toBe('nightly-build-steps-a-b');
    const unnamed = await initWorkspace(opts(repo, { name: '', slug: 'plain' }));
    expect(unnamed.ws.slug).toBe('plain');
    expect(read(repo, 'plain', 'config.json')).toContain('"title": "plain"');
    expect(read(repo, 'plain', 'task.json')).toContain('"name": "plain"');
    expect(read(repo, 'plain', 'README.md').startsWith('# Monitoring task: plain\n\n\n\n- `task.json`')).toBe(true);
  });

  it('an explicit slug beats the name; an empty slug falls back to the name like the legacy "slug or slugify(name)"', async () => {
    const repo = bareRepo();
    expect((await initWorkspace(opts(repo, { slug: 'chosen' }))).ws.slug).toBe('chosen');
    expect((await initWorkspace(opts(repo, { slug: '', name: 'From name' }))).ws.slug).toBe('from-name');
  });

  it('stores the engine and a requested port; the config gets the port key after the title', async () => {
    const repo = bareRepo();
    const result = await initWorkspace(opts(repo, { port: 8801 }));
    expect(result.instance.engine).toBe('node');
    expect(read(repo, 'nightly-build', 'config.json')).toBe(
      '{\n  "schema_version": 1,\n  "title": "Nightly build",\n  "port": 8801\n}\n',
    );
  });

  it('writes the repo relative to the workspace folder, whatever the depth of the tasks root', async () => {
    const repo = bareRepo();
    const custom = path.join(repo, 'elsewhere', 'tasks');
    await initWorkspace(opts(repo, { root: custom }));
    expect(readFileSync(path.join(custom, 'nightly-build', 'task.json'), 'utf8')).toContain('"repo": "../../.."');
  });

  it('never creates runtime.json, state.json or run/', async () => {
    const repo = bareRepo();
    await initWorkspace(opts(repo));
    const names = readdirSync(wsDir(repo, 'nightly-build'));
    expect(names).not.toContain('runtime.json');
    expect(names).not.toContain('state.json');
    expect(names).not.toContain('run');
  });
});

describe('initWorkspace: validation happens before anything is created', () => {
  async function refuses(over: Partial<InitOptions>, code: string): Promise<void> {
    const repo = bareRepo();
    const before = readdirSync(repo).sort();
    expect(await codeOf(initWorkspace(opts(repo, over)))).toBe(code);
    expect(readdirSync(repo).sort()).toEqual(before);
  }

  it('an invalid slug (explicit, or derived to a device name)', async () => {
    await refuses({ slug: 'Bad Slug' }, 'SLUG_INVALID');
    await refuses({ slug: '../up' }, 'SLUG_INVALID');
    await refuses({ name: 'CON' }, 'SLUG_INVALID');
  });

  it('a name or description with a lone surrogate (it could not be written as UTF-8)', async () => {
    const lone = String.fromCharCode(0xd800);
    await refuses({ name: `bad${lone}name`, slug: 'fine' }, 'CONFIG_INVALID');
    await refuses({ description: `bad${lone}`, slug: 'fine' }, 'CONFIG_INVALID');
  });

  it('a port outside 1..65535 or not an integer', async () => {
    await refuses({ port: 0 }, 'CONFIG_INVALID');
    await refuses({ port: 70000 }, 'CONFIG_INVALID');
    await refuses({ port: 1.5 }, 'CONFIG_INVALID');
    await refuses({ port: Number.NaN }, 'CONFIG_INVALID');
  });

  function seed(text: string): string {
    const file = path.join(makeTemp('init-seed').path, 'seed.json');
    writeFileSync(file, text);
    return file;
  }

  it('a seed file that is missing, not an object, not JSON, with unknown keys or another schema version', async () => {
    await refuses({ seedConfig: path.join(makeTemp('init-seed').path, 'absent.json') }, 'CONFIG_UNREADABLE');
    await refuses({ seedConfig: seed('{"a": ') }, 'CONFIG_UNREADABLE');
    await refuses({ seedConfig: seed('[1]') }, 'CONFIG_INVALID');
    await refuses({ seedConfig: seed('{"bogus": 1, "alsoBogus": 2}') }, 'CONFIG_INVALID');
    // Node-only (runtime) keys never go into config.json, which the legacy engine validates strictly (ADR 0001).
    await refuses({ seedConfig: seed('{"server": {"port": 8801}, "logLevel": "debug"}') }, 'CONFIG_INVALID');
    await refuses({ seedConfig: seed('{"schema_version": 2}') }, 'CONFIG_SCHEMA_UNSUPPORTED');
    await refuses({ seedConfig: seed('{"schema_version": null}') }, 'CONFIG_SCHEMA_MISSING');
  });

  it('names every unknown seed key in the message', async () => {
    const repo = bareRepo();
    const error = await initWorkspace(
      opts(repo, { seedConfig: seed('{"bogus": 1, "window_hours": 4, "alsoBogus": 2}') }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as McsError).message).toContain("'bogus'");
    expect((error as McsError).message).toContain("'alsoBogus'");
    expect((error as McsError).message).not.toContain('window_hours');
  });

  it('a seed value that breaks the legacy schema, with the legacy wording', async () => {
    const repo = bareRepo();
    const error = await initWorkspace(opts(repo, { seedConfig: seed('{"window_hours": -1, "docker": "yes"}') })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as McsError).message).toContain('window_hours: expected positive number, got -1');
    expect((error as McsError).message).toContain('docker: expected boolean, got "yes"');
    expect(readdirSync(repo)).toEqual(['FIXTURE.md']);
  });

  it('an invalid regex and a Python-syntax regex (CONFIG_INVALID, the second with the migration hint)', async () => {
    await refuses({ seedConfig: seed('{"session_rules": [{"match": "(", "label": "x"}]}') }, 'CONFIG_INVALID');
    await refuses({ seedConfig: seed('{"session_rules": [{"match": "(?P<n>a)", "label": "x"}]}') }, 'CONFIG_INVALID');
    const repo = bareRepo();
    const error = await initWorkspace(
      opts(repo, { seedConfig: seed('{"session_rules": [{"match": "(?P<n>a)", "label": "x"}]}') }),
    ).catch((e: unknown) => e);
    expect((error as McsError).message).toContain('this looks like Python regex syntax; run `mcs migrate-workspace');
  });

  it('accepts a seed rule with a JavaScript named group', async () => {
    const repo = bareRepo();
    await initWorkspace(
      opts(repo, { seedConfig: seed('{"session_rules": [{"match": "job-(?<n>[0-9]+)", "label": "Job {1}"}]}') }),
    );
    expect(read(repo, 'nightly-build', 'config.json')).toContain('job-(?<n>[0-9]+)');
  });
});

describe('initWorkspace: the seed file', () => {
  it('writes the seed keys after schema_version and title; the seed title wins; underscore keys are kept', async () => {
    const repo = bareRepo();
    const seedDir = makeTemp('init-seed').path;
    const seedFile = path.join(seedDir, 'seed.json');
    writeFileSync(
      seedFile,
      '{"_note": "kept", "window_hours": 12.5, "title": "From seed", "session_rules": [{"match": "build-(\\\\d+)", "label": "Build {1}"}], "port": 8800}',
    );
    await initWorkspace(opts(repo, { seedConfig: seedFile, port: 8802 }));
    expect(read(repo, 'nightly-build', 'config.json')).toBe(
      '{\n' +
        '  "schema_version": 1,\n' +
        '  "title": "From seed",\n' +
        '  "_note": "kept",\n' +
        '  "window_hours": 12.5,\n' +
        '  "session_rules": [\n' +
        '    {\n      "match": "build-(\\\\d+)",\n      "label": "Build {1}"\n    }\n' +
        '  ],\n' +
        '  "port": 8802\n' +
        '}\n',
    );
  });

  it('accepts a seed with schema_version 1 and keeps it in first place', async () => {
    const repo = bareRepo();
    const seedFile = path.join(makeTemp('init-seed').path, 'seed.json');
    writeFileSync(seedFile, '{"window_hours": 6, "schema_version": 1}');
    await initWorkspace(opts(repo, { seedConfig: seedFile }));
    expect(read(repo, 'nightly-build', 'config.json')).toBe(
      '{\n  "schema_version": 1,\n  "title": "Nightly build",\n  "window_hours": 6\n}\n',
    );
  });
});

describe('initWorkspace: reuse (nothing is overwritten)', () => {
  it('a second call reuses the workspace and changes no byte, adds no audit entry', async () => {
    const repo = bareRepo();
    await initWorkspace(opts(repo));
    const dir = wsDir(repo, 'nightly-build');
    const before = snapshotTree(dir);
    const again = await initWorkspace(
      opts(repo, { clock: new FakeClock(NOW + 3_600_000), newId: () => 'x', description: 'ignored' }),
    );
    expect(again.created).toBe(false);
    expect(again.adopted).toBe(false);
    expect(again.instance.instanceId).toBe(ID);
    expect(snapshotTree(dir)).toBe(before);
    expect(read(repo, 'nightly-build', 'audit', 'changes.md').match(/^## /gm)).toHaveLength(1);
  });

  it('a hand-edited config.json survives a reuse without seed options', async () => {
    const repo = bareRepo();
    await initWorkspace(opts(repo));
    const file = path.join(wsDir(repo, 'nightly-build'), 'config.json');
    writeFileSync(file, '{\n  "schema_version": 1,\n  "title": "Edited",\n  "window_hours": 3\n}\n');
    await initWorkspace(opts(repo));
    expect(readFileSync(file, 'utf8')).toContain('"title": "Edited"');
  });

  it('seed options that the existing config.json already holds are fine; others are WORKSPACE_EXISTS_CONFIG_DIFFERS', async () => {
    const repo = bareRepo();
    const seedFile = path.join(makeTemp('init-seed').path, 'seed.json');
    writeFileSync(seedFile, '{"window_hours": 12, "docker": true}');
    await initWorkspace(opts(repo, { seedConfig: seedFile, port: 8803 }));
    const dir = wsDir(repo, 'nightly-build');
    const before = snapshotTree(dir);

    expect((await initWorkspace(opts(repo, { seedConfig: seedFile, port: 8803 }))).created).toBe(false);
    expect((await initWorkspace(opts(repo, { port: 8803 }))).created).toBe(false);

    const differing = path.join(makeTemp('init-seed').path, 'other.json');
    writeFileSync(differing, '{"window_hours": 13}');
    const error = await initWorkspace(opts(repo, { seedConfig: differing })).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'WORKSPACE_EXISTS_CONFIG_DIFFERS',
      hint: 'use mcs configure --task nightly-build',
    });
    expect(await codeOf(initWorkspace(opts(repo, { port: 8804 })))).toBe('WORKSPACE_EXISTS_CONFIG_DIFFERS');
    // 12.0 equals 12 in Python (jsonEquals)
    writeFileSync(differing, '{"window_hours": 12.0}');
    expect((await initWorkspace(opts(repo, { seedConfig: differing }))).created).toBe(false);
    // A seed that breaks the schema is refused by the validation of step 1 before the workspace is looked at.
    writeFileSync(differing, '{"window_hours": "12"}');
    expect(await codeOf(initWorkspace(opts(repo, { seedConfig: differing })))).toBe('CONFIG_INVALID');
    expect(snapshotTree(dir)).toBe(before);
  });

  it('a key the existing config.json lacks counts as a difference', async () => {
    const repo = bareRepo();
    await initWorkspace(opts(repo));
    const seedFile = path.join(makeTemp('init-seed').path, 'seed.json');
    writeFileSync(seedFile, '{"docker": false}');
    expect(await codeOf(initWorkspace(opts(repo, { seedConfig: seedFile })))).toBe('WORKSPACE_EXISTS_CONFIG_DIFFERS');
  });

  it('a task.json that names another id is IDENTITY_MISMATCH', async () => {
    const repo = bareRepo();
    const dir = wsDir(repo, 'nightly-build');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'task.json'), '{"schema_version": 1, "id": "other"}');
    expect(await codeOf(initWorkspace(opts(repo)))).toBe('IDENTITY_MISMATCH');
  });

  it('adopts a legacy-created workspace: instance.json, data/, logs/, one adopt-instance entry, legacy bytes intact', async () => {
    const repo = bareRepo();
    const dir = wsDir(repo, 'legacy-demo');
    cpSync(FIXTURE, dir, { recursive: true });
    const legacy = ['task.json', 'config.json', 'README.md'].map((n) => readFileSync(path.join(dir, n)));
    const result = await initWorkspace(opts(repo, { name: 'Legacy demo task', slug: 'legacy-demo' }));
    expect(result.created).toBe(false);
    expect(result.adopted).toBe(true);
    expect(['task.json', 'config.json', 'README.md'].map((n) => readFileSync(path.join(dir, n)))).toEqual(legacy);
    expect(existsSync(path.join(dir, 'runtime.json'))).toBe(false);
    expect(read(repo, 'legacy-demo', 'audit', 'changes.md').match(/\| adopt-instance$/gm)).toHaveLength(1);
    const again = await initWorkspace(opts(repo, { name: 'Legacy demo task', slug: 'legacy-demo' }));
    expect(again.adopted).toBe(false);
    expect(read(repo, 'legacy-demo', 'audit', 'changes.md').match(/\| adopt-instance$/gm)).toHaveLength(1);
  });
});

describe('initWorkspace: the staging folder and the rename', () => {
  it('an error between staging and rename removes the staging folder and creates no workspace', async () => {
    const repo = bareRepo();
    class Boom extends Error {}
    await expect(
      initWorkspace(
        opts(repo, {
          beforeRename: () => {
            throw new Boom('hook failed');
          },
        }),
      ),
    ).rejects.toBeInstanceOf(Boom);
    expect(leftovers(repo)).toEqual([]);
    expect(existsSync(wsDir(repo, 'nightly-build'))).toBe(false);
    // The tasks root survives and the next init works.
    expect((await initWorkspace(opts(repo))).created).toBe(true);
  });

  it('a task mutex held by another command is WORKSPACE_BUSY (not INTERNAL), and nothing is created', async () => {
    const repo = bareRepo();
    const first = await initWorkspace(opts(repo));
    const holder = await tryAcquireMutex(mutexName('task', first.ws.realDir));
    expect(holder).not.toBeNull();
    try {
      const error = await initWorkspace(opts(repo, { mutexTimeoutMs: 50 })).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'WORKSPACE_BUSY', details: { reason: 'MUTEX_TIMEOUT' } });
      expect(leftovers(repo)).toEqual([]);
    } finally {
      await holder?.release();
    }
    expect((await initWorkspace(opts(repo))).created).toBe(false);
  });

  it('cleanupStaging removes a staging folder of a dead pid older than 10 minutes, and only that', async () => {
    const repo = bareRepo();
    const root = tasksRootOf(repo);
    mkdirSync(root, { recursive: true });
    const dead = deadPid();
    const old = path.join(root, `.init-demo-${String(dead)}-ab12cd34`);
    const young = path.join(root, `.init-young-${String(dead)}-ab12cd34`);
    const alive = path.join(root, `.init-alive-${String(process.pid)}-ab12cd34`);
    const notOurs = [
      `.init-demo-${String(dead)}-ZZ12cd34`,
      `.init-UPPER-${String(dead)}-ab12cd34`,
      '.init-demo',
      `.initdemo-${String(dead)}-ab12cd34`,
      `.init-demo-${String(dead)}-ab12cd3`,
    ];
    for (const dir of [old, young, alive, ...notOurs.map((n) => path.join(root, n))]) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'file.txt'), 'x');
    }
    backdate(old, 11);
    backdate(young, 9);
    backdate(alive, 60);
    for (const n of notOurs) backdate(path.join(root, n), 60);
    await cleanupStaging(root, new FakeClock(NOW));
    expect(readdirSync(root).sort()).toEqual([path.basename(alive), path.basename(young), ...notOurs].sort());
  });

  it('cleanupStaging never follows a link named like a staging folder and never touches a plain file', async () => {
    const repo = bareRepo();
    const root = tasksRootOf(repo);
    mkdirSync(root, { recursive: true });
    const outside = path.join(makeTemp('init-outside').path, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'precious.txt'), 'keep');
    const dead = deadPid();
    const link = path.join(root, `.init-link-${String(dead)}-ab12cd34`);
    makeJunction(link, outside);
    const file = path.join(root, `.init-file-${String(dead)}-ab12cd34`);
    writeFileSync(file, 'x');
    backdate(file, 60);
    await cleanupStaging(root, new FakeClock(NOW));
    expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep');
    expect(existsSync(file)).toBe(true);
  });

  it('init removes old leftovers of any slug before it works (step 3)', async () => {
    const repo = bareRepo();
    const root = tasksRootOf(repo);
    mkdirSync(root, { recursive: true });
    const stale = path.join(root, `.init-other-${String(deadPid())}-ab12cd34`);
    mkdirSync(stale);
    backdate(stale, 30);
    await initWorkspace(opts(repo));
    expect(leftovers(repo)).toEqual([]);
  });

  it('when another writer created the workspace first, the staging folder is dropped and the existing one is reused', async () => {
    const repo = bareRepo();
    const dir = wsDir(repo, 'nightly-build');
    const result = await initWorkspace(
      opts(repo, {
        beforeRename: () => {
          // What the legacy `init-task` would have made in the meantime (it takes no mutex).
          cpSync(FIXTURE, dir, { recursive: true });
          writeFileSync(path.join(dir, 'task.json'), '{"schema_version": 1, "id": "nightly-build", "name": "Theirs"}');
        },
      }),
    );
    expect(result.created).toBe(false);
    expect(result.adopted).toBe(true);
    expect(leftovers(repo)).toEqual([]);
    expect(read(repo, 'nightly-build', 'task.json')).toContain('"name": "Theirs"');
    expect(readdirSync(tasksRootOf(repo))).toEqual(['nightly-build']);
  });

  it('an empty folder at the target is replaced harmlessly; a non-empty one without task.json is refused', async () => {
    const repo = bareRepo();
    mkdirSync(wsDir(repo, 'nightly-build'), { recursive: true });
    expect((await initWorkspace(opts(repo))).created).toBe(true);

    const repo2 = bareRepo();
    const dir2 = wsDir(repo2, 'nightly-build');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path.join(dir2, 'notes.txt'), 'mine');
    expect(await codeOf(initWorkspace(opts(repo2)))).toBe('WORKSPACE_INVALID');
    expect(readFileSync(path.join(dir2, 'notes.txt'), 'utf8')).toBe('mine');
    expect(leftovers(repo2)).toEqual([]);
  });

  it('refuses a workspace folder that is a link (WORKSPACE_SYMLINK) and writes nothing through it', async () => {
    const repo = bareRepo();
    const root = tasksRootOf(repo);
    const real = path.join(root, 'real');
    mkdirSync(real, { recursive: true });
    makeJunction(path.join(root, 'nightly-build'), real);
    expect(await codeOf(initWorkspace(opts(repo)))).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(real)).toEqual([]);
  });

  it('two inits of one slug in the same process serialize: one creates, one reuses, one audit entry', async () => {
    const repo = bareRepo();
    const results = await Promise.all([
      initWorkspace(opts(repo)),
      initWorkspace(opts(repo)),
      initWorkspace(opts(repo)),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(read(repo, 'nightly-build', 'audit', 'changes.md').match(/\| init-task$/gm)).toHaveLength(1);
    expect(leftovers(repo)).toEqual([]);
  });
});

describe('initWorkspace: kind (06 1.3)', () => {
  it('writes kind "user" after the engine line for a user instance and nothing for a task', async () => {
    const repo = bareRepo();
    const user = await initWorkspace(opts(repo, { slug: 'user', kind: 'user', port: 7690 }));
    expect(user.created).toBe(true);
    expect(user.instance.kind).toBe('user');
    expect(read(repo, 'user', 'instance.json')).toContain('  "engine": "node",\n  "kind": "user",\n  "hooks": {');
    expect(await readInstanceFile(resolveWorkspace(tasksRootOf(repo), 'user'))).toMatchObject({ kind: 'user' });

    const task = await initWorkspace(opts(repo, { slug: 'plain' }));
    expect(task.instance.kind).toBeUndefined();
    expect(read(repo, 'plain', 'instance.json')).not.toContain('kind');
    const explicitTask = await initWorkspace(opts(repo, { slug: 'plain-two', kind: 'task' }));
    expect(explicitTask.instance.kind).toBeUndefined();
    expect(read(repo, 'plain-two', 'instance.json')).not.toContain('kind');
  });

  it('a task workspace of an init without kind is byte-identical to one that asks for kind task', async () => {
    const repo = bareRepo();
    await initWorkspace(opts(repo, { slug: 'one' }));
    await initWorkspace(opts(repo, { slug: 'one-b', kind: 'task' }));
    for (const file of ['instance.json', 'task.json', 'config.json']) {
      expect(read(repo, 'one-b', file).replaceAll('one-b', 'one')).toBe(read(repo, 'one', file));
    }
  });

  it('adopts an existing legacy workspace with the requested kind', async () => {
    const repo = bareRepo();
    const dir = wsDir(repo, 'user');
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'task.json'),
      readFileSync(path.join(dir, 'task.json'), 'utf8').replace(/"id": "[^"]*"/, '"id": "user"'),
    );
    const result = await initWorkspace(opts(repo, { slug: 'user', kind: 'user' }));
    expect(result.created).toBe(false);
    expect(result.adopted).toBe(true);
    expect(result.instance.kind).toBe('user');
  });

  it('reuses an existing user instance without rewriting its identity', async () => {
    const repo = bareRepo();
    await initWorkspace(opts(repo, { slug: 'user', kind: 'user' }));
    const before = read(repo, 'user', 'instance.json');
    const again = await initWorkspace(opts(repo, { slug: 'user', kind: 'user', newId: () => 'ignored' }));
    expect(again.created).toBe(false);
    expect(read(repo, 'user', 'instance.json')).toBe(before);
  });
});
