// Contracts of the projects area (CAW design 03 section 7.1, Option A): the folder catalogue rows the sidebar lists, the
// body that adds a folder by hand, the answer of the resume eligibility route and the link between a terminal and the
// monitored session that the terminal DTO embeds. The folder helpers (`../folders`) own the activity mark; nothing here
// restates it.
import { z } from 'zod';

import { ACTIVITY_MARKS } from '../folders/index.ts';
import { CountSchema, ProjectIdSchema, SessionIdSchema } from './ids.ts';
import { IsoTimeSchema, NullableIsoTimeSchema } from './time.ts';

/** `full | half | none`, built from the one definition of the helpers. */
export const ActivityMarkSchema = z.enum(ACTIVITY_MARKS);

/** Where a folder row came from: the DA memory, a folder a person added, the Claude home, or a fallback (a row that has only a session). */
export const FOLDER_ORIGINS = ['da', 'user', 'claude', 'fallback'] as const;
export const FolderOriginSchema = z.enum(FOLDER_ORIGINS);
export type FolderOrigin = z.infer<typeof FolderOriginSchema>;

/** How the path of a row was found (`none`: it could not be, and the row cannot start a terminal). */
export const FOLDER_PATH_SOURCES = ['da', 'user', 'project', 'transcript', 'reverse', 'none'] as const;
export const FolderPathSourceSchema = z.enum(FOLDER_PATH_SOURCES);
export type FolderPathSource = z.infer<typeof FolderPathSourceSchema>;

/** The two blocks of the folder list: the folders the DA memory knows, and the others. */
export const FOLDER_GROUPS = ['outside-da', 'da'] as const;
export const FolderGroupSchema = z.enum(FOLDER_GROUPS);
export type FolderGroup = z.infer<typeof FolderGroupSchema>;

const DA_SUMMARY_MAX_CODE_POINTS = 120;

/**
 * The DA summary, already redacted and clipped by the reader: at most 120 code points. `max(240)` is the same bound in
 * UTF-16 units (it is what the generated JSON Schema shows); the refinement counts code points.
 */
const DaSummarySchema = z
  .string()
  .max(DA_SUMMARY_MAX_CODE_POINTS * 2)
  .refine((text) => Array.from(text).length <= DA_SUMMARY_MAX_CODE_POINTS, { error: 'At most 120 characters' });

const DaBlockSchema = z.strictObject({
  lastUpdatedAt: NullableIsoTimeSchema,
  activity: ActivityMarkSchema,
  summary: DaSummarySchema,
  brain: CountSchema,
  action: CountSchema,
});

const ClaudeBlockSchema = z.strictObject({
  /** The folder name under the Claude projects folder, as written on disk. */
  dirName: z.string().min(1).max(255),
  sessionsInWindow: CountSchema,
  activeSessions: CountSchema,
  totalSessions: CountSchema,
  lastSessionAt: NullableIsoTimeSchema,
});

/** One row of `GET /folders`. `key` is the project key; `path` is null when it could not be recovered. */
export const FolderSchema = z.strictObject({
  key: ProjectIdSchema,
  name: z.string().min(1).max(255),
  path: z.string().max(1024).nullable(),
  pathSource: FolderPathSourceSchema,
  /** Whether the folder is a directory now; `null` when it was not checked or there is no path. */
  exists: z.boolean().nullable(),
  origins: z.array(FolderOriginSchema).min(1),
  group: FolderGroupSchema,
  activity: ActivityMarkSchema,
  lastActivityAt: NullableIsoTimeSchema,
  da: DaBlockSchema.nullable(),
  claude: ClaudeBlockSchema.nullable(),
  /** The path is known and the folder is not known to be missing. */
  canStart: z.boolean(),
  userAdded: z.boolean(),
});
export type Folder = z.infer<typeof FolderSchema>;

const SourceStatusSchema = z.enum(['ok', 'absent', 'unreadable']);

/** Body of `GET /folders`: the rows (at most 500), what each source said, and the clock the web feeds to `relativeTimeOf`. */
export const FolderListResponseSchema = z.strictObject({
  folders: z.array(FolderSchema).max(500),
  sources: z.strictObject({
    daMemory: z.strictObject({ status: SourceStatusSchema, folders: CountSchema, readAt: NullableIsoTimeSchema }),
    claudeHome: z.strictObject({
      status: SourceStatusSchema,
      folders: CountSchema,
      scannedAt: NullableIsoTimeSchema,
      truncated: z.boolean(),
    }),
    userFolders: z.strictObject({ status: z.enum(['ok', 'absent', 'corrupt', 'newer_version']), count: CountSchema }),
  }),
  /** The "now" of the server: the page and the server agree on every relative time. */
  asOf: IsoTimeSchema,
});
export type FolderListResponse = z.infer<typeof FolderListResponseSchema>;

