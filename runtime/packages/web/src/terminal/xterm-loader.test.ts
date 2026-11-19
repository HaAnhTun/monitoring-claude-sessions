import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalOptions } from './engine.ts';
import {
  createEngine,
  createGpuSlots,
  type GpuSlots,
  installCspShims,
  loadXtermEngine,
  MAX_GPU_TERMINALS,
  openExternalLink,
  type OpenWindow,
  webgl2Available,
  type XtermImporters,
  type XtermModules,
} from './xterm-loader.ts';

// ADR 0097. The loader is the one file that imports xterm.js. Here: the link rule, the wiring of the engine over fake classes
// (so the adapter is checked call by call), the shims it installs, and one load of the REAL packages to prove the lazy imports
// resolve and the real classes fit the adapter. What xterm draws, and what the CSP does with it, is proven in a real browser
// (the spike of the ADR; the Playwright specs of the terminal page).

/** A property by name, without taking a method off its object. */
function read(target: object, key: string): unknown {
  return Reflect.get(target, key);
}

/** The nonce of an element, or an empty text when the DOM implementation has none (happy-dom has no `nonce` accessor). */
function nonceOf(element: Element): string {
  const value = read(element, 'nonce');
  return typeof value === 'string' ? value : '';
}

/** An address built from its parts, so that no literal of this file is a script URL. */
function address(scheme: string, rest: string): string {
  return `${scheme}:${rest}`;
}

