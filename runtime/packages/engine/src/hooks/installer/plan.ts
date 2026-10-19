// The pure core of the hooks installer (02 3.3, 3.4; ADR 0014, ADR 0070): the shape of our settings entries, how one is
// recognised, and `planHooks`, which turns the text of a settings file into the text it should have after an install or an
// uninstall. Nothing here touches the file system, the clock or the environment.
//
// What the plan keeps of a user's file: every key and its order, the indentation (spaces or tabs), the line ending, the byte
// order mark and the final newline. What it does not keep: spacing the user chose inside a line, and the exact spelling of
// numbers (the file goes through `JSON.parse` and `JSON.stringify`, so `1.0` becomes `1`). A file that is not strict JSON
// (comments, trailing commas) is refused, never rewritten.
//
// Ownership is the argument `--mcs-hook` (`isOurs`); nothing else is ever removed. An entry of ours that already equals the
// wanted one stays where it is (so an install after a user added a group below ours changes nothing).
import { McsError } from '@mcs/shared';
import type { HooksFailureReason } from '@mcs/shared';
import {
  ASYNC_HOOK_EVENTS,
  HOOK_EVENT_POLICY,
  INSTALLED_HOOK_EVENTS,
  normalizePath,
  type InstalledHookEvent,
} from '@mcs/shared/protocol';

export type HooksOp = 'install' | 'uninstall';

/** The handler that `mcs hooks install` writes: exec form, no shell (02 2.1, 3.3). */
export interface HookCommandEntry {
  readonly type: 'command';
  /** Absolute path of the Node executable of the installing CLI. */
  readonly command: string;
  /** `--no-warnings`, the hook script, the marker, the event, and `--async` for the tool events. */
  readonly args: readonly string[];
  /** Seconds. */
  readonly timeout: number;
  readonly async?: true;
}

export interface EntryContext {
  /** `process.execPath` of the installing CLI. */
  readonly nodePath: string;
  /** The script the entry runs: the stable copy under `$MCS_HOME/hooks` (ADR 0070). */
  readonly hookEntryPath: string;
  /** `--sync-tool-events`: install the four tool events as synchronous hooks. */
  readonly syncToolEvents?: boolean;
}

/** The argument that marks an entry as ours (02 3.3). */
export const HOOK_MARKER = '--mcs-hook';

const SHELL_MARKER = /(^|\s)--mcs-hook(\s|$)/;
const ASYNC_EVENTS: ReadonlySet<string> = new Set(ASYNC_HOOK_EVENTS);

