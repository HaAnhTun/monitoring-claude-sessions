// The only file that imports xterm.js (eslint `no-restricted-imports` and the `ImportExpression` rule keep `@xterm/*` out of every
// other file, so the packages can never join the first chunk). `loadXtermEngine` is called when a session is opened: it installs
// the two CSP shims of `style-nonce.ts`, imports the packages lazily (the "Terminal chunk" row of the bundle budget) and adapts the
// real classes to `TerminalEngine`, the shape the connection hook and the view are written against.
//
// Two addons are optional and can never fail the engine (CAW-144, ADR 0135, which amends decision 2 of ADR 0097): Unicode 11
// (wide emoji and CJK take two cells, as the program lays them out; it needs `allowProposedApi`, set only when the module loaded)
// and the WebGL renderer, a chunk of its own that is imported only when WebGL2 exists and the preference is not "dom". The GPU
// renderer is attached after `terminal.open` inside a `try/catch` (`renderer.attach()`), at most four terminals at a time, and the
// terminal returns to xterm's DOM renderer when the GPU context is lost for good. The stylesheet is not imported here:
// `styles/index.css` imports `@xterm/xterm/css/xterm.css` once, in the components layer.
import type { FitAddon } from '@xterm/addon-fit';
import type { Unicode11Addon } from '@xterm/addon-unicode11';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

import type {
  Disposable,
  EngineLoadOptions,
  FitLike,
  RendererKind,
  RendererLike,
  TerminalEngine,
  TerminalInstance,
  TerminalLike,
  TerminalOptions,
} from './engine.ts';
import { installInlineColorAdapter, installStyleNonce, readStyleNonce } from './style-nonce.ts';

/** `window.open`, as far as the link opener needs it. */
export type OpenWindow = (url: string, target: string, features: string) => unknown;

/**
 * Opens a link a person clicked in the terminal output (Claude prints login addresses): `http` and `https` only, in a new tab with
 * no `opener` and no referrer. Any other scheme (`javascript:`, `data:`, `file:`, `blob:`, `ftp:`, `mailto:`) or text that is not an
 * address is refused: the terminal output is not trusted. Returns whether a window was opened. This is a click on printed text, not
 * a rendered link, so the lint rule against `target="_blank"` in JSX does not apply (ADR 0097).
 */
export function openExternalLink(uri: string, open: OpenWindow = (...args) => window.open(...args)): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  open(url.href, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Installs the CSP shims of `style-nonce.ts` for the page: the nonce on created `style` elements (when the meta tag carries one) and
 * the CSSOM write of 24-bit colours. Idempotent; the shims live as long as the page. The returned function removes them (tests).
 */
export function installCspShims(doc: Document = document): () => void {
  const removeNonce = installStyleNonce(doc, readStyleNonce(doc));
  const removeAdapter = installInlineColorAdapter();
  return () => {
    removeAdapter();
    removeNonce();
  };
}

/**
 * The classes the engine is built from; tests give fakes. The first three are required. The other two are optional: without
 * `Unicode11Addon` the terminal keeps Unicode 6 (and proposed API off); without `WebglAddon` it keeps the DOM renderer.
 */
export interface XtermModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  WebLinksAddon: typeof WebLinksAddon;
  Unicode11Addon?: typeof Unicode11Addon | undefined;
  WebglAddon?: typeof WebglAddon | undefined;
}

/** Chrome keeps about 16 WebGL contexts per page and drops the oldest; four GPU terminals at a time stay well inside that. */
export const MAX_GPU_TERMINALS = 4;

/** How many terminals hold the GPU renderer right now. A counter is simpler than relying on the browser dropping the oldest. */
export interface GpuSlots {
  /** Takes a slot; false when all are taken. */
  acquire(): boolean;
  release(): void;
  used(): number;
}

export function createGpuSlots(max: number = MAX_GPU_TERMINALS): GpuSlots {
  let used = 0;
  return {
    acquire() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    release() {
      if (used > 0) used -= 1;
    },
    used: () => used,
  };
}

/** The slots of the page: every engine of a page shares them, because the limit is the browser's, per page. */
const PAGE_GPU_SLOTS = createGpuSlots();

const webgl2Answers = new WeakMap<object, boolean>();

/**
 * Whether the browser can make a WebGL2 context: one throw-away canvas, whose context is released at once through
 * `WEBGL_lose_context`. The answer is remembered per document (so for the page); any exception means false. happy-dom has no canvas
 * context, so this is false in unit tests and they never import the addon unless they inject one.
 */
export function webgl2Available(doc: Pick<Document, 'createElement'> = document): boolean {
  const known = webgl2Answers.get(doc);
  if (known !== undefined) return known;
  let answer: boolean;
  try {
    const context = doc.createElement('canvas').getContext('webgl2');
    answer = context !== null;
    if (context !== null) context.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    answer = false;
  }
  webgl2Answers.set(doc, answer);
  return answer;
}

