// The connection of one terminal session (design 04 7.3, ADR 0098): the engine, the socket, the theme, the size and the keyboard of
// ONE open session, wired together for the view. It is written against the engine seam (`engine.ts`) and the socket seam
// (`seams.ts`), so it never imports xterm and a test drives it with a fake terminal and a fake WebSocket.
//
// The twelve steps, as the code below does them:
//  1. load the engine (a failure is `engine-failed`; Retry loads it again);  2. create the terminal, open it on the host, label its
//  text area, attach the key handler, watch the host size (nothing is fitted yet);  3. open the socket;  4. `ready`: reset the
//  screen and adopt the size of the process, so the replay is read at the geometry that produced it, and stop fitting;  5. binary
//  frames are written to the terminal as they come;  6. `live`: fit, send our size when it differs from the process, focus once when
//  the page asked;  7. `size`: another window resized, mirror it; typing here (or the button) takes the size back;  8. `exit`: the
//  view is over;  9. typed text and xterm's binary channel go to the socket, lost (and said so) while the connection is down;
//  10. fit after a 100 ms trailing debounce, send a size only when it changed, send nothing from a hidden tab;  11. a lost
//  connection reconnects by itself and asks the session list whether the session is gone;  12. cleanup disposes everything, so
//  StrictMode's mount, cleanup, mount leaves one terminal and one socket.
//
// Beyond the twelve steps (CAW-144, ADR 0135): the GPU renderer is attached right after `open` and a lost GPU context only costs a
// fit; plain Ctrl+V is left to the browser's paste event; a right click copies a selection or pastes (the next one opens the
// browser menu when the clipboard cannot be read, and at once when the page policy forbids reading it); a selection can be copied
// when the mouse goes up.
//
// What a person types and what the process prints are never logged and never kept: they pass from the terminal to the socket and
// back. React state holds only the status, the sizes and two flags.
import { clampTerminalSize, TERMINAL_CLOSE_CODES, type TerminalServerMessage } from '@mcs/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback, type RefObject } from 'react';

import { markLocked } from '../data/hooks/useAuth.ts';
import { useIid } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { useT } from '../i18n/context.ts';
import type { TFunction } from '../i18n/types.ts';
import { copyText } from '../lib/clipboard.ts';
import { readTerminalOptions, TERMINAL_FONT, type TerminalTheme } from '../lib/term-theme.ts';
import { useAnnounce, type Announce } from '../state/announcer.tsx';
import { useTerminalTheme } from '../state/color-scheme.ts';
import { usePrefs } from '../state/prefs-store.ts';
import { useMediaQuery } from '../state/use-media-query.ts';
import type { Disposable, TerminalEngine, TerminalInstance, TerminalOptions } from './engine.ts';
import { decideKey, platformIsMac } from './keys.ts';
import { terminalOptionsFor } from './options.ts';
import { FIT_DEBOUNCE_MS, terminalSocketUrl } from './protocol.ts';
import { useTerminalSeams, type TerminalSeams } from './seams.ts';
import type { SocketSnapshot, TerminalSocket } from './ws-client.ts';

/** `prefers-reduced-motion: reduce`: the cursor does not blink. */
export const MQ_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** The viewport below which the terminal font is the smaller size (`terminalFontSize`: 12 px under 700 px). */
export const MQ_TERMINAL_NARROW = `(max-width: ${String(TERMINAL_FONT.narrowBelow - 1)}px)`;

/** Redraw: the size one row smaller, then the real size this long after, so a TUI repaints (design 04 7.3). */
const REDRAW_GAP_MS = 60;
/** How many sizes of our own wait for their echo; the server echoes every resize to every viewer, ours included. */
const OWN_SIZE_MEMORY = 16;
/** The second refused handshake of an outage is the moment to ask the session list again (design 04 8.2). */
const REFUSALS_BEFORE_ASKING_AGAIN = 2;

export type TerminalViewStatus =
  | { kind: 'loading-engine' }
  | { kind: 'engine-failed' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; attempt: number; nextRetryAt: number | null }
  | { kind: 'ended'; exitCode: number | null; killed: boolean }
  | { kind: 'locked' }
  | { kind: 'failed' };

