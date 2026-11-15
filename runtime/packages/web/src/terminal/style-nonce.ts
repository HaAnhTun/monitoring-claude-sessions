// What xterm.js needs from the page under the content security policy of the monitor server (ADR 0086, ADR 0097, design 02
// section 7). The policy is `style-src 'self'; style-src-elem 'self' 'nonce-<n>'` with no `style-src-attr`, so two things of xterm
// would be blocked, and each has one small shim here. Both are installed by `xterm-loader.ts` once, just before xterm is imported.
//
// 1. xterm creates `<style>` elements (the scroll bar and, in the DOM renderer, the cell dimensions and the theme) with
//    `document.createElement('style')` and a `textContent`, and offers no way to give them a nonce. `installStyleNonce` wraps
//    `document.createElement` so a `style` element it returns carries the nonce of `<meta name="csp-nonce">`. The server replaces
//    the placeholder of that tag with a new nonce on every HTML response.
//
// 2. The DOM renderer paints each cell whose colour is 24-bit RGB (and, when `minimumContrastRatio` is above 1, each cell it
//    adjusts) with `element.setAttribute('style', 'color:#rrggbb')` or `'background-color:#rrggbb'`. A style ATTRIBUTE is governed
//    by `style-src-attr`, which falls back to `style-src 'self'` and blocks it: the cell loses its colour and the page logs a
//    violation (measured in Chrome: nine violations for three lines of text). Writing the same declarations through the CSSOM
//    (`element.style.cssText = ...`) is not governed by the policy. `installInlineColorAdapter` does exactly that for a value that
//    is nothing but `color` and `background-color` declarations with a hex or `rgb()` value, and hands every other write to the
//    browser unchanged, so it can never be used to set anything else (no `url()`, no other property).
//
// Neither shim runs without the loader, and neither changes what a page without a policy (the dev server) sees.

/** The text the build puts in the meta tag; the server replaces it with the nonce of the response. */
export const NONCE_PLACEHOLDER = '__CSP_NONCE__';

/** A base64 text, as the server writes it (`^[A-Za-z0-9+/]+={0,2}$` there, 16 random bytes); a longer or other value is not ours. */
const NONCE_RE = /^[A-Za-z0-9+/]{1,256}={0,2}$/;

/**
 * The nonce of the page: the content of `<meta name="csp-nonce">`, or `null` when the tag is missing, empty, still the placeholder
 * (the dev server and the tests serve it unreplaced) or not base64. `null` means "no nonce": the loader installs nothing.
 */
export function readStyleNonce(doc: Pick<Document, 'querySelector'>): string | null {
  const content = doc.querySelector('meta[name="csp-nonce"]')?.getAttribute('content')?.trim() ?? '';
  if (content === '' || content === NONCE_PLACEHOLDER) return null;
  return NONCE_RE.test(content) ? content : null;
}

const nonceInstalls = new WeakMap<Document, () => void>();

/** An element, as far as the wrapper can tell without a type assertion: an object whose tag name is `style`. */
function isStyleElement(element: unknown): element is object {
  return typeof element === 'object' && element !== null && Reflect.get(element, 'localName') === 'style';
}

/**
 * Wraps `doc.createElement` once so that a `style` element it returns carries `nonce`. Idempotent: while an installation is live a
 * second call changes nothing (the page has one nonce for its whole life) and returns the first remover. Without a nonce nothing is
 * installed. The remover puts the previous method back (or removes the own property when there was none) unless somebody wrapped it
 * again since, and may be called twice. The method is read and written through `Reflect`, so the wrapper keeps whatever overloads
 * the document has and needs no cast.
 */
export function installStyleNonce(doc: Document, nonce: string | null): () => void {
  if (nonce === null) return () => undefined;
  const live = nonceInstalls.get(doc);
  if (live !== undefined) return live;

  const original: unknown = Reflect.get(doc, 'createElement');
  if (typeof original !== 'function') return () => undefined;
  const hadOwn = Object.hasOwn(doc, 'createElement');
  const wrapped = function createElementWithNonce(this: unknown, ...args: unknown[]): unknown {
    const element: unknown = Reflect.apply(original, this, args);
    // the nonce is set through the `HTMLElement.nonce` accessor of the element the document made
    if (isStyleElement(element)) Reflect.set(element, 'nonce', nonce);
    return element;
  };
  Object.defineProperty(doc, 'createElement', { value: wrapped, writable: true, configurable: true });

  const uninstall = (): void => {
    if (nonceInstalls.get(doc) !== uninstall) return;
    nonceInstalls.delete(doc);
    if (Reflect.get(doc, 'createElement') !== wrapped) return;
    if (hadOwn) Object.defineProperty(doc, 'createElement', { value: original, writable: true, configurable: true });
    else Reflect.deleteProperty(doc, 'createElement');
  };
  nonceInstalls.set(doc, uninstall);
  return uninstall;
}

