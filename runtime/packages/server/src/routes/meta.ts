// The meta routes (03 6.1, 6.2): `legacyHealth` (`GET /api/health`, the only route outside `/api/v3`), `health`,
// `healthIngest`, `instance` and `config`. The handlers call the query layer of the instance context and nothing else
// (ADR 0029); only the body of `legacyHealth` is built here, because it is a projection of the process and `task.json`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { routes, toConfigInspection, type LegacyHealth } from '@mcs/shared';
import { z } from 'zod';

import { registerRoute, type AppContext, type LegacyTask, type RouteModule } from '../route-adapter.ts';

/** How many entries of the server error ring `HealthReport.errors` carries (03 6.2). */
const HEALTH_ERRORS = 20;

const TaskFileSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
});

/**
 * `task.json` as the legacy `task_brief()` shows it: `{ id, name, description }` with the description defaulting to the
 * empty string. The name falls back to the id. `null` when the file is missing, not JSON, not an object or without an id:
 * the health body then says `task: null`, like a legacy server without a task. Reads one small file, once, at boot.
 */
export async function readLegacyTask(instanceDir: string): Promise<LegacyTask | null> {
  let text: string;
  try {
    text = await readFile(path.join(instanceDir, 'task.json'), 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = TaskFileSchema.safeParse(value);
  if (!parsed.success) return null;
  return { id: parsed.data.id, name: parsed.data.name ?? parsed.data.id, description: parsed.data.description ?? '' };
}

/** One decimal, never below zero (the legacy `round(time.time() - start, 1)`). */
function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 100) / 10);
}

/** The 13 keys of the legacy health body (03 6.2, I-30): enough for `instance_alive` and `status` of the legacy CLI. */
export function legacyHealthOf(ctx: AppContext, task: LegacyTask | null): LegacyHealth {
  const nowMs = ctx.clock.now();
  const { pid, startedAtMs, runtimeVersion, bootCodeStamp } = ctx.process;
  return {
    ok: true,
    version: runtimeVersion,
    pid,
    started: startedAtMs / 1000,
    uptime: seconds(nowMs - startedAtMs),
    now: nowMs / 1000,
    code_stamp: bootCodeStamp,
    engine: 'node',
    instanceId: ctx.instanceId,
    task,
    config_source: 'task',
    errors: [],
    reader: {},
  };
}

export const metaRoutes: RouteModule = (app, { ctx, task }) => {
  registerRoute(app, routes.legacyHealth, () => legacyHealthOf(ctx, task));
  // the query layer does not know the server error ring (it is made after the queries): the route attaches it
  registerRoute(app, routes.health, () => ({
    ...ctx.queries.health(ctx.scope),
    errors: ctx.errors.list(HEALTH_ERRORS),
  }));
  registerRoute(app, routes.healthIngest, () => ctx.queries.ingestHealth(ctx.scope));
  registerRoute(app, routes.instance, () => ctx.queries.instanceInfo(ctx.scope));
  registerRoute(app, routes.config, () => toConfigInspection(ctx.config, ctx.instance.engine));
};