/** How a session ended: the exit code when the process said one, and whether it was stopped (close 4001) rather than exited. */
export interface EndedOutcome {
  exitCode: number | null;
  killed: boolean;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** `'self'`: the process has the size of this window. A size: another window set it and this terminal mirrors it. */
export type SizeOwner = 'self' | TerminalSize;

/** What the page can do to the terminal from outside (the `t` shortcut, the pane header, the status line). */
export interface TerminalHandle {
  focus: () => void;
  blur: () => void;
  /** Sends one row less and then the real size, so the program repaints (the button for a garbled screen). */
  redraw: () => void;
  /** Fits this window and sends its size: the process follows this window again. */
  takeSize: () => void;
  scrollToLatest: () => void;
}

export interface UseTerminalConnectionOptions {
  /** The session name (`TERMINAL_NAME_RE`): the socket of this session. The view is keyed by instance and name, so it does not change. */
  name: string;
  /** The session list is fresh and lacks the session: the connection stops and the view ends (the oracle of design 04 8.2). */
  gone: boolean;
  /** Focus the terminal on the first `live` (the person picked this session; a reconnect or a reload is not a pick). */
  focusOnLive: boolean;
  /** The view ended. Called when the end is known (the exit frame, or the session is gone) and once more if a stop refines it. */
  onEnded: (outcome: EndedOutcome) => void;
  /** The process runs under ConPTY. Left out when the caller does not know: the wire contract carries no host platform today. */
  windowsHost?: boolean | undefined;
}

export interface TerminalConnection {
  /** Give it to the host element: the terminal opens there. */
  hostRef: RefCallback<HTMLElement>;
  status: TerminalViewStatus;
  /** The size of the terminal now (for `data-cols` and `data-rows`); `null` until the terminal exists. */
  size: TerminalSize | null;
  sizeOwner: SizeOwner;
  /** The history is scrolled up: the "Jump to latest output" pill shows. */
  scrolledUp: boolean;
  /** Something was typed while the connection was down (once per outage); it was not sent and will not be. */
  typingPaused: boolean;
  handle: TerminalHandle;
  /** Retry now: loads the engine again, or skips the wait of a reconnect, or retries after a failed ending. */
  retryNow: () => void;
}

// ---- focus -----------------------------------------------------------------------------------------------------------------

/**
 * Where the focus goes when the person leaves the terminal with the release chord: the selected session row, else the project list,
 * else the main area. Returns whether something took the focus.
 */
export function focusOutsideTerminal(doc: Document = document): boolean {
  for (const selector of ['[data-nav-item][aria-current="true"]', '#project-list', '#main']) {
    const target = doc.querySelector<HTMLElement>(selector);
    if (target === null) continue;
    target.focus();
    if (doc.activeElement === target) return true;
  }
  return false;
}

// ---- the session -----------------------------------------------------------------------------------------------------------

/** What the session reports to React: plain setters, so the session knows nothing of hooks. */
interface UiSink {
  setStatus(status: TerminalViewStatus): void;
  setSize(size: TerminalSize): void;
  setSizeOwner(owner: SizeOwner): void;
  setScrolledUp(scrolledUp: boolean): void;
  setTypingPaused(paused: boolean): void;
}

/** What the session needs from the page, read at the moment it is needed (the page changes while the session lives). */
interface SessionEffects {
  onEnded(outcome: EndedOutcome): void;
  /** The page asked to focus on the first `live`. */
  focusOnLive(): boolean;
  /** The session list says the session is gone. */
  gone(): boolean;
  inputLabel(): string;
  /** Copies the text, tells the person (unless `announce` is false: a refusal is told anyway), and resolves whether it worked. */
  copy(text: string, options?: { announce?: boolean }): Promise<boolean>;
  /**
   * Whether the page may read the clipboard at all: false when its permissions policy forbids it (the server sends
   * `clipboard-read=()`), so that a click does not pretend to paste. True when the browser cannot tell.
   */
  clipboardReadable(): boolean;
  /** The text of the clipboard, or null when the browser cannot or will not give it. */
  readClipboard(): Promise<string | null>;
  /** The clipboard cannot be read: tell the person how to paste. */
  announcePasteBlocked(): void;
  /** What a right click does now (the preference, read when it happens). */
  rightClick(): 'smart' | 'menu';
  /** Whether a selection is copied when the mouse goes up (the preference, read when it happens). */
  copyOnSelect(): boolean;
  /** A connection was lost: ask the session list whether the session is gone. */
  outage(): void;
  /** The browser lost its session (close 4003). */
  locked(): void;
  /** The release chord: focus leaves the terminal. */
  release(): void;
}

interface SessionEnv {
  host: HTMLElement;
  name: string;
  instance: TerminalInstance;
  createSocket: TerminalSeams['createSocket'];
  ui: UiSink;
  effects: SessionEffects;
}

interface Session {
  readonly terminal: TerminalInstance['terminal'];
  redraw(): void;
  takeSize(): void;
  retryNow(): void;
  /** The session list lacks the session: stop and end the view. */
  endGone(): void;
  /** The page changed something a live terminal can take (theme, font size, screen reader mode, cursor blink and shape). */
  applyOptions(options: TerminalOptions): void;
  applyInputLabel(label: string): void;
  dispose(): void;
}

function sameSize(a: TerminalSize, b: TerminalSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

type Timer = ReturnType<typeof setTimeout>;

function openSession(env: SessionEnv): Session {
  const { host, instance, ui, effects } = env;
  const { terminal, fit } = instance;
  const cleanups: (() => void)[] = [];
  let disposed = false;

  // fitting and sizes
  let fitSuspended = false;
  let applyingRemoteSize = false;
  let sizeOwner: SizeOwner = 'self';
  /** The size the process has, as far as we know: its `ready`, its `size` frames and what we sent. */
  let processSize: TerminalSize | null = null;
  const ownSizes: TerminalSize[] = [];
  let appliedFontSize = terminal.options.fontSize;
  let fitTimer: Timer | null = null;
  let redrawTimer: Timer | null = null;

  // the story of the connection
  let livesSeen = 0;
  let outageAsked = false;
  let refusalAsked = false;
  let reported: EndedOutcome | null = null;
  let hadFocusAtBlur = false;

  function setOwner(next: SizeOwner): void {
    sizeOwner = next;
    ui.setSizeOwner(next);
  }

  // ---- fitting -------------------------------------------------------------------------------------------------------------

  function fitNow(): void {
    if (disposed || fitSuspended || sizeOwner !== 'self') return;
    if (document.visibilityState === 'hidden') return;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    fit.fit();
  }

  function scheduleFit(): void {
    if (fitTimer !== null) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      fitNow();
    }, FIT_DEBOUNCE_MS);
  }

