import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makeMetric } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { MetricTile, metricKnown, metricLink } from './MetricTile.tsx';

function renderTile(overrides: Parameters<typeof makeMetric>[0], locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(<MetricTile metric={makeMetric(overrides)} />, { locale });
}

describe('MetricTile', () => {
  it('draws a count with the label of the catalogue, in both languages', () => {
    const view = renderTile({ key: 'sessions.failed', label: 'SERVER LABEL', value: 1234 });
    expect(screen.getByText(msg('metric.sessions.failed'))).toBeInTheDocument();
    expect(screen.queryByText('SERVER LABEL')).toBeNull();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    view.unmount();
    renderTile({ key: 'sessions.failed', label: 'SERVER LABEL', value: 1234 }, 'vi');
    expect(screen.getByText(msg('metric.sessions.failed', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByText('1.234')).toBeInTheDocument();
  });

  it('falls back to the label of the server, marked as English server text, for a key without words', () => {
    renderTile({ key: 'cost.reported', label: 'Cost reported by the provider', value: 3, unit: 'currency' }, 'vi');
    const label = screen.getByText('Cost reported by the provider');
    expect(label).toHaveAttribute('lang', 'en');
  });

  it('shows tokens as a compact figure with the exact value in the tooltip and the unit beside it', () => {
    renderTile({ key: 'tokens.output', value: 12_345, unit: 'tokens' });
    const value = screen.getByText('12K');
    expect(value).toHaveAttribute('title', '12,345');
    expect(screen.getByText(msg('metric.unit.tokens'))).toBeInTheDocument();
    expect(screen.getByText(msg('metric.tokens.output'))).toBeInTheDocument();
  });

  it('formats the compact figure for Vietnamese with the exact value in the tooltip', () => {
    renderTile({ key: 'tokens.output', value: 12_345, unit: 'tokens' }, 'vi');
    const value = screen.getByText(/^12\s?N$/);
    expect(value).toHaveAttribute('title', '12.345');
  });

  it('shows "not available" for a null value and never a zero', () => {
    renderTile({ key: 'tokens.input_new', value: null, unit: 'tokens', completeness: 'unavailable' });
    expect(screen.getByText(msg('common.notAvailable'))).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText(msg('metric.unit.tokens'))).toBeNull();
  });

  it('treats a metric marked unavailable as not available even when it carries a number', () => {
    expect(metricKnown({ value: 7, completeness: 'unavailable' })).toBe(false);
    expect(metricKnown({ value: 7, completeness: 'partial' })).toBe(true);
    expect(metricKnown({ value: null, completeness: 'complete' })).toBe(false);
  });

  it('tags a partial figure as a lower bound and writes a partial count as N+', () => {
    renderTile({ key: 'sessions.active', value: 5, completeness: 'partial' });
    expect(screen.getByText('5+')).toBeInTheDocument();
    expect(screen.getByText(msg('metric.lowerBound')).closest('[title]')).toHaveAttribute(
      'title',
      msg('metric.lowerBound.tip'),
    );
  });

  it('labels the estimated cost as an estimate and writes the amount in its currency', () => {
    renderTile({ key: 'cost.estimate', value: 4.26, unit: 'currency', currency: 'USD' });
    expect(screen.getByText('$4.26')).toBeInTheDocument();
    expect(screen.getByText(msg('metric.estimate')).closest('[title]')).toHaveAttribute(
      'title',
      msg('analytics.cost.estimateTip'),
    );
  });

  it('shows the source and the rule of the server verbatim in an info tip that opens with the keyboard', async () => {
    const user = userEvent.setup();
    renderTile({
      key: 'tokens.output',
      unit: 'tokens',
      source: 'usage.output_tokens',
      rule: 'sum; lower bound when X',
    });
    expect(screen.queryByText('usage.output_tokens')).toBeNull();
    const trigger = screen.getByRole('button', { name: msg('metric.info', { label: msg('metric.tokens.output') }) });
    trigger.focus();
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText('usage.output_tokens')).toBeInTheDocument();
    expect(within(panel).getByText('sum; lower bound when X')).toBeInTheDocument();
    expect(within(panel).getByText(msg('metric.source'))).toBeInTheDocument();
    expect(within(panel).getByText(msg('metric.rule'))).toBeInTheDocument();
  });

  it('marks the tip text of the server as English inside a Vietnamese page', async () => {
    const user = userEvent.setup();
    renderTile({ key: 'sessions.active', source: 'sessions.state', rule: 'FIXTURE rule' }, 'vi');
    await user.click(
      screen.getByRole('button', {
        name: msg('metric.info', { label: msg('metric.sessions.active', undefined, 'vi') }, 'vi'),
      }),
    );
    expect(screen.getByText('FIXTURE rule')).toHaveAttribute('lang', 'en');
    expect(screen.getByText(msg('metric.rule', undefined, 'vi'))).toBeInTheDocument();
  });

  it('is a link to the server link, and to the sessions of its state when the server sent none', () => {
    const view = renderTile({ key: 'sessions.failed', link: '/sessions?state=failed' });
    expect(screen.getByRole('link', { name: msg('metric.sessions.failed') })).toHaveAttribute(
      'href',
      '/sessions?state=failed',
    );
    view.unmount();
    renderTile({ key: 'sessions.stale', link: null });
    expect(screen.getByRole('link', { name: msg('metric.sessions.stale') })).toHaveAttribute(
      'href',
      '/sessions?state=stale',
    );
  });

  it('follows the link of the server for tokens and has no link without one', () => {
    const view = renderTile({ key: 'tokens.output', unit: 'tokens', link: '/analytics' });
    expect(screen.getByRole('link', { name: msg('metric.tokens.output') })).toHaveAttribute('href', '/analytics');
    view.unmount();
    renderTile({ key: 'tokens.output', unit: 'tokens', link: null });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never follows an address that leaves the application', () => {
    expect(metricLink({ key: 'tokens.output', link: 'https://example.invalid/x' })).toBeNull();
    expect(metricLink({ key: 'tokens.output', link: '//example.invalid/x' })).toBeNull();
    expect(metricLink({ key: 'sessions.failed', link: 'https://example.invalid/x' })).toBe('/sessions?state=failed');
    expect(metricLink({ key: 'events.errors', link: '/activity?severity=error' })).toBe('/activity?severity=error');
  });

  it('writes durations and sizes through the formatters of the language', () => {
    const view = renderTile({ key: 'x.ms', label: 'Latency', unit: 'ms', value: 125_000 });
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    view.unmount();
    renderTile({ key: 'x.bytes', label: 'Size', unit: 'bytes', value: 1536 });
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
  });
});
