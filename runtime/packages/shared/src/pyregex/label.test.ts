import { describe, expect, it } from 'vitest';

import { compilePyRegex } from './compile.ts';
import { applyLabelTemplate } from './label.ts';

function label(pattern: string, text: string, template: string): string {
  const m = compilePyRegex(pattern, 'session_rule').exec(text);
  if (m === null) throw new Error('no match');
  return applyLabelTemplate(template, m);
}

describe('applyLabelTemplate (legacy sessions.py)', () => {
  it('substitutes numbered groups and {0}', () => {
    expect(label('step=([A-Z0-9]+)', 'run STEP=1 step=AB12 now', 'build step {1}')).toBe('build step AB12');
    expect(label('(a)(b)', 'ab', '{2}{1}{2}')).toBe('bab');
    expect(label('b+', 'abbbc', 'got {0}')).toBe('got bbb');
  });

  it('turns an unmatched group into the empty string', () => {
    expect(label('(a)|(b)', 'b', '[{1}][{2}]')).toBe('[][b]');
  });

  it('leaves unknown placeholders and plain text alone', () => {
    expect(label('(a)', 'a', 'no placeholders')).toBe('no placeholders');
    expect(label('(a)', 'a', '{1} {2} {x} {}')).toBe('a {2} {x} {}');
  });

  it('cuts {0} after 40 code points, counting astral characters once', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(label('.+', emoji.repeat(50), '{0}')).toBe(emoji.repeat(40));
    expect(label('.+', 'x'.repeat(60), '{0}')).toBe('x'.repeat(40));
  });

  it('substitutes sequentially, so text from group 1 is substituted again', () => {
    expect(label('(\\{2\\})(b)', '{2}b', '{1}/{2}')).toBe('b/b');
    expect(label('(.)', 'z', '{1}')).toBe('z');
  });

  it('substitutes {0} last, even inside text that came from a group', () => {
    expect(label('(\\{0\\})ab', '{0}ab', '{1}|')).toBe('{0}ab|');
  });

  it('replaces every occurrence and never treats $ specially', () => {
    expect(label('(a)', 'a', '{1}{1}')).toBe('aa');
    expect(label('(\\$&)', '$&', '{1}')).toBe('$&');
  });
});