  /** Resizes the terminal to a size the process has (not one this window chose): no resize goes back to the server. */
  function mirrorSize(size: TerminalSize): void {
    applyingRemoteSize = true;
    try {
      terminal.resize(size.cols, size.rows);
    } finally {
      applyingRemoteSize = false;
    }
  }

  function noteOwnSize(size: TerminalSize): void {
    processSize = size;
    ownSizes.push(size);
    if (ownSizes.length > OWN_SIZE_MEMORY) ownSizes.shift();
  }

  /** The server echoes every resize to every viewer, ours too: true when `size` is the echo of one of ours (and forgets it and older ones). */
  function takeOwnEcho(size: TerminalSize): boolean {
    const at = ownSizes.findIndex((own) => sameSize(own, size));
    if (at < 0) return false;
    ownSizes.splice(0, at + 1);
    return true;
  }

  function sendSize(size: TerminalSize): void {
    if (fitSuspended || sizeOwner !== 'self') return;
    if (document.visibilityState === 'hidden') return;
    const clamped = clampTerminalSize(size.cols, size.rows);
    if (processSize !== null && sameSize(processSize, clamped)) return;
    if (socket.sendResize(clamped.cols, clamped.rows)) noteOwnSize(clamped);
  }

  function takeSize(): void {
    if (disposed) return;
    if (sizeOwner !== 'self') setOwner('self');
    fitNow();
  }

