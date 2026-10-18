// Transcript record -> logical events and `events` rows (02 5.6, 5.7, 4.1.2; ADR 0016).
//
// Pure: no clock, no file, no database. A record is read once and only metadata leaves this module: ids, kinds, lengths,
// the 160 code point redacted summary of a tool input and its hash, labels and titles. Prompt and assistant text, thinking
// text and signatures, tool inputs and results, `toolUseResult`, attachment bodies, account ids and every other body of
// 02 5.7 are never copied into an event or a row (T-TR-16). Records without a valid `timestamp` produce nothing stamped.
import { TranscriptRecordShape, type EventKind } from '@mcs/shared';
import {
  AGENT_RE,
  RUN_ID_RE,
  SID_RE,
  TOOL_ID_RE,
  canonicalJsonHash,
  redact,
  summarizeToolInput,
  type Stamp,
} from '@mcs/shared/protocol';

import { clipCodePoints } from '../../platform/fsx.ts';
import {
  ROW_LIMITS,
  eventRow,
  promptKey,
  toolCallKey,
  toolEndKey,
  type EntryKind,
  type EventRowInit,
  type EventRowWrite,
  type LogicalEvent,
  type ToolOutcome,
} from '../event-row.ts';
import type { RawLine } from '../tail/line-splitter.ts';
import { parseTaskNotification } from './task-notification.ts';

/** A record that passed `TranscriptRecordShape` (loose: unknown keys pass through and are read through `rec['key']`). */
export type TranscriptRecord = ReturnType<typeof TranscriptRecordShape.parse>;

/** One entry of `message.content` (a loose object with a `type`). */
export type ContentBlockRef = Readonly<Record<string, unknown>> & { readonly type: string };

/** The file a record is read from. The session id comes from the DIRECTORY and the agent id from the file name (02 5.6). */
export interface TrackedFile {
  fileId: number;
  kind: 'session' | 'subagent' | 'workflow_agent' | 'workflow_journal' | 'workflow_status';
  sessionId: string;
  /** Null for the main session file. */
  agentId: string | null;
  /** Set for `workflow_agent` and `workflow_journal` files. */
  runId: string | null;
}

/** Where the record's line is in the file. */
export interface RecordPosition {
  offset: number;
  length: number;
  lineNo: number;
}

/** What `normalizeRecord` remembers between records of ONE file (titles already emitted, journal progress). */
export interface NormalizerState {
  titles: Map<string, string>;
  journal: Map<string, { started: Set<string>; results: Set<string>; failed: Set<string> }>;
}

export function createNormalizerState(): NormalizerState {
  return { titles: new Map(), journal: new Map() };
}

export interface NormalizeOptions {
  state?: NormalizerState;
  /** Import time, ms: the `received_at` of transcript rows (default: the record's own time) and a journal's `observedAt`. */
  nowMs?: number;
}

export interface NormalizedRecord {
  events: LogicalEvent[];
  rows: EventRowWrite[];
  /** The `type` of a record this design does not know (counted by the caller). */
  unknownType: string | null;
  /** The `attachment.type` of an attachment that is neither stored nor mapped (counted by the caller). */
  ignoredAttachment: string | null;
}

// ---- small readers (everything below `rec['x']` is unknown) ------------------------------------------------------------

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A safe non-negative integer (02 4.2: numbers taken from records are re-checked at use). */
function nOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && TOOL_ID_RE.test(value) ? value : null;
}

