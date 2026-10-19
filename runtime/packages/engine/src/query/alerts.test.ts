// `alertById` (03 6.1, 9.3, CR-WP-36-2): one alert of any status by its id, as the same item the list route answers. The stream
// hydrates its `alert/upsert` frames with it, so an alert older than the newest 200 is exact too. Rows are written with plain SQL.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AlertItemSchema, AlertListQuerySchema, RUNTIME_VERSION } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import { isDbError } from '../db/errors.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MINUTE = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const SESSION = 'cccccccc-0000-4000-8000-000000000001';

const opened: InstanceContext[] = [];
afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.db.close();
});

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

async function instance(): Promise<InstanceContext> {
  const root = makeTemp('q-alerts').path;
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
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  opened.push(ctx);
  return ctx;
}

function put(ctx: InstanceContext, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

function addAlert(ctx: InstanceContext, n: number, over: Record<string, SqlValue> = {}): number {
  return put(ctx, 'alerts', {
    rule_id: 'import_lag',
    rule_kind: 'import_lag',
    scope_kind: 'instance',
    scope_key: `scope-${String(n)}`,
    severity: 'warning',
    status: 'open',
    title: `Transcript import ${String(n)} s behind`,
    detail: JSON.stringify({ maxLagMs: n * 1000 }),
    first_fired_at: NOW - 60 * MINUTE + n,
    last_fired_at: NOW - 60 * MINUTE + n,
    fire_count: 1,
    updated_seq: n,
    ...over,
  });
}

describe('alertById', () => {
  it('answers the exact item of an open alert, the one the list route gives', async () => {
    const ctx = await instance();
    const id = addAlert(ctx, 7);
    const item = ctx.queries.alertById(ctx.scope, id);
    expect(AlertItemSchema.parse(item)).toEqual({
      id,
      seq: 7,
      ruleId: 'import_lag',
      rule: 'import_lag',
      severity: 'warning',
      status: 'open',
      title: 'Transcript import 7 s behind',
      scope: { kind: 'instance', key: 'scope-7' },
      sessionId: null,
      since: new Date(NOW - 60 * MINUTE + 7).toISOString(),
      lastFiredAt: new Date(NOW - 60 * MINUTE + 7).toISOString(),
      fireCount: 1,
      resolvedAt: null,
      resolvedReason: null,
      detail: { maxLagMs: 7000 },
    });
    const listed = ctx.queries.listAlerts(ctx.scope, AlertListQuerySchema.parse({ status: 'open,resolved' }));
    expect(listed.items).toEqual([item]);
  });

  it('answers a resolved alert and the uid of the session of a session scoped one', async () => {
    const ctx = await instance();
    const session = put(ctx, 'sessions', {
      session_uid: SESSION,
      first_seen_at: NOW - 3_600_000,
      started_at: NOW - 3_600_000,
      last_activity_at: NOW - 60_000,
      updated_at: NOW,
    });
    const id = addAlert(ctx, 1, {
      rule_id: 'hook_gap',
      rule_kind: 'hook_gap',
      scope_kind: 'session',
      scope_key: SESSION,
      session_id: session,
      status: 'resolved',
      resolved_at: NOW - MINUTE,
      resolved_reason: 'condition_cleared',
    });
    expect(ctx.queries.alertById(ctx.scope, id)).toMatchObject({
      id,
      status: 'resolved',
      sessionId: SESSION,
      resolvedReason: 'condition_cleared',
      resolvedAt: new Date(NOW - MINUTE).toISOString(),
    });
  });

  it('answers any id of the instance, also an alert older than the newest 200', async () => {
    const ctx = await instance();
    const ids: number[] = [];
    for (let n = 1; n <= 260; n += 1) ids.push(addAlert(ctx, n, { status: 'open' }));
    const oldest = ids[0] ?? 0;
    const page = ctx.queries.listAlerts(
      ctx.scope,
      AlertListQuerySchema.parse({ status: 'open,resolved', limit: '200' }),
    );
    expect(page.items.map((item) => item.id)).not.toContain(oldest);
    expect(ctx.queries.alertById(ctx.scope, oldest)).toMatchObject({ id: oldest, scope: { key: 'scope-1' }, seq: 1 });
    expect(ctx.queries.alertById(ctx.scope, ids[259] ?? 0)).toMatchObject({ scope: { key: 'scope-260' } });
  });

  it('answers null for an id the instance does not have', async () => {
    const ctx = await instance();
    addAlert(ctx, 1);
    expect(ctx.queries.alertById(ctx.scope, 9999)).toBeNull();
    expect(ctx.queries.alertById(ctx.scope, 0)).toBeNull();
  });

  it('refuses a caller of another instance and never writes', async () => {
    const ctx = await instance();
    const id = addAlert(ctx, 1);
    let code: string | undefined;
    try {
      ctx.queries.alertById(FOREIGN, id);
    } catch (error) {
      code = isDbError(error) ? error.code : 'other';
    }
    expect(code).toBe('scope_mismatch');
    const before = ctx.db.headSeq();
    ctx.queries.alertById(ctx.scope, id);
    expect(ctx.db.headSeq()).toBe(before);
  });
});
