// Transcript builder (05 4.4): synthetic Claude Code session files whose record shapes follow the survey of real transcripts
// (docs/research/transcript-survey.md section 8, 25 shapes). Every string that stands for user content starts with FIXTURE;
// ids come from a seeded counter, never from a random source. Builders are pure until `write`/`appendTo` is called.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isoMsZ } from '@mcs/shared';

import { FIXTURE_EPOCH_MS } from './clock.ts';

export type JsonRecord = Record<string, unknown>;

/** A uuid-shaped (version 4, variant 8..b) id derived from `seed` and `n`: stable, unique per pair. */
export function detUuid(seed: string, n: number | string): string {
  const hex = createHash('sha256')
    .update(`${seed}|${String(n)}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex.charAt(15), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-${variant}${hex.slice(16, 19)}-${hex.slice(19, 31)}`;
}

/** Folder name Claude Code gives a project: every character that is not a letter or digit becomes `-` (survey section 1). */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export interface UsageFixture {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  iterations?: readonly UsageFixture[];
}

export type StopReason = 'end_turn' | 'tool_use' | null;

export interface AssistantOptions {
  messageId: string;
  text?: string;
  usage?: UsageFixture;
  stop?: StopReason;
  model?: string;
  /** More than 1 repeats the id in streaming snapshots (survey 3.2). */
  snapshots?: number;
  /** Output tokens of each snapshot (06 request: streaming growth). */
  outputPerRecord?: readonly number[];
  /** Top-level counters 0 and `iterations[0]` populated (survey 3.3). */
  zeroTopLevel?: boolean;
  /** One counter becomes the boolean `true` (06 request, D13). */
  booleanUsageField?: 'input_tokens' | 'output_tokens';
  /** `iterations` on the last snapshot (06 request). */
  final?: boolean;
  /** `isAbortedMidStream: true` with `stop_reason: null` (survey 8.6). */
  abortedMidStream?: boolean;
}

export interface ToolUseOptions {
  messageId?: string;
  id?: string;
  /** Usage of the message (default: the usual fixture usage). */
  usage?: UsageFixture;
}

export interface ToolResultOptions {
  isError?: boolean;
  content?: string;
  /** `toolDenialKind: user-rejected` and a reject decision. */
  denial?: boolean;
  /** Content as a list of text blocks instead of a string (survey 8.7). */
  contentBlocks?: boolean;
  /** No `is_error` key at all (survey 8.7). */
  omitIsError?: boolean;
  /** Replaces the default `toolUseResult` object; `null` and a string are valid variants. */
  toolUseResult?: JsonRecord | string | null;
}

export type BookkeepingKind =
  | 'last-prompt'
  | 'ai-title'
  | 'custom-title'
  | 'agent-name'
  | 'mode'
  | 'permission-mode'
  | 'atis-latch'
  | 'queue-operation'
  | 'file-history-snapshot'
  | 'file-history-delta'
  | 'bridge-session'
  | 'cost-state'
  | 'continued-in';

export interface BookkeepingOptions {
  continuedInSessionId?: string;
  /** `cost-state` with `modelUsage: {}`. */
  emptyModelUsage?: boolean;
  /** `queue-operation` kind; `dequeue` and `remove` carry no content. */
  operation?: 'enqueue' | 'dequeue' | 'remove';
}

export type AttachmentType =
  | 'hook_success'
  | 'queued_command'
  | 'task_status'
  | 'structured_output'
  | 'total_tokens_reminder'
  | 'date'
  | 'environment';

export type NotificationStatus = 'completed' | 'failed' | 'killed' | 'stopped';

export interface TranscriptOptions {
  sessionId: string;
  cwd: string;
  startMs: number;
  /** Milliseconds between two records (default 1000). */
  stepMs?: number;
  /** Makes the file a subagent file: every record is a sidechain record of this agent. */
  agentId?: string;
  /** Seed of record uuids (default: the session id). Two builders with one seed produce the same uuids (resume copy, shape 21). */
  uuidSeed?: string;
}

export interface WriteOptions {
  newlineAtEnd?: boolean;
  crlf?: boolean;
  bom?: boolean;
  /** Keep only the first N bytes of the last line and no newline after it (a torn write). */
  partialLastBytes?: number;
}

type Entry = { readonly kind: 'json'; readonly value: JsonRecord } | { readonly kind: 'text'; readonly text: string };

export interface UsageNumbers {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

const DEFAULT_USAGE: UsageNumbers = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 20,
};

/** After a compaction the cache is cold (survey 3.6): reads fall to 0 and the next call writes the context again. */
const COMPACTED_USAGE: UsageNumbers = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 30_000,
};