/** A `HOOKS_FAILED` error with its `details.reason`. */
export function hooksFailed(
  reason: HooksFailureReason,
  message: string,
  extra: {
    readonly hint?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  } = {},
): McsError {
  return new McsError('HOOKS_FAILED', message, {
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
    details: { reason, ...extra.details },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The handler list of a group (`{ matcher?, hooks: [...] }`); `null` for anything else. */
function handlersOf(group: unknown): unknown[] | null {
  if (!isPlainObject(group)) return null;
  const handlers = group['hooks'];
  return Array.isArray(handlers) ? handlers : null;
}

/** True for a handler that carries our marker: an exec-form argument, or a word of a shell-form command (02 3.3). */
export function isOurs(handler: unknown): boolean {
  if (!isPlainObject(handler) || handler['type'] !== 'command') return false;
  const args = handler['args'];
  if (Array.isArray(args) && args.includes(HOOK_MARKER)) return true;
  const command = handler['command'];
  return typeof command === 'string' && SHELL_MARKER.test(command);
}

/** Our entry for one event (02 3.3). Every path goes through `normalizePath`. */
export function buildEntry(event: InstalledHookEvent, ctx: EntryContext): HookCommandEntry {
  const isAsync = ASYNC_EVENTS.has(event) && ctx.syncToolEvents !== true;
  const entry: HookCommandEntry = {
    type: 'command',
    command: normalizePath(ctx.nodePath),
    args: ['--no-warnings', normalizePath(ctx.hookEntryPath), HOOK_MARKER, event, ...(isAsync ? ['--async'] : [])],
    timeout: HOOK_EVENT_POLICY[event].timeoutSeconds,
  };
  return isAsync ? { ...entry, async: true } : entry;
}

/** Our entries for all installed events, in installation order. */
export function desiredEntries(ctx: EntryContext): Map<InstalledHookEvent, HookCommandEntry> {
  return new Map(INSTALLED_HOOK_EVENTS.map((event) => [event, buildEntry(event, ctx)]));
}

// ---- layout of the file -------------------------------------------------------------------------------------------------

interface Layout {
  readonly bom: boolean;
  readonly indent: string;
  readonly eol: '\n' | '\r\n';
  readonly finalNewline: boolean;
}

export const BOM = String.fromCharCode(0xfeff);
const DEFAULT_INDENT = '  ';
const MAX_INDENT = 10;

/** The layout of an existing file, or the defaults (two spaces, LF, final newline) for a missing or blank one. */
function detectLayout(text: string): Layout {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  if (body.trim() === '') return { bom, indent: DEFAULT_INDENT, eol: '\n', finalNewline: true };
  const lead = /^([ \t]+)\S/m.exec(body)?.[1];
  return {
    bom,
    indent: lead === undefined ? DEFAULT_INDENT : lead.slice(0, MAX_INDENT),
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    finalNewline: body.endsWith('\n'),
  };
}

function render(value: unknown, layout: Layout): string {
  let text = JSON.stringify(value, null, layout.indent);
  if (layout.eol === '\r\n') text = text.replaceAll('\n', '\r\n');
  return (layout.bom ? BOM : '') + text + (layout.finalNewline ? layout.eol : '');
}

/** `line L, column C` of the character offset that a V8 JSON error names; `null` when the message names none. */
function locationOf(body: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  const match = /position (\d+)/.exec(message);
  if (match?.[1] === undefined) return null;
  const offset = Math.min(Number(match[1]), body.length);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (body.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return `line ${String(line)}, column ${String(offset - lineStart + 1)}`;
}

function parseSettings(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    // The parser's own message quotes the text around the error, which may hold a token: only the position is reported.
    const where = locationOf(body, error);
    throw hooksFailed(
      'SETTINGS_INVALID_JSON',
      `the settings file is not valid JSON${where === null ? '' : ` (near ${where})`}; nothing was written`,
      { hint: 'fix the file by hand, or point --settings-file at another file' },
    );
  }
  if (!isPlainObject(value)) {
    throw hooksFailed(
      'SETTINGS_NOT_OBJECT',
      'the top level of the settings file is not a JSON object; nothing was written',
    );
  }
  return value;
}

// ---- the plan -------------------------------------------------------------------------------------------------------------

export interface HooksPlan {
  /** The settings object after the change (the parsed original when nothing changes). */
  readonly obj: Record<string, unknown>;
  /** The file text after the change; the original text when nothing changes, `''` for a missing file. */
  readonly text: string;
  readonly changed: boolean;
  /** The file did not exist (`text === null`). */
  readonly created: boolean;
  /** Event names (02 3.4 step 8). */
  readonly added: string[];
  readonly replaced: string[];
  readonly removed: string[];
  readonly kept: string[];
  /** Unified diff of the `hooks` key, 3 lines of context; empty when nothing changes. */
  readonly diff: string;
}

/** Canonical text of a JSON value (object keys sorted), to compare two entries without regard to key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isPlainObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** True when two handlers are the same JSON value, whatever the order of their keys. */
export function sameHandler(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Our handlers in a settings object, by event, in file order. Events without one are absent from the map. */
export function ourHandlers(settings: unknown): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>();
  const hooks = isPlainObject(settings) ? settings['hooks'] : undefined;
  if (!isPlainObject(hooks)) return found;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const ours: unknown[] = [];
    for (const group of groups) for (const handler of handlersOf(group) ?? []) if (isOurs(handler)) ours.push(handler);
    if (ours.length > 0) found.set(event, ours);
  }
  return found;
}

/** The lines of `"hooks": <value>` as they stand in a two-space file; none for a file without the key. */
function hooksLines(value: unknown): string[] {
  return value === undefined ? [] : JSON.stringify({ hooks: value }, null, 2).split('\n').slice(1, -1);
}

/**
 * The settings text after an install or an uninstall (02 3.4). `desired` maps an event to the entry that must be installed
 * for it, in installation order; an uninstall passes an empty map. Throws `HOOKS_FAILED` (`details.reason`
 * `SETTINGS_INVALID_JSON`, `SETTINGS_NOT_OBJECT`, `SETTINGS_HOOKS_NOT_OBJECT` or `SETTINGS_EVENT_NOT_ARRAY`) for a file that
 * cannot be edited safely; the caller writes nothing then.
 */
export function planHooks(text: string | null, op: HooksOp, desired: ReadonlyMap<string, HookCommandEntry>): HooksPlan {
  const layout = detectLayout(text ?? '');
  const obj = parseSettings(text);
  const hadHooks = Object.hasOwn(obj, 'hooks');
  const hooksValue = hadHooks ? obj['hooks'] : {};
  if (!isPlainObject(hooksValue)) {
    throw hooksFailed(
      'SETTINGS_HOOKS_NOT_OBJECT',
      'the "hooks" key of the settings file is not a JSON object; nothing was written',
    );
  }
  const hooks = hooksValue;
  const beforeLines = hadHooks ? hooksLines(hooks) : [];
  const wanted = op === 'install' ? desired : new Map<string, HookCommandEntry>();
  const known = new Set<string>([...INSTALLED_HOOK_EVENTS, ...desired.keys()]);

  // Step 4: take our handlers out of every event; remember what was there, event by event.
  const before = new Map<string, string[]>();
  const keptInPlace = new Set<string>();
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) {
      if (known.has(event)) {
        throw hooksFailed(
          'SETTINGS_EVENT_NOT_ARRAY',
          `hooks.${event} in the settings file is not an array; nothing was written`,
          { details: { event } },
        );
      }
      continue;
    }
    const ours: string[] = [];
    for (const group of groups) {
      for (const handler of handlersOf(group) ?? []) if (isOurs(handler)) ours.push(canonical(handler));
    }
    if (ours.length === 0) continue;
    const entry = wanted.get(event);
    if (ours.length === 1 && entry !== undefined && ours[0] === canonical(entry)) {
      keptInPlace.add(event);
      continue;
    }
    before.set(event, ours);
    let emptied = false;
    const remaining: unknown[] = [];
    for (const group of groups) {
      const handlers = handlersOf(group);
      if (handlers !== null && isPlainObject(group)) {
        const left = handlers.filter((handler) => !isOurs(handler));
        if (left.length === 0 && handlers.length > 0) {
          emptied = true;
          continue;
        }
        group['hooks'] = left;
      }
      remaining.push(group);
    }
    if (remaining.length === 0 && emptied) Reflect.deleteProperty(hooks, event);
    else hooks[event] = remaining;
  }

  // Step 5: one group with our handler for each wanted event, after the groups of the user.
  const added: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  for (const [event, entry] of wanted) {
    if (keptInPlace.has(event)) {
      kept.push(event);
      continue;
    }
    const existing = hooks[event];
    const groups: unknown[] = Array.isArray(existing) ? existing : [];
    hooks[event] = [...groups, { hooks: [{ ...entry, args: [...entry.args] }] }];
    (before.has(event) ? replaced : added).push(event);
  }
  const removed = [...before.keys()].filter((event) => !wanted.has(event));

  if (added.length + replaced.length + removed.length === 0) {
    return { obj, text: text ?? '', changed: false, created: text === null, added, replaced, removed, kept, diff: '' };
  }

  // Step 6: no empty "hooks" key that we left behind, and none that the file did not have.
  if (Object.keys(hooks).length === 0) delete obj['hooks'];
  else obj['hooks'] = hooks;
  const newText = render(obj, layout);
  const afterLines = hooksLines(obj['hooks']);
  return {
    obj,
    text: newText,
    changed: newText !== (text ?? ''),
    created: text === null,
    added,
    replaced,
    removed,
    kept,
    diff: unifiedDiff(beforeLines, afterLines, 3),
  };
}

