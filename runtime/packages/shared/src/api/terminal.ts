// Contracts of the terminal and the access code (CAW design 02 sections 2.1 and 2.3, 5.4 and 6): the session name, the
// access code and the folder path as the routes take them, the capabilities and the session row the sidebar lists, the
// bodies and responses of the ten access and terminal routes, the frames of the terminal socket (protocol v1) and the
// frames of the session event feed. Every object is strict: an extra key is `400 validation_failed` and names the issue
// code only, never the value. The folder rows, the link between a terminal and a monitored session and the resume
// eligibility belong to `folders.ts`; the login URL helpers and the shape of an access code to `../protocol/access.ts`.
import { z } from 'zod';

import { folderPathIssue } from '../folders/index.ts';
import { ACCESS_CODE_RE } from '../protocol/access.ts';
import { TerminalLinkSchema } from './folders.ts';
import { CountSchema, EpochSchema, InstanceIdSchema, ProjectIdSchema, SessionIdSchema } from './ids.ts';
import { IsoTimeSchema } from './time.ts';

// ---- names, codes and paths --------------------------------------------------------------------------------------------

/** The session name of MTOP: it appears in URLs and in the socket path, so no dot, slash, backslash, NUL or space. */
export const TERMINAL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const TerminalNameSchema = z.string().regex(TERMINAL_NAME_RE);

/** Path parameters of the routes that name one terminal session. */
export const TerminalNameParamsSchema = z.strictObject({ name: TerminalNameSchema });

