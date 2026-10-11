import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton } from './Skeleton.tsx';

describe('Skeleton', () => {
  it('marks the container busy and gives screen readers one status text', () => {
    const { container } = render(<Skeleton rows={3} variant="table" label="Loading sessions" />);
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading sessions');
    expect(status).toHaveClass('sr-only');
  });

  it.each(['table', 'list', 'tiles', 'text'] as const)('renders the requested number of rows for %s', (variant) => {
    const { container } = render(<Skeleton rows={4} variant={variant} label="Loading" />);
    expect(container.firstElementChild).toHaveClass(`skeleton--${variant}`);
    expect(container.querySelectorAll('.skeleton__row')).toHaveLength(4);
  });

  it('hides the placeholder rows from assistive technology', () => {
    const { container } = render(<Skeleton rows={2} variant="list" label="Loading" />);
    for (const row of container.querySelectorAll('.skeleton__row')) {
      expect(row).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('renders no rows for zero', () => {
    const { container } = render(<Skeleton rows={0} variant="text" label="Loading" />);
    expect(container.querySelectorAll('.skeleton__row')).toHaveLength(0);
  });
});
