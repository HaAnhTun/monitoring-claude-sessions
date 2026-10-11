// A scripted `EventSource` for the stream client tests (happy-dom has none, ADR 0032). The test drives it with `open()`,
// `emit()` and `fail()`; the client under test sees what a browser would deliver: nothing after `close()`, a plain `error`
// event for every failure. Not part of the app bundle; only tests import it.
import type { EventSourceLike } from '../stream/stream-client.ts';

export const FAKE_CONNECTING = 0;
export const FAKE_OPEN = 1;
export const FAKE_CLOSED = 2;

type Listener = (e: MessageEvent<string>) => void;

export class FakeEventSource implements EventSourceLike {
  readyState: number = FAKE_CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readonly url: string;
  /** How many times `close()` was called (a client must close a source exactly once). */
  closeCount = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = FAKE_CLOSED;
    this.closeCount += 1;
  }

  get closed(): boolean {
    return this.readyState === FAKE_CLOSED;
  }

  /** The browser opened the connection. */
  open(): void {
    if (this.closed) return;
    this.readyState = FAKE_OPEN;
    this.onopen?.(new Event('open'));
  }

  /**
   * Delivers one named event. An object is sent as its JSON text, a string as is (to script malformed frames). A closed
   * source delivers nothing, as a browser does, unless `force` is set (to prove the client ignores late events itself).
   */
  emit(type: string, data: unknown, options: { force?: boolean } = {}): void {
    if (this.closed && options.force !== true) return;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: text }));
  }

  /** The connection failed or dropped: the browser fires `error` and (without a client-owned reconnect) retries alone. */
  fail(options: { force?: boolean } = {}): void {
    if (this.closed && options.force !== true) return;
    this.onerror?.(new Event('error'));
  }

  /** The event names that have at least one listener. */
  get eventNames(): string[] {
    return [...this.listeners.keys()];
  }
}

export interface FakeEventSources {
  /** The `esFactory` to pass to the client. */
  factory: (url: string) => FakeEventSource;
  readonly instances: FakeEventSource[];
  /** The most recently created source; throws before the first one (a test bug, not a client state). */
  last(): FakeEventSource;
  urls(): string[];
}

export function createFakeEventSources(): FakeEventSources {
  const instances: FakeEventSource[] = [];
  return {
    factory(url) {
      const es = new FakeEventSource(url);
      instances.push(es);
      return es;
    },
    instances,
    last() {
      const es = instances.at(-1);
      if (es === undefined) throw new Error('no EventSource was created yet');
      return es;
    },
    urls() {
      return instances.map((es) => es.url);
    },
  };
}
