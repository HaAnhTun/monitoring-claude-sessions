// `config migrate` through the built CLI on real processes (01 2.7, T-ISO-27, T-CLI-06): the registry of 4.0 is empty, so the command
// reports `already current` and writes nothing, a file with a newer `schema_version` is refused, and the confirmation rules
// hold. The integration part of T-ISO-27 (a registered test step, a backup whose bytes equal the originals before the first write)
// runs the engine operation over a workspace made by the real `init`, then reads the result back through the built CLI.
// Every call passes `--repo <temp repo>`; nothing is started.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultRuntimeDir, defaultSkillDir, opsConfig, type FileMigration, type OpContext } from '@mcs/engine';
import { CliEnvelopeSchema, ConfigMigrateResultSchema, systemClock, type ConfigMigrateResult } from '@mcs/shared';
import { buildRepo, hermeticEnv, runCli, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SLUG = 'demo';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Sandbox {
  readonly repo: string;
  readonly tasks: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  mcs(args: readonly string[]): Promise<Run>;
}

async function sandbox(purpose: string): Promise<Sandbox> {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const tasks = join(repo, '.claude', 'monitor', 'tasks');
  const sb: Sandbox = {
    repo,
    tasks,
    ws: join(tasks, SLUG),
    env,
    mcs: (args) => runCli([...args, '--repo', repo], { mcsHome, env }),
  };
  const made = await sb.mcs(['init', '--slug', SLUG, '--name', 'FIXTURE demo']);
  expect(made.code, made.stderr).toBe(0);
  // a runtime.json too, so that all three files are present
  const configured = await sb.mcs(['configure', '--task', SLUG, '--set', 'logLevel="info"']);
  expect(configured.code, configured.stderr).toBe(0);
  return sb;
}

function envelope(run: Run): ReturnType<typeof CliEnvelopeSchema.parse> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

function resultOf(run: Run): ConfigMigrateResult {
  expect(run.code, run.stderr || run.stdout).toBe(0);
  return ConfigMigrateResultSchema.parse(envelope(run).data);
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('config migrate with the shipped registry (nothing to migrate in 4.0)', () => {
  it('says already current for a dry run and for --yes, and writes nothing', async () => {
    const sb = await sandbox('migrate-current');
    const before = snapshotTree(sb.tasks);
    const dry = await sb.mcs(['config', 'migrate', '--task', SLUG]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout.trim()).toBe(
      'already current: nothing to migrate (config.json v1, runtime.json v1, instance.json v1)',
    );
    expect(dry.stderr).toBe('');
    const applied = resultOf(await sb.mcs(['config', 'migrate', '--task', SLUG, '--yes', '--json']));
    expect(applied).toMatchObject({
      task: SLUG,
      outcome: 'current',
      steps: [],
      backup: null,
      restartNeeded: false,
      files: [
        { file: 'config.json', version: 1 },
        { file: 'runtime.json', version: 1 },
        { file: 'instance.json', version: 1 },
      ],
    });
    expect(snapshotTree(sb.tasks)).toBe(before);
    expect(existsSync(join(sb.ws, 'data', 'backups'))).toBe(false);
  }, 120_000);

  it('refuses a file with a newer schema_version as CONFIG_SCHEMA_UNSUPPORTED, in all three files, and writes nothing', async () => {
    for (const file of ['config.json', 'runtime.json', 'instance.json']) {
      const sb = await sandbox('migrate-newer');
      const target = join(sb.ws, file);
      const plain = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      writeFileSync(target, `${JSON.stringify({ ...plain, schema_version: 2 }, null, 2)}\n`);
      const before = snapshotTree(sb.tasks);
      for (const extra of [[], ['--yes']]) {
        const run = await sb.mcs(['config', 'migrate', '--task', SLUG, ...extra, '--json']);
        expect(run.code, `${file} ${extra.join(' ')}`).toBe(1);
        expect(envelope(run).error?.code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
        expect(envelope(run).error?.message).toContain(file);
      }
      expect(snapshotTree(sb.tasks)).toBe(before);
    }
  }, 180_000);

  it('refuses a config.json without schema_version, and a usage error or an unknown task are what they are', async () => {
    const sb = await sandbox('migrate-missing');
    const target = join(sb.ws, 'config.json');
    const plain = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    delete plain['schema_version'];
    writeFileSync(target, `${JSON.stringify(plain, null, 2)}\n`);
    const missing = await sb.mcs(['config', 'migrate', '--task', SLUG, '--json']);
    expect(missing.code).toBe(1);
    expect(envelope(missing).error?.code).toBe('CONFIG_SCHEMA_MISSING');

    expect((await sb.mcs(['config', 'migrate'])).code).toBe(2);
    const unknown = await sb.mcs(['config', 'migrate', '--task', 'nope', '--json']);
    expect(unknown.code).toBe(1);
    expect(envelope(unknown).error?.code).toBe('TASK_NOT_FOUND');
    const help = await sb.mcs(['config', 'migrate', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--task');
    expect(help.stdout).toContain('--yes');
  }, 120_000);
});

describe('T-ISO-27: a registered test step through a real workspace', () => {
  const STEP: FileMigration = {
    file: 'config.json',
    from: 1,
    to: 2,
    describe: 'FIXTURE adds window_hours',
    apply(doc) {
      if (doc.k !== 'obj') return doc;
      const entries = doc.v.filter(([key]) => key !== 'schema_version');
      return {
        k: 'obj',
        v: [['schema_version', { k: 'int', v: 2n }], ...entries, ['window_hours', { k: 'int', v: 7n }]],
      };
    },
  };

  function opContext(sb: Sandbox): OpContext {
    const skillDir = defaultSkillDir();
    return {
      repo: sb.repo,
      root: sb.tasks,
      skillDir,
      runtimeDir: defaultRuntimeDir(),
      launcherPath: join(skillDir, 'scripts', 'mcs.mjs'),
      env: sb.env,
      clock: systemClock,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
        close: () => Promise.resolve(),
      },
    };
  }

  it('the dry run writes nothing; --yes writes a backup equal to the originals first, then the files', async () => {
    const sb = await sandbox('migrate-step');
    const ctx = opContext(sb);
    const originals = new Map(
      ['config.json', 'runtime.json', 'instance.json', 'task.json'].map(
        (n) => [n, readFileSync(join(sb.ws, n))] as const,
      ),
    );
    const before = snapshotTree(sb.ws);

    const plan = await opsConfig.migrate(ctx, { task: SLUG }, { registry: [STEP] });
    expect(plan.outcome).toBe('dry-run');
    expect(snapshotTree(sb.ws)).toBe(before);

    let atWrite: string[] = [];
    const applied = await opsConfig.migrate(
      ctx,
      { task: SLUG, yes: true },
      {
        registry: [STEP],
        beforeStep: (step) => {
          if (step === 'write') atWrite = readdirSync(join(sb.ws, 'data', 'backups'));
        },
      },
    );
    expect(applied.outcome).toBe('migrated');
    expect(atWrite).toEqual([applied.backup]);

    // the built CLI reads the backup: the manifest is valid and every file equals the original that was there before the write
    const listed = await sb.mcs(['backup', 'list', '--task', SLUG, '--verify', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    expect((envelope(listed).data as { backups: unknown[] }).backups).toMatchObject([
      { id: applied.backup, reason: 'config-migrate', dbCopy: 'none', verified: true },
    ]);
    const manifest = JSON.parse(
      readFileSync(join(sb.ws, 'data', 'backups', applied.backup ?? '', 'manifest.json'), 'utf8'),
    ) as { files: { path: string; sha256: string }[] };
    expect(manifest.files.map((f) => f.path).sort()).toEqual([
      'config.json',
      'instance.json',
      'runtime.json',
      'task.json',
    ]);
    for (const file of manifest.files) expect(file.sha256).toBe(sha(originals.get(file.path) ?? Buffer.alloc(0)));
    expect(
      readFileSync(join(sb.ws, 'data', 'backups', applied.backup ?? '', 'config.json')).equals(
        originals.get('config.json') ?? Buffer.alloc(0),
      ),
    ).toBe(true);

    expect(JSON.parse(readFileSync(join(sb.ws, 'config.json'), 'utf8'))).toMatchObject({
      schema_version: 2,
      window_hours: 7,
    });
    for (const name of ['runtime.json', 'instance.json', 'task.json']) {
      expect(readFileSync(join(sb.ws, name)).equals(originals.get(name) ?? Buffer.alloc(0)), name).toBe(true);
    }
    expect(readFileSync(join(sb.ws, 'audit', 'changes.md'), 'utf8')).toContain('config.json schema_version 1 -> 2');

    // this 4.0 CLI knows only version 1 of config.json: the migrated file is refused, as the design says of a newer file
    const refused = await sb.mcs(['config', 'migrate', '--task', SLUG, '--json']);
    expect(refused.code).toBe(1);
    expect(envelope(refused).error?.code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
  }, 120_000);
});
