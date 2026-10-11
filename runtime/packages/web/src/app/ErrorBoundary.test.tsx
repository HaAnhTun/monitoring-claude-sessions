import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary.tsx';

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary resetKeys={[]} fallback={() => <p>fallback</p>}>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('renders the fallback with the error and logs name and message only', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary resetKeys={[]} fallback={({ error }) => <p>failed: {error.message}</p>}>
        <Boom message="oops" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('failed: oops')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('UI error: Error: oops');
  });

  it('passes a component stack to the fallback', () => {
    render(
      <ErrorBoundary resetKeys={[]} fallback={({ componentStack }) => <p>stack: {componentStack ?? 'none'}</p>}>
        <Boom message="oops" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/stack: .*Boom/)).toBeInTheDocument();
  });

  it('resets through the reset callback of the fallback', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary
          resetKeys={[]}
          fallback={({ reset }) => (
            <button
              type="button"
              onClick={() => {
                setBroken(false);
                reset();
              }}
            >
              retry
            </button>
          )}
        >
          {broken ? <Boom message="oops" /> : <p>recovered</p>}
        </ErrorBoundary>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('resets when a reset key changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['a']} fallback={() => <p>fallback</p>}>
        <Boom message="oops" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('fallback')).toBeInTheDocument();
    rerender(
      <ErrorBoundary resetKeys={['b']} fallback={() => <p>fallback</p>}>
        <p>healthy again</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy again')).toBeInTheDocument();
  });

  it('stays in the fallback while the reset keys are unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['a']} fallback={() => <p>fallback</p>}>
        <Boom message="oops" />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary resetKeys={['a']} fallback={() => <p>fallback</p>}>
        <p>healthy again</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fallback')).toBeInTheDocument();
  });
});
