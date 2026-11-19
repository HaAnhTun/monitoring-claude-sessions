import type { QueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../data/query-keys.ts';
import { createPrefs } from '../lib/prefs.ts';
import { TERMINAL_FONT } from '../lib/term-theme.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { createPrefsStore, type PrefsStore } from '../state/prefs-store.ts';
import {
  fakeEngine,
  fakeSeams,
  giveHostSize,
  handshake,
  setDocumentVisibility,
  stubResizeObserver,
  type FakeTerminalSeams,
  type ResizeObserverStub,
} from '../test/fake-terminal.ts';
import type { FakeWebSocket } from '../test/fake-websocket.ts';
import { FIXTURE_INSTANCE_ID } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderHookWithProviders, renderWithProviders } from '../test/render.tsx';
import { WORD_SEPARATOR } from './options.ts';
import { encodeResize, RELEASE_CHORD, terminalSocketUrl } from './protocol.ts';
import { TerminalSeamsContext } from './seams.ts';
import {
  MQ_REDUCED_MOTION,
  MQ_TERMINAL_NARROW,
  useTerminalConnection,
  type EndedOutcome,
  type UseTerminalConnectionOptions,
} from './useTerminalConnection.ts';

// Design 04 7.3: the 12 steps of the connection of one session, through the engine seam (a fake terminal) and the REAL socket client
// over `FakeWebSocket`. TC-UI-06 (URL, binary input, resize after fit, binary output, reconnect clears the screen before the
// replay, ended), TC-UI-07 (copy keeps the program running, Ctrl+C interrupts, paste goes through xterm) and TC-UI-12 (release).

const IID = FIXTURE_INSTANCE_ID;
const NAME = 'fixture-term-1';
const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

interface Rig {
  fake: FakeTerminalSeams;
  ro: ResizeObserverStub;
  host: HTMLDivElement;
  onEnded: ReturnType<typeof vi.fn<(outcome: EndedOutcome) => void>>;
  queryClient: QueryClient;
  prefsStore: ReturnType<typeof renderHookWithProviders>['prefsStore'];
  result: { readonly current: ReturnType<typeof useTerminalConnection> };
  rerender: (props: Props) => void;
  unmount: () => void;
}

interface Props {
  gone: boolean;
  focusOnLive: boolean;
}

interface MountOptions {
  fake?: FakeTerminalSeams;
  focusOnLive?: boolean;
  /** The size of the host box in px; 0 by 0 is a host that is not laid out. */
  box?: { width: number; height: number };
  windowsHost?: boolean;
  /** Preferences that are already stored when the view mounts (the engine is asked for at once, with what they say). */
  prefsStore?: PrefsStore;
}

function mount(options: MountOptions = {}): Rig {
  const fake = options.fake ?? fakeSeams();
  const ro = stubResizeObserver();
  const host = document.createElement('div');
  document.body.append(host);
  const box = options.box ?? { width: 900, height: 500 };
  giveHostSize(host, box.width, box.height);
  const onEnded = vi.fn<(outcome: EndedOutcome) => void>();
  const rendered = renderHookWithProviders(
    (props: Props) => {
      const hookOptions: UseTerminalConnectionOptions = {
        name: NAME,
        gone: props.gone,
        focusOnLive: props.focusOnLive,
        onEnded,
        ...(options.windowsHost === undefined ? {} : { windowsHost: options.windowsHost }),
      };
      return useTerminalConnection(hookOptions);
    },
    {
      initialProps: { gone: false, focusOnLive: options.focusOnLive ?? true },
      ...(options.prefsStore === undefined ? {} : { prefsStore: options.prefsStore }),
      wrap: (children: ReactNode) => (
        <TerminalSeamsContext value={fake.seams}>
          <AnnouncerProvider>{children}</AnnouncerProvider>
        </TerminalSeamsContext>
      ),
    },
  );
  act(() => {
    rendered.result.current.hostRef(host);
  });
  return {
    fake,
    ro,
    host,
    onEnded,
    queryClient: rendered.queryClient,
    prefsStore: rendered.prefsStore,
    result: rendered.result,
    rerender: rendered.rerender,
    unmount: rendered.unmount,
  };
}

/** Lets the engine load, the effects and the timers that are due now run. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mounts, lets the engine load and plays the server side of the first connection up to and including `live`. */
async function mountLive(
  options: MountOptions & { server?: Parameters<typeof handshake>[1] } = {},
): Promise<Rig & { socket: FakeWebSocket }> {
  const rig = mount(options);
  await settle();
  const socket = rig.fake.sockets.last();
  act(() => {
    handshake(socket, options.server ?? { cols: 120, rows: 30 });
  });
  return { ...rig, socket };
}

function terminalOf(rig: Rig) {
  return rig.fake.engine.last().terminal;
}

/** The binary frames the client sent, as text (they are UTF-8 in these tests). */
function sentTextOf(socket: FakeWebSocket): string[] {
  return socket.sentBinary.map((frame) => new TextDecoder().decode(frame));
}

function resizeFrames(socket: FakeWebSocket): string[] {
  return socket.sentText;
}

function stubClipboard(
  writeText: (text: string) => Promise<void>,
  readText: () => Promise<string> = () => Promise.resolve(''),
): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } });
  vi.stubGlobal('isSecureContext', true);
}

/** Tells the page which platform it runs on (`navigator.userAgentData.platform`, the first thing `platformIsMac` reads). */
function stubPlatform(platform: string): void {
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform } });
}

interface MediaStub {
  /** Sets whether `query` matches and tells the page. */
  set(query: string, matches: boolean): void;
}

