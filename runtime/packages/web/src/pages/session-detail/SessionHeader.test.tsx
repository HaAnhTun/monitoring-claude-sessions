import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_NOW_MS, iso, makeAgent, makeSessionDetail, makeState, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionHeader } from './SessionHeader.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SessionHeader', () => {
  it('has a way back to the list, the title as the only h1 and no 36-character id', () => {
    const { container } = renderWithIntl(
      <SessionHeader session={makeSessionDetail({ id: sessionId(3), label: 'FIXTURE the title' })} agent={null} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'FIXTURE the title' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('detail.back') })).toHaveAttribute('href', '/sessions');
    expect(container).not.toHaveTextContent(sessionId(3));
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('keeps the whole title as a tooltip, for a title the row has to cut', () => {
    renderWithIntl(<SessionHeader session={makeSessionDetail({ label: 'FIXTURE a very long title' })} agent={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('title', 'FIXTURE a very long title');
  });

  it('names the chosen subagent after the session', () => {
    renderWithIntl(
      <SessionHeader
        session={makeSessionDetail({ label: 'FIXTURE session' })}
        agent={makeAgent({ label: 'FIXTURE helper' })}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('FIXTURE session / FIXTURE helper');
  });

  it('shows the state as a dot and a word', () => {
    renderWithIntl(<SessionHeader session={makeSessionDetail({ state: makeState('turn_ended') })} agent={null} />);
    expect(screen.getByText(msg('state.turn_ended.label'))).toBeInTheDocument();
    expect(document.querySelector('.session-header__state [data-state="turn_ended"]')).not.toBeNull();
  });

  it('shows the evidence line of an inferred active state next to the badge, with a question mark', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXTURE_NOW_MS });
    renderWithIntl(
      <SessionHeader
        session={makeSessionDetail({
          lastActivityAt: iso(-18 * 60),
          state: makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }),
        })}
        agent={null}
      />,
    );
    expect(screen.getByText(msg('badge.inferredLabel', { label: msg('state.working.label') }))).toBeInTheDocument();
    const line = document.querySelector('.session-header__state .evidence-line');
    expect(line).toHaveTextContent('inferred, quiet 18m');
  });

  it('shows the first evidence item of an open tool as server text', () => {
    renderWithIntl(
      <SessionHeader
        session={makeSessionDetail({
          state: makeState('waiting_tool', {
            evidence: [{ kind: 'transcript:tool_open', at: iso(-60), text: 'FIXTURE tool Bash open' }],
          }),
        })}
        agent={null}
      />,
    );
    expect(document.querySelector('.session-header__state .evidence-line')).toHaveTextContent('FIXTURE tool Bash open');
  });

  it('shows no evidence line for an observed state', () => {
    renderWithIntl(<SessionHeader session={makeSessionDetail({ state: makeState('completed') })} agent={null} />);
    expect(document.querySelector('.evidence-line')).toBeNull();
  });

  it('lists the evidence behind the state, in plain words, in a popover', async () => {
    renderWithIntl(
      <SessionHeader
        session={makeSessionDetail({
          state: makeState('waiting_input', {
            basis: 'inferred',
            confidence: 'medium',
            evidence: [{ kind: 'hook:notification', at: iso(-20), text: 'FIXTURE evidence text' }],
          }),
        })}
        agent={null}
      />,
    );
    const toggle = screen.getByRole('button', { name: msg('detail.evidence') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('FIXTURE evidence text', { selector: 'li *, li' })).toBeNull();
    await userEvent.click(toggle);
    const panel = screen.getByRole('dialog', { name: msg('detail.evidence.panel') });
    expect(within(panel).getByText('FIXTURE evidence text')).toBeInTheDocument();
    expect(panel).toHaveTextContent(msg('evidence.basis.inferred'));
    expect(panel).toHaveTextContent(msg('evidence.confidence.medium'));
    expect(panel).not.toHaveTextContent('medium confidence');
  });

  it('says so when no evidence was recorded', async () => {
    renderWithIntl(<SessionHeader session={makeSessionDetail({ state: makeState('completed') })} agent={null} />);
    await userEvent.click(screen.getByRole('button', { name: msg('detail.evidence') }));
    expect(screen.getByText(msg('detail.evidence.none'))).toBeInTheDocument();
  });

  it('tags a session that no project rule matched, and not a matched one', () => {
    const { unmount } = renderWithIntl(<SessionHeader session={makeSessionDetail({ matched: false })} agent={null} />);
    expect(screen.getByText(msg('detail.notInList')).closest('.badge')).toHaveAttribute(
      'title',
      msg('detail.notInList.tip'),
    );
    unmount();
    renderWithIntl(<SessionHeader session={makeSessionDetail({ matched: true })} agent={null} />);
    expect(screen.queryByText(msg('detail.notInList'))).toBeNull();
  });

  it('copies the link of the current view', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderWithIntl(<SessionHeader session={makeSessionDetail()} agent={null} />, {
      route: `/sessions/${sessionId(1)}?tab=events`,
    });
    await user.click(screen.getByRole('button', { name: msg('detail.copyLink') }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(
        `${window.location.origin}/sessions/${sessionId(1)}?tab=events`,
      );
    });
  });

  it('shows its children under the title row', () => {
    renderWithIntl(
      <SessionHeader session={makeSessionDetail()} agent={null}>
        <p>FIXTURE banner</p>
      </SessionHeader>,
    );
    expect(screen.getByText('FIXTURE banner')).toBeInTheDocument();
  });

  it('is worded in Vietnamese', () => {
    renderWithIntl(<SessionHeader session={makeSessionDetail({ matched: false })} agent={null} />, { locale: 'vi' });
    expect(screen.getByRole('link', { name: msg('detail.back', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('detail.copyLink', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByText(msg('detail.notInList', undefined, 'vi'))).toBeInTheDocument();
  });
});
