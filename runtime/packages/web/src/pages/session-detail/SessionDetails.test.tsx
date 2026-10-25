import type { SessionDetail } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { iso, makeSessionDetail, makeState, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionDetails } from './SessionDetails.tsx';

const EMPTY: Partial<SessionDetail> = {
  projectLabel: null,
  cwd: null,
  gitBranch: null,
  permissionMode: null,
  ccVersion: null,
  entrypoint: null,
  models: [],
  workItems: [],
  matched: true,
  labelSource: 'none',
  endedAt: null,
};

function labels(): string[] {
  return screen.getAllByRole('term', { hidden: true }).map((term) => term.textContent);
}

async function open() {
  await userEvent.click(screen.getByRole('button', { name: msg('detail.details') }));
}

describe('SessionDetails', () => {
  it('is closed until asked for', async () => {
    renderWithIntl(<SessionDetails session={makeSessionDetail({ cwd: '/FIXTURE/work' })} />);
    const toggle = screen.getByRole('button', { name: msg('detail.details') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('/FIXTURE/work')).not.toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/FIXTURE/work')).toBeVisible();
  });

  it('hides every field that has no value', async () => {
    renderWithIntl(<SessionDetails session={makeSessionDetail(EMPTY)} />);
    await open();
    expect(labels()).toEqual([
      msg('detail.details.sessionId'),
      msg('detail.details.provider'),
      msg('detail.details.started'),
      msg('detail.details.stateBasis'),
      msg('detail.details.stateRule'),
    ]);
    expect(screen.queryByText('-')).toBeNull();
  });

  it('treats an empty or blank text as no value', async () => {
    renderWithIntl(<SessionDetails session={makeSessionDetail({ ...EMPTY, cwd: '', gitBranch: '   ' })} />);
    await open();
    expect(labels()).not.toContain(msg('detail.details.cwd'));
    expect(labels()).not.toContain(msg('detail.details.branch'));
  });

  it('shows the fields that have a value', async () => {
    renderWithIntl(
      <SessionDetails
        session={makeSessionDetail({
          ...EMPTY,
          projectLabel: 'FIXTURE project',
          cwd: '/FIXTURE/work',
          gitBranch: 'fixture-branch',
          permissionMode: 'plan',
          ccVersion: '9.9.9',
          entrypoint: 'cli',
          models: ['fixture-model-a', 'fixture-model-b'],
          endedAt: iso(-10),
          state: makeState('completed', { endReason: 'normal' }),
        })}
      />,
    );
    await open();
    expect(labels()).toEqual([
      msg('detail.details.sessionId'),
      msg('detail.details.project'),
      msg('detail.details.provider'),
      msg('detail.details.version'),
      msg('detail.details.entrypoint'),
      msg('detail.details.models'),
      msg('detail.details.cwd'),
      msg('detail.details.branch'),
      msg('detail.details.permission'),
      msg('detail.details.started'),
      msg('detail.details.ended'),
      msg('detail.details.endReason'),
      msg('detail.details.stateBasis'),
      msg('detail.details.stateRule'),
    ]);
    expect(screen.getByText('FIXTURE project')).toBeInTheDocument();
    expect(screen.getByText('fixture-model-a, fixture-model-b')).toBeInTheDocument();
    expect(screen.getByText('normal')).toBeInTheDocument();
  });

  it('shows the whole session id with a button that copies it', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderWithIntl(<SessionDetails session={makeSessionDetail({ id: sessionId(7) })} />);
    await user.click(screen.getByRole('button', { name: msg('detail.details') }));
    expect(screen.getByText(sessionId(7))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('detail.details.copyId') }));
    expect(await navigator.clipboard.readText()).toBe(sessionId(7));
    vi.unstubAllGlobals();
  });

  it('says where the label came from, and not for a session without one', async () => {
    const { unmount } = renderWithIntl(<SessionDetails session={makeSessionDetail({ labelSource: 'rule' })} />);
    await open();
    expect(screen.getByText(msg('detail.details.label.rule'))).toBeInTheDocument();
    unmount();
    renderWithIntl(<SessionDetails session={makeSessionDetail({ labelSource: 'none' })} />);
    await open();
    expect(labels()).not.toContain(msg('detail.details.label'));
  });

  it('says that no project rule matched a session that is not in the list', async () => {
    renderWithIntl(<SessionDetails session={makeSessionDetail({ matched: false })} />);
    await open();
    expect(labels()).toContain(msg('detail.details.projectRule'));
    expect(screen.getByText(msg('detail.notInList.tip'))).toBeInTheDocument();
  });

  it('links each work item to the session list of that task, with its state in words', async () => {
    renderWithIntl(
      <SessionDetails
        session={makeSessionDetail({ workItems: [{ id: 7, title: 'FIXTURE work item', state: 'waiting' }] })}
      />,
    );
    await open();
    const link = screen.getByRole('link', { name: 'FIXTURE work item' });
    expect(link).toHaveAttribute('href', '/sessions?task=7');
    expect(link.closest('li')).toHaveTextContent(msg('state.board.waiting'));
  });

  it('puts the rule of the state and how it was decided in words here, not as raw values', async () => {
    renderWithIntl(
      <SessionDetails
        session={makeSessionDetail({
          state: makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }),
        })}
      />,
    );
    await open();
    expect(screen.getByText('S-7e')).toBeInTheDocument();
    const basis = screen.getByText(msg('detail.details.stateBasis')).closest('div');
    expect(basis).toHaveTextContent(msg('evidence.basis.inferredSilence'));
    expect(basis).toHaveTextContent(msg('evidence.confidence.medium'));
    expect(basis).not.toHaveTextContent('inferred ·');
  });

  it('holds the audit references and draws no section for a session without any', async () => {
    const { unmount } = renderWithIntl(<SessionDetails session={makeSessionDetail()} />);
    await open();
    expect(screen.queryByRole('region', { name: msg('detail.auditRefs.title') })).toBeNull();
    unmount();
    renderWithIntl(
      <SessionDetails
        session={makeSessionDetail({
          auditRefs: [{ file: 'decisions', at: iso(-100), title: 'FIXTURE decision title', summary: '' }],
        })}
      />,
    );
    await open();
    const section = screen.getByRole('region', { name: msg('detail.auditRefs.title') });
    expect(within(section).getByText('FIXTURE decision title')).toBeInTheDocument();
  });

  it('is worded in Vietnamese', async () => {
    renderWithIntl(<SessionDetails session={makeSessionDetail({ cwd: '/FIXTURE/work' })} />, { locale: 'vi' });
    await userEvent.click(screen.getByRole('button', { name: msg('detail.details', undefined, 'vi') }));
    expect(screen.getByText(msg('detail.details.cwd', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByText(msg('detail.details.sessionId', undefined, 'vi'))).toBeInTheDocument();
  });
});
