import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { SummaryStrip, type SummaryTile } from './SummaryStrip.tsx';

const toggle = (over: Partial<Extract<SummaryTile, { onToggle: () => void }>> = {}): SummaryTile => ({
  id: 'working',
  label: 'FIXTURE Working',
  value: 3,
  tone: 'running',
  onToggle: vi.fn(),
  pressed: false,
  ...over,
});

describe('SummaryStrip', () => {
  it('is a labelled list with one item per tile: the figure first, then the dot and the word', () => {
    renderWithIntl(
      <SummaryStrip
        label="FIXTURE strip"
        tiles={[toggle(), toggle({ id: 'errors', label: 'FIXTURE Errors', value: 12, tone: 'failed' })]}
      />,
    );
    const list = screen.getByRole('list', { name: 'FIXTURE strip' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('3');
    expect(items[0]).toHaveTextContent('FIXTURE Working');
    expect(items[1]).toHaveTextContent('12');
    expect(items[1]?.querySelector('.summary-tile--failed')).not.toBeNull();
  });

  it('draws a toggle tile as a button with aria-pressed that calls onToggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = renderWithIntl(<SummaryStrip tiles={[toggle({ onToggle })]} />);
    const button = screen.getByRole('button', { name: /FIXTURE Working/ });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<SummaryStrip tiles={[toggle({ onToggle, pressed: true })]} />);
    expect(screen.getByRole('button', { name: /FIXTURE Working/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles from the keyboard with Enter and with Space', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithIntl(<SummaryStrip tiles={[toggle({ onToggle })]} />);
    await user.tab();
    expect(screen.getByRole('button', { name: /FIXTURE Working/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('draws a tile with an href as a link to that page', () => {
    renderWithIntl(
      <SummaryStrip
        tiles={[{ id: 'a', label: 'FIXTURE Active', value: 2, tone: 'running', href: '/sessions?state=active' }]}
      />,
    );
    const link = screen.getByRole('link', { name: /FIXTURE Active/ });
    expect(link).toHaveAttribute('href', '/sessions?state=active');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws a plain tile as text only', () => {
    renderWithIntl(<SummaryStrip tiles={[{ id: 'a', label: 'FIXTURE Plain', value: 2, tone: 'neutral' }]} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('FIXTURE Plain')).toBeInTheDocument();
  });

  it('shows a real zero as 0', () => {
    renderWithIntl(<SummaryStrip tiles={[toggle({ value: 0 })]} />);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.queryByText(msg('common.notAvailable'))).toBeNull();
  });

  it('shows an unknown value as a dash with "not available", never as 0', () => {
    renderWithIntl(<SummaryStrip tiles={[toggle({ value: null })]} />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('–');
    expect(within(button).getByText(msg('common.notAvailable'))).toHaveClass('sr-only');
    expect(button).not.toHaveTextContent(/\b0\b/);
  });

  it('shows a lower bound as N+ and tells a screen reader "at least N"', () => {
    renderWithIntl(<SummaryStrip tiles={[toggle({ value: 5, lowerBound: true, tip: 'FIXTURE tip' })]} />);
    expect(screen.getByText('5+')).toBeInTheDocument();
    expect(screen.getByText(msg('lists.atLeast', { value: '5' }))).toHaveClass('sr-only');
    expect(screen.getByRole('button')).toHaveAttribute('title', 'FIXTURE tip');
  });

  it('formats the figure for the language that is shown', () => {
    const tiles = [toggle({ value: 12345 })];
    const { unmount } = renderWithIntl(<SummaryStrip tiles={tiles} />);
    expect(screen.getAllByText('12,345').length).toBeGreaterThan(0);
    unmount();
    renderWithIntl(<SummaryStrip tiles={tiles} />, { locale: 'vi' });
    expect(screen.getAllByText('12.345').length).toBeGreaterThan(0);
  });

  it('renders no tiles as an empty list without failing', () => {
    renderWithIntl(<SummaryStrip tiles={[]} label="FIXTURE empty" />);
    expect(within(screen.getByRole('list', { name: 'FIXTURE empty' })).queryAllByRole('listitem')).toHaveLength(0);
  });
});
