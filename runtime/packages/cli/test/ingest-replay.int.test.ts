// `mcs ingest replay` through the built CLI and real servers (T-CLI-11; 01 6.4, I-29; 02 2.7): a dry run writes nothing, a stopped
// instance has its cursors reset and the next start reads the spool again without a duplicate event, a running instance does it
// through the control channel and reports the segment count with the event count unchanged, and `--from` is checked first.
// The spool is made by the real hook handler (a route written by `hooks enable`); ports come from the test range; every call
// passes `--repo <temp repo>`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { openInstanceDb } from '@mcs/engine';
import { CliEnvelopeSchema } from '@mcs/shared';
import { normalizePath, sanitizeProjectName } from '@mcs/shared/protocol';
import {
  allocatePort,
  buildRepo,
  hermeticEnv,
  hookPayload,
  killAllTracked,
  runCli,
  runHookHandler,
  snapshotTree,
  startInstance,
  useTempDirs,
  waitFor,
  type HookEventName,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SLUG = 'demo';
const SESSION = 'a0a0a0a0-0000-4000-8000-0000000000a1'; // FIXTURE session id
const SNAPSHOT = { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] };

afterEach(async () => {
  await killAllTracked();
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  readonly port: number;
  mcs(args: readonly string[]): Promise<Run>;
}

async function sandbox(purpose: string): Promise<Sandbox> {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const port = await allocatePort();
  const sb: Sandbox = {
    root,
    repo,
    ws: join(repo, '.claude', 'monitor', 'tasks', SLUG),
    env,
    port,
    mcs: (args) => runCli([...args, '--repo', repo], { mcsHome, env }),
  };
  const made = await sb.mcs(['init', '--slug', SLUG, '--name', `FIXTURE ${SLUG}`, '--port', String(port)]);
  expect(made.code, made.stderr).toBe(0);
  return sb;
}

function instanceId(sb: Sandbox): string {
  return (JSON.parse(readFileSync(join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string }).instanceId;
}

/** The real handler writes `events` into the spool of the task: the route of `hooks enable` points it at the workspace. */
async function fillSpool(sb: Sandbox, events: readonly HookEventName[]): Promise<string> {
  const enabled = await sb.mcs(['hooks', 'enable', '--task', SLUG]);
  expect(enabled.code, enabled.stderr).toBe(0);
  const projects = join(sb.env['CLAUDE_CONFIG_DIR'] ?? '', 'projects', sanitizeProjectName(sb.repo));
  const base = {
    sessionId: SESSION,
    cwd: normalizePath(sb.repo),
    transcriptPath: `${normalizePath(projects)}/${SESSION}.jsonl`,
  };
  const mcsHome = sb.env['MCS_HOME'] ?? '';
  for (const event of events) {
    const result = await runHookHandler(hookPayload(event, base), {
      mcsHome,
      event,
      direct: true,
      env: { CLAUDE_CONFIG_DIR: sb.env['CLAUDE_CONFIG_DIR'] ?? '' },
    });
    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  }
  const names = readdirSync(join(sb.ws, 'data', 'spool')).filter((name) => name.endsWith('.ndjson'));
  expect(names, 'one spool segment (the events were written within one hour)').toHaveLength(1);
  return names[0] ?? '';
}

interface Cursor {
  readonly offset: number;
  readonly sealed: number;
  readonly lines: number;
}

/** What the database of the task holds: the number of events and the cursor of one segment (read-only, also while it runs). */
function readDb(sb: Sandbox, segment: string): { events: number; cursor: Cursor | null } {
  const db = openInstanceDb({
    path: join(sb.ws, 'data', 'monitor.db'),
    expectedInstanceId: instanceId(sb),
    mode: 'readonly',
    runtimeVersion: '4.0.0',
  });
  try {
    const events = db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM events').get()?.n ?? 0;
    const row = db.driver
      .prepare<{ offset: number; sealed: number; lines: number }>(
        'SELECT offset_bytes AS offset, sealed, lines FROM spool_cursors WHERE segment = :segment',
      )
      .get({ segment });
    return { events, cursor: row ?? null };
  } finally {
    db.close();
  }
}

async function drained(sb: Sandbox, segment: string, bytes: number): Promise<void> {
  await waitFor(() => readDb(sb, segment).cursor?.offset === bytes, {
    what: 'the spool segment read to its end',
    timeoutMs: 20_000,
    intervalMs: 100,
  });
}

function jsonOf(run: Run): { ok: boolean; data: unknown; error: { code: string } | null } {
  const envelope = CliEnvelopeSchema.parse(JSON.parse(run.stdout));
  return { ok: envelope.ok, data: envelope.data, error: envelope.error };
}

const EVENTS: HookEventName[] = ['SessionStart', 'UserPromptSubmit', 'Stop'];

describe('T-CLI-11: ingest replay', () => {
  it('the dry run lists the segments and writes nothing, before and after the first start', async () => {
    const sb = await sandbox('replay-dry');
    const segment = await fillSpool(sb, EVENTS);
    const bytes = statSync(join(sb.ws, 'data', 'spool', segment)).size;
    const before = snapshotTree(sb.ws, SNAPSHOT);

    const dry = await sb.mcs(['ingest', 'replay', '--task', SLUG]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`${segment}  ${String(bytes)} bytes`);
    expect(dry.stderr).toContain('warning: dry run; pass --yes to apply');
    expect(snapshotTree(sb.ws, SNAPSHOT)).toBe(before);

    // no database yet: --yes has nothing to reset, says so, and writes no audit entry
    const nothing = await sb.mcs(['ingest', 'replay', '--task', SLUG, '--yes']);
    expect(nothing.code, nothing.stderr).toBe(0);
    expect(nothing.stdout).toContain('no database yet');
    expect(readFileSync(join(sb.ws, 'audit', 'changes.md'), 'utf8')).not.toContain('ingest-replay');
  }, 120_000);

  it('--from with a bad name exits 2, an unknown segment exits 1 with NOT_FOUND, and nothing changes', async () => {
    const sb = await sandbox('replay-from');
    await fillSpool(sb, EVENTS);
    const before = snapshotTree(sb.ws);
    const bad = await sb.mcs(['ingest', 'replay', '--task', SLUG, '--from', '../hooks-20261011T08Z.ndjson', '--json']);
    expect(bad.code).toBe(2);
    expect(jsonOf(bad).error?.code).toBe('USAGE');
    const missing = await sb.mcs(['ingest', 'replay', '--task', SLUG, '--from', 'hooks-20200101T00Z.ndjson', '--json']);
    expect(missing.code).toBe(1);
    expect(jsonOf(missing).error?.code).toBe('NOT_FOUND');
    const slug = await sb.mcs(['ingest', 'replay', '--task', '..', '--json']);
    expect(slug.code).toBe(1);
    expect(jsonOf(slug).error?.code).toBe('SLUG_INVALID');
    expect(snapshotTree(sb.ws)).toBe(before);
  }, 120_000);

  it('a stopped instance resets the cursors and the next start reads the segment again without a duplicate event', async () => {
    const sb = await sandbox('replay-stopped');
    const segment = await fillSpool(sb, EVENTS);
    const bytes = statSync(join(sb.ws, 'data', 'spool', segment)).size;

    const first = await startInstance({ repo: sb.repo, slug: SLUG, env: sb.env }, { port: sb.port });
    await drained(sb, segment, bytes);
    await first.stop();
    const ingested = readDb(sb, segment);
    expect(ingested.events).toBeGreaterThan(0);
    expect(ingested.cursor).toMatchObject({ offset: bytes, lines: EVENTS.length });

    const dryBefore = snapshotTree(sb.ws, SNAPSHOT);
    const dry = await sb.mcs(['ingest', 'replay', '--task', SLUG]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`read up to ${String(bytes)}`);
    expect(snapshotTree(sb.ws, SNAPSHOT)).toBe(dryBefore);

    const run = await sb.mcs(['ingest', 'replay', '--task', SLUG, '--yes', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(jsonOf(run).data).toMatchObject({ applied: true, mode: 'stopped', segmentsReset: 1, from: null });
    const reset = readDb(sb, segment);
    expect(reset.cursor).toMatchObject({ offset: 0, sealed: 0, lines: 0 });
    expect(reset.events).toBe(ingested.events);
    const audit = readFileSync(join(sb.ws, 'audit', 'changes.md'), 'utf8');
    expect(audit).toContain('| ingest-replay');
    expect(audit).toContain('- Summary: spool replay of 1 segments from all');
    expect(audit).toContain('- Validation: cursors re-read');
    expect(audit).toContain('- Outcome: scheduled');

    const second = await startInstance({ repo: sb.repo, slug: SLUG, env: sb.env }, { port: sb.port });
    await drained(sb, segment, bytes);
    await second.stop();
    const again = readDb(sb, segment);
    expect(again.cursor).toMatchObject({ offset: bytes, lines: EVENTS.length });
    expect(again.events).toBe(ingested.events);
  }, 180_000);

  it('a running instance is asked through the control channel: the report holds the segment count and the event count is unchanged', async () => {
    const sb = await sandbox('replay-running');
    const segment = await fillSpool(sb, EVENTS);
    const bytes = statSync(join(sb.ws, 'data', 'spool', segment)).size;
    const running = await startInstance({ repo: sb.repo, slug: SLUG, env: sb.env }, { port: sb.port });
    await drained(sb, segment, bytes);
    const ingested = readDb(sb, segment);

    const run = await sb.mcs(['ingest', 'replay', '--task', SLUG, '--from', segment, '--yes', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(jsonOf(run).data).toMatchObject({ applied: true, mode: 'running', segmentsReset: 1, from: segment });
    // the server read the segment again from its own writer queue
    await drained(sb, segment, bytes);
    await waitFor(() => readDb(sb, segment).cursor?.lines === EVENTS.length, {
      what: 'the segment counted again',
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    expect(readDb(sb, segment).events).toBe(ingested.events);
    const text = await sb.mcs(['ingest', 'replay', '--task', SLUG, '--yes']);
    expect(text.stdout).toContain('replay scheduled for 1 segments (duplicates are ignored by event_uid)');
    await running.stop();
    expect(readFileSync(join(sb.ws, 'audit', 'changes.md'), 'utf8')).toContain(
      `- Summary: spool replay of 1 segments from ${segment}`,
    );
  }, 180_000);
});
