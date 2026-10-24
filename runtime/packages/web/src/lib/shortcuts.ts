// Global keyboard shortcuts: the pure ignore rules and the help table (04 section 6.5). The registry that dispatches keys
// lives in state/shortcuts-registry.tsx.
/** The catalogue keys of the rows of the help table; none takes an argument. */
export type ShortcutDescriptionKey =
  | 'filters.focusSearch'
  | 'transcript.shortcut.follow'
  | 'transcript.shortcut.nextError'
  | 'transcript.shortcut.prevError'
  | 'shell.shortcutsHelp'
  | 'shortcuts.fixed.escape'
  | 'shortcuts.fixed.sidebar';

/** The parts of an event target the rules read; a DOM element satisfies it. */
export interface ShortcutTarget {
  tagName?: string | undefined;
  type?: string | undefined;
  isContentEditable?: boolean | undefined;
}

export interface KeyboardEventLike {
  key: string;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: ShortcutTarget | null;
}

const TEXT_INPUT_TYPES: readonly string[] = [
  'text',
  'search',
  'number',
  'email',
  'url',
  'tel',
  'password',
  'date',
  'time',
  'datetime-local',
  '',
];

/** True when the target takes typed text, so single-key shortcuts must not fire. */
export function isTextEntry(target: ShortcutTarget | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.includes((target.type ?? '').toLowerCase());
  return false;
}

/**
 * Should a global single-key shortcut run? False when the event was already handled, Ctrl, Meta or Alt is held, the
 * target takes typed text, or a dialog is open. Shift is allowed (`?`).
 */
export function shouldHandleShortcut(e: KeyboardEventLike, dialogOpen: boolean): boolean {
  if (dialogOpen || e.defaultPrevented) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return !isTextEntry(e.target);
}

/** The groups of the shortcuts dialog, in the order they are drawn. */
export const SHORTCUT_GROUPS = ['navigation', 'search', 'transcript'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/** The key caps that are words; a key not listed here is drawn as it is (`/`, `f`, `?`). */
export type KeyCapName = 'esc' | 'up' | 'down' | 'home' | 'end';

export interface ShortcutHelp {
  /** The keys of the row, one key cap each. */
  keys: readonly (string | { cap: KeyCapName })[];
  descriptionKey: ShortcutDescriptionKey;
  group: ShortcutGroup;
  /** True for a row that no component registers (native keys and the local handler of the session list). */
  fixed: boolean;
}

/** The rows of the shortcuts dialog and the group of every key that a component registers. */
export const SHORTCUT_HELP: readonly ShortcutHelp[] = [
  { keys: ['/'], descriptionKey: 'filters.focusSearch', group: 'search', fixed: false },
  { keys: ['f'], descriptionKey: 'transcript.shortcut.follow', group: 'transcript', fixed: false },
  { keys: [']'], descriptionKey: 'transcript.shortcut.nextError', group: 'transcript', fixed: false },
  { keys: ['['], descriptionKey: 'transcript.shortcut.prevError', group: 'transcript', fixed: false },
  { keys: ['?'], descriptionKey: 'shell.shortcutsHelp', group: 'navigation', fixed: false },
  { keys: [{ cap: 'esc' }], descriptionKey: 'shortcuts.fixed.escape', group: 'navigation', fixed: true },
  {
    keys: [{ cap: 'up' }, { cap: 'down' }, { cap: 'home' }, { cap: 'end' }],
    descriptionKey: 'shortcuts.fixed.sidebar',
    group: 'navigation',
    fixed: true,
  },
];

/** The group of a key that a component registered; a key the table does not know is a navigation key. */
export function groupOfKey(key: string): ShortcutGroup {
  const row = SHORTCUT_HELP.find(
    (candidate) => !candidate.fixed && candidate.keys.length === 1 && candidate.keys[0] === key,
  );
  return row?.group ?? 'navigation';
}
