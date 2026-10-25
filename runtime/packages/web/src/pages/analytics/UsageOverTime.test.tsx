import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makeSeriesPoint, makeUsageSeries } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { UsageOverTime } from './UsageOverTime.tsx';

const day = (n: number): string => new Date(Date.UTC(2026, 2, n, 12)).toISOString();

// Seven days, the 11th was omitted by the server and the 12th is a lower bound.
const SERIES = makeUsageSeries({
  bucket: 'day',
  window: { from: day(8), to: day(14) },
  points: [
    makeSeriesPoint({ start: day(9), output: 400, input: 1000 }),
    makeSeriesPoint({ start: day(10), output: 41_000, input: 2000 }),
    makeSeriesPoint({ start: day(12), output: 900, input: 3000, completeness: 'partial' }),
  ],
});

function chart(container: HTMLElement, metric: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-metric="${metric}"]`);
  if (found === null) throw new Error(`no chart for ${metric}`);
  return found;
}

describe('UsageOverTime', () => {
  it('draws four charts, one per token category, with a bar target for each bucket that has data and none for a gap', () => {
    const { container } = renderWithIntl(<UsageOverTime series={SERIES} />);
    expect(container.querySelectorAll('.chart')).toHaveLength(4);
    for (const metric of ['output', 'input', 'cacheCreation', 'cacheRead']) {
      expect(chart(container, metric).querySelectorAll('.chart__hit')).toHaveLength(3);
    }
    // 3 buckets with data on a 7-slot axis: the 8th and the 11th to 14th are blank, so no 7-bar chart
    expect(chart(container, 'output').querySelectorAll('.chart__bar')).toHaveLength(3);
  });

  it('never draws a bar for a gap, and a bucket with value 0 gets a target but no bar', () => {
    const series = makeUsageSeries({
      window: { from: day(9), to: day(11) },
      points: [
        makeSeriesPoint({ start: day(9), cacheCreation: 0 }),
        makeSeriesPoint({ start: day(11), cacheCreation: 7 }),
      ],
    });
    const { container } = renderWithIntl(<UsageOverTime series={series} />);
    const created = chart(container, 'cacheCreation');
    expect(created.querySelectorAll('.chart__hit')).toHaveLength(2);
    expect(created.querySelectorAll('.chart__bar')).toHaveLength(1);
  });

  it('hatches a partial bucket and explains the hatch in a legend', () => {
    const { container } = renderWithIntl(<UsageOverTime series={SERIES} />);
    const partial = chart(container, 'output').querySelectorAll('.chart__bar--partial');
    expect(partial).toHaveLength(1);
    expect(partial[0]?.getAttribute('style')).toMatch(/url\(#hatch-/);
    expect(screen.getByText(msg('analytics.trend.partialLegend'))).toBeInTheDocument();
  });

  it('has no legend when every bucket is complete', () => {
    const series = makeUsageSeries({ points: [makeSeriesPoint()] });
    renderWithIntl(<UsageOverTime series={series} />);
    expect(screen.queryByText(msg('analytics.trend.partialLegend'))).toBeNull();
  });

  it('gives the picture an accessible summary and every bar a text alternative', () => {
    const { container } = renderWithIntl(<UsageOverTime series={SERIES} />);
    const output = chart(container, 'output');
    const summary = within(output).getAllByRole('img')[0];
    expect(summary?.getAttribute('aria-label')).toMatch(/Output over time/);
    expect(summary?.getAttribute('aria-label')).toContain('41,000');
    const bars = Array.from(output.querySelectorAll('.chart__hit'));
    expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/Output 400$/),
      expect.stringMatching(/Output 41,000$/),
      expect.stringMatching(/Output 900 \(lower bound\)$/),
    ]);
  });

  it('shows the tooltip of a bar when it gets keyboard focus, and moves with the arrow keys', async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<UsageOverTime series={SERIES} />);
    const bars = chart(container, 'output').querySelectorAll<SVGRectElement>('.chart__hit');
    expect(chart(container, 'output').querySelector('.chart__tip')).toBeNull();
    // one tab stop per chart: the first bar
    expect(bars[0]?.getAttribute('tabindex')).toBe('0');
    expect(bars[1]?.getAttribute('tabindex')).toBe('-1');
    act(() => {
      bars[0]?.focus();
    });
    expect(chart(container, 'output').querySelector('.chart__tip')?.textContent).toContain('Output 400');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(bars[1]);
    expect(chart(container, 'output').querySelector('.chart__tip')?.textContent).toContain('Output 41,000');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(bars[2]);
    expect(chart(container, 'output').querySelector('.chart__tip')?.textContent).toContain(msg('tokens.lowerBound'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(bars[0]);
  });

  it('formats the axis labels in the language shown', () => {
    const labels = (locale: 'en' | 'vi'): string[] => {
      const { container, unmount } = renderWithIntl(<UsageOverTime series={SERIES} />, { locale });
      const found = Array.from(chart(container, 'output').querySelectorAll('.chart__tick')).map(
        (tick) => tick.textContent,
      );
      unmount();
      return found;
    };
    const en = labels('en');
    const vi = labels('vi');
    const expected = (locale: string): string[] =>
      [Date.parse(day(8)), Date.parse(day(11)), Date.parse(day(14))].map((ms) =>
        new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(ms),
      );
    expect(en).toEqual(expected('en'));
    expect(vi).toEqual(expected('vi'));
    expect(vi).not.toEqual(en);
  });

  it('swaps the charts for a table of the same numbers and back', async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<UsageOverTime series={SERIES} />);
    const toggle = screen.getByRole('button', { name: msg('analytics.trend.showTable') });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(container.querySelector('.chart')).toBeNull();
    const table = screen.getByRole('table', { name: msg('analytics.trend.tableCaptionDay') });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('41,000')).toBeInTheDocument();
    expect(within(table).getByText(msg('tokens.lowerBound'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('analytics.trend.showChart') }));
    expect(container.querySelectorAll('.chart')).toHaveLength(4);
  });

  it('says so when there is nothing to draw', () => {
    renderWithIntl(<UsageOverTime series={makeUsageSeries({ points: [] })} />);
    expect(screen.getByText(msg('analytics.trend.noData'))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
