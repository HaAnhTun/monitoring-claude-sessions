import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeMetric } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { MetricGrid } from './MetricGrid.tsx';

const SESSIONS = makeMetric({ key: 'sessions.active', value: 3 });
const FAILED = makeMetric({ key: 'sessions.failed', value: 1 });
const OUTPUT = makeMetric({ key: 'tokens.output', unit: 'tokens', value: 61_400, link: '/analytics' });
const INPUT_NEW = makeMetric({ key: 'tokens.input_new', unit: 'tokens', value: 118_900, link: '/analytics' });
const CACHE_READ = makeMetric({ key: 'tokens.cache_read', unit: 'tokens', value: 9_240_000, link: '/analytics' });
const ESTIMATE = makeMetric({ key: 'cost.estimate', unit: 'currency', currency: 'USD', value: 4.26 });
const REPORTED = makeMetric({
  key: 'cost.reported',
  label: 'Cost reported by Claude Code',
  unit: 'currency',
  currency: 'USD',
  value: 5.1,
  completeness: 'partial',
});

function tiles(): string[] {
  return Array.from(document.querySelectorAll('[data-metric]')).map((el) => el.getAttribute('data-metric') ?? '');
}

describe('MetricGrid', () => {
  it('draws one tile for each metric the server returned, in the order it sent them', () => {
    renderWithIntl(<MetricGrid metrics={[SESSIONS, OUTPUT, FAILED, INPUT_NEW]} />);
    expect(tiles()).toEqual(['sessions.active', 'sessions.failed', 'tokens.output', 'tokens.input_new']);
  });

  it('leaves out a metric the server did not return: no tile and no zero', () => {
    renderWithIntl(<MetricGrid metrics={[SESSIONS, OUTPUT]} />);
    expect(tiles()).toEqual(['sessions.active', 'tokens.output']);
    expect(screen.queryByText(msg('metric.tokens.input_new'))).toBeNull();
    expect(screen.queryByText(msg('metric.tokens.cache_read'))).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('groups sessions and errors apart from tokens and cost, and drops a group without tiles', () => {
    const view = renderWithIntl(<MetricGrid metrics={[SESSIONS, OUTPUT]} />);
    const sessions = screen.getByRole('region', { name: msg('overview.figures.sessions') });
    const usage = screen.getByRole('region', { name: msg('overview.figures.usage') });
    expect(within(sessions).getByText(msg('metric.sessions.active'))).toBeInTheDocument();
    expect(within(usage).getByText(msg('metric.tokens.output'))).toBeInTheDocument();
    view.unmount();
    renderWithIntl(<MetricGrid metrics={[SESSIONS]} />);
    expect(screen.queryByRole('region', { name: msg('overview.figures.usage') })).toBeNull();
  });

  it('draws nothing for an empty list', () => {
    const { container } = renderWithIntl(<MetricGrid metrics={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the estimated cost and the cost the provider reported as two separate tiles', () => {
    renderWithIntl(<MetricGrid metrics={[ESTIMATE, REPORTED]} />);
    expect(tiles()).toEqual(['cost.estimate', 'cost.reported']);
    expect(screen.getByText(msg('metric.cost.estimate'))).toBeInTheDocument();
    expect(screen.getByText('Cost reported by Claude Code')).toBeInTheDocument();
    expect(screen.getByText(msg('metric.estimate'))).toBeInTheDocument();
    expect(screen.getByText('$4.26')).toBeInTheDocument();
    expect(screen.getByText('$5.10')).toBeInTheDocument();
  });

  it('writes the figures of every tile in the language that is shown', () => {
    renderWithIntl(<MetricGrid metrics={[OUTPUT, CACHE_READ]} />, { locale: 'vi' });
    expect(screen.getByText(/^61\s?N$/)).toHaveAttribute('title', '61.400');
    expect(screen.getByText(/^9,2\s?Tr$/)).toHaveAttribute('title', '9.240.000');
    expect(screen.getByText(msg('metric.tokens.cache_read', undefined, 'vi'))).toBeInTheDocument();
  });
});
