import { screen, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccessFlowContext, useCreateAccessFlow } from '../data/hooks/useAuth.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../test/fake-api.ts';
import { makeAuthSession } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { AccessGate } from './AccessGate.tsx';

// Design 04 4.5: the gate redeems the login fragment of the address bar once, asks the session first, strips the fragment when
// the request has settled, announces the outcome, and never lets the code reach the DOM.

/** A code of the shape the server mints (32 to 128 characters of the URL-safe alphabet), invented for the tests. */
const CODE = 'fixtureAccessCode0123456789abcdefABCDEF';

interface Server {
  /** Whether the next read of the session answers authenticated; the exchange flips it when `keepCookie` is true. */
  authenticated: boolean;
  keepCookie: boolean;
}

function renderGate(options: { authenticated?: boolean; keepCookie?: boolean; handlers?: FakeHandlers } = {}) {
  const server: Server = { authenticated: options.authenticated ?? false, keepCookie: options.keepCookie ?? true };
  const api: FakeApi = createFakeApi({
    authSession: () => makeAuthSession(server.authenticated),
    authExchange: () => {
      if (server.keepCookie) server.authenticated = true;
      return { authenticated: true };
    },
    ...options.handlers,
  });
  // The shell provides the flow the gate and the Workspace share; this wrap does the same.
  function Shared({ children }: { children: ReactNode }) {
    const flow = useCreateAccessFlow();
    return <AccessFlowContext value={flow}>{children}</AccessFlowContext>;
  }
  const rendered = renderWithIntl(
    <StrictMode>
      <AnnouncerProvider>
        <Shared>
          <AccessGate />
        </Shared>
      </AnnouncerProvider>
    </StrictMode>,
    { api },
  );
  return { ...rendered, server };
}

/** The markup of a subtree, attributes included: what a person, a script or an extension could read. */
function markup(root: Element): string {
  return new XMLSerializer().serializeToString(root);
}

function setHash(hash: string): void {
  window.history.replaceState(null, '', `/${hash}`);
}

function liveText(): string {
  return document.getElementById('live-region')?.textContent ?? '';
}

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  setHash('');
});

describe('AccessGate', () => {
  it('sends one exchange for the code of the fragment under StrictMode, then strips the fragment', async () => {
    setHash(`#code=${CODE}`);
    const { api } = renderGate();
    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(api.callsTo('authExchange')).toHaveLength(1);
    expect(api.callsTo('authExchange')[0]?.body).toEqual({ code: CODE });
    expect(window.location.pathname).toBe('/');
  });

  it('asks the session first and stays out of the way when there is no code', async () => {
    const { api } = renderGate();
    await waitFor(() => {
      expect(api.callsTo('authSession').length).toBeGreaterThan(0);
    });
    expect(api.callsTo('authExchange')).toHaveLength(0);
    expect(liveText()).toBe('');
  });

  it('strips the fragment without a request when the browser already holds the session', async () => {
    setHash(`#code=${CODE}`);
    const { api } = renderGate({ authenticated: true });
    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(api.callsTo('authExchange')).toHaveLength(0);
  });

  it('removes a malformed fragment and sends nothing', async () => {
    setHash('#code=short');
    const { api } = renderGate();
    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(api.callsTo('authExchange')).toHaveLength(0);
  });

  it('announces "Terminals unlocked" when the code is accepted and the cookie is kept', async () => {
    setHash(`#code=${CODE}`);
    const { api } = renderGate();
    await waitFor(() => {
      expect(liveText()).toBe(msg('access.unlocked'));
    });
    // the session was read before the exchange and once more after it (the cookie check)
    expect(api.callsTo('authSession').length).toBeGreaterThanOrEqual(2);
  });

  it('says so when the code was accepted but this browser did not keep the cookie', async () => {
    setHash(`#code=${CODE}`);
    const { api } = renderGate({ keepCookie: false });
    await waitFor(() => {
      expect(liveText()).toBe(msg('access.error.cookie'));
    });
    expect(window.location.hash).toBe('');
    expect(api.callsTo('authExchange')).toHaveLength(1);
  });

  it('announces a used or expired code and still strips it', async () => {
    setHash(`#code=${CODE}`);
    renderGate({ handlers: { authExchange: () => errorResponse('access_code_invalid') } });
    await waitFor(() => {
      expect(liveText()).toBe(msg('access.error.invalid', { command: 'caw open' }));
    });
    expect(window.location.hash).toBe('');
  });

  it('announces a rate limit with the seconds to wait', async () => {
    setHash(`#code=${CODE}`);
    renderGate({
      handlers: { authExchange: () => errorResponse('access_rate_limited', 'x', { retryAfterSeconds: 12 }) },
    });
    await waitFor(() => {
      expect(liveText()).toBe(msg('access.error.rateLimited', { seconds: 12 }));
    });
    expect(window.location.hash).toBe('');
  });

  it('never puts the code in the DOM, the live region or the visible text', async () => {
    setHash(`#code=${CODE}`);
    const { container } = renderGate();
    await waitFor(() => {
      expect(liveText()).toBe(msg('access.unlocked'));
    });
    expect(markup(container)).not.toContain(CODE);
    expect(markup(document.body)).not.toContain(CODE);
    expect(screen.queryByText(CODE)).toBeNull();
  });

  it('renders nothing visible of its own', () => {
    const { container } = renderGate();
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });
});
