import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makeUsage } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { TokenFigures } from './TokenFigures.tsx';

const USAGE = makeUsage({ input: 1000, cacheCreation: 500, output: 2500, cacheRead: 3_000_000 });

describe('TokenFigures: the vocabulary (ADR 0074 decision 5)', () => {
  it('names the three figures Output, Input (new) and Cache read, with Input (new) = input + cache write', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="tiles" />);
    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    expect(terms).toEqual([msg('tokens.output'), msg('tokens.inputNew'), msg('tokens.cacheRead')]);
    expect(msg('tokens.output')).toBe('Output');
    expect(msg('tokens.inputNew')).toBe('Input (new)');
    expect(msg('tokens.cacheRead')).toBe('Cache read');
    const values = screen.getAllByRole('definition').map((value) => value.textContent);
    expect(values[0]).toContain('2.5K');
    expect(values[1]).toContain('1.5K');
    expect(values[2]).toContain('3M');
  });

  it('puts the exact value in the title of every figure', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="tiles" />);
    const figures = screen.getAllByRole('definition');
    expect(figures[0]?.querySelector('[title]')).toHaveAttribute('title', expect.stringContaining('2,500'));
    expect(figures[1]?.querySelector('[title]')).toHaveAttribute('title', expect.stringContaining('1,500'));
    expect(figures[2]?.querySelector('[title]')).toHaveAttribute('title', expect.stringContaining('3,000,000'));
  });

  it('shows the sum of Input (new) in its title: input plus cache write', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="tiles" />);
    const title = screen.getAllByRole('definition')[1]?.querySelector('[title]')?.getAttribute('title') ?? '';
    expect(title).toContain(msg('tokens.inputNewTip', { input: '1,000', cacheWrite: '500', sum: '1,500' }));
  });

  it('shows the three figures of a line in order, with a separator and the subagent note when asked', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="line" includesSubagents />);
    const line = screen.getByText(msg('tokens.output')).closest('.token-figures');
    expect(line).not.toBeNull();
    const text = line?.textContent ?? '';
    expect(text.indexOf(msg('tokens.output'))).toBeLessThan(text.indexOf(msg('tokens.inputNew')));
    expect(text.indexOf(msg('tokens.inputNew'))).toBeLessThan(text.indexOf(msg('tokens.cacheRead')));
    expect(screen.getByText(msg('tokens.inclSubagents'))).toBeInTheDocument();
  });

  it('has no subagent note by default', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="line" />);
    expect(screen.queryByText(msg('tokens.inclSubagents'))).toBeNull();
  });
});

describe('TokenFigures: a missing number is never 0 (UI-I9)', () => {
  it('says "not available" for the figures of null usage, in every variant', () => {
    for (const variant of ['cell', 'tiles', 'line'] as const) {
      const { unmount, container } = renderWithIntl(<TokenFigures usage={null} variant={variant} />);
      expect(screen.getAllByText(msg('tokens.notAvailable')).length, variant).toBeGreaterThan(0);
      expect(container.textContent, variant).not.toMatch(/\b0\b/);
      unmount();
    }
  });

  it('says "not available" for usage whose completeness is unavailable', () => {
    renderWithIntl(
      <TokenFigures
        usage={makeUsage({ completeness: 'unavailable', output: null, input: null, total: null })}
        variant="line"
      />,
    );
    expect(screen.getAllByText(msg('tokens.notAvailable')).length).toBeGreaterThan(0);
    expect(screen.queryByText(msg('tokens.lowerBound'))).toBeNull();
  });

  it('shows n/a for one unknown member and a real number for the others', () => {
    renderWithIntl(
      <TokenFigures usage={makeUsage({ output: null, input: 1000, cacheCreation: 0, cacheRead: 0 })} variant="tiles" />,
    );
    const values = screen.getAllByRole('definition');
    expect(values[0]).toHaveTextContent(msg('tokens.na'));
    expect(within(values[0]!).getByText(msg('tokens.notAvailable'))).toHaveClass('sr-only');
    expect(values[1]).toHaveTextContent('1K');
    expect(values[2]).toHaveTextContent('0');
  });

  it('makes Input (new) unknown when input or cache write is unknown', () => {
    renderWithIntl(<TokenFigures usage={makeUsage({ input: 1000, cacheCreation: null })} variant="tiles" />);
    expect(screen.getAllByRole('definition')[1]).toHaveTextContent(msg('tokens.na'));
  });

  it('keeps a real zero as 0', () => {
    renderWithIntl(
      <TokenFigures
        usage={makeUsage({ output: 0, input: 0, cacheCreation: 0, cacheRead: 0, total: 0 })}
        variant="tiles"
      />,
    );
    for (const value of screen.getAllByRole('definition')) expect(value).toHaveTextContent('0');
    expect(screen.queryByText(msg('tokens.notAvailable'))).toBeNull();
  });
});

