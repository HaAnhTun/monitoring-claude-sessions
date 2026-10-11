// `GET /api/health`, the only route outside `/api/v3` (03 6.2, I-30). Exactly the 13 keys the legacy `cli.py` readers may
// look at, so a legacy `start` on the same task recognises a running Node instance instead of launching a second engine.
import { z } from 'zod';

import { InstanceIdSchema } from './ids.ts';

export const LEGACY_HEALTH_KEYS = [
  'ok',
  'version',
  'pid',
  'started',
  'uptime',
  'now',
  'code_stamp',
  'engine',
  'instanceId',
  'task',
  'config_source',
  'errors',
  'reader',
] as const;

export const LegacyHealthSchema = z.strictObject({
  ok: z.literal(true),
  /** Runtime semver. */
  version: z.string(),
  pid: z.number().int().min(0),
  /** Epoch seconds, float. */
  started: z.number(),
  /** Seconds, one decimal. */
  uptime: z.number().min(0),
  /** Epoch seconds, float. */
  now: z.number(),
  code_stamp: z.string(),
  engine: z.literal('node'),
  instanceId: InstanceIdSchema,
  /** Legacy `task_brief()`: the `task` of `config.json`, description default `''`. */
  task: z.strictObject({ id: z.string(), name: z.string(), description: z.string() }).nullable(),
  config_source: z.literal('task'),
  /** Always empty: v3 errors are `GET /api/v3/errors`. */
  errors: z.tuple([]),
  /** Always `{}`. */
  reader: z.strictObject({}),
});
export type LegacyHealth = z.infer<typeof LegacyHealthSchema>;
