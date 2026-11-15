import { act, fireEvent, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { createRef, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { liveSessionOf, type EndedInfo, type LiveSession } from '../lib/workspace-view.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { ShortcutRegistryProvider, useShortcut } from '../state/shortcuts-registry.tsx';
import {
  fakeSeams,
  giveHostSize,
  handshake,
  stubResizeObserver,
  type FakeTerminalSeams,
} from '../test/fake-terminal.ts';
import type { FakeWebSocket } from '../test/fake-websocket.ts';
import { makeTerminalSession } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { encodeResize, RELEASE_CHORD } from './protocol.ts';
import { TerminalSeamsContext } from './seams.ts';
import TerminalView, { type TerminalViewHandle, type TerminalViewProps } from './TerminalView.tsx';

// Design 04 7.7, 6.3 and 12.2: the region, its labels and hint, the status line, the jump pill and the focus rules, through the fake
// engine and the real socket client over FakeWebSocket. TC-UI-06 (the ended state with its exit code), TC-UI-11 (axe, both
// languages), TC-UI-12 (focus: nothing on first paint, the terminal on `live` when asked, the way out, and the shortcut registry
// leaving the keyboard to the terminal).

const SESSION: LiveSession = liveSessionOf(makeTerminalSession(1));

interface Rig {
  fake: FakeTerminalSeams;
  onEnded: ReturnType<typeof vi.fn<(info: EndedInfo) => void>>;
  rendered: ReturnType<typeof renderWithIntl>;
  root: HTMLElement;
  host: HTMLElement;
  region: HTMLElement;
  rerender: (props: Partial<TerminalViewProps>) => void;
}

interface RenderOptions {
  locale?: 'en' | 'vi';
  fake?: FakeTerminalSeams;
  props?: Partial<TerminalViewProps>;
  /** Extra providers around the view (the shortcut registry), innermost last. */
  around?: (view: ReactNode) => ReactNode;
}

function viewOf(props: TerminalViewProps): ReactElement {
  return <TerminalView {...props} />;
}

function renderView(options: RenderOptions = {}): Rig {
  const fake = options.fake ?? fakeSeams();
  stubResizeObserver();
  const onEnded = vi.fn<(info: EndedInfo) => void>();
  const baseProps: TerminalViewProps = { session: SESSION, gone: false, focusOnLive: false, onEnded, ...options.props };
  const rendered = renderWithIntl(viewOf(baseProps), {
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    wrap: (children) => {
      const inner = options.around === undefined ? children : options.around(children);
      return (
        <TerminalSeamsContext value={fake.seams}>
          <AnnouncerProvider>{inner}</AnnouncerProvider>
        </TerminalSeamsContext>
      );
    },
  });
  const root = rendered.container.querySelector<HTMLElement>('#terminal');
  const host = rendered.container.querySelector<HTMLElement>('[data-terminal]');
  const region = rendered.container.querySelector<HTMLElement>('[data-terminal-region]');
  if (root === null || host === null || region === null) throw new Error('the view did not render its region');
  giveHostSize(host, 900, 500);
  return {
    fake,
    onEnded,
    rendered,
    root,
    host,
    region,
    rerender: (next) => {
      rendered.rerender(viewOf({ ...baseProps, ...next }));
    },
  };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderLive(options: RenderOptions & { server?: Parameters<typeof handshake>[1] } = {}) {
  const rig = renderView(options);
  await settle();
  const socket = rig.fake.sockets.last();
  act(() => {
    handshake(socket, options.server ?? { cols: 120, rows: 30 });
  });
  return { ...rig, socket };
}

function statusText(rig: Rig): string {
  return rig.root.querySelector('.terminal-status')?.textContent ?? '';
}

function liveRegionText(): string {
  return document.getElementById('live-region')?.textContent ?? '';
}

function drop(socket: FakeWebSocket, code = 1006): void {
  act(() => {
    socket.closeFromServer(code);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the region, its labels and the hint (design 04 7.7)', () => {
  it('is #terminal (the target of the skip link), a group named after the session, and a host that carries no children of React', () => {
    const rig = renderView();
    expect(rig.root.id).toBe('terminal');
    expect(rig.root.tabIndex).toBe(-1);
    const group = screen.getByRole('group', { name: msg('terminal.region', { name: SESSION.name }) });
    expect(group).toBe(rig.region);
    expect(group.hasAttribute('data-terminal-region')).toBe(true);
    expect(group.contains(rig.host)).toBe(true);
    expect(rig.host.hasAttribute('data-terminal')).toBe(true);
    expect(rig.host.children).toHaveLength(0);
  });

  it('names the way out in the hint, in a key cap, and on the host as a tooltip', () => {
    const rig = renderView();
    const hint = rig.root.querySelector<HTMLElement>('.terminal-hint');
    expect(hint?.textContent).toContain(msg('terminal.hint.leave'));
    const cap = hint?.querySelector('kbd');
    expect(cap?.textContent).toBe(RELEASE_CHORD);
    expect(cap).toHaveClass('kbd');
    expect(rig.host.title).toContain(RELEASE_CHORD);
    // the hint is not inside the region: the shortcut registry owns what is inside, the hint is only text
    expect(rig.region.contains(hint ?? null)).toBe(false);
  });

  it('writes no heading: the page has exactly one h1 and it is not the terminal`s', async () => {
    const rig = await renderLive();
    expect(within(rig.root).queryAllByRole('heading')).toHaveLength(0);
  });

  it('mirrors the size of the terminal in data-cols and data-rows on every resize', async () => {
    const rig = renderView();
    await settle();
    expect(rig.host.dataset['cols']).toBe('80');
    expect(rig.host.dataset['rows']).toBe('24');
    const socket = rig.fake.sockets.last();
    act(() => {
      handshake(socket, { cols: 120, rows: 30, skipLive: true });
    });
    expect([rig.host.dataset['cols'], rig.host.dataset['rows']]).toEqual(['120', '30']);
    act(() => {
      socket.message({ type: 'live' });
    });
    // the default fit of the fake is 100 x 30
    expect([rig.host.dataset['cols'], rig.host.dataset['rows']]).toEqual(['100', '30']);
    act(() => {
      socket.message({ type: 'size', cols: 80, rows: 40 });
    });
    expect([rig.host.dataset['cols'], rig.host.dataset['rows']]).toEqual(['80', '40']);
  });

  it('exposes the hint to assistive technology while the terminal has the focus, and describes the text area with it', async () => {
    const rig = await renderLive();
    const hint = rig.root.querySelector<HTMLElement>('.terminal-hint');
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
    const area = rig.fake.engine.last().terminal.textarea;
    expect(area).toBeDefined();
    act(() => {
      area?.focus();
    });
    expect(hint?.hasAttribute('aria-hidden')).toBe(false);
    const describedBy = area?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(hint?.id).toBe(describedBy);
    act(() => {
      area?.blur();
    });
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the status line (design 04 6.3)', () => {
  it('says nothing while all is well, and the hint stays', async () => {
    const rig = await renderLive();
    expect(statusText(rig)).toBe('');
    expect(rig.root.querySelector('.terminal-status')?.getAttribute('role')).toBe('status');
    expect(rig.root.querySelector('.terminal-hint')).not.toBeNull();
  });

  it('says loading, then connecting', async () => {
    const fake = fakeSeams();
    const release = fake.holdNextLoad();
    const rig = renderView({ fake });
    expect(statusText(rig)).toBe(msg('terminal.status.loadingEngine'));
    release();
    await settle();
    expect(statusText(rig)).toBe(msg('terminal.status.connecting'));
  });

  it('says the terminal could not be loaded and offers Retry, which loads it again', async () => {
    const fake = fakeSeams();
    fake.failNextLoad();
    const rig = renderView({ fake });
    await settle();
    expect(statusText(rig)).toBe(msg('terminal.status.engineFailed'));
    fireEvent.click(within(rig.root).getByRole('button', { name: msg('common.retry') }));
    await settle();
    expect(fake.loadCount()).toBe(2);
    expect(statusText(rig)).toBe(msg('terminal.status.connecting'));
    expect(within(rig.root).queryByRole('button', { name: msg('common.retry') })).toBeNull();
  });

  it('counts down the wait of a reconnect, offers Retry now, and says what typing does meanwhile', async () => {
    const rig = await renderLive();
    drop(rig.socket);
    await settle();
    drop(rig.fake.sockets.last());
    await settle(1000);
    // the third connection fails too: a wait of two seconds
    drop(rig.fake.sockets.last());
    expect(statusText(rig)).toBe(msg('terminal.status.reconnecting', { seconds: 2 }));
    await settle(1000);
    expect(statusText(rig)).toBe(msg('terminal.status.reconnecting', { seconds: 1 }));

    act(() => {
      rig.fake.engine.last().terminal.emitData('x');
    });
    expect(statusText(rig)).toBe(
      `${msg('terminal.status.reconnecting', { seconds: 1 })} ${msg('terminal.status.typingPaused')}`,
    );
    const before = rig.fake.sockets.instances.length;
    fireEvent.click(within(rig.root).getByRole('button', { name: msg('common.retryNow') }));
    expect(rig.fake.sockets.instances).toHaveLength(before + 1);
    expect(statusText(rig)).toContain(msg('terminal.status.reconnectingNow'));
  });

  it('clears the reconnect text and the typing note when the screen is live again', async () => {
    const rig = await renderLive();
    drop(rig.socket);
    act(() => {
      rig.fake.engine.last().terminal.emitData('x');
    });
    await settle();
    act(() => {
      handshake(rig.fake.sockets.last(), { cols: 120, rows: 30 });
    });
    expect(statusText(rig)).toBe('');
    expect(within(rig.root).queryByRole('button', { name: msg('common.retryNow') })).toBeNull();
  });

  it('tells that another window set the size, with a button that takes it back (R4)', async () => {
    const rig = await renderLive();
    act(() => {
      rig.socket.message({ type: 'size', cols: 80, rows: 40 });
    });
    expect(statusText(rig)).toBe(msg('workspace.pane.sizeOther', { cols: 80, rows: 40 }));
    fireEvent.click(within(rig.root).getByRole('button', { name: msg('workspace.pane.sizeUse') }));
    expect(statusText(rig)).toBe('');
    expect(rig.socket.sentText.at(-1)).toBe(encodeResize(100, 30));
  });

  it('states the ending of the session: the exit code, a plain exit, or a stop (TC-UI-06)', async () => {
    const withCode = await renderLive();
    act(() => {
      withCode.socket.message({ type: 'exit', code: 3, signal: null });
    });
    expect(statusText(withCode)).toBe(msg('terminal.ended.exitCode', { code: 3 }));
    withCode.rendered.unmount();

    const killed = await renderLive();
    act(() => {
      killed.socket.message({ type: 'exit', code: null, signal: 'SIGKILL' });
      killed.socket.closeFromServer(4001);
    });
    expect(statusText(killed)).toBe(msg('terminal.ended.killed'));
    killed.rendered.unmount();

    const plain = await renderLive();
    act(() => {
      plain.socket.closeFromServer(1000);
    });
    expect(statusText(plain)).toBe(msg('terminal.ended.exited'));
  });

  it('says the connection failed with Retry after a close that is our own bug', async () => {
    const rig = await renderLive();
    drop(rig.socket, 1009);
    expect(statusText(rig)).toBe(msg('terminal.status.failed'));
    fireEvent.click(within(rig.root).getByRole('button', { name: msg('common.retry') }));
    expect(rig.fake.sockets.instances).toHaveLength(2);
  });

  it('says the access link is needed when the session of the browser ended (close 4003)', async () => {
    const rig = await renderLive();
    drop(rig.socket, 4003);
    expect(statusText(rig)).toBe(msg('access.locked.title'));
  });

  it('speaks Vietnamese when the page does', async () => {
    const rig = await renderLive({ locale: 'vi' });
    drop(rig.socket);
    expect(statusText(rig)).toContain(msg('terminal.status.reconnectingNow', undefined, 'vi'));
    expect(rig.root.querySelector('.terminal-hint')?.textContent).toContain(
      msg('terminal.hint.leave', undefined, 'vi'),
    );
    expect(
      screen.getByRole('group', { name: msg('terminal.region', { name: SESSION.name }, 'vi') }),
    ).toBeInTheDocument();
    expect(rig.fake.engine.last().terminal.textarea?.getAttribute('aria-label')).toBe(
      msg('terminal.input', undefined, 'vi'),
    );
  });
});

describe('the jump to latest pill (design 04 7.6)', () => {
  it('shows while the history is scrolled up, inside the region, and scrolls to the newest output', async () => {
    const rig = await renderLive();
    const terminal = rig.fake.engine.last().terminal;
    expect(within(rig.region).queryByRole('button')).toBeNull();
    act(() => {
      terminal.scrollTo(3, 40);
    });
    const pill = within(rig.region).getByRole('button', { name: msg('workspace.pane.latest') });
    expect(pill).toHaveClass('terminal-latest');
    // it is a button, not a live region: scrolling must not talk
    expect(pill.closest('[aria-live]')).toBeNull();
    fireEvent.click(pill);
    expect(terminal.scrollToBottomCount).toBe(1);
    expect(within(rig.region).queryByRole('button')).toBeNull();
  });
});

describe('focus (TC-UI-12, design 04 7.5)', () => {
  it('takes no focus on first paint and none while loading or connecting', async () => {
    const rig = renderView({ props: { focusOnLive: true } });
    expect(rig.root.contains(document.activeElement)).toBe(false);
    await settle();
    expect(rig.root.contains(document.activeElement)).toBe(false);
    expect(rig.fake.engine.last().terminal.focusCount).toBe(0);
  });

  it('focuses the terminal text area on live when the page asked', async () => {
    const rig = await renderLive({ props: { focusOnLive: true } });
    const terminal = rig.fake.engine.last().terminal;
    expect(terminal.focusCount).toBe(1);
    expect(document.activeElement).toBe(terminal.textarea);
  });

  it('does not take the focus on live when the page did not ask', async () => {
    const rig = await renderLive({ props: { focusOnLive: false } });
    expect(rig.fake.engine.last().terminal.focusCount).toBe(0);
    expect(rig.root.contains(document.activeElement)).toBe(false);
  });

  it('forwards the focus that the skip link gives #terminal to the terminal, and only that focus', async () => {
    const rig = await renderLive();
    const terminal = rig.fake.engine.last().terminal;
    act(() => {
      rig.root.focus();
    });
    expect(terminal.focusCount).toBe(1);
    expect(document.activeElement).toBe(terminal.textarea);

    // a focus that lands on something inside does not bounce
    act(() => {
      terminal.blur();
    });
    const count = terminal.focusCount;
    act(() => {
      terminal.textarea?.focus();
    });
    expect(terminal.focusCount).toBe(count);
  });
});

describe('the handle of the view (ref prop)', () => {
  it('lets the page focus, blur, redraw, take the size back and scroll to the latest output', async () => {
    const ref = createRef<TerminalViewHandle>();
    const rig = await renderLive({ props: { ref } });
    const terminal = rig.fake.engine.last().terminal;
    expect(ref.current).not.toBeNull();

    act(() => {
      ref.current?.focus();
    });
    expect(terminal.focusCount).toBe(1);
    act(() => {
      ref.current?.blur();
    });
    expect(terminal.blurCount).toBe(1);

    act(() => {
      ref.current?.redraw();
    });
    expect(rig.socket.sentText.at(-1)).toBe(encodeResize(100, 29));

    act(() => {
      rig.socket.message({ type: 'size', cols: 80, rows: 40 });
    });
    act(() => {
      ref.current?.takeSize();
    });
    expect(rig.socket.sentText.at(-1)).toBe(encodeResize(100, 30));

    act(() => {
      ref.current?.scrollToLatest();
    });
    expect(terminal.scrollToBottomCount).toBe(1);
  });

  it('is handed over again, as the same methods, after a rerender', async () => {
    const ref = createRef<TerminalViewHandle>();
    const rig = await renderLive({ props: { ref } });
    const first = ref.current;
    rig.rerender({ focusOnLive: true });
    expect(ref.current).toBe(first);
  });
});

describe('the end of a session (TC-UI-06)', () => {
  it('tells the page with the name, the row it knew, the code and whether it was stopped', async () => {
    const rig = await renderLive();
    act(() => {
      rig.socket.message({ type: 'exit', code: 3, signal: null });
    });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
    expect(rig.onEnded).toHaveBeenLastCalledWith({ name: SESSION.name, session: SESSION, exitCode: 3, killed: false });
  });

  it('uses the session the page knows at the moment of the end, not the one of the first render', async () => {
    const rig = await renderLive();
    const newer: LiveSession = { ...SESSION, viewers: 2 };
    rig.rerender({ session: newer });
    act(() => {
      rig.socket.message({ type: 'exit', code: 0, signal: null });
    });
    expect(rig.onEnded).toHaveBeenLastCalledWith({ name: SESSION.name, session: newer, exitCode: 0, killed: false });
  });

  it('ends when the page says the session is gone, and keeps the last output on the screen', async () => {
    const rig = await renderLive({ server: { cols: 120, rows: 30, replay: ['last words\r\n'] } });
    rig.rerender({ gone: true });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
    expect(rig.onEnded).toHaveBeenLastCalledWith({
      name: SESSION.name,
      session: SESSION,
      exitCode: null,
      killed: false,
    });
    expect(rig.fake.engine.last().terminal.screen).toContain('last words');
    expect(statusText(rig)).toBe(msg('terminal.ended.exited'));
  });
});

describe('what is announced (design 04 7.7)', () => {
  it('announces the end of the session by name', async () => {
    const rig = await renderLive();
    act(() => {
      rig.socket.message({ type: 'exit', code: 0, signal: null });
      rig.socket.closeFromServer(4000);
    });
    await settle(50);
    expect(liveRegionText()).toBe(msg('workspace.announce.ended', { name: SESSION.name }));
  });

  it('announces a reconnect when the screen is live again, and not the first connection', async () => {
    const rig = await renderLive();
    await settle(50);
    expect(liveRegionText()).toBe('');
    drop(rig.socket);
    await settle();
    act(() => {
      handshake(rig.fake.sockets.last(), { cols: 120, rows: 30 });
    });
    await settle(50);
    expect(liveRegionText()).toBe(msg('workspace.announce.reconnected', { name: SESSION.name }));
  });

  it('announces that typing is paused, once the first key is lost', async () => {
    const rig = await renderLive();
    drop(rig.socket);
    await settle(50);
    expect(liveRegionText()).toBe('');
    act(() => {
      rig.fake.engine.last().terminal.emitData('x');
    });
    await settle(50);
    expect(liveRegionText()).toBe(msg('terminal.status.typingPaused'));
  });

  it('announces the end in Vietnamese on a Vietnamese page', async () => {
    const rig = await renderLive({ locale: 'vi' });
    act(() => {
      rig.socket.message({ type: 'exit', code: 0, signal: null });
    });
    await settle(50);
    expect(liveRegionText()).toBe(msg('workspace.announce.ended', { name: SESSION.name }, 'vi'));
  });
});

describe('the keyboard belongs to the terminal inside its region (TC-UI-12, design 04 D12)', () => {
  function ShortcutProbe({ onKey }: { onKey: (key: string) => void }) {
    useShortcut(
      '/',
      () => {
        onKey('/');
      },
      { description: 'probe' },
    );
    useShortcut(
      'f',
      () => {
        onKey('f');
      },
      { description: 'probe' },
    );
    return null;
  }

  function withRegistry(onKey: (key: string) => void): (view: ReactNode) => ReactNode {
    return (view) => (
      <ShortcutRegistryProvider>
        <ShortcutProbe onKey={onKey} />
        <button type="button">outside the terminal</button>
        {view}
      </ShortcutRegistryProvider>
    );
  }

  it('runs a single-key shortcut from outside the region, and none from the pill inside it', async () => {
    const onKey = vi.fn<(key: string) => void>();
    const rig = await renderLive({ around: withRegistry(onKey) });
    const terminal = rig.fake.engine.last().terminal;
    const outside = screen.getByRole('button', { name: 'outside the terminal' });
    outside.focus();
    fireEvent.keyDown(outside, { key: '/' });
    expect(onKey).toHaveBeenCalledWith('/');
    onKey.mockClear();

    act(() => {
      terminal.scrollTo(3, 40);
    });
    const pill = within(rig.region).getByRole('button', { name: msg('workspace.pane.latest') });
    pill.focus();
    fireEvent.keyDown(pill, { key: '/' });
    fireEvent.keyDown(pill, { key: 'f' });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('runs no shortcut from the terminal text area or from the region itself', async () => {
    const onKey = vi.fn<(key: string) => void>();
    const rig = await renderLive({ around: withRegistry(onKey) });
    const area = rig.fake.engine.last().terminal.textarea;
    if (area === undefined) throw new Error('no text area');
    fireEvent.keyDown(area, { key: '/' });
    fireEvent.keyDown(rig.region, { key: 'f' });
    fireEvent.keyDown(rig.host, { key: '/' });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('runs the shortcut again once the focus is back outside (the way out of the terminal)', async () => {
    const onKey = vi.fn<(key: string) => void>();
    const rig = await renderLive({ around: withRegistry(onKey), props: { focusOnLive: true } });
    const terminal = rig.fake.engine.last().terminal;
    expect(document.activeElement).toBe(terminal.textarea);
    const outside = screen.getByRole('button', { name: 'outside the terminal' });
    outside.setAttribute('data-nav-item', '');
    outside.setAttribute('aria-current', 'true');
    act(() => {
      terminal.pressKey({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    });
    expect(document.activeElement).toBe(outside);
    fireEvent.keyDown(outside, { key: 'f' });
    expect(onKey).toHaveBeenCalledWith('f');
  });
});

/** axe schedules its work with timers, so it runs on the real ones; the fake clock comes back for the next step of the test. */
async function axeViolations(container: HTMLElement): Promise<string[]> {
  vi.useRealTimers();
  try {
    // colour contrast needs layout, which the test environment does not have; the contrast gate is lib/tokens-contrast.test.ts
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    return result.violations.map((violation) => violation.id);
  } finally {
    vi.useFakeTimers();
  }
}

describe('accessibility (TC-UI-11)', () => {
  it('has no axe violation in the calm state, with the pill, the size notice and while reconnecting (en and vi)', async () => {
    for (const locale of ['en', 'vi'] as const) {
      const rig = await renderLive({ locale });
      expect(await axeViolations(rig.rendered.container), `${locale} calm`).toEqual([]);

      act(() => {
        rig.fake.engine.last().terminal.scrollTo(3, 40);
      });
      act(() => {
        rig.socket.message({ type: 'size', cols: 80, rows: 40 });
      });
      expect(
        within(rig.region).getByRole('button', { name: msg('workspace.pane.latest', undefined, locale) }),
      ).toBeTruthy();
      expect(await axeViolations(rig.rendered.container), `${locale} pill and size notice`).toEqual([]);

      drop(rig.socket);
      expect(await axeViolations(rig.rendered.container), `${locale} reconnecting`).toEqual([]);
      rig.rendered.unmount();
    }
  });
});