function stubMatchMedia(initial: Record<string, boolean> = {}): MediaStub {
  const state = new Map<string, boolean>(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return state.get(query) ?? false;
    },
    media: query,
    addEventListener: (_type: string, fn: () => void) => {
      const set = listeners.get(query) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(query, set);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners.get(query)?.delete(fn);
    },
  }));
  return {
    set(query, matches) {
      state.set(query, matches);
      act(() => {
        for (const fn of listeners.get(query) ?? []) fn();
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  stubPlatform('Windows');
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-theme');
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(navigator, 'userAgentData');
  document.body.replaceChildren();
});

describe('1 loading and opening (TC-UI-06)', () => {
  it('shows loading-engine, then opens the terminal on the host and connects the socket without focusing it', async () => {
    const fake = fakeSeams();
    const release = fake.holdNextLoad();
    const rig = mount({ fake });
    expect(rig.result.current.status).toEqual({ kind: 'loading-engine' });
    expect(fake.sockets.instances).toHaveLength(0);

    release();
    await settle();

    expect(rig.result.current.status).toEqual({ kind: 'connecting' });
    const { terminal } = fake.engine.last();
    expect(terminal.host).toBe(rig.host);
    expect(terminal.textarea?.getAttribute('aria-label')).toBe(msg('terminal.input'));
    const socket = fake.sockets.last();
    expect(socket.url).toBe(terminalSocketUrl(NAME, window.location));
    expect(socket.url).not.toMatch(/[?#]/);
    expect(socket.protocols).toEqual(['caw.terminal.v1']);
    expect(socket.binaryType).toBe('arraybuffer');
    // no focus on first paint: the page asks for it on `live`
    expect(terminal.focusCount).toBe(0);
    expect(document.activeElement).not.toBe(terminal.textarea);
  });

  it('creates the terminal with the options of the page: history, ratio 1, the screen reader preference, no Windows hint', async () => {
    const fake = fakeSeams();
    stubMatchMedia({ [MQ_REDUCED_MOTION]: true });
    const rig = mount({ fake });
    act(() => {
      rig.prefsStore.setPref('terminalScreenReader', true);
    });
    await settle();
    const options = fake.engine.last().options;
    expect(options.scrollback).toBe(20_000);
    expect(options.minimumContrastRatio).toBe(1);
    expect(options.screenReaderMode).toBe(true);
    expect(options.cursorBlink).toBe(false);
    expect(options.fontSize).toBe(TERMINAL_FONT.size);
    expect(options.fontFamily).not.toBe('');
    expect('windowsPty' in options).toBe(false);
  });

  it('passes the Windows hint through when the caller knows the host', async () => {
    const rig = mount({ windowsHost: true });
    await settle();
    expect(rig.fake.engine.last().options.windowsPty).toEqual({ backend: 'conpty' });
  });

  it('says engine-failed when the chunk cannot load, opens nothing, and Retry loads it again', async () => {
    const fake = fakeSeams();
    fake.failNextLoad();
    const rig = mount({ fake });
    await settle();
    expect(rig.result.current.status).toEqual({ kind: 'engine-failed' });
    expect(fake.sockets.instances).toHaveLength(0);
    expect(fake.engine.instances).toHaveLength(0);

    act(() => {
      rig.result.current.retryNow();
    });
    await settle();
    expect(fake.loadCount()).toBe(2);
    expect(rig.result.current.status).toEqual({ kind: 'connecting' });
    expect(fake.sockets.instances).toHaveLength(1);
  });

  it('says engine-failed when the terminal cannot be created and leaves no socket behind', async () => {
    const fake = fakeSeams();
    fake.engine.failNextCreate = new Error('no canvas');
    const rig = mount({ fake });
    await settle();
    expect(rig.result.current.status).toEqual({ kind: 'engine-failed' });
    expect(fake.sockets.instances).toHaveLength(0);
  });
});

describe('2 ready: reset and adopt the size of the process (TC-UI-06)', () => {
  it('resets the screen, adopts the size of the process without echoing it back, and does not fit while the replay arrives', async () => {
    const rig = mount();
    await settle();
    const socket = rig.fake.sockets.last();
    const terminal = terminalOf(rig);
    act(() => {
      handshake(socket, { cols: 120, rows: 30, skipLive: true });
    });
    expect(terminal.resets).toBe(1);
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 120, rows: 30 });
    expect(resizeFrames(socket)).toEqual([]);
    expect(rig.result.current.size).toEqual({ cols: 120, rows: 30 });
    expect(rig.result.current.status).toEqual({ kind: 'connecting' });

    // the window changes size while the replay is read: nothing is fitted until `live`
    rig.ro.trigger();
    await settle(500);
    expect(rig.fake.engine.last().fit.fitCalls).toBe(0);
  });
});

describe('3 replay and output (TC-UI-06)', () => {
  it('writes every binary frame to the terminal in order and never a text frame', async () => {
    const rig = mount();
    await settle();
    const socket = rig.fake.sockets.last();
    act(() => {
      handshake(socket, { replay: ['first\r\n', 'second\r\n'], skipLive: true });
      socket.message('this is not a protocol frame');
      socket.message('{"type":"unknown"}');
      socket.message(bytes('third\r\n'));
    });
    const terminal = terminalOf(rig);
    expect(terminal.writes).toEqual([bytes('first\r\n'), bytes('second\r\n'), bytes('third\r\n')]);
    expect(terminal.screen).toBe('first\r\nsecond\r\nthird\r\n');
  });
});

describe('4 live: fit and send our size (TC-UI-06)', () => {
  it('fits to the window and sends the size when it differs from the process, then is live and focuses once on request', async () => {
    const rig = await mountLive({ server: { cols: 120, rows: 30 } });
    expect(rig.result.current.status).toEqual({ kind: 'live' });
    expect(rig.fake.engine.last().fit.fitCalls).toBe(1);
    expect(resizeFrames(rig.socket)).toEqual([encodeResize(100, 30)]);
    expect(rig.result.current.size).toEqual({ cols: 100, rows: 30 });
    expect(terminalOf(rig).focusCount).toBe(1);
  });

  it('sends nothing when the fitted size is the size of the process', async () => {
    const fake = fakeSeams(fakeEngine({ cols: 120, rows: 30 }));
    const rig = await mountLive({ fake, server: { cols: 120, rows: 30 } });
    expect(rig.fake.engine.last().fit.fitCalls).toBe(1);
    expect(resizeFrames(rig.socket)).toEqual([]);
    expect(rig.result.current.status).toEqual({ kind: 'live' });
  });

  it('does not focus the terminal when the page did not ask (a reconnect is not a selection)', async () => {
    const rig = await mountLive({ focusOnLive: false });
    expect(terminalOf(rig).focusCount).toBe(0);
  });

  it('focuses only on the first live: a reconnect does not take the focus back', async () => {
    const rig = await mountLive();
    expect(terminalOf(rig).focusCount).toBe(1);
    act(() => {
      rig.socket.closeFromServer(1006);
    });
    await settle();
    act(() => {
      handshake(rig.fake.sockets.last(), { cols: 120, rows: 30 });
    });
    expect(rig.result.current.status).toEqual({ kind: 'live' });
    expect(terminalOf(rig).focusCount).toBe(1);
  });
});

describe('5 fit: 100 ms debounce, dedupe and clamp (TC-UI-06)', () => {
  it('fits once, 100 ms after the last of several size changes, and sends the new size once', async () => {
    const rig = await mountLive();
    const fit = rig.fake.engine.last().fit;
    fit.proposed = { cols: 90, rows: 25 };
    rig.ro.trigger();
    await settle(40);
    rig.ro.trigger();
    await settle(40);
    rig.ro.trigger();
    await settle(99);
    expect(fit.fitCalls).toBe(1);
    await settle(1);
    expect(fit.fitCalls).toBe(2);
    expect(resizeFrames(rig.socket)).toEqual([encodeResize(100, 30), encodeResize(90, 25)]);
  });

  it('sends a size again only when it changed', async () => {
    const rig = await mountLive();
    const fit = rig.fake.engine.last().fit;
    fit.proposed = { cols: 90, rows: 25 };
    rig.ro.trigger();
    await settle(100);
    rig.ro.trigger();
    await settle(100);
    expect(fit.fitCalls).toBe(3);
    expect(resizeFrames(rig.socket)).toHaveLength(2);
  });

  it('sends the clamped size and does not send again while the clamped size stays the same', async () => {
    const rig = await mountLive();
    const fit = rig.fake.engine.last().fit;
    fit.proposed = { cols: 10, rows: 3 };
    rig.ro.trigger();
    await settle(100);
    expect(resizeFrames(rig.socket).at(-1)).toBe(encodeResize(20, 5));
    fit.proposed = { cols: 15, rows: 4 };
    rig.ro.trigger();
    await settle(100);
    // the terminal changed (10x3 to 15x4) but both clamp to 20x5, which the process already has
    expect(resizeFrames(rig.socket).filter((frame) => frame === encodeResize(20, 5))).toHaveLength(1);
  });

  it('does not fit a host that has no room', async () => {
    const rig = await mountLive({ box: { width: 0, height: 0 } });
    rig.ro.trigger();
    await settle(200);
    expect(rig.fake.engine.last().fit.fitCalls).toBe(0);
    expect(resizeFrames(rig.socket)).toEqual([]);
    // the first live still says live: the terminal keeps the size of the process
    expect(rig.result.current.status).toEqual({ kind: 'live' });
  });

  it('fits when the window becomes visible and sends nothing from a hidden tab', async () => {
    const rig = await mountLive();
    const fit = rig.fake.engine.last().fit;
    setDocumentVisibility('hidden');
    fit.proposed = { cols: 80, rows: 24 };
    rig.ro.trigger();
    await settle(300);
    expect(fit.fitCalls).toBe(1);
    expect(resizeFrames(rig.socket)).toEqual([encodeResize(100, 30)]);

    setDocumentVisibility('visible');
    await settle();
    expect(fit.fitCalls).toBe(2);
    expect(resizeFrames(rig.socket).at(-1)).toBe(encodeResize(80, 24));
  });

  it('sends no size from a hidden tab even when the terminal changed size by itself (a font size change reflows it)', async () => {
    const rig = await mountLive();
    const sent = resizeFrames(rig.socket).length;
    setDocumentVisibility('hidden');
    act(() => {
      terminalOf(rig).resize(70, 20);
    });
    expect(resizeFrames(rig.socket)).toHaveLength(sent);
    expect(rig.result.current.size).toEqual({ cols: 70, rows: 20 });
  });
});

describe('7 size owner: mirror and take back (TC-UI-06, risk R4)', () => {
  it('mirrors the size of another window, says so, sends nothing back and stops fitting', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    const sent = resizeFrames(rig.socket).length;
    act(() => {
      rig.socket.message({ type: 'size', cols: 80, rows: 40 });
    });
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 80, rows: 40 });
    expect(rig.result.current.sizeOwner).toEqual({ cols: 80, rows: 40 });
    expect(rig.result.current.size).toEqual({ cols: 80, rows: 40 });
    expect(resizeFrames(rig.socket)).toHaveLength(sent);

    const fit = rig.fake.engine.last().fit;
    const calls = fit.fitCalls;
    rig.ro.trigger();
    await settle(300);
    expect(fit.fitCalls).toBe(calls);
  });

  it('takes the size back on request: fits, sends our size and owns it again', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'size', cols: 80, rows: 40 });
    });
    act(() => {
      rig.result.current.handle.takeSize();
    });
    expect(rig.result.current.sizeOwner).toBe('self');
    expect(resizeFrames(rig.socket).at(-1)).toBe(encodeResize(100, 30));
    expect(rig.result.current.size).toEqual({ cols: 100, rows: 30 });
  });

  it('takes the size back on the first keystroke, and sends the size before the key', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'size', cols: 80, rows: 40 });
    });
    const before = rig.socket.sent.length;
    act(() => {
      terminalOf(rig).emitData('x');
    });
    expect(rig.result.current.sizeOwner).toBe('self');
    expect(rig.socket.sent.slice(before).map((frame) => frame.kind)).toEqual(['text', 'binary']);
    expect(resizeFrames(rig.socket).at(-1)).toBe(encodeResize(100, 30));
    expect(sentTextOf(rig.socket)).toEqual(['x']);
  });

  it('does not take the size of its own resize for another window (the server echoes it to every viewer)', async () => {
    const rig = await mountLive();
    const fit = rig.fake.engine.last().fit;
    fit.proposed = { cols: 90, rows: 25 };
    rig.ro.trigger();
    await settle(100);
    act(() => {
      rig.socket.message({ type: 'size', cols: 100, rows: 30 });
      rig.socket.message({ type: 'size', cols: 90, rows: 25 });
    });
    expect(rig.result.current.sizeOwner).toBe('self');
  });

  it('shows a resize of another window that arrives before the echo of ours, and owns the size again at the echo', async () => {
    const rig = await mountLive();
    const fit = rig.fake.engine.last().fit;
    fit.proposed = { cols: 90, rows: 25 };
    rig.ro.trigger();
    await settle(100);
    act(() => {
      rig.socket.message({ type: 'size', cols: 100, rows: 30 });
      rig.socket.message({ type: 'size', cols: 70, rows: 20 });
    });
    expect(rig.result.current.sizeOwner).toEqual({ cols: 70, rows: 20 });
    act(() => {
      rig.socket.message({ type: 'size', cols: 90, rows: 25 });
    });
    expect(rig.result.current.sizeOwner).toBe('self');
    expect(rig.result.current.size).toEqual({ cols: 90, rows: 25 });
  });

  it('redraw sends one row less and then the real size, 60 ms apart, and its echoes do not look like another window', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    act(() => {
      rig.result.current.handle.redraw();
    });
    expect(resizeFrames(rig.socket).slice(-1)).toEqual([encodeResize(100, 29)]);
    await settle(59);
    expect(resizeFrames(rig.socket).slice(-1)).toEqual([encodeResize(100, 29)]);
    await settle(1);
    expect(resizeFrames(rig.socket).slice(-2)).toEqual([encodeResize(100, 29), encodeResize(100, 30)]);

    act(() => {
      rig.socket.message({ type: 'size', cols: 100, rows: 29 });
    });
    expect(terminal.rows).toBe(29);
    expect(rig.result.current.sizeOwner).toBe('self');
    act(() => {
      rig.socket.message({ type: 'size', cols: 100, rows: 30 });
    });
    expect(terminal.rows).toBe(30);
    expect(rig.result.current.sizeOwner).toBe('self');
  });

  it('a size frame that equals ours changes nothing', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'size', cols: 100, rows: 30 });
    });
    expect(rig.result.current.sizeOwner).toBe('self');
  });
});

