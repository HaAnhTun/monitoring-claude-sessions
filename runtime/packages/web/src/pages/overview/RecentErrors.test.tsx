import type { ActivityEvent } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso, makeEvent, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { RECENT_ERRORS_CAP, RecentErrors } from './RecentErrors.tsx';

function error(n: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return makeEvent({
    id: n,
    seq: n,
    key: `t:fixture-error-${String(n)}`,
    sessionId: sessionId(n),
    sessionLabel: `FIXTURE session ${String(n)}`,
    at: iso(-n * 30),
    type: 'tool.failure',
    category: 'error',
    severity: 'error',
    summary: `FIXTURE failure ${String(n)}`,
    ...over,
  });
}

describe('RecentErrors', () => {
  it('lists the errors with a link to the session of each', () => {
    renderWithIntl(<RecentErrors events={[error(1), error(2)]} />);
    expect(screen.getByRole('heading', { level: 2, name: msg('overview.errors.title') })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: msg('overview.errors.list') });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [first] = items;
    if (first === undefined) throw new Error('no row');
    expect(within(first).getByText('FIXTURE failure 1')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'FIXTURE session 1' })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}`,
    );
  });

  it('draws the failed mark on each row', () => {
    renderWithIntl(<RecentErrors events={[error(1)]} />);
    expect(document.querySelector('.activity-row--error')).not.toBeNull();
  });

  it('shows at most ten', () => {
    const events = Array.from({ length: 14 }, (_unused, i) => error(i + 1));
    renderWithIntl(<RecentErrors events={events} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(RECENT_ERRORS_CAP);
    expect(RECENT_ERRORS_CAP).toBe(10);
  });

  it('links to the activity page filtered to errors', () => {
    renderWithIntl(<RecentErrors events={[error(1)]} />);
    expect(screen.getByRole('link', { name: msg('overview.errors.viewAll') })).toHaveAttribute(
      'href',
      '/activity?severity=error',
    );
  });

  it('says that there are no errors', () => {
    renderWithIntl(<RecentErrors events={[]} />);
    expect(screen.getByText(msg('overview.errors.empty'))).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('speaks Vietnamese', () => {
    renderWithIntl(<RecentErrors events={[]} />, { locale: 'vi' });
    expect(screen.getByRole('heading', { name: msg('overview.errors.title', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByText(msg('overview.errors.empty', undefined, 'vi'))).toBeInTheDocument();
  });
});
