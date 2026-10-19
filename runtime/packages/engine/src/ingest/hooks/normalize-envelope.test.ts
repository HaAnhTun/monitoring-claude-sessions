import { join } from 'node:path';

import { EVENT_KINDS } from '@mcs/shared';
import { HOOK_EVENT_RANK, INSTALLED_HOOK_EVENTS, canonicalJsonHash } from '@mcs/shared/protocol';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb, type RepoContext } from '../../db/open.ts';
import { EventsRepo } from '../../db/repos/events.ts';
import { withWriteTx } from '../../db/write.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_INSTANCE_ID,
  FIXTURE_PROMPT_ID,
  FIXTURE_RECEIVED_AT,
  FIXTURE_SESSION_ID,
  FIXTURE_TOOL_USE_ID,
  allInstalledEnvelopes,
  fixtureEnvelope,
  fixtureProbeEnvelope,
} from '../../../test/fixtures/hooks.ts';
import type { LogicalEvent } from '../event-row.ts';
import { eventKindOfEnvelope, normalizeEnvelope } from './normalize-envelope.ts';

const S = FIXTURE_SESSION_ID;
const BATCH_HASH = canonicalJsonHash('toolu_fixture_hook_001,toolu_fixture_hook_002');

interface Case {
  readonly event: string;
  readonly kind: string;
  readonly severity: 0 | 1 | 2;
  readonly naturalKey: string | null;
  /** The logical events after the `session.seen` every envelope yields. */
  readonly logical: readonly LogicalEvent['k'][];
}

// One row per row of 02 4.3 (21 events, an event that is not installed); the probe is tested apart.
const CASES: readonly Case[] = [
  { event: 'SessionStart', kind: 'session.start', severity: 0, naturalKey: null, logical: ['session.start'] },
  {
    event: 'UserPromptSubmit',
    kind: 'prompt.submit',
    severity: 0,
    naturalKey: `prompt:${S}:${FIXTURE_PROMPT_ID}`,
    logical: ['turn.prompt', 'activity'],
  },
  {
    event: 'PreToolUse',
    kind: 'tool.call',
    severity: 0,
    naturalKey: `tool.call:${FIXTURE_TOOL_USE_ID}`,
    logical: ['tool.start', 'activity'],
  },
  {
    event: 'PermissionRequest',
    kind: 'permission.request',
    severity: 0,
    naturalKey: null,
    logical: ['permission.request'],
  },
  {
    event: 'PermissionDenied',
    kind: 'permission.denied',
    severity: 1,
    naturalKey: `permission.denied:${FIXTURE_TOOL_USE_ID}`,
    logical: ['tool.end'],
  },
  {
    event: 'PostToolUse',
    kind: 'tool.result',
    severity: 0,
    naturalKey: `tool.end:${FIXTURE_TOOL_USE_ID}`,
    logical: ['tool.end', 'activity'],
  },
  {
    event: 'PostToolUseFailure',
    kind: 'tool.failure',
    severity: 2,
    naturalKey: `tool.end:${FIXTURE_TOOL_USE_ID}`,
    logical: ['tool.end', 'activity'],
  },
  {
    event: 'PostToolBatch',
    kind: 'tool.batch',
    severity: 0,
    naturalKey: `tool.batch:${S}:${BATCH_HASH}`,
    logical: ['tool.batch', 'activity'],
  },
  { event: 'Notification', kind: 'notification.sent', severity: 0, naturalKey: null, logical: ['notification'] },
  { event: 'SubagentStart', kind: 'agent.start', severity: 0, naturalKey: null, logical: ['agent.start', 'activity'] },
  { event: 'SubagentStop', kind: 'agent.stop', severity: 0, naturalKey: null, logical: ['agent.stop', 'activity'] },
  {
    event: 'TaskCreated',
    kind: 'task.created',
    severity: 0,
    naturalKey: `task.created:${S}:task_fixture_1`,
    logical: ['info'],
  },
  {
    event: 'TaskCompleted',
    kind: 'task.completed',
    severity: 0,
    naturalKey: `task.completed:${S}:task_fixture_1`,
    logical: ['info'],
  },
  { event: 'Stop', kind: 'turn.stop', severity: 0, naturalKey: null, logical: ['turn.end'] },
  { event: 'StopFailure', kind: 'turn.failure', severity: 2, naturalKey: null, logical: ['turn.end'] },
  { event: 'TeammateIdle', kind: 'teammate.idle', severity: 0, naturalKey: null, logical: ['info'] },
  { event: 'PreCompact', kind: 'context.compact', severity: 0, naturalKey: null, logical: ['activity'] },
  { event: 'PostCompact', kind: 'context.compact', severity: 0, naturalKey: null, logical: ['compaction', 'activity'] },
  { event: 'PostModelSwitch', kind: 'model.switch', severity: 0, naturalKey: null, logical: ['info'] },
  { event: 'CwdChanged', kind: 'cwd.change', severity: 0, naturalKey: null, logical: ['info'] },
  { event: 'SessionEnd', kind: 'session.end', severity: 0, naturalKey: null, logical: ['session.end'] },
  { event: 'WorktreeCreate', kind: 'hook.unknown', severity: 1, naturalKey: null, logical: [] },
];

