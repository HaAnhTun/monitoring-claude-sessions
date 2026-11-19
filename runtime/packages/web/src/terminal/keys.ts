// Who owns a key press while the terminal has the focus (design 04 section 7.5, WCAG 2.1.2): xterm encodes almost everything, and
// this module names the exceptions. Pure, so every row of the table is a unit test; the view (useTerminalConnection) performs
// the effect of the answer. It is installed as the custom key handler of the terminal, which asks for one decision per key event.
//
//   pass     the event goes on to xterm (the handler returns true): letters, Tab and Shift+Tab (they belong to the program), the paste
//            keys Ctrl+Shift+V and Shift+Insert (xterm produces no key for them, so the browser pastes into xterm's text area; xterm
//            wraps it in a bracketed paste when the program asked for it), Ctrl+Insert (xterm's own copy listener), and Ctrl+C without
//            a selection (xterm sends 0x03 and the program is interrupted). On macOS Ctrl+V passes too: it stays the program's.
//   paste    plain Ctrl+V outside macOS. xterm 6.0.0 encodes it as 0x16 and cancels the event, so the browser would never paste: the
//            program got a ^V and nothing was pasted (CAW-144, ADR 0135). The handler returns false WITHOUT preventing the default:
//            xterm then skips the key (no 0x16) and the browser's default action fires `paste` on xterm's text area, which xterm
//            turns into a bracketed paste. This is the one answer that returns false and does not call `preventDefault`.
//   copy     the selection goes to the clipboard and is cleared, so the second Ctrl+C interrupts: Ctrl+C or Meta+C with a selection,
//            and Ctrl+Shift+C with a selection.
//   swallow  Ctrl+Shift+C without a selection: it is neither an interrupt nor the browser's inspect shortcut.
//   release  Ctrl+Shift+Space: the way out of the terminal (the view moves the focus to the session list). The text shown next to the
//            pane is `RELEASE_CHORD` of protocol.ts.
//
// For every answer but `pass` and `paste` the handler returns false and prevents the default. Browser-reserved keys (Ctrl+W, Ctrl+T, Ctrl+N,
// Alt+F4, F11) never reach a page, so no row can name them.

/** What `decideKey` does with one key event. */
export type KeyDecision = 'pass' | 'copy' | 'paste' | 'release' | 'swallow';

/** The part of a `KeyboardEvent` that is read; a real event satisfies it. */
export interface KeyEventLike {
  readonly type: string;
  readonly key: string;
  /** The physical key (`Space`); optional because a synthetic event may carry none. */
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** True while an input method (a Vietnamese or CJK composition) is open. */
  readonly isComposing?: boolean;
  /** The legacy code of a key that an input method processes (229). */
  readonly keyCode?: number;
}

/** What the decision depends on besides the event. */
export interface KeyContext {
  readonly hasSelection: boolean;
  /** Plain Ctrl+V is a paste (everywhere but macOS, where it stays the program's): `!platformIsMac(navigator)`. */
  readonly ctrlVPastes: boolean;
}

/** The part of `navigator` that tells the platform; `userAgentData` is the modern source, `platform` the fallback. */
export interface PlatformSource {
  readonly userAgentData?: { readonly platform?: string } | undefined;
  readonly platform?: string | undefined;
}

const MAC_PLATFORM = /mac|iphone|ipad/i;

/** Whether the browser runs on an Apple platform: `userAgentData.platform` first, then `platform`; false when neither says. */
export function platformIsMac(nav: PlatformSource | undefined): boolean {
  if (nav === undefined) return false;
  const modern = nav.userAgentData?.platform;
  if (modern !== undefined && modern !== '') return MAC_PLATFORM.test(modern);
  return MAC_PLATFORM.test(nav.platform ?? '');
}

/** `keyCode` of a key that an input method has taken. */
const IME_PROCESSING_KEY_CODE = 229;

function isSpace(event: KeyEventLike): boolean {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
}

function isLetter(event: KeyEventLike, letter: string): boolean {
  return event.key.toLowerCase() === letter;
}

/**
 * The decision for one key event. Only `keydown` is decided: `keyup` and `keypress` pass, so xterm sees the rest of every sequence
 * it started. Nothing is decided during an input method composition, whatever keys the method reports.
 */
export function decideKey(event: KeyEventLike, ctx: KeyContext): KeyDecision {
  if (event.type !== 'keydown') return 'pass';
  if (event.isComposing === true || event.key === 'Process' || event.keyCode === IME_PROCESSING_KEY_CODE) return 'pass';
  const { ctrlKey, shiftKey, altKey, metaKey } = event;

  if (ctrlKey && shiftKey && !altKey && !metaKey && isSpace(event)) return 'release';

  if (isLetter(event, 'c') && !altKey) {
    if (ctrlKey && !metaKey) {
      // Ctrl+C is the program's interrupt unless something is selected; Ctrl+Shift+C is only ever a copy
      if (shiftKey) return ctx.hasSelection ? 'copy' : 'swallow';
      return ctx.hasSelection ? 'copy' : 'pass';
    }
    if (metaKey && !ctrlKey && !shiftKey && ctx.hasSelection) return 'copy';
  }

  if (ctx.ctrlVPastes && ctrlKey && !shiftKey && !altKey && !metaKey && isLetter(event, 'v')) return 'paste';

  return 'pass';
}