function adaptTerminal(terminal: Terminal): TerminalLike {
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    get textarea() {
      return terminal.textarea;
    },
    get buffer() {
      return terminal.buffer;
    },
    // xterm's own options object: its keys are those of `LiveTerminalOptions`, and a write to it reaches the terminal
    get options() {
      return terminal.options;
    },
    set options(value) {
      Object.assign(terminal.options, value);
    },
    open: (host) => {
      terminal.open(host);
    },
    write: (data, callback) => {
      terminal.write(data, callback);
    },
    reset: () => {
      terminal.reset();
    },
    resize: (cols, rows) => {
      terminal.resize(cols, rows);
    },
    focus: () => {
      terminal.focus();
    },
    blur: () => {
      terminal.blur();
    },
    dispose: () => {
      terminal.dispose();
    },
    scrollToBottom: () => {
      terminal.scrollToBottom();
    },
    hasSelection: () => terminal.hasSelection(),
    getSelection: () => terminal.getSelection(),
    clearSelection: () => {
      terminal.clearSelection();
    },
    paste: (data) => {
      terminal.paste(data);
    },
    onData: (listener) => terminal.onData(listener),
    onBinary: (listener) => terminal.onBinary(listener),
    onResize: (listener) => terminal.onResize(listener),
    // xterm passes the scroll position; the app only needs to know that it moved
    onScroll: (listener) =>
      terminal.onScroll(() => {
        listener();
      }),
    onSelectionChange: (listener) => terminal.onSelectionChange(listener),
    attachCustomKeyEventHandler: (handler) => {
      terminal.attachCustomKeyEventHandler(handler);
    },
  };
}

function adaptFit(fit: FitAddon): FitLike {
  return {
    fit: () => {
      fit.fit();
    },
    proposeDimensions: () => fit.proposeDimensions(),
  };
}

/** What the engine needs from the page besides the classes; tests give their own. */
export interface EngineOptions {
  /** The preference allows the GPU renderer (it is not "dom"). Default false. */
  gpu?: boolean;
  /** Whether WebGL2 can be had. Default: `webgl2Available()`, asked only when `attach` runs with the module present. */
  probe?: () => boolean;
  /** The GPU terminals of the page. Default: the slots every engine of the page shares. */
  slots?: GpuSlots;
}

/** Runs `action`, ignoring a throw: the optional parts must never break a terminal. */
function attempt(action: () => void): void {
  try {
    action();
  } catch {
    // an optional part failed; the terminal goes on without it
  }
}