/** Number of code points of `text` (what the legacy `len()` counts). */
function cpLen(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const hi = text.charCodeAt(i);
    if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

const INTERRUPT_PREFIX = '[Request interrupted by user';
const SYNTHETIC_MODEL = '<synthetic>';
const TITLE_MAX_CP = 120;
/** `turns.origin` CHECK (03): 32 characters. */
const ORIGIN_MAX_CP = 32;
const OUR_HOOK_MARKER = '--mcs-hook';

// ---- classification --------------------------------------------------------------------------------------------------

function blocksOf(rec: TranscriptRecord): readonly ContentBlockRef[] {
  const content = rec.message?.content;
  return Array.isArray(content) ? content : [];
}

/** The string content, or the first text block (02 5.6); null when there is no text. */
function firstText(rec: TranscriptRecord): string | null {
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  for (const block of blocksOf(rec)) {
    const text = block['text'];
    if (block.type === 'text' && typeof text === 'string') return text;
  }
  return null;
}

type UserClass =
  | { kind: 'meta' }
  | { kind: 'tool_result'; blocks: readonly ContentBlockRef[] }
  | { kind: 'interrupt' }
  | { kind: 'prompt'; text: string }
  | { kind: 'other' };

function classifyUser(rec: TranscriptRecord): UserClass {
  if (rec.isMeta === true || rec.isCompactSummary === true) return { kind: 'meta' };
  const results = blocksOf(rec).filter((b) => b.type === 'tool_result');
  if (results.length > 0) return { kind: 'tool_result', blocks: results };
  const text = firstText(rec);
  if (text === null) return { kind: 'other' };
  return text.startsWith(INTERRUPT_PREFIX) ? { kind: 'interrupt' } : { kind: 'prompt', text };
}

function toolOutcomeOf(rec: TranscriptRecord, block: ContentBlockRef): ToolOutcome {
  if (sOf(rec.toolDenialKind) !== undefined) return 'denied';
  return block['is_error'] === true ? 'error' : 'ok';
}

function isTaskNotification(rec: TranscriptRecord): boolean {
  return rec.origin?.kind === 'task-notification';
}

function isOurHookError(att: Rec): boolean {
  const command = att['command'];
  return att['type'] === 'hook_non_blocking_error' && typeof command === 'string' && command.includes(OUR_HOOK_MARKER);
}

/** First block of an assistant record that this design stores (`tool_use`, `text`, `thinking`), or null. */
function storedAssistantBlock(rec: TranscriptRecord): ContentBlockRef | null {
  if (typeof rec.message?.content === 'string') return { type: 'text', text: rec.message.content };
  for (const block of blocksOf(rec)) {
    if (
      block.type === 'tool_use' ||
      block.type === 'text' ||
      block.type === 'thinking' ||
      block.type === 'redacted_thinking'
    ) {
      return block;
    }
  }
  return null;
}

/**
 * Stored kind of a record, or of one block of it (02 4.1.2, 5.6). Null where the table says "no row". `block` is the
 * `tool_result`, `tool_use`, `text` or `thinking` block the row is about; null takes the first stored block.
 */
export function eventKindOfRecord(
  rec: TranscriptRecord,
  block: ContentBlockRef | null,
  file: TrackedFile,
): EventKind | null {
  if (file.kind === 'workflow_journal' || file.kind === 'workflow_status') return null;
  switch (rec.type) {
    case 'user': {
      const cls = classifyUser(rec);
      if (cls.kind === 'meta') return null;
      if (block?.type === 'tool_result' || cls.kind === 'tool_result') {
        const target = block ?? (cls.kind === 'tool_result' ? cls.blocks[0] : undefined);
        return target === undefined || toolOutcomeOf(rec, target) === 'ok' ? 'tool.result' : 'tool.failure';
      }
      if (cls.kind === 'interrupt') return 'turn.interrupt';
      if (cls.kind === 'prompt') return isTaskNotification(rec) ? 'agent.notification' : 'prompt.submit';
      return null;
    }
    case 'assistant': {
      const target = block ?? storedAssistantBlock(rec);
      if (target === null) return null;
      if (target.type === 'tool_use') return 'tool.call';
      if (target.type === 'text') return rec.isApiErrorMessage === true ? 'api.error' : 'assistant.message';
      if (target.type === 'thinking' || target.type === 'redacted_thinking') return 'assistant.thinking';
      return null;
    }
    case 'system':
      if (rec.subtype === 'turn_duration') return 'turn.duration';
      if (rec.subtype === 'compact_boundary') return 'context.compact';
      return 'system.info';
    case 'attachment': {
      const att = rec.attachment;
      if (att === undefined) return null;
      if (isOurHookError(att)) return 'hook.handler_error';
      if (att.type === 'queued_command') return 'prompt.queued';
      if (att.type === 'task_status') return 'system.info';
      if (att.type === 'structured_output' && file.kind === 'workflow_agent') return 'agent.final';
      return null;
    }
    default:
      return null;
  }
}

// ---- the normalization ------------------------------------------------------------------------------------------------

/** Transcript ranks (02 4.3): user prompt 10, assistant 20, tool_result 30, attachment 50, compact 52, system 58, turn_duration 61. */
const RANK = {
  user: 10,
  assistant: 20,
  toolResult: 30,
  attachment: 50,
  compact: 52,
  system: 58,
  turnDuration: 61,
} as const;

interface Ctx {
  readonly rec: TranscriptRecord;
  readonly file: TrackedFile;
  readonly at: RecordPosition;
  readonly sid: string;
  /** Agent of the file (null for the main session file). */
  readonly agentId: string | null;
  readonly state: NormalizerState;
  readonly nowMs: number | undefined;
  readonly events: LogicalEvent[];
  readonly rows: EventRowWrite[];
}

function stampOf(c: Ctx, rank: number): Stamp | null {
  const text = c.rec.timestamp;
  if (text === undefined) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at) || at < 0) return null;
  return { at, rank, tie: `t:${String(c.file.fileId)}:${String(c.at.offset)}` };
}

