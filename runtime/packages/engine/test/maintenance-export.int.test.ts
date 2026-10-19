// The export `mcs.export/1` over real databases (03 11.1, 19.8, WP-60):
//   DA-T-E-1  every line validates against its export schema; the trailer counts and the sha256 of every byte before the trailer
//             match; no transcript text without `includeContent`; `strict` removes the listed fields and refuses `includeContent`
//   DA-T-E-2  the export of one instance holds no row of another, and a context of another instance is refused
//   and the paging: keyset pages of 1,000 ids, `drain` awaited, an abort that stops the export, a session that is deleted
//   between two pages, the filters (`session`, `workItem`, a time range, `include`).
// Every row and every transcript is synthetic; the SENTINEL strings must never appear where they may not.
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
  EXPORT_RECORD_TYPES,
  ExportLineSchema,
  ExportQuerySchema,
  RUNTIME_VERSION,
  isoMsZ,
  type ExportLine,
  type ExportQuery,
} from '@mcs/shared';
import { FakeClock, TranscriptBuilder, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../src/config/resolve.ts';
import type { SqlDriver, SqlValue, Stmt } from '../src/db/driver.ts';
import { isDbError } from '../src/db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../src/db/open.ts';
import { UsageRepo, type UsageValues } from '../src/db/repos/usage.ts';
import { withWriteTx } from '../src/db/write.ts';
import { exportInstance, projectPseudonym, type ExportContext } from '../src/maintenance/export.ts';
import { createQueries } from '../src/query/index.ts';
import { QueryRefusal } from '../src/query/transitions.ts';
import { SENTINEL } from './fixtures/transcripts.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
});

// `transcripts_dir: auto` looks below the Claude home of the environment: an empty temp home keeps the real one unread, and the
// folder of the main transcript stays the containment root.
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', makeTemp('claude-home').path);
});

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

// ---- seeding -----------------------------------------------------------------------------------------------------------------