describe('normalizeEnvelope: the table of 02 4.3', () => {
  it('has one case for each of the 21 installed events and one for an event that is not installed', () => {
    expect(CASES.map((c) => c.event).slice(0, 21)).toEqual([...INSTALLED_HOOK_EVENTS]);
    expect(CASES).toHaveLength(22);
  });

  it.each(CASES.map((c) => [c.event, c] as const))('%s', (_name, c) => {
    const env = fixtureEnvelope(c.event);
    const out = normalizeEnvelope(env, { segment: 'hooks-20260102T03Z.ndjson', offset: 480 });
    expect(out.events.map((e) => e.k)).toEqual(['session.seen', ...c.logical]);

    const row = out.row;
    if (row === null) throw new Error('no row');
    expect(row.kind).toBe(c.kind);
    expect(EVENT_KINDS).toContain(row.kind);
    expect(row.severity).toBe(c.severity);
    expect(row.naturalKey).toBe(c.naturalKey);
    expect(eventKindOfEnvelope(env)).toBe(c.kind);

    // columns of every hook row
    expect(row).toMatchObject({
      sessionUid: S,
      sources: 1,
      tsSource: 'hook_received',
      receivedAt: FIXTURE_RECEIVED_AT,
      eventUid: env.event_uid,
      recordUuid: null,
      hookEvent: c.event,
      contentHash: env.content_hash,
      spoolSegment: 'hooks-20260102T03Z.ndjson',
      spoolOffset: 480,
      entryKind: null,
      fileId: null,
      byteOffset: null,
    });
    expect(row.stamp).toEqual({
      at: FIXTURE_RECEIVED_AT,
      rank:
        c.event === 'WorktreeCreate'
          ? HOOK_EVENT_RANK.unknown
          : HOOK_EVENT_RANK[c.event as keyof typeof HOOK_EVENT_RANK],
      tie: env.event_uid,
    });
    for (const e of out.events) {
      if ('stamp' in e) expect(e.stamp).toEqual(row.stamp);
    }
  });

  it('is a probe without logical events or a row', () => {
    expect(normalizeEnvelope(fixtureProbeEnvelope())).toEqual({ events: [], row: null });
    expect(eventKindOfEnvelope(fixtureProbeEnvelope())).toBeNull();
  });

  it('stores only kinds of EVENT_KINDS for all 21 events', () => {
    for (const env of allInstalledEnvelopes()) {
      const kind = eventKindOfEnvelope(env);
      expect(kind === null ? null : EVENT_KINDS.includes(kind)).toBe(true);
    }
  });

  it('yields nothing for an envelope without a session id', () => {
    const env = fixtureEnvelope('PreToolUse', { top: { session_id: null } });
    expect(normalizeEnvelope(env)).toEqual({ events: [], row: null });
  });
});

