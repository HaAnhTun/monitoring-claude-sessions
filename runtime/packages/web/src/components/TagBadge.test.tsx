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
  it.each(TONES)('renders the %s tone class and its word', (tone) => {
    render(<TagBadge tone={tone}>lower bound</TagBadge>);
    const badge = screen.getByText('lower bound').closest('.badge');
    expect(badge).toHaveClass(`tone-${tone}`);
  });

  it('adds an icon when asked and keeps the word visible', () => {
    render(
      <TagBadge tone="partial" icon="alert">
        partial history
      </TagBadge>,
    );
    const badge = screen.getByText('partial history').closest('.badge');
    expect(badge?.querySelector('svg.icon')).not.toBeNull();
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
});
