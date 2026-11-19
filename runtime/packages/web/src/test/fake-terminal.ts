// Test doubles for the terminal view (design 04 12.2, D20). happy-dom cannot run xterm, so the view and its hook are written against
// the engine seam of `terminal/engine.ts` and the tests give them these:
// - `FakeTerminal` records what the view does to a terminal (`writes`, `resets`, `resizes`, `focusCount`, `options`, `pastes`) and is
//   driven with `emitData`, `emitBinary`, `setSelection`, `scrollTo` and `pressKey`. `pressKey` runs the custom key handler the view
//   attached and, when the handler lets the event through, does what xterm would for the keys the tests use (Ctrl+C sends 0x03, Tab
//   sends a tab), so "Ctrl+C without a selection reaches the socket" (TC-UI-07) is testable.
// - `fakeEngine()` is a `TerminalEngine` of those terminals with a fit helper that proposes a size the test sets.
// - `fakeSeams()` is a whole `TerminalSeams`: that engine, the REAL socket client over `FakeWebSocket`, and an events client that
//   is never opened. It also holds the engine back or fails it on demand.
// - `handshake()` plays the server side of a connection (ready, replay, live); `giveHostSize` and `stubResizeObserver` give a host
//   the box that happy-dom cannot lay out.
// Not part of the app bundle; only tests import it.
import { vi } from 'vitest';

import type {
  Disposable,
  EngineLoadOptions,
  FitLike,
  LiveTerminalOptions,
  RendererKind,
  RendererLike,
  TerminalEngine,
  TerminalInstance,
  TerminalLike,
  TerminalOptions,
} from '../terminal/engine.ts';
import type { EventsClient } from '../terminal/events-client.ts';
import type { TerminalSeams } from '../terminal/seams.ts';
import { createTerminalSocket } from '../terminal/ws-client.ts';
import { createFakeWebSockets, type FakeWebSocket, type FakeWebSockets } from './fake-websocket.ts';

export interface Size {
  cols: number;
  rows: number;
}

/** A tiny listener list with the `Disposable` shape of xterm's events. */
class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

const decoder = new TextDecoder();

export class FakeTerminal implements TerminalLike {
  cols = 80;
  rows = 24;
  textarea: HTMLTextAreaElement | undefined = undefined;
  readonly buffer = { active: { viewportY: 0, baseY: 0 } };
  /** What the terminal was created with. */
  readonly created: TerminalOptions;
  /** Read and written like xterm's own options object: `terminal.options.theme = ...`. */
  options: LiveTerminalOptions;
  host: HTMLElement | null = null;
  /** Everything written, in order, since the terminal was created (a reset does not clear it). */
  readonly writes: (string | Uint8Array)[] = [];
  resets = 0;
  /** Every `resize` call, in order. */
  readonly resizes: Size[] = [];
  focusCount = 0;
  blurCount = 0;
  scrollToBottomCount = 0;
  disposed = false;
  /** What a paste put into the terminal, as xterm's own paste path would (`paste()`). */
  readonly pastes: string[] = [];
  /** Keyboard events the custom handler took (it returned false), in order. */
  readonly takenKeys: KeyboardEvent[] = [];
  private selection = '';
  private screenText = '';
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  private readonly data = new Emitter<string>();
  private readonly binary = new Emitter<string>();
  private readonly resize_ = new Emitter<Size>();
  private readonly scroll = new Emitter<void>();
  private readonly selectionChange = new Emitter<void>();

  constructor(options: TerminalOptions) {
    this.created = options;
    this.options = { ...options };
  }

  /** The text on the screen as the process wrote it since the last reset: no cursor movement, just the characters. */
  get screen(): string {
    return this.screenText;
  }

  get listenerCount(): number {
    return this.data.size + this.binary.size + this.resize_.size + this.scroll.size + this.selectionChange.size;
  }