describe('8 ending (TC-UI-06)', () => {
  it('an exit frame ends the view with its code and tells the page once; the close that follows does not reconnect', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'exit', code: 0, signal: null });
    });
    expect(rig.result.current.status).toEqual({ kind: 'ended', exitCode: 0, killed: false });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
    expect(rig.onEnded).toHaveBeenLastCalledWith({ exitCode: 0, killed: false });

    act(() => {
      rig.socket.closeFromServer(4000);
    });
    await settle(60_000);
    expect(rig.result.current.status).toEqual({ kind: 'ended', exitCode: 0, killed: false });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
    expect(rig.fake.sockets.instances).toHaveLength(1);
  });

  it('a stop (close 4001 after the exit frame) is shown as stopped and corrects what the page was told', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'exit', code: null, signal: 'SIGKILL' });
      rig.socket.closeFromServer(4001);
    });
    expect(rig.result.current.status).toEqual({ kind: 'ended', exitCode: null, killed: true });
    expect(rig.onEnded.mock.calls.map(([outcome]) => outcome)).toEqual([
      { exitCode: null, killed: false },
      { exitCode: null, killed: true },
    ]);
  });

  it('a normal close without an exit frame ends the view with no code', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.closeFromServer(1000);
    });
    expect(rig.result.current.status).toEqual({ kind: 'ended', exitCode: null, killed: false });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
  });

  it('a close with 4003 locks the view and the page (the session of the browser is over)', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.closeFromServer(4003);
    });
    expect(rig.result.current.status).toEqual({ kind: 'locked' });
    expect(rig.queryClient.getQueryData(qk.authSession(IID))).toEqual({ authenticated: false });
    expect(rig.onEnded).not.toHaveBeenCalled();
    await settle(60_000);
    expect(rig.fake.sockets.instances).toHaveLength(1);
  });

  it('a close that is our own bug (1009) says failed, and Retry connects again instead of looping', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.closeFromServer(1009);
    });
    expect(rig.result.current.status).toEqual({ kind: 'failed' });
    await settle(60_000);
    expect(rig.fake.sockets.instances).toHaveLength(1);
    act(() => {
      rig.result.current.retryNow();
    });
    expect(rig.fake.sockets.instances).toHaveLength(2);
  });

  it('gone (the session list lacks the session) stops the socket and ends the view once, whatever the server says after', async () => {
    const rig = await mountLive();
    rig.rerender({ gone: true, focusOnLive: true });
    expect(rig.result.current.status).toEqual({ kind: 'ended', exitCode: null, killed: false });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
    expect(rig.onEnded).toHaveBeenLastCalledWith({ exitCode: null, killed: false });
    expect(rig.socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    act(() => {
      rig.socket.message(bytes('late output'), { force: true });
    });
    await settle(60_000);
    expect(terminalOf(rig).screen).not.toContain('late output');
    expect(rig.fake.sockets.instances).toHaveLength(1);
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
  });

  it('gone after an exit frame does not tell the page a second time', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'exit', code: 7, signal: null });
    });
    rig.rerender({ gone: true, focusOnLive: true });
    expect(rig.onEnded).toHaveBeenCalledTimes(1);
    expect(rig.result.current.status).toEqual({ kind: 'ended', exitCode: 7, killed: false });
  });
});

