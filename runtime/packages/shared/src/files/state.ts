// `<ws>/state.json`: runtime-only (01 section 1.7). Not strict (z.object ignores unknown keys): files that this runtime did
// not write (no `engine: 'node'`, such as a pre-4.0 monitor's) and files of future versions carry keys this schema does not know.
import { z } from 'zod';

import { Semver, UUID_V4_RE } from '../ids.ts';

export const StateFileSchema = z
  .object({
    pid: z.number().int().positive(),
    url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
    port: z.number().int().min(1).max(65535),
    started: z.number().nonnegative(),
    version: z.string(),
    task: z.string().nullable(),
    config: z.string().nullable(),
    schema_version: z.literal(1).optional(),
    engine: z.literal('node').optional(),
    instanceId: z.string().regex(UUID_V4_RE).optional(),
    runtimeVersion: Semver.optional(),
    codeStamp: z
      .string()
      .regex(/^[0-9a-f]{10}$/)
      .optional(),
    startedAt: z.string().optional(),
    nodeVersion: z.string().optional(),
    control: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (
      s.engine === 'node' &&
      (s.instanceId === undefined || s.codeStamp === undefined || s.runtimeVersion === undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'node state needs instanceId, codeStamp, runtimeVersion' });
    }
  });

export type StateFile = z.infer<typeof StateFileSchema>;
