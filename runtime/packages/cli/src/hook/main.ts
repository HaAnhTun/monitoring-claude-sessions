// The hook handler (02 2.1-2.4, 2.11): stamps an envelope, routes it to the matching instance spools and nudges the
// servers. Always silent, always exit 0. Imports only node:*, @mcs/shared/protocol and ./ (fast start, no zod, no engine).
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  AGENT_RE,
  EVENT_NAME_RE,
  HANDLER_HARD_EXIT_MS,
  HANDLER_VERSION,
  HOOK_EVENT_POLICY,
  HOOK_ENVELOPE_VERSION,
  NAME_MAX_CHARS,
  PATH_MAX_CHARS,
  PROBE_NOTIFICATION_TYPE,
  PROBE_SESSION_PREFIX,
  RUN_ID_RE,
  SID_RE,
  STDIN_MAX_BYTES,
  SUMMARY_MAX_CP,
  TITLE_MAX_CP,
  TOOL_ID_RE,
  UNKNOWN_HOOK_EVENT_POLICY,
  canonicalJsonHash,
  clip,
  isInstalledHookEvent,
  matchRoute,
  normalizePath,
  redactDetailed,
  resolveMcsHome,
  summarizeToolInputDetailed,
  type EnvLike,
  type EnvelopeDataValue,
  type HookEnvelopeV1,
  type HookRouteV1,
  type KeptField,
  type RouteMatchVia,
} from '@mcs/shared/protocol';

import { logHandler, type HandlerLogCode } from './handler-log.ts';
import { nudgeAll, readNudgeTarget, type NudgeTarget } from './nudge.ts';
import { readRoutes } from './routes-reader.ts';
import { appendEnvelope } from './spool-writer.ts';

const MAX_FLAGS = 32;
const MAX_UNKNOWN_KEYS = 32;
const MAX_CALLS = 64;
const MAX_TOOL_INPUT_KEYS = 16;
/** Source text handed to `redactDetailed`: previews are far shorter, so a longer body is cut before the work starts. */
const PREVIEW_SOURCE_MAX_UNITS = 8192;
const EXIT_CODE_RE = /^Exit code ([0-9]{1,5})$/;
const CLAUDE_PID_RE = /^[0-9]{1,10}$/;

type Payload = Record<string, unknown>;
type Data = Record<string, EnvelopeDataValue>;

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- argv ---------------------------------------------------------------------------------------------------------

export interface HookArgv {
  /** `--mcs-hook` is present: hook mode. */
  hookMode: boolean;
  /** The event the entry was installed for, or `''`. */
  event: string;
  async: boolean;
}

export function parseArgv(argv: readonly string[]): HookArgv {
  const at = argv.indexOf('--mcs-hook');
  const next = at < 0 ? undefined : argv[at + 1];
  return {
    hookMode: at >= 0,
    event: next !== undefined && EVENT_NAME_RE.test(next) ? next : '',
    async: argv.includes('--async'),
  };
}

// ---- stdin --------------------------------------------------------------------------------------------------------

export interface StdinResult {
  /** The first `maxBytes` bytes. */
  kept: Buffer;
  /** All bytes seen, also beyond the cap. */
  total: number;
}

