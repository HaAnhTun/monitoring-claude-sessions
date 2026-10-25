import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createFormatters } from '../../i18n/format.ts';
import { makeEvent, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../../test/render.tsx';
import { ActivityRow, SUMMARY_CLAMP_CHARS, type ActivityRowProps } from './ActivityRow.tsx';

function renderRow(props: ActivityRowProps, options: RenderOptions = {}) {
  return renderWithIntl(
    <ul>
      <ActivityRow {...props} />
    </ul>,
    options,
  );
}

describe('ActivityRow', () => {
  it('shows the time, type, category, summary, session link, agent and sources of an event', () => {
    renderRow({
      mode: 'page',
      event: makeEvent({
        id: 7,
        type: 'tool.call',
        category: 'tool',
        toolName: 'Bash',
        summary: 'FIXTURE ran the build',
        sessionLabel: 'FIXTURE build step A',
        agentLabel: 'FIXTURE reviewer',
        sources: ['hook', 'transcript'],
        source: 'hook',
      }),
    });
    const row = screen.getByRole('listitem');
    expect(row.querySelector('time')).toHaveAttribute('datetime');
    expect(within(row).getByText('tool.call')).toBeInTheDocument();
    expect(within(row).getByText('Bash')).toBeInTheDocument();
    expect(within(row).getByText('FIXTURE ran the build')).toBeInTheDocument();
    expect(within(row).getByText(msg('activity.category.tool'))).toBeInTheDocument();
    expect(within(row).getByText('FIXTURE reviewer')).toBeInTheDocument();
    expect(within(row).getByText(msg('activity.source.hook'))).toBeInTheDocument();
    expect(within(row).getByText(msg('activity.source.transcript'))).toBeInTheDocument();
    const link = within(row).getByRole('link', { name: 'FIXTURE build step A' });
    expect(link).toHaveAttribute('href', `/sessions/${sessionId(1)}`);
  });

  it('marks an info event with no severity word and no error bar', () => {
    renderRow({ mode: 'page', event: makeEvent({ severity: 'info' }) });
    const row = screen.getByRole('listitem');
    expect(row).not.toHaveClass('activity-row--error');
    expect(row).toHaveAttribute('data-severity', 'info');
    expect(within(row).queryByText(msg('activity.severity.warning'))).toBeNull();
    expect(within(row).queryByText(msg('activity.severity.error'))).toBeNull();
  });

  it('writes the word of a warning and of an error next to its icon, and gives an error the error bar', () => {
    const { unmount } = renderRow({ mode: 'page', event: makeEvent({ id: 2, severity: 'warning' }) });
    const warning = screen.getByRole('listitem');
    expect(within(warning).getByText(msg('activity.severity.warning'))).toBeInTheDocument();
    expect(warning).not.toHaveClass('activity-row--error');
    unmount();
    renderRow({ mode: 'page', event: makeEvent({ id: 3, severity: 'error' }) });
    const error = screen.getByRole('listitem');
    expect(within(error).getByText(msg('activity.severity.error'))).toBeInTheDocument();
    expect(error).toHaveClass('activity-row--error');
  });

  it('shows the status and the duration of a tool call', () => {
    renderRow({
      mode: 'page',
      event: makeEvent({ type: 'tool.result', toolName: 'Read', toolStatus: 'failed', durationMs: 2500 }),
    });
    expect(screen.getByText(msg('activity.toolStatus.failed'))).toBeInTheDocument();
    expect(screen.getByText(createFormatters('en').duration(2.5))).toBeInTheDocument();
  });

  it('shows a duration under a second in milliseconds', () => {
    renderRow({ mode: 'page', event: makeEvent({ toolName: 'Read', toolStatus: 'succeeded', durationMs: 420 }) });
    expect(screen.getByText(msg('activity.duration.ms', { value: 420 }))).toBeInTheDocument();
  });

  it('draws a monitor.gap event as a separator note, not as a row', () => {
    renderRow({
      mode: 'page',
      event: makeEvent({
        id: 9,
        type: 'monitor.gap',
        category: 'ingest',
        severity: 'warning',
        summary: 'FIXTURE hooks were off for 4 minutes',
      }),
    });
    const note = screen.getByRole('note');
    expect(note.closest('li')).toHaveClass('activity-row--gap');
    expect(note).toHaveTextContent(msg('activity.gap'));
    expect(note).toHaveTextContent('FIXTURE hooks were off for 4 minutes');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('draws a gap without a reason as the plain sentence', () => {
    renderRow({ mode: 'page', event: makeEvent({ type: 'monitor.gap', category: 'ingest', summary: '' }) });
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(msg('activity.gap'));
    expect(note.querySelector('.activity-row__gap-reason')).toBeNull();
  });

  it('shows a summary of up to 200 characters on one line with the whole text in the tooltip', () => {
    const summary = 'x'.repeat(SUMMARY_CLAMP_CHARS);
    renderRow({ mode: 'page', event: makeEvent({ summary }) });
    expect(screen.getByText(summary).closest('[title]')).toHaveAttribute('title', summary);
    expect(screen.queryByRole('button', { name: msg('common.showMore') })).toBeNull();
  });

  it('clamps a longer summary to 200 characters and expands it on request', async () => {
    const user = userEvent.setup();
    const summary = `${'y'.repeat(SUMMARY_CLAMP_CHARS)}TAIL`;
    renderRow({ mode: 'page', event: makeEvent({ summary }) });
    expect(screen.queryByText(/TAIL/)).toBeNull();
    const more = screen.getByRole('button', { name: msg('common.showMore') });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(screen.getByText(summary)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.showLess') })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders a summary as plain text, never as markup', () => {
    renderRow({ mode: 'page', event: makeEvent({ summary: '<img src=x onerror=alert(1)> **bold**' }) });
    expect(screen.getByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('opens the details as key and value pairs and keeps their values as text', async () => {
    const user = userEvent.setup();
    renderRow({
      mode: 'page',
      event: makeEvent({ id: 12, details: { exitCode: 1, cwd: '/FIXTURE/work', note: null } }),
    });
    const toggle = screen.getByRole('button', { name: msg('activity.row.details') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent('exitCode');
    expect(panel).toHaveTextContent('1');
    expect(panel).toHaveTextContent('/FIXTURE/work');
    expect(panel).toHaveTextContent('note');
  });

  it('has no details button when the event has no details', () => {
    renderRow({ mode: 'page', event: makeEvent({ details: {} }) });
    expect(screen.queryByRole('button', { name: msg('activity.row.details') })).toBeNull();
  });

  it('compact mode keeps the line short: no details, no sources, no category', () => {
    renderRow({
      mode: 'compact',
      event: makeEvent({ details: { a: 'b' }, sources: ['hook'], source: 'hook', category: 'tool' }),
    });
    const row = screen.getByRole('listitem');
    expect(row).toHaveClass('activity-row--compact');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).queryByText(msg('activity.source.hook'))).toBeNull();
    expect(within(row).queryByText(msg('activity.category.tool'))).toBeNull();
    expect(within(row).getByRole('link')).toBeInTheDocument();
  });

  it('writes the words of the row in Vietnamese and marks the server text as English', () => {
    renderRow(
      {
        mode: 'page',
        event: makeEvent({
          severity: 'error',
          category: 'error',
          summary: 'FIXTURE the API returned 500',
          toolName: 'Bash',
          toolStatus: 'failed',
        }),
      },
      { locale: 'vi' },
    );
    expect(screen.getAllByText(msg('activity.severity.error', undefined, 'vi')).length).toBeGreaterThan(0);
    expect(screen.getByText(msg('activity.toolStatus.failed', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByText('FIXTURE the API returned 500')).toHaveAttribute('lang', 'en');
  });

  it('gives an element id that a link can target', () => {
    renderRow({ mode: 'page', event: makeEvent({ id: 41 }) });
    expect(screen.getByRole('listitem')).toHaveAttribute('id', 'ev-41');
  });
});