/** The entry key of the record: its `uuid` (up to 80 characters, the column limit), else `f<file_id>:<byte_offset>` (02 4.1). */
function entryKey(c: Ctx): string {
  const uuid = sOf(c.rec.uuid);
  return uuid !== undefined && cpLen(uuid) <= ROW_LIMITS.recordUuid
    ? uuid
    : `f${String(c.file.fileId)}:${String(c.at.offset)}`;
}

/** Adds a row; the first row of a record carries the entry key, later ones only their natural key. */
function addRow(
  c: Ctx,
  stamp: Stamp,
  kind: EventKind,
  entryKind: EntryKind,
  extra: Partial<Omit<EventRowInit, 'sessionUid' | 'kind' | 'sources' | 'stamp' | 'tsSource' | 'receivedAt'>> = {},
): void {
  const subtype = sOf(c.rec.subtype);
  c.rows.push(
    eventRow({
      sessionUid: c.sid,
      agentUid: c.agentId ?? 'main',
      kind,
      entryKind,
      sources: 2,
      stamp,
      tsSource: 'record',
      receivedAt: c.nowMs ?? stamp.at,
      recordUuid: c.rows.length === 0 ? entryKey(c) : null,
      fileId: c.file.fileId,
      byteOffset: c.at.offset,
      byteLength: c.at.length,
      lineNo: c.at.lineNo,
      recordType: c.rec.type,
      ...(subtype === undefined ? {} : { subtype }),
      ...extra,
    }),
  );
}

function activity(c: Ctx, stamp: Stamp, via: 'assistant' | 'user' | 'tool_result'): LogicalEvent {
  return { k: 'activity', sessionId: c.sid, agentId: c.agentId, stamp, via };
}

function textLenOfBlock(block: ContentBlockRef): number {
  const content = block['content'];
  if (typeof content === 'string') return cpLen(content);
  if (!Array.isArray(content)) return 0;
  const parts: unknown[] = content;
  let total = 0;
  for (const part of parts) {
    if (isRec(part) && typeof part['text'] === 'string') total += cpLen(part['text']);
  }
  return total;
}

