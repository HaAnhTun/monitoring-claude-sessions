import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostPlatform } from './host.ts';
import {
  createWatchHint,
  createWatchHintWith,
  isNetworkRoot,
  type WatchHintDeps,
  type WatcherLike,
} from './watch-hint.ts';

const makeTemp = useTempDirs();

type Listener = (eventType: string, filename: string | null) => void;

class FakeWatcher implements WatcherLike {
  closed = false;
  readonly root: string;
  readonly options: { recursive: boolean; persistent: boolean };
  private readonly listener: Listener;
  private errorListeners: ((error: Error) => void)[] = [];

  constructor(root: string, options: { recursive: boolean; persistent: boolean }, listener: Listener) {
    this.root = root;
    this.options = options;
    this.listener = listener;
  }

  on(_event: 'error', listener: (error: Error) => void): this {
    this.errorListeners.push(listener);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  emit(filename: string | null, eventType = 'change'): void {
    this.listener(eventType, filename);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

interface HarnessState {
  watchers: FakeWatcher[];
  throwOnWatch: Error[];
  env: Record<string, string | undefined>;
}

/** The state plus the dependencies that read and write it. */
type Harness = HarnessState & { readonly deps: WatchHintDeps };

function harness(platform: HostPlatform = 'win32'): Harness {
  const h: HarnessState = { watchers: [], throwOnWatch: [], env: {} };
  const deps: WatchHintDeps = {
    watch: (root, options, listener) => {
      const failure = h.throwOnWatch.shift();
      if (failure !== undefined) throw failure;
      const watcher = new FakeWatcher(root, options, listener);
      h.watchers.push(watcher);
      return watcher;
    },
    env: (name) => h.env[name],
    platform,
  };
  return Object.assign(h, { deps });
}

describe('createWatchHintWith', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens one recursive, non-persistent watcher on the root', () => {
    const h = harness();
    const hint = createWatchHintWith(h.deps, 'C:\\roots\\a', () => undefined);
    expect(h.watchers).toHaveLength(1);
    expect(h.watchers[0]?.root).toBe('C:\\roots\\a');
    expect(h.watchers[0]?.options).toEqual({ recursive: true, persistent: false });
    expect(hint.active).toBe(true);
    expect(hint.failures).toBe(0);
    hint.close();
  });

  it('reports a path after the 100 ms debounce, as root joined with the file name', () => {
    const h = harness();
    const hints: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => hints.push(file));
    h.watchers[0]?.emit('sub/t.jsonl');
    vi.advanceTimersByTime(99);
    expect(hints).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(hints).toEqual([path.join('/roots/a', 'sub/t.jsonl')]);
    hint.close();
  });

