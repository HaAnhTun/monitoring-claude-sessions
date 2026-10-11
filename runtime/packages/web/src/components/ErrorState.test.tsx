import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorState } from './ErrorState.tsx';

afterEach(() => {
  vi.useRealTimers();
});

describe('ErrorState', () => {
  it('announces a page-size load failure as an alert with the message', () => {
    render(<ErrorState kind="load" size="page" subject="sessions" error={new Error('connection refused')} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load sessions: connection refused. Retrying automatically.');
  });

  it.each([
    ['load', 'block'],
    ['refresh', 'page'],
    ['not-found', 'page'],
    ['crash', 'page'],
    ['contract', 'page'],
  ] as const)('uses a status region (not an alert) for kind %s at size %s', (kind, size) => {
    render(<ErrorState kind={kind} size={size} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the retry button only with a callback and calls it', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState kind="load" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ErrorState kind="load" onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says how old the kept data is for a refresh failure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    render(
      <ErrorState
        kind="refresh"
        subject="sessions"
        error={new Error('timeout')}
        lastGoodAt={Date.parse('2026-01-01T00:00:48Z')}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not refresh sessions: timeout. Showing data from 12s ago.',
    );
  });

  it('renders the legacy text for an unknown session', () => {
    render(<ErrorState kind="not-found" />);
    expect(
      screen.getByText(
        'The monitor does not know this session. It may be outside the session window or belong to another task.',
      ),
    ).toBeInTheDocument();
  });

  it('offers Reload view for a crash and keeps extra actions', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState kind="crash" onRetry={onRetry}>
        <button type="button">Copy error details</button>
      </ErrorState>,
    );
    expect(screen.getByText('This view failed to render.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload view' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument();
  });

  it('names a contract failure without hiding the message', () => {
    render(<ErrorState kind="contract" error={new Error('field sessions[0].state is invalid')} />);
    expect(screen.getByRole('status')).toHaveTextContent('field sessions[0].state is invalid');
  });

  it('marks the inline size for the layout', () => {
    const { container } = render(<ErrorState kind="load" size="inline" />);
    expect(container.firstElementChild).toHaveClass('state--inline');
  });
});
