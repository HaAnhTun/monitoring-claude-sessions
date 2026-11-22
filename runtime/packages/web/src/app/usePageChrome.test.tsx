import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** The data of the page below arrives when a test says so (a store, so that the page needs no state of its own to be told). */
const loading = {
  loaded: false,
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void): (() => void) => {
    loading.listeners.add(listener);
    return () => {
      loading.listeners.delete(listener);
    };
  },
  finish(): void {
    loading.loaded = true;
    for (const listener of loading.listeners) listener();
  },
};

/** One page whose heading element is replaced when its data arrives (a sr-only heading of the loading frame, then the real one). */
function SwappingPage() {
  const ref = usePageChrome('Loaded page');
  const loaded = useSyncExternalStore(loading.subscribe, () => loading.loaded);
  return loaded ? (
    <h1 key="loaded" ref={ref} tabIndex={-1}>
      Loaded page
    </h1>
  ) : (
    <h1 key="loading" ref={ref} tabIndex={-1} className="sr-only">
      Loading
    </h1>
  );
}

function SwapHarness() {
  return (
    <MemoryRouter initialEntries={['/a']}>
      <nav>
        <Link to="/swap">to swap</Link>
      </nav>
      <main id="main">
        <Routes>
          <Route path="/a" element={<Page title="Page A" />} />
          <Route path="/swap" element={<SwappingPage />} />
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
  beforeEach(() => {
    loading.loaded = false;
  });

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

  it('moves the focus to the new heading when the focused heading is replaced by the page that loaded', async () => {
    const user = userEvent.setup();
    render(<SwapHarness />);
    await user.click(screen.getByRole('link', { name: 'to swap' }));
    expect(screen.getByRole('heading', { name: 'Loading' })).toHaveFocus();
    act(() => {
      loading.finish();
    });
    expect(screen.getByRole('heading', { name: 'Loaded page' })).toHaveFocus();
  });

  it('leaves the focus alone when the replaced heading was not focused', async () => {
    const user = userEvent.setup();
    render(<SwapHarness />);
    await user.click(screen.getByRole('link', { name: 'to swap' }));
    const link = screen.getByRole('link', { name: 'to swap' });
    link.focus();
    act(() => {
      loading.finish();
    });
    expect(link).toHaveFocus();
  });

  it('leaves the focus on the document when it left the heading before the page loaded', async () => {
    const user = userEvent.setup();
    render(<SwapHarness />);
    await user.click(screen.getByRole('link', { name: 'to swap' }));
    const heading = screen.getByRole('heading', { name: 'Loading' });
    expect(heading).toHaveFocus();
    // A click on an empty part of the page: the heading loses the focus and no other element takes it.
    await act(async () => {
      heading.blur();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(document.body);
    act(() => {
      loading.finish();
    });
    expect(screen.getByRole('heading', { name: 'Loaded page' })).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not take the focus when the heading is replaced on the first load', () => {
    render(
      <MemoryRouter initialEntries={['/swap']}>
        <main id="main">
          <Routes>
            <Route path="/swap" element={<SwappingPage />} />
          </Routes>
        </main>
      </MemoryRouter>,
    );
    act(() => {
      loading.finish();
    });
    expect(screen.getByRole('heading', { name: 'Loaded page' })).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('puts the application name of the language that is shown after the page name', () => {
    const page = msg('route.sessions.title', undefined, 'vi');
    renderWithIntl(<Page title={page} />, { locale: 'vi' });
    expect(document.title).toBe(`${page} - ${msg('shell.appTitle', undefined, 'vi')}`);
  });
});