describe('openExternalLink', () => {
  const open = (): { fn: OpenWindow; calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      fn: (...args) => {
        calls.push(args);
        return null;
      },
    };
  };

  it.each([
    ['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['http://127.0.0.1:18765/login', 'http://127.0.0.1:18765/login'],
    ['HTTPS://EXAMPLE.com/Path', 'https://example.com/Path'],
    ['https://example.com', 'https://example.com/'],
  ])('opens %s in a new tab without an opener', (uri, href) => {
    const { fn, calls } = open();
    expect(openExternalLink(uri, fn)).toBe(true);
    expect(calls).toEqual([[href, '_blank', 'noopener,noreferrer']]);
  });

  it.each([
    address('javascript', 'alert(1)'),
    address('JavaScript', 'alert(1)'),
    address('data', 'text/html,<script>alert(1)</script>'),
    address('file', '///etc/hosts'),
    'blob:https://example.com/0000',
    'ftp://example.com/x',
    'mailto:someone@example.invalid',
    address('vbscript', 'msgbox(1)'),
    'ws://example.com/socket',
    'about:blank',
  ])('refuses %s', (uri) => {
    const { fn, calls } = open();
    expect(openExternalLink(uri, fn)).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each(['', 'example.com/page', '//example.com/page', '/relative', 'not a url', 'https://'])(
    'refuses text that is not an address: %j',
    (uri) => {
      const { fn, calls } = open();
      expect(openExternalLink(uri, fn)).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it('uses window.open by default', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openExternalLink('https://example.com/x')).toBe(true);
    expect(spy).toHaveBeenCalledExactlyOnceWith('https://example.com/x', '_blank', 'noopener,noreferrer');
  });
});

const OPTIONS: TerminalOptions = {
  fontSize: 13,
  fontFamily: 'monospace',
  lineHeight: 1.2,
  scrollback: 20000,
  cursorBlink: false,
  cursorStyle: 'block',
  wordSeparator: ' ()[]{}',
  theme: {
    background: '#141414',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#141414',
    selectionBackground: '#3a4a5e',
    black: '#2a2a2a',
    red: '#e06c75',
    green: '#6cc785',
    yellow: '#e2c070',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#56b6c2',
    white: '#d4d4d4',
    brightBlack: '#8c8c8c',
    brightRed: '#ef8a92',
    brightGreen: '#86d99b',
    brightYellow: '#f0d38a',
    brightBlue: '#9bb9fa',
    brightMagenta: '#cdb4fb',
    brightCyan: '#7ccbd6',
    brightWhite: '#f0f0f0',
    scrollbarSliderBackground: '#2c2c2c',
    scrollbarSliderHoverBackground: '#444444',
    scrollbarSliderActiveBackground: '#888888',
  },
  screenReaderMode: false,
  minimumContrastRatio: 1,
  windowsPty: { backend: 'conpty' },
};

/** What a fake addon does when the terminal activates or builds it. */
interface AddonBehavior {
  /** `activate` of the addon throws (a blocklisted GPU, an old xterm). */
  throwOnActivate: boolean;
  /** The constructor throws. */
  throwOnConstruct: boolean;
}

class FakeUnicodeAddon {
  static behavior: AddonBehavior = { throwOnActivate: false, throwOnConstruct: false };
  static instances: FakeUnicodeAddon[] = [];
  constructor() {
    if (FakeUnicodeAddon.behavior.throwOnConstruct) throw new Error('unicode addon failed to build');
    FakeUnicodeAddon.instances.push(this);
  }
  activate(terminal: FakeTerminal): void {
    if (FakeUnicodeAddon.behavior.throwOnActivate) throw new Error('unicode addon failed to activate');
    terminal.unicodeVersions.push('11');
  }
}

class FakeWebglAddon {
  static behavior: AddonBehavior = { throwOnActivate: false, throwOnConstruct: false };
  static instances: FakeWebglAddon[] = [];
  disposed = 0;
  private lossListener: (() => void) | undefined;
  constructor() {
    if (FakeWebglAddon.behavior.throwOnConstruct) throw new Error('webgl addon failed to build');
    FakeWebglAddon.instances.push(this);
  }
  activate(): void {
    if (FakeWebglAddon.behavior.throwOnActivate) throw new Error('webgl addon failed to activate');
  }
  onContextLoss(listener: () => void): { dispose(): void } {
    this.lossListener = listener;
    return {
      dispose: () => {
        this.lossListener = undefined;
      },
    };
  }
  dispose(): void {
    this.disposed += 1;
  }
  /** The browser did not restore the context: xterm's addon fires this about three seconds after `webglcontextlost`. */
  loseContext(): void {
    this.lossListener?.();
  }
}

function resetAddonFakes(): void {
  FakeUnicodeAddon.behavior = { throwOnActivate: false, throwOnConstruct: false };
  FakeUnicodeAddon.instances = [];
  FakeWebglAddon.behavior = { throwOnActivate: false, throwOnConstruct: false };
  FakeWebglAddon.instances = [];
}

/** The two optional addons as fake classes, for `createEngine`. */
function withAddons(modules: XtermModules, which: { unicode?: boolean; webgl?: boolean } = {}): XtermModules {
  return {
    ...modules,
    ...(which.unicode === false
      ? {}
      : { Unicode11Addon: FakeUnicodeAddon as unknown as XtermModules['Unicode11Addon'] }),
    ...(which.webgl === false ? {} : { WebglAddon: FakeWebglAddon as unknown as XtermModules['WebglAddon'] }),
  };
}

/** Fake xterm classes that record what the engine does to them. */
function fakeModules(): {
  modules: XtermModules;
  terminals: FakeTerminal[];
  fits: FakeFit[];
  links: { handler: ((event: MouseEvent, uri: string) => void) | undefined }[];
} {
  const terminals: FakeTerminal[] = [];
  const fits: FakeFit[] = [];
  const links: { handler: ((event: MouseEvent, uri: string) => void) | undefined }[] = [];
  class Terminal extends FakeTerminal {
    constructor(options: Record<string, unknown>) {
      super(options);
      terminals.push(this);
    }
  }
  class FitAddon extends FakeFit {
    constructor() {
      super();
      fits.push(this);
    }
  }
  class WebLinksAddon {
    readonly handler: ((event: MouseEvent, uri: string) => void) | undefined;
    constructor(handler?: (event: MouseEvent, uri: string) => void) {
      this.handler = handler;
      links.push(this);
    }
  }
  return {
    modules: { Terminal, FitAddon, WebLinksAddon } as unknown as XtermModules,
    terminals,
    fits,
    links,
  };
}

class FakeFit {
  calls: string[] = [];
  fit(): void {
    this.calls.push('fit');
  }
  proposeDimensions(): { cols: number; rows: number } | undefined {
    return { cols: 100, rows: 30 };
  }
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  textarea: HTMLTextAreaElement | undefined = undefined;
  buffer = { active: { viewportY: 3, baseY: 9 } };
  options: Record<string, unknown>;
  addons: unknown[] = [];
  calls: [string, ...unknown[]][] = [];
  listeners: Record<string, ((...args: never[]) => void) | undefined> = {};
  disposed = 0;
  selection = '';
  /** What happened in order, by name, for the order of `open` and the addons. */
  log: string[] = [];
  /** The Unicode versions that were registered and the one in force (xterm starts on 6). */
  unicodeVersions: string[] = [];
  unicode = { activeVersion: '6' };
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
  }
  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }): void {
    this.log.push(`loadAddon:${addon.constructor.name}`);
    // as xterm does: the addon is activated inside the call, and a throw reaches the caller
    addon.activate?.(this);
    this.addons.push(addon);
  }
  open(host: HTMLElement): void {
    this.log.push('open');
    this.calls.push(['open', host]);
  }
  paste(data: string): void {
    this.calls.push(['paste', data]);
  }
  write(data: Uint8Array | string, callback?: () => void): void {
    this.calls.push(['write', data, callback]);
  }
  reset(): void {
    this.calls.push(['reset']);
  }
  resize(cols: number, rows: number): void {
    this.calls.push(['resize', cols, rows]);
  }
  focus(): void {
    this.calls.push(['focus']);
  }
  blur(): void {
    this.calls.push(['blur']);
  }
  dispose(): void {
    this.disposed += 1;
  }
  scrollToBottom(): void {
    this.calls.push(['scrollToBottom']);
  }
  hasSelection(): boolean {
    return this.selection !== '';
  }
  getSelection(): string {
    return this.selection;
  }
  clearSelection(): void {
    this.selection = '';
  }
  private on(name: string, listener: (...args: never[]) => void): { dispose(): void } {
    this.listeners[name] = listener;
    return {
      dispose: () => {
        this.listeners[name] = undefined;
      },
    };
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    return this.on('data', listener);
  }
  onBinary(listener: (data: string) => void): { dispose(): void } {
    return this.on('binary', listener);
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    return this.on('resize', listener);
  }
  onScroll(listener: (position: number) => void): { dispose(): void } {
    return this.on('scroll', listener);
  }
  onSelectionChange(listener: () => void): { dispose(): void } {
    return this.on('selection', listener);
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.calls.push(['attachCustomKeyEventHandler', handler]);
  }
}