  open(host: HTMLElement): void {
    this.host = host;
    const wrapper = host.ownerDocument.createElement('div');
    wrapper.className = 'xterm';
    const area = host.ownerDocument.createElement('textarea');
    area.className = 'xterm-helper-textarea';
    wrapper.append(area);
    host.append(wrapper);
    this.textarea = area;
  }

  write(data: Uint8Array | string, callback?: () => void): void {
    this.writes.push(data);
    this.screenText += typeof data === 'string' ? data : decoder.decode(data);
    callback?.();
  }

  reset(): void {
    this.resets += 1;
    this.screenText = '';
    this.selection = '';
  }

  /** As xterm: a change of size fires `onResize`, the same size does not. */
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.resize_.emit({ cols, rows });
  }

  focus(): void {
    this.focusCount += 1;
    this.textarea?.focus();
  }

  blur(): void {
    this.blurCount += 1;
    this.textarea?.blur();
  }

  dispose(): void {
    this.disposed = true;
    this.data.clear();
    this.binary.clear();
    this.resize_.clear();
    this.scroll.clear();
    this.selectionChange.clear();
    this.keyHandler = null;
    this.host?.querySelector('.xterm')?.remove();
  }

  scrollToBottom(): void {
    this.scrollToBottomCount += 1;
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.scroll.emit();
  }

  hasSelection(): boolean {
    return this.selection !== '';
  }

  getSelection(): string {
    return this.selection;
  }

  clearSelection(): void {
    const had = this.selection !== '';
    this.selection = '';
    if (had) this.selectionChange.emit();
  }

  onData(listener: (data: string) => void): Disposable {
    return this.data.on(listener);
  }

  onBinary(listener: (data: string) => void): Disposable {
    return this.binary.on(listener);
  }

  onResize(listener: (size: Size) => void): Disposable {
    return this.resize_.on(listener);
  }

  onScroll(listener: () => void): Disposable {
    return this.scroll.on(listener);
  }

  onSelectionChange(listener: () => void): Disposable {
    return this.selectionChange.on(listener);
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  // ---- what a test does to the terminal ------------------------------------------------------------------------------------

  /** The person typed (or xterm encoded a key): `onData` listeners get the text. */
  emitData(text: string): void {
    this.data.emit(text);
  }

  /** xterm's binary channel (legacy mouse reports): one character per byte. */
  emitBinary(text: string): void {
    this.binary.emit(text);
  }

  /** The selection changed, as a drag or a double click does: `onSelectionChange` listeners are told. */
  setSelection(text: string): void {
    this.selection = text;
    this.selectionChange.emit();
  }

  /** The viewport moved: `viewportY` below `baseY` means scrolled up into the history. */
  scrollTo(viewportY: number, baseY: number): void {
    this.buffer.active.viewportY = viewportY;
    this.buffer.active.baseY = baseY;
    this.scroll.emit();
  }

  /** A paste into xterm's text area: xterm sends the text through `onData` (bracketed when the program asked for it). */
  paste(text: string): void {
    this.pastes.push(text);
    this.data.emit(text);
  }

  /**
   * A key down on the terminal. The custom key handler decides first; when it returns false the event was taken (and is in
   * `takenKeys`). When it returns true xterm encodes the key: Ctrl+C sends 0x03, Tab a tab, Enter a carriage return and a single
   * printable character itself. Returns what the handler returned.
   */
  pressKey(init: KeyboardEventInit & { key: string }): boolean {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    const passed = this.keyHandler === null ? true : this.keyHandler(event);
    if (!passed) {
      this.takenKeys.push(event);
      return false;
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c') this.data.emit('\x03');
    else if (event.key === 'Tab') this.data.emit(event.shiftKey ? '\x1b[Z' : '\t');
    else if (event.key === 'Enter') this.data.emit('\r');
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) this.data.emit(event.key);
    return true;
  }
}

/** The fit addon: `proposeDimensions` answers the size the test set, `fit` resizes the terminal to it (as the real one does). */
export class FakeFit implements FitLike {
  proposed: Size | undefined;
  fitCalls = 0;
  private readonly terminal: FakeTerminal;

