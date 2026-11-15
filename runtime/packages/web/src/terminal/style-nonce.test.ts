import { describe, expect, it, vi } from 'vitest';

import {
  installInlineColorAdapter,
  installStyleNonce,
  NONCE_PLACEHOLDER,
  readStyleNonce,
  type StyleWriteTarget,
} from './style-nonce.ts';

// ADR 0097. The server answers the page with `style-src-elem 'self' 'nonce-<n>'` and puts `<n>` in `<meta name="csp-nonce">`.
// xterm creates `<style>` elements through `document.createElement` and cannot take a nonce itself, so the wrapper under test
// gives them one; and its DOM renderer paints every 24-bit colour with `setAttribute('style', 'color:#rrggbb')`, which
// `style-src` blocks, so the adapter under test writes that exact shape through the CSSOM (spike evidence in the ADR).

/** A property by name, as the wrapper itself reads it (no method is taken off its object). */
function read(target: object, key: string): unknown {
  return Reflect.get(target, key);
}

/** The nonce of an element, or an empty text when the DOM implementation has none (happy-dom has no `nonce` accessor). */
function nonceOf(element: Element): string {
  const value = read(element, 'nonce');
  return typeof value === 'string' ? value : '';
}

function pageWith(metaContent: string | null): Document {
  const doc = document.implementation.createHTMLDocument('t');
  if (metaContent !== null) {
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'csp-nonce');
    meta.setAttribute('content', metaContent);
    doc.head.append(meta);
  }
  return doc;
}

describe('readStyleNonce', () => {
  it('reads the nonce of the meta tag', () => {
    expect(readStyleNonce(pageWith('dGhpcyBpcyBhIG5vbmNl'))).toBe('dGhpcyBpcyBhIG5vbmNl');
    expect(readStyleNonce(pageWith('abc+DEF/0123456789=='))).toBe('abc+DEF/0123456789==');
  });

  it('ignores whitespace around the value', () => {
    expect(readStyleNonce(pageWith('  dGhpcyBpcyBhIG5vbmNl\n'))).toBe('dGhpcyBpcyBhIG5vbmNl');
  });

  it('has none when the tag is missing (a build served by something other than the monitor server)', () => {
    expect(readStyleNonce(pageWith(null))).toBeNull();
  });

  it('has none when the tag is empty', () => {
    expect(readStyleNonce(pageWith(''))).toBeNull();
    expect(readStyleNonce(pageWith('   '))).toBeNull();
  });

  it('has none while the server has not replaced the placeholder (the dev server, tests)', () => {
    expect(NONCE_PLACEHOLDER).toBe('__CSP_NONCE__');
    expect(readStyleNonce(pageWith(NONCE_PLACEHOLDER))).toBeNull();
  });

  it.each(["a'b", 'a b', 'a;b', 'a"b', 'a<b>', 'nonce-abc', 'a\nb'])(
    'has none for a value that is not base64: %j',
    (value) => {
      expect(readStyleNonce(pageWith(value))).toBeNull();
    },
  );
});

