import type { LifecycleState, SessionSummary, TerminalSessionInfo } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { liveSessionOf, rowStateOf, type SessionRowModel } from '../../lib/workspace-view.ts';
import {
  makeLinkedTerminalSession,
  makeSession,
  makeState,
  makeTerminalLink,
  makeTerminalSession,
  makeUsage,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionRow } from './SessionRow.tsx';

function modelOf(
  info: TerminalSessionInfo,
  monitor: readonly SessionSummary[] = [],
  selected = false,
): SessionRowModel {
  const session = liveSessionOf(info);
  const row = rowStateOf(session, new Map(monitor.map((summary) => [summary.id, summary])));
  return { session, row, selected };
}

function Probe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
      {JSON.stringify(location.state)}
    </output>
  );
}

function renderRow(model: SessionRowModel, locale: 'en' | 'vi' = 'en', onNavigate?: () => void) {
  return renderWithIntl(
    <>
      <ul>
        <SessionRow model={model} {...(onNavigate === undefined ? {} : { onNavigate })} />
      </ul>
      <Probe />
    </>,
    { locale },
  );
}

const link = (): HTMLElement => screen.getByRole('link');

describe('SessionRow', () => {
  it('TC-UI-04 links to the session with the focus request in the router state', async () => {
    renderRow(modelOf(makeTerminalSession(1)));
    expect(link()).toHaveAttribute('href', '/?session=fixture-term-1');
    await userEvent.setup().click(link());
    expect(screen.getByTestId('location')).toHaveTextContent('/?session=fixture-term-1{"focusTerminal":true}');
  });

  it('marks the selected row with aria-current and no other row', () => {
    const { unmount } = renderRow(modelOf(makeTerminalSession(1), [], true));
    expect(link()).toHaveAttribute('aria-current', 'true');
    unmount();
    renderRow(modelOf(makeTerminalSession(1), [], false));
    expect(link()).not.toHaveAttribute('aria-current');
  });

  it('is an item of the roving list, named by the session', () => {
    renderRow(modelOf(makeTerminalSession(1)));
    expect(link()).toHaveAttribute('data-nav-item');
    expect(link()).toHaveAttribute('data-nav-id', 'session:fixture-term-1');
    expect(within(link()).getByText('fixture-term-1')).toBeInTheDocument();
  });

  it('carries the path and the viewers in the title', () => {
    renderRow(modelOf(makeTerminalSession(1, { viewers: 2 })));
    expect(link().title).toContain('/fixture/projects/app-1');
    expect(link().title).toContain(msg('workspace.session.viewers', { count: 2 }));
  });

  it('leaves the viewers out of the title for one viewer or none', () => {
    renderRow(modelOf(makeTerminalSession(1, { viewers: 1 })));
    expect(link().title).toBe('/fixture/projects/app-1');
  });

  it('calls back after a click, so the overlay of the list can close', async () => {
    const onNavigate = vi.fn();
    renderRow(modelOf(makeTerminalSession(1)), 'en', onNavigate);
    await userEvent.setup().click(link());
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  describe('every RowState says its state in a word', () => {
    it('TC-UI-04 starting: the word of a session that has no link yet', () => {
      renderRow(modelOf(makeTerminalSession(1)));
      expect(within(link()).getByText(msg('workspace.session.starting'))).toBeInTheDocument();
      expect(link().querySelector('time')).toBeNull();
    });

    it('TC-UI-04 not-linked: unknown, and the note says it is not linked to the monitor yet', () => {
      renderRow(modelOf(makeTerminalSession(1, { link: makeTerminalLink({ reason: 'no_registry' }) })));
      expect(within(link()).getByText(msg('state.unknown.label'))).toBeInTheDocument();
      expect(within(link()).getByText(msg('workspace.session.notLinked'))).toBeInTheDocument();
    });

    it('TC-UI-04 ambiguous: unknown, and the note says why the monitor cannot follow it', () => {
      renderRow(modelOf(makeTerminalSession(1, { link: makeTerminalLink({ status: 'ambiguous' }) })));
      expect(within(link()).getByText(msg('state.unknown.label'))).toBeInTheDocument();
      expect(within(link()).getByText(msg('workspace.session.ambiguous'))).toBeInTheDocument();
    });

    const registry: [string, TerminalSessionInfo['link']['registryStatus'], string][] = [
      ['busy', 'busy', msg('state.working.label')],
      ['idle', 'idle', msg('state.turn_ended.label')],
      // a registry-only row that waits is the case of rule S-6b: it reads "Needs you" (ADR 0107)
      ['waiting', 'waiting', msg('state.waiting_input.needsYou.label')],
    ];
    for (const [title, registryStatus, word] of registry) {
      it(`TC-UI-04 registry ${title}: the lifecycle word of the process`, () => {
        renderRow(
          modelOf(
            makeTerminalSession(1, {
              link: makeTerminalLink({ status: 'linked', sessionId: sessionId(1), registryStatus }),
            }),
          ),
        );
        expect(within(link()).getByText(word)).toBeInTheDocument();
        expect(link().querySelector('[data-state]')).not.toBeNull();
      });
    }

    it('TC-UI-04 registry idle without a transcript: waiting for the first prompt', () => {
      renderRow(
        modelOf(
          makeTerminalSession(1, {
            link: makeTerminalLink({ status: 'linked', sessionId: sessionId(1), registryStatus: 'idle' }),
          }),
        ),
      );
      expect(within(link()).getByText(msg('workspace.session.waitingPrompt'))).toBeInTheDocument();
    });

    it('TC-UI-04 registry waiting: what the process waits for', () => {
      renderRow(
        modelOf(
          makeTerminalSession(1, {
            link: makeTerminalLink({
              status: 'linked',
              sessionId: sessionId(1),
              registryStatus: 'waiting',
              waitingFor: 'FIXTURE permission prompt',
            }),
          }),
        ),
      );
      expect(within(link()).getByText('FIXTURE permission prompt')).toBeInTheDocument();
    });

    const lifecycle: LifecycleState[] = [
      'working',
      'waiting_input',
      'waiting_tool',
      'turn_ended',
      'completed',
      'failed',
    ];
    for (const state of lifecycle) {
      it(`TC-UI-04 monitor ${state}: the word of the transcript state`, () => {
        const summary = makeSession({ id: sessionId(1), state: makeState(state) });
        renderRow(modelOf(makeLinkedTerminalSession(1), [summary]));
        expect(within(link()).getByText(msg(`state.${state}.label`))).toBeInTheDocument();
      });
    }

    it('TC-UI-04 monitor: the transcript figures, the age and the errors of the session', () => {
      const summary = makeSession({
        id: sessionId(1),
        usage: makeUsage({ output: 1234 }),
        errorCount: 3,
        lastActivityAt: '2026-10-12T11:59:30.000Z',
      });
      renderRow(modelOf(makeLinkedTerminalSession(1), [summary]));
      expect(within(link()).getByTitle('1,234')).toBeInTheDocument();
      expect(within(link()).getByText(msg('workspace.session.errors', { count: 3 }))).toBeInTheDocument();
      expect(link().querySelector('time')).toHaveAttribute('datetime', '2026-10-12T11:59:30.000Z');
    });

    it('shows no error count for a session without errors', () => {
      renderRow(modelOf(makeLinkedTerminalSession(1), [makeSession({ id: sessionId(1), errorCount: 0 })]));
      expect(link().textContent).not.toContain(msg('workspace.session.errors', { count: 0 }));
    });

    it('a tracked transcript whose row is not loaded yet reads as not linked', () => {
      renderRow(modelOf(makeLinkedTerminalSession(1)));
      expect(within(link()).getByText(msg('workspace.session.notLinked'))).toBeInTheDocument();
    });
  });

  it('TC-ATT-22 shows the title of the session in the three modes: named by default of the list, every title, none', () => {
    const named = makeSession({ id: sessionId(1), label: 'FIXTURE named title', labelSource: 'custom_title' });
    const prompted = makeSession({ id: sessionId(1), label: 'FIXTURE first prompt', labelSource: 'first_prompt' });
    const show = (summary: SessionSummary, titles?: 'all' | 'named' | 'off') =>
      renderWithIntl(
        <ul>
          <SessionRow model={modelOf(makeLinkedTerminalSession(1), [summary])} titles={titles} />
        </ul>,
        { locale: 'vi' },
      );

    let view = show(named, 'named');
    const title = within(link()).getByText('FIXTURE named title');
    // the text of the server is English under another UI language, and the full text is in the tooltip
    expect(title).toHaveAttribute('lang', 'en');
    expect(title.parentElement).toHaveAttribute('title', 'FIXTURE named title');
    view.unmount();
    view = show(prompted, 'named');
    expect(within(link()).queryByText('FIXTURE first prompt')).toBeNull();
    view.unmount();
    view = show(prompted, 'all');
    expect(within(link()).getByText('FIXTURE first prompt')).toBeInTheDocument();
    view.unmount();
    view = show(named, 'off');
    expect(within(link()).queryByText('FIXTURE named title')).toBeNull();
    view.unmount();
    // without the prop a row shows no title
    show(named);
    expect(within(link()).queryByText('FIXTURE named title')).toBeNull();
  });

  it('writes its words in Vietnamese through the catalogue', () => {
    const summary = makeSession({ id: sessionId(1), state: makeState('waiting_input') });
    renderRow(modelOf(makeLinkedTerminalSession(1), [summary]), 'vi');
    expect(within(link()).getByText(msg('state.waiting_input.label', undefined, 'vi'))).toBeInTheDocument();
  });

  it('never leaves the state to a colour: the dot is hidden from assistive technology and a word sits beside it', () => {
    const summary = makeSession({ id: sessionId(1), state: makeState('failed') });
    renderRow(modelOf(makeLinkedTerminalSession(1), [summary]));
    const dot = link().querySelector('.state-dot');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(within(link()).getByText(msg('state.failed.label'))).toBeVisible();
  });
});