function insert(db: InstanceDb, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return db.driver
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`,
    )
    .run(row).lastInsertRowid;
}

const uidOf = (instance: number, n: number): string =>
  `${String(instance).repeat(8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Seeded {
  readonly id: number;
  readonly uid: string;
  readonly main: number;
}

interface SessionRow {
  readonly lastActivityAt?: number;
  readonly label?: string;
  readonly labelSource?: string;
  readonly projectId?: number | null;
  readonly cwd?: string | null;
}

function addSession(db: InstanceDb, instance: number, n: number, o: SessionRow = {}): Seeded {
  const uid = uidOf(instance, n);
  const lastActivityAt = o.lastActivityAt ?? NOW - HOUR;
  const startedAt = lastActivityAt - HOUR;
  const id = insert(db, 'sessions', {
    session_uid: uid,
    label: o.label ?? `FIXTURE session ${String(n)}`,
    label_source: o.labelSource ?? 'rule',
    matched: 1,
    project_id: o.projectId ?? null,
    cwd: o.cwd ?? null,
    git_branch: o.cwd === undefined || o.cwd === null ? null : 'fixture-branch',
    permission_mode: o.cwd === undefined || o.cwd === null ? null : 'default',
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: lastActivityAt,
  });
  const main = insert(db, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: lastActivityAt,
  });
  return { id, uid, main };
}

let counter = 0;

function addEvent(db: InstanceDb, s: Seeded, ts: number, over: Record<string, SqlValue> = {}): number {
  counter += 1;
  return insert(db, 'events', {
    session_id: s.id,
    agent_id: s.main,
    kind: 'tool.call',
    sources: 1,
    ts,
    ts_source: 'record',
    received_at: ts,
    natural_key: `fixture:event:${String(counter)}`,
    ...over,
  });
}

function usageValues(input: number): UsageValues {
  return {
    model: 'fixture-model',
    inputTokens: input,
    outputTokens: input * 2,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    thinkingTokens: null,
    webSearchRequests: null,
    webFetchRequests: null,
    legacyIn: input,
    legacyOut: input * 2,
    legacyCr: 0,
    legacyCc: 0,
    finalized: true,
    usageSource: 'top',
    synthetic: false,
    ts: NOW - HOUR,
    invalidValues: 0,
  };
}

interface World {
  readonly db: InstanceDb;
  readonly s1: Seeded;
  readonly s2: Seeded;
  readonly s3: Seeded;
  readonly dir: string;
  readonly itemId: number;
}

/** Three sessions with agents, a workflow run, events, tool calls, turns, usage, transitions, alerts and a work item. */
function openWorld(instance: 1 | 2, id: string): World {
  const dir = makeTemp(`export-int-${String(instance)}`).path;
  const db = openInstanceDb({
    path: path.join(dir, 'monitor.db'),
    expectedInstanceId: id,
    mode: 'serve',
    runtimeVersion: RUNTIME_VERSION,
    clock: new FakeClock(NOW),
  });
  opened.push(db);
  const project = insert(db, 'projects', {
    project_key: 'fixture-project',
    dir_name: 'fixture-project',
    root_path: 'FIXTURE/root/fixture-project',
    first_seen_at: NOW - DAY,
    last_activity_at: NOW,
  });
  const s1 = addSession(db, instance, 1, {
    label: 'FIXTURE first prompt label',
    labelSource: 'first_prompt',
    projectId: project,
    cwd: 'FIXTURE/cwd/one',
    lastActivityAt: NOW - HOUR,
  });
  const s2 = addSession(db, instance, 2, { lastActivityAt: NOW - 3 * DAY });
  const s3 = addSession(db, instance, 3, { lastActivityAt: NOW - 10 * DAY });
  const ctx: RepoContext = { instanceId: id };

  // a subagent and a workflow run of the first session
  const run = insert(db, 'workflow_runs', {
    session_id: s1.id,
    run_uid: 'wf_fixture_1',
    workflow_name: 'FIXTURE workflow name',
    started_at: NOW - 2 * HOUR,
    updated_at: NOW,
  });
  insert(db, 'agents', {
    session_id: s1.id,
    agent_uid: 'agent-fixture-1',
    parent_agent_id: s1.main,
    kind: 'subagent',
    depth: 1,
    agent_type: 'general-purpose',
    label: 'FIXTURE helper label',
    description: 'FIXTURE helper description',
    workflow_run_id: run,
    first_seen_at: NOW - 2 * HOUR,
    started_at: NOW - 2 * HOUR,
    last_activity_at: NOW - HOUR,
    updated_at: NOW,
  });

  // events (the first has a summary and a tool call it refers to), tool calls, turns
  for (const s of [s1, s2, s3]) {
    for (let i = 0; i < 4; i += 1) addEvent(db, s, s.id * 1000 + i * 1000 + NOW - 5 * DAY);
  }
  addEvent(db, s1, NOW - 90 * 60_000, {
    summary: 'FIXTURE event summary',
    tool_name: 'Bash',
    tool_use_id: 'toolu_fixture_1',
    detail: JSON.stringify({ exitCode: 0 }),
  });
  for (const [n, s] of [s1, s2].entries()) {
    insert(db, 'tool_calls', {
      session_id: s.id,
      agent_id: s.main,
      tool_use_id: `toolu_fixture_${String(n + 1)}`,
      name: 'Bash',
      summary: 'FIXTURE tool summary',
      started_at: NOW - 90 * 60_000,
      ended_at: NOW - 89 * 60_000,
      outcome: 'ok',
      duration_ms: 60_000,
      updated_at: NOW,
    });
  }
  insert(db, 'turns', {
    session_id: s1.id,
    prompt_id: 'prompt-1',
    started_at: NOW - 2 * HOUR,
    ended_at: NOW - HOUR,
    end_kind: 'end_turn',
    tool_count: 1,
  });
  // a turn that was only known from a tool call has no time at all: the format cannot hold it, so it is left out
  insert(db, 'turns', { session_id: s1.id, prompt_id: 'prompt-timeless' });

  // two files per first session so that a usage key is held twice; transcripts are added by the tests that need them
  const file1 = insert(db, 'transcript_files', {
    path: path.join(dir, 'projects', `${s1.uid}.jsonl`),
    path_key: `fixture/${s1.uid}`,
    kind: 'session',
    session_uid: s1.uid,
    session_id: s1.id,
    agent_id: s1.main,
    discovered_at: NOW - DAY,
    updated_at: NOW,
  });
  insert(db, 'transcript_files', {
    path: path.join(dir, 'projects', `${s2.uid}.jsonl`),
    path_key: `fixture/${s2.uid}`,
    kind: 'session',
    session_uid: s2.uid,
    session_id: s2.id,
    agent_id: s2.main,
    state: 'missing',
    discovered_at: NOW - DAY,
    updated_at: NOW,
  });
  insert(db, 'transcript_files', {
    path: path.join(dir, 'projects', `${s3.uid}.jsonl`),
    path_key: `fixture/${s3.uid}`,
    kind: 'session',
    session_uid: s3.uid,
    session_id: s3.id,
    agent_id: s3.main,
    discovered_at: NOW - DAY,
    updated_at: NOW,
  });
  withWriteTx(db, ctx, (tx) => {
    const usage = new UsageRepo(db);
    usage.applyRecord(ctx, tx, file1, 'msg_fixture_1', usageValues(10));
    usage.applyRecord(ctx, tx, file1, 'msg_fixture_2', usageValues(20));
  });
  insert(db, 'state_transitions', {
    session_id: s1.id,
    to_state: 'running',
    rule: 'T-1',
    basis: 'observed',
    confidence: 'high',
    at: NOW - 2 * HOUR,
  });
  insert(db, 'state_transitions', {
    session_id: s1.id,
    from_state: 'running',
    to_state: 'completed',
    rule: 'T-2',
    basis: 'observed',
    confidence: 'high',
    at: NOW - HOUR,
  });
  insert(db, 'alerts', {
    rule_id: 'inactivity',
    rule_kind: 'inactivity',
    scope_kind: 'session',
    scope_key: s1.uid,
    session_id: s1.id,
    severity: 'warning',
    status: 'open',
    title: 'FIXTURE session alert',
    first_fired_at: NOW - HOUR,
    last_fired_at: NOW - HOUR,
  });
  insert(db, 'alerts', {
    rule_id: 'hook_failing',
    rule_kind: 'hook_failing',
    scope_kind: 'instance',
    scope_key: 'instance',
    severity: 'critical',
    status: 'open',
    title: 'FIXTURE instance alert',
    first_fired_at: NOW - HOUR,
    last_fired_at: NOW - HOUR,
  });
  const itemId = insert(db, 'work_items', {
    item_key: 'label:FIXTURE item',
    kind: 'label',
    title: 'FIXTURE item',
    state: 'completed',
    rule: 'W-LBL',
    board_reason: 'done',
    state_since: NOW - DAY,
    session_count: 2,
    last_activity_at: NOW - HOUR,
    created_at: NOW - DAY,
    updated_at: NOW,
  });
  insert(db, 'work_item_sessions', { work_item_id: itemId, session_id: s1.id, linked_at: NOW });
  insert(db, 'work_item_sessions', { work_item_id: itemId, session_id: s2.id, linked_at: NOW });
  return { db, s1, s2, s3, dir, itemId };
}

// ---- running an export -------------------------------------------------------------------------------------------------------

/** A writable that keeps every byte. */
class Collector extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    done();
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface Exported {
  readonly bytes: Buffer;
  readonly text: string;
  readonly lines: ExportLine[];
  readonly summary: Awaited<ReturnType<typeof exportInstance>>;
}

function contextOf(id: string, extra: Partial<ExportContext> = {}): ExportContext {
  return {
    instanceId: id,
    slug: 'demo',
    runtimeVersion: RUNTIME_VERSION,
    config,
    clock: new FakeClock(NOW),
    ...extra,
  };
}

/** The window service of the live instance, which `includeContent` reads through. */
function transcriptsOf(db: InstanceDb): NonNullable<ExportContext['transcripts']> {
  return createQueries(db, { config, now: () => NOW, audit: { entriesBetween: () => Promise.resolve([]) } });
}

async function runExport(
  w: Pick<World, 'db'>,
  query: ExportQuery = {},
  over: Partial<ExportContext> = {},
  options?: { pageSize?: number },
): Promise<Exported> {
  const out = new Collector();
  const summary = await exportInstance(w.db, contextOf(ID, over), query, out, new AbortController().signal, options);
  const bytes = out.bytes();
  const text = bytes.toString('utf8');
  const lines = text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): ExportLine => ExportLineSchema.parse(JSON.parse(line)));
  return { bytes, text, lines, summary };
}