  // ---- ending --------------------------------------------------------------------------------------------------------------

  function reportEnded(outcome: EndedOutcome): void {
    ui.setStatus({ kind: 'ended', exitCode: outcome.exitCode, killed: outcome.killed });
    ui.setTypingPaused(false);
    if (reported?.exitCode === outcome.exitCode && reported.killed === outcome.killed) return;
    reported = outcome;
    effects.onEnded(outcome);
  }

  function endGone(): void {
    if (disposed) return;
    socket.stop();
    if (fitTimer !== null) clearTimeout(fitTimer);
    fitTimer = null;
    if (reported === null) reportEnded({ exitCode: null, killed: false });
  }

  // ---- the frames of the server --------------------------------------------------------------------------------------------

  function onReady(frame: Extract<TerminalServerMessage, { type: 'ready' }>): void {
    fitSuspended = true;
    ownSizes.length = 0;
    terminal.reset();
    const size = { cols: frame.cols, rows: frame.rows };
    mirrorSize(size);
    processSize = size;
    if (sizeOwner !== 'self') setOwner('self');
    ui.setScrolledUp(false);
    ui.setStatus({ kind: 'connecting' });
  }

  function onLive(): void {
    fitSuspended = false;
    outageAsked = false;
    refusalAsked = false;
    ui.setStatus({ kind: 'live' });
    ui.setTypingPaused(false);
    fitNow();
    const first = livesSeen === 0;
    livesSeen += 1;
    // focus once, and only when the person picked this session: a reconnect must not take the focus from where it is now
    if (first && effects.focusOnLive()) terminal.focus();
  }

  function onSize(frame: Extract<TerminalServerMessage, { type: 'size' }>): void {
    const size = { cols: frame.cols, rows: frame.rows };
    processSize = size;
    // the terminal follows the process either way: the output that follows was written for this size
    const differs = !sameSize(size, { cols: terminal.cols, rows: terminal.rows });
    if (differs) mirrorSize(size);
    if (takeOwnEcho(size)) {
      // a size of ours coming back (its echo may follow a resize of another window: then this window owns the size again)
      if (sizeOwner !== 'self') setOwner('self');
    } else if (differs) {
      setOwner(size);
    }
  }

  function onControl(frame: TerminalServerMessage): void {
    switch (frame.type) {
      case 'ready':
        onReady(frame);
        break;
      case 'live':
        onLive();
        break;
      case 'size':
        onSize(frame);
        break;
      case 'exit':
        reportEnded({ exitCode: frame.code, killed: false });
        break;
    }
  }

  function onSocketStatus(snapshot: SocketSnapshot): void {
    if (disposed) return;
    switch (snapshot.status) {
      case 'backoff':
        ui.setStatus({ kind: 'reconnecting', attempt: snapshot.attempt, nextRetryAt: snapshot.nextRetryAt });
        if (!outageAsked) {
          outageAsked = true;
          effects.outage();
        }
        if (snapshot.refusals >= REFUSALS_BEFORE_ASKING_AGAIN && !refusalAsked) {
          refusalAsked = true;
          effects.outage();
        }
        break;
      case 'connecting':
        // the first connection is `connecting` from `start()`; a later one is a reconnect
        if (snapshot.reconnects > 0) {
          ui.setStatus({ kind: 'reconnecting', attempt: snapshot.attempt, nextRetryAt: null });
        }
        break;
      case 'ended':
        if (snapshot.failed) {
          ui.setStatus({ kind: 'failed' });
        } else {
          reportEnded({
            exitCode: snapshot.exit?.code ?? null,
            killed: snapshot.lastCloseCode === TERMINAL_CLOSE_CODES.killed,
          });
        }
        break;
      case 'locked':
        ui.setStatus({ kind: 'locked' });
        effects.locked();
        break;
      // nothing to show: `idle` is before `start`, `open` waits for `ready` and `live`, `stopped` is our own stop
      case 'idle':
      case 'open':
      case 'stopped':
        break;
    }
  }