/** Reads `stream` to its end, keeping at most `maxBytes`. Resolves on end, close or error: the caller never blocks on it. */
export function readStdin(stream: Readable, maxBytes: number): Promise<StdinResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let total = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve({ kept: Buffer.concat(chunks), total });
    };
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buffer.length;
      if (kept < maxBytes) {
        const part = buffer.subarray(0, maxBytes - kept);
        chunks.push(part);
        kept += part.length;
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

// ---- ids (02 2.3.2) -----------------------------------------------------------------------------------------------

export interface HookIds {
  session_id: string | null;
  transcript_path: string | null;
  cwd: string | null;
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  permission_mode: string | null;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `[value, valid]`: `null` and a missing field are `null` and valid; anything else that fails the check is `null` and invalid. */
function checked(value: unknown, accept: (text: string) => string | null): [string | null, boolean] {
  if (value === undefined || value === null) return [null, true];
  if (typeof value !== 'string') return [null, false];
  const accepted = accept(value);
  return accepted === null ? [null, false] : [accepted, true];
}

const byPattern =
  (re: RegExp) =>
  (text: string): string | null =>
    re.test(text) ? text : null;

const asName = (text: string): string | null =>
  text.length <= NAME_MAX_CHARS && !hasControlCharacter(text) ? text : null;

const asPath = (text: string): string | null => {
  const normalized = normalizePath(text);
  return normalized !== '' && normalized.length <= PATH_MAX_CHARS ? normalized : null;
};

/** The routing and correlation ids of a payload; a field that fails its check is `null` and adds `invalid_<field>`. */
export function extractIds(payload: Payload): { ids: HookIds; flags: string[] } {
  const flags: string[] = [];
  const pick = (field: keyof HookIds, accept: (text: string) => string | null): string | null => {
    const [value, valid] = checked(payload[field], accept);
    if (!valid) flags.push(`invalid_${field}`);
    return value;
  };
  const ids: HookIds = {
    session_id: pick('session_id', byPattern(SID_RE)),
    transcript_path: pick('transcript_path', asPath),
    cwd: pick('cwd', asPath),
    prompt_id: pick('prompt_id', byPattern(TOOL_ID_RE)),
    agent_id: pick('agent_id', byPattern(AGENT_RE)),
    agent_type: pick('agent_type', asName),
    tool_use_id: pick('tool_use_id', byPattern(TOOL_ID_RE)),
    permission_mode: pick('permission_mode', asName),
  };
  return { ids, flags };
}

// ---- data (02 2.4) ------------------------------------------------------------------------------------------------

/** Code points of `text` without building an array (a prompt can be megabytes). */
function codePointLength(text: string): number {
  let count = text.length;
  for (let i = 1; i < text.length; i += 1) {
    const high = text.charCodeAt(i - 1);
    const low = text.charCodeAt(i);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      count -= 1;
      i += 1;
    }
  }
  return count;
}

function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function keptValue(field: KeptField, value: unknown): EnvelopeDataValue | undefined {
  switch (field.kind) {
    case 'string':
      return typeof value === 'string' ? cutUnits(value, field.maxChars ?? NAME_MAX_CHARS) : undefined;
    case 'path': {
      if (typeof value !== 'string') return undefined;
      const normalized = normalizePath(value);
      return normalized === '' ? undefined : cutUnits(normalized, field.maxChars ?? PATH_MAX_CHARS);
    }
    case 'int':
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
  }
}

function intOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function shortString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? cutUnits(value, max) : undefined;
}

function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

/** `undefined` values are not stored. */
function put(data: Data, key: string, value: EnvelopeDataValue | undefined): void {
  if (value !== undefined) data[key] = value;
}

function preview(value: unknown, max: number, flags: Set<string>): string | undefined {
  if (typeof value !== 'string') return undefined;
  const { text, redacted } = redactDetailed(cutUnits(value, PREVIEW_SOURCE_MAX_UNITS));
  if (redacted) flags.add('redacted');
  return clip(text, max);
}

function lengthOf(value: unknown): number | undefined {
  return typeof value === 'string' ? codePointLength(value) : undefined;
}