  it('collapses a burst for one path into one hint and restarts the window on every event', () => {
    const h = harness();
    const hints: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => hints.push(file));
    const watcher = h.watchers[0];
    watcher?.emit('t.jsonl');
    vi.advanceTimersByTime(60);
    watcher?.emit('t.jsonl');
    vi.advanceTimersByTime(60);
    expect(hints).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(hints).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(hints).toHaveLength(1);
    hint.close();
  });

  it('debounces every path on its own', () => {
    const h = harness();
    const hints: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => hints.push(path.basename(file)));
    h.watchers[0]?.emit('one.jsonl');
    vi.advanceTimersByTime(50);
    h.watchers[0]?.emit('two.jsonl');
    vi.advanceTimersByTime(50);
    expect(hints).toEqual(['one.jsonl']);
    vi.advanceTimersByTime(50);
    expect(hints).toEqual(['one.jsonl', 'two.jsonl']);
    hint.close();
  });

  it('honours debounceMs and ignores events without a file name', () => {
    const h = harness();
    const hints: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => hints.push(file), { debounceMs: 20 });
    h.watchers[0]?.emit(null);
    h.watchers[0]?.emit('x.jsonl');
    vi.advanceTimersByTime(20);
    expect(hints).toHaveLength(1);
    hint.close();
  });

  it('survives an onHint that throws', () => {
    const h = harness();
    const seen: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => {
      seen.push(file);
      throw new Error('consumer bug');
    });
    h.watchers[0]?.emit('a');
    h.watchers[0]?.emit('b');
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(seen).toHaveLength(2);
    hint.close();
  });

  it('closes the watcher on an error, counts it, and reopens after 60 s', () => {
    const h = harness();
    const hint = createWatchHintWith(h.deps, '/roots/a', () => undefined);
    h.watchers[0]?.fail(errno('EPERM'));
    expect(h.watchers[0]?.closed).toBe(true);
    expect(hint.active).toBe(false);
    expect(hint.failures).toBe(1);
    vi.advanceTimersByTime(59_999);
    expect(h.watchers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.watchers).toHaveLength(2);
    expect(hint.active).toBe(true);
    expect(hint.failures).toBe(1);
    hint.close();
  });

  it('keeps counting and retrying on repeated errors', () => {
    const h = harness();
    const hint = createWatchHintWith(h.deps, '/roots/a', () => undefined);
    h.watchers[0]?.fail(errno('EPERM'));
    vi.advanceTimersByTime(60_000);
    h.watchers[1]?.fail(errno('EPERM'));
    expect(hint.failures).toBe(2);
    expect(hint.active).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(h.watchers).toHaveLength(3);
    expect(hint.active).toBe(true);
    hint.close();
  });

  it('treats a watch() that throws like an error: inactive, counted, retried after 60 s', () => {
    const h = harness();
    h.throwOnWatch.push(errno('ENOENT'));
    const hint = createWatchHintWith(h.deps, '/roots/missing', () => undefined);
    expect(hint.active).toBe(false);
    expect(hint.failures).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(hint.active).toBe(true);
    hint.close();
  });

  it('disables itself for good on ENOSPC (Linux inotify limit), thrown or emitted', () => {
    const thrown = harness('linux');
    thrown.throwOnWatch.push(errno('ENOSPC'));
    const a = createWatchHintWith(thrown.deps, '/roots/a', () => undefined);
    expect(a.active).toBe(false);
    expect(a.failures).toBe(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(thrown.watchers).toHaveLength(0);

    const emitted = harness('linux');
    const b = createWatchHintWith(emitted.deps, '/roots/a', () => undefined);
    emitted.watchers[0]?.fail(errno('ENOSPC'));
    expect(b.active).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(emitted.watchers).toHaveLength(1);
    a.close();
    b.close();
  });

  it('does nothing when MCS_FS_WATCH is 0, and watches for any other value or none', () => {
    const off = harness();
    off.env['MCS_FS_WATCH'] = '0';
    const disabled = createWatchHintWith(off.deps, '/roots/a', () => undefined);
    expect(off.watchers).toHaveLength(0);
    expect(disabled.active).toBe(false);
    expect(disabled.failures).toBe(0);
    disabled.close();

    for (const value of ['1', '', 'false', 'yes', undefined]) {
      const on = harness();
      on.env['MCS_FS_WATCH'] = value;
      const hint = createWatchHintWith(on.deps, '/roots/a', () => undefined);
      expect(on.watchers).toHaveLength(1);
      expect(hint.active).toBe(true);
      hint.close();
    }
  });

  it('does not watch UNC roots on Windows (polling only)', () => {
    for (const root of ['\\\\server\\share\\dir', '//server/share/dir', '\\\\?\\UNC\\server\\share\\dir']) {
      const h = harness('win32');
      const hint = createWatchHintWith(h.deps, root, () => undefined);
      expect(h.watchers).toHaveLength(0);
      expect(hint.active).toBe(false);
      expect(hint.failures).toBe(0);
    }
    for (const root of ['C:\\Users\\x', '\\\\?\\C:\\Users\\x', 'D:/work']) {
      const h = harness('win32');
      const hint = createWatchHintWith(h.deps, root, () => undefined);
      expect(h.watchers).toHaveLength(1);
      hint.close();
    }
  });

  it('close() stops the watcher, drops pending hints, and prevents any retry', () => {
    const h = harness();
    const hints: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => hints.push(file));
    h.watchers[0]?.emit('late.jsonl');
    hint.close();
    expect(h.watchers[0]?.closed).toBe(true);
    expect(hint.active).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(hints).toEqual([]);
    hint.close();

    const failing = harness();
    const second = createWatchHintWith(failing.deps, '/roots/a', () => undefined);
    failing.watchers[0]?.fail(errno('EPERM'));
    second.close();
    vi.advanceTimersByTime(120_000);
    expect(failing.watchers).toHaveLength(1);
  });

  it('ignores events and errors that arrive after close()', () => {
    const h = harness();
    const hints: string[] = [];
    const hint = createWatchHintWith(h.deps, '/roots/a', (file) => hints.push(file));
    const watcher = h.watchers[0];
    hint.close();
    watcher?.emit('x');
    watcher?.fail(errno('EPERM'));
    vi.advanceTimersByTime(200_000);
    expect(hints).toEqual([]);
    expect(hint.failures).toBe(0);
    expect(h.watchers).toHaveLength(1);
  });
});

describe('isNetworkRoot', () => {
  it('flags UNC paths on win32 only', () => {
    expect(isNetworkRoot('\\\\server\\share', 'win32')).toBe(true);
    expect(isNetworkRoot('//server/share', 'win32')).toBe(true);
    expect(isNetworkRoot('\\\\?\\UNC\\server\\share', 'win32')).toBe(true);
    expect(isNetworkRoot('\\\\?\\C:\\x', 'win32')).toBe(false);
    expect(isNetworkRoot('C:\\x', 'win32')).toBe(false);
    expect(isNetworkRoot('/usr/lib', 'win32')).toBe(false);
    expect(isNetworkRoot('//server/share', 'linux')).toBe(false);
    expect(isNetworkRoot('//server/share', 'darwin')).toBe(false);
  });
});

describe('createWatchHint (real fs.watch)', () => {
  it('reports a file written under the watched folder', async () => {
    const root = makeTemp('watch').path;
    mkdirSync(path.join(root, 'sub'));
    const hints: string[] = [];
    const hint = createWatchHint(root, (file) => hints.push(file), { debounceMs: 20 });
    try {
      expect(hint.active).toBe(true);
      const target = path.join(root, 'sub', 'a.jsonl');
      writeFileSync(target, 'one\n');
      const seen = await waitFor(
        () => {
          appendFileSync(target, 'more\n');
          return hints.find((file) => file.endsWith('a.jsonl'));
        },
        { timeoutMs: 5000, intervalMs: 100, what: 'a watch hint for the written file' },
      );
      expect(path.basename(seen)).toBe('a.jsonl');
    } finally {
      hint.close();
    }
    expect(hint.active).toBe(false);
  });
});
