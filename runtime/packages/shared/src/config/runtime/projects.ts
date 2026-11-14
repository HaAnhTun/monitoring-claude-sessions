// `projects` section: all-projects ingestion, the folder catalogue and the link between a terminal and the monitored
// session (CAW design 03 2.1). Eleven flat keys. The `scope` key decides what the instance reads; `auto` follows the
// kind of the instance (all projects for the user instance, the repository for a task instance).
import { z } from 'zod';

import { type KeySpec, intKey, sectionSchema } from './section.ts';

/** The values of `projects.scope`. */
export const PROJECT_SCOPES = ['auto', 'repo', 'all'] as const;
export type ProjectScope = (typeof PROJECT_SCOPES)[number];

const scope: KeySpec<z.ZodEnum<{ auto: 'auto'; repo: 'repo'; all: 'all' }>> = {
  /** `repo` reads the one repository, `all` every folder under the Claude projects folder, `auto` decides by instance kind. */
  schema: z.enum(PROJECT_SCOPES),
  default: 'auto',
};

const daMemoryDir: KeySpec<z.ZodNullable<z.ZodString>> = {
  /** Folder of the DA memory files; null is `<home>/.claude/memory`, whatever `CLAUDE_CONFIG_DIR` says. */
  schema: z
    .string()
    .min(1)
    .max(1024)
    // printable characters only (no C0, DEL or C1 control, written as the allowed ranges)
    .regex(/^[\u0020-\u007e\u00a1-\uffff]+$/)
    .nullable(),
  default: null,
};

export const ProjectsSectionKeys = {
  scope,
  /** Period of the full sweep of every project folder (scope `all`). */
  fullSweepIntervalMs: intKey(5000, 3_600_000, 60_000),
  /** Period at which files without growth for five minutes are checked (scope `all`). */
  coldStatIntervalMs: intKey(1000, 600_000, 10_000),
  /** Period of the refresh of the folder catalogue. */
  catalogIntervalMs: intKey(5000, 600_000, 30_000),
  daMemoryDir,
  /** How long one read of the DA memory is reused. */
  daCacheMs: intKey(500, 60_000, 3000),
  /** The most folders a person may add by hand. */
  userFoldersMax: intKey(1, 1000, 200),
  /** Poll of the registry for the link while a terminal is young. */
  linkPollMs: intKey(100, 5000, 250),
  /** Poll after the fast window, and for terminals that are already linked. */
  linkSlowPollMs: intKey(500, 60_000, 2000),
  /** Length of the fast poll window; the database fallback starts when it ends. */
  linkFastWindowMs: intKey(5000, 600_000, 30_000),
  /** A registry entry may start this much before the spawn time and still count as the new session. */
  linkStartToleranceMs: intKey(0, 30_000, 2000),
};

export const ProjectsSectionSchema = sectionSchema(ProjectsSectionKeys);
export type ProjectsSection = z.output<typeof ProjectsSectionSchema>;