const MODEL = 'claude-sonnet-5-5';
const CLI_VERSION = '0.0.0-fixture';
const pad3 = (n: number): string => String(n).padStart(3, '0');

function iteration(u: UsageNumbers): JsonRecord {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    type: 'message',
  };
}

function normalize(u: UsageFixture): UsageNumbers {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

export class TranscriptBuilder {
  readonly sessionId: string;
  readonly agentId: string | undefined;
  readonly #opts: TranscriptOptions;
  #cwd: string;
  readonly #seed: string;
  readonly #tag: string;
  readonly #entries: Entry[] = [];
  #bytes = 0;
  #uuidSeq = 0;
  #tsIndex = 0;
  #offsetMs = 0;
  #lastUuid: string | null = null;
  #detached = false;
  #conversational = 0;
  #msgSeq = 0;
  #toolSeq = 0;
  #apiErrorSeq = 0;
  #lastMessageId: string | null = null;
  #cold = false;
  #toolCalls = 0;
  #toolErrors = 0;
  readonly #usageById = new Map<string, UsageNumbers>();
  readonly #requestIds = new Map<string, string>();
  readonly #toolOwners = new Map<string, string>();

  constructor(opts: TranscriptOptions) {
    this.#opts = opts;
    this.#cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.#seed = `${opts.uuidSeed ?? opts.sessionId}${opts.agentId === undefined ? '' : `:${opts.agentId}`}`;
    this.#tag = detUuid(this.#seed, 'tag').slice(0, 8);
  }

  /** Bytes of the file as `write` would produce it with the default options. */
  get sizeBytes(): number {
    return this.#bytes;
  }

  /** Token usage per message id as the builder emitted it (the last snapshot of an id wins). Inputs, never parsed output. */
  usageByMessage(): ReadonlyMap<string, Readonly<UsageNumbers>> {
    return this.#usageById;
  }

  /** Totals of `usageByMessage()`: every message id counted once. */
  usageTotals(): { input: number; output: number; cacheCreation: number; cacheRead: number } {
    const total = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (const u of this.#usageById.values()) {
      total.input += u.input_tokens;
      total.output += u.output_tokens;
      total.cacheCreation += u.cache_creation_input_tokens;
      total.cacheRead += u.cache_read_input_tokens;
    }
    return total;
  }

  /** Number of `tool_use` blocks written. */
  toolUseCount(): number {
    return this.#toolCalls;
  }

  /** Number of tool results written with `is_error: true`. */
  toolErrorCount(): number {
    return this.#toolErrors;
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  #push(entry: Entry): void {
    this.#entries.push(entry);
    const text = entry.kind === 'json' ? JSON.stringify(entry.value) : entry.text;
    this.#bytes += Buffer.byteLength(text) + 1;
  }

  #timestamp(): string {
    const at = this.#opts.startMs + this.#offsetMs + this.#tsIndex * (this.#opts.stepMs ?? 1000);
    this.#tsIndex += 1;
    return isoMsZ(at);
  }

  /** A conversational record: chained to the previous one (or to `parent`), with the common session fields. */
  #record(type: string, extra: JsonRecord, parent?: string | null): string {
    const uuid = detUuid(this.#seed, this.#uuidSeq);
    this.#uuidSeq += 1;
    let parentUuid: string | null;
    if (parent !== undefined) parentUuid = parent;
    else if (this.#detached) parentUuid = null;
    else parentUuid = this.#lastUuid;
    this.#detached = false;
    const record: JsonRecord = {
      type,
      uuid,
      parentUuid,
      isSidechain: this.agentId !== undefined,
      ...(this.agentId === undefined ? {} : { agentId: this.agentId }),
      sessionId: this.sessionId,
      cwd: this.#cwd,
      timestamp: this.#timestamp(),
      entrypoint: 'cli',
      version: CLI_VERSION,
      ...extra,
    };
    this.#push({ kind: 'json', value: record });
    this.#lastUuid = uuid;
    this.#conversational += 1;
    return uuid;
  }

  #requestId(messageId: string): string {
    let id = this.#requestIds.get(messageId);
    if (id === undefined) {
      id = `req_fixture_${this.#tag}_${pad3(this.#requestIds.size)}`;
      this.#requestIds.set(messageId, id);
    }
    return id;
  }

  #nextMessageId(): string {
    const id = `msg_fixture_${this.#tag}_${pad3(this.#msgSeq)}`;
    this.#msgSeq += 1;
    return id;
  }

  #usageRecord(
    base: UsageNumbers,
    output: number,
    o: {
      zeroTopLevel?: boolean;
      booleanUsageField?: 'input_tokens' | 'output_tokens';
      iterations?: readonly UsageNumbers[];
    },
  ): JsonRecord {
    const full: UsageNumbers = { ...base, output_tokens: output };
    const top: UsageNumbers =
      o.zeroTopLevel === true
        ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : full;
    const usage: JsonRecord = { ...top, service_tier: 'standard' };
    if (o.zeroTopLevel === true) usage['iterations'] = [iteration(full)];
    else if (o.iterations !== undefined) usage['iterations'] = o.iterations.map(iteration);
    if (o.booleanUsageField !== undefined) usage[o.booleanUsageField] = true;
    return usage;
  }

  #assistantRecord(
    block: JsonRecord,
    messageId: string,
    stop: StopReason,
    usage: JsonRecord,
    model: string,
    extra: JsonRecord = {},
  ): string {
    this.#lastMessageId = messageId;
    return this.#record('assistant', {
      requestId: this.#requestId(messageId),
      ...extra,
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [block],
        stop_reason: stop,
        stop_sequence: null,
        stop_details: null,
        usage,
        container: null,
        context_management: null,
        diagnostics: null,
      },
    });
  }

  // ---- conversation ------------------------------------------------------------------------------------------------

  /** A human prompt (default text `FIXTURE prompt <n>`). */
  user(text?: string): this {
    const n = this.#conversational;
    this.#record('user', {
      promptId: detUuid(this.#seed, `prompt-${String(n)}`),
      message: { role: 'user', content: text ?? `FIXTURE prompt ${String(n)}` },
    });
    return this;
  }

  /** One assistant record per snapshot, one text block each. */
  assistant(o: AssistantOptions): this {
    const snapshots = o.snapshots ?? 1;
    if (!Number.isInteger(snapshots) || snapshots < 1)
      throw new RangeError(`assistant: snapshots must be a positive integer, got ${String(snapshots)}`);
    const aborted = o.abortedMidStream === true;
    const base = o.usage !== undefined ? normalize(o.usage) : this.#cold ? COMPACTED_USAGE : DEFAULT_USAGE;
    this.#cold = false;
    const finalStop: StopReason = aborted ? null : o.stop === undefined ? 'end_turn' : o.stop;
    const text = o.text ?? `FIXTURE assistant reply ${String(this.#conversational)}`;
    this.#usageById.set(o.messageId, {
      ...base,
      output_tokens: o.outputPerRecord?.[snapshots - 1] ?? base.output_tokens,
    });
    for (let i = 0; i < snapshots; i += 1) {
      const last = i === snapshots - 1;
      const output = o.outputPerRecord?.[i] ?? (last ? base.output_tokens : Math.min(8, base.output_tokens));
      const iterations =
        last && (o.final === true || o.usage?.iterations !== undefined)
          ? (o.usage?.iterations ?? [o.usage ?? base]).map(normalize)
          : undefined;
      const usage = this.#usageRecord(base, output, {
        ...(o.zeroTopLevel === undefined ? {} : { zeroTopLevel: o.zeroTopLevel }),
        ...(o.booleanUsageField === undefined ? {} : { booleanUsageField: o.booleanUsageField }),
        ...(iterations === undefined ? {} : { iterations }),
      });
      this.#assistantRecord(
        { type: 'text', text },
        o.messageId,
        last ? finalStop : null,
        usage,
        o.model ?? MODEL,
        aborted ? { isAbortedMidStream: true } : {},
      );
    }
    return this;
  }

  /** An assistant record holding one `tool_use` block; returns the `tool_use_id`. */
  toolUse(name: string, input?: JsonRecord, opts: ToolUseOptions = {}): string {
    const id = opts.id ?? `toolu_fixture_${this.#tag}_${pad3(this.#toolSeq)}`;
    this.#toolSeq += 1;
    const messageId = opts.messageId ?? this.#nextMessageId();
    const defaults = name === 'Bash' ? { command: 'echo FIXTURE tool input' } : { description: 'FIXTURE tool input' };
    const base = opts.usage !== undefined ? normalize(opts.usage) : this.#cold ? COMPACTED_USAGE : DEFAULT_USAGE;
    this.#cold = false;
    this.#toolCalls += 1;
    this.#usageById.set(messageId, base);
    const uuid = this.#assistantRecord(
      { type: 'tool_use', id, name, input: input ?? defaults, caller: { type: 'direct' } },
      messageId,
      'tool_use',
      this.#usageRecord(base, base.output_tokens, {}),
      MODEL,
    );
    this.#toolOwners.set(id, uuid);
    return id;
  }

  /** The user record that answers `toolUseId` (its own record, also for parallel calls). */
  toolResult(toolUseId: string, o: ToolResultOptions = {}): this {
    return this.#toolResult(toolUseId, o, {});
  }

  #toolResult(toolUseId: string, o: ToolResultOptions, extra: JsonRecord): this {
    const owner = this.#toolOwners.get(toolUseId);
    if (owner === undefined) throw new Error(`toolResult: no tool_use with id ${toolUseId} in this transcript`);
    const text = o.content ?? 'FIXTURE result';
    const denial = o.denial === true;
    const failed = o.isError === true || denial;
    if (failed) this.#toolErrors += 1;
    const block: JsonRecord = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: o.contentBlocks === true ? [{ type: 'text', text }] : text,
      ...(o.omitIsError === true ? {} : { is_error: failed }),
    };
    const defaultResult: JsonRecord = {
      stdout: text,
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    };
    this.#record(
      'user',
      {
        message: { role: 'user', content: [block] },
        sourceToolAssistantUUID: owner,
        toolUseResult: o.toolUseResult === undefined ? defaultResult : o.toolUseResult,
        ...(denial
          ? { toolDenialKind: 'user-rejected', permissionDecision: { decision: 'reject', source: 'user_temporary' } }
          : {}),
        ...extra,
      },
      owner,
    );
    return this;
  }

  /** A `SubagentHandback` or `StructuredOutput` call and its result with `toolEndsTurn: true` (survey 4.2). */
  endTurnTool(name: 'SubagentHandback' | 'StructuredOutput'): this {
    const id = this.toolUse(name, { note: 'FIXTURE handback' });
    return this.#toolResult(id, { content: 'FIXTURE done' }, { toolEndsTurn: true });
  }

  /** An assistant `end_turn` text record followed by `system/turn_duration` (survey 4.2). */
  turnEnd(o: { pendingBackgroundAgentCount?: number; pendingWorkflowCount?: number } = {}): this {
    this.assistant({ messageId: this.#nextMessageId(), stop: 'end_turn' });
    this.#record('system', {
      subtype: 'turn_duration',
      durationMs: 1000 + this.#conversational,
      messageCount: this.#conversational,
      isMeta: false,
      ...(o.pendingBackgroundAgentCount === undefined
        ? {}
        : { pendingBackgroundAgentCount: o.pendingBackgroundAgentCount }),
      ...(o.pendingWorkflowCount === undefined ? {} : { pendingWorkflowCount: o.pendingWorkflowCount }),
    });
    return this;
  }

  /** The interrupt marker the user record carries (survey 4.3). */
  interrupt(o: { forToolUse?: boolean } = {}): this {
    const text = o.forToolUse === true ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]';
    this.#record('user', {
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...(this.#lastMessageId === null ? {} : { interruptedMessageId: this.#lastMessageId }),
    });
    return this;
  }

  /** The synthetic error record of an API failure (survey 8.5). */
  apiError(status = 529): this {
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const id = detUuid(this.#seed, `api-error-${String(this.#apiErrorSeq)}`);
    this.#apiErrorSeq += 1;
    this.#usageById.set(id, zero);
    this.#record('assistant', {
      isApiErrorMessage: true,
      apiErrorStatus: status,
      error: 'server_error',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'FIXTURE API error' }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        usage: { ...zero, service_tier: null, output_tokens_details: null },
      },
    });
    return this;
  }

  /** `compact_boundary`, then the summary (a user record, or an attachment) and a cold cache for the next answer (survey 3.6). */
  compact(o: { attachment?: boolean } = {}): this {
    const prior = this.#lastUuid;
    this.#record(
      'system',
      {
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        logicalParentUuid: prior,
        compactMetadata: {
          trigger: 'auto',
          preTokens: 900_000,
          postTokens: 20_000,
          cumulativeDroppedTokens: 880_000,
          durationMs: 90_000,
          preCompactDiscoveredTools: [],
          preservedSegment: { headUuid: prior, anchorUuid: prior, tailUuid: prior },
          preservedMessages: { anchorUuid: prior, uuids: [], allUuids: [] },
        },
      },
      null,
    );
    if (o.attachment === true) {
      this.#record('attachment', { attachment: { type: 'compact_file_reference', filename: 'FIXTURE/file.txt' } });
    } else {
      this.#record('user', {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: 'user', content: 'FIXTURE compaction summary' },
      });
    }
    this.#cold = true;
    return this;
  }

  /** A record that is not conversation: no uuid, no chain, never counts as activity (survey 8.14). */
  bookkeeping(kind: BookkeepingKind, o: BookkeepingOptions = {}): this {
    const sessionId = this.sessionId;
    const messageId = this.#lastMessageId ?? detUuid(this.#seed, 'bookkeeping');
    let value: JsonRecord;
    switch (kind) {
      case 'last-prompt':
        value = { type: kind, sessionId, lastPrompt: 'FIXTURE last prompt', leafUuid: this.#lastUuid };
        break;
      case 'ai-title':
        value = { type: kind, sessionId, aiTitle: 'FIXTURE ai title' };
        break;
      case 'custom-title':
        value = { type: kind, sessionId, customTitle: 'FIXTURE custom title' };
        break;
      case 'agent-name':
        value = { type: kind, sessionId, agentName: 'FIXTURE agent name' };
        break;
      case 'mode':
        value = { type: kind, sessionId, mode: 'normal' };
        break;
      case 'permission-mode':
        value = { type: kind, sessionId, permissionMode: 'default' };
        break;
      case 'atis-latch':
        value = { type: kind, sessionId, latched: true };
        break;
      case 'queue-operation': {
        const operation = o.operation ?? 'enqueue';
        value = {
          type: kind,
          operation,
          timestamp: this.#timestamp(),
          sessionId,
          ...(operation === 'enqueue' ? { content: 'FIXTURE queued prompt' } : {}),
        };
        break;
      }
      case 'file-history-snapshot':
        value = {
          type: kind,
          messageId,
          snapshot: { messageId, trackedFileBackups: {}, timestamp: isoMsZ(this.#opts.startMs) },
          isSnapshotUpdate: false,
        };
        break;
      case 'file-history-delta':
        value = { type: kind, messageId, trackedFileBackups: {} };
        break;
      case 'bridge-session':
        value = { type: kind, sessionId, bridgeSessionId: detUuid(this.#seed, 'bridge') };
        break;
      case 'cost-state':
        value = {
          type: kind,
          sessionId,
          totalCostUSD: 0,
          totalAPIDuration: 0,
          startTime: this.#opts.startMs,
          modelUsage:
            o.emptyModelUsage === true
              ? {}
              : {
                  [MODEL]: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadInputTokens: 100,
                    cacheCreationInputTokens: 20,
                    costUSD: 0,
                  },
                  'claude-opus-5[1m]': {
                    inputTokens: 1,
                    outputTokens: 1,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0,
                  },
                },
        };
        break;
      case 'continued-in':
        value = {
          type: kind,
          sessionId,
          continuedInSessionId: o.continuedInSessionId ?? detUuid(this.#seed, 'continued-in'),
        };
        break;
    }
    this.#push({ kind: 'json', value });
    return this;
  }

  /** An `attachment` record (survey 2.4); `extra` overrides the defaults of the attachment object. */
  attachment(type: AttachmentType, extra: JsonRecord = {}): this {
    let body: JsonRecord;
    switch (type) {
      case 'hook_success':
        body = {
          hookName: 'PostToolUse:Bash',
          hookEvent: 'PostToolUse',
          toolUseID: `toolu_fixture_${this.#tag}_hook`,
          command: 'FIXTURE hook command',
          content: '',
          stdout: '',
          stderr: '',
          exitCode: 0,
          durationMs: 12,
        };
        break;
      case 'queued_command':
        body = { prompt: 'FIXTURE queued prompt', commandMode: 'prompt' };
        break;
      case 'task_status':
        body = {
          taskId: 'task_fixture_1',
          taskType: 'local_agent',
          description: 'FIXTURE task',
          status: 'running',
          deltaSummary: 'FIXTURE delta',
          outputFilePath: 'FIXTURE-output/task_fixture_1.output',
        };
        break;
      case 'structured_output':
        body = { data: { ok: true } };
        break;
      case 'total_tokens_reminder':
        body = { content: `FIXTURE token reminder ${'x'.repeat(2000)}` };
        break;
      case 'date':
        body = { content: 'FIXTURE date 2026-01-01' };
        break;
      case 'environment':
        body = { content: 'FIXTURE environment' };
        break;
    }
    this.#record('attachment', { attachment: { type, ...body, ...extra } });
    return this;
  }

  /** An `Agent` tool call and its result (survey 6.1); returns the `tool_use_id` that the subagent's meta file names. */
  agentLaunch(o: { agentId: string; background: boolean }): string {
    const description = 'FIXTURE agent task';
    const prompt = 'FIXTURE agent prompt';
    const id = this.toolUse('Agent', {
      description,
      prompt,
      subagent_type: 'general-purpose',
      run_in_background: o.background,
    });
    this.toolResult(id, {
      content: o.background ? 'FIXTURE agent launched' : 'FIXTURE agent finished',
      toolUseResult: {
        agentId: o.agentId,
        status: o.background ? 'async_launched' : 'completed',
        description,
        isAsync: o.background,
        ...(o.background ? { outputFile: `FIXTURE-output/agent-${o.agentId}.output`, canReadOutputFile: true } : {}),
        prompt,
        resolvedModel: 'sonnet',
      },
    });
    return id;
  }

  /** The user record that announces the end of a background task (survey 4.2); without `status` it is an event-only notification. */
  taskNotification(o: { taskId: string; toolUseId: string; status?: NotificationStatus }): this {
    const content = [
      '<task-notification>',
      `<task-id>${o.taskId}</task-id>`,
      `<tool-use-id>${o.toolUseId}</tool-use-id>`,
      `<output-file>FIXTURE-output/${o.taskId}.output</output-file>`,
      ...(o.status === undefined ? [] : [`<status>${o.status}</status>`]),
      '<summary>FIXTURE task summary</summary>',
      '<usage><total_tokens>1000</total_tokens><tool_uses>2</tool_uses><duration_ms>1500</duration_ms></usage>',
      '</task-notification>',
    ].join('\n');
    this.#record('user', {
      origin: { kind: 'task-notification', producer: 'session-task' },
      message: { role: 'user', content },
    });
    return this;
  }

  // ---- clock and chain control -------------------------------------------------------------------------------------

  /** Moves the record clock by `ms`, also backwards (order anomalies, survey 8.22). */
  advance(ms: number): this {
    this.#offsetMs += ms;
    return this;
  }

  /** The `cwd` of every later record changes to `path` (a session that moves into a subfolder, survey 8.25). */
  cwd(path: string): this {
    if (path === '') throw new RangeError('TranscriptBuilder.cwd: the folder must not be empty');
    this.#cwd = path;
    return this;
  }

  /** The next record gets `parentUuid: null`, as after a compaction or a copied prefix (survey 8.22). */
  detach(): this {
    this.#detached = true;
    return this;
  }

  /** A record exactly as given (no session fields, no chain). */
  raw(record: JsonRecord): this {
    this.#push({ kind: 'json', value: record });
    return this;
  }

  /** A line that is not valid JSON (survey 8.23). */
  invalidLine(text = '{"type":"user", FIXTURE invalid line'): this {
    this.#push({ kind: 'text', text });
    return this;
  }

  // ---- output ------------------------------------------------------------------------------------------------------

  /** One JSON document per line. */
  lines(): string[] {
    return this.#entries.map((entry) => (entry.kind === 'json' ? JSON.stringify(entry.value) : entry.text));
  }

  write(path: string, opts: WriteOptions = {}): void {
    const eol = opts.crlf === true ? '\r\n' : '\n';
    const lines = this.lines();
    let body: string;
    if (opts.partialLastBytes !== undefined && lines.length > 0) {
      const last = Buffer.from(lines[lines.length - 1] ?? '', 'utf8')
        .subarray(0, opts.partialLastBytes)
        .toString('utf8');
      body = [...lines.slice(0, -1), last].join(eol);
    } else {
      body = lines.join(eol) + (opts.newlineAtEnd === false || lines.length === 0 ? '' : eol);
    }
    const parts = [...(opts.bom === true ? [Buffer.from([0xef, 0xbb, 0xbf])] : []), Buffer.from(body, 'utf8')];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.concat(parts));
  }

  /** Grows an existing file in place with the lines from `fromLine` on (a live session). */
  appendTo(path: string, fromLine: number): void {
    const text = this.lines()
      .slice(fromLine)
      .map((line) => `${line}\n`)
      .join('');
    appendFileSync(path, text);
  }
}

/**
 * A long session: user/assistant pairs of about a kilobyte until the file reaches `targetBytes`. With `maxLineBytes` one
 * single line of exactly that many bytes is included first (survey 8.23). Deterministic.
 */
export function bigTranscript(opts: {
  sessionId: string;
  targetBytes: number;
  maxLineBytes?: number;
}): TranscriptBuilder {
  const b = new TranscriptBuilder({ sessionId: opts.sessionId, cwd: 'FIXTURE/big', startMs: FIXTURE_EPOCH_MS });
  if (opts.maxLineBytes !== undefined) {
    const head = JSON.stringify({ type: 'user', message: { role: 'user', content: 'FIXTURE long line ' } });
    const room = opts.maxLineBytes - Buffer.byteLength(head);
    if (room < 0) throw new RangeError(`bigTranscript: maxLineBytes ${String(opts.maxLineBytes)} is too small`);
    b.raw({ type: 'user', message: { role: 'user', content: `FIXTURE long line ${'x'.repeat(room)}` } });
  }
  const filler = 'lorem ipsum '.repeat(60);
  for (let i = 0; b.sizeBytes < opts.targetBytes; i += 1) {
    b.user(`FIXTURE big prompt ${String(i)} ${filler}`);
    b.assistant({ messageId: `msg_fixture_big_${String(i)}`, text: `FIXTURE big answer ${String(i)} ${filler}` });
  }
  return b;
}