function userRecord(c: Ctx): void {
  const stamp = stampOf(c, RANK.user);
  if (stamp === null) return;
  const cls = classifyUser(c.rec);
  switch (cls.kind) {
    case 'meta':
    case 'other':
      c.events.push(activity(c, stamp, 'user'));
      return;
    case 'interrupt':
      c.events.push(
        { k: 'interrupt', sessionId: c.sid, agentId: c.agentId, stamp, via: 'user_marker' },
        activity(c, stamp, 'user'),
      );
      addRow(c, stamp, 'turn.interrupt', 'prompt', { flags: ['interrupt'] });
      return;
    case 'prompt': {
      const promptId = idOf(c.rec.promptId);
      const origin = clipCodePoints(sOf(c.rec.origin?.kind) ?? sOf(c.rec['promptSource']) ?? 'unknown', ORIGIN_MAX_CP);
      const textLen = cpLen(cls.text);
      c.events.push(
        { k: 'turn.prompt', sessionId: c.sid, agentId: c.agentId, promptId, stamp, origin, promptLen: textLen },
        activity(c, stamp, 'user'),
      );
      if (isTaskNotification(c.rec)) {
        const note = parseTaskNotification(c.rec.message?.content);
        c.events.push({
          k: 'agent.notification',
          sessionId: c.sid,
          toolUseId: note.toolUseId,
          taskId: note.taskId,
          status: note.status,
          stamp,
        });
        addRow(c, stamp, 'agent.notification', 'prompt', { textLen, promptId });
      } else {
        addRow(c, stamp, 'prompt.submit', 'prompt', { textLen, naturalKey: promptKey(c.sid, promptId), promptId });
      }
      return;
    }
    case 'tool_result':
      toolResults(c, cls.blocks);
  }
}

function toolResults(c: Ctx, blocks: readonly ContentBlockRef[]): void {
  const stamp = stampOf(c, RANK.toolResult);
  if (stamp === null) return;
  let firstId: string | null = null;
  for (const [index, block] of blocks.entries()) {
    const id = idOf(block['tool_use_id']);
    const outcome = toolOutcomeOf(c.rec, block);
    if (id !== null) {
      firstId ??= id;
      c.events.push({ k: 'tool.end', sessionId: c.sid, agentId: c.agentId, toolUseId: id, stamp, outcome });
    }
    if (id === null && index > 0) continue; // a later block without an id has nothing that could identify its row
    addRow(c, stamp, outcome === 'ok' ? 'tool.result' : 'tool.failure', 'result', {
      naturalKey: toolEndKey(id),
      toolUseId: id,
      textLen: textLenOfBlock(block),
    });
  }
  c.events.push(activity(c, stamp, 'tool_result'));

  const result = c.rec.toolUseResult;
  if (isRec(result) && firstId !== null) {
    const agentId = sOf(result['agentId']);
    if (agentId !== undefined && AGENT_RE.test(agentId)) {
      c.events.push({
        k: 'agent.link',
        sessionId: c.sid,
        agentId,
        toolUseId: firstId,
        status: sOf(result['status']) ?? null,
        stamp,
      });
    }
    const runId = sOf(result['runId']);
    if (runId !== undefined && RUN_ID_RE.test(runId)) {
      const name = sOf(result['workflowName']);
      c.events.push({
        k: 'workflow.launch',
        sessionId: c.sid,
        runId,
        toolUseId: firstId,
        stamp,
        ...(name === undefined ? {} : { name: clipCodePoints(redact(name), TITLE_MAX_CP) }),
      });
    }
  }
  if (
    c.rec.toolEndsTurn === true &&
    (c.file.kind === 'subagent' || c.file.kind === 'workflow_agent') &&
    c.file.agentId !== null
  ) {
    c.events.push({ k: 'agent.final', sessionId: c.sid, agentId: c.file.agentId, stamp, via: 'tool_ends_turn' });
  }
}