describe('createEngine over fake classes', () => {
  it('builds a terminal with the options, no proposed API and no line feed conversion', () => {
    const { modules, terminals } = fakeModules();
    createEngine(modules).create(OPTIONS);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.options).toEqual({ ...OPTIONS, allowProposedApi: false, convertEol: false });
  });

  it('passes the contrast option on as given (1 turns the minimum off)', () => {
    const { modules, terminals } = fakeModules();
    createEngine(modules).create({ ...OPTIONS, minimumContrastRatio: 1 });
    expect(terminals[0]?.options['minimumContrastRatio']).toBe(1);
  });

  it('loads the fit addon and then the links addon, and no renderer addon', () => {
    const { modules, terminals, fits, links } = fakeModules();
    createEngine(modules).create(OPTIONS);
    expect(terminals[0]?.addons).toHaveLength(2);
    expect(terminals[0]?.addons[0]).toBe(fits[0]);
    expect(links).toHaveLength(1);
  });

  it('builds one terminal per create', () => {
    const { modules, terminals } = fakeModules();
    const engine = createEngine(modules);
    const a = engine.create(OPTIONS);
    const b = engine.create(OPTIONS);
    expect(terminals).toHaveLength(2);
    expect(a.terminal).not.toBe(b.terminal);
  });

  it('opens a clicked link only for http and https', () => {
    const { modules, links } = fakeModules();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    createEngine(modules).create(OPTIONS);
    const handler = links[0]?.handler;
    expect(handler).toBeTypeOf('function');
    handler?.(new MouseEvent('click'), address('javascript', 'alert(1)'));
    handler?.(new MouseEvent('click'), address('file', '///etc/hosts'));
    expect(open).not.toHaveBeenCalled();
    handler?.(new MouseEvent('click'), 'https://example.com/login');
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/login', '_blank', 'noopener,noreferrer');
  });

  it('forwards every call and read to the terminal', () => {
    const { modules, terminals } = fakeModules();
    const { terminal } = createEngine(modules).create(OPTIONS);
    const fake = terminals[0];
    if (fake === undefined) throw new Error('no terminal');
    const host = document.createElement('div');
    const done = vi.fn();
    terminal.open(host);
    terminal.write('text', done);
    terminal.write(new Uint8Array([1, 2]));
    terminal.reset();
    terminal.resize(100, 30);
    terminal.focus();
    terminal.blur();
    terminal.scrollToBottom();
    terminal.paste('pasted text');
    const handler = vi.fn(() => true);
    terminal.attachCustomKeyEventHandler(handler);
    expect(fake.calls).toEqual([
      ['open', host],
      ['write', 'text', done],
      ['write', new Uint8Array([1, 2]), undefined],
      ['reset'],
      ['resize', 100, 30],
      ['focus'],
      ['blur'],
      ['scrollToBottom'],
      ['paste', 'pasted text'],
      ['attachCustomKeyEventHandler', handler],
    ]);

    fake.cols = 120;
    fake.rows = 40;
    expect([terminal.cols, terminal.rows]).toEqual([120, 40]);
    expect(terminal.textarea).toBeUndefined();
    fake.textarea = document.createElement('textarea');
    expect(terminal.textarea).toBe(fake.textarea);
    fake.buffer.active.viewportY = 7;
    expect(terminal.buffer.active.viewportY).toBe(7);
    expect(terminal.buffer.active.baseY).toBe(9);

    expect(terminal.hasSelection()).toBe(false);
    fake.selection = 'picked';
    expect(terminal.hasSelection()).toBe(true);
    expect(terminal.getSelection()).toBe('picked');
    terminal.clearSelection();
    expect(terminal.hasSelection()).toBe(false);
  });

  it('gives the listeners and a disposable for each', () => {
    const { modules, terminals } = fakeModules();
    const { terminal } = createEngine(modules).create(OPTIONS);
    const fake = terminals[0];
    if (fake === undefined) throw new Error('no terminal');
    const onData = vi.fn();
    const onBinary = vi.fn();
    const onResize = vi.fn();
    const onScroll = vi.fn();
    const onSelectionChange = vi.fn();
    const subscriptions = [
      terminal.onData(onData),
      terminal.onBinary(onBinary),
      terminal.onResize(onResize),
      terminal.onScroll(onScroll),
      terminal.onSelectionChange(onSelectionChange),
    ];
    (fake.listeners['data'] as ((data: string) => void) | undefined)?.('typed');
    (fake.listeners['binary'] as ((data: string) => void) | undefined)?.('\u0001');
    (fake.listeners['resize'] as ((size: { cols: number; rows: number }) => void) | undefined)?.({
      cols: 90,
      rows: 20,
    });
    (fake.listeners['scroll'] as ((position: number) => void) | undefined)?.(42);
    (fake.listeners['selection'] as (() => void) | undefined)?.();
    expect(onData).toHaveBeenCalledWith('typed');
    expect(onBinary).toHaveBeenCalledWith('\u0001');
    expect(onResize).toHaveBeenCalledWith({ cols: 90, rows: 20 });
    // the position of the scroll is not passed on: the app reads the buffer
    expect(onScroll).toHaveBeenCalledExactlyOnceWith();
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith();
    for (const subscription of subscriptions) subscription.dispose();
    expect(Object.values(fake.listeners).every((l) => l === undefined)).toBe(true);
  });

  it('writes options through to the terminal, one key or several', () => {
    const { modules, terminals } = fakeModules();
    const { terminal } = createEngine(modules).create(OPTIONS);
    const fake = terminals[0];
    if (fake === undefined) throw new Error('no terminal');
    const theme = { ...OPTIONS.theme, background: '#fcfbf7' };
    terminal.options.theme = theme;
    terminal.options.fontSize = 12;
    expect(fake.options['theme']).toBe(theme);
    expect(fake.options['fontSize']).toBe(12);
    expect(terminal.options.fontSize).toBe(12);
    terminal.options = { scrollback: 5, cursorBlink: true };
    expect(fake.options['scrollback']).toBe(5);
    expect(fake.options['cursorBlink']).toBe(true);
    expect(fake.options['fontSize']).toBe(12);
  });

  it('forwards the fit addon', () => {
    const { modules, fits } = fakeModules();
    const { fit } = createEngine(modules).create(OPTIONS);
    fit.fit();
    expect(fits[0]?.calls).toEqual(['fit']);
    expect(fit.proposeDimensions()).toEqual({ cols: 100, rows: 30 });
  });

  it('disposes the terminal when the instance is disposed', () => {
    const { modules, terminals } = fakeModules();
    const instance = createEngine(modules).create(OPTIONS);
    instance.dispose();
    expect(terminals[0]?.disposed).toBe(1);
  });
});