function ofType<T extends ExportLine['type']>(
  lines: readonly ExportLine[],
  type: T,
): Extract<ExportLine, { type: T }>[] {
  return lines.flatMap((line) => (line.type === type ? [line as Extract<ExportLine, { type: T }>] : []));
}

// ---- DA-T-E-1 ---------------------------------------------------------------------------------------------------------------

describe('DA-T-E-1: the format', () => {
  it('writes a header, the records in the order of the format and a trailer whose counts and sha256 match', async () => {
    const w = openWorld(1, ID);
    const result = await runExport(w);

    const types = result.lines.map((line) => line.type);
    expect(types[0]).toBe('header');
    expect(types.at(-1)).toBe('trailer');
    // every record type appears in the order of the format, and the types never interleave
    const order = EXPORT_RECORD_TYPES.filter((type) => types.includes(type));
    expect(order).toEqual([...EXPORT_RECORD_TYPES]);
    const compact = types.filter((type, index) => type !== types[index - 1]);
    expect(compact).toEqual(['header', ...EXPORT_RECORD_TYPES, 'trailer']);

    const [header] = ofType(result.lines, 'header');
    expect(header).toMatchObject({
      type: 'header',
      format: 'mcs.export/1',
      instanceId: ID,
      slug: 'demo',
      exportedAt: isoMsZ(NOW),
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: 1,
      scope: { from: null, to: isoMsZ(NOW), sessions: [] },
      redaction: 'standard',
      includeContent: false,
      privacyNote: 'Metadata only: no prompt, reply, thinking or tool result text.',
    });
    expect(header?.include).toHaveLength(10);

    const counts: Record<string, number> = {};
    for (const line of result.lines) {
      if (line.type !== 'header' && line.type !== 'trailer') counts[line.type] = (counts[line.type] ?? 0) + 1;
    }
    expect(counts).toEqual({
      session: 3,
      agent: 4,
      workflow: 1,
      work_item: 1,
      turn: 1,
      event: 13,
      tool_call: 2,
      usage: 2,
      transition: 2,
      alert: 2,
    });
    const [trailer] = ofType(result.lines, 'trailer');
    expect(trailer?.counts).toEqual(counts);
    expect(trailer?.missingTranscripts).toEqual([]);

    // the sha256 is that of every byte before the trailer line
    const lastLineStart = result.bytes.lastIndexOf(10, result.bytes.length - 2) + 1;
    expect(createHash('sha256').update(result.bytes.subarray(0, lastLineStart)).digest('hex')).toBe(trailer?.sha256);
    expect(result.summary).toEqual({
      lines: result.lines.length,
      bytes: result.bytes.length,
      sha256: trailer?.sha256,
      counts,
      includeContent: false,
    });
    // LF only, UTF-8, one JSON object per line
    expect(result.text.endsWith('\n')).toBe(true);
    expect(result.text).not.toContain('\r');
  });

  it('exports the rows as the API shows them', async () => {
    const w = openWorld(1, ID);
    const { lines } = await runExport(w);
    const [first] = ofType(lines, 'session');
    expect(first?.data).toMatchObject({
      id: w.s1.uid,
      label: 'FIXTURE first prompt label',
      labelSource: 'first_prompt',
      projectId: 'fixture-project',
      projectLabel: 'fixture-project',
      cwd: 'FIXTURE/cwd/one',
      gitBranch: 'fixture-branch',
      permissionMode: 'default',
    });
    const agents = ofType(lines, 'agent').map((line) => [line.data.sessionId, line.data.id, line.data.label]);
    expect(agents).toContainEqual([w.s1.uid, 'agent-fixture-1', 'FIXTURE helper label']);
    const event = ofType(lines, 'event').find((line) => line.data.summary === 'FIXTURE event summary');
    expect(event?.data).toMatchObject({ toolName: 'Bash', toolUseId: 'toolu_fixture_1', toolStatus: 'succeeded' });
    expect(event?.data).not.toHaveProperty('sessionLabel');
    expect(event?.data).not.toHaveProperty('agentLabel');
    expect(ofType(lines, 'turn').map((line) => line.data.promptId)).toEqual(['prompt-1']);
    expect(ofType(lines, 'usage').map((line) => [line.data.messageKey, line.data.agentId, line.data.input])).toEqual([
      ['msg_fixture_1', 'main', 10],
      ['msg_fixture_2', 'main', 20],
    ]);
    expect(ofType(lines, 'transition').map((line) => [line.data.sessionId, line.data.to])).toEqual([
      [w.s1.uid, 'running'],
      [w.s1.uid, 'completed'],
    ]);
    expect(ofType(lines, 'work_item').map((line) => line.data.title)).toEqual(['FIXTURE item']);
    expect(ofType(lines, 'workflow').map((line) => line.data.runId)).toEqual(['wf_fixture_1']);
  });

  it('holds no transcript text without includeContent, even when the transcript is on disk', async () => {
    const w = openWorld(1, ID);
    const b = new TranscriptBuilder({ sessionId: w.s1.uid, cwd: 'FIXTURE/cwd', startMs: NOW - 3 * HOUR });
    b.user(SENTINEL.prompt);
    b.assistant({ messageId: 'msg_s1', text: SENTINEL.assistant });
    b.raw({
      type: 'assistant',
      timestamp: new Date(NOW - 2 * HOUR).toISOString(),
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: SENTINEL.thinking }] },
    });
    b.write(path.join(w.dir, 'projects', `${w.s1.uid}.jsonl`));

    const standard = await runExport(w);
    const strict = await runExport(w, { redaction: 'strict' });
    for (const result of [standard, strict]) {
      for (const secret of Object.values(SENTINEL)) expect(result.text).not.toContain(secret);
      expect(ofType(result.lines, 'transcript')).toEqual([]);
      expect(result.summary.includeContent).toBe(false);
    }
  });

  it('includeContent adds the display entries of the transcripts on disk, 500 per line, without thinking, and lists the gone ones', async () => {
    const w = openWorld(1, ID);
    const b = new TranscriptBuilder({ sessionId: w.s1.uid, cwd: 'FIXTURE/cwd', startMs: NOW - 3 * HOUR });
    b.user(SENTINEL.prompt);
    b.assistant({ messageId: 'msg_s1', text: SENTINEL.assistant });
    b.raw({
      type: 'assistant',
      timestamp: new Date(NOW - 2 * HOUR).toISOString(),
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: SENTINEL.thinking }] },
    });
    for (let i = 0; i < 1100; i += 1) b.user(`FIXTURE prompt number ${String(i)}`);
    mkdirSync(path.join(w.dir, 'projects'), { recursive: true });
    b.write(path.join(w.dir, 'projects', `${w.s1.uid}.jsonl`));

    const result = await runExport(w, { includeContent: true }, { transcripts: transcriptsOf(w.db) });

    const transcripts = ofType(result.lines, 'transcript');
    // 1103 entries (a prompt, a reply, a thinking block and 1100 prompts); the window reads 500 entries a call and the
    // thinking entry (number 2) is left out of the first one
    expect(transcripts.map((line) => [line.sessionId, line.agentId, line.entries.length])).toEqual([
      [w.s1.uid, 'main', 499],
      [w.s1.uid, 'main', 500],
      [w.s1.uid, 'main', 103],
    ]);
    expect(transcripts[0]?.entries[0]).toMatchObject({ i: 0, k: 'prompt', text: SENTINEL.prompt });
    expect(transcripts[0]?.entries[1]).toMatchObject({ i: 1, k: 'say', text: SENTINEL.assistant });
    expect(result.text).not.toContain(SENTINEL.thinking);
    // entries keep their number in the transcript across the lines: every one but the thinking entry
    expect(transcripts.flatMap((line) => line.entries.map((entry) => entry.i))).toEqual(
      Array.from({ length: 1103 }, (_, i) => i).filter((i) => i !== 2),
    );
    const [header] = ofType(result.lines, 'header');
    expect(header).toMatchObject({
      includeContent: true,
      privacyNote: 'Contains transcript text: treat as confidential.',
    });
    const [trailer] = ofType(result.lines, 'trailer');
    // the second session's file is marked missing, the third one is not on disk
    expect(trailer?.missingTranscripts).toEqual([
      { sessionId: w.s2.uid, agentId: 'main' },
      { sessionId: w.s3.uid, agentId: 'main' },
    ]);
    expect(trailer?.counts['transcript']).toBe(3);
    expect(result.summary.includeContent).toBe(true);
  });

  it('refuses includeContent with strict redaction, and without a transcript window, before a byte is written', async () => {
    const w = openWorld(1, ID);
    const out = new Collector();
    const strict = exportInstance(
      w.db,
      contextOf(ID, { transcripts: transcriptsOf(w.db) }),
      { redaction: 'strict', includeContent: true },
      out,
      new AbortController().signal,
    );
    await expect(strict).rejects.toBeInstanceOf(RangeError);
    const bare = exportInstance(w.db, contextOf(ID), { includeContent: true }, out, new AbortController().signal);
    await expect(bare).rejects.toBeInstanceOf(RangeError);
    expect(out.chunks).toEqual([]);
    // the API schema refuses the same combination with validation_failed
    expect(ExportQuerySchema.safeParse({ redaction: 'strict', includeContent: '1' }).success).toBe(false);
  });

  it('strict removes the first-prompt label, the summaries, names, paths and branch, and pseudonymises the project', async () => {
    const w = openWorld(1, ID);
    const { lines, text } = await runExport(w, { redaction: 'strict' });
    for (const secret of [
      'FIXTURE first prompt label',
      'FIXTURE event summary',
      'FIXTURE tool summary',
      'FIXTURE workflow name',
      'FIXTURE helper label',
      'FIXTURE cwd',
      'FIXTURE/cwd/one',
      'fixture-branch',
      'FIXTURE/root',
      'fixture-project',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    const [first] = ofType(lines, 'session');
    expect(first?.data).toMatchObject({
      label: '',
      labelSource: 'first_prompt',
      projectId: projectPseudonym('fixture-project'),
      projectLabel: null,
      cwd: null,
      gitBranch: null,
    });
    expect(first?.data.projectId).toMatch(/^p-[0-9a-f]{12}$/);
    // a label that did not come from the first prompt is not text of the person and stays
    expect(ofType(lines, 'session')[1]?.data.label).toBe('FIXTURE session 2');
    expect(ofType(lines, 'agent').find((line) => line.data.id === 'agent-fixture-1')?.data.label).toBe(
      'general-purpose',
    );
    expect(ofType(lines, 'workflow')[0]?.data.name).toBeNull();
    expect(ofType(lines, 'tool_call').every((line) => line.data.summary === null)).toBe(true);
    expect(ofType(lines, 'event').every((line) => line.data.summary === '')).toBe(true);
    const [header] = ofType(lines, 'header');
    expect(header?.redaction).toBe('strict');
  });
});