/**
 * Hash of a tool input (02 2.5.4), or null when it cannot be hashed. `canonicalJsonHash` recurses, so an input nested
 * thousands of levels deep (a few KB of brackets) overflows the stack: that record keeps its `tool.start` without a hash
 * instead of failing the line.
 */
function safeInputHash(input: unknown): string | null {
  try {
    return canonicalJsonHash(input ?? null);
  } catch {
    return null;
  }
}

function assistantRecord(c: Ctx): void {
  const stamp = stampOf(c, RANK.assistant);
  if (stamp === null) return;
  const rec = c.rec;
  c.events.push(activity(c, stamp, 'assistant'));
  if (rec.isApiErrorMessage === true) {
    const status = nOf(rec['apiErrorStatus']);
    const error = sOf(rec['error']);
    c.events.push({
      k: 'api_error',
      sessionId: c.sid,
      agentId: c.agentId,
      stamp,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error: clipCodePoints(error, 64) }),
    });
  } else if (rec.message?.model !== SYNTHETIC_MODEL) {
    c.events.push({ k: 'assistant.ok', sessionId: c.sid, agentId: c.agentId, stamp });
  }
  if (rec.isAbortedMidStream === true) {
    c.events.push({ k: 'interrupt', sessionId: c.sid, agentId: c.agentId, stamp, via: 'aborted_mid_stream' });
  }

  const messageId = sOf(rec.message?.id);
  const blocks: readonly ContentBlockRef[] =
    typeof rec.message?.content === 'string' ? [{ type: 'text', text: rec.message.content }] : blocksOf(rec);
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const id = idOf(block['id']);
      const input: unknown = block['input'];
      const summary = summarizeToolInput(input);
      const inputHash = id === null ? null : safeInputHash(input);
      const name = sOf(block['name']);
      if (id !== null) {
        c.events.push({
          k: 'tool.start',
          sessionId: c.sid,
          agentId: c.agentId,
          promptId: null,
          toolUseId: id,
          name: name === undefined ? 'unknown' : clipCodePoints(name, 128),
          stamp,
          ...(summary === '' ? {} : { summary }),
          ...(inputHash === null ? {} : { inputHash }),
        });
      }
      if (id !== null || c.rows.length === 0) {
        addRow(c, stamp, 'tool.call', 'tool', {
          naturalKey: toolCallKey(id),
          toolUseId: id,
          toolName: name === undefined ? null : clipCodePoints(name, 128),
          summary: summary === '' ? null : summary,
          ...(messageId === undefined ? {} : { messageId }),
        });
      }
    } else if (c.rows.length === 0) {
      // text and thinking blocks have no id of their own: only the first can be a row (it carries the record uuid)
      const kind = eventKindOfRecord(rec, block, c.file);
      if (kind !== null) {
        const text = block.type === 'text' ? block['text'] : block['thinking'];
        addRow(c, stamp, kind, block.type === 'text' ? 'say' : 'think', {
          textLen: typeof text === 'string' ? cpLen(text) : 0,
          ...(messageId === undefined ? {} : { messageId }),
        });
      }
    }
  }
  const stop = rec.message?.stop_reason;
  if (stop === 'end_turn' || stop === 'stop_sequence') {
    c.events.push({ k: 'turn.end', sessionId: c.sid, agentId: c.agentId, promptId: null, stamp, kind: 'end_turn' });
  }
}

