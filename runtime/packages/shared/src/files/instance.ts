// `<ws>/instance.json`: Node-owned runtime identity (01 section 1.5, ADR 0001). Key order on disk is the order below.
import { z } from 'zod';

import { IsoSecondsZ, SLUG_RE, Semver, UUID_V4_RE } from '../ids.ts';

export const InstanceFileSchema = z.strictObject({
  schema_version: z.literal(1),
  /** `crypto.randomUUID()`; never changes except through `instances repair`. */
  instanceId: z.string().regex(UUID_V4_RE),
  /** Must equal the folder name (copy detection, 01 3.4). */
  slug: z.string().regex(SLUG_RE),
  createdAt: IsoSecondsZ,
  createdBy: z.string().regex(/^mcs \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  /** Runtime that last initialized or upgraded this instance's data. */
  runtimeVersion: Semver,
  /** Mirror of the DB value after the last upgrade; 0 = no DB yet; the DB is authoritative. */
  dbSchemaVersion: z.number().int().min(0),
  /** Which engine `mcs start` launches (01 6.5). */
  engine: z.enum(['node', 'legacy']),
  /** Whether the hook handler routes to this instance. */
  hooks: z.strictObject({ enabled: z.boolean() }),
  upgradedAt: IsoSecondsZ.nullable(),
});

export type InstanceFile = z.infer<typeof InstanceFileSchema>;
