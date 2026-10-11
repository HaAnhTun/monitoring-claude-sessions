// The display entries of one transcript record (03 7.1): the legacy `events_of` projection of `src/backend/reader.py`, implemented
// once. `displayEntries` builds the entries of a `user` or `assistant` record with the legacy clips (text `textChars`, tool input
// 4000, thinking 1500, summary 160, all in code points); `countEntries` gives the same count without building any text, which is
// what the entry index counts (7.2). `readEntryText` of 02 5.7 and the transcript window of 7.3 both call this module, so the
// projection has one home. The record is untrusted transcript data: nothing here assumes a shape, and a record of another
// shape produces no entries. Nothing is cached or persisted (ADR 0016).
import type { TranscriptEntry } from '@mcs/shared';

import { dumpPyJson, pyFloatRepr, pyRepr, type PyJsonValue } from '../pyjson/index.ts';

/** One display entry before the index `i` is known (registry 98: `Omit<TranscriptEntry, 'i'>`). */
export type DisplayEntry = Omit<TranscriptEntry, 'i'>;

/** Legacy clips that do not depend on the caller (`reader.py` `events_of`). */
export const TOOL_INPUT_CHARS = 4000;
export const THINK_CHARS = 1500;
export const SUMMARY_CHARS = 160;

const LF = String.fromCharCode(10);
const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'description', 'prompt', 'script'] as const;

type Plain = Readonly<Record<string, unknown>>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listOf(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: unknown[] = value;
  return items;
}

/** Python truthiness of a JSON value (`x or y`, `if x`). */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** `JSON.stringify` is undefined for a value that has no JSON form; the type says string only for the usual input. */
function plainJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/**
 * An integer-valued double from `JSON.parse` at or beyond 2**64 in magnitude. `JSON.parse` keeps no lexeme, so the file's `1e300`
 * and a 301-digit integer cannot be told apart: such a number is written as a float (`1e+300`, the likelier source), while an
 * integer below that bound is written with its digits (a 64-bit id; digits beyond 2**53 stay rounded, a recorded deviation).
 */
const FLOAT_FORM_FROM = 2 ** 64;
const MAX_JSON_DEPTH = 1000;

/** Plain `JSON.parse` data to the value the Python-style writer prints (`fromPlain` of the pyjson module, plus the rule above). */
function toPyValue(value: unknown, depth: number): PyJsonValue {
  if (depth > MAX_JSON_DEPTH) throw new RangeError('value is nested too deeply');
  if (value === null) return { k: 'null' };
  if (typeof value === 'boolean') return { k: 'bool', v: value };
  if (typeof value === 'string') return { k: 'str', v: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) < FLOAT_FORM_FROM
      ? { k: 'int', v: BigInt(value) }
      : { k: 'float', v: value };
  }
  const items = listOf(value);
  if (items !== undefined) return { k: 'arr', v: items.map((item) => toPyValue(item, depth + 1)) };
  if (isPlain(value)) {
    const fields: [string, PyJsonValue][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) fields.push([key, toPyValue(item, depth + 1)]);
    }
    return { k: 'obj', v: fields };
  }
  throw new TypeError('not JSON data');
}

/** `json.dumps(value, ensure_ascii=False)`: the legacy `clip` of a value that is not a string. */
function pyJsonText(value: unknown): string {
  try {
    return dumpPyJson(toPyValue(value, 0), { compact: true });
  } catch {
    // a lone surrogate (Python writes it, a UTF-8 file cannot) or a value nested too deeply: plain JSON is the closest text
    return plainJson(value) ?? '';
  }
}