describe('createEngine: Unicode 11 (CAW-144, ADR 0135)', () => {
  afterEach(resetAddonFakes);

  it('loads the addon after fit and links, turns proposed API on and activates version 11', () => {
    const { modules, terminals, fits } = fakeModules();
    createEngine(withAddons(modules, { webgl: false })).create(OPTIONS);
    const terminal = terminals[0];
    expect(terminal?.options['allowProposedApi']).toBe(true);
    expect(terminal?.addons).toHaveLength(3);
    expect(terminal?.addons[0]).toBe(fits[0]);
    expect(terminal?.addons[2]).toBe(FakeUnicodeAddon.instances[0]);
    expect(terminal?.unicodeVersions).toEqual(['11']);
    expect(terminal?.unicode.activeVersion).toBe('11');
  });

  it('keeps proposed API off and Unicode 6 while the module is absent', () => {
    const { modules, terminals } = fakeModules();
    createEngine(modules).create(OPTIONS);
    expect(terminals[0]?.options['allowProposedApi']).toBe(false);
    expect(terminals[0]?.unicode.activeVersion).toBe('6');
    expect(FakeUnicodeAddon.instances).toHaveLength(0);
  });

  it.each([
    ['activate throws', { throwOnActivate: true, throwOnConstruct: false }],
    ['the constructor throws', { throwOnActivate: false, throwOnConstruct: true }],
  ])('leaves a working terminal on Unicode 6 when %s', (_name, behavior) => {
    FakeUnicodeAddon.behavior = behavior;
    const { modules, terminals } = fakeModules();
    const instance = createEngine(withAddons(modules, { webgl: false })).create(OPTIONS);
    expect(instance.terminal.cols).toBe(80);
    expect(terminals[0]?.unicode.activeVersion).toBe('6');
    expect(terminals[0]?.addons).toHaveLength(2);
  });
});