function systemRecord(c: Ctx): void {
  const rec = c.rec;
  const sub = rec.subtype;
  if (sub === 'turn_duration') {
    const stamp = stampOf(c, RANK.turnDuration);
    if (stamp === null) return;
    const agents = nOf(rec['pendingBackgroundAgentCount']);
    const workflows = nOf(rec['pendingWorkflowCount']);
    c.events.push({
      k: 'turn.end',
      sessionId: c.sid,
      agentId: c.agentId,
      promptId: null,
      stamp,
      kind: 'turn_duration',
      ...(agents === undefined ? {} : { pendingBackgroundAgents: agents }),
      ...(workflows === undefined ? {} : { pendingWorkflows: workflows }),
    });
    addRow(c, stamp, 'turn.duration', 'system');
  } else if (sub === 'compact_boundary') {
    const stamp = stampOf(c, RANK.compact);
    if (stamp === null) return;
    const meta: Rec = isRec(rec.compactMetadata) ? rec.compactMetadata : {};
    const pre = nOf(meta['preTokens']);
    const post = nOf(meta['postTokens']);
    c.events.push({
      k: 'compaction',
      sessionId: c.sid,
      stamp,
      trigger: clipCodePoints(sOf(meta['trigger']) ?? 'unknown', 32),
      ...(pre === undefined ? {} : { preTokens: pre }),
      ...(post === undefined ? {} : { postTokens: post }),
    });
    addRow(c, stamp, 'context.compact', 'system');
  } else {
    const stamp = stampOf(c, RANK.system);
    if (stamp === null) return;
    if (sub === 'away_summary' || sub === 'local_command') {
      c.events.push({ k: 'info', sessionId: c.sid, stamp, what: sub });
    }
    addRow(c, stamp, 'system.info', 'system');
  }
}

/** Returns the attachment type when the attachment is ignored (counted by the caller). */
function attachmentRecord(c: Ctx): string | null {
  const att = c.rec.attachment;
  if (att === undefined) return null;
  const kind = eventKindOfRecord(c.rec, null, c.file);
  if (kind === null) return att.type;
  const stamp = stampOf(c, RANK.attachment);
  if (stamp === null) return null;
  const extra = { subtype: att.type };
  if (kind === 'hook.handler_error') {
    const exit = att['exitCode'];
    c.events.push({
      k: 'hook.handler_error',
      sessionId: c.sid,
      hookEvent: clipCodePoints(sOf(att['hookEvent']) ?? 'unknown', 64),
      exitCode: typeof exit === 'number' && Number.isSafeInteger(exit) ? exit : null,
      stamp,
    });
    addRow(c, stamp, kind, 'attachment', { ...extra, flags: ['ours'] });
  } else {
    if (kind === 'prompt.queued') {
      c.events.push({ k: 'info', sessionId: c.sid, stamp, what: 'queued_command' });
    } else if (kind === 'agent.final' && c.file.agentId !== null) {
      c.events.push({ k: 'agent.final', sessionId: c.sid, agentId: c.file.agentId, stamp, via: 'structured_output' });
    }
    addRow(c, stamp, kind, 'attachment', extra);
  }
  return null;
}

const TITLE_FIELDS = {
  'ai-title': { field: 'aiTitle', source: 'ai' },
  'custom-title': { field: 'customTitle', source: 'custom' },
  'agent-name': { field: 'agentName', source: 'agent_name' },
} as const;

function titleRecord(c: Ctx, type: keyof typeof TITLE_FIELDS): void {
  const { field, source } = TITLE_FIELDS[type];
  const raw = sOf(c.rec[field]);
  if (raw === undefined) return;
  const value = clipCodePoints(redact(raw), TITLE_MAX_CP);
  const key = `${String(c.file.fileId)}:${source}`;
  if (c.state.titles.get(key) === value) return;
  c.state.titles.set(key, value);
  c.events.push({ k: 'title', sessionId: c.sid, source, value, order: c.at.offset });
}

/** Numbers only: the model usage of a `cost-state` record without any non-numeric field (02 5.7). */
function numericUsage(value: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!isRec(value)) return out;
  const nameOk = (name: string): boolean => name.length >= 1 && name.length <= 128 && !/[\s\p{Cc}]/u.test(name);
  for (const [model, usage] of Object.entries(value).slice(0, 32)) {
    if (!isRec(usage) || !nameOk(model)) continue;
    const numbers: Record<string, number> = {};
    for (const [key, n] of Object.entries(usage).slice(0, 32)) {
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && nameOk(key)) numbers[key] = n;
    }
    out[model] = numbers;
  }
  return out;
}

