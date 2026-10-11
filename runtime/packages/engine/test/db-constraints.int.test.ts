import { makeTempDir, type TempDir } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlDriver } from '../src/db/driver.ts';
import { DbError, type DbConstraintKind } from '../src/db/errors.ts';
import { openInstanceDb, type InstanceDb } from '../src/db/open.ts';

// DA-T-DB-8 (the probes of [exp:X1, X12]) and the X14 probes of DA-T-DB-20, as table tests against the real 0001 schema.
// Every probe runs inside a transaction that is rolled back, so the seeded rows are the same for every probe. A rejected
// probe must fail with the expected kind of constraint: a typo in a probe would fail with db_io (SQLITE_ERROR) instead.

type Cell = string | number | null;
type Expect = 'accepted' | DbConstraintKind;
interface Probe {
  readonly label: string;
  readonly sql: string | readonly string[];
  readonly expect: Expect;
}

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_NEW = 'aaaaaaaa-0000-4000-8000-000000000099';
const H64 = 'a'.repeat(64);
const H32 = 'b'.repeat(32);
const UID36 = 'c'.repeat(36);

function literal(value: Cell): string {
  if (value === null) return 'NULL';
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

/** `INSERT INTO <table>` with the base columns overridden by `over`; a key set to `undefined` is dropped. */
function ins(
  table: string,
  base: Readonly<Record<string, Cell>>,
  over: Readonly<Record<string, Cell | undefined>> = {},
): string {
  const row = new Map<string, Cell>(Object.entries(base));
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) row.delete(key);
    else row.set(key, value);
  }
  const columns = [...row.keys()];
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => literal(row.get(column) ?? null)).join(', ')})`;
}

const BASE = {
  meta: { key: 'k-new', value: 'v' },
  projects: { project_key: 'p-new', dir_name: 'P', first_seen_at: 1, last_activity_at: 1 },
  sessions: { session_uid: S_NEW, first_seen_at: 1, started_at: 1, last_activity_at: 1, updated_at: 1 },
  workflow_runs: { session_id: 1, run_uid: 'wf_new', updated_at: 1 },
  agents: {
    session_id: 2,
    agent_uid: 'abc123def456aa0',
    parent_agent_id: 1,
    kind: 'subagent',
    depth: 1,
    first_seen_at: 1,
    started_at: 1,
    last_activity_at: 1,
    updated_at: 1,
  },
  turns: { session_id: 1, prompt_id: 'prompt-new' },
  transcript_files: { path: 'a', path_key: 'a-new', kind: 'session', session_uid: S1, discovered_at: 1, updated_at: 1 },
  transcript_checkpoints: { file_id: 1, entry_index: 5, byte_offset: 0 },
  tool_calls: { session_id: 1, agent_id: 1, tool_use_id: 'toolu_new', name: 'Bash', updated_at: 1 },
  events: {
    session_id: 1,
    kind: 'tool.call',
    sources: 1,
    ts: 1,
    ts_source: 'record',
    received_at: 1,
    natural_key: 'nk-new',
  },
  entry_occurrences: { file_id: 1, byte_offset: 9, record_uuid: 'rec-1' },
  usage_files: { file_id: 1, message_key: 'msg-new' },
  usage: {
    message_key: 'msg-new',
    session_id: 1,
    agent_id: 1,
    owner_file_id: 1,
    model: 'm',
    ts: 1,
    finalized: 0,
    usage_source: 'top',
    updated_at: 1,
  },
  cost_states: { file_id: 9, session_id: 1, byte_offset: 0, observed_at: 1 },
  state_transitions: { session_id: 1, to_state: 'working', rule: 'R1', basis: 'observed', confidence: 'high', at: 1 },
  reconciliations: { scope_key: 'instance', kind: 'hook_gap', at: 1, detail_hash: H32 },
  external_observations: { session_id: 1, source: 'pid', observed_at: 1, value_json: '{}' },
  hook_probes: { probe_session_id: UID36, received_at: 1, committed_at: 1 },
  work_items: {
    item_key: 'label:new',
    kind: 'label',
    title: 't',
    state: 'working',
    rule: 'W-LBL',
    board_reason: '2',
    state_since: 1,
    created_at: 1,
    updated_at: 1,
  },
  work_item_sessions: { work_item_id: 1, session_id: 1, linked_at: 1 },
  ingest_health: { id: 1, evaluated_at: 1, status: 'ok', updated_at: 1 },
  ingest_errors: { at: 1, source: 'spool', code: 'E_X' },
  spool_cursors: { segment: 'hooks-20261011T05Z.ndjson', first_seen_at: 1, updated_at: 1 },
  attempt_sources: {
    path: 'D:/r/chain.log',
    path_key: 'pk-new',
    head_len: 10,
    head_hash: H64,
    config_sha256: H64,
    updated_at: 1,
  },
  attempt_runs: {
    source_id: 1,
    generation: 1,
    start_offset: 7000,
    part: 'S1',
    started_at: 1000,
    evidence: 'e',
    updated_at: 1,
  },
  alerts: {
    rule_id: 'inactivity',
    rule_kind: 'inactivity',
    scope_kind: 'session',
    scope_key: S1,
    severity: 'warning',
    status: 'open',
    title: 't',
    first_fired_at: 1,
    last_fired_at: 1,
  },
  alert_state: { rule_id: 'r', scope_key: 'k', last_evaluated_at: 1 },
  changes: { at: 1, kind: 'health', op: 'upsert' },
} as const satisfies Record<string, Readonly<Record<string, Cell>>>;

type Table = keyof typeof BASE;

function row(table: Table, over: Readonly<Record<string, Cell | undefined>> = {}): string {
  return ins(table, BASE[table], over);
}

/** Rows every probe can point at; ids are the first rows of their tables. */
const SEED: readonly string[] = [
  ins('projects', BASE.projects, { project_key: 'd--mvp', dir_name: 'D--mvp' }),
  ins('sessions', BASE.sessions, { session_uid: S1, project_id: 1 }),
  ins('sessions', BASE.sessions, { session_uid: S2 }),
  ins('agents', BASE.agents, { session_id: 1, agent_uid: 'main', parent_agent_id: null, kind: 'main', depth: 0 }),
  ins('turns', BASE.turns, { prompt_id: 'prompt-fixture' }),
  ins('transcript_files', BASE.transcript_files, { path: 'f1', path_key: 'f1' }),
  ins('tool_calls', BASE.tool_calls, { tool_use_id: 'toolu_A' }),
  ins('events', BASE.events, { event_uid: UID36, natural_key: 'nk-1', record_uuid: 'rec-fixture' }),
  ins('entry_occurrences', BASE.entry_occurrences, { byte_offset: 1 }),
  ins('usage_files', BASE.usage_files, { message_key: 'msg-fixture' }),
  ins('usage', BASE.usage, { message_key: 'msg-fixture' }),
  ins('cost_states', BASE.cost_states, { file_id: 1 }),
  ins('reconciliations', BASE.reconciliations, { kind: 'runtime_unavailable' }),
  ins('external_observations', BASE.external_observations, { source: 'registry' }),
  ins('hook_probes', BASE.hook_probes, {}),
  ins('work_items', BASE.work_items, { item_key: 'label:a' }),
  ins('ingest_health', BASE.ingest_health, {}),
  ins('spool_cursors', BASE.spool_cursors, { segment: 'hooks-20261011T04Z.ndjson' }),
  ins('attempt_sources', BASE.attempt_sources, { path_key: 'pk-fixture' }),
  ins('attempt_runs', BASE.attempt_runs, { start_offset: 0 }),
  ins('alerts', BASE.alerts, {}),
  ins('alert_state', BASE.alert_state, {}),
  ins('transcript_checkpoints', BASE.transcript_checkpoints, { entry_index: 0 }),
];

const long = (length: number, char = 'x'): string => char.repeat(length);

const PROBES: Readonly<Record<string, readonly Probe[]>> = {
  meta: [
    { label: 'a new key', sql: row('meta'), expect: 'accepted' },
    { label: 'empty key', sql: row('meta', { key: '' }), expect: 'check' },
    { label: 'key of 65 characters', sql: row('meta', { key: long(65) }), expect: 'check' },
    { label: 'value of 4097 characters', sql: row('meta', { value: long(4097) }), expect: 'check' },
    { label: 'value of 4096 characters', sql: row('meta', { value: long(4096) }), expect: 'accepted' },
    { label: 'duplicate key', sql: row('meta', { key: 'instance_id' }), expect: 'unique' },
    { label: 'NULL value', sql: row('meta', { value: null }), expect: 'notnull' },
  ],
  projects: [
    { label: 'a new project', sql: row('projects'), expect: 'accepted' },
    { label: 'project_key in upper case', sql: row('projects', { project_key: 'D--mvp' }), expect: 'check' },
    { label: 'duplicate project_key', sql: row('projects', { project_key: 'd--mvp' }), expect: 'unique' },
    { label: 'empty dir_name', sql: row('projects', { dir_name: '' }), expect: 'check' },
    { label: 'root_path of 1025 characters', sql: row('projects', { root_path: long(1025) }), expect: 'check' },
    {
      label: 'text in an INTEGER column (STRICT)',
      sql: row('projects', { first_seen_at: 'yesterday' }),
      expect: 'datatype',
    },
  ],
  sessions: [
    { label: 'a new session', sql: row('sessions'), expect: 'accepted' },
    { label: 'unknown state', sql: row('sessions', { state: 'bogus' }), expect: 'check' },
    { label: 'session_uid in upper case', sql: row('sessions', { session_uid: S_NEW.toUpperCase() }), expect: 'check' },
    { label: 'session_uid of 35 characters', sql: row('sessions', { session_uid: S_NEW.slice(1) }), expect: 'check' },
    { label: 'duplicate session_uid', sql: row('sessions', { session_uid: S1 }), expect: 'unique' },
    { label: 'project that does not exist', sql: row('sessions', { project_id: 999 }), expect: 'foreignkey' },
    {
      label: 'last activity before the start',
      sql: row('sessions', { started_at: 10, last_activity_at: 5 }),
      expect: 'check',
    },
    {
      label: 'end before the start',
      sql: row('sessions', { started_at: 10, last_activity_at: 10, ended_at: 5 }),
      expect: 'check',
    },
    { label: 'label of 201 characters', sql: row('sessions', { label: long(201) }), expect: 'check' },
    { label: 'unknown label_source', sql: row('sessions', { label_source: 'x' }), expect: 'check' },
    { label: 'title_ai of 121 characters', sql: row('sessions', { title_ai: long(121) }), expect: 'check' },
    { label: 'models that is JSON but not an array', sql: row('sessions', { models: '{}' }), expect: 'check' },
    { label: 'facts_json that is not JSON', sql: row('sessions', { facts_json: '{bad' }), expect: 'check' },
    { label: 'matched = 2', sql: row('sessions', { matched: 2 }), expect: 'check' },
    { label: 'negative event_count', sql: row('sessions', { event_count: -1 }), expect: 'check' },
    { label: 'negative tok_input', sql: row('sessions', { tok_input: -1 }), expect: 'check' },
    { label: 'unknown hook_coverage', sql: row('sessions', { hook_coverage: 'x' }), expect: 'check' },
    { label: 'unknown usage_status', sql: row('sessions', { usage_status: 'bogus' }), expect: 'check' },
    { label: 'claude_pid 0', sql: row('sessions', { claude_pid: 0 }), expect: 'check' },
    { label: 'negative reported cost', sql: row('sessions', { reported_cost_usd: -1 }), expect: 'check' },
    { label: 'state_rule of 17 characters', sql: row('sessions', { state_rule: long(17) }), expect: 'check' },
    { label: 'unknown wait_reason', sql: row('sessions', { wait_reason: 'bogus' }), expect: 'check' },
  ],
  workflow_runs: [
    { label: 'a new run', sql: row('workflow_runs'), expect: 'accepted' },
    { label: 'run_uid without the wf_ prefix', sql: row('workflow_runs', { run_uid: 'run_new' }), expect: 'check' },
    {
      label: 'run in a session that does not exist',
      sql: row('workflow_runs', { session_id: 999 }),
      expect: 'foreignkey',
    },
    { label: 'the same run twice', sql: [row('workflow_runs'), row('workflow_runs')], expect: 'unique' },
  ],
  agents: [
    { label: 'a subagent', sql: row('agents'), expect: 'accepted' },
    {
      label: 'an internal agent with a parent (internal agents are kept)',
      sql: row('agents', { kind: 'internal' }),
      expect: 'accepted',
    },
    {
      label: 'a main agent',
      sql: row('agents', { agent_uid: 'main', parent_agent_id: null, kind: 'main', depth: 0 }),
      expect: 'accepted',
    },
    {
      label: 'main agent with a parent',
      sql: row('agents', { agent_uid: 'main', kind: 'main', depth: 0 }),
      expect: 'check',
    },
    {
      label: 'main agent at depth 1',
      sql: row('agents', { agent_uid: 'main', parent_agent_id: null, kind: 'main' }),
      expect: 'check',
    },
    { label: 'subagent at depth 0', sql: row('agents', { depth: 0 }), expect: 'check' },
    { label: "agent_uid 'main' of another kind", sql: row('agents', { agent_uid: 'main' }), expect: 'check' },
    { label: 'agent_uid with a slash', sql: row('agents', { agent_uid: 'a/b/c' }), expect: 'check' },
    { label: 'agent_uid of 2 characters', sql: row('agents', { agent_uid: 'ab' }), expect: 'check' },
    { label: 'unknown kind', sql: row('agents', { kind: 'bogus' }), expect: 'check' },
    { label: 'depth 17', sql: row('agents', { depth: 17 }), expect: 'check' },
    {
      label: 'second main agent of a session',
      sql: row('agents', { session_id: 1, agent_uid: 'main', parent_agent_id: null, kind: 'main', depth: 0 }),
      expect: 'unique',
    },
    { label: 'session that does not exist', sql: row('agents', { session_id: 999 }), expect: 'foreignkey' },
    { label: 'unknown request_shape', sql: row('agents', { request_shape: 'bogus' }), expect: 'check' },
  ],
  turns: [
    { label: 'a new turn', sql: row('turns'), expect: 'accepted' },
    { label: 'duplicate (session, prompt)', sql: row('turns', { prompt_id: 'prompt-fixture' }), expect: 'unique' },
    { label: 'start after end', sql: row('turns', { started_at: 10, ended_at: 5 }), expect: 'check' },
    { label: 'unknown end_kind', sql: row('turns', { end_kind: 'bogus' }), expect: 'check' },
    { label: 'empty prompt_id', sql: row('turns', { prompt_id: '' }), expect: 'check' },
  ],
  transcript_files: [
    { label: 'a new file', sql: row('transcript_files'), expect: 'accepted' },
    {
      label: 'cursors out of order (head_end after backfill_offset)',
      sql: row('transcript_files', {
        head_end: 10,
        backfill_offset: 5,
        tail_start: 20,
        tail_offset: 30,
        size_seen: 40,
      }),
      expect: 'check',
    },
    {
      label: 'tail beyond the size while active',
      sql: row('transcript_files', { tail_offset: 50, size_seen: 40 }),
      expect: 'check',
    },
    {
      label: 'tail beyond the size once the file is missing',
      sql: row('transcript_files', { tail_offset: 50, size_seen: 40, state: 'missing' }),
      expect: 'accepted',
    },
    { label: 'head_hash of 2 characters', sql: row('transcript_files', { head_hash: 'ab' }), expect: 'check' },
    { label: 'head_len 300', sql: row('transcript_files', { head_len: 300 }), expect: 'check' },
    { label: 'unknown kind', sql: row('transcript_files', { kind: 'bogus' }), expect: 'check' },
    { label: 'unknown state', sql: row('transcript_files', { state: 'bogus' }), expect: 'check' },
    { label: 'duplicate path_key', sql: row('transcript_files', { path_key: 'f1' }), expect: 'unique' },
    {
      label: 'session_uid of 35 characters',
      sql: row('transcript_files', { session_uid: S1.slice(1) }),
      expect: 'check',
    },
    { label: 'negative invalid_json counter', sql: row('transcript_files', { invalid_json: -1 }), expect: 'check' },
  ],
  transcript_checkpoints: [
    { label: 'a new checkpoint', sql: row('transcript_checkpoints'), expect: 'accepted' },
    {
      label: 'duplicate (file, entry_index)',
      sql: row('transcript_checkpoints', { entry_index: 0 }),
      expect: 'unique',
    },
    { label: 'negative entry_index', sql: row('transcript_checkpoints', { entry_index: -1 }), expect: 'check' },
    { label: 'negative byte_offset', sql: row('transcript_checkpoints', { byte_offset: -1 }), expect: 'check' },
  ],
  tool_calls: [
    { label: 'a new call', sql: row('tool_calls'), expect: 'accepted' },
    {
      label: 'a finished call with an outcome',
      sql: row('tool_calls', { outcome: 'ok', ended_at: 5 }),
      expect: 'accepted',
    },
    { label: 'an outcome without ended_at', sql: row('tool_calls', { outcome: 'ok' }), expect: 'check' },
    { label: 'unknown outcome', sql: row('tool_calls', { outcome: 'weird', ended_at: 5 }), expect: 'check' },
    { label: 'duplicate tool_use_id', sql: row('tool_calls', { tool_use_id: 'toolu_A' }), expect: 'unique' },
    { label: 'sources 32', sql: row('tool_calls', { sources: 32 }), expect: 'check' },
    { label: 'sources 31', sql: row('tool_calls', { sources: 31 }), expect: 'accepted' },
    { label: 'negative duration', sql: row('tool_calls', { duration_ms: -1 }), expect: 'check' },
    { label: 'unknown duration_source', sql: row('tool_calls', { duration_source: 'bogus' }), expect: 'check' },
    { label: 'session that does not exist', sql: row('tool_calls', { session_id: 999 }), expect: 'foreignkey' },
    { label: 'summary of 161 characters', sql: row('tool_calls', { summary: long(161) }), expect: 'check' },
  ],
  events: [
    { label: 'a new event', sql: row('events'), expect: 'accepted' },
    {
      label: 'two events without event_uid (the unique index is partial)',
      sql: [row('events', { natural_key: 'nk-a' }), row('events', { natural_key: 'nk-b' })],
      expect: 'accepted',
    },
    { label: 'no key at all', sql: row('events', { natural_key: undefined }), expect: 'check' },
    {
      label: 'only a record_uuid',
      sql: row('events', { natural_key: undefined, record_uuid: 'rec-x' }),
      expect: 'accepted',
    },
    { label: 'kind with a space and capitals', sql: row('events', { kind: 'Tool Call' }), expect: 'check' },
    { label: 'kind of 2 characters', sql: row('events', { kind: 'ab' }), expect: 'check' },
    { label: 'kind with a digit', sql: row('events', { kind: 'tool.call2' }), expect: 'check' },
    { label: 'kind without a dot', sql: row('events', { kind: 'toolcall' }), expect: 'check' },
    { label: 'detail that is not JSON', sql: row('events', { detail: '{bad' }), expect: 'check' },
    {
      label: 'detail of 16385 characters',
      sql: row('events', { detail: JSON.stringify(long(16383)) }),
      expect: 'check',
    },
    {
      label: 'detail of 16384 characters',
      sql: row('events', { detail: JSON.stringify(long(16382)) }),
      expect: 'accepted',
    },
    { label: 'file_id without byte_offset', sql: row('events', { file_id: 1 }), expect: 'check' },
    {
      label: 'file_id with byte_offset',
      sql: row('events', { file_id: 1, byte_offset: 10, byte_length: 5 }),
      expect: 'accepted',
    },
    { label: 'byte_length 0', sql: row('events', { file_id: 1, byte_offset: 10, byte_length: 0 }), expect: 'check' },
    { label: 'sources 8', sql: row('events', { sources: 8 }), expect: 'check' },
    { label: 'sources 0', sql: row('events', { sources: 0 }), expect: 'check' },
    { label: 'severity 3', sql: row('events', { severity: 3 }), expect: 'check' },
    { label: 'ts_rank 100', sql: row('events', { ts_rank: 100 }), expect: 'check' },
    { label: 'unknown ts_source', sql: row('events', { ts_source: 'bogus' }), expect: 'check' },
    { label: 'unknown entry_kind', sql: row('events', { entry_kind: 'bogus' }), expect: 'check' },
    { label: 'event_uid of 35 characters', sql: row('events', { event_uid: UID36.slice(1) }), expect: 'check' },
    { label: 'content_hash of 31 characters', sql: row('events', { content_hash: H32.slice(1) }), expect: 'check' },
    { label: 'duplicate event_uid', sql: row('events', { natural_key: 'nk-z', event_uid: UID36 }), expect: 'unique' },
    { label: 'duplicate natural_key', sql: row('events', { natural_key: 'nk-1' }), expect: 'unique' },
    {
      label: 'duplicate record_uuid',
      sql: row('events', { natural_key: undefined, record_uuid: 'rec-fixture' }),
      expect: 'unique',
    },
    { label: 'session that does not exist', sql: row('events', { session_id: 999 }), expect: 'foreignkey' },
    { label: 'text in the ts column (STRICT)', sql: row('events', { ts: 'yesterday' }), expect: 'datatype' },
    { label: 'summary of 241 characters', sql: row('events', { summary: long(241) }), expect: 'check' },
    { label: 'negative change_seq', sql: row('events', { change_seq: -1 }), expect: 'check' },
  ],
  entry_occurrences: [
    { label: 'a new occurrence', sql: row('entry_occurrences'), expect: 'accepted' },
    { label: 'duplicate (file, offset)', sql: row('entry_occurrences', { byte_offset: 1 }), expect: 'unique' },
    { label: 'empty record_uuid', sql: row('entry_occurrences', { record_uuid: '' }), expect: 'check' },
  ],
  usage_files: [
    { label: 'a row with missing values (NULL = missing)', sql: row('usage_files'), expect: 'accepted' },
    { label: 'negative input_tokens', sql: row('usage_files', { input_tokens: -1 }), expect: 'check' },
    { label: 'finalized 2', sql: row('usage_files', { finalized: 2 }), expect: 'check' },
    { label: 'empty message_key', sql: row('usage_files', { message_key: '' }), expect: 'check' },
    { label: 'unknown usage_source', sql: row('usage_files', { usage_source: 'bogus' }), expect: 'check' },
    { label: 'record_count 0', sql: row('usage_files', { record_count: 0 }), expect: 'check' },
    {
      label: 'duplicate (file, message_key)',
      sql: row('usage_files', { message_key: 'msg-fixture' }),
      expect: 'unique',
    },
  ],
  usage: [
    { label: 'a new message', sql: row('usage'), expect: 'accepted' },
    { label: 'duplicate message_key', sql: row('usage', { message_key: 'msg-fixture' }), expect: 'unique' },
    { label: 'owner session that does not exist', sql: row('usage', { session_id: 999 }), expect: 'foreignkey' },
    { label: 'files 0', sql: row('usage', { files: 0 }), expect: 'check' },
    { label: 'empty model', sql: row('usage', { model: '' }), expect: 'check' },
    { label: 'negative output_tokens', sql: row('usage', { output_tokens: -1 }), expect: 'check' },
    { label: 'NULL finalized', sql: row('usage', { finalized: null }), expect: 'notnull' },
  ],
  cost_states: [
    { label: 'a new cost state', sql: row('cost_states'), expect: 'accepted' },
    { label: 'negative cost', sql: row('cost_states', { total_cost_usd: -1 }), expect: 'check' },
    { label: 'session that does not exist', sql: row('cost_states', { session_id: 999 }), expect: 'foreignkey' },
    { label: 'model_usage_json that is not JSON', sql: row('cost_states', { model_usage_json: 'x' }), expect: 'check' },
    { label: 'second state for one file', sql: row('cost_states', { file_id: 1 }), expect: 'unique' },
  ],
  state_transitions: [
    { label: 'a new transition', sql: row('state_transitions'), expect: 'accepted' },
    { label: 'unknown basis', sql: row('state_transitions', { basis: 'bogus' }), expect: 'check' },
    { label: 'unknown confidence', sql: row('state_transitions', { confidence: 'bogus' }), expect: 'check' },
    { label: 'empty rule', sql: row('state_transitions', { rule: '' }), expect: 'check' },
    { label: 'session that does not exist', sql: row('state_transitions', { session_id: 999 }), expect: 'foreignkey' },
  ],
  reconciliations: [
    { label: 'another kind for the same scope', sql: row('reconciliations'), expect: 'accepted' },
    {
      label: 'the same (scope, kind, hash) twice',
      sql: row('reconciliations', { kind: 'runtime_unavailable' }),
      expect: 'unique',
    },
    { label: 'unknown kind', sql: row('reconciliations', { kind: 'bogus' }), expect: 'check' },
    {
      label: 'detail_hash of 31 characters',
      sql: row('reconciliations', { detail_hash: H32.slice(1) }),
      expect: 'check',
    },
    { label: 'session that does not exist', sql: row('reconciliations', { session_id: 999 }), expect: 'foreignkey' },
    { label: 'detail that is not JSON', sql: row('reconciliations', { detail: 'x' }), expect: 'check' },
  ],
  external_observations: [
    { label: 'a new source', sql: row('external_observations'), expect: 'accepted' },
    { label: 'unknown source', sql: row('external_observations', { source: 'bogus' }), expect: 'check' },
    {
      label: 'second observation of a source (latest only)',
      sql: row('external_observations', { source: 'registry' }),
      expect: 'unique',
    },
    { label: 'value_json that is not JSON', sql: row('external_observations', { value_json: 'x' }), expect: 'check' },
  ],
  hook_probes: [
    { label: 'another probe', sql: row('hook_probes', { probe_session_id: 'd'.repeat(36) }), expect: 'accepted' },
    {
      label: 'probe id of 35 characters',
      sql: row('hook_probes', { probe_session_id: 'd'.repeat(35) }),
      expect: 'check',
    },
    { label: 'the same probe twice', sql: row('hook_probes'), expect: 'unique' },
  ],
  work_items: [
    { label: 'a new item', sql: row('work_items'), expect: 'accepted' },
    { label: 'unknown kind', sql: row('work_items', { kind: 'bogus' }), expect: 'check' },
    { label: 'unknown rule', sql: row('work_items', { rule: 'W-X' }), expect: 'check' },
    { label: "state 'running' is not a board state", sql: row('work_items', { state: 'running' }), expect: 'check' },
    { label: 'duplicate item_key', sql: row('work_items', { item_key: 'label:a' }), expect: 'unique' },
    { label: 'empty title', sql: row('work_items', { title: '' }), expect: 'check' },
    { label: 'item_key of 2 characters', sql: row('work_items', { item_key: 'ab' }), expect: 'check' },
  ],
  work_item_sessions: [
    { label: 'a session joins an item', sql: row('work_item_sessions'), expect: 'accepted' },
    {
      label: 'a session in two items',
      sql: [
        row('work_items', { item_key: 'label:b' }),
        row('work_item_sessions'),
        row('work_item_sessions', { work_item_id: 2 }),
      ],
      expect: 'unique',
    },
    { label: 'item that does not exist', sql: row('work_item_sessions', { work_item_id: 999 }), expect: 'foreignkey' },
    { label: 'session that does not exist', sql: row('work_item_sessions', { session_id: 999 }), expect: 'foreignkey' },
  ],
  ingest_health: [
    {
      label: 'the one row, replaced',
      sql: `INSERT OR REPLACE INTO ingest_health (id, evaluated_at, status, updated_at) VALUES (1, 2, 'degraded', 2)`,
      expect: 'accepted',
    },
    { label: 'a second row (id 2)', sql: row('ingest_health', { id: 2 }), expect: 'check' },
    { label: 'unknown status', sql: row('ingest_health', { id: 1, status: 'bogus' }), expect: 'check' },
    { label: 'the same id twice', sql: row('ingest_health'), expect: 'unique' },
    {
      label: 'report_json that is not JSON',
      sql: `UPDATE ingest_health SET report_json = 'x' WHERE id = 1`,
      expect: 'check',
    },
  ],
  ingest_errors: [
    { label: 'a new error', sql: row('ingest_errors'), expect: 'accepted' },
    { label: 'code in lower case', sql: row('ingest_errors', { code: 'e_x' }), expect: 'check' },
    { label: 'empty code', sql: row('ingest_errors', { code: '' }), expect: 'check' },
    { label: 'unknown source', sql: row('ingest_errors', { source: 'bogus' }), expect: 'check' },
    { label: 'session_uid of 35 characters', sql: row('ingest_errors', { session_uid: S1.slice(1) }), expect: 'check' },
    { label: 'detail of 201 characters', sql: row('ingest_errors', { detail: long(201) }), expect: 'check' },
  ],
  spool_cursors: [
    { label: 'an .ndjson segment', sql: row('spool_cursors'), expect: 'accepted' },
    {
      label: 'a .jsonl segment (X14)',
      sql: row('spool_cursors', { segment: 'hooks-20261011T05Z.jsonl' }),
      expect: 'check',
    },
    { label: 'path traversal', sql: row('spool_cursors', { segment: '../x.ndjson' }), expect: 'check' },
    { label: 'a slash', sql: row('spool_cursors', { segment: 'a/bcdefg.ndjson' }), expect: 'check' },
    { label: 'a backslash', sql: row('spool_cursors', { segment: 'a\\bcdefg.ndjson' }), expect: 'check' },
    { label: 'a colon', sql: row('spool_cursors', { segment: 'a:bcdefg.ndjson' }), expect: 'check' },
    {
      label: 'offset beyond the size seen',
      sql: row('spool_cursors', { offset_bytes: 5, size_seen: 0 }),
      expect: 'check',
    },
    { label: 'sealed 2', sql: row('spool_cursors', { sealed: 2 }), expect: 'check' },
    {
      label: 'the same segment twice',
      sql: row('spool_cursors', { segment: 'hooks-20261011T04Z.ndjson' }),
      expect: 'unique',
    },
    { label: 'head_hash of 2 characters', sql: row('spool_cursors', { head_hash: 'ab' }), expect: 'check' },
  ],
  attempt_sources: [
    { label: 'a source (X14)', sql: row('attempt_sources'), expect: 'accepted' },
    { label: 'duplicate path_key (X14)', sql: row('attempt_sources', { path_key: 'pk-fixture' }), expect: 'unique' },
    { label: 'head_len 300 (X14)', sql: row('attempt_sources', { head_len: 300 }), expect: 'check' },
    { label: 'short head hash (X14)', sql: row('attempt_sources', { head_hash: 'ab' }), expect: 'check' },
    { label: 'short config hash', sql: row('attempt_sources', { config_sha256: 'ab' }), expect: 'check' },
    { label: 'generation 0', sql: row('attempt_sources', { generation: 0 }), expect: 'check' },
    { label: 'empty path', sql: row('attempt_sources', { path: '' }), expect: 'check' },
    { label: 'negative read_offset', sql: row('attempt_sources', { read_offset: -1 }), expect: 'check' },
  ],
  attempt_runs: [
    { label: 'an open run (X14)', sql: row('attempt_runs'), expect: 'accepted' },
    {
      label: 'the same natural key again as a plain insert (X14)',
      sql: row('attempt_runs', { start_offset: 0 }),
      expect: 'unique',
    },
    {
      label: 'the same natural key again with ON CONFLICT DO NOTHING: no row, no error (X14)',
      sql: `${row('attempt_runs', { start_offset: 0 })} ON CONFLICT (source_id, generation, start_offset) DO NOTHING`,
      expect: 'accepted',
    },
    { label: 'an open row that is not RUNNING (X14)', sql: row('attempt_runs', { state: 'FAILED' }), expect: 'check' },
    {
      label: 'ended without ended_at (X14)',
      sql: row('attempt_runs', { end_reason: 'ended', state: 'FAILED', end_offset: 9000 }),
      expect: 'check',
    },
    {
      label: 'ended with its end (X14)',
      sql: row('attempt_runs', {
        end_reason: 'ended',
        state: 'COMPLETED',
        end_offset: 9000,
        ended_at: 1500,
        exit_raw: '0',
        status_raw: 'PASS',
      }),
      expect: 'accepted',
    },
    {
      label: 'superseded (X14)',
      sql: row('attempt_runs', { end_reason: 'superseded', state: 'UNKNOWN' }),
      expect: 'accepted',
    },
    {
      label: 'end_offset before the start (X14)',
      sql: row('attempt_runs', { end_reason: 'ended', state: 'COMPLETED', end_offset: 100, ended_at: 1500 }),
      expect: 'check',
    },
    { label: 'match delta without a session (X14)', sql: row('attempt_runs', { match_delta_ms: 10 }), expect: 'check' },
    {
      label: 'matched to a session with its delta (X14)',
      sql: row('attempt_runs', { session_id: 1, match_delta_ms: 10 }),
      expect: 'accepted',
    },
    {
      label: 'unknown state DONE (X14)',
      sql: row('attempt_runs', { end_reason: 'superseded', state: 'DONE' }),
      expect: 'check',
    },
    { label: 'part of 513 characters (X14)', sql: row('attempt_runs', { part: long(513) }), expect: 'check' },
    { label: 'part of 512 characters', sql: row('attempt_runs', { part: long(512) }), expect: 'accepted' },
    { label: 'empty part (absent group, legacy)', sql: row('attempt_runs', { part: '' }), expect: 'accepted' },
    {
      label: 'empty model (stored as NULL by the repository)',
      sql: row('attempt_runs', { model: '' }),
      expect: 'check',
    },
    { label: 'effort of 65 characters', sql: row('attempt_runs', { effort: long(65) }), expect: 'check' },
    { label: 'n_raw of 65 characters', sql: row('attempt_runs', { n_raw: long(65) }), expect: 'check' },
    { label: 'exit_raw of 65 characters', sql: row('attempt_runs', { exit_raw: long(65) }), expect: 'check' },
    { label: 'status_raw of 513 characters', sql: row('attempt_runs', { status_raw: long(513) }), expect: 'check' },
    { label: 'empty evidence', sql: row('attempt_runs', { evidence: '' }), expect: 'check' },
    { label: 'evidence of 1025 characters', sql: row('attempt_runs', { evidence: long(1025) }), expect: 'check' },
    { label: 'unknown end_reason', sql: row('attempt_runs', { end_reason: 'bogus' }), expect: 'check' },
    { label: 'generation 0', sql: row('attempt_runs', { generation: 0 }), expect: 'check' },
  ],
  alerts: [
    { label: 'an open alert of another scope', sql: row('alerts', { scope_key: S2 }), expect: 'accepted' },
    { label: 'a second open alert for the same rule and scope', sql: row('alerts'), expect: 'unique' },
    {
      label: 'two resolved alerts for the same rule and scope',
      sql: [
        row('alerts', { status: 'resolved', resolved_at: 5 }),
        row('alerts', { status: 'resolved', resolved_at: 6 }),
      ],
      expect: 'accepted',
    },
    {
      label: 'resolved without resolved_at',
      sql: row('alerts', { scope_key: S2, status: 'resolved' }),
      expect: 'check',
    },
    { label: 'open with resolved_at', sql: row('alerts', { scope_key: S2, resolved_at: 5 }), expect: 'check' },
    { label: 'unknown severity', sql: row('alerts', { scope_key: S2, severity: 'info' }), expect: 'check' },
    { label: 'unknown rule_kind', sql: row('alerts', { scope_key: S2, rule_kind: 'bogus' }), expect: 'check' },
    { label: 'unknown scope_kind', sql: row('alerts', { scope_key: S2, scope_kind: 'bogus' }), expect: 'check' },
    {
      label: 'last fired before the first',
      sql: row('alerts', { scope_key: S2, first_fired_at: 10, last_fired_at: 5 }),
      expect: 'check',
    },
    { label: 'fire_count 0', sql: row('alerts', { scope_key: S2, fire_count: 0 }), expect: 'check' },
    {
      label: 'unknown resolved_reason',
      sql: row('alerts', { scope_key: S2, status: 'resolved', resolved_at: 5, resolved_reason: 'bogus' }),
      expect: 'check',
    },
    {
      label: 'session that does not exist',
      sql: row('alerts', { scope_key: S2, session_id: 999 }),
      expect: 'foreignkey',
    },
  ],
  alert_state: [
    { label: 'another scope', sql: row('alert_state', { scope_key: 'k2' }), expect: 'accepted' },
    { label: 'the same (rule, scope) twice', sql: row('alert_state'), expect: 'unique' },
    { label: 'empty rule_id', sql: row('alert_state', { rule_id: '' }), expect: 'check' },
  ],
  changes: [
    { label: 'attempt/upsert (X14)', sql: row('changes', { kind: 'attempt', op: 'upsert' }), expect: 'accepted' },
    { label: 'attempt/delete (X14)', sql: row('changes', { kind: 'attempt', op: 'delete' }), expect: 'check' },
    { label: 'event/upsert', sql: row('changes', { kind: 'event', op: 'upsert' }), expect: 'check' },
    { label: 'session/append', sql: row('changes', { kind: 'session', op: 'append' }), expect: 'check' },
    { label: 'health/invalidate', sql: row('changes', { kind: 'health', op: 'invalidate' }), expect: 'check' },
    { label: 'a config kind (there is none)', sql: row('changes', { kind: 'config', op: 'upsert' }), expect: 'check' },
    { label: 'an unknown op', sql: row('changes', { op: 'bogus' }), expect: 'check' },
    { label: 'payload that is not JSON', sql: row('changes', { payload: '{bad' }), expect: 'check' },
    {
      label: 'payload of 2049 characters',
      sql: row('changes', { payload: JSON.stringify({ x: long(2041) }) }),
      expect: 'check',
    },
    {
      label: 'payload of 2048 characters',
      sql: row('changes', { payload: JSON.stringify({ x: long(2040) }) }),
      expect: 'accepted',
    },
    { label: 'session_uid of 35 characters', sql: row('changes', { session_uid: S1.slice(1) }), expect: 'check' },
    {
      label: 'explicit seq reuse',
      sql: [row('changes'), `INSERT INTO changes (seq, at, kind, op) VALUES (1, 1, 'health', 'upsert')`],
      expect: 'unique',
    },
  ],
};

const ALL_PAIRS: readonly (readonly [string, string])[] = [
  ['session', 'upsert'],
  ['session', 'delete'],
  ['agent', 'upsert'],
  ['workflow', 'upsert'],
  ['tool_call', 'upsert'],
  ['event', 'append'],
  ['transcript', 'append'],
  ['work_item', 'upsert'],
  ['usage', 'invalidate'],
  ['alert', 'upsert'],
  ['health', 'upsert'],
  ['attempt', 'upsert'],
];

class Rollback extends Error {}

/** Runs the statements in one transaction and always rolls it back; reports how the last statement fared. */
function attempt(
  db: SqlDriver,
  statements: readonly string[],
): { accepted: true } | { accepted: false; error: DbError } {
  try {
    db.transaction(() => {
      for (const statement of statements) db.exec(statement);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return { accepted: true };
    if (error instanceof DbError) return { accepted: false, error };
    throw error;
  }
  throw new Error('unreachable');
}

function describeOutcome(outcome: ReturnType<typeof attempt>): string {
  return outcome.accepted
    ? 'accepted'
    : outcome.error.code === 'db_constraint'
      ? (outcome.error.constraint ?? 'other')
      : `${outcome.error.code} ${outcome.error.sqliteCode ?? ''}`.trim();
}

let temp: TempDir;
let instance: InstanceDb;

beforeAll(() => {
  temp = makeTempDir('constraints');
  instance = openInstanceDb({
    path: `${temp.path}/monitor.db`,
    expectedInstanceId: '11111111-1111-4111-8111-111111111111',
    mode: 'serve',
    runtimeVersion: '3.0.0',
  });
  for (const statement of SEED) instance.driver.exec(statement);
});

afterAll(() => {
  instance.close();
  temp.remove();
});

describe('DA-T-DB-8, DA-T-DB-20: constraint probes against the real schema', () => {
  for (const [table, probes] of Object.entries(PROBES)) {
    it(`${table}: ${String(probes.length)} probes behave`, () => {
      const mismatches = probes
        .map((probe) => {
          const outcome = attempt(instance.driver, typeof probe.sql === 'string' ? [probe.sql] : probe.sql);
          const actual = describeOutcome(outcome);
          return actual === probe.expect ? null : `${probe.label}: expected ${probe.expect}, got ${actual}`;
        })
        .filter((line): line is string => line !== null);
      expect(mismatches).toEqual([]);
    });
  }

  it('covers every table of the schema with at least one probe', () => {
    const tables = instance.driver
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'schema_migrations') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(Object.keys(PROBES).sort()).toEqual(tables);
  });

  it('accepts all twelve kind/op pairs of the change log', () => {
    for (const [kind, op] of ALL_PAIRS) {
      expect(describeOutcome(attempt(instance.driver, [row('changes', { kind, op })])), `${kind}/${op}`).toBe(
        'accepted',
      );
    }
  });

  it('leaves the seeded database unchanged by all those probes', () => {
    expect(instance.driver.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 2 });
    expect(instance.driver.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
    expect(instance.driver.prepare('SELECT count(*) AS n FROM changes').get()).toEqual({ n: 0 });
  });
});

/** Runs `fn` inside a transaction that is rolled back afterwards and returns what `fn` returned. */
function inRolledBackTx<T>(db: SqlDriver, fn: () => T): T {
  const box: { done: boolean; value: T | undefined } = { done: false, value: undefined };
  try {
    db.transaction(() => {
      box.value = fn();
      box.done = true;
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (!box.done) throw new Error('the callback did not run to its end');
  return box.value as T;
}

describe('foreign key actions (03 3.4)', () => {
  const countFor = (table: string, where: string): number =>
    instance.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get()?.n ?? -1;

  it('deleting a session cascades to every child row that references it and keeps unrelated rows', () => {
    const children = [
      'agents',
      'turns',
      'tool_calls',
      'events',
      'usage',
      'cost_states',
      'state_transitions',
      'external_observations',
      'workflow_runs',
      'work_item_sessions',
    ];
    const result = inRolledBackTx(instance.driver, () => {
      instance.driver.exec(row('workflow_runs'));
      instance.driver.exec(row('work_item_sessions'));
      instance.driver.exec(row('state_transitions'));
      const before = children.map((table) => countFor(table, 'session_id = 1'));
      instance.driver.exec('DELETE FROM sessions WHERE id = 1');
      const after = children.map((table) => countFor(table, 'session_id = 1'));
      return { before, after, otherSessions: countFor('sessions', 'id = 2'), items: countFor('work_items', '1 = 1') };
    });
    expect(result.before.every((count) => count >= 1)).toBe(true);
    expect(result.after).toEqual(children.map(() => 0));
    expect(result.otherSessions).toBe(1);
    expect(result.items).toBe(1);
  });

  it('deleting a project detaches its sessions (SET NULL) and deleting a session detaches its alerts', () => {
    const result = inRolledBackTx(instance.driver, () => {
      instance.driver.exec(row('alerts', { session_id: 2, scope_key: S2 }));
      instance.driver.exec('DELETE FROM projects WHERE id = 1');
      const detached = instance.driver.prepare('SELECT project_id FROM sessions WHERE id = 1').get();
      instance.driver.exec('DELETE FROM sessions WHERE id = 2');
      const alert = instance.driver.prepare('SELECT session_id FROM alerts WHERE scope_key = ?').get([S2]);
      return { detached, alert };
    });
    expect(result.detached).toEqual({ project_id: null });
    expect(result.alert).toEqual({ session_id: null });
  });

  it('deleting a work item removes its links but not the sessions', () => {
    const result = inRolledBackTx(instance.driver, () => {
      instance.driver.exec(row('work_item_sessions'));
      instance.driver.exec('DELETE FROM work_items WHERE id = 1');
      return { links: countFor('work_item_sessions', '1 = 1'), sessions: countFor('sessions', '1 = 1') };
    });
    expect(result).toEqual({ links: 0, sessions: 2 });
  });
});

describe('schema conventions (ADR 0020, I-03, I-07, DA-I1)', () => {
  const tableNames = (): string[] =>
    instance.driver
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);

  it('makes every table STRICT', () => {
    const lax = instance.driver
      .prepare<{ name: string }>(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND strict = 0",
      )
      .all();
    expect(lax).toEqual([]);
  });

  it('has no per-row instance_id column: one file is one instance (03 C-1)', () => {
    const offenders = tableNames().flatMap((name) =>
      instance.driver
        .prepare<{ name: string }>(`SELECT name FROM pragma_table_info('${name}') WHERE name = 'instance_id'`)
        .all()
        .map(() => name),
    );
    expect(offenders).toEqual([]);
  });

  it('has one events table for hook envelopes and transcript entries (I-03) and the attempts tables (I-07)', () => {
    const names = tableNames();
    expect(names).toContain('events');
    expect(names).toContain('attempt_sources');
    expect(names).toContain('attempt_runs');
    expect(names).not.toContain('hook_event');
    expect(names).not.toContain('transcript_entry');
    expect(names).toHaveLength(29); // 28 own tables + schema_migrations
  });

  it('keys the spool cursors by .ndjson segment names only (I-02)', () => {
    const sql = instance.driver
      .prepare<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE name = 'spool_cursors'")
      .get()?.sql;
    expect(sql).toContain("segment GLOB '*.ndjson'");
    expect(sql).not.toContain('jsonl');
  });

  it('leads an index with every foreign key child column (cascades must not scan)', () => {
    const issues: string[] = [];
    for (const name of tableNames()) {
      const foreignKeys = instance.driver
        .prepare<{ from: string }>(`SELECT "from" FROM pragma_foreign_key_list('${name}')`)
        .all();
      if (foreignKeys.length === 0) continue;
      const leading = new Set(
        instance.driver
          .prepare<{ name: string }>(`SELECT name FROM pragma_index_list('${name}')`)
          .all()
          .map(
            (index) =>
              instance.driver
                .prepare<{ name: string }>(`SELECT name FROM pragma_index_info('${index.name}') WHERE seqno = 0`)
                .get()?.name,
          )
          .filter((column): column is string => column !== undefined),
      );
      const primary = instance.driver
        .prepare<{ name: string }>(`SELECT name FROM pragma_table_info('${name}') WHERE pk = 1`)
        .all()
        .map((column) => column.name);
      for (const { from } of foreignKeys)
        if (!leading.has(from) && !primary.includes(from)) issues.push(`${name}.${from}`);
    }
    expect(issues).toEqual([]);
  });

  it('answers foreign_key_check with no violation and integrity_check with ok', () => {
    expect(instance.driver.pragma('foreign_key_check')).toEqual([]);
    expect(instance.driver.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });
});