/** A document whose canvas answers `getContext` as the test says; `created` counts the canvases. */
function fakeDocument(getContext: (kind: string) => unknown): {
  doc: Pick<Document, 'createElement'>;
  created: number;
} {
  const state = { doc: undefined as unknown as Pick<Document, 'createElement'>, created: 0 };
  state.doc = {
    createElement: (() => {
      state.created += 1;
      return { getContext };
    }) as unknown as Document['createElement'],
  };
  return state;
}

describe('webgl2Available', () => {
  it('is true when a WebGL2 context exists, and frees that context at once', () => {
    const lose = vi.fn();
    const getExtension = vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext: lose } : null));
    const fake = fakeDocument((kind) => (kind === 'webgl2' ? { getExtension } : null));
    expect(webgl2Available(fake.doc)).toBe(true);
    expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(lose).toHaveBeenCalledOnce();
  });

  it('is true when the context has no lose extension', () => {
    const fake = fakeDocument(() => ({ getExtension: () => null }));
    expect(webgl2Available(fake.doc)).toBe(true);
  });

  it('is false when there is no context', () => {
    expect(webgl2Available(fakeDocument(() => null).doc)).toBe(false);
  });

  it('is false when anything throws, the context lookup or the release', () => {
    const lookup = fakeDocument(() => {
      throw new Error('blocked');
    });
    expect(webgl2Available(lookup.doc)).toBe(false);
    const release = fakeDocument(() => ({
      getExtension: () => {
        throw new Error('lost');
      },
    }));
    expect(webgl2Available(release.doc)).toBe(false);
  });

  it('asks once per document and remembers the answer', () => {
    const fake = fakeDocument(() => ({ getExtension: () => null }));
    expect(webgl2Available(fake.doc)).toBe(true);
    expect(webgl2Available(fake.doc)).toBe(true);
    expect(fake.created).toBe(1);
  });

  it('is false in happy-dom, which has no canvas context, so unit tests never import the addon', () => {
    expect(webgl2Available()).toBe(false);
  });
});