describe('9 input (TC-UI-06, TC-UI-07)', () => {
  it('sends typed text as UTF-8 binary frames', async () => {
    const rig = await mountLive();
    act(() => {
      terminalOf(rig).emitData('ls\r');
      terminalOf(rig).emitData('é');
    });
    expect(rig.socket.sentBinary).toEqual([bytes('ls\r'), Uint8Array.of(0xc3, 0xa9)]);
  });

  it('sends the binary channel of xterm byte for byte (a character code is a byte, not UTF-8)', async () => {
    const rig = await mountLive();
    act(() => {
      terminalOf(rig).emitBinary('\x1b[M\x80\xff');
    });
    expect(rig.socket.sentBinary.at(-1)).toEqual(Uint8Array.of(0x1b, 0x5b, 0x4d, 0x80, 0xff));
  });

  it('while the connection is down typing is lost, not queued, and the view says so until it is live again', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.closeFromServer(1006);
    });
    expect(rig.result.current.typingPaused).toBe(false);
    act(() => {
      terminalOf(rig).emitData('x');
    });
    expect(rig.result.current.typingPaused).toBe(true);
    expect(rig.socket.sentBinary).toEqual([]);
    await settle();
    act(() => {
      handshake(rig.fake.sockets.last(), { cols: 120, rows: 30 });
    });
    expect(rig.result.current.typingPaused).toBe(false);
    // nothing typed during the outage is sent late
    expect(rig.fake.sockets.last().sentBinary).toEqual([]);
  });

  it('typing into an ended session is not an outage', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.message({ type: 'exit', code: 0, signal: null });
      rig.socket.closeFromServer(4000);
    });
    act(() => {
      terminalOf(rig).emitData('x');
    });
    expect(rig.result.current.typingPaused).toBe(false);
  });
});

