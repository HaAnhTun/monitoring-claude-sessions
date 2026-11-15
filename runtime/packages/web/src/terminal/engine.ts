// The part of xterm.js the app uses, as plain types (design 04 section 7.2, ADR 0097). `xterm-loader.ts` adapts the real classes to
// `TerminalEngine`; the connection hook and the view are written against these types and a fake engine in tests, so they never
// import `@xterm/*` (an eslint rule keeps the three packages out of every other file, and so out of the first chunk).
// Types only: no value, no import of a package.
//
// Created with the loader (CAW-40) because the loader returns it; the terminal view package (CAW-42) owns it from there.
import type { TerminalTheme } from '../lib/term-theme.ts';

/** What `dispose()` hands back: a listener or an addon that can be removed. */
export interface Disposable {
  dispose(): void;
}

/** The options the app gives a terminal, whole at creation and in part afterwards (`terminal.options.theme = ...`). */
export interface TerminalOptions {
  fontSize: number;
  fontFamily: string;
  /** Unitless multiple of the font size; above 1 so that the stacked marks of Vietnamese letters do not clip at the row boundary. */
  lineHeight: number;
  scrollback: number;
  cursorBlink: boolean;
  theme: TerminalTheme;
  screenReaderMode: boolean;
  /** 1 turns the minimum contrast off (the decision of ADR 0097); a higher value makes the renderer adjust each cell's colour. */
  minimumContrastRatio: number;
  /** Set when the process runs under ConPTY, so that xterm reflows its lines like the Windows console does. */
  windowsPty?: { backend: 'conpty'; buildNumber?: number };
}

/**
 * The options that can change while a terminal lives, read and written as `terminal.options.theme = ...` (the rest are fixed at
 * creation). Every key is optional and a theme may be partial: this is the shape xterm's own options object has, so the real object is
 * handed out as it is and a write reaches the terminal.
 */
export interface LiveTerminalOptions {
  theme?: Partial<TerminalTheme>;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  scrollback?: number;
  cursorBlink?: boolean;
  screenReaderMode?: boolean;
  minimumContrastRatio?: number;
}

/** The terminal widget (a subset of xterm's `Terminal`). */
export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  /** Xterm's own text area, the focus target; it exists after `open`. */
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly buffer: { readonly active: { readonly viewportY: number; readonly baseY: number } };
  options: LiveTerminalOptions;
  open(host: HTMLElement): void;
  write(data: Uint8Array | string, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  scrollToBottom(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable;
  onScroll(listener: () => void): Disposable;
  /** The handler returns true to let xterm handle the event and false to take it (see `decideKey`). */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

/** The fit addon: the size the host would hold, and resizing the terminal to it. */
export interface FitLike {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

/** One terminal with its fit helper; `dispose` removes the terminal, its addons and its listeners. */
export interface TerminalInstance {
  terminal: TerminalLike;
  fit: FitLike;
  dispose(): void;
}

/** What `loadEngine` resolves to: a factory, so the view creates one terminal per open session. */
export interface TerminalEngine {
  create(options: TerminalOptions): TerminalInstance;
}