describe('createEngine: the GPU renderer (CAW-144, ADR 0135)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAddonFakes();
  });

  const gpu = (over: { gpu?: boolean; probe?: () => boolean; slots?: GpuSlots } = {}) => ({
    gpu: true,
    probe: () => true,
    slots: createGpuSlots(),
    ...over,
  });

  it('allows four GPU terminals at a time', () => {
    expect(MAX_GPU_TERMINALS).toBe(4);
  });

  it('is not loaded by create: attach builds it, after open, in one loadAddon call', () => {
    const { modules, terminals } = fakeModules();
    const instance = createEngine(withAddons(modules, { unicode: false }), gpu()).create(OPTIONS);
    expect(FakeWebglAddon.instances).toHaveLength(0);
    expect(instance.renderer.kind()).toBe('dom');
    instance.terminal.open(document.createElement('div'));
    expect(instance.renderer.attach()).toBe('webgl');
    expect(instance.renderer.kind()).toBe('webgl');
    expect(terminals[0]?.log.slice(-2)).toEqual(['open', 'loadAddon:FakeWebglAddon']);
    expect(FakeWebglAddon.instances).toHaveLength(1);
  });

  it.each([
    ['the preference is dom', { gpu: false }],
    ['the WebGL2 probe says no', { probe: () => false }],
  ])('never constructs the addon when %s', (_name, over) => {
    const { modules } = fakeModules();
    const slots = createGpuSlots();
    const instance = createEngine(withAddons(modules), gpu({ ...over, slots })).create(OPTIONS);
    expect(instance.renderer.attach()).toBe('dom');
    expect(instance.renderer.kind()).toBe('dom');
    expect(FakeWebglAddon.instances).toHaveLength(0);
    expect(slots.used()).toBe(0);
  });

  it('answers dom when the module did not load', () => {
    const { modules } = fakeModules();
    const instance = createEngine(withAddons(modules, { webgl: false }), gpu()).create(OPTIONS);
    expect(instance.renderer.attach()).toBe('dom');
    expect(instance.renderer.kind()).toBe('dom');
  });

  it.each([
    ['the constructor throws', { throwOnActivate: false, throwOnConstruct: true }, 0],
    ['activate throws', { throwOnActivate: true, throwOnConstruct: false }, 1],
  ])('answers dom, disposes the addon and frees the slot when %s', (_name, behavior, disposed) => {
    FakeWebglAddon.behavior = behavior;
    const { modules } = fakeModules();
    const slots = createGpuSlots();
    const instance = createEngine(withAddons(modules), gpu({ slots })).create(OPTIONS);
    expect(instance.renderer.attach()).toBe('dom');
    expect(instance.renderer.kind()).toBe('dom');
    expect(FakeWebglAddon.instances[0]?.disposed ?? 0).toBe(disposed);
    expect(slots.used()).toBe(0);
  });

  it('survives an addon that throws again while it is disposed', () => {
    FakeWebglAddon.behavior = { throwOnActivate: true, throwOnConstruct: false };
    const { modules } = fakeModules();
    const instance = createEngine(withAddons(modules), gpu()).create(OPTIONS);
    vi.spyOn(FakeWebglAddon.prototype, 'dispose').mockImplementation(() => {
      throw new Error('already gone');
    });
    expect(instance.renderer.attach()).toBe('dom');
  });

  it('goes back to the DOM renderer once when the context is lost for good', () => {
    const { modules } = fakeModules();
    const slots = createGpuSlots();
    const instance = createEngine(withAddons(modules), gpu({ slots })).create(OPTIONS);
    const fallback = vi.fn();
    instance.renderer.onFallback(fallback);
    expect(instance.renderer.attach()).toBe('webgl');
    expect(slots.used()).toBe(1);
    const addon = FakeWebglAddon.instances[0];
    addon?.loseContext();
    addon?.loseContext();
    expect(addon?.disposed).toBe(1);
    expect(instance.renderer.kind()).toBe('dom');
    expect(slots.used()).toBe(0);
    expect(fallback).toHaveBeenCalledOnce();
    // disposing the terminal later neither disposes the addon again nor frees a second slot
    instance.dispose();
    expect(addon?.disposed).toBe(1);
    expect(slots.used()).toBe(0);
  });

  it('never throws out of a fallback listener or a failing dispose', () => {
    const { modules } = fakeModules();
    const instance = createEngine(withAddons(modules), gpu()).create(OPTIONS);
    const later = vi.fn();
    instance.renderer.onFallback(() => {
      throw new Error('listener failed');
    });
    instance.renderer.onFallback(later);
    instance.renderer.attach();
    vi.spyOn(FakeWebglAddon.prototype, 'dispose').mockImplementation(() => {
      throw new Error('dispose failed');
    });
    expect(() => {
      FakeWebglAddon.instances[0]?.loseContext();
    }).not.toThrow();
    expect(instance.renderer.kind()).toBe('dom');
    expect(later).toHaveBeenCalledOnce();
  });

  it('stops notifying a listener that was disposed', () => {
    const { modules } = fakeModules();
    const instance = createEngine(withAddons(modules), gpu()).create(OPTIONS);
    const fallback = vi.fn();
    instance.renderer.onFallback(fallback).dispose();
    instance.renderer.attach();
    FakeWebglAddon.instances[0]?.loseContext();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('gives the fifth terminal the DOM renderer and frees a slot when a GPU terminal is disposed', () => {
    const { modules } = fakeModules();
    const slots = createGpuSlots();
    const engine = createEngine(withAddons(modules), gpu({ slots }));
    const instances = Array.from({ length: 5 }, () => engine.create(OPTIONS));
    const kinds = instances.map((instance) => instance.renderer.attach());
    expect(kinds).toEqual(['webgl', 'webgl', 'webgl', 'webgl', 'dom']);
    expect(FakeWebglAddon.instances).toHaveLength(4);
    expect(slots.used()).toBe(4);
    instances[0]?.dispose();
    instances[0]?.dispose();
    expect(slots.used()).toBe(3);
    const sixth = engine.create(OPTIONS);
    expect(sixth.renderer.attach()).toBe('webgl');
    expect(slots.used()).toBe(4);
  });

  it('attaches only once per terminal', () => {
    const { modules } = fakeModules();
    const instance = createEngine(withAddons(modules), gpu()).create(OPTIONS);
    expect(instance.renderer.attach()).toBe('webgl');
    expect(instance.renderer.attach()).toBe('webgl');
    expect(FakeWebglAddon.instances).toHaveLength(1);
    instance.dispose();
  });
});