describe('11 reconnect and the oracle (TC-UI-06)', () => {
  it('shows reconnecting, asks for the session list once, and rebuilds the screen from the replay with no duplicated line', async () => {
    const rig = await mountLive({ server: { cols: 120, rows: 30, replay: ['line 1\r\n', 'line 2\r\n'] } });
    const terminal = terminalOf(rig);
    expect(terminal.screen).toBe('line 1\r\nline 2\r\n');
    const invalidate = vi.spyOn(rig.queryClient, 'invalidateQueries');

    act(() => {
      rig.socket.closeFromServer(1006);
    });
    expect(rig.result.current.status).toMatchObject({ kind: 'reconnecting', attempt: 1 });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.terminalState(IID) });

    await settle();
    expect(rig.fake.sockets.instances).toHaveLength(2);
    expect(rig.result.current.status).toEqual({ kind: 'reconnecting', attempt: 1, nextRetryAt: null });

    act(() => {
      handshake(rig.fake.sockets.last(), { cols: 120, rows: 30, replay: ['line 1\r\n', 'line 2\r\n'], skipLive: true });
    });
    expect(terminal.resets).toBe(2);
    expect(rig.result.current.status).toEqual({ kind: 'connecting' });
    expect(terminal.screen).toBe('line 1\r\nline 2\r\n');
    act(() => {
      rig.fake.sockets.last().message({ type: 'live' });
    });
    expect(rig.result.current.status).toEqual({ kind: 'live' });
    expect(terminal.screen).toBe('line 1\r\nline 2\r\n');
    // one terminal for the whole outage: the view is rebuilt in place, not remounted
    expect(rig.fake.engine.instances).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('counts the wait of a failed attempt and lets Retry now skip it', async () => {
    const rig = await mountLive();
    act(() => {
      rig.socket.closeFromServer(1006);
    });
    await settle();
    // the second connection never opens: the next wait is one second
    const second = rig.fake.sockets.last();
    const failedAt = Date.now();
    act(() => {
      second.closeFromServer(1006);
    });
    expect(rig.result.current.status).toEqual({ kind: 'reconnecting', attempt: 2, nextRetryAt: failedAt + 1000 });
    act(() => {
      rig.result.current.retryNow();
    });
    expect(rig.fake.sockets.instances).toHaveLength(3);
  });

  it('asks for the session list again after two refused handshakes in a row, and only then (the oracle of design 04 8.2)', async () => {
    const rig = mount();
    await settle();
    const invalidate = vi.spyOn(rig.queryClient, 'invalidateQueries');
    act(() => {
      rig.fake.sockets.last().closeFromServer(1006);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    await settle();
    act(() => {
      rig.fake.sockets.last().closeFromServer(1006);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    await settle(1000);
    act(() => {
      rig.fake.sockets.last().closeFromServer(1006);
    });
    // a third refusal in the same outage does not ask again: the 15 s cap bounds the noise
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('asks again in the next outage', async () => {
    const rig = await mountLive();
    const invalidate = vi.spyOn(rig.queryClient, 'invalidateQueries');
    act(() => {
      rig.socket.closeFromServer(1001);
    });
    await settle();
    act(() => {
      handshake(rig.fake.sockets.last(), { cols: 120, rows: 30 });
    });
    act(() => {
      rig.fake.sockets.last().closeFromServer(1013);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

describe('copy, interrupt, paste and the way out (TC-UI-07, TC-UI-12)', () => {
  it('Ctrl+C with a selection copies it, clears the selection, announces it and sends nothing to the program', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    const before = rig.socket.sent.length;
    terminal.setSelection('selected words');

    expect(terminal.pressKey({ key: 'c', ctrlKey: true })).toBe(false);
    await settle(50);

    expect(writeText).toHaveBeenCalledWith('selected words');
    expect(terminal.hasSelection()).toBe(false);
    expect(rig.socket.sent).toHaveLength(before);
    expect(terminal.takenKeys[0]?.defaultPrevented).toBe(true);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('common.copied'));
  });

  it('the second Ctrl+C, with nothing selected any more, interrupts the program with 0x03', async () => {
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined));
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    terminal.setSelection('abc');
    terminal.pressKey({ key: 'c', ctrlKey: true });
    await settle(50);
    expect(rig.socket.sentBinary).toEqual([]);

    expect(terminal.pressKey({ key: 'c', ctrlKey: true })).toBe(true);
    expect(rig.socket.sentBinary).toEqual([Uint8Array.of(3)]);
  });

  it('Ctrl+C without a selection reaches the socket as 0x03 and takes nothing from the page', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.pressKey({ key: 'c', ctrlKey: true })).toBe(true);
    expect(terminal.takenKeys).toEqual([]);
    expect(rig.socket.sentBinary).toEqual([Uint8Array.of(3)]);
  });

  it('keeps the selection and says so when the clipboard refuses', async () => {
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied')));
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    terminal.setSelection('abc');
    terminal.pressKey({ key: 'c', ctrlKey: true });
    await settle(50);
    expect(terminal.hasSelection()).toBe(true);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('common.copyFailed'));
  });

  it('Ctrl+Shift+C copies a selection and, without one, does neither interrupt nor anything else', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.pressKey({ key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(rig.socket.sentBinary).toEqual([]);
    expect(terminal.takenKeys[0]?.defaultPrevented).toBe(true);

    terminal.setSelection('picked');
    expect(terminal.pressKey({ key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
    await settle(50);
    expect(writeText).toHaveBeenCalledWith('picked');
  });

  it('paste goes through the paste path of xterm itself: Ctrl+Shift+V and Shift+Insert pass, the text arrives as input', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.pressKey({ key: 'V', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(terminal.pressKey({ key: 'Insert', shiftKey: true })).toBe(true);
    terminal.paste('pasted text');
    expect(terminal.pastes).toEqual(['pasted text']);
    expect(sentTextOf(rig.socket)).toEqual(['pasted text']);
  });

  it('Tab and Shift+Tab belong to the program', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.pressKey({ key: 'Tab' })).toBe(true);
    expect(terminal.pressKey({ key: 'Tab', shiftKey: true })).toBe(true);
    expect(rig.socket.sentBinary).toEqual([bytes('\t'), bytes('\x1b[Z')]);
    expect(terminal.takenKeys).toEqual([]);
  });

  describe(`the way out (${RELEASE_CHORD})`, () => {
    const release = { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true } as const;

    it('blurs the terminal and focuses the selected session row', async () => {
      const row = document.createElement('a');
      row.href = '#row';
      row.setAttribute('data-nav-item', '');
      row.setAttribute('aria-current', 'true');
      const other = document.createElement('a');
      other.href = '#other';
      other.setAttribute('data-nav-item', '');
      document.body.append(other, row);
      const rig = await mountLive();
      const terminal = terminalOf(rig);
      terminal.focus();
      expect(document.activeElement).toBe(terminal.textarea);

      expect(terminal.pressKey(release)).toBe(false);
      expect(terminal.takenKeys[0]?.defaultPrevented).toBe(true);
      expect(terminal.blurCount).toBe(1);
      expect(document.activeElement).toBe(row);
      expect(rig.socket.sentBinary).toEqual([]);
    });

    it('without a selected row it focuses the project list, and without that the main area', async () => {
      const list = document.createElement('nav');
      list.id = 'project-list';
      list.tabIndex = -1;
      const main = document.createElement('main');
      main.id = 'main';
      main.tabIndex = -1;
      document.body.append(list, main);
      const rig = await mountLive();
      terminalOf(rig).pressKey(release);
      expect(document.activeElement).toBe(list);

      list.remove();
      terminalOf(rig).focus();
      terminalOf(rig).pressKey(release);
      expect(document.activeElement).toBe(main);
    });

    it('does not throw when there is nowhere to go', async () => {
      const rig = await mountLive();
      expect(() => terminalOf(rig).pressKey(release)).not.toThrow();
    });

    it('does not release on Ctrl+Space or Shift+Space alone', async () => {
      const rig = await mountLive();
      const terminal = terminalOf(rig);
      expect(terminal.pressKey({ key: ' ', code: 'Space', ctrlKey: true })).toBe(true);
      expect(terminal.pressKey({ key: ' ', code: 'Space', shiftKey: true })).toBe(true);
      expect(terminal.blurCount).toBe(0);
    });
  });
});

describe('window focus', () => {
  it('gives the focus back to the terminal only when it had the focus when the window lost it', async () => {
    const rig = await mountLive({ focusOnLive: false });
    const terminal = terminalOf(rig);
    const bystander = document.createElement('button');
    document.body.append(bystander);

    bystander.focus();
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(terminal.focusCount).toBe(0);

    terminal.focus();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    terminal.blur();
    const focusCount = terminal.focusCount;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(terminal.focusCount).toBe(focusCount + 1);
  });
});

describe('theme, font size and preferences follow the page', () => {
  it('assigns a new theme to the terminal when the colour scheme changes', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    const before = terminal.options.theme;
    expect(before).toBe(rig.fake.engine.last().options.theme);
    act(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await settle();
    expect(terminal.options.theme).toBeDefined();
    expect(terminal.options.theme).not.toBe(before);
  });

  it('switches to 12 px below the narrow breakpoint, back to 13 px above it, and fits again', async () => {
    const media = stubMatchMedia();
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    const fit = rig.fake.engine.last().fit;
    expect(terminal.options.fontSize).toBe(TERMINAL_FONT.size);
    const calls = fit.fitCalls;

    media.set(MQ_TERMINAL_NARROW, true);
    await settle(100);
    expect(terminal.options.fontSize).toBe(TERMINAL_FONT.sizeNarrow);
    expect(fit.fitCalls).toBeGreaterThan(calls);

    media.set(MQ_TERMINAL_NARROW, false);
    await settle(100);
    expect(terminal.options.fontSize).toBe(TERMINAL_FONT.size);
  });

  it('turns the screen reader mode and the blinking cursor on and off while the terminal lives', async () => {
    const media = stubMatchMedia();
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.options.screenReaderMode).toBe(false);
    expect(terminal.options.cursorBlink).toBe(true);

    act(() => {
      rig.prefsStore.setPref('terminalScreenReader', true);
    });
    expect(terminal.options.screenReaderMode).toBe(true);
    media.set(MQ_REDUCED_MOTION, true);
    expect(terminal.options.cursorBlink).toBe(false);
    media.set(MQ_REDUCED_MOTION, false);
    expect(terminal.options.cursorBlink).toBe(true);
  });
});

describe('Ctrl+V pastes (CAW-144: xterm 6.0.0 would send 0x16 and cancel the paste)', () => {
  it('takes the key away from xterm without preventing the default, so the browser fires paste; the hook sends nothing itself', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.pressKey({ key: 'v', ctrlKey: true })).toBe(false);
    expect(terminal.takenKeys).toHaveLength(1);
    expect(terminal.takenKeys[0]?.defaultPrevented).toBe(false);
    expect(rig.socket.sentBinary).toEqual([]);
    // the browser's paste event reaches xterm's own paste path, which sends the text as input
    terminal.paste('two lines');
    expect(sentTextOf(rig.socket)).toEqual(['two lines']);
  });

  it('does the same with a selection (the selection is not copied or cleared)', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    terminal.setSelection('picked');
    expect(terminal.pressKey({ key: 'V', ctrlKey: true })).toBe(false);
    expect(terminal.takenKeys[0]?.defaultPrevented).toBe(false);
    expect(terminal.hasSelection()).toBe(true);
  });

  it('leaves Ctrl+V to the program on macOS, and Alt+V (the image paste) everywhere', async () => {
    stubPlatform('macOS');
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.pressKey({ key: 'v', ctrlKey: true })).toBe(true);
    expect(terminal.takenKeys).toEqual([]);
    expect(terminal.pressKey({ key: 'v', altKey: true })).toBe(true);
    expect(terminal.takenKeys).toEqual([]);
  });
});

describe('the GPU renderer (CAW-144, ADR 0135)', () => {
  it('asks the engine for the GPU renderer unless the preference says dom, and attaches once, after open', async () => {
    const rig = mount();
    await settle();
    expect(rig.fake.loadOptions).toEqual([{ gpu: true }]);
    const renderer = rig.fake.engine.last().renderer;
    expect(renderer.attachCalls).toBe(1);
    expect(renderer.openedAtAttach).toEqual([true]);
    expect(renderer.kind()).toBe('webgl');
  });

  it('does not ask for the GPU renderer when the preference is dom', async () => {
    const fake = fakeSeams();
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('terminalRenderer', 'dom');
    mount({ fake, prefsStore });
    await settle();
    expect(fake.loadOptions).toEqual([{ gpu: false }]);
  });

  it('keeps working on the DOM renderer when the engine says it could not attach', async () => {
    const fake = fakeSeams();
    fake.engine.rendererKind = 'dom';
    const rig = await mountLive({ fake });
    expect(rig.result.current.status).toEqual({ kind: 'live' });
    expect(rig.fake.engine.last().renderer.kind()).toBe('dom');
  });

  it('survives an attach that throws: the terminal is not the engine failing', async () => {
    const fake = fakeSeams();
    fake.engine.failNextAttach = new Error('attach failed');
    const rig = await mountLive({ fake });
    expect(rig.result.current.status).toEqual({ kind: 'live' });
    expect(fake.engine.instances).toHaveLength(1);
    expect(terminalOf(rig).disposed).toBe(false);
  });

  it('fits again after the GPU context is lost for good (the cell size may differ), and does nothing else', async () => {
    const rig = await mountLive();
    const instance = rig.fake.engine.last();
    const calls = instance.fit.fitCalls;
    const sent = rig.socket.sent.length;
    instance.renderer.fireFallback();
    expect(instance.fit.fitCalls).toBe(calls);
    await settle(100);
    expect(instance.fit.fitCalls).toBeGreaterThan(calls);
    expect(rig.result.current.status).toEqual({ kind: 'live' });
    expect(rig.socket.sent.length).toBeGreaterThanOrEqual(sent);
    expect(document.getElementById('live-region')?.textContent ?? '').toBe('');
  });

  it('stops listening for the fallback when the view goes away', async () => {
    const rig = await mountLive();
    const instance = rig.fake.engine.last();
    rig.unmount();
    expect(() => {
      instance.renderer.fireFallback();
    }).not.toThrow();
  });
});

/** A right click on the terminal: it starts in xterm's own element, inside the host, and is cancelable. */
function rightClick(rig: Rig, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
  (rig.host.querySelector('.xterm') ?? rig.host).dispatchEvent(event);
  return event;
}

describe('right click (CAW-144)', () => {
  it('copies a selection, clears it, announces it and keeps the browser menu away', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const readText = vi.fn<() => Promise<string>>().mockResolvedValue('from the clipboard');
    stubClipboard(writeText, readText);
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    terminal.setSelection('selected words');
    const event = rightClick(rig);
    await settle(50);
    expect(event.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith('selected words');
    expect(terminal.hasSelection()).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    expect(terminal.pastes).toEqual([]);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('common.copied'));
  });

  it('keeps the selection and says so when the copy is refused', async () => {
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied')));
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    terminal.setSelection('abc');
    rightClick(rig);
    await settle(50);
    expect(terminal.hasSelection()).toBe(true);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('common.copyFailed'));
  });

  it('pastes the clipboard text through the paste path of xterm when nothing is selected', async () => {
    const readText = vi.fn<() => Promise<string>>().mockResolvedValue('line one');
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText);
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    const event = rightClick(rig);
    await settle(50);
    expect(event.defaultPrevented).toBe(true);
    expect(terminal.pastes).toEqual(['line one']);
    expect(sentTextOf(rig.socket)).toEqual(['line one']);
  });

  it('pastes nothing for an empty clipboard', async () => {
    stubClipboard(
      vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
      vi.fn<() => Promise<string>>().mockResolvedValue(''),
    );
    const rig = await mountLive();
    const event = rightClick(rig);
    await settle(50);
    expect(event.defaultPrevented).toBe(true);
    expect(terminalOf(rig).pastes).toEqual([]);
    expect(rig.socket.sentBinary).toEqual([]);
  });

  it('says once that the clipboard is closed and lets the next right click through to the browser menu', async () => {
    const readText = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('denied'));
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText);
    const rig = await mountLive();
    const first = rightClick(rig);
    await settle(50);
    expect(first.defaultPrevented).toBe(true);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('terminal.clipboard.pasteBlocked'));
    expect(readText).toHaveBeenCalledTimes(1);

    const second = rightClick(rig);
    await settle(50);
    expect(second.defaultPrevented).toBe(false);
    expect(readText).toHaveBeenCalledTimes(1);

    // after the menu was let through, the smart behaviour is back
    const third = rightClick(rig);
    await settle(50);
    expect(third.defaultPrevented).toBe(true);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it('lets the browser menu through at once, and says nothing, when the page policy forbids reading the clipboard', async () => {
    // the server sends `Permissions-Policy: clipboard-read=()`: readText could never work, so a click must not pretend to paste
    const allowsFeature = vi.fn((feature: string) => feature !== 'clipboard-read');
    Object.defineProperty(document, 'permissionsPolicy', { configurable: true, value: { allowsFeature } });
    try {
      const readText = vi.fn<() => Promise<string>>().mockResolvedValue('never read');
      stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText);
      const rig = await mountLive();
      const terminal = terminalOf(rig);
      const menu = rightClick(rig);
      await settle(50);
      expect(menu.defaultPrevented).toBe(false);
      expect(allowsFeature).toHaveBeenCalledWith('clipboard-read');
      expect(readText).not.toHaveBeenCalled();
      expect(document.getElementById('live-region')?.textContent ?? '').toBe('');
      // copying a selection needs the write permission, which the policy gives the page
      terminal.setSelection('picked');
      const copy = rightClick(rig);
      await settle(50);
      expect(copy.defaultPrevented).toBe(true);
      expect(terminal.hasSelection()).toBe(false);
    } finally {
      Reflect.deleteProperty(document, 'permissionsPolicy');
    }
  });

  it('treats a browser without a readable clipboard like a refusal', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const rig = await mountLive();
    const first = rightClick(rig);
    await settle(50);
    expect(first.defaultPrevented).toBe(true);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('terminal.clipboard.pasteBlocked'));
    expect(rightClick(rig).defaultPrevented).toBe(false);
  });

  it('opens the browser menu on Shift and right click, whatever the preference', async () => {
    const readText = vi.fn<() => Promise<string>>().mockResolvedValue('x');
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText);
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    terminal.setSelection('abc');
    const event = rightClick(rig, { shiftKey: true });
    await settle(50);
    expect(event.defaultPrevented).toBe(false);
    expect(terminal.hasSelection()).toBe(true);
    expect(readText).not.toHaveBeenCalled();
  });

  it('does nothing with the menu preference, and follows a change of the preference while the terminal lives', async () => {
    const readText = vi.fn<() => Promise<string>>().mockResolvedValue('pasted');
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText);
    const rig = await mountLive();
    act(() => {
      rig.prefsStore.setPref('terminalRightClick', 'menu');
    });
    const menu = rightClick(rig);
    await settle(50);
    expect(menu.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    expect(terminalOf(rig).pastes).toEqual([]);

    act(() => {
      rig.prefsStore.setPref('terminalRightClick', 'smart');
    });
    const smart = rightClick(rig);
    await settle(50);
    expect(smart.defaultPrevented).toBe(true);
    expect(terminalOf(rig).pastes).toEqual(['pasted']);
  });

  it('does not paste after the view went away while the clipboard was being read', async () => {
    let resolve: (text: string) => void = () => undefined;
    const readText = vi.fn<() => Promise<string>>(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined), readText);
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    rightClick(rig);
    rig.unmount();
    resolve('late text');
    await settle(50);
    expect(terminal.pastes).toEqual([]);
  });

  it('removes its listener with the view', async () => {
    const rig = await mountLive();
    rig.unmount();
    expect(rightClick(rig).defaultPrevented).toBe(false);
  });
});

