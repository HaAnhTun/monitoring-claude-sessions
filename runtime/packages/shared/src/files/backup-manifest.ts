// `data/backups/<backupId>/manifest.json` (01 section 5.5).
import { z } from 'zod';

import { IsoSecondsZ, Semver, UUID_V4_RE } from '../ids.ts';

export const BACKUP_REASONS = ['manual', 'upgrade', 'config-migrate', 'pre-restore', 'cleanup', 'db-rebuild'] as const;

/** `online` = SQLite online backup, `raw` = the moved original file (db rebuild), `none` = files-only backup. */
export const BACKUP_DB_COPIES = ['online', 'raw', 'none'] as const;

export const BackupManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  backupId: z.string(),
  instanceId: z.string().regex(UUID_V4_RE),
  slug: z.string(),
  createdAt: IsoSecondsZ,
  reason: z.enum(BACKUP_REASONS),
  runtimeVersion: Semver,
  dbSchemaVersion: z.number().int().min(0),
  dbCopy: z.enum(BACKUP_DB_COPIES),
  files: z.array(
    z.strictObject({
      path: z.string(),
      bytes: z.number().int().min(0),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;
