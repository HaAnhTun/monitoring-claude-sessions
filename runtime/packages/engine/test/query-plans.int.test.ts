// DA-T-DB-14 (03 19.1, 3.7): the query plans of the read layer stay indexed. A seeded dataset (500 sessions, 50,000 events,
// 20,000 tool calls, 50,000 usage rows, `ANALYZE`d) is read through the real query functions; every statement they run is captured and
// explained with the parameters of the call. No statement may scan `events` or `usage` without an index, and the queries of
// the 3.7 table must use the index the table names. The expectations are index names, not the text of a plan, so that a
// newer SQLite that words a plan differently does not fail the test; a dropped or unusable index does.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  AgentListQuerySchema,
  EventListQuerySchema,
  RUNTIME_VERSION,
  SessionAgentsQuerySchema,
  SessionListQuerySchema,
  ToolCallListQuerySchema,
  TransitionListQuerySchema,
} from '@mcs/shared';
import { FakeClock, makeTempDir } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import type { SqlParams, SqlValue, Stmt } from '../src/db/driver.ts';
import type { InstanceDb } from '../src/db/open.ts';
import type { Logger } from '../src/log/logger.ts';
import { createAgentQueries } from '../src/query/agents.ts';
import { createEventQueries } from '../src/query/events.ts';
import { createSessionQueries } from '../src/query/sessions.ts';
import { createToolCallQueries } from '../src/query/tool-calls.ts';
import { createTransitionQueries } from '../src/query/transitions.ts';
import { buildInstanceContext, type InstanceContext, type QueryDeps } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const SESSIONS = 500;
const EVENTS = 50_000;
const TOOL_CALLS = 20_000;
const USAGE_ROWS = 50_000;

interface Captured {
  readonly sql: string;
  readonly params: SqlParams | undefined;
}

let ctx: InstanceContext;
let deps: QueryDeps;
let captured: Captured[] = [];
let spyDb: InstanceDb;
const cleanup: (() => void)[] = [];

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** The database with a driver whose `prepare` records every statement that reads (the writes of the seed are not captured). */
function spyOn(db: InstanceDb, log: () => Captured[]): InstanceDb {
  return {
    ...db,
    driver: {
      ...db.driver,
      prepare: <R = Record<string, SqlValue>>(sql: string): Stmt<R> => {
        const stmt = db.driver.prepare<R>(sql);
        return {
          run: (params) => stmt.run(params),
          get: (params) => {
            log().push({ sql, params });
            return stmt.get(params);
          },
          all: (params) => {
            log().push({ sql, params });
            return stmt.all(params);
          },
        };
      },
    },
  };
}