  constructor(terminal: FakeTerminal, proposed: Size | undefined) {
    this.terminal = terminal;
    this.proposed = proposed;
  }

  fit(): void {
    this.fitCalls += 1;
    if (this.proposed !== undefined) this.terminal.resize(this.proposed.cols, this.proposed.rows);
  }

  proposeDimensions(): Size | undefined {
    return this.proposed;
  }
}

/**
 * The GPU renderer of a fake terminal. `attach` answers what the engine was told to answer (`FakeEngine.rendererKind`), and
 * `fireFallback` plays the loss of the GPU context for good.
 */
export class FakeRenderer implements RendererLike {
  attachCalls = 0;
  /** What the hook had done to the terminal when `attach` ran: the host was opened already. */
  openedAtAttach: boolean[] = [];
  /** The next `attach` throws this (the real one never does; the hook must still survive it). */
  failNextAttach: Error | null = null;
  private current: RendererKind = 'dom';
  private readonly fallback = new Emitter<void>();
  private readonly terminal: FakeTerminal;
  private readonly willBe: RendererKind;

  constructor(terminal: FakeTerminal, willBe: RendererKind) {
    this.terminal = terminal;
    this.willBe = willBe;
  }

  attach(): RendererKind {
    this.attachCalls += 1;
    this.openedAtAttach.push(this.terminal.host !== null);
    if (this.failNextAttach !== null) {
      const error = this.failNextAttach;
      this.failNextAttach = null;
      throw error;
    }
    this.current = this.willBe;
    return this.current;
  }

  kind(): RendererKind {
    return this.current;
  }

  onFallback(listener: () => void): Disposable {
    return this.fallback.on(listener);
  }

  /** The GPU context is lost for good: the terminal is on the DOM renderer again and the listeners are told. */
  fireFallback(): void {
    this.current = 'dom';
    this.fallback.emit();
  }
}

export interface FakeInstance extends TerminalInstance {
  terminal: FakeTerminal;
  fit: FakeFit;
  renderer: FakeRenderer;
  options: TerminalOptions;
  disposed: boolean;
}

export interface FakeEngine extends TerminalEngine {
  readonly instances: FakeInstance[];
  /** The most recently created terminal with its fit helper; throws before the first one (a test bug). */
  last(): FakeInstance;
  /** What every fit proposes (also for terminals created later). `undefined`: the host has no room. */
  fitSize: Size | undefined;
  /** The next `create` throws this. */
  failNextCreate: Error | null;
  /** What `renderer.attach()` of the terminals created from now on answers. */
  rendererKind: RendererKind;
  /** The `attach` of the next terminal created throws this (the real one never does). */
  failNextAttach: Error | null;
}

export function fakeEngine(initialFit: Size | undefined = { cols: 100, rows: 30 }): FakeEngine {
  const instances: FakeInstance[] = [];
  const engine: FakeEngine = {
    instances,
    fitSize: initialFit,
    failNextCreate: null,
    rendererKind: 'webgl',
    failNextAttach: null,
    last() {
      const found = instances.at(-1);
      if (found === undefined) throw new Error('no terminal was created yet');
      return found;
    },
    create(options) {
      if (engine.failNextCreate !== null) {
        const error = engine.failNextCreate;
        engine.failNextCreate = null;
        throw error;
      }
      const terminal = new FakeTerminal(options);
      const fit = new FakeFit(terminal, engine.fitSize);
      const renderer = new FakeRenderer(terminal, engine.rendererKind);
      renderer.failNextAttach = engine.failNextAttach;
      engine.failNextAttach = null;
      const instance: FakeInstance = {
        terminal,
        fit,
        renderer,
        options,
        disposed: false,
        dispose: () => {
          instance.disposed = true;
          terminal.dispose();
        },
      };
      instances.push(instance);
      return instance;
    },
  };
  return engine;
}

