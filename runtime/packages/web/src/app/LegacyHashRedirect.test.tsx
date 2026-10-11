import { act, screen } from '@testing-library/react';
import { useLocation, useNavigationType } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithProviders } from '../test/render.tsx';
import { LegacyHashRedirect } from './LegacyHashRedirect.tsx';

function Probe() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <output data-testid="probe">
      {location.pathname + location.search + location.hash}|{type}
    </output>
  );
}

function renderAt(route: string) {
  return renderWithProviders(
    <>
      <LegacyHashRedirect />
      <Probe />
    </>,
    { route },
  );
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('LegacyHashRedirect (04-ui.md section 3.3, must-preserve #1)', () => {
  it('moves a legacy #sid link to the session transcript, replacing the history entry', () => {
    renderAt('/#sid=abc-123');
    expect(screen.getByTestId('probe')).toHaveTextContent('/sessions/abc-123?tab=transcript|REPLACE');
  });

  it('carries the agent over', () => {
    renderAt('/#sid=abc&agent=agent-0001');
    expect(screen.getByTestId('probe')).toHaveTextContent('/sessions/abc?tab=transcript&agent=agent-0001|REPLACE');
  });

  it('encodes the id as one path segment', () => {
    renderAt('/#sid=a%2Fb%20c');
    expect(screen.getByTestId('probe')).toHaveTextContent('/sessions/a%2Fb%20c?tab=transcript|REPLACE');
  });

  it('caps the values at 200 characters', () => {
    renderAt(`/#sid=${'x'.repeat(250)}`);
    expect(screen.getByTestId('probe')).toHaveTextContent(`/sessions/${'x'.repeat(200)}?tab=transcript|REPLACE`);
  });

  it.each([['/'], ['/#'], ['/#agent=main'], ['/#sid='], ['/#something-else']])('leaves %s alone', (route) => {
    renderAt(route);
    const text = screen.getByTestId('probe').textContent;
    expect(text.endsWith('|POP')).toBe(true);
    expect(text.startsWith('/sessions')).toBe(false);
  });

  it('only acts on the root path', () => {
    renderAt('/sessions#sid=abc');
    expect(screen.getByTestId('probe')).toHaveTextContent('/sessions#sid=abc|POP');
  });

  it('repeats the check when the hash changes while the page is open', () => {
    renderAt('/');
    expect(screen.getByTestId('probe')).toHaveTextContent('/|POP');
    act(() => {
      window.history.replaceState(null, '', '/#sid=later');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('/sessions/later?tab=transcript|REPLACE');
  });

  it('ignores a hash change that is not a session link', () => {
    renderAt('/');
    act(() => {
      window.history.replaceState(null, '', '/#nothing');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('/|POP');
  });
});