describe('normalizeEnvelope: logical event contents', () => {
  const only = <K extends LogicalEvent['k']>(
    events: readonly LogicalEvent[],
    k: K,
  ): Extract<LogicalEvent, { k: K }> => {
    const found = events.find((e): e is Extract<LogicalEvent, { k: K }> => e.k === k);
    if (found === undefined) throw new Error(`no ${k}`);
    return found;
  };

  it('session.seen carries the pid, the cwd and the transcript path of every envelope', () => {
    const { events } = normalizeEnvelope(fixtureEnvelope('Stop'));
    expect(only(events, 'session.seen')).toMatchObject({
      sessionId: S,
      claudePid: 4242,
      cwd: 'FIXTURE/project',
      transcriptPath: 'FIXTURE/projects/FIXTURE-session.jsonl',
    });
  });

  it('session.seen leaves out what the envelope does not carry', () => {
    const env = fixtureEnvelope('Stop', { top: { claude_pid: null, cwd: null, transcript_path: null } });
    const seen = only(normalizeEnvelope(env).events, 'session.seen');
    expect(Object.keys(seen).sort()).toEqual(['k', 'sessionId', 'stamp']);
  });

  it('SessionStart keeps the source and the model', () => {
    const e = only(normalizeEnvelope(fixtureEnvelope('SessionStart')).events, 'session.start');
    expect(e).toMatchObject({ startSource: 'startup', model: 'claude-sonnet-5-5' });
  });

  it('UserPromptSubmit is a hook-origin prompt with the length and the prompt id', () => {
    const e = only(normalizeEnvelope(fixtureEnvelope('UserPromptSubmit')).events, 'turn.prompt');
    expect(e).toMatchObject({ origin: 'hook', promptId: FIXTURE_PROMPT_ID, promptLen: 14, agentId: null });
  });

  it('PreToolUse starts a tool with its summary and input hash', () => {
    const e = only(normalizeEnvelope(fixtureEnvelope('PreToolUse')).events, 'tool.start');
    expect(e).toMatchObject({
      toolUseId: FIXTURE_TOOL_USE_ID,
      name: 'Bash',
      summary: 'echo FIXTURE',
      inputHash: '0123456789abcdef0123456789abcdef',
      promptId: FIXTURE_PROMPT_ID,
    });
  });

  it('PreToolUse without a tool use id still counts as activity and gets no natural key', () => {
    const out = normalizeEnvelope(fixtureEnvelope('PreToolUse', { top: { tool_use_id: null } }));
    expect(out.events.map((e) => e.k)).toEqual(['session.seen', 'activity']);
    expect(out.row?.naturalKey).toBeNull();
    expect(out.row?.kind).toBe('tool.call');
  });

  it('PermissionDenied ends the call as denied', () => {
    const e = only(normalizeEnvelope(fixtureEnvelope('PermissionDenied')).events, 'tool.end');
    expect(e).toMatchObject({ outcome: 'denied', toolUseId: FIXTURE_TOOL_USE_ID });
  });

  it('PostToolUse ends the call as ok with its duration', () => {
    const e = only(normalizeEnvelope(fixtureEnvelope('PostToolUse')).events, 'tool.end');
    expect(e).toMatchObject({ outcome: 'ok', durationMs: 12 });
  });

  it('PostToolUseFailure is an error with the exit code, or interrupted when the user interrupted', () => {
    const error = only(normalizeEnvelope(fixtureEnvelope('PostToolUseFailure')).events, 'tool.end');
    expect(error).toMatchObject({ outcome: 'error', exitCode: 1, durationMs: 15 });
    const interrupted = only(
      normalizeEnvelope(fixtureEnvelope('PostToolUseFailure', { data: { is_interrupt: true } })).events,
      'tool.end',
    );
    expect(interrupted.outcome).toBe('interrupted');
  });

  it('PostToolUse of an Agent call with a link id adds agent.link; of a Workflow call with a run id adds workflow.launch', () => {
    const agent = normalizeEnvelope(
      fixtureEnvelope('PostToolUse', {
        data: { tool_name: 'Agent', agent_link_id: FIXTURE_AGENT_ID, agent_status: 'async_launched' },
      }),
    );
    expect(only(agent.events, 'agent.link')).toMatchObject({
      agentId: FIXTURE_AGENT_ID,
      toolUseId: FIXTURE_TOOL_USE_ID,
      status: 'async_launched',
    });
    const workflow = normalizeEnvelope(
      fixtureEnvelope('PostToolUse', { data: { tool_name: 'Workflow', run_id: 'wf_fixture_1', workflow_name: 'fx' } }),
    );
    expect(only(workflow.events, 'workflow.launch')).toMatchObject({
      runId: 'wf_fixture_1',
      toolUseId: FIXTURE_TOOL_USE_ID,
      name: 'fx',
    });
    const bad = normalizeEnvelope(
      fixtureEnvelope('PostToolUse', { data: { tool_name: 'Agent', agent_link_id: 'no way!' } }),
    );
    expect(bad.events.map((e) => e.k)).not.toContain('agent.link');
  });

  it('PostToolBatch lists the tool use ids and hashes the sorted list into the natural key', () => {
    const out = normalizeEnvelope(fixtureEnvelope('PostToolBatch'));
    expect(only(out.events, 'tool.batch').toolUseIds).toEqual(['toolu_fixture_hook_002', 'toolu_fixture_hook_001']);
    const reversed = normalizeEnvelope(
      fixtureEnvelope('PostToolBatch', {
        data: {
          calls: [
            { tool_use_id: 'toolu_fixture_hook_001', tool_name: 'Read' },
            { tool_use_id: 'toolu_fixture_hook_002', tool_name: 'Bash' },
          ],
        },
      }),
    );
    expect(reversed.row?.naturalKey).toBe(out.row?.naturalKey);
  });

  it('PostToolBatch without calls gets no natural key', () => {
    const out = normalizeEnvelope(fixtureEnvelope('PostToolBatch', { data: { calls: [] } }));
    expect(out.row?.naturalKey).toBeNull();
  });

  it('Notification keeps the type; SessionEnd the reason; compaction the trigger', () => {
    expect(only(normalizeEnvelope(fixtureEnvelope('Notification')).events, 'notification').type).toBe('idle_prompt');
    expect(only(normalizeEnvelope(fixtureEnvelope('SessionEnd')).events, 'session.end').reason).toBe('other');
    expect(only(normalizeEnvelope(fixtureEnvelope('PostCompact')).events, 'compaction').trigger).toBe('auto');
  });

  it('SubagentStart and SubagentStop carry the agent id and type; the stop carries the transcript path', () => {
    const start = only(normalizeEnvelope(fixtureEnvelope('SubagentStart')).events, 'agent.start');
    expect(start).toMatchObject({ agentId: FIXTURE_AGENT_ID, agentType: 'general-purpose' });
    const stop = only(normalizeEnvelope(fixtureEnvelope('SubagentStop')).events, 'agent.stop');
    expect(stop.transcriptPath).toBe('FIXTURE/projects/agent-a1b2c3d4e5f6a7b8c.jsonl');
    const activity = only(normalizeEnvelope(fixtureEnvelope('SubagentStop')).events, 'activity');
    expect(activity.agentId).toBe(FIXTURE_AGENT_ID);
  });

  it('a subagent event without an agent id has no agent events', () => {
    const out = normalizeEnvelope(fixtureEnvelope('SubagentStart', { top: { agent_id: null } }));
    expect(out.events.map((e) => e.k)).toEqual(['session.seen']);
    expect(out.row?.kind).toBe('agent.start');
  });

  it('Stop and StopFailure end the turn with the counts and the error', () => {
    expect(only(normalizeEnvelope(fixtureEnvelope('Stop')).events, 'turn.end')).toMatchObject({
      kind: 'stop',
      backgroundTasks: 2,
      promptId: FIXTURE_PROMPT_ID,
    });
    expect(only(normalizeEnvelope(fixtureEnvelope('StopFailure')).events, 'turn.end')).toMatchObject({
      kind: 'stop_failure',
      error: 'rate_limit',
    });
  });

  it('info events name what happened', () => {
    const what = (event: string): string => only(normalizeEnvelope(fixtureEnvelope(event)).events, 'info').what;
    expect(what('TaskCreated')).toBe('task_created');
    expect(what('TaskCompleted')).toBe('task_completed');
    expect(what('TeammateIdle')).toBe('teammate_idle');
    expect(what('PostModelSwitch')).toBe('model_switch');
    expect(what('CwdChanged')).toBe('cwd_changed');
  });

  it('an event that is not installed is session.seen and a hook.unknown row of rank 70', () => {
    const out = normalizeEnvelope(fixtureEnvelope('WorktreeCreate'));
    expect(out.events.map((e) => e.k)).toEqual(['session.seen']);
    expect(out.row).toMatchObject({ kind: 'hook.unknown', severity: 1, hookEvent: 'WorktreeCreate' });
    expect(out.row?.stamp.rank).toBe(70);
  });
});

