// `SourceCache` (06 3.5, ADR 0059): one cache per panel source with single flight, stale-while-revalidate, the last good
// value and a backoff after failures. Nothing runs without a request: no timer is armed while no `read()` is waiting, and a
// source is loaded only by a read that finds its value stale. The timers that exist (the wait for a first value, the hard
// deadline of a running load) belong to a request in flight, are unref'd and are cleared when it settles.
//
// Also here: the helpers that turn cache reads into the `PanelResponse` pieces (`sourceState`, `panelStatus`, `PanelSample`).
import {
  isoMsZ,
  type Clock,
  type PanelSource,
  type PanelSourceState,
  type PanelSourceStats,
  type PanelStatus,
  type SourceStatus,
} from '@mcs/shared';

import { firstLine } from '../platform/exec.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import {
  ERROR_BACKOFF_CAP_MS,
  ERROR_RING_WINDOW_MS,
  HARD_DEADLINE_GRACE_MS,
  SOURCE_MESSAGE_MAX_CHARS,
} from './constants.ts';

export interface SourceSpec<T> {
  source: PanelSource;
  /** A value younger than this is served without a refresh. */
  ttlMs: number;
  /** With no value yet, a read waits this long for the first load before it answers `pending`; `0` waits for the load itself. */
  firstWaitMs: number;
  /** The budget of one load (child timeout or file system budget); the loader enforces it, the cache only backs it up. */
  timeoutMs: number;
  /** After an `unavailable` or `unsupported` result, the source is not tried again before this. */
  retryAfterUnavailableMs: number;
  /** Never needs to reject: a rejection or a synchronous throw becomes an `error` result. The signal aborts on `abort()` and at the hard deadline. */
  load(signal: AbortSignal): Promise<SourceResult<T>>;
}

export type SourceResult<T> =
  { status: 'ok'; value: T } | { status: 'unavailable' | 'unsupported' | 'error'; message: string };

export interface CacheRead<T> {
  value: T | null;
  /** Epoch ms of the value being served, `null` without a value. */
  sampledAt: number | null;
  status: SourceStatus;
  message: string | null;
}

/** What a sampler hands to the panel service: the data (null when nothing is known yet) and the state of every source. */
export interface PanelSample<D> {
  data: D | null;
  sources: PanelSourceState[];
}

type Settled<T> = SourceResult<T>;

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const line = firstLine(text, SOURCE_MESSAGE_MAX_CHARS);
  return line === '' ? 'the source failed' : line;
}