describe('installStyleNonce', () => {
  it('gives a created style element the nonce', () => {
    const doc = pageWith(null);
    installStyleNonce(doc, 'N0nce+/==');
    expect(nonceOf(doc.createElement('style'))).toBe('N0nce+/==');
  });

  it('reads the tag name in any letter case', () => {
    const doc = pageWith(null);
    installStyleNonce(doc, 'N0nce');
    expect(nonceOf(doc.createElement('STYLE'))).toBe('N0nce');
    expect(nonceOf(doc.createElement('Style'))).toBe('N0nce');
  });

  it('leaves every other element alone', () => {
    const doc = pageWith(null);
    installStyleNonce(doc, 'N0nce');
    for (const tag of ['div', 'span', 'script', 'link', 'textarea']) {
      const el = doc.createElement(tag);
      expect(el.localName).toBe(tag);
      expect(nonceOf(el)).toBe('');
    }
  });

  it('passes its arguments on and returns the element the document made', () => {
    const doc = pageWith(null);
    const original = vi.spyOn(doc, 'createElement');
    installStyleNonce(doc, 'N0nce');
    const el = doc.createElement('span', { is: 'x-test' });
    expect(el.localName).toBe('span');
    // the wrapper replaced the spy on the instance; the spy saw the call the wrapper made
    expect(original).not.toHaveBeenCalledTimes(0);
    expect(original.mock.calls.at(-1)).toEqual(['span', { is: 'x-test' }]);
  });

  it('does nothing without a nonce: the method stays the one the document had', () => {
    const doc = pageWith(null);
    const before = read(doc, 'createElement');
    const uninstall = installStyleNonce(doc, null);
    expect(read(doc, 'createElement')).toBe(before);
    expect(nonceOf(doc.createElement('style'))).toBe('');
    expect(() => {
      uninstall();
    }).not.toThrow();
  });

  it('wraps once: a second call is the same installation', () => {
    const doc = pageWith(null);
    const first = installStyleNonce(doc, 'First');
    const wrapped = read(doc, 'createElement');
    const second = installStyleNonce(doc, 'Second');
    expect(read(doc, 'createElement')).toBe(wrapped);
    // the first nonce stays: the page has one nonce for its whole life
    expect(nonceOf(doc.createElement('style'))).toBe('First');
    expect(second).toBe(first);
  });

  it('removes itself and restores the document method', () => {
    const doc = pageWith(null);
    expect(Object.hasOwn(doc, 'createElement')).toBe(false);
    const uninstall = installStyleNonce(doc, 'N0nce');
    expect(Object.hasOwn(doc, 'createElement')).toBe(true);
    uninstall();
    expect(Object.hasOwn(doc, 'createElement')).toBe(false);
    expect(nonceOf(doc.createElement('style'))).toBe('');
    uninstall();
    expect(Object.hasOwn(doc, 'createElement')).toBe(false);
  });

  it('puts back an own method the document had before', () => {
    const doc = pageWith(null);
    const mine = vi.fn(() => document.createElement('style'));
    Object.defineProperty(doc, 'createElement', { value: mine, writable: true, configurable: true });
    const uninstall = installStyleNonce(doc, 'N0nce');
    expect(nonceOf(doc.createElement('style'))).toBe('N0nce');
    expect(mine).toHaveBeenCalledWith('style');
    uninstall();
    expect(read(doc, 'createElement')).toBe(mine);
  });

  it('does not undo a later wrapper of somebody else', () => {
    const doc = pageWith(null);
    const uninstall = installStyleNonce(doc, 'N0nce');
    const other = vi.fn();
    Object.defineProperty(doc, 'createElement', { value: other, writable: true, configurable: true });
    uninstall();
    expect(read(doc, 'createElement')).toBe(other);
  });

  it('can be installed again after it was removed, with the new nonce', () => {
    const doc = pageWith(null);
    installStyleNonce(doc, 'Old')();
    installStyleNonce(doc, 'New');
    expect(nonceOf(doc.createElement('style'))).toBe('New');
  });

  it('gives each document its own installation', () => {
    const a = pageWith(null);
    const b = pageWith(null);
    installStyleNonce(a, 'A');
    expect(nonceOf(b.createElement('style'))).toBe('');
    installStyleNonce(b, 'B');
    expect(nonceOf(a.createElement('style'))).toBe('A');
    expect(nonceOf(b.createElement('style'))).toBe('B');
  });
});

/** A prototype with a recording `setAttribute`, and elements whose `style` is a plain `cssText` holder. */
function fakeWorld(): {
  proto: StyleWriteTarget;
  original: ReturnType<typeof vi.fn>;
  element: () => { style: { cssText: string }; setAttribute: StyleWriteTarget['setAttribute'] };
} {
  const original = vi.fn();
  const proto: StyleWriteTarget = { setAttribute: original };
  return {
    proto,
    original,
    element: () => {
      const el = Object.create(proto) as { style: { cssText: string }; setAttribute: StyleWriteTarget['setAttribute'] };
      el.style = { cssText: '' };
      return el;
    },
  };
}