describe('loadXtermEngine: optional chunks', () => {
  afterEach(() => {
    installCspShims()();
    resetAddonFakes();
  });

  /** Importers that resolve fake modules and count how often each one is asked. */
  function importers(over: Partial<XtermImporters> = {}): { importers: XtermImporters; asked: Record<string, number> } {
    const { modules } = fakeModules();
    const asked: Record<string, number> = { xterm: 0, fit: 0, links: 0, unicode11: 0, webgl: 0 };
    const count =
      <T>(name: string, value: T) =>
      () => {
        asked[name] = (asked[name] ?? 0) + 1;
        return Promise.resolve(value);
      };
    return {
      asked,
      importers: {
        xterm: count('xterm', { Terminal: modules.Terminal }),
        fit: count('fit', { FitAddon: modules.FitAddon }),
        links: count('links', { WebLinksAddon: modules.WebLinksAddon }),
        unicode11: count('unicode11', {
          Unicode11Addon: FakeUnicodeAddon as unknown as XtermModules['Unicode11Addon'],
        }),
        webgl: count('webgl', { WebglAddon: FakeWebglAddon as unknown as XtermModules['WebglAddon'] }),
        ...over,
      } as XtermImporters,
    };
  }

  it('does not import the WebGL chunk when gpu is false', async () => {
    const { importers: deps, asked } = importers();
    await loadXtermEngine({ gpu: false }, { importers: deps, webgl2Available: () => true });
    expect(asked['webgl']).toBe(0);
    expect(asked['unicode11']).toBe(1);
  });

  it('does not import the WebGL chunk when the probe says no', async () => {
    const { importers: deps, asked } = importers();
    await loadXtermEngine({ gpu: true }, { importers: deps, webgl2Available: () => false });
    expect(asked['webgl']).toBe(0);
  });

  it('imports the WebGL chunk once when gpu is true and the probe says yes', async () => {
    const { importers: deps, asked } = importers();
    const engine = await loadXtermEngine({ gpu: true }, { importers: deps, webgl2Available: () => true });
    expect(asked).toEqual({ xterm: 1, fit: 1, links: 1, unicode11: 1, webgl: 1 });
    const instance = engine.create(OPTIONS);
    expect(instance.renderer.attach()).toBe('webgl');
    instance.dispose();
  });

  it('never fails the engine because an optional import failed', async () => {
    const { importers: deps } = importers({
      unicode11: () => Promise.reject(new Error('chunk 404')),
      webgl: () => Promise.reject(new Error('chunk 404')),
    });
    const engine = await loadXtermEngine({ gpu: true }, { importers: deps, webgl2Available: () => true });
    const instance = engine.create(OPTIONS);
    expect(instance.terminal.cols).toBe(80);
    expect(instance.renderer.attach()).toBe('dom');
  });

  it.each(['xterm', 'fit', 'links'] as const)('still rejects when the required %s import fails', async (name) => {
    const { importers: deps } = importers({ [name]: () => Promise.reject(new Error('chunk 404')) });
    await expect(loadXtermEngine({ gpu: true }, { importers: deps, webgl2Available: () => true })).rejects.toThrow(
      'chunk 404',
    );
  });
});