beforeAll(async () => {
  const temp = makeTempDir('query-plans');
  const root = temp.path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  cleanup.push(() => {
    ctx.db.close();
    temp.remove();
  });
  const { driver } = ctx.db;
  driver.exec(`
    INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at)
      VALUES ('proj-a', 'proj-a', ${String(NOW)}, ${String(NOW)}), ('proj-b', 'proj-b', ${String(NOW)}, ${String(NOW)});
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(SESSIONS)})
    INSERT INTO sessions (session_uid, project_id, label, matched, search_text, models, first_seen_at, started_at,
                          last_activity_at, state, tok_input, error_count, updated_at)
    SELECT printf('cccccccc-0000-4000-8000-%012x', i), 1 + (i % 2), 'session ' || i, 1, 'session ' || i, '["m"]',
           ${String(NOW)} - 86400000 - i * 1000, ${String(NOW)} - 86400000 - i * 1000, ${String(NOW)} - i * 60000,
           CASE i % 4 WHEN 0 THEN 'working' WHEN 1 THEN 'completed' WHEN 2 THEN 'stale' ELSE 'waiting_input' END,
           i * 10, i % 5, ${String(NOW)} FROM n;
    INSERT INTO agents (session_id, agent_uid, kind, depth, first_seen_at, started_at, last_activity_at, updated_at)
    SELECT id, 'main', 'main', 0, first_seen_at, started_at, last_activity_at, ${String(NOW)} FROM sessions;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(TOOL_CALLS)})
    INSERT INTO tool_calls (session_id, agent_id, tool_use_id, name, started_at, updated_at)
    SELECT 1 + (i % ${String(SESSIONS)}), 1 + (i % ${String(SESSIONS)}), 'toolu_' || i, 'Tool' || (i % 20),
           ${String(NOW)} - i * 20000, ${String(NOW)} FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(EVENTS)})
    INSERT INTO events (session_id, agent_id, kind, severity, sources, ts, ts_source, received_at, event_uid, tool_use_id,
                        tool_name, summary)
    SELECT 1 + (i % ${String(SESSIONS)}), 1 + (i % ${String(SESSIONS)}),
           CASE i % 8 WHEN 0 THEN 'prompt.submit' WHEN 1 THEN 'tool.call' WHEN 2 THEN 'tool.result' WHEN 3 THEN 'assistant.message'
                      WHEN 4 THEN 'tool.call' WHEN 5 THEN 'turn.stop' WHEN 6 THEN 'tool.failure' ELSE 'agent.start' END,
           CASE WHEN i % 50 = 0 THEN 2 ELSE 0 END, 1, ${String(NOW)} - i * 5000, 'hook_received', ${String(NOW)},
           printf('eeeeeeee-0000-4000-8000-%012x', i), CASE WHEN i % 2 = 1 THEN 'toolu_' || (i % ${String(TOOL_CALLS)} + 1) END,
           CASE WHEN i % 2 = 1 THEN 'Tool' || (i % 20) END, 'event ' || i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(USAGE_ROWS)})
    INSERT INTO usage (message_key, session_id, agent_id, owner_file_id, model, ts, input_tokens, output_tokens, finalized,
                       usage_source, updated_at)
    SELECT 'msg-' || i, 1 + (i % ${String(SESSIONS)}), 1 + (i % ${String(SESSIONS)}), 1, 'm', ${String(NOW)} - i * 1000, 3, 4, 1,
           'top', ${String(NOW)} FROM n;
    UPDATE agents SET usage_messages = 4, tok_input = 12, tok_output = 16, tok_cache_read = 0, tok_cache_creation = 0,
                      tok_cache_read_missing = 4, tok_cache_creation_missing = 4 WHERE agent_uid = 'main' AND session_id = 7;
    INSERT INTO state_transitions (session_id, to_state, rule, basis, confidence, at)
    SELECT 1, 'working', 'S-7c', 'observed', 'high', ${String(NOW)} - id FROM sessions;
    ANALYZE;`);
  deps = { config: ctx.config, now: () => NOW, audit: { entriesBetween: () => Promise.resolve([]) } };
  spyDb = spyOn(ctx.db, () => captured);
});

afterAll(() => {
  for (const run of cleanup.splice(0)) run();
});

