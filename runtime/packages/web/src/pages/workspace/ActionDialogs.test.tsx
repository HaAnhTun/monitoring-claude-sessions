import type { ResumeEligibility } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { liveSessionOf, type LiveSession } from '../../lib/workspace-view.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  makeAuthSession,
  makeFolder,
  makeInstance,
  makeResumeEligibility,
  makeTerminalSession,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { FolderPathDialog, NewSessionDialog, ResumeDialog, StopSessionDialog } from './ActionDialogs.tsx';

function fakeApi(handlers: FakeHandlers = {}): FakeApi {
  return createFakeApi({ instance: () => makeInstance(), authSession: () => makeAuthSession(true), ...handlers });
}

/** The words of a failure inside a sentence: the catalogue sentence without its closing full stop. */
const reason = (text: string): string => text.replace(/[. ]+$/u, '');

const cancelButton = (): HTMLElement => screen.getByRole('button', { name: msg('workspace.dialog.cancel') });
const buttonNames = (): (string | null)[] => screen.getAllByRole('button').map((button) => button.textContent);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const FOLDER = { name: 'FIXTURE app', path: '/fixture/projects/app-1', known: true };
const LIVE: LiveSession = liveSessionOf(makeTerminalSession(1));

/** A page with an opener button, the way the dialogs are used: the page owns what is open. */
function Opener({ children }: { children: (open: boolean, close: () => void) => ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Opener
      </button>
      {children(open, () => {
        setOpen(false);
      })}
    </>
  );
}

