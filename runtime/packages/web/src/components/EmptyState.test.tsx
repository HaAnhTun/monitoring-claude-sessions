import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../test/render.tsx';
import { EmptyState } from './EmptyState.tsx';

describe('EmptyState', () => {
  it('renders the title and the hints', () => {
    renderWithIntl(
      <EmptyState title="No sessions yet">
        <p>The transcripts folder was not found.</p>
      </EmptyState>,
    );
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByText('The transcripts folder was not found.')).toBeInTheDocument();
  });

  it('is a polite status region, not an alert', () => {
    renderWithIntl(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the primary action as the one primary button and calls back', async () => {
    const onClick = vi.fn();
    renderWithIntl(<EmptyState title="No match" primary={{ label: 'Clear filters', onClick }} />);
    const button = screen.getByRole('button', { name: 'Clear filters' });
    expect(button).toHaveClass('btn-primary');
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no button without a primary action', () => {
    renderWithIntl(<EmptyState title="Nothing" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows an optional icon next to the title', () => {
    const { container } = renderWithIntl(<EmptyState title="Nothing" icon="info" />);
    expect(container.querySelector('svg.icon')).not.toBeNull();
  });

  it('can carry the page heading: a focusable h1 that is not a live region', () => {
    const ref = createRef<HTMLHeadingElement>();
    renderWithIntl(<EmptyState title="Gone" headingLevel={1} titleRef={ref} announce={false} />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Gone' });
    expect(ref.current).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
