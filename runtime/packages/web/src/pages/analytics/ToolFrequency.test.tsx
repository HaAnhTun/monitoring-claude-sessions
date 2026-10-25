import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeToolFrequencyReport, makeToolFrequencyRow } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { ToolFrequency } from './ToolFrequency.tsx';

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

const REPORT = makeToolFrequencyReport({
  items: [
    makeToolFrequencyRow({
      toolName: 'Bash',
      calls: 120,
      failed: 16,
      failurePct: 13.3,
      medianDurationMs: 120,
      maxDurationMs: 4300,
    }),
    makeToolFrequencyRow({
      toolName: 'Read',
      calls: 60,
      failed: 0,
      failurePct: 0,
      medianDurationMs: 1500,
      maxDurationMs: 90_000,
    }),
    makeToolFrequencyRow({
      toolName: 'search',
      mcpServer: 'FIXTURE-server',
      calls: 3,
      failed: 0,
      failurePct: null,
      medianDurationMs: null,
      maxDurationMs: null,
    }),
  ],
});

describe('ToolFrequency', () => {
  it('lists each tool with its calls, failures and failure rate', () => {
    renderWithIntl(<ToolFrequency report={REPORT} />);
    expect(screen.getByRole('table', { name: msg('analytics.tools.caption') })).toBeInTheDocument();
    const bash = within(rowOf('Bash'));
    expect(bash.getByText('120')).toBeInTheDocument();
    expect(bash.getByText('16')).toHaveClass('usage-failed');
    expect(bash.getByText('13.3%')).toBeInTheDocument();
    expect(within(rowOf('Read')).getByText('0%')).toBeInTheDocument();
  });

  it('names the MCP server of a tool', () => {
    renderWithIntl(<ToolFrequency report={REPORT} />);
    expect(
      within(rowOf('search')).getByText(msg('analytics.tools.mcp', { server: 'FIXTURE-server' })),
    ).toBeInTheDocument();
  });

  it('writes a rate or duration the monitor does not have as not available, never as 0', () => {
    renderWithIntl(<ToolFrequency report={REPORT} />);
    const cells = within(rowOf('search')).getAllByRole('cell');
    // the narrow columns (priority 3) are hidden in the test window; the failure rate and the median stay
    for (const cell of cells.slice(-2)) {
      expect(cell.textContent).toContain(msg('tokens.na'));
      expect(within(cell).getByText(msg('tokens.notAvailable'))).toHaveClass('sr-only');
      expect(cell.textContent).not.toMatch(/\b0\b/);
    }
  });

  it('formats durations for the language shown', () => {
    renderWithIntl(<ToolFrequency report={REPORT} />);
    expect(within(rowOf('Bash')).getByText(/120\s?ms/)).toBeInTheDocument();
    expect(within(rowOf('Read')).getByText(/1\.5\s?s/)).toBeInTheDocument();
  });

  it('draws the calls bar from the share of the busiest tool', () => {
    const { container } = renderWithIntl(<ToolFrequency report={REPORT} />);
    const widths = Array.from(container.querySelectorAll<HTMLElement>('.mag__fill')).map(
      (fill) => fill.style.inlineSize,
    );
    expect(widths).toEqual(['100%', '50%', '2.5%']);
  });

  it('says when the durations were sampled and not otherwise', () => {
    const { rerender } = renderWithIntl(<ToolFrequency report={REPORT} />);
    expect(screen.queryByText(msg('analytics.tools.sampled', { count: 100_000 }))).toBeNull();
    rerender(<ToolFrequency report={{ ...REPORT, sampled: true }} />);
    expect(screen.getByText(msg('analytics.tools.sampled', { count: 100_000 }))).toBeInTheDocument();
  });
});
