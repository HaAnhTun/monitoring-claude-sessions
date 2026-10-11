// Global keyboard shortcuts: the pure ignore rules and the help table (04 section 6.5). The registry that dispatches keys
// lives in state/shortcuts-registry.tsx.

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

export interface ShortcutHelp {
  keys: string;
  description: string;
}

/** The rows of the shortcuts dialog. */
export const SHORTCUT_HELP: readonly ShortcutHelp[] = [
  { keys: '/', description: 'Focus the search box of the page' },
  { keys: 'f', description: 'Follow new events (transcript) or pause the feed (activity)' },
  { keys: ']', description: 'Go to the next error' },
  { keys: '[', description: 'Go to the previous error' },
  { keys: '?', description: 'Show this list of shortcuts' },
  { keys: 'Esc', description: 'Close a dialog, or clear the search box when it has focus' },
  { keys: 'Up / Down / Home / End', description: 'Move through the session list in the sidebar' },
];