function countOf(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function toolInput(payload: Payload, data: Data, flags: Set<string>, withBytes: boolean): void {
  const input = payload['tool_input'];
  if (input === undefined) return;
  const summary = summarizeToolInputDetailed(input);
  if (summary.redacted) flags.add('redacted');
  data['tool_summary'] = summary.text;
  data['tool_input_hash'] = canonicalJsonHash(input);
  if (!withBytes) return;
  data['tool_input_bytes'] = jsonBytes(input);
  data['tool_input_keys'] = isRecord(input) ? Object.keys(input).slice(0, MAX_TOOL_INPUT_KEYS).join(',') : '';
}

function preToolUse(payload: Payload, data: Data, flags: Set<string>): void {
  toolInput(payload, data, flags, true);
  const input = payload['tool_input'];
  if (!isRecord(input)) return;
  const tool = payload['tool_name'];
  if (tool === 'Agent') {
    put(data, 'subagent_type', shortString(input['subagent_type'], 64));
    const background = input['run_in_background'];
    if (typeof background === 'boolean') data['run_in_background'] = background;
  } else if (tool === 'Workflow') {
    put(data, 'workflow_name', shortString(input['name'], 128));
  }
}

function postToolUse(payload: Payload, data: Data): void {
  const response = payload['tool_response'];
  if (response !== undefined) data['response_bytes'] = jsonBytes(response);
  const tool = payload['tool_name'];
  if (!isRecord(response)) return;
  if (tool === 'Agent') {
    const agentId = response['agentId'];
    if (typeof agentId === 'string' && AGENT_RE.test(agentId)) data['agent_link_id'] = agentId;
    put(data, 'agent_status', shortString(response['status'], 32));
    put(data, 'agent_total_tokens', intOrUndefined(response['totalTokens']));
    put(data, 'agent_total_duration_ms', intOrUndefined(response['totalDurationMs']));
    put(data, 'agent_tool_use_count', intOrUndefined(response['totalToolUseCount']));
  } else if (tool === 'Workflow') {
    const runId = response['runId'];
    if (typeof runId === 'string' && RUN_ID_RE.test(runId)) data['run_id'] = runId;
    put(data, 'run_status', shortString(response['status'], 32));
    put(data, 'task_id', shortString(response['taskId'], 128));
  } else if (tool === 'Bash') {
    const interrupted = response['interrupted'];
    if (typeof interrupted === 'boolean') data['interrupted'] = interrupted;
  }
}

function toolFailure(payload: Payload, data: Data): void {
  const error = payload['error'];
  if (typeof error !== 'string') return;
  const firstLine = error.split(String.fromCharCode(10), 1)[0] ?? '';
  const code = EXIT_CODE_RE.exec(firstLine.endsWith(String.fromCharCode(13)) ? firstLine.slice(0, -1) : firstLine);
  if (code?.[1] !== undefined) data['exit_code'] = Number(code[1]);
  data['error_len'] = codePointLength(error);
}

function toolBatch(payload: Payload, data: Data, flags: Set<string>): void {
  const calls = payload['tool_calls'];
  if (!Array.isArray(calls)) return;
  const list: unknown[] = calls;
  const kept = list.slice(0, MAX_CALLS).map((call): Record<string, string | null> => {
    const record = isRecord(call) ? call : {};
    const id = record['tool_use_id'];
    return {
      tool_use_id: typeof id === 'string' && TOOL_ID_RE.test(id) ? id : null,
      tool_name: shortString(record['tool_name'], 128) ?? null,
    };
  });
  data['calls'] = kept;
  if (list.length > MAX_CALLS) flags.add('data_truncated:calls');
}

function stopSummary(payload: Payload, data: Data): void {
  put(data, 'last_message_len', lengthOf(payload['last_assistant_message']));
  put(data, 'background_task_count', countOf(payload['background_tasks']));
  put(data, 'cron_count', countOf(payload['session_crons']));
}

function summarize(event: string, payload: Payload, data: Data, flags: Set<string>): void {
  switch (event) {
    case 'SessionStart':
      put(data, 'session_title_len', lengthOf(payload['session_title']));
      return;
    case 'UserPromptSubmit': {
      const prompt = payload['prompt'];
      if (typeof prompt === 'string') {
        data['prompt_len'] = codePointLength(prompt);
        data['prompt_slash'] = prompt.trimStart().startsWith('/');
      }
      put(data, 'session_title_len', lengthOf(payload['session_title']));
      return;
    }
    case 'PreToolUse':
      preToolUse(payload, data, flags);
      return;
    case 'PermissionRequest':
      toolInput(payload, data, flags, false);
      put(data, 'suggestion_count', countOf(payload['permission_suggestions']));
      return;
    case 'PermissionDenied':
      put(data, 'reason_preview', preview(payload['reason'], SUMMARY_MAX_CP, flags));
      return;
    case 'PostToolUse':
      postToolUse(payload, data);
      return;
    case 'PostToolUseFailure':
      toolFailure(payload, data);
      return;
    case 'PostToolBatch':
      toolBatch(payload, data, flags);
      return;
    case 'Notification': {
      put(data, 'title_preview', preview(payload['title'], TITLE_MAX_CP, flags));
      put(data, 'message_preview', preview(payload['message'], SUMMARY_MAX_CP, flags));
      put(data, 'message_len', lengthOf(payload['message']));
      return;
    }
    case 'SubagentStop':
    case 'Stop':
      stopSummary(payload, data);
      return;
    case 'TaskCreated':
    case 'TaskCompleted':
      put(data, 'subject_preview', preview(payload['task_subject'], SUMMARY_MAX_CP, flags));
      put(data, 'description_len', lengthOf(payload['task_description']));
      return;
    case 'StopFailure':
      put(data, 'error_preview', preview(payload['error_details'], SUMMARY_MAX_CP, flags));
      put(data, 'last_message_len', lengthOf(payload['last_assistant_message']));
      return;
    case 'PreCompact':
      put(data, 'custom_instructions_len', lengthOf(payload['custom_instructions']));
      return;
    case 'PostCompact':
      put(data, 'compact_summary_len', lengthOf(payload['compact_summary']));
      return;
    default:
      return;
  }
}

/**
 * The `data` of an envelope (02 2.4): the kept fields of the event verbatim and capped, the derived values of the summarized
 * ones, nothing else. A name that is not an installed event keeps only the top-level key names. Every free-text body is
 * dropped; previews pass through `redact()`. Returns the flags it raised (`redacted`, `data_truncated:<field>`).
 */
export function sanitizeEventData(event: string, payload: Payload): { data: Data; flags: string[] } {
  const data: Data = {};
  const flags = new Set<string>();
  const policy = isInstalledHookEvent(event) ? HOOK_EVENT_POLICY[event] : UNKNOWN_HOOK_EVENT_POLICY;
  for (const field of policy.kept) put(data, field.name, keptValue(field, payload[field.name]));
  if (isInstalledHookEvent(event)) {
    summarize(event, payload, data, flags);
  } else {
    const names = Object.keys(payload);
    data['data_keys'] = names
      .slice(0, MAX_UNKNOWN_KEYS)
      .map((name) => cutUnits(name, NAME_MAX_CHARS))
      .join(',');
    if (names.length > MAX_UNKNOWN_KEYS) flags.add('data_truncated:data_keys');
  }
  const effort = payload['effort'];
  if (isRecord(effort)) put(data, 'effort_level', shortString(effort['level'], 16));
  return { data, flags: [...flags] };
}

// ---- envelope (02 2.3) --------------------------------------------------------------------------------------------

/** What every routed copy of one event shares. */
export interface EnvelopeBase {
  kind: 'hook' | 'probe';
  eventUid: string;
  receivedAt: number;
  event: string;
  argvEvent: string;
  ids: HookIds;
  claudePid: number | null;
  payloadBytes: number;
  contentHash: string;
  handler: { version: string; pid: number; async: boolean };
  flags: string[];
  data: Data;
}

const VIA_FLAG: Record<Exclude<RouteMatchVia, 'transcript'>, string> = {
  session_pin: 'routed_by_session_pin',
  cwd: 'routed_by_cwd',
};

/** The envelope for one matched route: the shared fields, `instance_id`, and the `routed_by_*` flag of how it matched. */
export function buildEnvelope(base: EnvelopeBase, instanceId: string, via: RouteMatchVia): HookEnvelopeV1 {
  const flags = [...base.flags];
  if (via !== 'transcript') flags.push(VIA_FLAG[via]);
  return {
    v: HOOK_ENVELOPE_VERSION,
    kind: base.kind,
    instance_id: instanceId,
    event_uid: base.eventUid,
    received_at: base.receivedAt,
    event: base.event,
    argv_event: base.argvEvent,
    ...base.ids,
    claude_pid: base.claudePid,
    payload_bytes: base.payloadBytes,
    content_hash: base.contentHash,
    handler: base.handler,
    flags: [...new Set(flags)].slice(0, MAX_FLAGS),
    data: base.data,
  };
}

// ---- the run ------------------------------------------------------------------------------------------------------

/** What the handler needs from its process; tests pass their own. */
export interface HookDeps {
  env: EnvLike;
  now: () => number;
  pid: number;
  /** True when stdin is a terminal (a manual run): nothing to read. */
  stdinIsTty: boolean;
  readStdin: (maxBytes: number) => Promise<StdinResult>;
}

function parsePayload(bytes: Buffer): Payload | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isProbe(ids: HookIds, event: string, payload: Payload): boolean {
  return (
    ids.session_id?.startsWith(PROBE_SESSION_PREFIX) === true &&
    event === 'Notification' &&
    payload['notification_type'] === PROBE_NOTIFICATION_TYPE
  );
}

/**
 * Steps 2-13 of 02 2.2 without the process-level parts (timers, exit): returns when the handler is done. Never throws for
 * input reasons; an unexpected error propagates to `runHook`, which logs `UNCAUGHT` and exits 0.
 */
export async function handleHook(argv: readonly string[], deps: HookDeps): Promise<void> {
  const t0 = deps.now();
  const args = parseArgv(argv);
  if (!args.hookMode) return;
  if (deps.env['MCS_HOOK_DISABLE'] === '1') {
    if (!deps.stdinIsTty) await deps.readStdin(0);
    return;
  }
  if (deps.stdinIsTty) return;
  const stdin = await deps.readStdin(STDIN_MAX_BYTES);

  let mcsHome: string;
  try {
    mcsHome = resolveMcsHome(deps.env);
  } catch {
    return;
  }
  const log = (code: HandlerLogCode, detail: string, instanceId: string | null = null, event = args.event): void => {
    logHandler(mcsHome, { code, event, instanceId, detail }, deps.now(), deps.pid);
  };
  const routes = readRoutes(mcsHome, (problem) => {
    log(problem.code, problem.detail);
  });
  if (routes.length === 0) return;

  const payload = parsePayload(stdin.kept);
  if (payload === null) {
    log('STDIN_PARSE_ERROR', '');
    return;
  }
  const { ids, flags: idFlags } = extractIds(payload);
  const matched: { route: HookRouteV1; via: RouteMatchVia }[] = [];
  for (const route of routes) {
    const via = matchRoute(route, ids, t0);
    if (via !== null) matched.push({ route, via });
  }
  if (matched.length === 0) return;

  const named = payload['hook_event_name'];
  const event =
    typeof named === 'string' && EVENT_NAME_RE.test(named) ? named : args.event !== '' ? args.event : 'Unknown';
  const flags = [...(stdin.total > STDIN_MAX_BYTES ? ['stdin_truncated'] : []), ...idFlags];
  if (args.event !== '' && event !== args.event) flags.push('event_mismatch');
  // A hostile nesting depth can overflow the stack inside the summarizer; the lifecycle signal must still be spooled.
  let sanitized: { data: Data; flags: string[] };
  try {
    sanitized = sanitizeEventData(event, payload);
  } catch (error) {
    log('UNCAUGHT', `sanitize: ${error instanceof Error ? error.name : 'unknown'}`, undefined, event);
    sanitized = { data: {}, flags: ['data_truncated:data'] };
  }
  flags.push(...sanitized.flags);
  const pidText = deps.env['CLAUDE_PID'];
  const base: EnvelopeBase = {
    kind: isProbe(ids, event, payload) ? 'probe' : 'hook',
    eventUid: randomUUID(),
    receivedAt: t0,
    event,
    argvEvent: args.event,
    ids,
    claudePid: pidText !== undefined && CLAUDE_PID_RE.test(pidText) ? Number(pidText) : null,
    payloadBytes: stdin.total,
    contentHash: createHash('sha256').update(stdin.kept).digest('hex').slice(0, 32),
    handler: { version: HANDLER_VERSION, pid: deps.pid, async: args.async },
    flags,
    data: sanitized.data,
  };

  const targets: NudgeTarget[] = [];
  for (const { route, via } of matched) {
    const result = appendEnvelope(route, buildEnvelope(base, route.instanceId, via));
    if (result.outcome === 'full') log('SPOOL_FULL', result.detail, route.instanceId, event);
    else if (result.outcome === 'failed') log('SPOOL_WRITE_FAILED', result.detail, route.instanceId, event);
    const target = readNudgeTarget(route);
    if (target !== null) targets.push(target);
  }
  await nudgeAll(targets);
}

/** `process.stdin.isTTY` is undefined (not false) for a pipe or a file, and reading `process.stdin` can throw without a stdin. */
function isTerminal(): boolean {
  try {
    const flag: unknown = Reflect.get(process.stdin, 'isTTY');
    return flag === true;
  } catch {
    return false;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The handler entry (02 2.2): arms the hard exit, handles every error, and exits 0 when done. It prints nothing, ever.
 * `argv` is the argument list after the script name.
 */
export async function runHook(argv: string[]): Promise<void> {
  // From process start, not from now: the import of this module has already used part of the budget.
  const remaining = Math.max(200, HANDLER_HARD_EXIT_MS - performance.now());
  setTimeout(() => process.exit(0), remaining).unref();
  const eventName = parseArgv(argv).event;
  const fatal = (error: unknown): void => {
    try {
      logHandler(resolveMcsHome(process.env), {
        code: 'UNCAUGHT',
        event: eventName,
        instanceId: null,
        detail: errorName(error),
      });
    } finally {
      process.exit(0);
    }
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  try {
    await handleHook(argv, {
      env: process.env,
      now: Date.now,
      pid: process.pid,
      stdinIsTty: isTerminal(),
      readStdin: (maxBytes) => readStdin(process.stdin, maxBytes),
    });
  } catch (error) {
    fatal(error);
  }
  process.exit(0);
}