/** The part of `Element.prototype` the adapter replaces (a property, not a method: the adapter reads and writes it by name). */
export interface StyleWriteTarget {
  setAttribute: (name: string, value: string) => void;
}

/**
 * One declaration xterm writes, without its `;`: `color` or `background-color` with `#hex` (3, 4, 6 or 8 digits) or `rgb()`/`rgba()`
 * (three or four numbers, each with an optional `%`, split by whitespace, `,` or `/`). The text is cut at every `;` before this runs,
 * so the pattern is anchored at both ends and every part of it has exactly one way to match a given text: a gap between two numbers
 * is a comma or slash with optional spaces around it, or spaces alone, never both. There is no quantified group in which two
 * neighbours can match the same characters (that is what made an earlier pattern exponential), so the time a value costs grows with
 * its length and no faster, and the length cap below keeps even that small.
 */
const COLOR_DECLARATION =
  /^\s*(?:color|background-color)\s*:\s*(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*[0-9.]+%?(?:(?:\s*[,/]\s*|\s+)[0-9.]+%?){2,3}\s*\))\s*$/i;

/** The longest value tested: xterm writes at most two short declarations, so a longer one is not its write. */
const MAX_STYLE_VALUE_LENGTH = 256;

/**
 * True when `value` is a list of colour declarations separated by `;` (one `;` may end the list, spaces may follow it) and nothing
 * else. It cuts the text at the semicolons and tests each part on its own, which keeps the test linear in the length of the value.
 */
function isColorOnlyStyle(value: string): boolean {
  if (value.length > MAX_STYLE_VALUE_LENGTH) return false;
  const declarations = value.split(';');
  // `a;b;` ends in an empty part (a final `;`); an empty part anywhere else is not a declaration and fails the test below
  if (declarations.at(-1)?.trim() === '') declarations.pop();
  return declarations.length > 0 && declarations.every((declaration) => COLOR_DECLARATION.test(declaration));
}

function hasCssText(target: unknown): target is { style: { cssText: string } } {
  if (typeof target !== 'object' || target === null) return false;
  const style: unknown = Reflect.get(target, 'style');
  return typeof style === 'object' && style !== null && typeof Reflect.get(style, 'cssText') === 'string';
}

const adapterInstalls = new WeakMap<StyleWriteTarget, () => void>();

/**
 * True while the adapter's own CSSOM write runs. A real browser reflects a CSSOM change into the attribute internally; a DOM
 * implementation that does it through the public `setAttribute` (happy-dom does) would call the adapter again, and the guard makes
 * that nested call reach the real method instead of recursing.
 */
let writingCssText = false;

/**
 * Makes `setAttribute('style', <colour declarations>)` a CSSOM write on every element (see the header). It replaces
 * `setAttribute` on `target` (default `Element.prototype`); a call that is not exactly that shape reaches the browser's method with
 * the same `this` and arguments. Idempotent per target, with a remover that restores the previous method unless somebody wrapped
 * it again since.
 */
export function installInlineColorAdapter(target: StyleWriteTarget = Element.prototype): () => void {
  const live = adapterInstalls.get(target);
  if (live !== undefined) return live;

  const original: unknown = Reflect.get(target, 'setAttribute');
  if (typeof original !== 'function') return () => undefined;
  const wrapped = function setAttributeWithColorAdapter(this: unknown, name: string, value: string): void {
    if (
      !writingCssText &&
      typeof name === 'string' &&
      typeof value === 'string' &&
      name.toLowerCase() === 'style' &&
      hasCssText(this) &&
      isColorOnlyStyle(value)
    ) {
      writingCssText = true;
      try {
        this.style.cssText = value;
      } finally {
        writingCssText = false;
      }
      return;
    }
    Reflect.apply(original, this, [name, value]);
  };
  Reflect.set(target, 'setAttribute', wrapped);

  const uninstall = (): void => {
    if (adapterInstalls.get(target) !== uninstall) return;
    adapterInstalls.delete(target);
    if (Reflect.get(target, 'setAttribute') === wrapped) Reflect.set(target, 'setAttribute', original);
  };
  adapterInstalls.set(target, uninstall);
  return uninstall;
}
