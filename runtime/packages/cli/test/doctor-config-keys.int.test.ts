// `mcs doctor` and the `config.keys` check (WP-105) through the real built CLI against a hermetic instance: a default
// configuration is `[ok]`, a key that validation accepts but nothing reads is one `[warn]` line that names it and never shows
// its value. The real `~/.claude` is never read (`hermeticEnv`).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CliEnvelopeSchema, DoctorReportSchema } from '@mcs/shared';
import { allocatePort, buildRepo, hermeticEnv, runCli, useTempDirs } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

// Every test starts the real CLI (some also a real instance): on a loaded machine one needs far more than the 10 s default.
// A test with its own limit keeps it.
vi.setConfig({ testTimeout: 120_000 });

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const SLUG = 'keys';

async function sandbox(): Promise<{
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}> {
  const root = makeTemp('doctor-config-keys-int').path;
  const { repo } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  mkdirSync(mcsHome, { recursive: true });
  const mcs = (args: readonly string[]) => runCli([...args, '--repo', repo], { mcsHome, env });
  const made = await mcs(['init', '--name', 'Keys task', '--slug', SLUG, '--port', String(await allocatePort())]);
  expect(made.code, made.stderr).toBe(0);
  return { mcs };
}

function keysLine(stdout: string): string[] {
  return stdout.split(LF).filter((line) => line.includes('config.keys'));
}

describe('mcs doctor: config.keys', () => {
  it('prints [ok] for a default configuration', async () => {
    const sb = await sandbox();
    const run = await sb.mcs(['doctor', '--task', SLUG]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(keysLine(run.stdout)).toEqual(['[ok] config.keys: every configured key has an effect']);
  });

  it('is skipped without a task', async () => {
    const sb = await sandbox();
    const run = await sb.mcs(['doctor']);
    expect(keysLine(run.stdout)).toEqual(['[ok] config.keys: no task selected (skipped)']);
  });

  it('prints one [warn] line that names limits.max_events and not its value, and still exits 0', async () => {
    const sb = await sandbox();
    const set = await sb.mcs(['configure', '--task', SLUG, '--set', 'limits.max_events=424242']);
    expect(set.code, set.stderr).toBe(0);
    const run = await sb.mcs(['doctor', '--task', SLUG]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const lines = keysLine(run.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[warn\] config\.keys: limits\.max_events is not supported/);
    expect(run.stdout).not.toContain('424242');
    expect(run.stdout).toContain('  fix: edit config.json of task keys');
    const json = await sb.mcs(['doctor', '--task', SLUG, '--json']);
    const report = DoctorReportSchema.parse(CliEnvelopeSchema.parse(JSON.parse(json.stdout)).data);
    expect(report.checks.find((c) => c.id === 'config.keys')).toMatchObject({ ok: false, level: 'warn' });
    expect(report.ok).toBe(true);
  });

  it('warns about an unknown key and a panel without its partner key, in one line', async () => {
    const sb = await sandbox();
    for (const assignment of ['poll.unknown=1', 'panels.ledger=true']) {
      const set = await sb.mcs(['configure', '--task', SLUG, '--set', assignment]);
      expect(set.code, set.stderr).toBe(0);
    }
    const run = await sb.mcs(['doctor', '--task', SLUG]);
    const lines = keysLine(run.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('poll.unknown');
    expect(lines[0]).toContain('panels.ledger is on but ledger is not set');
  });

  it('does not print the warnings from check or configure', async () => {
    const sb = await sandbox();
    const set = await sb.mcs(['configure', '--task', SLUG, '--set', 'limits.max_events=424242']);
    expect(set.stdout + set.stderr).not.toContain('config.keys');
    const check = await sb.mcs(['check', '--task', SLUG]);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout + check.stderr).not.toContain('max_events');
  });
});
