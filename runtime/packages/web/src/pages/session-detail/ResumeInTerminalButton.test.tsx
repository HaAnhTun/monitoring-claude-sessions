import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { createFakeApi, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  makeAuthSession,
  makeInstance,
  makeLinkedTerminalSession,
  makeResumeEligibility,
  makeTerminalCapabilities,
  makeTerminalSession,
  makeTerminalState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { ResumeInTerminalButton } from './ResumeInTerminalButton.tsx';

const SID = sessionId(1);

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

interface Options {
  kind?: 'user' | 'task';
  authenticated?: boolean;
  state?: ReturnType<typeof makeTerminalState>;
  handlers?: FakeHandlers;
  locale?: 'en' | 'vi';
}

function setup(o: Options = {}) {
  const api: FakeApi = createFakeApi({
    instance: () => makeInstance({ kind: o.kind ?? 'user' }),
    authSession: () => makeAuthSession(o.authenticated ?? true),
    terminalState: () => o.state ?? makeTerminalState(),
    sessionResume: () => makeResumeEligibility(1),
    ...o.handlers,
  });
  const rendered = renderWithIntl(
    <>
      <ResumeInTerminalButton sessionId={SID} />
      <Where />
    </>,
    { api, instance: makeInstance({ kind: o.kind ?? 'user' }), locale: o.locale ?? 'en' },
  );
  return { ...rendered, api };
}

const resumeLabel = (): string => msg('detail.resume.action');

describe('ResumeInTerminalButton', () => {
  it('offers Resume in terminal on a user instance with a browser that holds the session', async () => {
    setup();
    expect(await screen.findByRole('button', { name: resumeLabel() })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: msg('detail.resume.open') })).toBeNull();
  });

  it('shows nothing and asks nothing on a task instance', async () => {
    const { api } = setup({ kind: 'task' });
    await Promise.resolve();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(api.callsTo('authSession')).toHaveLength(0);
    expect(api.callsTo('terminalState')).toHaveLength(0);
  });

  it('shows nothing, and does not ask for the terminal state, before the browser holds the session', async () => {
    const { api } = setup({ authenticated: false });
    await waitFor(() => {
      expect(api.callsTo('authSession')).toHaveLength(1);
    });
    await Promise.resolve();
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.callsTo('terminalState')).toHaveLength(0);
  });

  it('shows nothing while the terminal state is not loaded yet', () => {
    setup({ handlers: { terminalState: () => new Promise(() => undefined) } });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each([
    ['cannot resume', makeTerminalCapabilities({ resume: false })],
    ['is not available', makeTerminalCapabilities({ available: false, reason: 'unsupported_os', resume: true })],
  ])('shows nothing when the terminal %s', async (_name, capabilities) => {
    const { api } = setup({ state: makeTerminalState([], { capabilities }) });
    await waitFor(() => {
      expect(api.callsTo('terminalState')).toHaveLength(1);
    });
    await Promise.resolve();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says Open its terminal, as a link to it, when a terminal of this app already runs the session', async () => {
    setup({ state: makeTerminalState([makeTerminalSession(2), makeLinkedTerminalSession(1)]) });
    const link = await screen.findByRole('link', { name: msg('detail.resume.open') });
    expect(link).toHaveAttribute('href', '/?session=fixture-term-1');
    expect(screen.queryByRole('button', { name: resumeLabel() })).toBeNull();
  });

  it('is not fooled by a terminal that runs another session', async () => {
    setup({ state: makeTerminalState([makeLinkedTerminalSession(2)]) });
    expect(await screen.findByRole('button', { name: resumeLabel() })).toBeInTheDocument();
  });

  it('opens the resume dialog for this session and gives the focus back to the button', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const button = await screen.findByRole('button', { name: resumeLabel() });
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.resume.title') });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => {
      expect(api.callsTo('sessionResume')[0]?.params).toEqual({ sessionId: SID });
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('resumes the session and takes the person to its terminal', async () => {
    const user = userEvent.setup();
    const created = makeLinkedTerminalSession(1, { name: 'fixture-term-9' });
    const { api } = setup({ handlers: { terminalResume: () => ({ session: created }) } });
    await user.click(await screen.findByRole('button', { name: resumeLabel() }));
    await user.click(await screen.findByRole('button', { name: msg('workspace.dialog.resume.confirm') }));
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent('/?session=fixture-term-9');
    });
    expect(api.callsTo('terminalResume')[0]?.body).toEqual({ sessionId: SID, fork: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('TC-UI-11 has no axe violation as a button, with its dialog open, and as a link (en and vi)', async () => {
    for (const locale of ['en', 'vi'] as const) {
      const user = userEvent.setup();
      const button = setup({ locale });
      await user.click(await screen.findByRole('button', { name: msg('detail.resume.action', undefined, locale) }));
      await screen.findByRole('dialog');
      const one = await axe.run(button.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        one.violations.map((violation) => violation.id),
        `button ${locale}`,
      ).toEqual([]);
      button.unmount();
      const link = setup({ locale, state: makeTerminalState([makeLinkedTerminalSession(1)]) });
      await screen.findByRole('link', { name: msg('detail.resume.open', undefined, locale) });
      const two = await axe.run(link.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        two.violations.map((violation) => violation.id),
        `link ${locale}`,
      ).toEqual([]);
      link.unmount();
    }
  });
});
