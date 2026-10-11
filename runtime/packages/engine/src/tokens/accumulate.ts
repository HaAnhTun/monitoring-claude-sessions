// Token accounting, record side (02 6.1, 6.2 rules 1-3, 5, 10-12): one transcript record -> the message key and the effective
// values that `UsageRepo.applyRecord` maximizes per file and per instance (03 3.6).
//
// Pure: no clock, no file, no database (`accumulateRecord` is the one function that hands the result to the repository).
// Only numbers leave this module; text, thinking and tool bodies of the record are never read. Hooks never come through
// here (D8): the one input is a transcript record of type `assistant`.
import type { RepoContext } from '../db/open.ts';
import type { UsageApplyResult, UsageRepo, UsageSource, UsageValues } from '../db/repos/usage.ts';
import type { WriteTx } from '../db/write.ts';
import type { TranscriptRecord } from '../ingest/transcripts/normalize-record.ts';

/** `message.model` of the placeholder messages Claude Code writes itself (counted as messages, never priced, 02 6.2 rule 10). */
export const SYNTHETIC_MODEL = '<synthetic>';
/** A `message.id` or a record `uuid` longer than this is not used as a key (the key column holds 160 characters). */
export const MESSAGE_KEY_PART_MAX = 128;
/** `usage_files.model` holds 128 characters. */
const MODEL_MAX = 128;

/** Where the record is: the key of a record that has neither id nor uuid is its position (legacy `line<offset>`, 02 6.2 rule 1). */
export interface RecordSite {
  readonly fileId: number;
  readonly byteOffset: number;
}

export interface RecordUsage {
  readonly messageKey: string;
  readonly values: UsageValues;
}

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A valid number (02 6.2 rule 2): a safe integer >= 0. Anything else is missing for the record. */
function isValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function keyPart(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MESSAGE_KEY_PART_MAX ? value : undefined;
}

/** `message.id`, else `uuid:<uuid>`, else `line:<file id>:<byte offset>` (02 6.2 rule 1). */
export function messageKeyOf(record: TranscriptRecord, site: RecordSite): string {
  const id = keyPart(record.message?.id);
  if (id !== undefined) return id;
  const uuid = keyPart(record.uuid);
  if (uuid !== undefined) return `uuid:${uuid}`;
  return `line:${String(site.fileId)}:${String(site.byteOffset)}`;
}

/** One field read: its valid value or `null`, and whether the key was present but not valid (counted in `invalid_values`). */
interface Read {
  readonly value: number | null;
  readonly invalid: number;
}

const ABSENT: Read = { value: null, invalid: 0 };

function read(from: Rec | undefined, key: string): Read {
  if (from === undefined || !Object.hasOwn(from, key)) return ABSENT;
  const value = from[key];
  return isValid(value) ? { value, invalid: 0 } : { value: null, invalid: 1 };
}

function child(from: Rec | undefined, key: string): Rec | undefined {
  const value = from?.[key];
  return isRec(value) ? value : undefined;
}

/** The four main fields, in the order input, output, cache read, cache creation (the names are the transcript's). */
const MAIN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

function positive(value: unknown): boolean {
  return isValid(value) && value > 0;
}

/** `iterations[0]` when it is an object (02 6.2 rule 3), else `undefined`. */
function firstIteration(usage: Rec | undefined): Rec | undefined {
  const iterations = usage?.['iterations'];
  if (!Array.isArray(iterations) || iterations.length === 0) return undefined;
  const first: unknown = iterations[0];
  return isRec(first) ? first : undefined;
}

function tsOf(record: TranscriptRecord): number | null {
  const text = record.timestamp;
  if (text === undefined) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) && at >= 0 ? at : null;
}

/**
 * The key and the effective values of one record, or `null` when the record is not an assistant message (only assistant
 * records carry tokens, 02 6.1). A record without a `usage` object is a message whose fields are all missing.
 */
export function usageOfRecord(record: TranscriptRecord, site: RecordSite): RecordUsage | null {
  if (record.type !== 'assistant' || record.message === undefined) return null;
  const message = record.message;
  const usage: Rec | undefined = isRec(message.usage) ? message.usage : undefined;

  const top = MAIN_KEYS.map((key) => read(usage, key));
  // rule 3: all four top-level fields 0 or missing, and iterations[0] has a positive value among the four
  const iteration = firstIteration(usage);
  const useIterations =
    iteration !== undefined &&
    top.every((r) => (r.value ?? 0) === 0) &&
    MAIN_KEYS.some((key) => positive(iteration[key]));
  const source: Rec | undefined = useIterations ? iteration : usage;
  const main = useIterations ? MAIN_KEYS.map((key) => read(source, key)) : top;
  const split = child(source, 'cache_creation');
  const split5m = read(split, 'ephemeral_5m_input_tokens');
  const split1h = read(split, 'ephemeral_1h_input_tokens');
  const thinking = read(child(usage, 'output_tokens_details'), 'thinking_tokens');
  const tools = child(usage, 'server_tool_use');
  const webSearch = read(tools, 'web_search_requests');
  const webFetch = read(tools, 'web_fetch_requests');

  const [input, output, cacheRead, cacheCreation] = main;
  const invalidValues = [
    ...top,
    ...(useIterations ? main : []),
    split5m,
    split1h,
    thinking,
    webSearch,
    webFetch,
  ].reduce((n, r) => n + r.invalid, 0);
  const stop = message.stop_reason;
  const model = typeof message.model === 'string' && message.model !== '' ? message.model : null;
  const usageSource: UsageSource = useIterations ? 'iterations' : 'top';
  const [legacyIn, legacyOut, legacyCr, legacyCc] = top.map((r) => r.value ?? 0);

  return {
    messageKey: messageKeyOf(record, site),
    values: {
      model: model === null ? null : model.slice(0, MODEL_MAX),
      inputTokens: input?.value ?? null,
      outputTokens: output?.value ?? null,
      cacheReadTokens: cacheRead?.value ?? null,
      cacheCreationTokens: cacheCreation?.value ?? null,
      cacheCreation5mTokens: split5m.value,
      cacheCreation1hTokens: split1h.value,
      thinkingTokens: thinking.value,
      webSearchRequests: webSearch.value,
      webFetchRequests: webFetch.value,
      legacyIn: legacyIn ?? 0,
      legacyOut: legacyOut ?? 0,
      legacyCr: legacyCr ?? 0,
      legacyCc: legacyCc ?? 0,
      finalized: (typeof stop === 'string' && stop !== '') || Array.isArray(usage?.['iterations']),
      usageSource,
      synthetic: model === SYNTHETIC_MODEL,
      ts: tsOf(record),
      invalidValues,
    },
  };
}

/**
 * Applies one transcript record to the usage tables inside the caller's write transaction. Returns `null` for a record that
 * carries no tokens (anything but an assistant message), else what the repository changed.
 */
export function accumulateRecord(
  repo: UsageRepo,
  ctx: RepoContext,
  tx: WriteTx,
  site: RecordSite,
  record: TranscriptRecord,
): UsageApplyResult | null {
  const usage = usageOfRecord(record, site);
  if (usage === null) return null;
  return repo.applyRecord(ctx, tx, site.fileId, usage.messageKey, usage.values);
}