export interface FakeTerminalSeams {
  seams: TerminalSeams;
  engine: FakeEngine;
  sockets: FakeWebSockets;
  /** How many times the view asked for the engine. */
  loadCount: () => number;
  /** The options of every `loadEngine` call, in order (`gpu` follows the renderer preference). */
  loadOptions: EngineLoadOptions[];
  /** The next `loadEngine` rejects with this error. */
  failNextLoad(error?: Error): void;
  /** The next `loadEngine` stays pending until the returned function is called. */
  holdNextLoad(): () => void;
}

/** A whole `TerminalSeams`: the fake engine, the real socket client over `FakeWebSocket`, an events client that is never started. */
export function fakeSeams(engine: FakeEngine = fakeEngine()): FakeTerminalSeams {
  const sockets = createFakeWebSockets();
  let loads = 0;
  const loadOptions: EngineLoadOptions[] = [];
  let failure: Error | null = null;
  let hold: Promise<void> | null = null;
  const seams: TerminalSeams = {
    async loadEngine(options) {
      loads += 1;
      loadOptions.push(options);
      if (hold !== null) await hold;
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
      return engine;
    },
    // the socket client is the real one: its timers, visibility and network target are the page's (visibility handling is off)
    createSocket: (options) =>
      createTerminalSocket({ ...options, factory: sockets.factory, visibility: null, windowTarget: null }),
    createEventsClient: (): EventsClient => {
      throw new Error('the terminal view does not open the events stream');
    },
  };
  return {
    seams,
    engine,
    sockets,
    loadCount: () => loads,
    loadOptions,
    failNextLoad(error = new Error('chunk failed to load')) {
      failure = error;
    },
    holdNextLoad() {
      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
  };
}

export interface HandshakeOptions extends Partial<Size> {
  /** Bytes of the replay, one binary frame each, between `ready` and `live`. */
  replay?: readonly (string | Uint8Array)[];
  viewers?: number;
  /** Stop after `ready` and the replay: the `live` frame is sent by the test. */
  skipLive?: boolean;
}

const encoder = new TextEncoder();

/** The server side of one connection: the handshake, `ready` with the size of the process, the replay, then `live`. */
export function handshake(socket: FakeWebSocket, options: HandshakeOptions = {}): void {
  const replay = options.replay ?? [];
  const replayBytes = replay.reduce<number>(
    (sum, chunk) => sum + (typeof chunk === 'string' ? encoder.encode(chunk).length : chunk.length),
    0,
  );
  socket.open();
  socket.message({
    type: 'ready',
    v: 1,
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    replayBytes,
    viewers: options.viewers ?? 1,
  });
  for (const chunk of replay) socket.message(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  if (options.skipLive !== true) socket.message({ type: 'live' });
}

/** happy-dom has no layout: gives an element the box a browser would have measured. */
export function giveHostSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height });
}

export interface ResizeObserverStub {
  /** Every observer that was created and not disconnected. */
  readonly active: () => number;
  /** The observed element changed size. */
  trigger(): void;
}

/** Replaces the global `ResizeObserver` for the current test (Vitest restores it: `unstubGlobals`). */
export function stubResizeObserver(): ResizeObserverStub {
  const observers = new Set<{ callback: () => void }>();
  class FakeResizeObserver {
    private readonly entry: { callback: () => void };
    constructor(callback: () => void) {
      this.entry = { callback };
      observers.add(this.entry);
    }
    observe(): void {
      // the stub reports to every observer on `trigger`
    }
    unobserve(): void {
      // not used by the view
    }
    disconnect(): void {
      observers.delete(this.entry);
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return {
    active: () => observers.size,
    trigger() {
      for (const observer of [...observers]) observer.callback();
    },
  };
}

/** Makes `document.visibilityState` say `hidden` or `visible` and fires `visibilitychange`. */
export function setDocumentVisibility(state: 'hidden' | 'visible'): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}