describe('the optional addons (the real packages)', () => {
  it('resolve and fit the adapter: Unicode 11 registers and activates, which needs proposed API', async () => {
    const xterm = await import('@xterm/xterm');
    const unicode = await import('@xterm/addon-unicode11');
    const webgl = await import('@xterm/addon-webgl');
    expect(typeof webgl.WebglAddon).toBe('function');
    expect(typeof unicode.Unicode11Addon).toBe('function');

    class Capture extends xterm.Terminal {
      static last: InstanceType<typeof xterm.Terminal> | undefined;
      constructor(options?: ConstructorParameters<typeof xterm.Terminal>[0]) {
        super(options);
        Capture.last = this;
      }
    }
    const instance = createEngine({
      Terminal: Capture,
      FitAddon: (await import('@xterm/addon-fit')).FitAddon,
      WebLinksAddon: (await import('@xterm/addon-web-links')).WebLinksAddon,
      Unicode11Addon: unicode.Unicode11Addon,
      WebglAddon: webgl.WebglAddon,
    }).create(OPTIONS);
    try {
      expect(Capture.last?.unicode.versions).toContain('11');
      expect(Capture.last?.unicode.activeVersion).toBe('11');
      expect(typeof instance.terminal.paste).toBe('function');
      expect(instance.renderer.kind()).toBe('dom');
    } finally {
      instance.dispose();
    }
  });
});

describe('installCspShims', () => {
  let remove: (() => void) | null = null;

  afterEach(() => {
    remove?.();
    remove = null;
    document.head.querySelector('meta[name="csp-nonce"]')?.remove();
  });

  function withMeta(content: string): void {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'csp-nonce');
    meta.setAttribute('content', content);
    document.head.append(meta);
  }

  it('installs the nonce wrapper and the colour adapter', () => {
    withMeta('dGhpcyBpcyBhIG5vbmNl');
    const setAttribute = read(Element.prototype, 'setAttribute');
    remove = installCspShims();
    expect(nonceOf(document.createElement('style'))).toBe('dGhpcyBpcyBhIG5vbmNl');
    expect(read(Element.prototype, 'setAttribute')).not.toBe(setAttribute);
    remove();
    remove = null;
    expect(read(Element.prototype, 'setAttribute')).toBe(setAttribute);
    expect(nonceOf(document.createElement('style'))).toBe('');
  });

  it('installs only the colour adapter while the page carries no nonce', () => {
    withMeta('__CSP_NONCE__');
    remove = installCspShims();
    expect(nonceOf(document.createElement('style'))).toBe('');
    expect(Object.hasOwn(document, 'createElement')).toBe(false);
  });

  it('is idempotent', () => {
    withMeta('dGhpcyBpcyBhIG5vbmNl');
    const first = installCspShims();
    const second = installCspShims();
    remove = first;
    const wrapped = read(Element.prototype, 'setAttribute');
    installCspShims();
    expect(read(Element.prototype, 'setAttribute')).toBe(wrapped);
    expect(typeof second).toBe('function');
  });
});

describe('loadXtermEngine (the real packages)', () => {
  afterEach(() => {
    // the shims live for the page; take them out so the next test starts from the document as it was
    installCspShims()();
  });

  it('imports the three packages lazily and builds a working terminal', async () => {
    const engine = await loadXtermEngine();
    const instance = engine.create(OPTIONS);
    try {
      expect(instance.terminal.cols).toBe(80);
      expect(instance.terminal.rows).toBe(24);
      instance.terminal.resize(100, 30);
      expect([instance.terminal.cols, instance.terminal.rows]).toEqual([100, 30]);
      // options written afterwards reach the real options object
      instance.terminal.options.fontSize = 14;
      expect(instance.terminal.options.fontSize).toBe(14);
      expect(instance.terminal.options.minimumContrastRatio).toBe(1);
      expect(instance.terminal.options.theme?.red).toBe('#e06c75');
      expect(instance.terminal.hasSelection()).toBe(false);
      expect(instance.terminal.buffer.active.baseY).toBe(0);
      const sizes: { cols: number; rows: number }[] = [];
      // xterm 6 adds `colsChanged` and `rowsChanged` to the size it reports
      const subscription = instance.terminal.onResize((size) => sizes.push(size));
      instance.terminal.resize(90, 20);
      expect(sizes).toHaveLength(1);
      expect(sizes[0]).toMatchObject({ cols: 90, rows: 20 });
      subscription.dispose();
    } finally {
      instance.dispose();
    }
  });

  it('has the shims in place before the first terminal is built', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'csp-nonce');
    meta.setAttribute('content', 'dGhpcyBpcyBhIG5vbmNl');
    document.head.append(meta);
    try {
      const engine = await loadXtermEngine();
      expect(nonceOf(document.createElement('style'))).toBe('dGhpcyBpcyBhIG5vbmNl');
      engine.create(OPTIONS).dispose();
    } finally {
      // while the tag is still there, so that the nonce wrapper is the live one that is removed
      installCspShims()();
      meta.remove();
    }
  });
});
