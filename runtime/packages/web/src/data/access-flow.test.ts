import { act, render } from '@testing-library/react';
import { createElement, StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accessCode, accessHash } from '../test/fixtures/terminal.ts';
import {
  createAccessFlow,
  readAccessCode,
  readAccessInput,
  redeemFragment,
  stripAccessFragment,
  type AccessFlowDeps,
  type AccessOutcome,
  type AccessPage,
} from './access-flow.ts';
import { ApiError } from './api-errors.ts';

const CODE = accessCode(1);
const OTHER_CODE = accessCode(2);

function httpError(status: number, code: ApiError['info']['code'], extra: Partial<ApiError['info']> = {}): ApiError {
  return new ApiError('diagnostic', {
    kind: 'http',
    status,
    code,
    endpoint: 'authExchange',
    requestId: 'r-0123456789ab',
    method: 'POST',
    ...extra,
  });
}

function networkError(): ApiError {
  return new ApiError('diagnostic', {
    kind: 'network',
    status: 0,
    code: null,
    endpoint: 'authExchange',
    requestId: null,
  });
}

interface Deferred {
  promise: Promise<undefined>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<undefined>((res) => {
    resolve = () => {
      res(undefined);
    };
  });
  return { promise, resolve };
}

/** What a storage holds, keys and values, as one text (a spread of `Storage` would lose its class). */
function storageText(storage: Storage): string {
  const parts: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) parts.push(key, storage.getItem(key) ?? '');
  }
  return parts.join('|');
}

function makeDeps(overrides: Partial<AccessFlowDeps> = {}) {
  const exchange = vi.fn<AccessFlowDeps['exchange']>(overrides.exchange ?? (() => Promise.resolve()));
  const readAuthenticated = vi.fn<AccessFlowDeps['readAuthenticated']>(
    overrides.readAuthenticated ?? (() => Promise.resolve(true)),
  );
  const onGranted = vi.fn<AccessFlowDeps['onGranted']>(overrides.onGranted);
  const deps: AccessFlowDeps = { exchange, readAuthenticated, onGranted };
  return { deps, exchange, readAuthenticated, onGranted };
}

/** A page whose location and history are plain objects, so a test sees exactly what the flow does to them. */
function fakePage(hash: string, state: unknown = { key: 'fixture-state' }) {
  const location = { hash, pathname: '/workspace', search: '?session=fixture-term-1' };
  const replaceState = vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => {
    const href = String(url);
    const hashIndex = href.indexOf('#');
    location.hash = hashIndex < 0 ? '' : href.slice(hashIndex);
  });
  const page: AccessPage = { location, history: { state, replaceState } };
  return { page, location, replaceState };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readAccessCode: the one reader of the login fragment (conflict X1: the key is `code`)', () => {
  it('reads the code of #code=<code>', () => {
    expect(readAccessCode(accessHash(CODE))).toBe(CODE);
    expect(readAccessCode(`#code=${'A'.repeat(32)}`)).toBe('A'.repeat(32));
    expect(readAccessCode(`#code=${'a-_9'.repeat(32)}`)).toBe('a-_9'.repeat(32));
  });

  it.each([
    ['', 'empty'],
    ['#', 'a bare hash'],
    [`#access=${CODE}`, 'the other key of the first design'],
    [`code=${CODE}`, 'no hash sign'],
    [`#code=${CODE}&x=1`, 'an extra key'],
    [`#x=1&code=${CODE}`, 'the key not first'],
    ['#code=', 'no code'],
    [`#code=${'a'.repeat(31)}`, 'one character short'],
    [`#code=${'a'.repeat(129)}`, 'one character long'],
    [`#code=${'a'.repeat(31)}!`, 'a character outside the alphabet'],
    [`#code=${CODE} `, 'trailing space'],
    ['#sid=abc', 'a legacy session bookmark'],
  ])('refuses %s (%s)', (hash) => {
    expect(readAccessCode(hash)).toBeNull();
  });
});

describe('readAccessInput: what the paste field accepts', () => {
  it('accepts the bare code, with the whitespace of a paste around it', () => {
    expect(readAccessInput(CODE)).toBe(CODE);
    expect(readAccessInput(`  ${CODE}\n`)).toBe(CODE);
  });

  it('accepts the whole printed link', () => {
    expect(readAccessInput(`http://127.0.0.1:18123/#code=${CODE}`)).toBe(CODE);
    expect(readAccessInput(`  http://127.0.0.1:18123/${accessHash(CODE)}  `)).toBe(CODE);
  });

  it.each([
    '',
    '   ',
    'not a code',
    'http://127.0.0.1:18123/',
    'http://127.0.0.1:18123/#code=short',
    `http://127.0.0.1:18123/#access=${CODE}`,
    `${CODE}${CODE}${CODE}${CODE}`,
    `${CODE} ${CODE}`,
    'http://[',
  ])('refuses %j without a request', (text) => {
    expect(readAccessInput(text)).toBeNull();
  });
});

