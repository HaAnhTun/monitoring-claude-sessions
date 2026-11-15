// The only file that imports xterm.js (eslint `no-restricted-imports` and the `ImportExpression` rule keep `@xterm/*` out of every
// other file, so the three packages can never join the first chunk). `loadXtermEngine` is called when a session is opened: it
// installs the two CSP shims of `style-nonce.ts`, imports the three packages lazily (the "Terminal chunk" row of the bundle budget)
// and adapts the real classes to `TerminalEngine`, the shape the connection hook and the view are written against.
//
// The renderer is xterm's DOM renderer, with no renderer addon (ADR 0097: the spike found the nonce and the colour adapter enough,
// and a WebGL package would be a fourth dependency with no stable release for this xterm). The stylesheet is not imported here:
// `styles/index.css` imports `@xterm/xterm/css/xterm.css` once, in the components layer.
import type { FitAddon } from '@xterm/addon-fit';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal } from '@xterm/xterm';

import type { FitLike, TerminalEngine, TerminalInstance, TerminalLike, TerminalOptions } from './engine.ts';
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

/** The three classes the engine is built from; tests give fakes. */
export interface XtermModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  WebLinksAddon: typeof WebLinksAddon;
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
    onData: (listener) => terminal.onData(listener),
    onBinary: (listener) => terminal.onBinary(listener),
    onResize: (listener) => terminal.onResize(listener),
    // xterm passes the scroll position; the app only needs to know that it moved
    onScroll: (listener) =>
      terminal.onScroll(() => {
        listener();
      }),
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

/**
 * The engine over the three classes. Each `create` builds one terminal with the fit addon and the links addon (clicks go through
 * `openExternalLink`); proposed APIs stay off and a line feed is not converted (the process writes its own `\r\n`).
 */
export function createEngine({
  Terminal: TerminalClass,
  FitAddon: FitClass,
  WebLinksAddon: LinksClass,
}: XtermModules): TerminalEngine {
  return {
    create(options: TerminalOptions): TerminalInstance {
      const terminal = new TerminalClass({ ...options, allowProposedApi: false, convertEol: false });
      const fit = new FitClass();
      terminal.loadAddon(fit);
      terminal.loadAddon(
        new LinksClass((_event, uri) => {
          openExternalLink(uri);
        }),
      );
      return {
        terminal: adaptTerminal(terminal),
        fit: adaptFit(fit),
        // disposing the terminal disposes the addons it loaded
        dispose: () => {
          terminal.dispose();
        },
      };
    },
  };
}

/** Installs the shims, loads xterm and its two addons in one lazy step, and returns the engine. Rejects when a chunk cannot load. */
export async function loadXtermEngine(): Promise<TerminalEngine> {
  installCspShims();
  const [xterm, fit, links] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
  ]);
  return createEngine({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon, WebLinksAddon: links.WebLinksAddon });
}