describe('NewSessionDialog', () => {
  it('renders nothing while there is no folder', () => {
    renderWithIntl(<NewSessionDialog target={null} onCancel={() => undefined} onStarted={() => undefined} />, {
      api: fakeApi(),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('TC-UI-05 asks before it starts: the folder name and path, Start session, the focus on Cancel', () => {
    renderWithIntl(<NewSessionDialog target={FOLDER} onCancel={() => undefined} onStarted={() => undefined} />, {
      api: fakeApi(),
    });
    const dialog = screen.getByRole('dialog', { name: msg('workspace.dialog.new.title') });
    expect(within(dialog).getByText(msg('workspace.dialog.new.body'))).toBeInTheDocument();
    expect(within(dialog).getByText(FOLDER.name)).toBeInTheDocument();
    expect(within(dialog).getByText(FOLDER.path)).toBeInTheDocument();
    expect(cancelButton()).toHaveFocus();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel'), msg('workspace.dialog.new.confirm')]);
  });

  it('TC-UI-02 starts a known folder with one create request and hands the session to the page', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const created = makeTerminalSession(1);
    const api = fakeApi({ terminalCreateSession: () => ({ session: created }) });
    renderWithIntl(<NewSessionDialog target={FOLDER} onCancel={() => undefined} onStarted={onStarted} />, { api });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    await waitFor(() => {
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
    expect(onStarted).toHaveBeenCalledWith(liveSessionOf(created));
    expect(api.callsTo('terminalCreateSession')).toHaveLength(1);
    expect(api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: FOLDER.path });
    expect(api.callsTo('addFolder')).toHaveLength(0);
  });

  it('TC-UI-03 adds a folder from the picker first, then starts in the path the server gave back', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const api = fakeApi({
      addFolder: () => makeFolder(9, { path: '/fixture/normalised/app-9' }),
      terminalCreateSession: () => ({ session: makeTerminalSession(9) }),
    });
    renderWithIntl(
      <NewSessionDialog
        target={{ name: 'FIXTURE picked', path: '/fixture/picked', known: false }}
        onCancel={() => undefined}
        onStarted={onStarted}
      />,
      { api },
    );
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    await waitFor(() => {
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
    expect(api.callsTo('addFolder')[0]?.body).toEqual({ path: '/fixture/picked' });
    expect(api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: '/fixture/normalised/app-9' });
  });

  it('TC-UI-05 waits while the request runs: the busy words, no second request, no cancel', async () => {
    const user = userEvent.setup();
    const gate = deferred<{ session: ReturnType<typeof makeTerminalSession> }>();
    const onCancel = vi.fn();
    const api = fakeApi({ terminalCreateSession: () => gate.promise });
    renderWithIntl(<NewSessionDialog target={FOLDER} onCancel={onCancel} onStarted={() => undefined} />, { api });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    const busy = await screen.findByRole('button', { name: msg('workspace.dialog.busy') });
    expect(busy).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    expect(api.callsTo('terminalCreateSession')).toHaveLength(1);
    await act(async () => {
      gate.resolve({ session: makeTerminalSession(1) });
      await gate.promise;
    });
  });

  it('TC-UI-05 shows a failure inside the dialog, keeps it open and lets the person try again', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const onCancel = vi.fn();
    const api = fakeApi({ terminalCreateSession: () => errorResponse('terminal_limit') });
    renderWithIntl(<NewSessionDialog target={FOLDER} onCancel={onCancel} onStarted={onStarted} />, { api });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      msg('workspace.error.create', { detail: reason(msg('error.handling.terminalLimit')) }),
    );
    expect(onStarted).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    api.handlers.terminalCreateSession = () => ({ session: makeTerminalSession(1) });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    await waitFor(() => {
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
  });

  it('TC-UI-05 cancels on Escape', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderWithIntl(<NewSessionDialog target={FOLDER} onCancel={onCancel} onStarted={() => undefined} />, {
      api: fakeApi(),
    });
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('forgets the failure of an earlier try when it is opened again', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ terminalCreateSession: () => errorResponse('terminal_limit') });
    renderWithIntl(
      <Opener>
        {(open, close) => (
          <NewSessionDialog target={open ? FOLDER : null} onCancel={close} onStarted={() => undefined} />
        )}
      </Opener>,
      { api },
    );
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    await screen.findByRole('alert');
    await user.click(cancelButton());
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('StopSessionDialog', () => {
  it('renders nothing while there is no session', () => {
    renderWithIntl(<StopSessionDialog session={null} onCancel={() => undefined} onStopped={() => undefined} />, {
      api: fakeApi(),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('TC-UI-05 names the session, marks the action as dangerous and puts the focus on Cancel', () => {
    renderWithIntl(<StopSessionDialog session={LIVE} onCancel={() => undefined} onStopped={() => undefined} />, {
      api: fakeApi(),
    });
    const dialog = screen.getByRole('dialog', { name: msg('workspace.dialog.stop.title') });
    expect(dialog).toHaveClass('dialog--danger');
    expect(within(dialog).getByText(msg('workspace.dialog.stop.body'))).toBeInTheDocument();
    expect(within(dialog).getByText(LIVE.name)).toBeInTheDocument();
    expect(within(dialog).getByText(LIVE.path)).toBeInTheDocument();
    expect(cancelButton()).toHaveFocus();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel'), msg('workspace.dialog.stop.confirm')]);
  });

  it('TC-UI-05 stops the session on confirm and tells the page which one', async () => {
    const user = userEvent.setup();
    const onStopped = vi.fn();
    const api = fakeApi({ terminalKillSession: () => ({ name: LIVE.name }) });
    renderWithIntl(<StopSessionDialog session={LIVE} onCancel={() => undefined} onStopped={onStopped} />, { api });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.stop.confirm') }));
    await waitFor(() => {
      expect(onStopped).toHaveBeenCalledWith(LIVE.name);
    });
    expect(api.callsTo('terminalKillSession')[0]?.params).toEqual({ name: LIVE.name });
  });

  it('counts a session that was already gone as stopped', async () => {
    const user = userEvent.setup();
    const onStopped = vi.fn();
    const api = fakeApi({ terminalKillSession: () => errorResponse('terminal_not_found') });
    renderWithIntl(<StopSessionDialog session={LIVE} onCancel={() => undefined} onStopped={onStopped} />, { api });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.stop.confirm') }));
    await waitFor(() => {
      expect(onStopped).toHaveBeenCalledWith(LIVE.name);
    });
  });

  it('TC-UI-05 shows a failure as a notice and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const onStopped = vi.fn();
    const api = fakeApi({ terminalKillSession: () => errorResponse('internal_error') });
    renderWithIntl(<StopSessionDialog session={LIVE} onCancel={() => undefined} onStopped={onStopped} />, { api });
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.stop.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(msg('workspace.error.stop', { detail: '' }).trim().slice(0, 20));
    expect(onStopped).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('TC-UI-05 gives the focus back to the button that opened it', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <Opener>
        {(open, close) => <StopSessionDialog session={open ? LIVE : null} onCancel={close} onStopped={close} />}
      </Opener>,
      { api: fakeApi() },
    );
    const opener = screen.getByRole('button', { name: 'Opener' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    await user.click(opener);
    await user.click(cancelButton());
    expect(opener).toHaveFocus();
  });
});

describe('ResumeDialog', () => {
  const SID = sessionId(1);

  function renderResume(
    eligibility: ResumeEligibility | Response | (() => Promise<ResumeEligibility>),
    extra: Partial<Parameters<typeof ResumeDialog>[0]> = {},
    handlers: FakeHandlers = {},
  ) {
    const api = fakeApi({
      sessionResume: () => (typeof eligibility === 'function' ? eligibility() : eligibility),
      ...handlers,
    });
    const props = { onCancel: vi.fn(), onResumed: vi.fn(), ...extra };
    const rendered = renderWithIntl(<ResumeDialog sessionId={SID} {...props} />, { api });
    return { ...rendered, api, props };
  }

  it('renders nothing and asks nothing without a session id', () => {
    const api = fakeApi({ sessionResume: () => makeResumeEligibility(1) });
    renderWithIntl(<ResumeDialog sessionId={null} onCancel={() => undefined} onResumed={() => undefined} />, { api });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('sessionResume')).toHaveLength(0);
  });

  it('TC-UI-05 checks first: says so, offers only Cancel and nothing to confirm', async () => {
    const gate = deferred<ResumeEligibility>();
    renderResume(() => gate.promise);
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.resume.title') });
    expect(within(dialog).getByText(msg('workspace.dialog.resume.checking'))).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel')]);
    await act(async () => {
      gate.resolve(makeResumeEligibility(1));
      await gate.promise;
    });
  });

  it('TC-UI-05 offers Resume session when the session can be resumed, with the folder it starts in', async () => {
    const user = userEvent.setup();
    const created = makeTerminalSession(1);
    const { api, props } = renderResume(makeResumeEligibility(1), {}, { terminalResume: () => ({ session: created }) });
    const body = await screen.findByText(msg('workspace.dialog.resume.body'));
    expect(body).toBeInTheDocument();
    expect(screen.getByText('/fixture/projects/app-1')).toBeInTheDocument();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel'), msg('workspace.dialog.resume.confirm')]);
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.resume.confirm') }));
    await waitFor(() => {
      expect(props.onResumed).toHaveBeenCalledWith(liveSessionOf(created));
    });
    expect(api.callsTo('terminalResume')[0]?.body).toEqual({ sessionId: SID, fork: false });
  });

  it('names the session that continued this one', async () => {
    renderResume(makeResumeEligibility(1, { redirectTo: sessionId(2) }));
    expect(await screen.findByText(msg('workspace.dialog.resume.redirect'))).toBeInTheDocument();
  });

  it('shows no continuation line when there is none', async () => {
    renderResume(makeResumeEligibility(1));
    await screen.findByText(msg('workspace.dialog.resume.body'));
    expect(screen.queryByText(msg('workspace.dialog.resume.redirect'))).toBeNull();
  });

  it('TC-UI-05 warns about a session open elsewhere and offers only a copy', async () => {
    const user = userEvent.setup();
    const created = makeTerminalSession(1);
    const { api, props } = renderResume(
      makeResumeEligibility(1, { allowed: false, liveElsewhere: true, forkAllowed: true, reason: 'live_elsewhere' }),
      {},
      { terminalResume: () => ({ session: created }) },
    );
    expect(await screen.findByText(msg('workspace.dialog.resume.elsewhere'))).toBeInTheDocument();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel'), msg('workspace.dialog.resume.fork')]);
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.resume.fork') }));
    await waitFor(() => {
      expect(props.onResumed).toHaveBeenCalledTimes(1);
    });
    expect(api.callsTo('terminalResume')[0]?.body).toEqual({ sessionId: SID, fork: true });
  });

  it('refuses a session open elsewhere when not even a copy is allowed', async () => {
    renderResume(
      makeResumeEligibility(1, { allowed: false, liveElsewhere: true, forkAllowed: false, reason: 'live_elsewhere' }),
    );
    expect(
      await screen.findByText(
        msg('workspace.dialog.resume.refused', { reason: msg('workspace.resume.reason.live_elsewhere') }),
      ),
    ).toBeInTheDocument();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel')]);
  });

  it('TC-UI-05 points to the terminal of this app that already runs the session', async () => {
    const user = userEvent.setup();
    const { props } = renderResume(
      makeResumeEligibility(1, {
        allowed: false,
        forkAllowed: false,
        reason: 'live_in_terminal',
        liveTerminal: 'fixture-term-1',
      }),
    );
    expect(await screen.findByText(msg('workspace.dialog.resume.inTerminal'))).toBeInTheDocument();
    const link = screen.getByRole('link', { name: msg('workspace.dialog.resume.show') });
    expect(link).toHaveAttribute('href', '/?session=fixture-term-1');
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel')]);
    await user.click(link);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('says that a session is in a terminal without a link when the terminal is not named', async () => {
    renderResume(
      makeResumeEligibility(1, { allowed: false, forkAllowed: false, reason: 'live_in_terminal', liveTerminal: null }),
    );
    expect(await screen.findByText(msg('workspace.dialog.resume.inTerminal'))).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each(['transcript_gone', 'folder_missing', 'folder_unknown'] as const)(
    'TC-UI-05 refuses with the words of the reason %s and offers only Cancel',
    async (why) => {
      renderResume(makeResumeEligibility(1, { allowed: false, forkAllowed: false, reason: why }));
      expect(
        await screen.findByText(
          msg('workspace.dialog.resume.refused', { reason: msg(`workspace.resume.reason.${why}`) }),
        ),
      ).toBeInTheDocument();
      expect(buttonNames()).toEqual([msg('workspace.dialog.cancel')]);
    },
  );

  it('refuses in plain words when the server gave no reason', async () => {
    renderResume(makeResumeEligibility(1, { allowed: false, forkAllowed: false, reason: null }));
    expect(await screen.findByText(msg('error.handling.notResumable'))).toBeInTheDocument();
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel')]);
  });

  it('shows the failure of the check as an alert, with only Cancel', async () => {
    renderResume(errorResponse('session_not_found'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(msg('workspace.error.resume', { detail: '' }).trim().slice(0, 20));
    expect(buttonNames()).toEqual([msg('workspace.dialog.cancel')]);
  });

  it('TC-UI-05 shows the failure of the resume itself and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { props } = renderResume(
      makeResumeEligibility(1),
      {},
      { terminalResume: () => errorResponse('resume_unavailable') },
    );
    await user.click(await screen.findByRole('button', { name: msg('workspace.dialog.resume.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      msg('workspace.error.resume', { detail: reason(msg('error.handling.notResumable')) }),
    );
    expect(props.onResumed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('TC-UI-11 has no axe violation in any answer (en and vi)', async () => {
    const answers: ResumeEligibility[] = [
      makeResumeEligibility(1),
      makeResumeEligibility(1, { allowed: false, liveElsewhere: true, reason: 'live_elsewhere' }),
      makeResumeEligibility(1, {
        allowed: false,
        forkAllowed: false,
        reason: 'live_in_terminal',
        liveTerminal: 'fixture-term-1',
      }),
      makeResumeEligibility(1, { allowed: false, forkAllowed: false, reason: 'folder_missing' }),
    ];
    for (const locale of ['en', 'vi'] as const) {
      for (const answer of answers) {
        const api = fakeApi({ sessionResume: () => answer });
        const rendered = renderWithIntl(
          <ResumeDialog sessionId={SID} onCancel={() => undefined} onResumed={() => undefined} />,
          { api, locale },
        );
        await waitFor(() => {
          expect(screen.queryByText(msg('workspace.dialog.resume.checking', undefined, locale))).toBeNull();
        });
        const result = await axe.run(rendered.container, { rules: { 'color-contrast': { enabled: false } } });
        expect(
          result.violations.map((violation) => violation.id),
          `${locale} ${String(answer.reason)}`,
        ).toEqual([]);
        rendered.unmount();
      }
    }
  });
});

describe('FolderPathDialog', () => {
  const field = (): HTMLElement => screen.getByRole('textbox', { name: msg('workspace.dialog.folder.label') });

  it('renders nothing while it is closed', () => {
    renderWithIntl(<FolderPathDialog open={false} onCancel={() => undefined} onStarted={() => undefined} />, {
      api: fakeApi(),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains itself, labels the field and puts the focus in it', () => {
    renderWithIntl(<FolderPathDialog open onCancel={() => undefined} onStarted={() => undefined} />, {
      api: fakeApi(),
    });
    const dialog = screen.getByRole('dialog', { name: msg('workspace.dialog.folder.title') });
    expect(within(dialog).getByText(msg('workspace.dialog.folder.body'))).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute('placeholder', msg('workspace.dialog.folder.placeholder'));
    expect(field()).toHaveAttribute('spellcheck', 'false');
  });

  it('waits for a path: the confirm button is off while the field is empty', async () => {
    const user = userEvent.setup();
    renderWithIntl(<FolderPathDialog open onCancel={() => undefined} onStarted={() => undefined} />, {
      api: fakeApi(),
    });
    const confirm = screen.getByRole('button', { name: msg('workspace.dialog.folder.confirm') });
    expect(confirm).toBeDisabled();
    await user.type(field(), '   ');
    expect(confirm).toBeDisabled();
    await user.type(field(), '/fixture/typed');
    expect(confirm).toBeEnabled();
  });

  it('TC-UI-03 adds the typed folder, then starts in the path the server normalised', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const api = fakeApi({
      addFolder: () => makeFolder(4, { path: '/fixture/normalised/app-4' }),
      terminalCreateSession: () => ({ session: makeTerminalSession(4) }),
    });
    renderWithIntl(<FolderPathDialog open onCancel={() => undefined} onStarted={onStarted} />, { api });
    await user.type(field(), '/fixture/typed/app-4');
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.folder.confirm') }));
    await waitFor(() => {
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
    expect(api.callsTo('addFolder')[0]?.body).toEqual({ path: '/fixture/typed/app-4' });
    expect(api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: '/fixture/normalised/app-4' });
  });

  it('starts from the Enter key in the field', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const api = fakeApi({
      addFolder: () => makeFolder(4),
      terminalCreateSession: () => ({ session: makeTerminalSession(4) }),
    });
    renderWithIntl(<FolderPathDialog open onCancel={() => undefined} onStarted={onStarted} />, { api });
    await user.type(field(), '/fixture/typed/app-4{Enter}');
    await waitFor(() => {
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
  });

  it('does nothing on Enter while the field is empty', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithIntl(<FolderPathDialog open onCancel={() => undefined} onStarted={() => undefined} />, { api });
    await user.type(field(), '{Enter}');
    expect(api.callsTo('addFolder')).toHaveLength(0);
  });

  it('TC-UI-03 shows a folder the server refuses next to the field, starts nothing and clears the notice on the next key', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      addFolder: () => errorResponse('folder_invalid'),
      terminalCreateSession: () => ({ session: makeTerminalSession(1) }),
    });
    renderWithIntl(<FolderPathDialog open onCancel={() => undefined} onStarted={() => undefined} />, { api });
    await user.type(field(), '/fixture/missing');
    await user.click(screen.getByRole('button', { name: msg('workspace.dialog.folder.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      msg('workspace.error.create', { detail: reason(msg('error.handling.folderInvalid')) }),
    );
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(api.callsTo('terminalCreateSession')).toHaveLength(0);
    await user.type(field(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('forgets the typed path when it is closed and opened again', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <Opener>{(open, close) => <FolderPathDialog open={open} onCancel={close} onStarted={close} />}</Opener>,
      { api: fakeApi() },
    );
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    await user.type(field(), '/fixture/typed');
    await user.click(cancelButton());
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    expect(field()).toHaveValue('');
  });

  it('TC-UI-11 has no axe violation, open and with a failure (en and vi)', async () => {
    for (const locale of ['en', 'vi'] as const) {
      const user = userEvent.setup();
      const api = fakeApi({ addFolder: () => errorResponse('folder_invalid') });
      const rendered = renderWithIntl(
        <FolderPathDialog open onCancel={() => undefined} onStarted={() => undefined} />,
        { api, locale },
      );
      await user.type(
        screen.getByRole('textbox', { name: msg('workspace.dialog.folder.label', undefined, locale) }),
        '/fixture/x',
      );
      await user.click(screen.getByRole('button', { name: msg('workspace.dialog.folder.confirm', undefined, locale) }));
      await screen.findByRole('alert');
      const result = await axe.run(rendered.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        result.violations.map((violation) => violation.id),
        locale,
      ).toEqual([]);
      rendered.unmount();
    }
  });
});

describe('the other dialogs in both languages', () => {
  it('TC-UI-11 has no axe violation for the new-session and stop dialogs (en and vi)', async () => {
    for (const locale of ['en', 'vi'] as const) {
      const first = renderWithIntl(
        <NewSessionDialog target={FOLDER} onCancel={() => undefined} onStarted={() => undefined} />,
        { api: fakeApi(), locale },
      );
      const one = await axe.run(first.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        one.violations.map((violation) => violation.id),
        `new ${locale}`,
      ).toEqual([]);
      first.unmount();
      const second = renderWithIntl(
        <StopSessionDialog session={LIVE} onCancel={() => undefined} onStopped={() => undefined} />,
        { api: fakeApi(), locale },
      );
      const two = await axe.run(second.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        two.violations.map((violation) => violation.id),
        `stop ${locale}`,
      ).toEqual([]);
      second.unmount();
    }
  });
});