function costStateRecord(c: Ctx): void {
  const total = c.rec['totalCostUSD'];
  c.events.push({
    k: 'cost_state',
    sessionId: c.sid,
    fileId: c.file.fileId,
    byteOffset: c.at.offset,
    totalCostUsd: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null,
    modelUsage: numericUsage(c.rec['modelUsage']),
  });
}

function journalRecord(c: Ctx): boolean {
  const type = c.rec.type;
  if (type === 'launched') return true;
  if (type !== 'started' && type !== 'result' && type !== 'failed') return false;
  const runId = c.file.runId;
  const stampText = c.rec.timestamp;
  const parsed = stampText === undefined ? NaN : Date.parse(stampText);
  const observedAt = Number.isFinite(parsed) && parsed >= 0 ? parsed : c.nowMs;
  const key = sOf(c.rec['key']) ?? sOf(c.rec.agentId);
  if (runId === null || observedAt === undefined || key === undefined) return true;
  let run = c.state.journal.get(runId);
  if (run === undefined) {
    run = { started: new Set(), results: new Set(), failed: new Set() };
    c.state.journal.set(runId, run);
  }
  const set = type === 'started' ? run.started : type === 'result' ? run.results : run.failed;
  if (set.size < 10_000) set.add(key);
  c.events.push({
    k: 'workflow.status',
    sessionId: c.sid,
    runId,
    observedAt,
    fileStatus: null,
    started: run.started.size,
    results: run.results.size,
    failed: run.failed.size,
  });
  return true;
}

const BOOKKEEPING: ReadonlySet<string> = new Set([
  'last-prompt',
  'atis-latch',
  'mode',
  'permission-mode',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
]);

/**
 * Normalizes one record (02 5.6). Returns the logical events, the `events` rows (one per `tool_result` block, one per
 * stored assistant block, else at most one) and what the caller must count (an unknown type, an ignored attachment).
 */
export function normalizeRecord(
  rec: TranscriptRecord,
  file: TrackedFile,
  at: RecordPosition,
  opts: NormalizeOptions = {},
): NormalizedRecord {
  const c: Ctx = {
    rec,
    file,
    at,
    sid: file.sessionId,
    agentId: file.agentId,
    state: opts.state ?? createNormalizerState(),
    nowMs: opts.nowMs,
    events: [],
    rows: [],
  };
  let unknownType: string | null = null;
  let ignoredAttachment: string | null = null;

  // A workflow status file holds a snapshot, not a log: it yields nothing here (02 5.6), like `eventKindOfRecord` says.
  if (file.kind === 'workflow_status') return { events: [], rows: [], unknownType: null, ignoredAttachment: null };
  if (file.kind === 'workflow_journal') {
    if (!journalRecord(c)) unknownType = rec.type;
    return { events: c.events, rows: c.rows, unknownType, ignoredAttachment };
  }
  switch (rec.type) {
    case 'user':
      userRecord(c);
      break;
    case 'assistant':
      assistantRecord(c);
      break;
    case 'system':
      systemRecord(c);
      break;
    case 'attachment':
      ignoredAttachment = attachmentRecord(c);
      break;
    case 'ai-title':
    case 'custom-title':
    case 'agent-name':
      titleRecord(c, rec.type);
      break;
    case 'continued-in': {
      const target = sOf(rec['continuedInSessionId']);
      if (target !== undefined && SID_RE.test(target)) {
        c.events.push({ k: 'session.continued_in', sessionId: c.sid, target });
      }
      break;
    }
    case 'cost-state':
      costStateRecord(c);
      break;
    default:
      if (!BOOKKEEPING.has(rec.type)) unknownType = rec.type;
  }
  return { events: c.events, rows: c.rows, unknownType, ignoredAttachment };
}

// ---- lines to items ----------------------------------------------------------------------------------------------------