// ---- DA-T-E-2 ---------------------------------------------------------------------------------------------------------------

describe('DA-T-E-2: one instance, one export', () => {
  it("instance A's export holds no row of instance B", async () => {
    const a = openWorld(1, ID);
    const b = openWorld(2, OTHER_ID);
    const exported = await runExport(a);
    const sessions = ofType(exported.lines, 'session').map((line) => line.data.id);
    expect(sessions.sort()).toEqual([a.s1.uid, a.s2.uid, a.s3.uid].sort());
    for (const foreign of [b.s1.uid, b.s2.uid, b.s3.uid]) expect(exported.text).not.toContain(foreign);
    expect(exported.text).not.toContain(OTHER_ID);
    const [header] = ofType(exported.lines, 'header');
    expect(header?.instanceId).toBe(ID);
  });

  it('refuses a context of another instance before it writes a byte', async () => {
    const a = openWorld(1, ID);
    const out = new Collector();
    const refused = await exportInstance(a.db, contextOf(OTHER_ID), {}, out, new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isDbError(refused, 'scope_mismatch')).toBe(true);
    expect(out.chunks).toEqual([]);
  });
});

// ---- filters ---------------------------------------------------------------------------------------------------------------

describe('the filters of the query', () => {
  it('session limits every type to the named sessions and lists them in the header', async () => {
    const w = openWorld(1, ID);
    const { lines } = await runExport(w, { session: [w.s2.uid, 'ffffffff-0000-4000-8000-ffffffffffff'] });
    expect(ofType(lines, 'session').map((line) => line.data.id)).toEqual([w.s2.uid]);
    expect(ofType(lines, 'header')[0]?.scope.sessions).toEqual([w.s2.uid]);
    expect(ofType(lines, 'event')).toHaveLength(4);
    expect(ofType(lines, 'tool_call').map((line) => line.data.sessionId)).toEqual([w.s2.uid]);
    expect(ofType(lines, 'agent')).toHaveLength(1);
    // the alerts of the other session and the instance level alert are not part of a session export
    expect(ofType(lines, 'alert')).toEqual([]);
    expect(ofType(lines, 'usage')).toEqual([]);
  });

  it('workItem exports the item and its sessions', async () => {
    const w = openWorld(1, ID);
    const { lines } = await runExport(w, { workItem: w.itemId });
    expect(
      ofType(lines, 'session')
        .map((line) => line.data.id)
        .sort(),
    ).toEqual([w.s1.uid, w.s2.uid].sort());
    expect(ofType(lines, 'work_item').map((line) => line.data.id)).toEqual([w.itemId]);
    expect(ofType(lines, 'header')[0]?.scope.sessions.sort()).toEqual([w.s1.uid, w.s2.uid].sort());
    expect(ofType(lines, 'event').every((line) => line.data.sessionId !== w.s3.uid)).toBe(true);
    const unknown = await runExport(w, { workItem: 9999 });
    expect(ofType(unknown.lines, 'session')).toEqual([]);
    expect(ofType(unknown.lines, 'work_item')).toEqual([]);
  });

  it('a time range selects the sessions that were active in it and resolves the bounds in the header', async () => {
    const w = openWorld(1, ID);
    const week = await runExport(w, { range: '7d' });
    expect(
      ofType(week.lines, 'session')
        .map((line) => line.data.id)
        .sort(),
    ).toEqual([w.s1.uid, w.s2.uid].sort());
    expect(ofType(week.lines, 'header')[0]?.scope).toEqual({
      from: isoMsZ(NOW - 7 * DAY),
      to: isoMsZ(NOW),
      sessions: [],
    });
    const custom = await runExport(w, {
      from: isoMsZ(NOW - 12 * DAY),
      to: isoMsZ(NOW - 6 * DAY),
    });
    expect(ofType(custom.lines, 'session').map((line) => line.data.id)).toEqual([w.s3.uid]);
    expect(ofType(custom.lines, 'header')[0]?.scope).toEqual({
      from: isoMsZ(NOW - 12 * DAY),
      to: isoMsZ(NOW - 6 * DAY),
      sessions: [],
    });
  });

  it('refuses a range that is not valid before it writes a byte', async () => {
    const w = openWorld(1, ID);
    for (const query of [
      { from: isoMsZ(NOW), to: isoMsZ(NOW - DAY) },
      { to: isoMsZ(NOW) },
      { range: '7d', from: isoMsZ(NOW - DAY) },
    ] as const) {
      const out = new Collector();
      const refused = await exportInstance(w.db, contextOf(ID), query, out, new AbortController().signal).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(QueryRefusal);
      expect(refused instanceof QueryRefusal ? refused.code : '').toBe('range_invalid');
      expect(out.chunks).toEqual([]);
    }
  });

  it('include limits the record types and the header says which', async () => {
    const w = openWorld(1, ID);
    const { lines } = await runExport(w, { include: ['events', 'sessions'] });
    expect(new Set(lines.map((line) => line.type))).toEqual(new Set(['header', 'session', 'event', 'trailer']));
    expect(ofType(lines, 'header')[0]?.include).toEqual(['sessions', 'events']);
    expect(ofType(lines, 'trailer')[0]?.counts).toEqual({ session: 3, event: 13 });
  });
});