// ---- unified diff ---------------------------------------------------------------------------------------------------------

interface DiffOp {
  readonly kind: ' ' | '-' | '+';
  readonly line: string;
}

/** Longest-common-subsequence table size above which two blocks are shown as removed and added as a whole. */
const MAX_LCS_CELLS = 4_000_000;

function diffMiddle(a: readonly string[], b: readonly string[]): DiffOp[] {
  if (a.length === 0) return b.map((line) => ({ kind: '+', line }));
  if (b.length === 0) return a.map((line) => ({ kind: '-', line }));
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    return [...a.map((line): DiffOp => ({ kind: '-', line })), ...b.map((line): DiffOp => ({ kind: '+', line }))];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const down = table[(i + 1) * width + j] ?? 0;
      const right = table[i * width + j + 1] ?? 0;
      table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(down, right);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ kind: '-', line: a[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) ops.push({ kind: '-', line: a[i] ?? '' });
  for (; j < b.length; j += 1) ops.push({ kind: '+', line: b[j] ?? '' });
  return ops;
}

/**
 * A unified diff of two line lists with `context` lines around each change; `''` when they are equal. The headers name no
 * file: the caller shows it under its own heading.
 */
export function unifiedDiff(a: readonly string[], b: readonly string[], context: number): string {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === a.length && start === b.length) return '';
  const ops: DiffOp[] = [
    ...a.slice(0, start).map((line): DiffOp => ({ kind: ' ', line })),
    ...diffMiddle(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((line): DiffOp => ({ kind: ' ', line })),
  ];

  const changes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== ' ') changes.push(index);
  });
  const out: string[] = ['--- hooks (current)', '+++ hooks (planned)'];
  let k = 0;
  while (k < changes.length) {
    let last = changes[k] ?? 0;
    const first = changes[k] ?? 0;
    k += 1;
    while (k < changes.length && (changes[k] ?? 0) - last <= 2 * context + 1) {
      last = changes[k] ?? last;
      k += 1;
    }
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + context + 1);
    let aStart = 1;
    let bStart = 1;
    for (let n = 0; n < from; n += 1) {
      if (ops[n]?.kind !== '+') aStart += 1;
      if (ops[n]?.kind !== '-') bStart += 1;
    }
    const hunk = ops.slice(from, to);
    const aCount = hunk.filter((op) => op.kind !== '+').length;
    const bCount = hunk.filter((op) => op.kind !== '-').length;
    out.push(
      `@@ -${String(aCount === 0 ? aStart - 1 : aStart)},${String(aCount)} +${String(bCount === 0 ? bStart - 1 : bStart)},${String(bCount)} @@`,
    );
    for (const op of hunk) out.push(op.kind + op.line);
  }
  return out.join('\n');
}