/** The WebGL2 probe; one that throws counts as "no". */
function askProbe(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

/** Loads Unicode 11 into the terminal and switches to it; on any failure the terminal stays on Unicode 6. */
function enableUnicode11(terminal: Terminal, UnicodeClass: typeof Unicode11Addon): void {
  attempt(() => {
    terminal.loadAddon(new UnicodeClass());
    terminal.unicode.activeVersion = '11';
  });
}

/** The renderer of one terminal and the way to hand its slot back when the terminal goes. */
interface RendererControl extends RendererLike {
  /** The terminal is being disposed: xterm takes the addon down with it, only the slot is ours to give back. */
  releaseSlot(): void;
}

/**
 * The optional GPU renderer of one terminal. `attach` runs once, after `open`; every failure leaves xterm's DOM renderer in place.
 * Losing the context for good (xterm's addon fires `onContextLoss` when the browser did not restore it) disposes the addon, which
 * puts the DOM renderer back, and tells the listeners once.
 */
function createRenderer(terminal: Terminal, modules: XtermModules, options: EngineOptions): RendererControl {
  const slots = options.slots ?? PAGE_GPU_SLOTS;
  const probe = options.probe ?? (() => webgl2Available());
  const listeners = new Set<() => void>();
  let kind: RendererKind = 'dom';
  let attached = false;
  /** The addon holding a slot; null while the DOM renderer is in force. */
  let addon: WebglAddon | null = null;

  /** Takes the GPU renderer down once, gives its slot back and returns to `dom`; false when it was not up. */
  function takeDown(): boolean {
    if (addon === null) return false;
    const current = addon;
    addon = null;
    kind = 'dom';
    attempt(() => {
      current.dispose();
    });
    slots.release();
    return true;
  }

  function attach(): RendererKind {
    if (attached) return kind;
    attached = true;
    const WebglClass = modules.WebglAddon;
    if (options.gpu !== true || WebglClass === undefined) return kind;
    if (!askProbe(probe) || !slots.acquire()) return kind;
    let created: WebglAddon;
    try {
      created = new WebglClass();
    } catch {
      slots.release();
      return kind;
    }
    addon = created;
    try {
      terminal.loadAddon(created);
    } catch {
      takeDown();
      return kind;
    }
    kind = 'webgl';
    attempt(() => {
      created.onContextLoss(() => {
        if (addon !== created || !takeDown()) return;
        for (const listener of [...listeners]) attempt(listener);
      });
    });
    return kind;
  }

  return {
    attach,
    kind: () => kind,
    onFallback(listener): Disposable {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    releaseSlot() {
      if (addon === null) return;
      addon = null;
      kind = 'dom';
      slots.release();
    },
  };
}

/**
 * The engine over the classes. Each `create` builds one terminal with the fit addon, the links addon (clicks go through
 * `openExternalLink`) and, when its module loaded, Unicode 11; proposed API is on only for that addon, and a line feed is not
 * converted (the process writes its own carriage return and line feed). The GPU renderer is not loaded here: see
 * `TerminalInstance.renderer`.
 */
export function createEngine(modules: XtermModules, engineOptions: EngineOptions = {}): TerminalEngine {
  const {
    Terminal: TerminalClass,
    FitAddon: FitClass,
    WebLinksAddon: LinksClass,
    Unicode11Addon: UnicodeClass,
  } = modules;
  return {
    create(options: TerminalOptions): TerminalInstance {
      const terminal = new TerminalClass({
        ...options,
        // `terminal.unicode` is proposed API and throws without the flag; nothing else of it is used
        allowProposedApi: UnicodeClass !== undefined,
        convertEol: false,
      });
      const fit = new FitClass();
      terminal.loadAddon(fit);
      terminal.loadAddon(
        new LinksClass((_event, uri) => {
          openExternalLink(uri);
        }),
      );
      if (UnicodeClass !== undefined) enableUnicode11(terminal, UnicodeClass);
      const renderer = createRenderer(terminal, modules, engineOptions);
      return {
        terminal: adaptTerminal(terminal),
        fit: adaptFit(fit),
        renderer: {
          attach: () => renderer.attach(),
          kind: () => renderer.kind(),
          onFallback: (listener) => renderer.onFallback(listener),
        },
        // disposing the terminal disposes the addons it loaded
        dispose: () => {
          renderer.releaseSlot();
          terminal.dispose();
        },
      };
    },
  };
}

/** The lazy imports, one per package; a test gives its own to count them and to make one fail. */
export interface XtermImporters {
  xterm: () => Promise<Pick<XtermModules, 'Terminal'>>;
  fit: () => Promise<Pick<XtermModules, 'FitAddon'>>;
  links: () => Promise<Pick<XtermModules, 'WebLinksAddon'>>;
  unicode11: () => Promise<{ Unicode11Addon: typeof Unicode11Addon }>;
  webgl: () => Promise<{ WebglAddon: typeof WebglAddon }>;
}

/** Literal specifiers, so the bundler splits each package into its chunk (the GPU addon into a chunk of its own). */
const DEFAULT_IMPORTERS: XtermImporters = {
  xterm: () => import('@xterm/xterm'),
  fit: () => import('@xterm/addon-fit'),
  links: () => import('@xterm/addon-web-links'),
  unicode11: () => import('@xterm/addon-unicode11'),
  webgl: () => import('@xterm/addon-webgl'),
};

export interface LoadDeps {
  importers?: Partial<XtermImporters>;
  /** Whether WebGL2 can be had; default `webgl2Available()`. */
  webgl2Available?: () => boolean;
  slots?: GpuSlots;
}

/** An optional import: whatever goes wrong, the answer is "not there". */
async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

/**
 * Installs the shims, then loads xterm with its two required addons and the optional ones in one lazy step, and returns the engine.
 * Rejects when a required chunk cannot load. Unicode 11 is always tried; the GPU addon only when `gpu` is true (the preference is
 * not "dom") and WebGL2 is available, so a machine without it never fetches the chunk.
 */
export async function loadXtermEngine(
  options: Partial<EngineLoadOptions> = {},
  deps: LoadDeps = {},
): Promise<TerminalEngine> {
  const gpu = options.gpu ?? true;
  const importers = { ...DEFAULT_IMPORTERS, ...deps.importers };
  const probe = deps.webgl2Available ?? (() => webgl2Available());
  installCspShims();
  const [xterm, fit, links, unicode, webgl] = await Promise.all([
    importers.xterm(),
    importers.fit(),
    importers.links(),
    optional(importers.unicode11),
    gpu && probe() ? optional(importers.webgl) : Promise.resolve(undefined),
  ]);
  return createEngine(
    {
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      WebLinksAddon: links.WebLinksAddon,
      Unicode11Addon: unicode?.Unicode11Addon,
      WebglAddon: webgl?.WebglAddon,
    },
    { gpu, probe, ...(deps.slots === undefined ? {} : { slots: deps.slots }) },
  );
}