/** The mouse button goes up somewhere on the page: a drag selection ends. */
function mouseUp(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('copy on select (CAW-144)', () => {
  it('is off by default: a selection is not copied', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    terminalOf(rig).setSelection('abc');
    mouseUp();
    await settle(50);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies the selection silently when the mouse goes up, once for a whole drag, and keeps the selection', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    act(() => {
      rig.prefsStore.setPref('terminalCopyOnSelect', true);
    });
    const terminal = terminalOf(rig);
    terminal.setSelection('a');
    terminal.setSelection('ab');
    terminal.setSelection('abc');
    expect(writeText).not.toHaveBeenCalled();
    mouseUp();
    await settle(50);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('abc');
    expect(terminal.hasSelection()).toBe(true);
    expect(document.getElementById('live-region')?.textContent ?? '').toBe('');
    // a mouse up that changed no selection copies nothing again
    mouseUp();
    await settle(50);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it('copies nothing when the selection was cleared before the copy ran', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    act(() => {
      rig.prefsStore.setPref('terminalCopyOnSelect', true);
    });
    const terminal = terminalOf(rig);
    terminal.setSelection('abc');
    mouseUp();
    terminal.clearSelection();
    await settle(50);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does not copy an old selection when the preference is switched on later', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    terminalOf(rig).setSelection('old');
    mouseUp();
    await settle(50);
    act(() => {
      rig.prefsStore.setPref('terminalCopyOnSelect', true);
    });
    mouseUp();
    await settle(50);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('still says so when the clipboard refuses', async () => {
    stubClipboard(vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied')));
    const rig = await mountLive();
    act(() => {
      rig.prefsStore.setPref('terminalCopyOnSelect', true);
    });
    terminalOf(rig).setSelection('abc');
    mouseUp();
    await settle(50);
    expect(document.getElementById('live-region')?.textContent).toBe(msg('common.copyFailed'));
  });

  it('stops listening with the view', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const rig = await mountLive();
    act(() => {
      rig.prefsStore.setPref('terminalCopyOnSelect', true);
    });
    const terminal = terminalOf(rig);
    terminal.setSelection('abc');
    rig.unmount();
    mouseUp();
    await settle(50);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('cursor style and word separators (CAW-144)', () => {
  it('creates a block cursor and the word separators of the app', async () => {
    const rig = mount();
    await settle();
    const options = rig.fake.engine.last().options;
    expect(options.cursorStyle).toBe('block');
    expect(options.wordSeparator).toBe(WORD_SEPARATOR);
  });

  it('creates the cursor the preference names', async () => {
    const fake = fakeSeams();
    const rig = mount({ fake });
    act(() => {
      rig.prefsStore.setPref('terminalCursor', 'underline');
    });
    await settle();
    expect(fake.engine.last().options.cursorStyle).toBe('underline');
  });

  it('changes the cursor of an open terminal at once', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(terminal.options.cursorStyle).toBe('block');
    act(() => {
      rig.prefsStore.setPref('terminalCursor', 'bar');
    });
    expect(terminal.options.cursorStyle).toBe('bar');
    act(() => {
      rig.prefsStore.setPref('terminalCursor', 'block');
    });
    expect(terminal.options.cursorStyle).toBe('block');
  });
});

describe('scroll position', () => {
  it('knows when the history is scrolled up, and Jump to latest scrolls back to the newest output', async () => {
    const rig = await mountLive();
    const terminal = terminalOf(rig);
    expect(rig.result.current.scrolledUp).toBe(false);
    act(() => {
      terminal.scrollTo(5, 20);
    });
    expect(rig.result.current.scrolledUp).toBe(true);
    act(() => {
      rig.result.current.handle.scrollToLatest();
    });
    expect(terminal.scrollToBottomCount).toBe(1);
    expect(rig.result.current.scrolledUp).toBe(false);
  });
});

describe('12 cleanup (TC-UI-06)', () => {
  it('stops the socket, disposes the terminal and every listener and timer when the view goes away', async () => {
    const documentAdds = vi.spyOn(document, 'addEventListener');
    const documentRemoves = vi.spyOn(document, 'removeEventListener');
    const windowAdds = vi.spyOn(window, 'addEventListener');
    const windowRemoves = vi.spyOn(window, 'removeEventListener');
    const rig = await mountLive();
    const instance = rig.fake.engine.last();
    // the query client keeps a timer of its own: the view's timers are the difference
    const baseline = vi.getTimerCount();
    // a fit is pending and a redraw is half done when the view goes away
    rig.ro.trigger();
    act(() => {
      rig.result.current.handle.redraw();
    });
    expect(vi.getTimerCount()).toBe(baseline + 2);

    rig.unmount();

    expect(rig.socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(instance.disposed).toBe(true);
    expect(instance.terminal.listenerCount).toBe(0);
    expect(rig.ro.active()).toBe(0);
    expect(vi.getTimerCount()).toBe(baseline);
    const net = (adds: typeof documentAdds, removes: typeof documentRemoves, type: string): number =>
      adds.mock.calls.filter(([name]) => name === type).length -
      removes.mock.calls.filter(([name]) => name === type).length;
    expect(net(documentAdds, documentRemoves, 'visibilitychange')).toBe(0);
    expect(net(windowAdds, windowRemoves, 'focus')).toBe(0);
    expect(net(windowAdds, windowRemoves, 'blur')).toBe(0);
    // nothing of the dead view reaches the page any more
    await settle(60_000);
    expect(rig.onEnded).not.toHaveBeenCalled();
  });

  it('survives StrictMode with a real element: React attaches the host ref twice, one terminal and one socket stay', async () => {
    const fake = fakeSeams();
    stubResizeObserver();
    const latest: { current: ReturnType<typeof useTerminalConnection> | null } = { current: null };
    function Harness() {
      const connection = useTerminalConnection({
        name: NAME,
        gone: false,
        focusOnLive: true,
        onEnded: () => undefined,
      });
      latest.current = connection;
      return <div ref={connection.hostRef} data-testid="strict-host" />;
    }
    const rendered = renderWithProviders(<Harness />, {
      wrap: (children) => (
        <StrictMode>
          <TerminalSeamsContext value={fake.seams}>{children}</TerminalSeamsContext>
        </StrictMode>
      ),
    });
    giveHostSize(rendered.getByTestId('strict-host'), 900, 500);
    await settle();
    expect(fake.engine.instances).toHaveLength(1);
    expect(fake.sockets.instances).toHaveLength(1);
    expect(fake.engine.last().disposed).toBe(false);
    expect(fake.sockets.last().closed).toBe(false);
    act(() => {
      handshake(fake.sockets.last(), { cols: 120, rows: 30 });
    });
    expect(latest.current?.status).toEqual({ kind: 'live' });
    rendered.unmount();
    expect(fake.engine.last().disposed).toBe(true);
    expect(fake.sockets.last().closed).toBe(true);
  });

  it('rebuilds from nothing when the session name changes: the old terminal and socket go, the new ones start', async () => {
    const fake = fakeSeams();
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    giveHostSize(host, 900, 500);
    const rendered = renderHookWithProviders(
      (props: { name: string }) =>
        useTerminalConnection({ name: props.name, gone: false, focusOnLive: false, onEnded: () => undefined }),
      {
        initialProps: { name: 'fixture-term-1' },
        wrap: (children: ReactNode) => <TerminalSeamsContext value={fake.seams}>{children}</TerminalSeamsContext>,
      },
    );
    act(() => {
      rendered.result.current.hostRef(host);
    });
    await settle();
    act(() => {
      handshake(fake.sockets.last(), { cols: 120, rows: 30 });
    });
    expect(rendered.result.current.status).toEqual({ kind: 'live' });
    const first = fake.engine.last();
    const firstSocket = fake.sockets.last();

    rendered.rerender({ name: 'fixture-term-2' });
    expect(first.disposed).toBe(true);
    expect(firstSocket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(rendered.result.current.status).toEqual({ kind: 'loading-engine' });
    expect(rendered.result.current.size).toBeNull();
    await settle();
    expect(fake.engine.instances).toHaveLength(2);
    expect(fake.sockets.last().url).toContain('fixture-term-2');
    expect(rendered.result.current.status).toEqual({ kind: 'connecting' });
  });

  it('a view that goes away before the engine loaded builds nothing', async () => {
    const fake = fakeSeams();
    const release = fake.holdNextLoad();
    const rig = mount({ fake });
    rig.unmount();
    release();
    await settle();
    expect(fake.engine.instances).toHaveLength(0);
    expect(fake.sockets.instances).toHaveLength(0);
  });

  it('keeps one stable handle across renders', async () => {
    const rig = await mountLive();
    const { handle, hostRef } = rig.result.current;
    rig.rerender({ gone: false, focusOnLive: true });
    expect(rig.result.current.handle).toBe(handle);
    expect(rig.result.current.hostRef).toBe(hostRef);
  });
});