/** The events and rows of one record, with its place in the file (the unit of an `IngestItem`, 02 4.6). */
export interface RecordItem {
  kind: 'record';
  offset: number;
  events: LogicalEvent[];
  rows: EventRowWrite[];
}

/** Per-file counters of 02 5.9 that this step can fill. */
export interface RecordCounters {
  invalidJson: number;
  notObject: number;
  shapeInvalid: number;
  unknownTypes: number;
  /** Unknown `type` values by name (at most 64 names, then `other`; names clipped to 64 code points). */
  unknownRecordTypes: Record<string, number>;
  /** Ignored `attachment.type` values by name, bounded like `unknownRecordTypes`. */
  ignoredAttachments: Record<string, number>;
  /** Lines whose normalization threw (a hostile record): counted and skipped, so the other lines of the call survive. */
  normalizeFailed: number;
}

export interface NormalizedBatch {
  items: RecordItem[];
  counters: RecordCounters;
  /** Lines the call used (all of them unless `shouldStop` ended the loop): the next call starts at `lines[taken]`. */
  taken: number;
}

export interface NormalizeRecordsOptions extends Omit<NormalizeOptions, 'state'> {
  /** Called once per object record that passed the shape check, before it is normalized (usage, head facts). */
  onRecord?: (rec: TranscriptRecord, line: RawLine) => void;
  /** Asked before each line: true ends the loop there (a slice deadline). */
  shouldStop?: () => boolean;
}

const MAX_NAMES = 64;

function bump(counts: Map<string, number>, name: string): void {
  const key = clipCodePoints(name, 64);
  const slot = counts.has(key) || counts.size < MAX_NAMES ? key : 'other';
  counts.set(slot, (counts.get(slot) ?? 0) + 1);
}

/** Parses, validates and normalizes lines of ONE file, in order. A bad line is counted, never thrown. */
export function normalizeRecords(
  lines: readonly RawLine[],
  file: TrackedFile,
  state: NormalizerState,
  opts: NormalizeRecordsOptions = {},
): NormalizedBatch {
  const items: RecordItem[] = [];
  const counters: RecordCounters = {
    invalidJson: 0,
    notObject: 0,
    shapeInvalid: 0,
    unknownTypes: 0,
    unknownRecordTypes: {},
    ignoredAttachments: {},
    normalizeFailed: 0,
  };
  const unknown = new Map<string, number>();
  const ignored = new Map<string, number>();
  let taken = 0;
  for (const line of lines) {
    if (opts.shouldStop?.() === true) break;
    taken += 1;
    let value: unknown;
    try {
      value = JSON.parse(line.bytes.toString('utf8'));
    } catch {
      counters.invalidJson += 1;
      continue;
    }
    if (!isRec(value)) {
      counters.notObject += 1;
      continue;
    }
    const shape = TranscriptRecordShape.safeParse(value);
    if (!shape.success) {
      counters.shapeInvalid += 1;
      continue;
    }
    opts.onRecord?.(shape.data, line);
    let out: NormalizedRecord;
    try {
      out = normalizeRecord(
        shape.data,
        file,
        { offset: line.offset, length: line.length, lineNo: line.lineNo },
        { state, ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }) },
      );
    } catch {
      // The cursor moves past this line: a throw here would be re-read and re-thrown on every poll (poison pill).
      counters.normalizeFailed += 1;
      continue;
    }
    if (out.unknownType !== null) {
      counters.unknownTypes += 1;
      bump(unknown, out.unknownType);
    }
    if (out.ignoredAttachment !== null) bump(ignored, out.ignoredAttachment);
    if (out.events.length > 0 || out.rows.length > 0) {
      items.push({ kind: 'record', offset: line.offset, events: out.events, rows: out.rows });
    }
  }
  counters.unknownRecordTypes = Object.fromEntries(unknown);
  counters.ignoredAttachments = Object.fromEntries(ignored);
  return { items, counters, taken };
}
