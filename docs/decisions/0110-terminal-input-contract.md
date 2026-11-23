# 0110 Terminal input contract: Shift+Enter is a new line, letters are read by key then by physical key

Status: Accepted for the code, the sequence itself UNVERIFIED against the real client (CAW, 2026-11-23): spike C is pending, see "Verification". Owner: web terminal (CAW-86).
Related: 0097 (the key table and the release chord), 0098 (the browser side of the terminal protocol), 0135 decision 5 (the paste row of the key table).

## Context

While the terminal has the focus xterm encodes almost every key and `terminal/keys.ts` names the exceptions. Two rows were missing:

- **Shift+Enter submits.** People press Shift+Enter in the prompt of Claude Code for a new line. A browser terminal cannot tell the program: xterm 6.0.0 has no enhanced keyboard
  protocol and encodes Enter by key code alone, so Shift+Enter is a plain CR and the prompt is sent.
- **The letter rows read `event.key`.** On a layout that types no Latin letter (Cyrillic, Greek, Hebrew, Arabic, Thai) `key` of the physical C key is not `c`, so Ctrl+C with a
  selection did not copy and Ctrl+V did not paste. The interrupt itself was never affected: xterm takes the control byte from the key code.

## Evidence

- xterm 6.0.0, `src/common/input/Keyboard.ts` lines 100 to 102: `case 13: result.key = ev.altKey ? C0.ESC + C0.CR : C0.CR`. Shift is not read: Shift+Enter is CR, Alt+Enter is
  ESC CR. The same file builds Ctrl plus a letter from `keyCode`, not from `key`.
- Herdr `CHANGELOG.md` line 72 (release 0.9.3): "Escape-based Shift+Enter bindings insert a newline in Claude Code instead of submitting". Second-hand evidence that Claude Code
  reads an ESC-prefixed Enter as a new line. Line 1159 of the same file names a bare line feed ("inputs like Shift+Enter or Ctrl+J") as another input that is kept as a new line.
- Not evidence: nobody has pressed the key in a CAW terminal that runs the installed `claude` yet.

## Decision

1. **A fifth key decision, `newline`.** `decideKey` answers `newline` for a `keydown` of Enter (the numeric Enter too) with Shift and without Ctrl, Alt or Meta, with or without
   a selection, outside an input method composition. Every other Enter combination passes to xterm: Enter, Ctrl+Enter, Meta+Enter, Ctrl+Shift+Enter, and Alt+Enter, for which
   xterm sends ESC CR itself. The order of the checks is: composition guard, release chord, copy rows, paste row, new line.
2. **One constant.** `NEWLINE_SEQUENCE` in `terminal/keys.ts` is what Shift+Enter sends: `ESC CR` (bytes `1b 0d`), the sequence xterm already sends for Alt+Enter. The view
   prevents the default of the event (that also stops the `keypress` that would make xterm send its own CR) and sends the constant through `typeInto`, the one function that typed
   text takes too: the size is taken back first when another window owns it, the bytes are one ordinary binary input frame, and while the connection is down they are lost and
   "typing paused" is shown, never queued. The view also scrolls to the latest output, as xterm does for typed text. No change to the socket client, the protocol or the server.
3. **Fallback order, if the real client does not treat `ESC CR` as a new line:** first `LF` (`0a`, what Ctrl+J sends), then a backslash followed by CR (`5c 0d`). Both are
   unverified. Taking a fallback is a change of the one constant and of one row of `keys.test.ts`, recorded here with the `claude` version that needed it.
4. **Letters by key, then by physical key.** `lib/key-match.ts` `isLetterKey(event, letter)`: an ASCII letter in `key` decides alone, in either case, so a Latin layout that moves
   the letters (Dvorak, AZERTY) follows the letter and never the position; when `key` is one character outside ASCII the physical key `Key<LETTER>` of `code` decides; a named
   key (`Process` of an input method, `Dead`) and ASCII punctuation never match. The copy rows (Ctrl+C, Ctrl+Shift+C, Meta+C) and the paste row (Ctrl+V) of the key table use it.
5. **The help row.** The shortcuts dialog lists `Shift+Enter` in the Terminal group ("Insert a new line without sending", catalogues en and vi) as a fixed row.

## Verification

- Unit: `lib/key-match.test.ts` (TC-ERGO-03), `terminal/keys.test.ts` (TC-ERGO-01: the Enter rows, composition, `keyup` and `keypress`, the letter rows on Cyrillic, Hebrew and
  Dvorak), `terminal/useTerminalConnection.test.tsx` (TC-ERGO-02: one `1b 0d` frame and no `0d`, the size taken back first, lost while the connection is down, Alt+Enter, Enter
  and a paste untouched).
- **Spike C (what the installed `claude` does with `ESC CR`) is pending**: `docs/design/spike-results.md` has no result for it. Until it has one, decision 2 ships as the
  default and is settled by the manual owner step **ERGO-M1**: in a CAW terminal running the real `claude` (with a throw-away `CLAUDE_CONFIG_DIR`), type `a`,
  press Shift+Enter, type `b`; the prompt shows two lines and nothing was sent; Enter sends both. Record the `claude` version here. If the step fails, take the next entry of
  decision 3.
- The byte path under a real ConPTY (the child receives exactly `1b 0d` for Shift+Enter and for Alt+Enter, `0d` for Enter; a Vietnamese composition arrives as exact UTF-8; copy by
  physical key in Chrome) is proven by the specs of CAW-87, not by this package. If ConPTY rewrites the pair, those specs name the bytes the child received and this ADR records them.

## Consequences / revisit

Shift+Enter no longer reaches a program as CR: a program that wants CR for it gets ESC CR, which is what it already gets for Alt+Enter. On a layout whose letter key types ASCII
punctuation the letter rows do not apply, by design. Revisit when xterm ships an enhanced keyboard protocol that Claude Code negotiates: the row then passes to xterm and the constant goes away.