// ---- paging, back pressure, abort ------------------------------------------------------------------------------------------

interface Call {
  readonly sql: string;
  readonly params: unknown;
}

const PageParamsSchema = z.object({ last: z.number(), limit: z.number() });

/** Lets the event loop turn a number of times: whatever would happen without a `drain` would have happened by then. */
async function turns(count = 25): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** `db` with a driver that tells `onAll` about every query that is read with `all`, after it ran. */
function spied(db: InstanceDb, onAll: (call: Call) => void): InstanceDb {
  const driver: SqlDriver = {
    ...db.driver,
    prepare: <R>(sql: string): Stmt<R> => {
      const statement = db.driver.prepare<R>(sql);
      return {
        run: (params) => statement.run(params),
        get: (params) => statement.get(params),
        all: (params) => {
          const rows = statement.all(params);
          onAll({ sql, params });
          return rows;
        },
      };
    },
  };
  return { ...db, driver };
}

function manyEvents(w: World, total: number): void {
  w.db.driver.transaction(() => {
    for (let i = 0; i < total; i += 1) addEvent(w.db, w.s2, NOW - 4 * DAY + i);
  });
}

describe('keyset pages and back pressure', () => {
  it('reads each table in pages of 1,000 ids after the last id read', async () => {
    const w = openWorld(1, ID);
    manyEvents(w, 2300);
    const seen: Call[] = [];
    const { lines } = await runExport({ db: spied(w.db, (call) => seen.push(call)) }, { include: ['events'] });

    expect(ofType(lines, 'event')).toHaveLength(2313);
    const pages = seen.filter((call) => call.sql.includes('FROM events e WHERE e.id > :last'));
    expect(pages).toHaveLength(3);
    const asked = pages.map((call) => PageParamsSchema.parse(call.params));
    expect(asked.map((page) => page.limit)).toEqual([1000, 1000, 1000]);
    const lasts = asked.map((page) => page.last);
    expect(lasts[0]).toBe(0);
    expect(lasts[1]).toBeGreaterThan(lasts[0] ?? 0);
    expect(lasts[2]).toBeGreaterThan(lasts[1] ?? 0);
    // the ids come in ascending order across the pages
    const ids = ofType(lines, 'event').map((line) => line.data.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('waits for drain whenever the output is full, and keeps no more than one chunk in memory', async () => {
    const w = openWorld(1, ID);
    manyEvents(w, 3000);
    let drains = 0;
    let maxBuffered = 0;
    let written = 0;
    const slow = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        maxBuffered = Math.max(maxBuffered, slow.writableLength);
        // the sink completes later, like a socket: the buffer fills, `write` answers false and the export must wait
        setImmediate(done);
      },
    });
    slow.on('drain', () => {
      drains += 1;
    });

    const summary = await exportInstance(
      w.db,
      contextOf(ID),
      { include: ['events'] },
      slow,
      new AbortController().signal,
    );
    await new Promise<void>((resolve) => {
      slow.end(resolve);
    });

    expect(drains).toBeGreaterThan(5);
    // one chunk of at most 64 KiB plus the line that crossed the limit
    expect(maxBuffered).toBeLessThan(80 * 1024);
    expect(written).toBe(summary.bytes);
    expect(summary.counts['event']).toBe(3013);
  });

  it('does not write again while the output has not drained, and an abort ends the wait', async () => {
    const w = openWorld(1, ID);
    manyEvents(w, 3000);
    let writes = 0;
    // a sink that never drains: the first `write` says "full" and nothing ever follows
    const stuck = new Writable({
      highWaterMark: 1,
      write() {
        writes += 1;
      },
    });
    const controller = new AbortController();
    const running = exportInstance(w.db, contextOf(ID), { include: ['events'] }, stuck, controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => writes === 1);
    await turns();
    expect(writes).toBe(1);
    controller.abort();
    const stopped = await running;
    expect(stopped).toBeInstanceOf(Error);
    expect(stopped instanceof Error ? stopped.name : '').toBe('AbortError');
    expect(writes).toBe(1);
    stuck.destroy();
  });

  it('stops between two pages when the signal aborts, and the trailer is never written', async () => {
    const w = openWorld(1, ID);
    manyEvents(w, 2500);
    const controller = new AbortController();
    const out = new Collector();
    let pages = 0;
    const db = spied(w.db, (call) => {
      if (!call.sql.includes('FROM events e WHERE e.id > :last')) return;
      pages += 1;
      if (pages === 2) controller.abort();
    });

    const stopped = await exportInstance(db, contextOf(ID), { include: ['events'] }, out, controller.signal).then(
      () => null,
      (error: unknown) => error,
    );

    expect(stopped instanceof Error ? stopped.name : '').toBe('AbortError');
    expect(pages).toBe(2);
    expect(out.bytes().toString('utf8')).not.toContain('"type":"trailer"');
  });

  it('keeps going when a session is deleted between the page of ids and its rows, and the trailer counts what was written', async () => {
    const w = openWorld(1, ID);
    for (let n = 4; n <= 8; n += 1) addSession(w.db, 1, n);
    let sessionPages = 0;
    const db = spied(w.db, (call) => {
      if (!call.sql.includes('FROM sessions s WHERE s.id > :last')) return;
      sessionPages += 1;
      // after the ids of the first page were read, the third of them is deleted: its row is simply not found
      if (sessionPages === 1) w.db.driver.prepare('DELETE FROM sessions WHERE id = :id').run({ id: w.s3.id });
    });

    const out = new Collector();
    const summary = await exportInstance(
      db,
      contextOf(ID),
      { include: ['sessions'] },
      out,
      new AbortController().signal,
      {
        pageSize: 3,
      },
    );

    const lines = out
      .bytes()
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => ExportLineSchema.parse(JSON.parse(line)));
    const exported = ofType(lines, 'session').map((line) => line.data.id);
    expect(exported).not.toContain(w.s3.uid);
    expect(exported).toHaveLength(7);
    expect(summary.counts['session']).toBe(7);
    expect(ofType(lines, 'trailer')[0]?.counts).toEqual({ session: 7 });
  });

  it('pages of a smaller size give the same export', async () => {
    const w = openWorld(1, ID);
    manyEvents(w, 40);
    const whole = await runExport(w);
    const paged = await runExport(w, {}, {}, { pageSize: 3 });
    expect(paged.lines.map((line) => JSON.stringify(line))).toEqual(whole.lines.map((line) => JSON.stringify(line)));
    expect(paged.summary).toEqual(whole.summary);
  });

  it('keeps nothing of the export in memory: 200,000 rows need no more heap than a few pages', async () => {
    const w = openWorld(1, ID);
    manyEvents(w, 200_000);
    // the heap is read after a full collection, so that garbage that is not yet collected does not count
    setFlagsFromString('--expose-gc');
    const collector: unknown = runInNewContext('gc');
    const collect = (): void => {
      if (typeof collector === 'function') Reflect.apply(collector, undefined, []);
    };
    collect();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let chunks = 0;
    const discard = new Writable({
      write(_chunk: Buffer, _encoding, done) {
        chunks += 1;
        if (chunks % 25 === 0) {
          collect();
          peak = Math.max(peak, process.memoryUsage().heapUsed);
        }
        done();
      },
    });

    const summary = await exportInstance(
      w.db,
      contextOf(ID),
      { include: ['events'] },
      discard,
      new AbortController().signal,
    );

    expect(summary.counts['event']).toBe(200_013);
    // the export is about 90 MiB; what the heap held at any look is a small part of one page
    expect(summary.bytes).toBeGreaterThan(80 * 1024 * 1024);
    expect(chunks).toBeGreaterThan(1000);
    expect(peak - before).toBeLessThan(40 * 1024 * 1024);
  }, 180_000);

  it('writes to a file stream as well', async () => {
    const w = openWorld(1, ID);
    const file = path.join(w.dir, 'export.jsonl');
    const stream = createWriteStream(file);
    const summary = await exportInstance(w.db, contextOf(ID), {}, stream, new AbortController().signal);
    await new Promise<void>((resolve) => {
      stream.end(resolve);
    });
    expect(readFileSync(file).length).toBe(summary.bytes);
  });
});