describe('createAccessFlow: the outcomes (TC-UI-15)', () => {
  it('starts idle', () => {
    expect(createAccessFlow(makeDeps().deps).snapshot()).toEqual({ kind: 'idle' });
  });

  it('granted: exchange, then a fresh read of the session says authenticated; onGranted runs once', async () => {
    const { deps, exchange, readAuthenticated, onGranted } = makeDeps();
    const flow = createAccessFlow(deps);
    expect(await flow.submit(CODE)).toEqual({ kind: 'granted' });
    expect(flow.snapshot()).toEqual({ kind: 'granted' });
    expect(exchange).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(readAuthenticated).toHaveBeenCalledTimes(1);
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it('reads the session only after the exchange has answered', async () => {
    const gate = deferred();
    const { deps, readAuthenticated } = makeDeps({ exchange: () => gate.promise });
    const flow = createAccessFlow(deps);
    const pending = flow.submit(CODE);
    await Promise.resolve();
    expect(readAuthenticated).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(readAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('cookie-not-kept: the code was accepted but the next read is still not authenticated', async () => {
    const { deps, onGranted } = makeDeps({ readAuthenticated: () => Promise.resolve(false) });
    const flow = createAccessFlow(deps);
    expect(await flow.submit(CODE)).toEqual({ kind: 'cookie-not-kept' });
    expect(flow.snapshot()).toEqual({ kind: 'cookie-not-kept' });
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('invalid: access_code_invalid (a used, expired or wrong code)', async () => {
    const { deps, readAuthenticated, onGranted } = makeDeps({
      exchange: () => Promise.reject(httpError(401, 'access_code_invalid')),
    });
    const flow = createAccessFlow(deps);
    expect(await flow.submit(CODE)).toEqual({ kind: 'invalid' });
    expect(readAuthenticated).not.toHaveBeenCalled();
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('rate-limited: access_rate_limited with the Retry-After of the answer', async () => {
    const { deps } = makeDeps({
      exchange: () => Promise.reject(httpError(429, 'access_rate_limited', { retryAfterMs: 12_000 })),
    });
    expect(await createAccessFlow(deps).submit(CODE)).toEqual({ kind: 'rate-limited', retryAfterMs: 12_000 });
  });

  it('rate-limited without a Retry-After waits 30 s, the cap of the client', async () => {
    const { deps } = makeDeps({ exchange: () => Promise.reject(httpError(429, 'access_rate_limited')) });
    expect(await createAccessFlow(deps).submit(CODE)).toEqual({ kind: 'rate-limited', retryAfterMs: 30_000 });
  });

  it('failed: any other failure of the exchange keeps the error', async () => {
    const error = networkError();
    const { deps, onGranted } = makeDeps({ exchange: () => Promise.reject(error) });
    const outcome = await createAccessFlow(deps).submit(CODE);
    expect(outcome).toEqual({ kind: 'failed', error });
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('failed: a server error and a 403 are failures, not an invalid code', async () => {
    for (const error of [httpError(500, 'internal_error'), httpError(403, 'csrf_rejected')]) {
      const { deps } = makeDeps({ exchange: () => Promise.reject(error) });
      expect(await createAccessFlow(deps).submit(CODE)).toEqual({ kind: 'failed', error });
    }
  });

  it('failed: the read after the exchange can fail too', async () => {
    const error = networkError();
    const { deps, onGranted } = makeDeps({ readAuthenticated: () => Promise.reject(error) });
    expect(await createAccessFlow(deps).submit(CODE)).toEqual({ kind: 'failed', error });
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('failed: an error that is not an ApiError is wrapped, and its message (which could hold the code) is dropped', async () => {
    const { deps } = makeDeps({ exchange: () => Promise.reject(new Error(`boom ${CODE}`)) });
    const outcome = await createAccessFlow(deps).submit(CODE);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toBeInstanceOf(ApiError);
    expect(outcome.error.info.kind).toBe('network');
    expect(outcome.error.message).not.toContain(CODE);
  });

  it('never throws: a rejected exchange resolves to an outcome', async () => {
    const { deps } = makeDeps({ exchange: () => Promise.reject(httpError(500, 'internal_error')) });
    await expect(createAccessFlow(deps).submit(CODE)).resolves.toMatchObject({ kind: 'failed' });
  });
});

describe('createAccessFlow: the store', () => {
  it('shows exchanging while the request is in flight and tells the subscribers on every change', async () => {
    const gate = deferred();
    const { deps } = makeDeps({ exchange: () => gate.promise });
    const flow = createAccessFlow(deps);
    const seen: AccessOutcome['kind'][] = [];
    flow.subscribe(() => {
      seen.push(flow.snapshot().kind);
    });
    const pending = flow.submit(CODE);
    expect(flow.snapshot()).toEqual({ kind: 'exchanging' });
    gate.resolve();
    await pending;
    expect(seen).toEqual(['exchanging', 'granted']);
  });

  it('gives the same snapshot object until the outcome changes (the contract of useSyncExternalStore)', async () => {
    const flow = createAccessFlow(makeDeps().deps);
    const idle = flow.snapshot();
    expect(flow.snapshot()).toBe(idle);
    await flow.submit(CODE);
    const granted = flow.snapshot();
    expect(granted).not.toBe(idle);
    expect(flow.snapshot()).toBe(granted);
  });

  it('stops telling a subscriber that unsubscribed', async () => {
    const flow = createAccessFlow(makeDeps().deps);
    const listener = vi.fn();
    const unsubscribe = flow.subscribe(listener);
    unsubscribe();
    await flow.submit(CODE);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the code out of every snapshot, whatever the outcome', async () => {
    const results: Partial<AccessFlowDeps>[] = [
      {},
      { readAuthenticated: () => Promise.resolve(false) },
      { exchange: () => Promise.reject(httpError(401, 'access_code_invalid')) },
      { exchange: () => Promise.reject(httpError(429, 'access_rate_limited', { retryAfterMs: 1000 })) },
      { exchange: () => Promise.reject(networkError()) },
    ];
    for (const overrides of results) {
      const flow = createAccessFlow(makeDeps(overrides).deps);
      const states: string[] = [];
      flow.subscribe(() => {
        states.push(JSON.stringify(flow.snapshot()));
      });
      await flow.submit(CODE);
      expect(states.join('|') + JSON.stringify(flow.snapshot())).not.toContain(CODE);
    }
  });

  it('keeps the code out of web storage and the document', async () => {
    const flow = createAccessFlow(makeDeps().deps);
    await flow.submit(CODE);
    expect(storageText(window.localStorage)).not.toContain(CODE);
    expect(storageText(window.sessionStorage)).not.toContain(CODE);
    expect(document.documentElement.textContent).not.toContain(CODE);
    expect(window.location.href).not.toContain(CODE);
  });
});

describe('createAccessFlow: one request per code value', () => {
  it('two calls with the same code before the answer share one request and one outcome', async () => {
    const gate = deferred();
    const { deps, exchange, onGranted } = makeDeps({ exchange: () => gate.promise });
    const flow = createAccessFlow(deps);
    const first = flow.submit(CODE);
    const second = flow.submit(CODE);
    gate.resolve();
    expect(await first).toEqual({ kind: 'granted' });
    expect(await second).toEqual({ kind: 'granted' });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it('two different codes are two requests', async () => {
    const { deps, exchange } = makeDeps();
    const flow = createAccessFlow(deps);
    await Promise.all([flow.submit(CODE), flow.submit(OTHER_CODE)]);
    expect(exchange.mock.calls.map(([code]) => code).sort()).toEqual([CODE, OTHER_CODE].sort());
  });

  it('a code that was rate-limited can be sent again once the first request has settled', async () => {
    let calls = 0;
    const { deps, exchange } = makeDeps({
      exchange: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(httpError(429, 'access_rate_limited', { retryAfterMs: 1000 }))
          : Promise.resolve();
      },
    });
    const flow = createAccessFlow(deps);
    expect((await flow.submit(CODE)).kind).toBe('rate-limited');
    expect((await flow.submit(CODE)).kind).toBe('granted');
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('a failed request does not poison the next one with the same code', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      exchange: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(networkError()) : Promise.resolve();
      },
    });
    const flow = createAccessFlow(deps);
    expect((await flow.submit(CODE)).kind).toBe('failed');
    expect((await flow.submit(CODE)).kind).toBe('granted');
  });
});

describe('stripAccessFragment', () => {
  it('replaces the entry without the fragment and keeps the path, the query and the history state', () => {
    const { page, location, replaceState } = fakePage(accessHash(CODE));
    stripAccessFragment(page);
    expect(location.hash).toBe('');
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(
      { key: 'fixture-state' },
      '',
      '/workspace?session=fixture-term-1',
    );
  });

  it('leaves a page without the login fragment alone', () => {
    for (const hash of ['', '#sid=abc', '#section']) {
      const { page, replaceState } = fakePage(hash);
      stripAccessFragment(page);
      expect(replaceState, hash).not.toHaveBeenCalled();
    }
  });

  it('strips a malformed #code= too: a failed attempt must not linger in the address bar', () => {
    const { page, location } = fakePage('#code=short');
    stripAccessFragment(page);
    expect(location.hash).toBe('');
  });

  it('works on the real window', () => {
    window.history.replaceState(null, '', `/?session=fixture-term-1${accessHash(CODE)}`);
    expect(window.location.hash).toBe(accessHash(CODE));
    stripAccessFragment();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?session=fixture-term-1');
    window.history.replaceState(null, '', '/');
  });
});

describe('redeemFragment (TC-UI-15)', () => {
  it('does nothing without a login fragment: no request, no strip, null', async () => {
    const { deps, exchange } = makeDeps();
    const flow = createAccessFlow(deps);
    for (const hash of ['', '#sid=abc', `#access=${CODE}`]) {
      const { page, replaceState } = fakePage(hash);
      expect(await redeemFragment(flow, page), hash).toBeNull();
      expect(replaceState, hash).not.toHaveBeenCalled();
    }
    expect(exchange).not.toHaveBeenCalled();
  });

  it('sends the code of the fragment and strips the fragment only after the request has settled', async () => {
    const gate = deferred();
    const { deps, exchange } = makeDeps({ exchange: () => gate.promise });
    const flow = createAccessFlow(deps);
    const { page, location, replaceState } = fakePage(accessHash(CODE));
    const pending = redeemFragment(flow, page);
    await Promise.resolve();
    expect(exchange).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.hash).toBe(accessHash(CODE));
    gate.resolve();
    expect(await pending).toEqual({ kind: 'granted' });
    expect(location.hash).toBe('');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<AccessFlowDeps>, AccessOutcome['kind']]>([
    ['granted', {}, 'granted'],
    ['cookie-not-kept', { readAuthenticated: () => Promise.resolve(false) }, 'cookie-not-kept'],
    ['invalid', { exchange: () => Promise.reject(httpError(401, 'access_code_invalid')) }, 'invalid'],
    [
      'rate-limited',
      { exchange: () => Promise.reject(httpError(429, 'access_rate_limited', { retryAfterMs: 5000 })) },
      'rate-limited',
    ],
    ['failed', { exchange: () => Promise.reject(networkError()) }, 'failed'],
  ])('strips the fragment when the outcome is %s', async (_name, overrides, kind) => {
    const flow = createAccessFlow(makeDeps(overrides).deps);
    const { page, location } = fakePage(accessHash(CODE));
    const outcome = await redeemFragment(flow, page);
    expect(outcome?.kind).toBe(kind);
    expect(location.hash).toBe('');
  });

  it('a malformed code is stripped without a request', async () => {
    const { deps, exchange } = makeDeps();
    const { page, location } = fakePage('#code=short');
    expect(await redeemFragment(createAccessFlow(deps), page)).toBeNull();
    expect(exchange).not.toHaveBeenCalled();
    expect(location.hash).toBe('');
  });

  it('TC-UI-15: one request per code even when StrictMode runs the effect twice', async () => {
    const gate = deferred();
    const { deps, exchange } = makeDeps({ exchange: () => gate.promise });
    const flow = createAccessFlow(deps);
    const { page, location } = fakePage(accessHash(CODE));
    const runs: Promise<AccessOutcome | null>[] = [];
    function Gate() {
      useEffect(() => {
        runs.push(redeemFragment(flow, page));
      }, []);
      return null;
    }
    render(createElement(StrictMode, null, createElement(Gate)));
    expect(runs).toHaveLength(2);
    await act(async () => {
      gate.resolve();
      await Promise.all(runs);
    });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(await runs[0]).toEqual({ kind: 'granted' });
    expect(await runs[1]).toEqual({ kind: 'granted' });
    expect(location.hash).toBe('');
  });
});

describe('the page really is left without the code', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/${accessHash(CODE)}`);
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('redeems the fragment of the real window and leaves an address bar without the code', async () => {
    const { deps, exchange } = makeDeps();
    const outcome = await redeemFragment(createAccessFlow(deps));
    expect(outcome).toEqual({ kind: 'granted' });
    expect(exchange).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(window.location.href).not.toContain(CODE);
    expect(window.location.hash).toBe('');
  });
});