  // ---- the socket ----------------------------------------------------------------------------------------------------------

  const socket: TerminalSocket = env.createSocket({
    url: terminalSocketUrl(env.name, window.location),
    onData: (bytes) => {
      terminal.write(bytes);
    },
    onControl,
    onStatus: onSocketStatus,
  });

  // ---- the terminal --------------------------------------------------------------------------------------------------------

  terminal.open(host);
  terminal.textarea?.setAttribute('aria-label', effects.inputLabel());
  ui.setSize({ cols: terminal.cols, rows: terminal.rows });

  // The GPU renderer goes on after `open`, so that a failure can never break the terminal (ADR 0135). When its context is lost for
  // good the terminal is on the DOM renderer again, whose cells may differ in size: fit, and nothing else (no toast, no reconnect).
  const fallbackSubscription = instance.renderer.onFallback(scheduleFit);
  cleanups.push(() => {
    fallbackSubscription.dispose();
  });
  try {
    instance.renderer.attach();
  } catch {
    // the real renderer never throws; whatever happened, the DOM renderer is what is drawing
  }

  // plain Ctrl+V is a paste outside macOS; on macOS it stays the program's
  const ctrlVPastes = !platformIsMac(navigator);

  terminal.attachCustomKeyEventHandler((event) => {
    switch (decideKey(event, { hasSelection: terminal.hasSelection(), ctrlVPastes })) {
      case 'pass':
        return true;
      case 'paste':
        // xterm 6.0.0 would send 0x16 and cancel the event. Returning false WITHOUT preventing the default makes xterm skip the key
        // and lets the browser fire `paste` on the text area, which xterm turns into a (bracketed) paste.
        return false;
      case 'copy': {
        event.preventDefault();
        const text = terminal.getSelection();
        void effects.copy(text).then((copied) => {
          // cleared only once it is on the clipboard, so the second Ctrl+C interrupts; a refusal keeps the selection to try again
          if (copied && !disposed && terminal.getSelection() === text) terminal.clearSelection();
        });
        return false;
      }
      case 'release':
        event.preventDefault();
        terminal.blur();
        effects.release();
        return false;
      case 'swallow':
        event.preventDefault();
        return false;
    }
  });

  // right click: with a selection copy it, without one paste; Shift and right click and the "menu" preference are the browser's
  let nativeMenuOnce = false;
  const onContextMenu = (event: MouseEvent): void => {
    if (disposed || effects.rightClick() !== 'smart' || event.shiftKey) return;
    if (nativeMenuOnce) {
      // the clipboard could not be read last time: let the browser menu through once, so a person is never locked out
      nativeMenuOnce = false;
      return;
    }
    const selected = terminal.hasSelection();
    // nothing to paste with: the page may not read the clipboard, so the browser menu (it has Paste) is the honest answer
    if (!selected && !effects.clipboardReadable()) return;
    event.preventDefault();
    event.stopPropagation();
    if (selected) {
      const text = terminal.getSelection();
      void effects.copy(text).then((copied) => {
        if (copied && !disposed && terminal.getSelection() === text) terminal.clearSelection();
      });
      return;
    }
    void effects.readClipboard().then((text) => {
      if (disposed) return;
      if (text === null) {
        nativeMenuOnce = true;
        effects.announcePasteBlocked();
        return;
      }
      if (text !== '') terminal.paste(text);
    });
  };
  // the capture phase, so that it runs before xterm's own listener, which would move its text area under the pointer
  host.addEventListener('contextmenu', onContextMenu, true);
  cleanups.push(() => {
    host.removeEventListener('contextmenu', onContextMenu, true);
  });