describe('normalizeEnvelope: the stored row', () => {
  it('keeps the previews it is given and the envelope flags', () => {
    const out = normalizeEnvelope(fixtureEnvelope('PreToolUse', { top: { flags: ['redacted'] } }));
    expect(out.row).toMatchObject({
      summary: 'echo FIXTURE',
      flags: ['redacted'],
      toolName: 'Bash',
      toolUseId: FIXTURE_TOOL_USE_ID,
      promptId: FIXTURE_PROMPT_ID,
    });
  });

  it('a StopFailure row keeps the error preview (160 code points, redacted) and never an error_details field', () => {
    const long = `password=hunter2hunter2 ${'word '.repeat(80)}`;
    const out = normalizeEnvelope(fixtureEnvelope('StopFailure', { data: { error_preview: long } }));
    const summary = out.row?.summary ?? '';
    expect(summary.startsWith('password=[redacted] word word')).toBe(true);
    expect(summary).not.toContain('hunter2hunter2');
    expect(Array.from(summary.split(' ... [truncated ')[0] ?? '').length).toBeLessThanOrEqual(160);
    expect(out.events.find((e) => e.k === 'turn.end')).toMatchObject({ kind: 'stop_failure', error: 'rate_limit' });
    // the stored copy has no trace of a raw field of that name
    expect(Object.keys(out.row?.detail ?? {})).not.toContain('error_details');
    expect(JSON.stringify(out)).not.toContain('error_details');
  });

  it('puts the prompt length of a prompt row in text_len and no text anywhere', () => {
    const out = normalizeEnvelope(fixtureEnvelope('UserPromptSubmit'));
    expect(out.row?.textLen).toBe(14);
    expect(out.row?.summary).toBeNull();
  });

  it('flattens the data into scalars (a list becomes its length) and keeps it under 16 KiB', () => {
    const out = normalizeEnvelope(fixtureEnvelope('PostToolBatch'));
    expect(out.row?.detail).toEqual({ calls_count: 2 });
    const big = normalizeEnvelope(
      fixtureEnvelope('Notification', {
        data: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`key_${String(i).padStart(2, '0')}`, 'v'.repeat(900)]),
        ),
      }),
    );
    expect(JSON.stringify(big.row?.detail).length).toBeLessThanOrEqual(16 * 1024);
    expect(big.row?.detail).not.toBeNull();
  });

  it('uses the agent id of the envelope, and "main" for agent-level kinds of the main agent', () => {
    expect(normalizeEnvelope(fixtureEnvelope('SubagentStart')).row?.agentUid).toBe(FIXTURE_AGENT_ID);
    expect(normalizeEnvelope(fixtureEnvelope('PreToolUse')).row?.agentUid).toBe('main');
    expect(normalizeEnvelope(fixtureEnvelope('SessionStart')).row?.agentUid).toBeNull();
    expect(
      normalizeEnvelope(fixtureEnvelope('PreToolUse', { top: { agent_id: FIXTURE_AGENT_ID } })).row?.agentUid,
    ).toBe(FIXTURE_AGENT_ID);
  });
});