describe('TokenFigures: the lower-bound tag', () => {
  it('tags partial usage and explains the scan in the tooltip', () => {
    renderWithIntl(<TokenFigures usage={makeUsage({ completeness: 'partial', scannedPct: 40 })} variant="line" />);
    const tag = screen.getByText(msg('tokens.lowerBound'));
    expect(tag.closest('[title]')).toHaveAttribute('title', msg('tokens.lowerBoundScan', { pct: '40%' }));
  });

  it('tags usage that is marked as a lower bound, and says so when the scan share is unknown', () => {
    renderWithIntl(<TokenFigures usage={makeUsage({ lowerBound: true, scannedPct: null })} variant="tiles" />);
    expect(screen.getByText(msg('tokens.lowerBound')).closest('[title]')).toHaveAttribute(
      'title',
      msg('tokens.lowerBoundUnknown'),
    );
  });

  it('has no tag for complete usage', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="line" />);
    expect(screen.queryByText(msg('tokens.lowerBound'))).toBeNull();
  });
});

describe('TokenFigures: the cell variant (one figure of a table row)', () => {
  it('shows one compact number with the exact value in its title', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="cell" figure="output" />);
    const cell = screen.getByText('2.5K');
    expect(cell.closest('[title]')).toHaveAttribute('title', expect.stringContaining('2,500'));
    expect(screen.queryByText(msg('tokens.output'))).toBeNull();
  });

  it('shows Input (new) and Cache read on request', () => {
    const { unmount } = renderWithIntl(<TokenFigures usage={USAGE} variant="cell" figure="inputNew" />);
    expect(screen.getByText('1.5K')).toBeInTheDocument();
    unmount();
    renderWithIntl(<TokenFigures usage={USAGE} variant="cell" figure="cacheRead" />);
    expect(screen.getByText('3M')).toBeInTheDocument();
  });

  it('marks a lower bound with a plus sign that a screen reader hears as text', () => {
    renderWithIntl(
      <TokenFigures usage={makeUsage({ completeness: 'partial', scannedPct: 40 })} variant="cell" figure="output" />,
    );
    expect(screen.getByText('+')).toBeInTheDocument();
    expect(screen.getByText(msg('tokens.lowerBound'))).toHaveClass('sr-only');
  });

  it('is plain text: no button inside a table row, where a popover would be clipped', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="cell" figure="inputNew" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TokenFigures: the cache breakdown popover', () => {
  it('opens from the keyboard and lists input, cache write, cache read and the sum', async () => {
    const user = userEvent.setup();
    renderWithIntl(<TokenFigures usage={USAGE} variant="line" />);
    const trigger = screen.getByRole('button', { name: msg('tokens.breakdown') });
    trigger.focus();
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('dialog', { name: msg('tokens.breakdown') });
    const terms = within(panel)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms).toEqual([
      msg('tokens.input'),
      msg('tokens.cacheWrite'),
      msg('tokens.inputNew'),
      msg('tokens.cacheRead'),
    ]);
    expect(panel).toHaveTextContent('1,000');
    expect(panel).toHaveTextContent('500');
    expect(panel).toHaveTextContent('1,500');
    expect(panel).toHaveTextContent('3,000,000');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('is offered by the tiles too, but not when there are no numbers', () => {
    const { unmount } = renderWithIntl(<TokenFigures usage={USAGE} variant="tiles" />);
    expect(screen.getByRole('button', { name: msg('tokens.breakdown') })).toBeInTheDocument();
    unmount();
    renderWithIntl(<TokenFigures usage={null} variant="tiles" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TokenFigures: the language', () => {
  it('formats the numbers and says the words in Vietnamese', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="tiles" />, { locale: 'vi' });
    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    expect(terms).toEqual([
      msg('tokens.output', undefined, 'vi'),
      msg('tokens.inputNew', undefined, 'vi'),
      msg('tokens.cacheRead', undefined, 'vi'),
    ]);
    expect(terms[0]).not.toBe('Output');
    const exact = screen.getAllByRole('definition')[2]?.querySelector('[title]')?.getAttribute('title') ?? '';
    expect(exact).toContain('3.000.000');
  });

  it('writes the cell number in the compact form of the language', () => {
    renderWithIntl(<TokenFigures usage={USAGE} variant="cell" figure="cacheRead" />, { locale: 'vi' });
    expect(screen.getByText(/^3\s?Tr$/)).toBeInTheDocument();
  });
});
