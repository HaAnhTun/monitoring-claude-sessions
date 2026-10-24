import type { EntryKind, TranscriptEntry, TranscriptSearchResponse } from '@mcs/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createFormatters } from '../i18n/format.ts';
import { useShortcutRegistry, ShortcutRegistryProvider } from '../state/shortcuts-registry.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandler, type FakeHandlers } from '../test/fake-api.ts';
import {
  iso,
  makeInstance,
  makeTranscript,
  makeTranscriptSearch,
  makeTranscriptWindow,
  sessionId,
} from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { TranscriptViewer, type TranscriptViewerProps } from './TranscriptViewer.tsx';

const SID = sessionId(1);

const scrollIntoView = vi.fn();
beforeAll(() => {
  // happy-dom has no layout: scrolling a row into view is a no-op that tests can observe
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.useRealTimers();
});

interface Server {
  entries: TranscriptEntry[];
  gate: Promise<void> | null;
  partial: { partial: boolean; pendingBytes: number };
  handler: FakeHandler;
}

/** The window and locate semantics of 03 7.3 over a mutable list of entries. */
function makeServer(entries: TranscriptEntry[]): Server {
  const server: Server = {
    entries,
    gate: null,
    partial: { partial: false, pendingBytes: 0 },
    handler: async (query) => {
      if (server.gate !== null) await server.gate;
      const total = server.entries.length;
      const before = query.get('before');
      const after = Number(query.get('after') ?? '-1');
      const limit = Number(query.get('limit') ?? (before !== null || after === -1 ? '250' : '2000'));
      let start: number;
      let end: number;
      if (before !== null) {
        end = Math.min(Number(before), total);
        start = Math.max(0, end - limit);
      } else if (after === -1) {
        end = total;
        start = Math.max(0, total - limit);
      } else {
        start = Math.min(after, total);
        end = Math.min(total, start + limit);
      }
      return makeTranscriptWindow(0, {
        events: server.entries.slice(start, end),
        from: start,
        next: end,
        total,
        ...server.partial,
      });
    },
  };
  return server;
}

function locate(server: Server): FakeHandler {
  return (query) => {
    const raw = query.get('i');
    if (raw === null) return errorResponse('event_not_found');
    const i = Math.min(Math.max(0, Number(raw)), server.entries.length - 1);
    return { i, t: iso(0), base: 0, total: server.entries.length };
  };
}

function toolPair(i: number, name: string, err = false, text = 'tool output'): TranscriptEntry[] {
  return [
    { i, t: iso(i), k: 'tool', id: `t${String(i)}`, name, summary: `${name} summary ${String(i)}`, input: '{"a":1}' },
    { i: i + 1, t: iso(i + 1), k: 'result', id: `t${String(i)}`, text, ...(err ? { err: true as const } : {}) },
  ];
}

function setup(
  server: Server,
  props: Partial<TranscriptViewerProps> = {},
  extra: { handlers?: FakeHandlers; locale?: 'en' | 'vi' } = {},
) {
  const instance = makeInstance();
  const api: FakeApi = createFakeApi({
    instance: () => instance,
    transcriptWindow: server.handler,
    transcriptLocate: locate(server),
    ...extra.handlers,
  });
  const onNotice = vi.fn();
  const merged: TranscriptViewerProps = { sessionId: SID, agentId: 'main', newestFirst: false, onNotice, ...props };
  const rendered = renderWithIntl(<TranscriptViewer {...merged} />, {
    api,
    instance,
    live: true,
    ...(extra.locale === undefined ? {} : { locale: extra.locale }),
    wrap: (children) => <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>,
  });
  const rerenderViewer = (next: Partial<TranscriptViewerProps>): void => {
    rendered.rerender(<TranscriptViewer {...merged} {...next} />);
  };
  return { ...rendered, api, onNotice, rerenderViewer };
}

const rowKeys = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('li[data-row-key]')).map((li) => li.getAttribute('data-row-key') ?? '');

const visibleKeys = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('li[data-row-key]:not([hidden])')).map(
    (li) => li.getAttribute('data-row-key') ?? '',
  );

async function loaded(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector('li[data-row-key]')).not.toBeNull();
  });
}

function setGeometry(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  let top = geometry.scrollTop;
  Object.defineProperty(scroller, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: geometry.clientHeight, configurable: true });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
    configurable: true,
  });
}

const scrollerOf = (): HTMLElement => screen.getByRole('region', { name: msg('transcript.eventsRegion') });

type User = ReturnType<typeof userEvent.setup>;