/** Waits for `settled` or `ms`, whichever comes first, and leaves no timer behind. `ms <= 0` waits for `settled` alone. */
function waitUpTo(settled: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return settled.then(() => undefined);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class SourceCache<T> {
  readonly #spec: SourceSpec<T>;
  readonly #clock: Clock;
  readonly #errors: ErrorRing;

  #hasValue = false;
  #value: T | null = null;
  #sampledAt: number | null = null;
  #lastStatus: SourceStatus = 'pending';
  #lastMessage: string | null = null;
  #inflight: Promise<void> | null = null;
  #controller: AbortController | null = null;
  /** Ends the wait of the running load (used by `abort()` so that no waiter is left hanging). */
  #cancel: (() => void) | null = null;
  #nextTryAt = Number.NEGATIVE_INFINITY;
  #failures = 0;
  #reportedAt = new Map<string, number>();
  #stats: PanelSourceStats = { refreshes: 0, failures: 0, lastDurationMs: null, lastStatus: null };

  constructor(spec: SourceSpec<T>, clock: Clock, errors: ErrorRing) {
    this.#spec = spec;
    this.#clock = clock;
    this.#errors = errors;
  }

  get source(): PanelSource {
    return this.#spec.source;
  }

  /** Refreshes, failures and the last duration and status (`PanelService.stats()`). */
  stats(): PanelSourceStats {
    return { ...this.#stats };
  }

  async read(): Promise<CacheRead<T>> {
    const now = this.#clock.now();
    if (this.#hasValue && this.#sampledAt !== null && now - this.#sampledAt < this.#spec.ttlMs) return this.#snapshot();
    if (this.#inflight === null && now >= this.#nextTryAt) this.#start();
    if (this.#hasValue) return this.#snapshot();
    const inflight = this.#inflight;
    if (inflight !== null) {
      await waitUpTo(inflight, this.#spec.firstWaitMs);
      if (this.#known()) return this.#snapshot();
      return {
        value: null,
        sampledAt: null,
        status: this.#loading() ? 'pending' : this.#lastStatus,
        message: this.#loading() ? null : this.#lastMessage,
      };
    }
    return { value: null, sampledAt: null, status: this.#lastStatus, message: this.#lastMessage };
  }

  /** Aborts the running load and drops its result. A later `read()` starts a new load. */
  abort(): void {
    const controller = this.#controller;
    const cancel = this.#cancel;
    this.#controller = null;
    this.#inflight = null;
    this.#cancel = null;
    controller?.abort();
    cancel?.();
  }

  /** True once a load succeeded (a method, like `#loading`, because `read()` awaits between the checks). */
  #known(): boolean {
    return this.#hasValue;
  }

  /** True while a load runs (a method, so that the narrowing of the field in `read()` does not apply after an await). */
  #loading(): boolean {
    return this.#inflight !== null;
  }

  #snapshot(): CacheRead<T> {
    return { value: this.#value, sampledAt: this.#sampledAt, status: this.#lastStatus, message: this.#lastMessage };
  }

  #start(): void {
    const controller = new AbortController();
    this.#controller = controller;
    const startedAt = this.#clock.now();
    const load = (async (): Promise<Settled<T>> => {
      try {
        return await this.#spec.load(controller.signal);
      } catch (error) {
        return { status: 'error', message: messageOf(error) };
      }
    })();
    let deadline: NodeJS.Timeout | undefined;
    const hardStop = new Promise<Settled<T>>((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve({ status: 'error', message: 'the source did not answer in time' });
      }, this.#spec.timeoutMs + HARD_DEADLINE_GRACE_MS);
      deadline.unref();
      this.#cancel = () => {
        resolve({ status: 'error', message: 'the source was aborted' });
      };
    });
    this.#inflight = Promise.race([load, hardStop]).then((result) => {
      clearTimeout(deadline);
      // abort() (or a newer load) took this one over: its result is dropped
      if (this.#controller !== controller) return;
      this.#controller = null;
      this.#inflight = null;
      this.#cancel = null;
      this.#settle(result, startedAt);
    });
  }

  #settle(result: Settled<T>, startedAt: number): void {
    const finishedAt = this.#clock.now();
    this.#stats.refreshes += 1;
    this.#stats.lastDurationMs = Math.max(0, finishedAt - startedAt);
    this.#stats.lastStatus = result.status;
    if (result.status === 'ok') {
      this.#hasValue = true;
      this.#value = result.value;
      this.#sampledAt = finishedAt;
      this.#lastStatus = 'ok';
      this.#lastMessage = null;
      this.#failures = 0;
      return;
    }
    this.#stats.failures += 1;
    this.#lastStatus = result.status;
    this.#lastMessage = firstLine(result.message, SOURCE_MESSAGE_MAX_CHARS) || null;
    if (result.status === 'error') {
      this.#nextTryAt =
        finishedAt + Math.min(this.#spec.ttlMs * 2 ** Math.min(this.#failures, 30), ERROR_BACKOFF_CAP_MS);
      this.#failures += 1;
      this.#report(this.#lastMessage ?? 'the source failed', finishedAt);
    } else {
      this.#nextTryAt = finishedAt + this.#spec.retryAfterUnavailableMs;
    }
  }

  /** The error ring gets one entry per distinct message per window, whatever the retry rate. */
  #report(message: string, now: number): void {
    for (const [known, at] of this.#reportedAt) {
      if (now - at >= ERROR_RING_WINDOW_MS) this.#reportedAt.delete(known);
    }
    if (this.#reportedAt.has(message)) return;
    this.#reportedAt.set(message, now);
    this.#errors.push({
      source: 'panel',
      code: 'PANEL_SOURCE_FAILED',
      where: `panel.${this.#spec.source}`,
      message,
    });
  }
}

/** The `PanelSourceState` of one cache read (sampled time as ISO, message clipped to 200 code points). */
export function sourceState(source: PanelSource, read: CacheRead<unknown>): PanelSourceState {
  return {
    source,
    status: read.status,
    sampledAt: read.sampledAt === null ? null : isoMsZ(read.sampledAt),
    message: read.message === null ? null : firstLine(read.message, SOURCE_MESSAGE_MAX_CHARS) || null,
  };
}

/**
 * `ok`: data and every source ok or disabled; `partial`: data, but a source is pending, unavailable, unsupported or in error;
 * `error`: no data (06 3.3).
 */
export function panelStatus(sources: readonly PanelSourceState[], hasData: boolean): PanelStatus {
  if (!hasData) return 'error';
  return sources.every((s) => s.status === 'ok' || s.status === 'disabled') ? 'ok' : 'partial';
}
