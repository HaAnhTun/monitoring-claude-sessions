// `<ws>/instance.json`: Node-owned runtime identity (01 section 1.5, ADR 0001). Key order on disk is the order below.
import { z } from 'zod';

import { IsoSecondsZ, SLUG_RE, Semver, UUID_V4_RE } from '../ids.ts';

/** What an instance is for: a monitored `task` workspace, or the one `user` instance that hosts the app (06 1.3). */
export const InstanceKindSchema = z.enum(['task', 'user']);
export type InstanceKind = z.infer<typeof InstanceKindSchema>;

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
  /** Written by this runtime; the Node runtime is the only engine (ADR 0066). */
  engine: z.literal('node'),
  /**
   * Written only for `user`; an absent key means `task`, so a task file stays byte-identical (06 1.3). It lives in the
   * identity file, not in the configuration: a one-line `config.json` edit must not turn a task into a terminal host.
   */
  kind: InstanceKindSchema.optional(),
  /** Whether the hook handler routes to this instance. */
  hooks: z.strictObject({ enabled: z.boolean() }),
  upgradedAt: IsoSecondsZ.nullable(),
});

export type InstanceFile = z.infer<typeof InstanceFileSchema>;

/** The kind of an instance file; a file without the key is a `task`. */
export function instanceKindOf(file: Pick<InstanceFile, 'kind'>): InstanceKind {
  return file.kind ?? 'task';
}