const searchbox = (): HTMLElement => screen.getByRole('searchbox', { name: msg('transcript.toolbar.search') });
const followSwitch = (): HTMLElement => screen.getByRole('switch', { name: msg('transcript.toolbar.follow') });

/** The text of the count line, to assert the loaded range without the wording around it. */
const countText = (container: HTMLElement): string => container.querySelector('.tv-count')?.textContent ?? '';

async function openMenu(user: User, key: 'transcript.toolbar.show' | 'transcript.toolbar.more'): Promise<HTMLElement> {
  const open = screen.queryByRole('dialog');
  if (open === null) {
    const name = msg(key);
    const trigger =
      key === 'transcript.toolbar.more'
        ? screen.getByRole('button', { name })
        : screen.getByRole('button', { name, expanded: false });
    await user.click(trigger);
  }
  return screen.getByRole('dialog');
}

/** Types into the jump box of the overflow menu (opening the menu when it is closed). */
async function typeJump(user: User, text: string): Promise<void> {
  const panel = await openMenu(user, 'transcript.toolbar.more');
  const box = within(panel).getByRole('textbox', { name: msg('transcript.toolbar.jumpTo') });
  await user.clear(box);
  await user.type(box, text);
}

async function toggleKind(user: User, kind: EntryKind): Promise<void> {
  const panel = await openMenu(user, 'transcript.toolbar.show');
  await user.click(within(panel).getByRole('button', { name: msg(`transcript.toolbar.kind.${kind}`) }));
}

async function chooseTool(user: User, tool: string): Promise<void> {
  const panel = await openMenu(user, 'transcript.toolbar.show');
  await user.selectOptions(within(panel).getByRole('combobox', { name: msg('transcript.toolbar.tool') }), tool);
}

