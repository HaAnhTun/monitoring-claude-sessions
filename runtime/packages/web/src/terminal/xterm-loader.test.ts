import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalOptions } from './engine.ts';
import {
  createEngine,
  installCspShims,
  loadXtermEngine,
  openExternalLink,
  type OpenWindow,
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
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
  }
  loadAddon(addon: unknown): void {
    this.addons.push(addon);
  }
  open(host: HTMLElement): void {
    this.calls.push(['open', host]);
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
    const subscriptions = [
      terminal.onData(onData),
      terminal.onBinary(onBinary),
      terminal.onResize(onResize),
      terminal.onScroll(onScroll),
    ];
    (fake.listeners['data'] as ((data: string) => void) | undefined)?.('typed');
    (fake.listeners['binary'] as ((data: string) => void) | undefined)?.('\u0001');
    (fake.listeners['resize'] as ((size: { cols: number; rows: number }) => void) | undefined)?.({
      cols: 90,
      rows: 20,
    });
    (fake.listeners['scroll'] as ((position: number) => void) | undefined)?.(42);
    expect(onData).toHaveBeenCalledWith('typed');
    expect(onBinary).toHaveBeenCalledWith('\u0001');
    expect(onResize).toHaveBeenCalledWith({ cols: 90, rows: 20 });
    // the position of the scroll is not passed on: the app reads the buffer
    expect(onScroll).toHaveBeenCalledExactlyOnceWith();
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
