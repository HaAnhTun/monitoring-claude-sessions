import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown.tsx';

const ALLOWED_TAGS = new Set(['DIV', 'P', 'PRE', 'CODE', 'SPAN', 'BUTTON']);
const ALLOWED_ATTRIBUTES = /^(class|type|aria-.+)$/;

/** Every element of the rendered markdown is one of the six tags and carries no event, URL or style attribute. */
function expectOnlyInertElements(container: HTMLElement): void {
  for (const el of Array.from(container.querySelectorAll('*'))) {
    expect(ALLOWED_TAGS.has(el.tagName), `unexpected <${el.tagName.toLowerCase()}>`).toBe(true);
    for (const attr of Array.from(el.attributes)) {
      expect(ALLOWED_ATTRIBUTES.test(attr.name), `unexpected attribute ${attr.name}`).toBe(true);
      expect(attr.name.startsWith('on')).toBe(false);
    }
  }
}

describe('Markdown', () => {
  it('renders paragraphs and inline code', () => {
    const { container } = render(<Markdown text={'first line\nsecond `code` here\n\nnext paragraph'} />);
    const paragraphs = container.querySelectorAll('p.md-p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe('first line\nsecond code here');
    expect(container.querySelector('code.md-inline')?.textContent).toBe('code');
  });

  it('renders a fenced block with a language label of at most 24 characters', () => {
    const { container } = render(
      <Markdown text={'```typescript-with-a-very-long-language-name extra\nconst a = 1;\n```'} />,
    );
    expect(container.querySelector('.md-lang')?.textContent).toBe('typescript-with-a-very-l');
    expect(container.querySelector('.md-code pre code')?.textContent).toBe('const a = 1;');
  });

  it('supports tilde fences and renders nothing for empty text', () => {
    const { container } = render(<Markdown text={'~~~\nraw\n~~~'} />);
    expect(container.querySelector('.md-code pre code')?.textContent).toBe('raw');
    const empty = render(<Markdown text="" />);
    expect(empty.container.childNodes).toHaveLength(0);
  });

  it('keeps links, emphasis, headings, lists and images as plain text', () => {
    const text = '# title\n\n- item **bold** _em_\n\n![alt](http://example.invalid/x.png) [x](http://example.invalid)';
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector('a, img, h1, ul, li, strong, em')).toBeNull();
    expect(container.textContent).toContain('[x](http://example.invalid)');
    expect(container.textContent).toContain('**bold**');
  });

  describe('hostile input (04 section 8)', () => {
    const HOSTILE = [
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
      '[x](javascript:alert(1))',
      '```"><svg onload=alert(1)>\n<iframe src="data:text/html,<script>1</script>"></iframe>\n```',
      '&lt;b&gt;bold&lt;/b&gt; &amp; <b>real</b>',
      '`<a href="javascript:alert(1)">x</a>`',
      'text <style>*{display:none}</style> <a href=//evil.invalid>link</a>',
    ];

    it.each(HOSTILE)('renders %j as literal text with inert elements only', (input) => {
      const { container } = render(<Markdown text={input} />);
      expectOnlyInertElements(container);
      expect(container.querySelector('script, img, svg, iframe, a, style')).toBeNull();
      const fenced = input.startsWith('```');
      const shown = container.textContent;
      if (fenced) {
        // the first token after the fence is the language label, shown as text
        expect(container.querySelector('.md-lang')?.textContent).toBe('"><svg');
        expect(shown).toContain('<iframe src="data:text/html,<script>1</script>"></iframe>');
      } else {
        // backticks of inline code are syntax, everything else must appear as typed
        expect(shown).toBe(input.replaceAll('`', ''));
      }
    });

    it('does not decode HTML entities', () => {
      const { container } = render(<Markdown text={'&lt;b&gt;'} />);
      expect(container.querySelector('p')?.textContent).toBe('&lt;b&gt;');
    });

    it('shows bidi control characters as text of the same paragraph without wrapping markup', () => {
      const input = ['a', 0x202e, 'b', 0x2066, 'c', 0x2069, 'd']
        .map((p) => (typeof p === 'string' ? p : String.fromCodePoint(p)))
        .join('');
      const { container } = render(<Markdown text={input} />);
      expectOnlyInertElements(container);
      expect(container.textContent).toBe(input);
    });

    it('survives a giant line and a giant code block without a crash', () => {
      const line = 'x'.repeat(1_000_000);
      const { container } = render(<Markdown text={`${line}\n\n\`\`\`\n${line}\n\`\`\``} />);
      expect(container.querySelectorAll('p.md-p')).toHaveLength(1);
      // the code block is cut at 200,000 characters and says so
      expect((container.querySelector('.md-code code')?.textContent ?? '').length).toBe(200_000);
      expect(container.querySelector('.md-code')?.textContent).toContain(
        'Text too long to show here (1000000 characters)',
      );
    });
  });

  describe('long code blocks', () => {
    const lines = Array.from({ length: 450 }, (_unused, n) => `line ${String(n + 1)}`);
    const text = `\`\`\`\n${lines.join('\n')}\n\`\`\``;

    it('shows the first 200 lines of a block over 400 lines and expands on request', async () => {
      const user = userEvent.setup();
      const { container } = render(<Markdown text={text} />);
      const code = (): string => container.querySelector('.md-code code')?.textContent ?? '';
      expect(code().split('\n')).toHaveLength(200);
      const button = screen.getByRole('button', { name: 'Show all 450 lines' });
      expect(button).not.toHaveAttribute('aria-expanded');
      await user.click(button);
      expect(code().split('\n')).toHaveLength(450);
      expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    });

    it('shows a block of exactly 400 lines in full', () => {
      const exact = `\`\`\`\n${lines.slice(0, 400).join('\n')}\n\`\`\``;
      const { container } = render(<Markdown text={exact} />);
      expect((container.querySelector('.md-code code')?.textContent ?? '').split('\n')).toHaveLength(400);
      expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    });
  });

  it('gives each code block a Copy code button', () => {
    render(<Markdown text={'```\na\n```'} />);
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });
});
