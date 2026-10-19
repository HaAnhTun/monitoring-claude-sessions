import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { RouteErrorBoundary } from './RouteErrorBoundary.tsx';

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('FIXTURE render failure');
  return <p>fine</p>;
}

function Harness() {
  const [explode, setExplode] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setExplode(false);
        }}
      >
        heal
      </button>
      <RouteErrorBoundary>
        <Bomb explode={explode} />
      </RouteErrorBoundary>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RouteErrorBoundary', () => {
  it('shows the crash state with Reload view and Copy error details', () => {
    renderWithIntl(<Harness />);
    expect(screen.getByText(msg('common.viewFailed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.reloadView') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.copyErrorDetails') })).toBeInTheDocument();
  });

  it('draws the page again when Reload view is pressed and the cause is gone', async () => {
    const user = userEvent.setup();
    renderWithIntl(<Harness />);
    await user.click(screen.getByRole('button', { name: 'heal' }));
    await user.click(screen.getByRole('button', { name: msg('common.reloadView') }));
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('copies the error name, message and component stack, nothing else', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderWithIntl(<Harness />);
    await user.click(screen.getByRole('button', { name: msg('common.copyErrorDetails') }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const calls = writeText.mock.calls as unknown as string[][];
    expect(calls[0]?.[0]).toContain('Error: FIXTURE render failure');
  });

  it('does not throw when the clipboard is missing', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', {});
    renderWithIntl(<Harness />);
    await act(async () => {
      await user.click(screen.getByRole('button', { name: msg('common.copyErrorDetails') }));
    });
    expect(screen.getByText(msg('common.viewFailed'))).toBeInTheDocument();
  });

  it('words the fallback in Vietnamese', () => {
    renderWithIntl(<Harness />, { locale: 'vi' });
    expect(screen.getByText(msg('common.viewFailed', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.reloadView', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.copyErrorDetails', undefined, 'vi') })).toBeInTheDocument();
  });
});
