import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../data/api-errors.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { TerminalNotice, type NoticeState, type TerminalNoticeProps } from './TerminalNotice.tsx';

// Design 04 6.3 and 8.1: what the pane says when there is no terminal to show. Every state is the one heading of the page (an
// `h1`), so a screen reader lands on it after a navigation. TC-UI-10: the three reasons terminals cannot run.

function renderNotice(state: NoticeState, props: Partial<TerminalNoticeProps> = {}, locale: 'en' | 'vi' = 'en') {
  const headingRef = createRef<HTMLHeadingElement>();
  const onRetry = vi.fn<() => void>();
  const rendered = renderWithIntl(
    <TerminalNotice state={state} headingRef={headingRef} onRetry={onRetry} {...props} />,
    { locale },
  );
  return { ...rendered, headingRef, onRetry };
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

describe('TerminalNotice', () => {
  it('says that projects are loading, as the heading, and attaches the heading ref', () => {
    const { headingRef } = renderNotice({ kind: 'loading' });
    const heading = screen.getByRole('heading', { level: 1, name: msg('workspace.loading') });
    expect(headingRef.current).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('names nothing selected and says how to pick or start a session', () => {
    renderNotice({ kind: 'none-selected' });
    expect(screen.getByRole('heading', { level: 1, name: msg('workspace.pane.none.title') })).toBeInTheDocument();
    expect(screen.getByText(msg('workspace.pane.none.body'))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers "Other folder" as the one primary button and the list toggle only when the column is hidden', async () => {
    const user = userEvent.setup();
    const onOtherFolder = vi.fn<() => void>();
    const onOpenList = vi.fn<() => void>();
    renderNotice({ kind: 'none-selected' }, { onOtherFolder, onOpenList });
    const primary = screen.getByRole('button', { name: msg('workspace.otherFolder') });
    expect(primary).toHaveClass('btn-primary');
    expect(screen.getAllByRole('button').filter((button) => button.classList.contains('btn-primary'))).toHaveLength(1);
    await user.click(primary);
    await user.click(screen.getByRole('button', { name: msg('workspace.pane.toggleList') }));
    expect(onOtherFolder).toHaveBeenCalledTimes(1);
    expect(onOpenList).toHaveBeenCalledTimes(1);
  });

  it('says that a session is not running, with its name as text, and links to the bare workspace', () => {
    const { container } = renderNotice({ kind: 'not-found', name: 'fixture-term-9' });
    expect(screen.getByRole('heading', { level: 1, name: msg('workspace.pane.notFound.title') })).toBeInTheDocument();
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('fixture-term-9');
    expect(screen.getByRole('link', { name: msg('route.workspace.title') })).toHaveAttribute('href', '/');
  });

  it('shows a name from the address as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = renderNotice({ kind: 'not-found', name: hostile });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(hostile);
    expect(container.querySelector('code')?.children).toHaveLength(0);
  });

  it.each([
    ['unsupported_os', 'os'],
    ['addon_missing', 'addon'],
    ['claude_not_found', 'claude'],
  ] as const)('TC-UI-10 says why terminals are unavailable: %s', (reason, id) => {
    renderNotice({ kind: 'unavailable', reason });
    const title = `terminal.unavailable.${id}.title` as const;
    const body = `terminal.unavailable.${id}.body` as const;
    expect(screen.getByRole('heading', { level: 1, name: msg(title) })).toBeInTheDocument();
    expect(screen.getByText(msg(body))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a failed first load with a retry, under one hidden heading', async () => {
    const user = userEvent.setup();
    const { onRetry, headingRef } = renderNotice({ kind: 'error', error: networkError() });
    const heading = screen.getByRole('heading', { level: 1, name: msg('route.workspace.title') });
    expect(heading).toHaveClass('sr-only');
    expect(headingRef.current).toBe(heading);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(msg('error.subject.workspace'));
    await user.click(within(alert).getByRole('button', { name: msg('common.retryNow') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('has exactly one h1 in every state', () => {
    const states: NoticeState[] = [
      { kind: 'loading' },
      { kind: 'none-selected' },
      { kind: 'not-found', name: 'fixture-term-1' },
      { kind: 'unavailable', reason: 'addon_missing' },
      { kind: 'error', error: networkError() },
    ];
    for (const state of states) {
      const { unmount } = renderNotice(state);
      expect(screen.getAllByRole('heading', { level: 1 }), state.kind).toHaveLength(1);
      unmount();
    }
  });

  for (const locale of ['en', 'vi'] as const) {
    it(`TC-UI-11 has no axe violation in any state (${locale})`, async () => {
      const states: NoticeState[] = [
        { kind: 'loading' },
        { kind: 'none-selected' },
        { kind: 'not-found', name: 'fixture-term-1' },
        { kind: 'unavailable', reason: 'claude_not_found' },
        { kind: 'error', error: networkError() },
      ];
      for (const state of states) {
        const { container, unmount } = renderNotice(state, { onOtherFolder: vi.fn(), onOpenList: vi.fn() }, locale);
        const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
        expect(
          result.violations.map((violation) => `${violation.id}: ${violation.help}`),
          state.kind,
        ).toEqual([]);
        unmount();
      }
    });
  }
});