describe('TranscriptViewer', () => {
  describe('rendering', () => {
    it('pairs tool calls with their results and shows one row per unit', async () => {
      const server = makeServer(makeTranscript(8));
      const { container } = setup(server);
      await loaded(container);
      expect(rowKeys(container)).toEqual(['e0', 'e1', 'e2', 'e4', 'e5', 'e6']);
      expect(container.querySelectorAll('li > details')).toHaveLength(2);
    });

    it('puts the newest unit first by default and the oldest first on request', async () => {
      const server = makeServer(makeTranscript(8));
      const { container, rerenderViewer } = setup(server, { newestFirst: true });
      await loaded(container);
      expect(rowKeys(container)).toEqual(['e6', 'e5', 'e4', 'e2', 'e1', 'e0']);
      rerenderViewer({ newestFirst: false });
      expect(rowKeys(container)).toEqual(['e0', 'e1', 'e2', 'e4', 'e5', 'e6']);
    });

    it('shows the count line with the loaded range and the total', async () => {
      const server = makeServer(makeTranscript(8));
      const { container } = setup(server);
      await loaded(container);
      expect(
        screen.getByText(
          msg('transcript.count', { visible: 6, loaded: 6, errors: 0, first: '0', last: '7', total: 8 }),
        ),
      ).toBeInTheDocument();
    });

    it('renders hostile transcript text literally', async () => {
      const entries: TranscriptEntry[] = [
        { i: 0, t: iso(0), k: 'prompt', text: '<img src=x onerror=alert(1)> [x](javascript:alert(1))' },
        { i: 1, t: iso(1), k: 'say', text: '<script>alert(1)</script>\n```"><svg onload=alert(1)>\nx\n```' },
        ...toolPair(2, '<b>Tool</b>'),
      ];
      const { container } = setup(makeServer(entries));
      await loaded(container);
      expect(container.querySelector('script, img, svg[onload], a, b')).toBeNull();
      expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(container.textContent).toContain('<script>alert(1)</script>');
      expect(container.textContent).toContain('<b>Tool</b>');
    });

    it('has the empty, loading and failure states', async () => {
      const empty = setup(makeServer([]));
      expect(await screen.findByText(msg('transcript.empty'))).toBeInTheDocument();
      empty.unmount();

      const gone = setup(
        makeServer([]),
        {},
        { handlers: { transcriptWindow: () => errorResponse('transcript_gone') } },
      );
      expect(await screen.findByText(msg('transcript.gone'))).toBeInTheDocument();
      gone.unmount();

      setup(makeServer([]), {}, { handlers: { transcriptWindow: () => errorResponse('session_not_found') } });
      expect(await screen.findByText(msg('error.sessionNotFound'))).toBeInTheDocument();
    });

    it('shows a loading status first', () => {
      const server = makeServer(makeTranscript(4));
      server.gate = new Promise<void>(() => undefined);
      setup(server);
      expect(screen.getByText(msg('transcript.loading'))).toBeInTheDocument();
    });

    it('shows a refresh failure above the kept events', async () => {
      const server = makeServer(makeTranscript(4));
      const { container, api, rerenderViewer } = setup(server);
      await loaded(container);
      api.handlers = { ...api.handlers, transcriptWindow: () => errorResponse('internal_error') };
      rerenderViewer({ refreshToken: 1 });
      // the sentence around the detail is the catalogue's; the detail is the worded API error
      const [before, after] = msg('transcript.refreshFailedDetail', { detail: '@@' }).split('@@');
      const banner = await screen.findByText((text) => text.startsWith(before ?? '') && text.endsWith(after ?? ''));
      expect(banner).toHaveClass('tv-banner--warn');
      expect(rowKeys(container)).toHaveLength(3);
    });
  });

  describe('filters (rows are hidden, not unmounted)', () => {
    it('hides rows that do not match the text filter and keeps their nodes', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(8));
      const { container } = setup(server);
      await loaded(container);
      const before = Array.from(container.querySelectorAll('li[data-row-key]'));
      await user.type(searchbox(), 'say text 5');
      await waitFor(() => {
        expect(visibleKeys(container)).toEqual(['e5']);
      });
      const after = Array.from(container.querySelectorAll('li[data-row-key]'));
      expect(after).toHaveLength(before.length);
      expect(after.every((node, n) => node === before[n])).toBe(true);
      expect(
        screen.getByText(
          msg('transcript.count', { visible: 1, loaded: 6, errors: 0, first: '0', last: '7', total: 8 }),
        ),
      ).toBeInTheDocument();
    });

    it('shows a message when nothing matches', async () => {
      const user = userEvent.setup();
      const { container } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      await user.type(searchbox(), 'nothing like this');
      expect(await screen.findByText(msg('transcript.noMatch'))).toBeInTheDocument();
    });

    it('filters by kind, tool and errors only', async () => {
      const user = userEvent.setup();
      const entries = [
        { i: 0, t: iso(0), k: 'say' as const, text: 'hello' },
        ...toolPair(1, 'Bash'),
        ...toolPair(3, 'Read', true, 'failed read'),
      ];
      const { container } = setup(makeServer(entries));
      await loaded(container);
      await toggleKind(user, 'say');
      expect(visibleKeys(container)).toEqual(['e1', 'e3']);
      await chooseTool(user, 'Read');
      expect(visibleKeys(container)).toEqual(['e3']);
      await chooseTool(user, '');
      await user.click(screen.getByRole('switch', { name: msg('transcript.toolbar.errorsOnly') }));
      expect(visibleKeys(container)).toEqual(['e3']);
    });

    it('hides the result block of tool rows when the Results kind is off', async () => {
      const user = userEvent.setup();
      const { container } = setup(makeServer(toolPair(0, 'Bash')));
      await loaded(container);
      await toggleKind(user, 'result');
      expect(container.querySelector('details')).toHaveClass('hide-result');
    });

    it('rebuilds the tool list only when the set of names changes and keeps a vanished selection', async () => {
      const user = userEvent.setup();
      const server = makeServer([...toolPair(0, 'Bash'), ...toolPair(2, 'Read')]);
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      await chooseTool(user, 'Read');
      const toolSelect = (): HTMLElement => screen.getByRole('combobox', { name: msg('transcript.toolbar.tool') });
      const options = Array.from(toolSelect().querySelectorAll('option'));
      server.entries = [...server.entries, ...toolPair(4, 'Bash')];
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(countText(container)).toMatch(/#0.*#5.*6/);
      });
      const same = Array.from(toolSelect().querySelectorAll('option'));
      expect(same).toHaveLength(options.length);
      expect(same.every((option, n) => option === options[n])).toBe(true);
      expect(toolSelect()).toHaveValue('Read');
    });
  });

  describe('tool units', () => {
    it('keeps an opened tool row open when new events arrive', async () => {
      const user = userEvent.setup();
      const server = makeServer([...makeTranscript(4)]);
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      const summary = container.querySelector('details > summary');
      if (summary === null) throw new Error('no summary');
      await user.click(summary);
      expect(container.querySelector('details')).toHaveAttribute('open');
      server.entries = makeTranscript(10);
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(countText(container)).toMatch(/#0.*#9.*10/);
      });
      expect(container.querySelector('details')).toHaveAttribute('open');
    });

    it('keeps an opened tool row open when a filter hides it and shows it again', async () => {
      const user = userEvent.setup();
      const entries = [...toolPair(0, 'Bash'), ...toolPair(2, 'Read', true, 'failed read')];
      const { container } = setup(makeServer(entries));
      await loaded(container);
      const summary = container.querySelector<HTMLElement>('li[data-row-key="e0"] summary');
      if (summary === null) throw new Error('no summary');
      expect(summary).toHaveAttribute('aria-expanded', 'false');
      await user.click(summary);
      expect(summary).toHaveAttribute('aria-expanded', 'true');
      const row = container.querySelector('li[data-row-key="e0"]');
      await user.click(screen.getByRole('switch', { name: msg('transcript.toolbar.errorsOnly') }));
      expect(visibleKeys(container)).toEqual(['e2']);
      expect(container.querySelector('li[data-row-key="e0"]')).toBe(row);
      await user.click(screen.getByRole('switch', { name: msg('transcript.toolbar.errorsOnly') }));
      expect(visibleKeys(container)).toEqual(['e0', 'e2']);
      expect(container.querySelector('li[data-row-key="e0"] details')).toHaveAttribute('open');
      expect(container.querySelector('li[data-row-key="e2"] details')).not.toHaveAttribute('open');
    });

    it('keeps the expanded state of a clamped text across updates', async () => {
      const user = userEvent.setup();
      const server = makeServer([{ i: 0, t: iso(0), k: 'say', text: 'long '.repeat(400) }]);
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      const more = screen.getByRole('button', { name: msg('common.showMore') });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      await user.click(more);
      expect(screen.getByRole('button', { name: msg('common.showLess') })).toHaveAttribute('aria-expanded', 'true');
      server.entries = [...server.entries, { i: 1, t: iso(1), k: 'say', text: 'next' }];
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(rowKeys(container)).toEqual(['e0', 'e1']);
      });
      expect(screen.getByRole('button', { name: msg('common.showLess') })).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('follow mode and scrolling', () => {
    it('turns follow off when the user scrolls away and counts new events until resume', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(8));
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      const follow = followSwitch();
      expect(follow).toBeChecked();
      setGeometry(scrollerOf(), { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 });
      fireEvent.scroll(scrollerOf());
      expect(follow).not.toBeChecked();
      expect(screen.getByRole('button', { name: msg('transcript.resume') })).toBeInTheDocument();

      server.entries = makeTranscript(11);
      rerenderViewer({ refreshToken: 1 });
      const resumeNew = msg('transcript.resumeNew', { count: 3 });
      expect(await screen.findByRole('button', { name: resumeNew })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: resumeNew }));
      expect(follow).toBeChecked();
      expect(screen.queryByRole('button', { name: new RegExp(msg('transcript.resume')) })).toBeNull();
    });

    it('resumes by itself when the user scrolls back to the latest edge', async () => {
      const { container } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      setGeometry(scrollerOf(), { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 });
      fireEvent.scroll(scrollerOf());
      expect(followSwitch()).not.toBeChecked();
      setGeometry(scrollerOf(), { scrollTop: 790, scrollHeight: 1000, clientHeight: 200 });
      fireEvent.scroll(scrollerOf());
      expect(followSwitch()).toBeChecked();
    });

    it('snaps to the latest edge while following', async () => {
      const server = makeServer(makeTranscript(8));
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      setGeometry(scrollerOf(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
      server.entries = makeTranscript(12);
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(countText(container)).toMatch(/#0.*#11.*12/);
      });
      expect(scrollerOf().scrollTop).toBe(1000);
    });

    it('never moves focus when live updates arrive', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(8));
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      const button = within(container.querySelector('li[data-row-key="e1"]')!).getByRole('button', {
        name: msg('transcript.row.copyIndex'),
      });
      await user.click(button);
      button.focus();
      server.entries = makeTranscript(12);
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(countText(container)).toMatch(/#0.*#11.*12/);
      });
      expect(document.activeElement).toBe(button);
    });

    it('toggles follow with the f key and announces it', async () => {
      const user = userEvent.setup();
      const { container, onNotice } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      await user.keyboard('f');
      expect(followSwitch()).not.toBeChecked();
      expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.followOff'));
      await user.keyboard('f');
      expect(followSwitch()).toBeChecked();
      expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.followOn'));
    });

    it('focuses the search box with the slash key but not while typing in a field', async () => {
      const user = userEvent.setup();
      const { container } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      await user.keyboard('/');
      const search = searchbox();
      expect(search).toHaveFocus();
      await user.keyboard('f/');
      expect(search).toHaveValue('f/');
    });
  });

  describe('error stepping', () => {
    function errorEntries(): TranscriptEntry[] {
      return [
        { i: 0, t: iso(0), k: 'say', text: 'start' },
        ...toolPair(1, 'Bash', true, 'first failure'),
        ...toolPair(3, 'Bash'),
        ...toolPair(5, 'Read', true, 'second failure'),
      ];
    }

    it('steps to the next and previous error without wrapping and announces the position', async () => {
      const user = userEvent.setup();
      const { container, onNotice } = setup(makeServer(errorEntries()));
      await loaded(container);
      expect(
        screen.getByText(
          msg('transcript.count', { visible: 4, loaded: 4, errors: 2, first: '0', last: '6', total: 7 }),
        ),
      ).toBeInTheDocument();
      const next = (): HTMLElement => screen.getByRole('button', { name: msg('transcript.toolbar.nextError') });
      await user.click(next());
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.errorPosition', { position: 1, total: 2 }));
      expect(container.querySelector('li[data-row-key="e1"]')).toHaveClass('is-target');
      await user.click(next());
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.errorPosition', { position: 2, total: 2 }));
      await user.click(next());
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.noMoreErrors'));
      await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.prevError') }));
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.errorPosition', { position: 1, total: 2 }));
    });

    it('uses the bracket keys', async () => {
      const user = userEvent.setup();
      const { container, onNotice } = setup(makeServer(errorEntries()));
      await loaded(container);
      await user.keyboard(']');
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.errorPosition', { position: 1, total: 2 }));
      await user.keyboard('[[');
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.noMoreErrors'));
    });

    it('says so when the loaded events have no error', async () => {
      const user = userEvent.setup();
      const { container, onNotice } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.nextError') }));
      expect(onNotice).toHaveBeenLastCalledWith(msg('transcript.notice.noErrors'));
    });
  });

  describe('older events and the partial index', () => {
    it('loads older events, announces the count and places the row at the far edge', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(400));
      const { container, onNotice } = setup(server);
      await loaded(container);
      const list = container.querySelector<HTMLElement>('ol.tv-list')!;
      expect(list.firstElementChild).toHaveClass('tv-older');
      await user.click(within(list).getByRole('button', { name: msg('transcript.loadOlder') }));
      await waitFor(() => {
        expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.olderLoaded', { count: 150 }));
      });
      expect(rowKeys(container)[0]).toBe('e0');
      expect(container.querySelector('li.tv-older')).toBeNull();
    });

    it('puts the older row last when the newest unit is first', async () => {
      const { container } = setup(makeServer(makeTranscript(400)), { newestFirst: true });
      await loaded(container);
      const list = container.querySelector<HTMLElement>('ol.tv-list')!;
      expect(list.lastElementChild).toHaveClass('tv-older');
    });

    it('shows the partial banner only while bytes are not indexed', async () => {
      const server = makeServer(makeTranscript(8));
      server.partial = { partial: true, pendingBytes: 2_000_000 };
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      const banner = msg('transcript.partial', { size: createFormatters('en').bytes(2_000_000) });
      expect(screen.getByText(banner)).toBeInTheDocument();
      server.partial = { partial: false, pendingBytes: 0 };
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(screen.queryByText(banner)).toBeNull();
      });
    });

    it('shows the window limit banner and offers no Load older at the cap', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(120));
      const { container } = setup(server, { maxEvents: 60 });
      await loaded(container);
      expect(screen.getByText(msg('transcript.capped'))).toBeInTheDocument();
      expect(container.querySelector('li.tv-older')).toBeNull();
      const menu = await openMenu(user, 'transcript.toolbar.more');
      expect(within(menu).queryByRole('button', { name: msg('transcript.loadOlder') })).toBeNull();
      expect(countText(container)).toMatch(/#60.*#119.*120/);
    });

    it('offers no Load older when the first event is loaded', async () => {
      const user = userEvent.setup();
      const { container } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      expect(container.querySelector('li.tv-older')).toBeNull();
      const menu = await openMenu(user, 'transcript.toolbar.more');
      expect(within(menu).queryByRole('button', { name: msg('transcript.loadOlder') })).toBeNull();
    });

    it('offers Load older in the menu while older events exist', async () => {
      const user = userEvent.setup();
      const { container, onNotice } = setup(makeServer(makeTranscript(400)));
      await loaded(container);
      const menu = await openMenu(user, 'transcript.toolbar.more');
      await user.click(within(menu).getByRole('button', { name: msg('transcript.loadOlder') }));
      await waitFor(() => {
        expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.olderLoaded', { count: 150 }));
      });
    });

    it('announces a reset and reloads when the transcript shrank', async () => {
      const server = makeServer(makeTranscript(12));
      const { container, rerenderViewer, onNotice } = setup(server);
      await loaded(container);
      server.entries = makeTranscript(4);
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.reset'));
      });
      await waitFor(() => {
        expect(countText(container)).toMatch(/#0.*#3.*4/);
      });
      expect(screen.getByText(msg('transcript.notice.reset'))).toBeInTheDocument();
    });

    it('shows the reloaded text, not the old text, when a reset keeps the same indices', async () => {
      const old = Array.from({ length: 10 }, (_unused, i): TranscriptEntry => ({
        i,
        t: iso(i),
        k: 'say',
        text: `old${String(i)}`,
      }));
      const server = makeServer(old);
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      expect(container).toHaveTextContent('old0');
      server.entries = Array.from({ length: 3 }, (_unused, i): TranscriptEntry => ({
        i,
        t: iso(i),
        k: 'say',
        text: `fresh${String(i)}`,
      }));
      rerenderViewer({ refreshToken: 1 });
      await waitFor(() => {
        expect(countText(container)).toMatch(/#0.*#2.*3/);
      });
      expect(container).toHaveTextContent('fresh0');
      expect(container).toHaveTextContent('fresh2');
      expect(container).not.toHaveTextContent('old0');
    });
  });

  describe('jump', () => {
    it('replaces the window around an index that is not loaded, then focuses and outlines the row', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(2000));
      const { container, onNotice } = setup(server);
      await loaded(container);
      await typeJump(user, '#500{Enter}');
      await waitFor(() => {
        expect(container.querySelector('li[data-row-key="e500"]')).toHaveClass('is-target');
      });
      expect(container.querySelector('li[data-row-key="e500"]')).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
      expect(followSwitch()).not.toBeChecked();
      expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.jumped', { index: '500' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('opens the tool row when the jump hits its result', async () => {
      const user = userEvent.setup();
      const entries = [
        ...makeTranscript(1),
        ...toolPair(1, 'Bash'),
        ...makeTranscript(10)
          .slice(0, 3)
          .map((e, n) => ({ ...e, i: 3 + n })),
      ];
      const { container } = setup(makeServer(entries));
      await loaded(container);
      await typeJump(user, '2{Enter}');
      await waitFor(() => {
        expect(container.querySelector('li[data-row-key="e1"] details')).toHaveAttribute('open');
      });
      expect(container.querySelector('li[data-row-key="e1"]')).toHaveClass('is-target');
    });

    it('clears the filters when the target is hidden by them', async () => {
      const user = userEvent.setup();
      const { container, onNotice } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      await user.type(searchbox(), 'say text 5');
      await waitFor(() => {
        expect(visibleKeys(container)).toEqual(['e5']);
      });
      await typeJump(user, '#0{Enter}');
      await waitFor(() => {
        expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.filtersCleared', { index: '0' }));
      });
      expect(searchbox()).toHaveValue('');
      expect(visibleKeys(container)).toContain('e0');
    });

    it('explains an unreadable jump text and an index that does not exist', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(8));
      const { container, onNotice } = setup(
        server,
        {},
        { handlers: { transcriptLocate: () => errorResponse('event_not_found') } },
      );
      await loaded(container);
      await typeJump(user, 'later{Enter}');
      expect(screen.getByText(msg('transcript.notice.jumpUnreadable'))).toBeInTheDocument();
      await typeJump(user, '#99999{Enter}');
      await waitFor(() => {
        expect(onNotice).toHaveBeenCalledWith(msg('transcript.notice.noJump'));
      });
    });

    it('jumps to the index of the i parameter on load and reports that it is done', async () => {
      const onInitialIndexDone = vi.fn();
      const { container } = setup(makeServer(makeTranscript(2000)), { initialIndex: 700, onInitialIndexDone });
      await waitFor(() => {
        expect(container.querySelector('li[data-row-key="e700"]')).toHaveClass('is-target');
      });
      expect(onInitialIndexDone).toHaveBeenCalledTimes(1);
    });
  });

  describe('whole-transcript search', () => {
    const match = (i: number, snippet: string): TranscriptSearchResponse['matches'][number] => ({
      i,
      k: 'say',
      t: iso(i),
      name: null,
      snippet,
      offset: i * 10,
    });

    it('sends the filter as a search, lists the matches and jumps on click', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(2000));
      const searchHandler: FakeHandler = (query) =>
        makeTranscriptSearch({
          matches: [match(900, 'the needle is here')],
          count: 1,
          query: { q: query.get('q') ?? '', kinds: [], tool: null, errors: false },
        });
      const { container, api } = setup(server, {}, { handlers: { searchTranscript: searchHandler } });
      await loaded(container);
      await user.type(searchbox(), 'needle');
      await waitFor(() => {
        expect(visibleKeys(container)).toHaveLength(0);
      });
      await user.keyboard('{Enter}');
      const panel = await screen.findByRole('region', { name: msg('transcript.search.region') });
      expect(within(panel).getByText('needle')).toBeInTheDocument();
      const call = api.callsTo('searchTranscript')[0];
      expect(call?.query.get('session')).toBe(SID);
      expect(call?.query.get('q')).toBe('needle');
      expect(call?.query.get('agent')).toBe('main');
      await user.click(within(panel).getByRole('button', { name: msg('transcript.search.jumpTo', { index: '900' }) }));
      await waitFor(() => {
        expect(container.querySelector('li[data-row-key="e900"]')).toHaveClass('is-target');
      });
    });

    it('drops a response whose echoed query is not the one asked', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(20));
      const searchHandler: FakeHandler = () =>
        makeTranscriptSearch({
          matches: [match(3, 'stale answer')],
          count: 1,
          query: { q: 'something else', kinds: [], tool: null, errors: false },
        });
      const { container } = setup(server, {}, { handlers: { searchTranscript: searchHandler } });
      await loaded(container);
      await user.type(searchbox(), 'needle{Enter}');
      await screen.findByRole('region', { name: msg('transcript.search.region') });
      expect(screen.queryByText('stale answer')).toBeNull();
    });

    it('shows the answer of the latest search when an older one finishes late', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(20));
      let release: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const searchHandler: FakeHandler = async (query) => {
        const q = query.get('q') ?? '';
        if (q === 'one') await slow;
        return makeTranscriptSearch({
          matches: [match(q === 'one' ? 1 : 2, `answer for ${q}`)],
          count: 1,
          query: { q, kinds: [], tool: null, errors: false },
        });
      };
      const { container } = setup(server, {}, { handlers: { searchTranscript: searchHandler } });
      await loaded(container);
      const box = searchbox();
      await user.type(box, 'one{Enter}');
      await user.clear(box);
      await user.type(box, 'two{Enter}');
      const panel = await screen.findByRole('region', { name: msg('transcript.search.region') });
      await waitFor(() => {
        expect(panel).toHaveTextContent('answer for two');
      });
      await act(async () => {
        release();
        await Promise.resolve();
      });
      expect(panel).not.toHaveTextContent('answer for one');
      expect(panel).toHaveTextContent('answer for two');
    });

    it('says the monitor is busy and returns focus to the search box on close', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(20));
      const { container } = setup(server, {}, { handlers: { searchTranscript: () => errorResponse('search_busy') } });
      await loaded(container);
      await user.type(searchbox(), 'needle{Enter}');
      expect(await screen.findByText(msg('transcript.search.busy'))).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: msg('transcript.search.close') }));
      expect(screen.queryByRole('region', { name: msg('transcript.search.region') })).toBeNull();
      expect(searchbox()).toHaveFocus();
    });

    it('searches from the overflow menu with the text in the box', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(20));
      const { container, api } = setup(server);
      await loaded(container);
      await user.type(searchbox(), 'needle');
      const menu = await openMenu(user, 'transcript.toolbar.more');
      await user.click(within(menu).getByRole('button', { name: msg('transcript.toolbar.searchWhole') }));
      await screen.findByRole('region', { name: msg('transcript.search.region') });
      expect(api.callsTo('searchTranscript')[0]?.query.get('q')).toBe('needle');
    });
  });

  describe('session changes', () => {
    it('starts over for another session and does not keep the open rows of the first', async () => {
      const user = userEvent.setup();
      const server = makeServer(makeTranscript(8));
      const { container, rerenderViewer } = setup(server);
      await loaded(container);
      const summary = container.querySelector('details > summary')!;
      await user.click(summary);
      expect(container.querySelector('details')).toHaveAttribute('open');
      rerenderViewer({ sessionId: sessionId(2) });
      await waitFor(() => {
        expect(container.querySelector('details')).not.toBeNull();
      });
      expect(container.querySelector('details')).not.toHaveAttribute('open');
    });
  });

  describe('the error breakdown of the session', () => {
    const errors = { thisAgent: 0, subagents: 1, errorsTabHref: '/sessions/s1?tab=errors' };

    it('says how many errors are in this agent and how many in subagents, with a link to the Errors tab', async () => {
      const { container } = setup(makeServer(makeTranscript(8)), { sessionErrors: errors });
      await loaded(container);
      expect(screen.getByText(msg('transcript.errors.breakdown', { thisAgent: 0, subagents: 1 }))).toBeInTheDocument();
      expect(screen.getByRole('link', { name: msg('transcript.errors.viewAll') })).toHaveAttribute(
        'href',
        errors.errorsTabHref,
      );
    });

    it('is not shown when the page passes no counts', async () => {
      const { container } = setup(makeServer(makeTranscript(8)));
      await loaded(container);
      expect(screen.queryByRole('link', { name: msg('transcript.errors.viewAll') })).toBeNull();
    });
  });

  describe('shortcuts', () => {
    function Registered() {
      const { shortcuts } = useShortcutRegistry();
      return (
        <ul aria-label="registered">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.key} data-key={shortcut.key}>
              {shortcut.description}
            </li>
          ))}
        </ul>
      );
    }

    it('registers the slash, f, [ and ] keys with a description each, in the shortcuts registry', () => {
      const instance = makeInstance();
      const api = createFakeApi({ instance: () => instance, transcriptWindow: makeServer(makeTranscript(4)).handler });
      renderWithIntl(
        <>
          <Registered />
          <TranscriptViewer sessionId={SID} agentId="main" />
        </>,
        {
          api,
          instance,
          live: true,
          wrap: (children) => <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>,
        },
      );
      const list = screen.getByRole('list', { name: 'registered' });
      const descriptions = new Map(
        Array.from(list.querySelectorAll('li')).map((li) => [li.dataset['key'] ?? '', li.textContent]),
      );
      expect(descriptions.get('/')).toBe(msg('transcript.shortcut.search'));
      expect(descriptions.get('f')).toBe(msg('transcript.shortcut.follow'));
      expect(descriptions.get(']')).toBe(msg('transcript.shortcut.nextError'));
      expect(descriptions.get('[')).toBe(msg('transcript.shortcut.prevError'));
    });

    it('takes the keys away when the viewer unmounts', () => {
      const instance = makeInstance();
      const api = createFakeApi({ instance: () => instance, transcriptWindow: makeServer(makeTranscript(4)).handler });
      const rendered = renderWithIntl(
        <>
          <Registered />
          <TranscriptViewer sessionId={SID} agentId="main" />
        </>,
        {
          api,
          instance,
          live: true,
          wrap: (children) => <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>,
        },
      );
      expect(screen.getByRole('list', { name: 'registered' }).querySelectorAll('li')).toHaveLength(4);
      rendered.rerender(<Registered />);
      expect(screen.getByRole('list', { name: 'registered' }).querySelectorAll('li')).toHaveLength(0);
    });
  });

  describe('Vietnamese', () => {
    it('words the toolbar, the count line and the states in Vietnamese', async () => {
      const { container } = setup(makeServer(makeTranscript(8)), {}, { locale: 'vi' });
      await loaded(container);
      expect(
        screen.getByRole('switch', { name: msg('transcript.toolbar.follow', undefined, 'vi') }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          msg('transcript.count', { visible: 6, loaded: 6, errors: 0, first: '0', last: '7', total: 8 }, 'vi'),
        ),
      ).toBeInTheDocument();
      expect(container.querySelector('.tr-kind')).not.toBeNull();
    });

    it('words the empty state in Vietnamese', async () => {
      setup(makeServer([]), {}, { locale: 'vi' });
      expect(await screen.findByText(msg('transcript.empty', undefined, 'vi'))).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has no axe violation with the toolbar, an open tool row and the Show popover (en and vi)', async () => {
      for (const locale of ['en', 'vi'] as const) {
        const user = userEvent.setup();
        const entries = [
          { i: 0, t: iso(0), k: 'say' as const, text: 'hello' },
          ...toolPair(1, 'Bash'),
          ...toolPair(3, 'Read', true, 'failed read'),
        ];
        const { container, unmount } = setup(makeServer(entries), {}, { locale });
        await loaded(container);
        await user.click(container.querySelector<HTMLElement>('li[data-row-key="e1"] summary')!);
        if (locale === 'en') await openMenu(user, 'transcript.toolbar.show');
        // color contrast needs layout, which the test environment does not have; the contrast gate is lib/tokens-contrast.test.ts
        const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
        expect(
          result.violations.map((violation) => violation.id),
          locale,
        ).toEqual([]);
        unmount();
      }
    });
  });
});
