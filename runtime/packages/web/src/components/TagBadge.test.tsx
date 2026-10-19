import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TagBadge, type Tone } from './TagBadge.tsx';

const TONES: Tone[] = [
  'running',
  'waiting',
  'idle',
  'completed',
  'failed',
  'unknown',
  'stale',
  'partial',
  'ok',
  'neutral',
];

describe('TagBadge', () => {
  it.each(TONES)('renders the %s tone class and its word as a muted tag, not a pill', (tone) => {
    render(<TagBadge tone={tone}>lower bound</TagBadge>);
    const badge = screen.getByText('lower bound').closest('.badge');
    expect(badge).toHaveClass(`tone-${tone}`, 'badge--tag');
    expect(badge).not.toHaveClass('badge--state');
    expect(badge?.querySelector('.state-dot')).toBeNull();
  });

  it('adds an icon when asked and keeps the word visible', () => {
    render(
      <TagBadge tone="partial" icon="alert">
        partial history
      </TagBadge>,
    );
    const badge = screen.getByText('partial history').closest('.badge');
    expect(badge?.querySelector('svg.icon')).not.toBeNull();
    expect(badge?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no icon unless one is asked for', () => {
    render(<TagBadge tone="neutral">hooks</TagBadge>);
    expect(screen.getByText('hooks').closest('.badge')?.querySelector('svg')).toBeNull();
  });

  it('puts the tip into the title attribute', () => {
    render(
      <TagBadge tone="ok" tip="All good">
        ok
      </TagBadge>,
    );
    expect(screen.getByText('ok').closest('.badge')).toHaveAttribute('title', 'All good');
  });

  it('has no title when no tip is given', () => {
    render(<TagBadge tone="ok">ok</TagBadge>);
    expect(screen.getByText('ok').closest('.badge')).not.toHaveAttribute('title');
  });

  it('keeps the props: extra class and data-state', () => {
    render(
      <TagBadge tone="neutral" extraClass="badge--sm" state="working">
        label
      </TagBadge>,
    );
    const badge = screen.getByText('label').closest('.badge');
    expect(badge).toHaveClass('badge--sm');
    expect(badge).toHaveAttribute('data-state', 'working');
  });
});