describe('normalizeEnvelope: rows are accepted by EventsRepo (CHECKs of 03 3.5)', () => {
  const makeTemp = useTempDirs();
  const ctx: RepoContext = { instanceId: FIXTURE_INSTANCE_ID };
  const opened: InstanceDb[] = [];
  // registered after useTempDirs(): the database closes before its folder is removed
  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });

  it('inserts the row of an envelope whose strings are far longer than the columns', () => {
    const db = openInstanceDb({
      path: join(makeTemp('envelope-hostile-db').path, 'monitor.db'),
      expectedInstanceId: FIXTURE_INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
      clock: new FakeClock(FIXTURE_EPOCH_MS),
    });
    opened.push(db);
    const t = FIXTURE_EPOCH_MS;
    const { lastInsertRowid: sessionId } = db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([S, t, t, t, t]);
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      )
      .run([sessionId, t, t, t, t]);
    const env = fixtureEnvelope('PreToolUse', {
      data: { tool_name: 'T'.repeat(5000), tool_summary: 'S'.repeat(5000), tool_input_hash: 'h'.repeat(5000) },
    });
    const { row, events } = normalizeEnvelope(env);
    if (row === null) throw new Error('no row');
    const result = withWriteTx(db, ctx, (tx) => new EventsRepo(db).insert(ctx, tx, row));
    expect(result.outcome).toBe('inserted');
    expect(row.toolName).toHaveLength(200);
    const start = events.find((e) => e.k === 'tool.start');
    expect(start?.k === 'tool.start' && Array.from(start.name).length).toBe(128);
    expect(start?.k === 'tool.start' && Array.from(start.summary ?? '').length).toBeLessThan(260);
    expect(start?.k === 'tool.start' && Array.from(start.inputHash ?? '').length).toBe(32);
  });

  it('inserts the row of each of the 21 events, the unknown event, and merges nothing it should not', () => {
    const db = openInstanceDb({
      path: join(makeTemp('envelope-db').path, 'monitor.db'),
      expectedInstanceId: FIXTURE_INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
      clock: new FakeClock(FIXTURE_EPOCH_MS),
    });
    opened.push(db);
    const { lastInsertRowid: sessionId } = db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([S, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS]);
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      )
      .run([sessionId, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS]);
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, 1, 'subagent', 1, ?, ?, ?, ?)",
      )
      .run([sessionId, FIXTURE_AGENT_ID, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS, FIXTURE_EPOCH_MS]);

    const repo = new EventsRepo(db);
    let offset = 0;
    const envelopes = [...allInstalledEnvelopes(), fixtureEnvelope('WorktreeCreate')];
    for (const env of envelopes) {
      const { row } = normalizeEnvelope(env, { segment: 'hooks-20260102T03Z.ndjson', offset });
      offset += 100;
      if (row === null) throw new Error(`no row for ${env.event}`);
      const result = withWriteTx(db, ctx, (tx) => repo.insert(ctx, tx, row));
      // PostToolUseFailure shares the tool use id of PostToolUse: the two hooks of one call are one row (`tool.failure` wins)
      expect(result.outcome, env.event).toBe(env.event === 'PostToolUseFailure' ? 'merged' : 'inserted');
    }
    const count = db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM events').get()?.n;
    expect(count).toBe(envelopes.length - 1);
    const merged = db.driver
      .prepare<{ kind: string; severity: number }>(
        "SELECT kind, severity FROM events WHERE natural_key LIKE 'tool.end:%'",
      )
      .all();
    expect(merged).toEqual([{ kind: 'tool.failure', severity: 2 }]);
  });
});
