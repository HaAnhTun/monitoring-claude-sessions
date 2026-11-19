import { useContext, useEffect, useRef } from 'react';

import { readAccessCode, redeemFragment, stripAccessFragment, type AccessOutcome } from '../data/access-flow.ts';
import { describeApiError } from '../data/api-errors.ts';
import { AccessFlowContext, useAuthSession, useCreateAccessFlow } from '../data/hooks/useAuth.ts';
import { useT } from '../i18n/context.ts';
import type { TFunction } from '../i18n/types.ts';
import { useAnnounce } from '../state/announcer.tsx';

/** The command that prints a new access link: a command of the tool, the same in every language. */
const ACCESS_COMMAND = 'caw open';

/** What a screen reader hears when the flow settles, or `null` for a state that is not an end (idle, exchanging). */
function announcementOf(outcome: AccessOutcome, t: TFunction): string | null {
  switch (outcome.kind) {
    case 'granted':
      return t('access.unlocked');
    case 'cookie-not-kept':
      return t('access.error.cookie');
    case 'invalid':
      return t('access.error.invalid', { command: ACCESS_COMMAND });
    case 'rate-limited':
      return t('access.error.rateLimited', { seconds: Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)) });
    case 'failed':
      return t('access.error.failed', { detail: describeApiError(outcome.error, t) ?? outcome.error.name });
    case 'idle':
    case 'exchanging':
      return null;
  }
}

/**
 * Redeems the login link of a user instance (design 04 4.5), once, for the whole shell: it asks the session first
 * (`GET /auth/session`), and when the address bar carries `#code=<code>` and the browser holds no session it sends the one
 * exchange, takes the fragment out of the address bar when that request has settled, and announces the outcome through the one
 * live region. A browser that is already signed in only loses the fragment. The code is read from the address bar and goes to
 * the one request; it is never rendered, announced or stored, and the gate draws nothing of its own (the locked state of the
 * Workspace shows the paste field and the failures). The flow is the one of `AccessFlowContext`, so a code pasted into the
 * Workspace is announced here too.
 */
export function AccessGate() {
  const t = useT();
  const announce = useAnnounce();
  const ownFlow = useCreateAccessFlow();
  const flow = useContext(AccessFlowContext) ?? ownFlow;
  const session = useAuthSession();
  const authenticated = session.data?.authenticated;
  const announced = useRef<AccessOutcome['kind']>('idle');

  // The outcome of every attempt, the pasted ones included, is said once.
  useEffect(() => {
    return flow.subscribe(() => {
      const outcome = flow.snapshot();
      if (outcome.kind === announced.current) return;
      announced.current = outcome.kind;
      const line = announcementOf(outcome, t);
      if (line !== null) announce(line, { force: true });
    });
  }, [flow, announce, t]);

  // The session is known: redeem the fragment, or just remove it. StrictMode runs this twice; the flow keeps one request per code.
  useEffect(() => {
    if (authenticated === undefined) return;
    if (authenticated || readAccessCode(window.location.hash) === null) {
      stripAccessFragment();
      return;
    }
    void redeemFragment(flow);
  }, [authenticated, flow]);

  return null;
}