  // copy on select: xterm finishes its own mouse up first, then the selection (kept as it is) goes to the clipboard once per gesture
  let selectionChanged = false;
  let copyTimer: Timer | null = null;
  const onMouseUp = (): void => {
    const changed = selectionChanged;
    selectionChanged = false;
    if (!changed || !effects.copyOnSelect()) return;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyTimer = null;
      if (disposed || !terminal.hasSelection()) return;
      void effects.copy(terminal.getSelection(), { announce: false });
    }, 0);
  };
  document.addEventListener('mouseup', onMouseUp);
  cleanups.push(() => {
    document.removeEventListener('mouseup', onMouseUp);
    if (copyTimer !== null) clearTimeout(copyTimer);
  });

  const subscriptions: Disposable[] = [
    terminal.onSelectionChange(() => {
      selectionChanged = true;
    }),
    terminal.onData((data) => {
      // the process sees our size before the first key we type after another window took it
      if (sizeOwner !== 'self') takeSize();
      if (socket.sendInput(data)) return;
      const status = socket.snapshot().status;
      // not open for an outage's sake (ended, locked and stopped are not "paused")
      if (status === 'connecting' || status === 'backoff') ui.setTypingPaused(true);
    }),
    terminal.onBinary((data) => {
      // one character per byte (xterm's legacy mouse reports), not UTF-8
      socket.sendBinary(Uint8Array.from(data, (char) => char.charCodeAt(0)));
    }),
    terminal.onResize((size) => {
      ui.setSize(size);
      if (!applyingRemoteSize) sendSize(size);
    }),
    terminal.onScroll(() => {
      const { viewportY, baseY } = terminal.buffer.active;
      ui.setScrolledUp(viewportY < baseY);
    }),
  ];
  cleanups.push(() => {
    for (const subscription of subscriptions) subscription.dispose();
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    cleanups.push(() => {
      observer.disconnect();
    });
  }

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') fitNow();
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => {
    document.removeEventListener('visibilitychange', onVisibility);
  });

  // the window gets the focus back only when the terminal had it when the window lost it (not unconditionally: that would take the
  // focus from a screen reader user who moved on)
  const onWindowBlur = (): void => {
    hadFocusAtBlur = host.contains(document.activeElement);
  };
  const onWindowFocus = (): void => {
    if (!hadFocusAtBlur) return;
    hadFocusAtBlur = false;
    terminal.focus();
  };
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);
  cleanups.push(() => {
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('focus', onWindowFocus);
  });

  if (effects.gone()) {
    // the session list already says it is gone: show what there is, connect to nothing
    reportEnded({ exitCode: null, killed: false });
  } else {
    socket.start();
    ui.setStatus({ kind: 'connecting' });
  }

  return {
    terminal,
    redraw() {
      if (disposed) return;
      const { cols, rows } = terminal;
      const smaller = clampTerminalSize(cols, rows - 1);
      const full = clampTerminalSize(cols, rows);
      if (!socket.sendResize(smaller.cols, smaller.rows)) return;
      noteOwnSize(smaller);
      if (redrawTimer !== null) clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => {
        redrawTimer = null;
        if (!disposed && socket.sendResize(full.cols, full.rows)) noteOwnSize(full);
      }, REDRAW_GAP_MS);
    },
    takeSize,
    retryNow() {
      socket.retryNow();
    },
    endGone,
    applyOptions(options) {
      const live = terminal.options;
      live.theme = options.theme;
      live.fontSize = options.fontSize;
      live.screenReaderMode = options.screenReaderMode;
      live.cursorBlink = options.cursorBlink;
      live.cursorStyle = options.cursorStyle;
      // another cell size means another number of columns and rows
      if (options.fontSize !== appliedFontSize) {
        appliedFontSize = options.fontSize;
        scheduleFit();
      }
    },
    applyInputLabel(label) {
      terminal.textarea?.setAttribute('aria-label', label);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      socket.stop();
      if (fitTimer !== null) clearTimeout(fitTimer);
      if (redrawTimer !== null) clearTimeout(redrawTimer);
      for (const cleanup of cleanups.reverse()) cleanup();
      instance.dispose();
    },
  };
}

// ---- the hook --------------------------------------------------------------------------------------------------------------

/** The newest value, readable from callbacks that outlive a render without making an effect restart. */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

