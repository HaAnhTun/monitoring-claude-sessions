import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, renderMarkdown } from '../../src/frontend/modules/markdown.js';

// Minimal fake DOM that records everything the renderer does and refuses HTML parsing.
function fakeDoc() {
  const created = [];
  class FakeNode {
    constructor(tag) { this.tag = tag; this.children = []; this._text = ''; this.className = ''; created.push(this); }
    appendChild(c) { this.children.push(c); return c; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(_v) { throw new Error('innerHTML must never be used'); }
    set outerHTML(_v) { throw new Error('outerHTML must never be used'); }
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML must never be used'); }
  }
  return {
    created,
    createElement: (t) => new FakeNode(t),
    createDocumentFragment: () => new FakeNode('#fragment'),
    createTextNode: (s) => { const n = new FakeNode('#text'); n._text = String(s); return n; },
  };
}

const ALLOWED_TAGS = new Set(['#fragment', '#text', 'div', 'p', 'pre', 'code', 'span']);

test('parse: fences, inline code, paragraphs', () => {
  const b = parseMarkdown('Hello `x` world\n\n```js\nconst a = 1;\n```\ntail');
  assert.deepEqual(b.map((x) => x.type), ['p', 'code', 'p']);
  assert.equal(b[1].lang, 'js');
  assert.equal(b[1].text, 'const a = 1;');
  assert.deepEqual(b[0].inline.map((p) => [p.type, p.text]), [['text', 'Hello '], ['code', 'x'], ['text', ' world']]);
});

test('parse: unterminated fence runs to the end; ~~~ fences; empty input', () => {
  const b = parseMarkdown('```\nline1\nline2');
  assert.deepEqual(b, [{ type: 'code', lang: '', text: 'line1\nline2' }]);
  assert.equal(parseMarkdown('~~~py\nx\n~~~')[0].lang, 'py');
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(null), []);
});

test('hostile input never produces HTML: only whitelisted tags, markup stays literal text', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '```\n<script>alert(2)</script>\n```',
    'inline `<iframe src=javascript:alert(3)>` code',
    '```"><svg onload=alert(4)>\n</svg>\n```',
    '[x](javascript:alert(5)) **bold** <b>b</b>',
  ].join('\n\n');
  const doc = fakeDoc();
  const frag = renderMarkdown(hostile, doc);
  for (const n of doc.created) assert.ok(ALLOWED_TAGS.has(n.tag), `unexpected element <${n.tag}>`);
  const all = frag.textContent;
  assert.ok(all.includes('<img src=x onerror=alert(1)>'));
  assert.ok(all.includes('<script>alert(1)</script>'));
  assert.ok(all.includes('<script>alert(2)</script>'));
  assert.ok(all.includes('<iframe src=javascript:alert(3)>'));
  // attributes are never set from data (the fake node has no setAttribute at all)
  assert.ok(doc.created.every((n) => n.setAttribute === undefined));
});

test('language label comes from text, never from an attribute', () => {
  const doc = fakeDoc();
  renderMarkdown('```"><img onerror=x>\ncode\n```', doc);
  const spans = doc.created.filter((n) => n.tag === 'span');
  assert.equal(spans.length, 1);
  assert.ok(spans[0].textContent.length <= 24);
});

test('source audit: no HTML-injection APIs anywhere in the frontend code', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/frontend');
  const files = [path.join(root, 'app.js'), ...fs.readdirSync(path.join(root, 'modules')).map((f) => path.join(root, 'modules', f))].filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 10);
  const banned = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/, /srcdoc/];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of banned) assert.doesNotMatch(src, re, `${path.basename(f)} matches ${re}`);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<title>__TITLE__<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/static\/styles\.css">/);
  assert.match(html, /<script type="module" src="\/static\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\//); // nothing loaded from the network
});