describe('installInlineColorAdapter', () => {
  const COLOURS = [
    'color:#0ac832;',
    'background-color:#0ac832;',
    'color:#0ac832;background-color:#112233;',
    'color:#abc;',
    'color:#0ac832ff;',
    'color:rgb(10, 200, 50);',
    'color: rgb(10, 200, 50);background-color:#112233;',
    'color:rgba(10,200,50,0.5);',
    'color:rgb(10 200 50 / 50%);',
    'background-color: rgba(10, 200, 50, 0.5)',
    'COLOR:#0AC832;',
  ];

  it.each(COLOURS)('writes %j through the CSSOM', (value) => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('style', value);
    expect(el.style.cssText).toBe(value);
    expect(original).not.toHaveBeenCalled();
  });

  it('matches the attribute name in any letter case', () => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('STYLE', 'color:#0ac832;');
    expect(el.style.cssText).toBe('color:#0ac832;');
    expect(original).not.toHaveBeenCalled();
  });

  it('replaces the whole style, as the attribute would', () => {
    const { proto, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('style', 'color:#111111;background-color:#222222;');
    el.setAttribute('style', 'color:#333333;');
    expect(el.style.cssText).toBe('color:#333333;');
  });

  it.each([
    ['a url', 'background-color:#000;background-image:url(https://example.invalid/x.png);'],
    ['a url in a colour slot', 'color:url(https://example.invalid/x);'],
    ['another property', 'position:fixed;'],
    ['a colour property and another one', 'color:#0ac832;position:fixed;'],
    ['a named colour', 'color:red;'],
    ['a function that is not a colour', 'color:expression(alert(1));'],
    ['a var()', 'color:var(--accent);'],
    ['an !important', 'color:#0ac832 !important;'],
    ['a comment', 'color:#0ac832;/* x */'],
    ['an empty value', ''],
    ['a brace', 'color:#0ac832;}body{color:red'],
    ['a hex of the wrong length', 'color:#0ac83;'],
    ['a hex with a letter past f', 'color:#0ac83g;'],
    ['text before the declaration', 'x color:#0ac832;'],
  ])('leaves %s to the browser', (_name, value) => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('style', value);
    expect(el.style.cssText).toBe('');
    expect(original).toHaveBeenCalledExactlyOnceWith('style', value);
  });

  it('leaves a very long value to the browser without testing it', () => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    const long = `color:#0ac832;${' '.repeat(5000)}`;
    el.setAttribute('style', long);
    expect(original).toHaveBeenCalledExactlyOnceWith('style', long);
  });

  it('writes a declaration list of spaces around every token through the CSSOM', () => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    const value = ' color : #0ac832 ; background-color : rgb( 10 , 200 , 50 ) ; ';
    el.setAttribute('style', value);
    expect(el.style.cssText).toBe(value);
    expect(original).not.toHaveBeenCalled();
  });

  it('writes a list that is just under the length cap through the CSSOM', () => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    const value = 'color:#fff;'.repeat(23);
    expect(value.length).toBeLessThanOrEqual(256);
    el.setAttribute('style', value);
    expect(el.style.cssText).toBe(value);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    ['two declarations without a semicolon between them', 'color:#fff  color:#fff'],
    ['two declarations glued together', 'color:#abccolor:#fff'],
    ['an empty declaration between two semicolons', 'color:#fff;;background-color:#000'],
    ['a lone semicolon', ';'],
    ['two trailing semicolons', 'color:#fff;;'],
    ['an rgb() with a missing component', 'color:rgb(10, 200);'],
    ['an rgb() with five components', 'color:rgb(1, 2, 3, 4, 5);'],
  ])('leaves %s to the browser', (_name, value) => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('style', value);
    expect(el.style.cssText).toBe('');
    expect(original).toHaveBeenCalledExactlyOnceWith('style', value);
  });

  // The shim sits on `Element.prototype.setAttribute` for the life of the page, so what one write costs must not depend on what a
  // page, a dependency or a terminal program makes of the value, and the length cap alone does not bound a backtracking pattern. An
  // earlier pattern repeated `\s*;?\s*` inside a `+` group: `'color:#fff  '.repeat(17) + '!'` (205 characters) took 2.75 s and each
  // repeat after that tripled the time. Every value below is under the cap and none is a colour list.
  describe('a crafted value under the length cap', () => {
    const BOUND_MS = 500;
    const CRAFTED: [string, string][] = [
      ['the 205-character repro of the exponential case', `${'color:#fff  '.repeat(17)}!`],
      ['the same with 21 repeats', `${'color:#fff  '.repeat(21)}!`],
      ['declarations with spaces on both sides of the semicolon', `${'color:#fff ; '.repeat(19)}!`],
      ['declarations with a semicolon and no space', `${'color:#fff;'.repeat(23)}!`],
      ['background colours with spaces around every token', `${'background-color : #fff ; '.repeat(9)}!`],
      ['only spaces and a stray character', `${' '.repeat(255)}!`],
      ['only semicolons', ';'.repeat(256)],
      ['a long run of hex digits', `color:#${'a'.repeat(240)}!`],
      ['an rgb() with spaces between its numbers', `color:rgb(${'1 '.repeat(120)})`],
      [
        'an rgb() with long runs of spaces around its separators',
        `color:rgb(1${' '.repeat(80)},${' '.repeat(80)}2${' '.repeat(40)}`,
      ],
      ['an rgb() with repeated separators', `color:rgb(1${', '.repeat(100)}!`],
      ['a name that never ends', `${'color'.repeat(50)}:#fff`],
    ];

    it.each(CRAFTED)('answers %s within the bound and leaves it to the browser', (_name, value) => {
      expect(value.length).toBeLessThanOrEqual(256);
      const { proto, original, element } = fakeWorld();
      installInlineColorAdapter(proto);
      const el = element();
      const started = performance.now();
      el.setAttribute('style', value);
      const elapsed = performance.now() - started;
      expect(original).toHaveBeenCalledExactlyOnceWith('style', value);
      expect(el.style.cssText).toBe('');
      expect(elapsed).toBeLessThan(BOUND_MS);
    });
  });

  it('leaves every other attribute to the browser', () => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('class', 'xterm-bold');
    el.setAttribute('color', '#0ac832');
    el.setAttribute('data-style', 'color:#0ac832;');
    expect(original.mock.calls).toEqual([
      ['class', 'xterm-bold'],
      ['color', '#0ac832'],
      ['data-style', 'color:#0ac832;'],
    ]);
    expect(el.style.cssText).toBe('');
  });

  it('leaves the write to the browser when the element has no style declaration to write', () => {
    const { proto, original } = fakeWorld();
    installInlineColorAdapter(proto);
    const bare = Object.create(proto) as { setAttribute: StyleWriteTarget['setAttribute'] };
    bare.setAttribute('style', 'color:#0ac832;');
    expect(original).toHaveBeenCalledExactlyOnceWith('style', 'color:#0ac832;');
    const odd = Object.create(proto) as { style: unknown; setAttribute: StyleWriteTarget['setAttribute'] };
    odd.style = { cssText: 5 };
    odd.setAttribute('style', 'color:#0ac832;');
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('does not recurse when the CSSOM write reflects into the attribute through setAttribute (happy-dom does)', () => {
    const { proto, original } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = Object.create(proto) as { style: { cssText: string }; setAttribute: StyleWriteTarget['setAttribute'] };
    let held = '';
    el.style = {
      get cssText() {
        return held;
      },
      set cssText(value: string) {
        held = value;
        el.setAttribute('style', value);
      },
    };
    el.setAttribute('style', 'color:#0ac832;');
    expect(held).toBe('color:#0ac832;');
    expect(original).toHaveBeenCalledExactlyOnceWith('style', 'color:#0ac832;');
    // and the guard is released afterwards
    el.setAttribute('style', 'background-color:#112233;');
    expect(held).toBe('background-color:#112233;');
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('keeps `this` for the browser method', () => {
    const { proto, original, element } = fakeWorld();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('id', 'x');
    expect(original.mock.contexts[0]).toBe(el);
  });

  it('is one installation: a second call changes nothing and returns the same remover', () => {
    const { proto, original, element } = fakeWorld();
    const first = installInlineColorAdapter(proto);
    const wrapped = proto.setAttribute;
    const second = installInlineColorAdapter(proto);
    expect(proto.setAttribute).toBe(wrapped);
    expect(second).toBe(first);
    element().setAttribute('id', 'x');
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('puts the browser method back and ignores a second removal', () => {
    const { proto, original, element } = fakeWorld();
    const uninstall = installInlineColorAdapter(proto);
    expect(proto.setAttribute).not.toBe(original);
    uninstall();
    expect(proto.setAttribute).toBe(original);
    uninstall();
    expect(proto.setAttribute).toBe(original);
    const el = element();
    el.setAttribute('style', 'color:#0ac832;');
    expect(original).toHaveBeenCalledExactlyOnceWith('style', 'color:#0ac832;');
  });

  it('does not undo a later wrapper of somebody else', () => {
    const { proto } = fakeWorld();
    const uninstall = installInlineColorAdapter(proto);
    const other = vi.fn();
    proto.setAttribute = other;
    uninstall();
    expect(proto.setAttribute).toBe(other);
  });

  it('can be installed again after it was removed', () => {
    const { proto, element } = fakeWorld();
    installInlineColorAdapter(proto)();
    installInlineColorAdapter(proto);
    const el = element();
    el.setAttribute('style', 'color:#0ac832;');
    expect(el.style.cssText).toBe('color:#0ac832;');
  });

  it('works on the real Element prototype: colours land in the style of a real element, other writes still reach the attribute', () => {
    const uninstall = installInlineColorAdapter();
    try {
      const span = document.createElement('span');
      span.setAttribute('style', 'color:#0ac832;background-color:#112233;');
      expect(span.style.color).not.toBe('');
      expect(span.style.backgroundColor).not.toBe('');
      span.setAttribute('class', 'a b');
      expect(span.className).toBe('a b');
      const other = document.createElement('span');
      other.setAttribute('style', 'position:absolute;');
      expect(other.style.position).toBe('absolute');
    } finally {
      uninstall();
    }
  });
});