interface Latest {
  onEnded: (outcome: EndedOutcome) => void;
  focusOnLive: boolean;
  gone: boolean;
  windowsHost: boolean | undefined;
  theme: TerminalTheme;
  fontSize: number;
  screenReader: boolean;
  cursor: TerminalOptions['cursorStyle'];
  renderer: 'auto' | 'dom';
  rightClick: 'smart' | 'menu';
  copyOnSelect: boolean;
  reducedMotion: boolean;
  t: TFunction;
  announce: Announce;
}

/** The options of a new terminal: the page as it is now (font family, line height) with the theme and size of this render. */
function creationOptions(latest: Latest): TerminalOptions {
  return terminalOptionsFor({
    base: { ...readTerminalOptions(), theme: latest.theme, fontSize: latest.fontSize },
    prefs: { terminalScreenReader: latest.screenReader, terminalCursor: latest.cursor },
    reducedMotion: latest.reducedMotion,
    windowsHost: latest.windowsHost,
  });
}

/** The options a live terminal takes; the family and line height are fixed at creation, so the page's CSS is not read again. */
function liveOptions(latest: Latest): TerminalOptions {
  return terminalOptionsFor({
    base: {
      theme: latest.theme,
      fontFamily: TERMINAL_FONT.family,
      fontSize: latest.fontSize,
      lineHeight: TERMINAL_FONT.lineHeight,
    },
    prefs: { terminalScreenReader: latest.screenReader, terminalCursor: latest.cursor },
    reducedMotion: latest.reducedMotion,
    windowsHost: latest.windowsHost,
  });
}

const LOADING: TerminalViewStatus = { kind: 'loading-engine' };