/** An access code: the alphabet and the length of `ACCESS_CODE_RE` (this area mints 43 characters, 32 random bytes). */
export const AccessCodeSchema = z.string().regex(ACCESS_CODE_RE);

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * A folder path as a route takes or sends it: 1 to 1024 characters, no control character (NUL, a line break, DEL, C1) and
 * no UNC or device path (`\\host\share`, `//host`, `\\?\`, `\\.\`, `\??\`): Windows would try to reach another machine and
 * could leak credentials over SMB. The relative, drive and name rules are the engine's (`windowsFolderPath`), which answers
 * `folder_invalid` with a reason; the first two checks here keep the worst inputs out of every layer.
 */
export const FolderPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !CONTROL_CHARACTER.test(path), { error: 'A folder path has no control characters' })
  .refine(
    (path) => {
      const issue = folderPathIssue(path);
      return issue !== 'unc' && issue !== 'device';
    },
    { error: 'A folder on a network share or a device is not allowed' },
  );

// ---- bodies and responses ------------------------------------------------------------------------------------------------

/** The body of a POST that carries no data: `{}` and nothing else (an extra key is refused). */
export const EmptyBodySchema = z.strictObject({});

/** `GET /auth/session`: whether the request carries a valid session cookie. */
export const AuthSessionResponseSchema = z.strictObject({ authenticated: z.boolean() });

/** `POST /auth/exchange`: the one-time access code from the login URL. The cookie travels in `Set-Cookie`, not in the body. */
export const ExchangeBodySchema = z.strictObject({ code: AccessCodeSchema });
export const ExchangeResponseSchema = z.strictObject({ authenticated: z.literal(true) });

/** `POST /auth/logout`: the session is revoked and the cookie cleared. */
export const LogoutResponseSchema = z.strictObject({ authenticated: z.literal(false) });

/** Why a terminal cannot run on this system (the capabilities say it; the routes answer `terminal_unavailable`). */
export const TERMINAL_UNAVAILABLE_REASONS = [
  'unsupported_os',
  'addon_missing',
  'claude_not_found',
  'not_configured',
] as const;
export const TerminalUnavailableReasonSchema = z.enum(TERMINAL_UNAVAILABLE_REASONS);
export type TerminalUnavailableReason = z.infer<typeof TerminalUnavailableReasonSchema>;

export const TerminalCapabilitiesSchema = z.strictObject({
  available: z.boolean(),
  reason: TerminalUnavailableReasonSchema.nullable(),
  folderPicker: z.boolean(),
  resume: z.boolean(),
  maxSessions: CountSchema,
});
export type TerminalCapabilities = z.infer<typeof TerminalCapabilitiesSchema>;

/** The most sessions a list carries (the largest value of `terminal.maxSessions`). */
const MAX_LISTED_SESSIONS = 64;

/**
 * One live terminal. `link` says which monitored session the process is (the transcript-derived state and tokens come from
 * the monitor, not from here); `folderKey` is the project key of the working folder (the key of a `listFolders` row),
 * `null` when the host could not derive one. There is no separate monitor session id: it is `link.sessionId`.
 */
export const TerminalSessionInfoSchema = z.strictObject({
  name: TerminalNameSchema,
  path: FolderPathSchema,
  createdAt: IsoTimeSchema,
  cols: CountSchema,
  rows: CountSchema,
  viewers: CountSchema,
  link: TerminalLinkSchema,
  folderKey: ProjectIdSchema.nullable(),
});
export type TerminalSessionInfo = z.infer<typeof TerminalSessionInfoSchema>;

/** `GET /terminal/state`: what the host can do and the live sessions (the folders are `listFolders`). */
export const TerminalStateSchema = z.strictObject({
  capabilities: TerminalCapabilitiesSchema,
  sessions: z.array(TerminalSessionInfoSchema).max(MAX_LISTED_SESSIONS),
  epoch: EpochSchema,
  generatedAt: IsoTimeSchema,
});
export type TerminalState = z.infer<typeof TerminalStateSchema>;

/** `POST /terminal/sessions`: start `claude` in a folder. Never a command line, arguments or an environment. */
export const CreateSessionBodySchema = z.strictObject({ path: FolderPathSchema });
export const CreateSessionResponseSchema = z.strictObject({ session: TerminalSessionInfoSchema });

/** `POST /terminal/sessions/:name/kill`. */
export const KillSessionResponseSchema = z.strictObject({ name: TerminalNameSchema });

/** `POST /terminal/pick-folder`: the folder the person chose in the dialog, or `null` when the dialog was closed. */
export const PickFolderResponseSchema = z.strictObject({ path: FolderPathSchema.nullable() });

/**
 * `POST /terminal/resume`: `claude --resume <id>` for a monitored session, with `--fork-session` when `fork` is true. The
 * engine plans the folder and the arguments itself.
 */
export const ResumeBodySchema = z.strictObject({ sessionId: SessionIdSchema, fork: z.boolean().optional() });
export const ResumeResponseSchema = z.strictObject({ session: TerminalSessionInfoSchema });

// ---- the terminal size ---------------------------------------------------------------------------------------------------

/** The clamps and the default of a terminal, in character cells (the values of MTOP). */
export const TERMINAL_SIZE_LIMITS = {
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 200,
  defaultCols: 120,
  defaultRows: 30,
} as const;

function clampCells(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** A size inside `TERMINAL_SIZE_LIMITS`; a value that is not a finite number becomes the default, a fraction is cut. */
export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  const limits = TERMINAL_SIZE_LIMITS;
  return {
    cols: clampCells(cols, limits.minCols, limits.maxCols, limits.defaultCols),
    rows: clampCells(rows, limits.minRows, limits.maxRows, limits.defaultRows),
  };
}

// ---- the socket (protocol v1, design 02 5.4) -----------------------------------------------------------------------------

/** The subprotocol of `GET /terminal/sessions/:name/socket`; a handshake that does not offer it is refused. */
export const TERMINAL_SUBPROTOCOL = 'caw.terminal.v1';

/**
 * The most bytes one input message may carry: one limit for the whole path (the gateway payload, the session write and the
 * default and maximum of `terminal.maxInputBytes`). The web client sends a larger paste in chunks.
 */
export const TERMINAL_INPUT_MAX_BYTES = 262_144;

/** The longest text frame a client may send; a longer one closes the socket (1009). */
export const TERMINAL_TEXT_FRAME_MAX_BYTES = 256;

/**
 * The close codes the socket uses. 1000 to 1013 are the standard ones (`1008 bad_message`, `1013 slow_consumer`: the
 * reason strings are fixed tokens, never request data); 4000 to 4003 are ours. The client tells them apart by number:
 * `exited` and `killed` end the view, `signedOut` shows the locked state, `shuttingDown` and `slowConsumer` reconnect.
 */
export const TERMINAL_CLOSE_CODES = {
  normal: 1000,
  shuttingDown: 1001,
  protocolError: 1002,
  badMessage: 1008,
  tooBig: 1009,
  internalError: 1011,
  slowConsumer: 1013,
  exited: 4000,
  killed: 4001,
  signedOut: 4003,
} as const;

/** A dimension on the wire: the client may ask for 1 to 1000 cells and the server clamps it to `TERMINAL_SIZE_LIMITS`. */
const DimensionSchema = z.number().int().min(1).max(1000);

/** The one text frame a client sends: its size, as `{"type":"resize","cols":n,"rows":n}`. Input is binary, never text. */
export const TerminalClientMessageSchema = z.strictObject({
  type: z.literal('resize'),
  cols: DimensionSchema,
  rows: DimensionSchema,
});
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

/**
 * The text frames the server sends: `ready` before any byte, `live` once the replay is sent, `size` when any viewer
 * resizes, `exit` after the last output. A text frame is never terminal output (that is binary).
 */
export const TerminalServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    v: z.literal(1),
    cols: DimensionSchema,
    rows: DimensionSchema,
    replayBytes: CountSchema,
    viewers: CountSchema,
  }),
  z.strictObject({ type: z.literal('live') }),
  z.strictObject({ type: z.literal('size'), cols: DimensionSchema, rows: DimensionSchema }),
  z.strictObject({
    type: z.literal('exit'),
    code: z.number().int().nullable(),
    signal: z.string().min(1).max(32).nullable(),
  }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;

// ---- the session event feed (design 02 6) ------------------------------------------------------------------------------

/** The named server-sent events of `GET /terminal/events`, in the order a client sees them first. */
export const TERMINAL_EVENT_NAMES = ['hello', 'sessions', 'heartbeat'] as const;

export const TerminalHelloEventSchema = z.strictObject({
  instanceId: InstanceIdSchema,
  epoch: EpochSchema,
  serverTime: IsoTimeSchema,
  heartbeatMs: CountSchema,
});
export type TerminalHelloEvent = z.infer<typeof TerminalHelloEventSchema>;

/** The full list of live sessions (latest wins: a client keeps only the newest `version`). */
export const TerminalSessionsEventSchema = z.strictObject({
  version: CountSchema,
  sessions: z.array(TerminalSessionInfoSchema).max(MAX_LISTED_SESSIONS),
});
export type TerminalSessionsEvent = z.infer<typeof TerminalSessionsEventSchema>;

export const TerminalHeartbeatEventSchema = z.strictObject({ serverTime: IsoTimeSchema });
export type TerminalHeartbeatEvent = z.infer<typeof TerminalHeartbeatEventSchema>;

/** The data schema of every event name of the feed. */
export const TerminalEventSchemas = {
  hello: TerminalHelloEventSchema,
  sessions: TerminalSessionsEventSchema,
  heartbeat: TerminalHeartbeatEventSchema,
} as const;
