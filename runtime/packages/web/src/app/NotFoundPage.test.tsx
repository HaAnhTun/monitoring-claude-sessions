import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';

function Where() {
  const location = useLocation();
  return <span data-testid="where" data-path={location.pathname} />;
}

function renderAt(path: string, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(
    <>
      <Where />
      <Routes>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>,
    { route: path, locale },
  );
}

afterEach(() => {
  document.title = '';
});

describe('NotFoundPage', () => {
  it('names the page, quotes the requested path as text and sets the document title', () => {
    renderAt('/no/such/page');
    expect(screen.getByRole('heading', { level: 1, name: msg('notFound.title') })).toBeInTheDocument();
    const code = screen.getByText('/no/such/page');
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement).toHaveTextContent(msg('notFound.body', { path: '/no/such/page' }));
    expect(document.title).toBe(`${msg('notFound.documentTitle')} - Claude session monitor`);
  });

  it('shows a hostile path as plain text, never as markup', () => {
    const { container } = renderAt('/<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.children).toHaveLength(0);
    expect(code?.textContent).toContain('onerror=alert(1)');
    expect(code?.textContent.startsWith('/')).toBe(true);
  });

  it('makes the primary button the first stop after the heading and opens the Overview with it', async () => {
    const user = userEvent.setup();
    renderAt('/gone');
    const heading = screen.getByRole('heading', { level: 1 });
    heading.focus();
    await user.tab();
    const primary = screen.getByRole('button', { name: msg('notFound.openOverview') });
    expect(primary).toHaveFocus();
    expect(primary).toHaveClass('btn-primary');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveAttribute('data-path', '/');
  });

  it('links to the sessions list as the second stop', async () => {
    const user = userEvent.setup();
    renderAt('/gone');
    const link = screen.getByRole('link', { name: msg('notFound.openSessions') });
    expect(link).toHaveAttribute('href', '/sessions');
    screen.getByRole('heading', { level: 1 }).focus();
    await user.tab();
    await user.tab();
    expect(link).toHaveFocus();
  });

  it('has one primary button and the heading can take focus', () => {
    const { container } = renderAt('/gone');
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
  });

  it('is not a live region: the page is the announcement', () => {
    renderAt('/gone');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is worded in Vietnamese', () => {
    renderAt('/gone', 'vi');
    expect(screen.getByRole('heading', { level: 1, name: msg('notFound.title', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('notFound.openOverview', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('notFound.openSessions', undefined, 'vi') })).toBeInTheDocument();
    expect(document.title).toBe(`${msg('notFound.documentTitle', undefined, 'vi')} - Claude session monitor`);
  });
});