export function useTerminalConnection(o: UseTerminalConnectionOptions): TerminalConnection {
  const { name } = o;
  const iid = useIid();
  const queryClient = useQueryClient();
  const seams = useTerminalSeams();
  const t = useT();
  const announce = useAnnounce();
  const { prefs } = usePrefs();
  const theme = useTerminalTheme();
  const narrow = useMediaQuery(MQ_TERMINAL_NARROW);
  const reducedMotion = useMediaQuery(MQ_REDUCED_MOTION);
  const screenReader = prefs.terminalScreenReader ?? false;
  const cursor = prefs.terminalCursor ?? 'block';
  const renderer = prefs.terminalRenderer ?? 'auto';
  const rightClick = prefs.terminalRightClick ?? 'smart';
  const copyOnSelect = prefs.terminalCopyOnSelect ?? false;
  const fontSize = narrow ? TERMINAL_FONT.sizeNarrow : TERMINAL_FONT.size;

  const [host, setHost] = useState<HTMLElement | null>(null);
  const [engineAttempt, setEngineAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalViewStatus>(LOADING);
  const [size, setSize] = useState<TerminalSize | null>(null);
  const [sizeOwner, setSizeOwner] = useState<SizeOwner>('self');
  const [scrolledUp, setScrolledUp] = useState(false);
  const [typingPaused, setTypingPaused] = useState(false);
  const sessionRef = useRef<Session | null>(null);

  // declared before the effects that read it: it is updated first in every commit
  const latest = useLatest<Latest>({
    onEnded: o.onEnded,
    focusOnLive: o.focusOnLive,
    gone: o.gone,
    windowsHost: o.windowsHost,
    theme,
    fontSize,
    screenReader,
    cursor,
    renderer,
    rightClick,
    copyOnSelect,
    reducedMotion,
    t,
    announce,
  });

  useEffect(() => {
    if (host === null) return undefined;
    let cancelled = false;
    let session: Session | null = null;

    const effects: SessionEffects = {
      onEnded: (outcome) => {
        latest.current.onEnded(outcome);
      },
      focusOnLive: () => latest.current.focusOnLive,
      gone: () => latest.current.gone,
      inputLabel: () => latest.current.t('terminal.input'),
      copy: async (text, copyOptions) => {
        const copied = await copyText(text);
        // a silent copy (copy on select) says nothing when it worked, and still says so when it did not
        if (copied && copyOptions?.announce === false) return true;
        const { t: translate, announce: say } = latest.current;
        say(translate(copied ? 'common.copied' : 'common.copyFailed'), { force: true });
        return copied;
      },
      clipboardReadable: () => {
        // `document.permissionsPolicy` (older: `featurePolicy`) is Chrome's view of the Permissions-Policy header; not in the DOM typings
        const policy: unknown = Reflect.get(document, 'permissionsPolicy') ?? Reflect.get(document, 'featurePolicy');
        if (typeof policy !== 'object' || policy === null) return true;
        const allows: unknown = Reflect.get(policy, 'allowsFeature');
        if (typeof allows !== 'function') return true;
        try {
          return Reflect.apply(allows, policy, ['clipboard-read']) !== false;
        } catch {
          return true;
        }
      },
      readClipboard: async () => {
        try {
          const text = await navigator.clipboard.readText();
          return text;
        } catch {
          // no clipboard API, an insecure page or a refused permission
          return null;
        }
      },
      announcePasteBlocked: () => {
        const { t: translate, announce: say } = latest.current;
        say(translate('terminal.clipboard.pasteBlocked'), { force: true });
      },
      rightClick: () => latest.current.rightClick,
      copyOnSelect: () => latest.current.copyOnSelect,
      // a lost connection cannot say why: the session list can (design 04 8.2)
      outage: () => {
        void queryClient.invalidateQueries({ queryKey: qk.terminalState(iid) });
      },
      locked: () => {
        markLocked(queryClient, iid);
      },
      release: () => {
        focusOutsideTerminal();
      },
    };

    async function start(): Promise<void> {
      let engine: TerminalEngine;
      try {
        engine = await seams.loadEngine({ gpu: latest.current.renderer !== 'dom' });
      } catch {
        if (!cancelled) setStatus({ kind: 'engine-failed' });
        return;
      }
      if (cancelled || host === null) return;
      let instance: TerminalInstance | null = null;
      try {
        instance = engine.create(creationOptions(latest.current));
        session = openSession({
          host,
          name,
          instance,
          createSocket: seams.createSocket,
          ui: { setStatus, setSize, setSizeOwner, setScrolledUp, setTypingPaused },
          effects,
        });
      } catch {
        instance?.dispose();
        setStatus({ kind: 'engine-failed' });
        return;
      }
      sessionRef.current = session;
    }
    void start();

    return () => {
      cancelled = true;
      sessionRef.current = null;
      session?.dispose();
      // the next session (another name, a retry, StrictMode's second mount) starts from nothing, not from the last one's story
      setStatus(LOADING);
      setSize(null);
      setSizeOwner('self');
      setScrolledUp(false);
      setTypingPaused(false);
    };
  }, [host, name, iid, engineAttempt, seams, queryClient, latest]);

  // the session list says the session is gone
  const { gone } = o;
  useEffect(() => {
    if (gone) sessionRef.current?.endGone();
  }, [gone]);

  // the page changed the theme, the size class, the screen reader preference, the cursor or the motion preference
  useEffect(() => {
    sessionRef.current?.applyOptions(liveOptions(latest.current));
  }, [theme, fontSize, screenReader, cursor, reducedMotion, latest]);

  // the language changed
  const inputLabel = t('terminal.input');
  useEffect(() => {
    sessionRef.current?.applyInputLabel(inputLabel);
  }, [inputLabel]);

  const hostRef = useCallback((element: HTMLElement | null) => {
    setHost(element);
  }, []);

  const handle = useMemo<TerminalHandle>(
    () => ({
      focus: () => {
        sessionRef.current?.terminal.focus();
      },
      blur: () => {
        sessionRef.current?.terminal.blur();
      },
      redraw: () => {
        sessionRef.current?.redraw();
      },
      takeSize: () => {
        sessionRef.current?.takeSize();
      },
      scrollToLatest: () => {
        sessionRef.current?.terminal.scrollToBottom();
      },
    }),
    [],
  );

  const statusKind = status.kind;
  const retryNow = useCallback(() => {
    if (statusKind === 'engine-failed') setEngineAttempt((attempt) => attempt + 1);
    else sessionRef.current?.retryNow();
  }, [statusKind]);

  return { hostRef, status, size, sizeOwner, scrolledUp, typingPaused, handle, retryNow };
}
