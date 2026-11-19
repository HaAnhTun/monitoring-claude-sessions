import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createRef, type RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessFlow, AccessOutcome } from '../../data/access-flow.ts';
import { ApiError } from '../../data/api-errors.ts';
import { liveSessionOf, type EndedInfo, type LiveSession, type PaneState } from '../../lib/workspace-view.ts';
import { AnnouncerProvider } from '../../state/announcer.tsx';
import { fakeSeams, stubResizeObserver } from '../../test/fake-terminal.ts';
import {
  accessCode,
  accessHash,
  makeLinkedTerminalSession,
  makeSession,
  makeTerminalSession,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { TerminalSeamsContext } from '../../terminal/seams.ts';
import type { TerminalViewHandle } from '../../terminal/TerminalView.tsx';
import { ACCESS_COMMAND } from './LockedNotice.tsx';
import type { ListToggle } from './PaneHeader.tsx';
import { TerminalPane, type TerminalPaneProps } from './TerminalPane.tsx';

// Design 04 6.3 and 8.1: every state of the pane, with the real lazy view over the fake engine and the fake socket. Exactly one h1
// whatever the state is (the heading the page chrome focuses); the locked form sends nothing for a wrong format and never keeps
// a code; the ended banner keeps the frozen terminal and offers what comes next.

const PLAIN: LiveSession = liveSessionOf(makeTerminalSession(1));
const LINKED: LiveSession = liveSessionOf(makeLinkedTerminalSession(2));
const IDLE: AccessOutcome = { kind: 'idle' };

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeFlow(outcome: AccessOutcome = IDLE) {
  const submit = vi.fn<(code: string) => Promise<AccessOutcome>>(() => Promise.resolve({ kind: 'granted' }));
  const flow: AccessFlow = {
    submit,
    snapshot: () => outcome,
    subscribe: () => () => undefined,
  };
  return { flow, submit };
}

interface Rig {
  props: TerminalPaneProps;
  viewRef: RefObject<TerminalViewHandle | null>;
  submit: ReturnType<typeof fakeFlow>['submit'];
  toggle: ReturnType<typeof vi.fn<() => void>>;
}

function rigFor(state: PaneState<AccessOutcome>, over: Partial<TerminalPaneProps> = {}): Rig {
  const { flow, submit } = fakeFlow(state.kind === 'locked' ? state.outcome : IDLE);
  const viewRef = createRef<TerminalViewHandle>();
  const toggle = vi.fn<() => void>();
  const list: ListToggle = { expanded: true, controlsId: 'project-list', onToggle: toggle };
  return {
    submit,
    toggle,
    viewRef,
    props: {
      state,
      flow,
      headingRef: createRef<HTMLHeadingElement>(),
      viewRef,
      gone: false,
      list,
      toggleRef: createRef<HTMLButtonElement>(),
      onEnded: vi.fn<(info: EndedInfo) => void>(),
      onStop: vi.fn<(session: LiveSession) => void>(),
      onStartAgain: vi.fn<(session: LiveSession) => void>(),
      onResume: vi.fn<(sessionId: string) => void>(),
      onRetry: vi.fn<() => void>(),
      ...over,
    },
  };
}

function renderPane(
  state: PaneState<AccessOutcome>,
  over: Partial<TerminalPaneProps> = {},
  locale: 'en' | 'vi' = 'en',
) {
  stubResizeObserver();
  const fake = fakeSeams();
  const rig = rigFor(state, over);
  const wrap = (children: React.ReactNode): React.ReactNode => (
    <TerminalSeamsContext value={fake.seams}>
      <AnnouncerProvider>
        <div id="project-list" />
        {children}
      </AnnouncerProvider>
    </TerminalSeamsContext>
  );
  const rendered = renderWithIntl(<TerminalPane {...rig.props} />, { locale, wrap });
  return {
    ...rig,
    ...rendered,
    fake,
    update: (next: Partial<TerminalPaneProps>) => {
      rendered.rerender(<TerminalPane {...rig.props} {...next} />);
    },
  };
}

function terminalState(
  session: LiveSession,
  over: Partial<Extract<PaneState, { kind: 'terminal' }>> = {},
): PaneState<AccessOutcome> {
  return { kind: 'terminal', session, row: { kind: 'not-linked' }, focus: false, ended: null, ...over };
}

function networkError(): ApiError {
  return new ApiError('network', {
    kind: 'network',
    status: 0,
    code: null,
    endpoint: 'terminalState',
    requestId: null,
    method: 'POST',
  });
}

async function regionOf(session: LiveSession, locale: 'en' | 'vi' = 'en'): Promise<HTMLElement> {
  return screen.findByRole('group', { name: msg('terminal.region', { name: session.name }, locale) });
}

describe('every state has exactly one h1', () => {
  const states: [string, PaneState<AccessOutcome>][] = [
    ['locked', { kind: 'locked', outcome: IDLE }],
    ['loading', { kind: 'loading' }],
    ['error', { kind: 'error', error: networkError() }],
    ['unavailable', { kind: 'unavailable', reason: 'unsupported_os' }],
    ['none-selected', { kind: 'none-selected' }],
    ['not-found', { kind: 'not-found', name: 'fixture-term-7' }],
    ['terminal', terminalState(PLAIN)],
    [
      'ended terminal',
      terminalState(PLAIN, { ended: { name: PLAIN.name, session: PLAIN, exitCode: 0, killed: false } }),
    ],
  ];

  it.each(states)('%s', async (_name, state) => {
    const rig = renderPane(state);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    if (state.kind === 'terminal') await regionOf(state.session);
    expect(rig.props.headingRef).toHaveProperty('current', screen.getByRole('heading', { level: 1 }));
    expect(rig.container.querySelector('.workspace-pane')).toHaveAttribute('data-pane', state.kind);
  });
});

describe('the session (TC-UI-12 and design 6.3)', () => {
  it('names the session as the heading, shows its folder and loads the terminal lazily', async () => {
    const rig = renderPane(terminalState(PLAIN));
    expect(screen.getByRole('heading', { level: 1, name: PLAIN.name })).toBeInTheDocument();
    expect(screen.getByTitle(PLAIN.path)).toHaveTextContent(PLAIN.path);
    const region = await regionOf(PLAIN);
    expect(region).toHaveAttribute('data-terminal-region');
    await waitFor(() => {
      expect(rig.fake.loadCount()).toBe(1);
    });
    expect(rig.viewRef.current).not.toBeNull();
  });

  it('opens one socket for the session, and none again for the same session on a re-render', async () => {
    const rig = renderPane(terminalState(PLAIN));
    await regionOf(PLAIN);
    await waitFor(() => {
      expect(rig.fake.sockets.instances).toHaveLength(1);
    });
    rig.update({ state: terminalState(PLAIN, { row: { kind: 'starting' } }) });
    expect(rig.fake.sockets.instances).toHaveLength(1);
  });

  it('shows the word of a registry state and no link to the monitor before a transcript is tracked', async () => {
    renderPane(terminalState(PLAIN, { row: { kind: 'registry', state: 'working', waitingFor: null } }));
    await regionOf(PLAIN);
    expect(document.querySelector('.badge--state')).not.toBeNull();
    expect(screen.queryByRole('link', { name: msg('workspace.session.openMonitor') })).toBeNull();
  });

  it('shows the monitor row: state, tokens, and the link to its page', async () => {
    const summary = makeSession({ id: sessionId(2) });
    renderPane(terminalState(LINKED, { row: { kind: 'monitor', summary } }));
    await regionOf(LINKED);
    expect(screen.getByRole('link', { name: msg('workspace.session.openMonitor') })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(2)}`,
    );
    expect(document.querySelector('.badge--state')).not.toBeNull();
    expect(screen.queryByText(msg('workspace.session.notLinked'))).toBeNull();
  });

  it('says why the monitor knows nothing yet', async () => {
    renderPane(terminalState(PLAIN, { row: { kind: 'starting' } }));
    await regionOf(PLAIN);
    expect(screen.getByText(msg('workspace.session.starting'))).toBeInTheDocument();
  });

  it('says how many windows watch it, only when there are several', async () => {
    const two = liveSessionOf(makeTerminalSession(1, { viewers: 2 }));
    const view = renderPane(terminalState(two));
    await regionOf(two);
    expect(screen.getByText(msg('workspace.session.viewers', { count: 2 }))).toBeInTheDocument();
    view.unmount();
    const one = liveSessionOf(makeTerminalSession(1, { viewers: 1 }));
    renderPane(terminalState(one));
    await regionOf(one);
    expect(screen.queryByText(/viewer/)).toBeNull();
  });

  it('asks the page to stop the session, and Redraw goes to the view', async () => {
    const user = userEvent.setup();
    const rig = renderPane(terminalState(PLAIN));
    await regionOf(PLAIN);
    await waitFor(() => {
      expect(rig.viewRef.current).not.toBeNull();
    });
    const handle = rig.viewRef.current;
    if (handle === null) throw new Error('the view did not mount');
    const redraw = vi.spyOn(handle, 'redraw');
    await user.click(screen.getByRole('button', { name: msg('workspace.pane.redraw') }));
    expect(redraw).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: msg('workspace.pane.stop') }));
    expect(rig.props.onStop).toHaveBeenCalledWith(PLAIN);
  });

  it('draws the toggle of the project list with its state and the list it controls', async () => {
    const user = userEvent.setup();
    const rig = renderPane(terminalState(PLAIN));
    await regionOf(PLAIN);
    const toggle = screen.getByRole('button', { name: msg('workspace.pane.toggleList') });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'project-list');
    await user.click(toggle);
    expect(rig.toggle).toHaveBeenCalledTimes(1);
  });

  it('has no toggle when the project column does not exist', async () => {
    renderPane(terminalState(PLAIN), { list: null });
    await regionOf(PLAIN);
    expect(screen.queryByRole('button', { name: msg('workspace.pane.toggleList') })).toBeNull();
  });

  it('keys the view by session: another name is another terminal', async () => {
    const rig = renderPane(terminalState(PLAIN));
    await regionOf(PLAIN);
    await waitFor(() => {
      expect(rig.fake.sockets.instances).toHaveLength(1);
    });
    rig.update({ state: terminalState(LINKED) });
    await regionOf(LINKED);
    await waitFor(() => {
      expect(rig.fake.sockets.instances).toHaveLength(2);
    });
  });
});

describe('the ended session (design D18)', () => {
  const ended = (over: Partial<EndedInfo> = {}): EndedInfo => ({
    name: LINKED.name,
    session: LINKED,
    exitCode: 3,
    killed: false,
    ...over,
  });

  it('keeps the terminal under a banner with the exit code, and hides Stop and Redraw', async () => {
    renderPane(terminalState(LINKED, { ended: ended() }));
    await regionOf(LINKED);
    const banner = screen.getByRole('region', { name: msg('terminal.ended.title') });
    expect(within(banner).getByText(msg('terminal.ended.exitCode', { code: 3 }))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('workspace.pane.stop') })).toBeNull();
    expect(screen.queryByRole('button', { name: msg('workspace.pane.redraw') })).toBeNull();
  });

  it.each([
    [{ exitCode: null, killed: true }, 'terminal.ended.killed'],
    [{ exitCode: null, killed: false }, 'terminal.ended.exited'],
  ] as const)('words an ending without a code: %j', async (over, key) => {
    renderPane(terminalState(LINKED, { ended: ended(over) }));
    await regionOf(LINKED);
    const banner = screen.getByRole('region', { name: msg('terminal.ended.title') });
    expect(within(banner).getByText(msg(key))).toBeInTheDocument();
  });

  it('starts again in the folder and resumes the conversation', async () => {
    const user = userEvent.setup();
    const rig = renderPane(terminalState(LINKED, { ended: ended() }));
    await regionOf(LINKED);
    await user.click(screen.getByRole('button', { name: msg('terminal.ended.startAgain') }));
    expect(rig.props.onStartAgain).toHaveBeenCalledWith(LINKED);
    await user.click(screen.getByRole('button', { name: msg('terminal.ended.resume') }));
    expect(rig.props.onResume).toHaveBeenCalledWith(sessionId(2));
  });

  it('offers no resume for a session that never reached a transcript', async () => {
    renderPane(terminalState(PLAIN, { ended: { name: PLAIN.name, session: PLAIN, exitCode: 0, killed: false } }));
    await regionOf(PLAIN);
    expect(screen.queryByRole('button', { name: msg('terminal.ended.resume') })).toBeNull();
    expect(screen.getByRole('button', { name: msg('terminal.ended.startAgain') })).toBeInTheDocument();
  });
});

describe('the locked state (design 4.5, TC-UI-10)', () => {
  const locked = (outcome: AccessOutcome = IDLE): PaneState<AccessOutcome> => ({ kind: 'locked', outcome });

  it('names the command that prints a new link, and says the monitor pages keep working', () => {
    const { container } = renderPane(locked());
    expect(screen.getByRole('heading', { level: 1, name: msg('access.locked.title') })).toBeInTheDocument();
    expect(container.querySelector('code')?.textContent).toBe(ACCESS_COMMAND);
    expect(screen.getByText(msg('access.locked.monitor'))).toBeInTheDocument();
  });

  it('sends a pasted bare code once and clears the field', async () => {
    const user = userEvent.setup();
    const rig = renderPane(locked());
    const field = screen.getByLabelText(msg('access.field.label'));
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(field, `  ${accessCode(1)}  `);
    await user.click(screen.getByRole('button', { name: msg('access.field.submit') }));
    expect(rig.submit).toHaveBeenCalledTimes(1);
    expect(rig.submit).toHaveBeenCalledWith(accessCode(1));
    expect(field).toHaveValue('');
  });

  it('takes the whole printed link and sends only its code', async () => {
    const user = userEvent.setup();
    const rig = renderPane(locked());
    await user.type(
      screen.getByLabelText(msg('access.field.label')),
      `http://127.0.0.1:18123/${accessHash(accessCode(2))}`,
    );
    await user.keyboard('{Enter}');
    expect(rig.submit).toHaveBeenCalledWith(accessCode(2));
  });

  it('sends nothing for text that is no link and no code, and says so', async () => {
    const user = userEvent.setup();
    const rig = renderPane(locked());
    await user.type(screen.getByLabelText(msg('access.field.label')), 'not a code');
    await user.click(screen.getByRole('button', { name: msg('access.field.submit') }));
    expect(rig.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(msg('access.error.format'));
    expect(screen.getByLabelText(msg('access.field.label'))).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the submit button disabled while the field is empty', () => {
    renderPane(locked());
    expect(screen.getByRole('button', { name: msg('access.field.submit') })).toBeDisabled();
  });

  it.each([
    [{ kind: 'cookie-not-kept' }, msg('access.error.cookie')],
    [{ kind: 'invalid' }, msg('access.error.invalid', { command: ACCESS_COMMAND })],
    [{ kind: 'rate-limited', retryAfterMs: 12_300 }, msg('access.error.rateLimited', { seconds: 13 })],
  ] as const)('says what happened after the exchange: %j', (outcome, text) => {
    renderPane(locked(outcome));
    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(screen.getByLabelText(msg('access.field.label'))).toBeInTheDocument();
  });

  it('says that the code could not be checked after another failure', () => {
    renderPane(locked({ kind: 'failed', error: networkError() }));
    expect(screen.getByRole('alert').textContent.startsWith('The code could not be checked: ')).toBe(true);
  });

  it('disables the form while the code is being checked', () => {
    renderPane(locked({ kind: 'exchanging' }));
    expect(screen.getByRole('button', { name: msg('access.field.checking') })).toBeDisabled();
  });

  it('declares its method, so that an early submit never puts the code in the address', () => {
    const { container } = renderPane(locked());
    expect(container.querySelector('form')).toHaveAttribute('method', 'post');
  });
});

describe('accessibility', () => {
  async function violations(container: HTMLElement): Promise<string[]> {
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  for (const locale of ['en', 'vi'] as const) {
    it(`TC-UI-11 has no axe violation in the locked, ended and live states (${locale})`, async () => {
      const locked = renderPane({ kind: 'locked', outcome: { kind: 'invalid' } }, {}, locale);
      expect(await violations(locked.container)).toEqual([]);
      locked.unmount();

      const ended = renderPane(
        terminalState(LINKED, { ended: { name: LINKED.name, session: LINKED, exitCode: 1, killed: false } }),
        {},
        locale,
      );
      await regionOf(LINKED, locale);
      expect(await violations(ended.container)).toEqual([]);
      ended.unmount();

      const live = renderPane(
        terminalState(LINKED, { row: { kind: 'monitor', summary: makeSession({ id: sessionId(2) }) } }),
        {},
        locale,
      );
      await regionOf(LINKED, locale);
      await act(async () => {
        await Promise.resolve();
      });
      expect(await violations(live.container)).toEqual([]);
    });
  }
});
