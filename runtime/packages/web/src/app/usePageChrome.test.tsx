import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { documentTitleFor, usePageChrome } from './usePageChrome.ts';

const APP_TITLE = msg('shell.appTitle');

function Page({ title }: { title: string }) {
  const ref = usePageChrome(title);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {title}
    </h1>
  );
}

function Harness({ initial }: { initial: string }) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <nav>
        <Link to="/b">to b</Link>
        <Link to="/a?x=1">to a with search</Link>
      </nav>
      <main id="main">
        <Routes>
          <Route path="/a" element={<Page title="Page A" />} />
          <Route path="/b" element={<Page title="Page B" />} />
        </Routes>
      </main>
    </MemoryRouter>
  );
}

describe('documentTitleFor', () => {
  it('puts the page before the app name', () => {
    expect(documentTitleFor('Sessions', APP_TITLE)).toBe(`Sessions - ${APP_TITLE}`);
  });

  it('is the app name alone for an empty page title', () => {
    expect(documentTitleFor('', APP_TITLE)).toBe(APP_TITLE);
  });
});

describe('usePageChrome', () => {
  it('sets the title and leaves focus alone on the first load', () => {
    render(<Harness initial="/a" />);
    expect(document.title).toBe(`Page A - ${APP_TITLE}`);
    expect(document.activeElement).toBe(document.body);
  });

  it('focuses the heading and scrolls #main to the top on a pathname change', async () => {
    const scrollTo = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial="/a" />);
    const main = document.getElementById('main');
    if (main === null) throw new Error('main missing');
    main.scrollTo = scrollTo;
    await user.click(screen.getByRole('link', { name: 'to b' }));
    expect(screen.getByRole('heading', { name: 'Page B' })).toHaveFocus();
    expect(document.title).toBe(`Page B - ${APP_TITLE}`);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('does not move focus when only the search part changes', async () => {
    const user = userEvent.setup();
    render(<Harness initial="/a" />);
    const heading = screen.getByRole('heading', { name: 'Page A' });
    const main = document.getElementById('main');
    if (main === null) throw new Error('main missing');
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo;
    await user.click(screen.getByRole('link', { name: 'to a with search' }));
    expect(heading).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('puts the application name of the language that is shown after the page name', () => {
    const page = msg('route.sessions.title', undefined, 'vi');
    renderWithIntl(<Page title={page} />, { locale: 'vi' });
    expect(document.title).toBe(`${page} - ${msg('shell.appTitle', undefined, 'vi')}`);
  });
});