/** Python `repr()` of a JSON value. */
function pyReprOf(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return pyRepr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  const items = listOf(value);
  if (items !== undefined) return `[${items.map(pyReprOf).join(', ')}]`;
  if (isPlain(value)) {
    const fields = Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyReprOf(item)}`);
    return `{${fields.join(', ')}}`;
  }
  return '';
}

/** Python `str()` of a JSON value, for the summary key of a tool input. */
function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : pyReprOf(value);
}

/** The code points of `text` and the UTF-16 length of the first `n` of them. */
function measure(text: string, n: number): { total: number; cut: number } {
  let total = 0;
  let cut = text.length;
  let unit = 0;
  for (const char of text) {
    if (total === n) cut = unit;
    total += 1;
    unit += char.length;
  }
  return { total, cut };
}

/**
 * The legacy `clip(s, n)`: the text itself up to `n` code points, else its first `n` code points and
 * ` ... [truncated K chars]`. A value that is not a string is first written as JSON (`json.dumps`).
 */
export function clipText(value: unknown, n: number): string {
  const text = typeof value === 'string' ? value : pyJsonText(value);
  // a text of at most `n` UTF-16 units has at most `n` code points: the common case allocates nothing
  if (text.length <= n) return text;
  const { total, cut } = measure(text, n);
  return total <= n ? text : `${text.slice(0, cut)} ... [truncated ${String(total - n)} chars]`;
}

/** Python `str.isspace` for one code point. */
function isPySpace(code: number): boolean {
  if (code >= 9 && code <= 13) return true;
  if (code >= 0x1c && code <= 0x20) return true;
  if (code === 0x85 || code === 0xa0 || code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  return code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** Python `bool(text.strip())`. */
function hasContent(text: string): boolean {
  for (const char of text) {
    if (!isPySpace(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** The record time as the legacy code reads it: `timestamp` when it is a text, else the empty text. */
export function recordTimestamp(record: unknown): string {
  if (!isPlain(record)) return '';
  const stamp = record['timestamp'];
  return typeof stamp === 'string' ? stamp : '';
}

/** The `message.content` of a record: undefined unless `message` is an object. */
function contentOf(record: Plain): unknown {
  const message = record['message'];
  return isPlain(message) ? message['content'] : undefined;
}

/** The text of a `tool_result` block: a list of text parts is joined with LF (legacy), a falsy value is the empty text. */
function resultText(content: unknown): unknown {
  let value = content;
  const parts = listOf(value);
  if (parts !== undefined) {
    // legacy: `LF.join(x.get('text', '') for x in cc if isinstance(x, dict))`: an item that is not an object is left out
    value = parts
      .filter(isPlain)
      .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
      .join(LF);
  }
  return truthy(value) ? value : '';
}

/** The first line of the first truthy of `command`, `file_path`, `pattern`, `description`, `prompt`, `script` (legacy `key`). */
function summaryOf(input: Plain): string {
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (truthy(value)) {
      const text = pyStr(value);
      const line = text.indexOf(LF);
      return clipText(line < 0 ? text : text.slice(0, line), SUMMARY_CHARS);
    }
  }
  return '';
}

/**
 * The legacy `events_of(record, text_chars)`: kinds `prompt | say | think | tool | result`, in block order. Only `user` and
 * `assistant` records produce entries; anything else, and any block of an unexpected shape, produces none.
 */
export function displayEntries(record: unknown, opts: { textChars: number }): DisplayEntry[] {
  if (!isPlain(record)) return [];
  const type = record['type'];
  const content = contentOf(record);
  const blocks = listOf(content);
  const t = recordTimestamp(record);
  const out: DisplayEntry[] = [];
  if (type === 'user') {
    if (typeof content === 'string') {
      out.push({ t, k: 'prompt', text: clipText(content, opts.textChars) });
    } else if (blocks !== undefined) {
      for (const block of blocks) {
        if (!isPlain(block)) continue;
        if (block['type'] === 'text') {
          out.push({ t, k: 'prompt', text: clipText('text' in block ? block['text'] : '', opts.textChars) });
        } else if (block['type'] === 'tool_result') {
          const id = block['tool_use_id'];
          out.push({
            t,
            k: 'result',
            ...(typeof id === 'string' ? { id } : {}),
            text: clipText(resultText(block['content']), opts.textChars),
            err: truthy(block['is_error']),
          });
        }
      }
    }
  } else if (type === 'assistant' && blocks !== undefined) {
    for (const block of blocks) {
      if (!isPlain(block)) continue;
      const blockType = block['type'];
      if (blockType === 'text') {
        const text = block['text'];
        if (typeof text === 'string' && hasContent(text)) {
          out.push({ t, k: 'say', text: clipText(text, opts.textChars) });
        }
      } else if (blockType === 'tool_use') {
        const rawInput = block['input'];
        const input: Plain = isPlain(rawInput) ? rawInput : {};
        const id = block['id'];
        const name = block['name'];
        out.push({
          t,
          k: 'tool',
          ...(typeof id === 'string' ? { id } : {}),
          name: typeof name === 'string' && name.length > 0 ? name : '?',
          summary: summaryOf(input),
          input: clipText(input, TOOL_INPUT_CHARS),
        });
      } else if (blockType === 'thinking' && truthy(block['thinking'])) {
        out.push({ t, k: 'think', text: clipText(block['thinking'], THINK_CHARS) });
      }
    }
  }
  return out;
}

/** `displayEntries(record, ...).length` without building any text (the entry index counts with this, 7.2). */
export function countEntries(record: unknown): number {
  if (!isPlain(record)) return 0;
  const type = record['type'];
  const content = contentOf(record);
  const blocks = listOf(content);
  let count = 0;
  if (type === 'user') {
    if (typeof content === 'string') return 1;
    for (const block of blocks ?? []) {
      if (isPlain(block) && (block['type'] === 'text' || block['type'] === 'tool_result')) count += 1;
    }
  } else if (type === 'assistant') {
    for (const block of blocks ?? []) {
      if (!isPlain(block)) continue;
      const blockType = block['type'];
      if (blockType === 'text') {
        const text = block['text'];
        if (typeof text === 'string' && hasContent(text)) count += 1;
      } else if (blockType === 'tool_use') {
        count += 1;
      } else if (blockType === 'thinking' && truthy(block['thinking'])) {
        count += 1;
      }
    }
  }
  return count;
}
