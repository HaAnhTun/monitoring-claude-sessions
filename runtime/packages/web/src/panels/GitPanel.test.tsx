import type { PanelDataMap } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso, makePanelData } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { GitPanel } from './GitPanel.tsx';

type Git = PanelDataMap['git'];

function git(over: Partial<Git> = {}): Git {
  return { ...makePanelData('git'), ...over };
}

function show(data: Git, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(<GitPanel data={data} sources={[]} />, { locale });
}

describe('GitPanel', () => {
  it('shows the branch and a clean tree', () => {
    show(git({ branch: 'fixture-branch', dirty: 0 }));
    expect(screen.getByText('fixture-branch')).toHaveClass('mono');
    expect(screen.getByText(msg('panels.git.uncommitted', { count: 0 }))).toBeInTheDocument();
  });

  it('counts the uncommitted changes with the plural of the language', () => {
    const { unmount } = show(git({ dirty: 1 }));
    expect(screen.getByText(msg('panels.git.uncommitted', { count: 1 }))).toBeInTheDocument();
    unmount();
    show(git({ dirty: 7 }));
    expect(screen.getByText(msg('panels.git.uncommitted', { count: 7 }))).toHaveAttribute('data-dirty', 'true');
  });

  it('says that the count is not available when Git could not tell, never zero', () => {
    show(git({ dirty: null }));
    expect(screen.getByText(msg('panels.git.uncommittedUnknown'))).toBeInTheDocument();
    expect(screen.queryByText(msg('panels.git.uncommitted', { count: 0 }))).not.toBeInTheDocument();
  });

  it('shows the STOP file as a status alert only when it exists', () => {
    const { unmount } = show(git({ stopFile: false }));
    expect(screen.queryByText(msg('panels.git.stopFile'))).not.toBeInTheDocument();
    unmount();
    show(git({ stopFile: true }));
    expect(screen.getByRole('status')).toHaveTextContent(msg('panels.git.stopFile'));
  });

  it('lists the commits with a short hash, the subject as text and the age', () => {
    show(
      git({
        commits: [
          { hash: 'abcdef0123456789', subject: '<img src=x onerror=alert(1)> FIXTURE subject', at: iso(-3600) },
          { hash: '1234567890abcdef', subject: 'FIXTURE second', at: null },
        ],
      }),
    );
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('abcdef0');
    expect(items[0]).toHaveTextContent('<img src=x onerror=alert(1)> FIXTURE subject');
    expect(list.querySelector('img')).toBeNull();
    expect(items[0]?.querySelector('time')).not.toBeNull();
    expect(items[1]?.querySelector('time')).toBeNull();
  });

  it('says that there are no commits', () => {
    show(git({ commits: [] }));
    expect(screen.getByText(msg('panels.git.noCommits'))).toBeInTheDocument();
  });

  it('names a detached head by its short id', () => {
    show(git({ branch: null, detached: true, headOid: 'abcdef0123456789' }));
    expect(screen.getByText(msg('panels.git.detached', { oid: 'abcdef0' }))).toBeInTheDocument();
  });

  it('says that there is no branch', () => {
    show(git({ branch: null, detached: false, headOid: null }));
    expect(screen.getByText(msg('panels.git.noBranch'))).toBeInTheDocument();
  });

  it('explains a folder that is not a repository, a missing Git and a Git error instead of empty facts', () => {
    for (const state of ['not_a_repository', 'git_missing', 'error'] as const) {
      const { unmount } = show(git({ repoState: state, branch: null, dirty: null, commits: [] }));
      expect(screen.getByText(msg(`panels.git.state.${state}`))).toBeInTheDocument();
      expect(screen.queryByText(msg('panels.git.commits'))).not.toBeInTheDocument();
      unmount();
    }
  });

  it('is translated', () => {
    show(git({ dirty: 3 }), 'vi');
    expect(screen.getByText(msg('panels.git.uncommitted', { count: 3 }, 'vi'))).toBeInTheDocument();
  });
});