/**
 * Body of `POST /folders`. Only the size is checked here: a relative, UNC or device path, a reserved name and the like are
 * answered by the service as `folder_invalid` with the reason in `details`, not as a generic `validation_failed`.
 */
export const AddFolderBodySchema = z.strictObject({ path: z.string().min(1).max(1024) });
export type AddFolderBody = z.infer<typeof AddFolderBodySchema>;

/** Why a session cannot be resumed in a terminal (design 03 section 6, in the order the checks run). */
export const RESUME_REASONS = [
  'transcript_gone',
  'folder_missing',
  'folder_unknown',
  'live_in_terminal',
  'live_elsewhere',
] as const;
export const ResumeReasonSchema = z.enum(RESUME_REASONS);
export type ResumeReason = z.infer<typeof ResumeReasonSchema>;

/** Body of `GET /sessions/:sessionId/resume`: whether `claude --resume` may run, and whether a copy (`--fork-session`) may. */
export const ResumeEligibilitySchema = z.strictObject({
  sessionId: SessionIdSchema,
  allowed: z.boolean(),
  forkAllowed: z.boolean(),
  reason: ResumeReasonSchema.nullable(),
  /** The folder the terminal would start in. */
  folder: z.strictObject({ key: ProjectIdSchema, path: z.string().max(1024) }).nullable(),
  /** A `claude` outside this app (a user's own terminal, an editor) holds the session: only a copy is safe. */
  liveElsewhere: z.boolean(),
  /** The name of the terminal of this app that holds the session. */
  liveTerminal: z.string().min(1).max(64).nullable(),
  /** The session that continued this one, when the monitor knows it: resuming the old id branches off. */
  redirectTo: SessionIdSchema.nullable(),
});
export type ResumeEligibility = z.infer<typeof ResumeEligibilitySchema>;

export const LINK_STATUSES = ['pending', 'linked', 'ambiguous'] as const;
export const LinkStatusSchema = z.enum(LINK_STATUSES);
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

/** The evidence a link rests on, strongest first (design 03 section 5.2). */
export const LINK_BASES = [
  'registry-pid',
  'registry-tree',
  'registry-cwd',
  'registry-order',
  'resume-id',
  'transcript-time',
] as const;
export const LinkBasisSchema = z.enum(LINK_BASES);
export type LinkBasis = z.infer<typeof LinkBasisSchema>;

export const LINK_CONFIDENCES = ['high', 'medium', 'low'] as const;
export const LinkConfidenceSchema = z.enum(LINK_CONFIDENCES);
export type LinkConfidence = z.infer<typeof LinkConfidenceSchema>;

/** Why a terminal is not linked (yet). */
export const LINK_REASONS = ['no_registry', 'registry_unreadable', 'ambiguous'] as const;
export const LinkReasonSchema = z.enum(LINK_REASONS);
export type LinkReason = z.infer<typeof LinkReasonSchema>;

/** What the terminal host embeds in its session DTO: which monitored session a terminal's `claude` is, and how sure that is. */
export const TerminalLinkSchema = z.strictObject({
  status: LinkStatusSchema,
  sessionId: SessionIdSchema.nullable(),
  /** The ids the process had before a `/clear` or `/resume` inside it. */
  previousSessionIds: z.array(SessionIdSchema).max(8),
  basis: LinkBasisSchema.nullable(),
  confidence: LinkConfidenceSchema.nullable(),
  since: NullableIsoTimeSchema,
  claudePid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  /** `tracked` once the monitor has a session row for the transcript. */
  transcript: z.enum(['none', 'tracked']),
  registryStatus: z.enum(['busy', 'idle', 'waiting']).nullable(),
  /** What the process waits for (for example a permission prompt), clipped to 64 characters. */
  waitingFor: z.string().max(64).nullable(),
  reason: LinkReasonSchema.nullable(),
  /** Another live terminal of this app resolved to the same session id (a resume of a live session). */
  shared: z.boolean(),
});
export type TerminalLink = z.infer<typeof TerminalLinkSchema>;