const uid = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Runs `call` and returns the `EXPLAIN QUERY PLAN` detail lines of every statement it read, one list per statement. */
function plansOf(call: () => void): string[][] {
  captured = [];
  call();
  const statements = captured.filter((entry) => /^\s*SELECT/i.test(entry.sql));
  captured = [];
  return statements.map((entry) =>
    ctx.db.driver
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${entry.sql}`)
      .all(entry.params)
      .map((row) => row.detail),
  );
}

const flat = (plans: string[][]): string => plans.flat().join('\n');

/** No statement may scan `events`, `usage` or `usage_files` without an index (03 3.7 and DA-T-DB-14). */
function expectNoBareScan(plans: string[][]): void {
  for (const line of plans.flat()) {
    expect(line, line).not.toMatch(/^SCAN (events|e|usage|u|usage_files|uf)$/);
  }
}

const eventQueries = (): ReturnType<typeof createEventQueries> => createEventQueries(spyDb, deps);
const sessionQueries = (): ReturnType<typeof createSessionQueries> => createSessionQueries(spyDb, deps);
const eventQuery = (params: Record<string, string>) => EventListQuerySchema.parse(params);

describe('the dataset', () => {
  it('has the sizes the plans are judged on', () => {
    const count = (table: string): number =>
      ctx.db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
    expect(count('sessions')).toBe(SESSIONS);
    expect(count('events')).toBe(EVENTS);
    expect(count('tool_calls')).toBe(TOOL_CALLS);
    expect(count('usage')).toBe(USAGE_ROWS);
  });
});

describe('sessions', () => {
  it('pages a window by the activity index', () => {
    const plans = plansOf(() => {
      sessionQueries().listSessions(ctx.scope, SessionListQuerySchema.parse({ range: '30d', includeUnmatched: '1' }));
    });
    expect(plans.length).toBeGreaterThan(0);
    expect(flat(plans)).toContain('idx_sessions_activity');
    expectNoBareScan(plans);
  });

  it('answers a keyset page, a state filter and a project filter without scanning events or usage', () => {
    const first = sessionQueries().listSessions(
      ctx.scope,
      SessionListQuerySchema.parse({ range: '30d', includeUnmatched: '1', limit: '5' }),
    );
    const cursor = first.nextCursor ?? '';
    expect(cursor).not.toBe('');
    for (const params of [
      { cursor },
      { state: 'working' },
      { project: 'proj-a' },
      { sort: 'tokens' },
      { q: 'session 4' },
      { includeTotal: '1' },
    ]) {
      const plans = plansOf(() => {
        sessionQueries().listSessions(
          ctx.scope,
          SessionListQuerySchema.parse({ range: '30d', includeUnmatched: '1', limit: '5', ...params }),
        );
      });
      expectNoBareScan(plans);
    }
  });

  it('reads the transcript files and the cost state of a page through their indexes', () => {
    const plans = plansOf(() => {
      sessionQueries().listSessions(ctx.scope, SessionListQuerySchema.parse({ range: '30d', includeUnmatched: '1' }));
    });
    const text = flat(plans);
    expect(text).toContain('idx_transcript_files_session');
    expect(text).toContain('idx_cost_states_session');
    expectNoBareScan(plans);
  });

  /** The statements of a call that name `usage` or `usage_files` (03 3.7 rule 3: a page never aggregates the usage table). */
  function usageStatements(call: () => void): string[] {
    captured = [];
    call();
    const statements = captured.map((entry) => entry.sql).filter((sql) => /\b(usage|usage_files)\b/.test(sql));
    captured = [];
    return statements;
  }

  it('takes the own usage of a page from the main agent rollup and never reads the usage table (03 6.3)', () => {
    const page = SessionListQuerySchema.parse({ range: '30d', includeUnmatched: '1', limit: '100' });
    expect(usageStatements(() => sessionQueries().listSessions(ctx.scope, page))).toEqual([]);
    const summary = sessionQueries()
      .listSessions(ctx.scope, page)
      .items.find((item) => item.id === uid(7));
    // the rollup of session 7 says 4 messages; the 100 usage rows of that session in the table are not read
    expect(summary?.usage).toMatchObject({ turns: 4, input: 12, output: 16, cacheRead: null, cacheCreation: null });
  });

  it('reads usage in getSession only to count the messages that another session owns', () => {
    const statements = usageStatements(() => {
      sessionQueries().getSession(ctx.scope, uid(7));
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/usage_files uf JOIN usage u/);
    expect(statements[0]).toMatch(/u\.session_id <> :sid/);
  });
});

describe('events', () => {
  it('answers a session timeline from the session index, covering the ordering', () => {
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ session: uid(7), range: 'all' }));
    });
    expect(flat(plans)).toContain('idx_events_session_ts');
    expectNoBareScan(plans);
  });

  it('answers the activity feed newest first, and its next page, from the time index', () => {
    const first = eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', limit: '20' }));
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', limit: '20' }));
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', limit: '20', cursor: first.nextCursor ?? '' }));
    });
    expect(flat(plans)).toContain('idx_events_ts');
    expectNoBareScan(plans);
  });

  it('answers the feed by kinds and categories from the kind index (113 ms without it)', () => {
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', type: 'tool.failure,turn.stop' }));
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', category: 'prompt' }));
    });
    expect(flat(plans)).toContain('idx_events_kind_ts');
    expectNoBareScan(plans);
  });

  it('answers the problems feed from the partial index', () => {
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', severity: 'error' }));
    });
    expect(flat(plans)).toContain('idx_events_problems');
    expectNoBareScan(plans);
  });

  it('answers the live tail by primary key', () => {
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', afterId: '49000', limit: '500' }));
    });
    expect(flat(plans)).toMatch(/SEARCH e USING INTEGER PRIMARY KEY|SEARCH events USING INTEGER PRIMARY KEY/);
    expectNoBareScan(plans);
  });

  it('answers the hydration of a frame by the id range of the primary key', () => {
    const plans = plansOf(() => {
      eventQueries().eventsByIdRange(ctx.scope, 1, 100, 200, 50);
    });
    expect(flat(plans)).toMatch(/SEARCH e USING INTEGER PRIMARY KEY/);
    expectNoBareScan(plans);
  });

  it('bounds the text search of a window to the newest 50,000 rows through the time index', () => {
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', q: 'no-such-text' }));
      eventQueries().listEvents(ctx.scope, eventQuery({ range: 'all', session: uid(3), q: 'no-such-text' }));
    });
    const text = flat(plans);
    expect(text).toMatch(/idx_events_ts|idx_events_session_ts/);
    expectNoBareScan(plans);
  });

  it('answers the tool filter through the tool call name index and the events through the time index', () => {
    const plans = plansOf(() => {
      eventQueries().listEvents(ctx.scope, eventQuery({ range: '24h', tool: 'Tool3' }));
    });
    expect(flat(plans)).toContain('idx_tool_calls_name');
    expectNoBareScan(plans);
  });
});

describe('tool calls, agents and transitions', () => {
  it('answers the tool calls of a session by the session index and by name by the name index', () => {
    const queries = createToolCallQueries(spyDb, deps);
    const bySession = plansOf(() => {
      queries.listToolCalls(ctx.scope, ToolCallListQuerySchema.parse({ session: uid(9), range: 'all' }));
    });
    expect(flat(bySession)).toContain('idx_tool_calls_session');
    const byName = plansOf(() => {
      queries.listToolCalls(ctx.scope, ToolCallListQuerySchema.parse({ tool: 'Tool4', range: '24h' }));
    });
    expect(flat(byName)).toContain('idx_tool_calls_name');
  });

  it('answers the agents of a session by their unique index and the running agents by the partial index', () => {
    const queries = createAgentQueries(spyDb, deps);
    const ofSession = plansOf(() => {
      queries.sessionAgents(ctx.scope, uid(5), SessionAgentsQuerySchema.parse({}));
    });
    expect(flat(ofSession)).toMatch(/sqlite_autoindex_agents_1|idx_agents/);
    const running = plansOf(() => {
      queries.listAgents(
        ctx.scope,
        AgentListQuerySchema.parse({ state: 'active', range: '30d', includeUnmatched: '1' }),
      );
    });
    expectNoBareScan(running);
  });

  it('answers the transitions of a session by their index', () => {
    const queries = createTransitionQueries(spyDb, deps);
    const plans = plansOf(() => {
      queries.sessionTransitions(ctx.scope, uid(1), TransitionListQuerySchema.parse({}));
    });
    expect(flat(plans)).toContain('idx_transitions_session');
  });
});
