// Change detection: stat polling is the truth, `fs.watch` is only a hint (06 4.4, ADR 0052, E7, E8).
// Design 02's scheduler polls every file and runs discovery on its own timers; that alone keeps the data correct. This
// module supplies a low-latency hint (one recursive, non-persistent watcher per root, debounced per path) that is never
// required for correctness: when the watcher fails it is closed, counted and retried after 60 s.
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';

import { hostPlatform, type HostPlatform } from './host.ts';

export interface WatchHint {
  /** Stops the watcher and drops every pending hint. Safe to call twice. */
  close(): void;
  /** True while a watcher is attached. */
  readonly active: boolean;
  /** How many times the watcher failed (health: `ingest.watchHint = 'off'` while it is not active). */
  readonly failures: number;
}

export interface WatchHintOptions {
  /** Per-path debounce (default 100 ms). */
  debounceMs?: number;
  /** Delay before a failed watcher is reopened (default 60 000 ms). */
  retryMs?: number;
}

/** The part of `fs.FSWatcher` this module uses. */
export interface WatcherLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): void;
}

export interface WatchHintDeps {
  watch(
    root: string,
    options: { recursive: true; persistent: false },
    listener: (eventType: string, filename: string | null) => void,
  ): WatcherLike;
  env(name: string): string | undefined;
  platform: HostPlatform;
}

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_RETRY_MS = 60_000;

/** SMB change notifications are unreliable (UNVERIFIED), so UNC roots are polled only. Local extended paths are fine. */
export function isNetworkRoot(root: string, platform: HostPlatform): boolean {
  if (platform !== 'win32') return false;
  if (/^\\\\\?\\UNC\\/i.test(root)) return true;
  if (/^\\\\[?.]\\/.test(root)) return false;
  return /^(\\\\|\/\/)[^\\/]/.test(root);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

/** Builds a hint over `deps`; `createWatchHint` is this over the real `fs.watch`. */
export function createWatchHintWith(
  deps: WatchHintDeps,
  root: string,
  onHint: (absPath: string) => void,
  o: WatchHintOptions = {},
): WatchHint {
  const debounceMs = o.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const retryMs = o.retryMs ?? DEFAULT_RETRY_MS;
  const pending = new Map<string, NodeJS.Timeout>();
  let watcher: WatcherLike | null = null;
  let retryTimer: NodeJS.Timeout | undefined;
  let failures = 0;
  let closed = false;
  // `MCS_FS_WATCH=0` and network roots turn the hint off for good; so does the Linux inotify limit (ENOSPC).
  let disabled = deps.env('MCS_FS_WATCH') === '0' || isNetworkRoot(root, deps.platform);

  const onEvent = (_eventType: string, filename: string | null): void => {
    if (closed || filename === null) return;
    const file = path.join(root, filename);
    const previous = pending.get(file);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      pending.delete(file);
      try {
        onHint(file);
      } catch {
        // A consumer bug must not stop the hints.
      }
    }, debounceMs);
    timer.unref();
    pending.set(file, timer);
  };

  const fail = (error: unknown): void => {
    failures += 1;
    try {
      watcher?.close();
    } catch {
      // Already closed by the failure itself.
    }
    watcher = null;
    if (errorCode(error) === 'ENOSPC') {
      disabled = true;
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      open();
    }, retryMs);
    retryTimer.unref();
  };

  function open(): void {
    if (closed || disabled) return;
    let created: WatcherLike;
    try {
      created = deps.watch(root, { recursive: true, persistent: false }, onEvent);
    } catch (error) {
      fail(error);
      return;
    }
    watcher = created;
    created.on('error', (error) => {
      if (closed || watcher !== created) return;
      fail(error);
    });
  }

  open();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      try {
        watcher?.close();
      } catch {
        // Nothing left to release.
      }
      watcher = null;
    },
    get active() {
      return watcher !== null;
    },
    get failures() {
      return failures;
    },
  };
}

/**
 * One recursive, non-persistent `fs.watch` on `root`; `onHint(absPath)` runs 100 ms after the last event of a path. Never
 * needed for correctness (E7: a writer that keeps its handle open produces no events).
 */
export function createWatchHint(root: string, onHint: (absPath: string) => void, o?: WatchHintOptions): WatchHint {
  return createWatchHintWith(
    {
      watch: (watchRoot, options, listener) => fsWatch(watchRoot, options, listener),
      env: (name) => process.env[name],
      platform: hostPlatform,
    },
    root,
    onHint,
    o,
  );
}
