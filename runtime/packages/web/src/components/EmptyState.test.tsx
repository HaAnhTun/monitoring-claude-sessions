import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './EmptyState.tsx';

describe('EmptyState', () => {
  it('renders the title and the hints', () => {
    render(
      <EmptyState title="No sessions yet">
        <p>The transcripts folder was not found.</p>
      </EmptyState>,
    );
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByText('The transcripts folder was not found.')).toBeInTheDocument();
  });

  it('is a polite status region, not an alert', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders an action button that calls back', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="No match" action={{ label: 'Clear filters', onClick }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no button without an action', () => {
    render(<EmptyState title="Nothing" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows an optional icon next to the title', () => {
    const { container } = render(<EmptyState title="Nothing" icon="info" />);
    expect(container.querySelector('svg.icon')).not.toBeNull();
  });
});
