// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './markdown.ts';

describe('markdown parser', () => {
  it('legacy: parse: fences, inline code, paragraphs', () => {
    const b = parseMarkdown('Hello `x` world\n\n```js\nconst a = 1;\n```\ntail');
    expect(b.map((x) => x.type)).toEqual(['p', 'code', 'p']);
    const code = b[1];
    expect(code?.type === 'code' && code.lang).toBe('js');
    expect(code?.type === 'code' && code.text).toBe('const a = 1;');
    const para = b[0];
    expect(para?.type === 'p' && para.inline.map((p) => [p.type, p.text])).toEqual([
      ['text', 'Hello '],
      ['code', 'x'],
      ['text', ' world'],
    ]);
  });

  it('legacy: parse: unterminated fence runs to the end; ~~~ fences; empty input', () => {
    expect(parseMarkdown('```\nline1\nline2')).toEqual([{ type: 'code', lang: '', text: 'line1\nline2' }]);
    const tilde = parseMarkdown('~~~py\nx\n~~~')[0];
    expect(tilde?.type === 'code' && tilde.lang).toBe('py');
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown(undefined)).toEqual([]);
  });

  it('a closing fence needs the same character and at least the opening length', () => {
    const blocks = parseMarkdown('````\n```\nstill code\n````\nafter');
    expect(blocks).toEqual([
      { type: 'code', lang: '', text: '```\nstill code' },
      { type: 'p', inline: [{ type: 'text', text: 'after' }] },
    ]);
    const mixed = parseMarkdown('```\na\n~~~\nb\n```');
    expect(mixed).toEqual([{ type: 'code', lang: '', text: 'a\n~~~\nb' }]);
  });

  it('language label is the first word of the info string, capped at 24 characters', () => {
    const long = parseMarkdown('```averyveryverylonglanguagenamethatkeepsgoing extra\nx\n```')[0];
    expect(long?.type === 'code' && long.lang).toBe('averyveryverylonglanguag');
    expect(long?.type === 'code' && long.lang.length).toBeLessThanOrEqual(24);
    const hostile = parseMarkdown('```"><img onerror=x>\ncode\n```')[0];
    expect(hostile?.type === 'code' && hostile.lang).toBe('"><img');
  });

  it('normalises CRLF and CR line endings and keeps markup as literal text', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>\r\n\r\n<b>b</b>\r[x](javascript:alert(5))');
    expect(blocks).toEqual([
      { type: 'p', inline: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
      { type: 'p', inline: [{ type: 'text', text: '<b>b</b>\n[x](javascript:alert(5))' }] },
    ]);
  });

  it('parseInline splits inline code spans and ignores unbalanced backticks', () => {
    expect(parseInline('a `b` c `d`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'b' },
      { type: 'text', text: ' c ' },
      { type: 'code', text: 'd' },
    ]);
    expect(parseInline('no `closing')).toEqual([{ type: 'text', text: 'no `closing' }]);
    expect(parseInline('')).toEqual([]);
    expect(parseInline('`<iframe src=javascript:alert(3)>`')).toEqual([
      { type: 'code', text: '<iframe src=javascript:alert(3)>' },
    ]);
  });
});
