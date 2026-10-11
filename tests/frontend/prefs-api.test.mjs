import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs, sanitize, parseHash, buildHash } from '../../src/frontend/modules/prefs.js';
import { createApi, describeFailure, ApiError } from '../../src/frontend/modules/api.js';
import { nextDelay, createPoller } from '../../src/frontend/modules/poller.js';

class MemStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };

test('prefs persist known keys and reject bad values', () => {
  const st = new MemStorage();
  const p = createPrefs(st);
  assert.equal(p.get('theme', 'auto'), 'auto');
  assert.equal(p.set('theme', 'dark'), true);
  assert.equal(p.set('theme', 'neon'), false);
  assert.equal(p.set('apiKey', 'x'), false);
  assert.equal(p.set('sel', { sid: 'abc', agent: '' }), true);
  const q = createPrefs(st);
  assert.equal(q.get('theme'), 'dark');
  assert.deepEqual(q.get('sel'), { sid: 'abc', agent: '' });
});

test('prefs survive storage that throws on read and write', () => {
  const p = createPrefs(throwing);
  assert.equal(p.get('density', 'comfortable'), 'comfortable');
  assert.equal(p.set('density', 'compact'), false); // not persisted ...
  assert.equal(p.get('density'), 'compact');         // ... but kept in memory
  assert.equal(p.persistent, false);
});

test('prefs survive missing storage and corrupt JSON', () => {
  assert.equal(createPrefs(null).get('theme', 'auto'), 'auto');
  const bad = new MemStorage({ 'ccm.prefs.v1': '{not json' });
  assert.equal(createPrefs(bad).get('theme', 'auto'), 'auto');
  assert.deepEqual(sanitize({ theme: 5, density: 'compact', evil: 1, sel: { sid: 3 } }), { density: 'compact' });
  assert.deepEqual(sanitize([1, 2]), {});
});

test('hash round trip', () => {
  assert.deepEqual(parseHash('#sid=abc-123&agent=a%2Fb'), { sid: 'abc-123', agent: 'a/b' });
  assert.deepEqual(parseHash(''), { sid: '', agent: '' });
  assert.equal(buildHash({ sid: 'x y', agent: '' }), '#sid=x+y');
  assert.equal(buildHash({ sid: '', agent: 'a' }), '');
  const h = buildHash({ sid: 's1', agent: 'ag 2' });
  assert.deepEqual(parseHash(h), { sid: 's1', agent: 'ag 2' });
});

test('backoff: doubles, capped at 30 s, normal interval when healthy', () => {
  assert.equal(nextDelay(1500, 0), 1500);
  assert.equal(nextDelay(1500, 1), 3000);
  assert.equal(nextDelay(1500, 2), 6000);
  assert.equal(nextDelay(1500, 4), 24000);
  assert.equal(nextDelay(1500, 5), 30000);
  assert.equal(nextDelay(1500, 50), 30000);
  assert.equal(nextDelay(6000, 1), 12000);
  assert.equal(nextDelay(200, 1), 2000); // never faster than 1 s base when failing
  assert.equal(nextDelay(60000, 1, 30000), 30000);
});

test('poller: failure schedules backoff and success resumes the normal interval', async () => {
  const delays = [];
  let n = 0;
  const errors = [];
  const p = createPoller({
    name: 't',
    getInterval: () => 10,
    run: async () => { n += 1; if (n <= 2) throw new Error('boom'); },
    onError: (e, f) => errors.push([e.message, f]),
    delayFn: (iv, f) => { delays.push([iv, f]); return 1; },
  });
  p.start();
  await new Promise((r) => setTimeout(r, 80));
  p.stop();
  assert.deepEqual(errors.slice(0, 2), [['boom', 1], ['boom', 2]]);
  assert.deepEqual(delays.slice(0, 3), [[10, 1], [10, 2], [10, 0]]);
  assert.equal(p.state.failures, 0);
});

function fakeResp(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

test('api tracks last success / last error per endpoint and keeps the error', async () => {
  let t = 1000;
  let mode = 'ok';
  const fetchImpl = async () => {
    if (mode === 'ok') return fakeResp(200, { a: 1 });
    if (mode === 'net') throw new TypeError('fetch failed');
    if (mode === '404') return fakeResp(404, { error: 'not found' });
    if (mode === 'junk') return fakeResp(200, '<html>');
    return fakeResp(500, { error: 'kaput' });
  };
  const api = createApi({ fetchImpl, now: () => t });
  assert.deepEqual(await api.get('x', '/api/x'), { a: 1 });
  assert.equal(api.status('x').lastSuccess, 1000);
  t = 2000; mode = 'net';
  await assert.rejects(api.get('x', '/api/x'), (e) => e instanceof ApiError && e.kind === 'network');
  let s = api.status('x');
  assert.equal(s.failures, 1);
  assert.equal(s.lastSuccess, 1000);
  assert.match(s.lastError.message, /Cannot reach the monitor/);
  mode = '404';
  await assert.rejects(api.get('x', '/api/x'), (e) => e.status === 404);
  mode = 'junk';
  await assert.rejects(api.get('x', '/api/x'), (e) => e.kind === 'parse');
  mode = '500';
  await assert.rejects(api.get('x', '/api/x'), (e) => /Monitor error \(500\): kaput/.test(e.message));
  assert.equal(api.status('x').failures, 4);
  mode = 'ok'; t = 3000;
  await api.get('x', '/api/x');
  s = api.status('x');
  assert.equal(s.failures, 0);
  assert.equal(s.lastSuccess, 3000);
});

test('api times out hanging requests', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  const api = createApi({ fetchImpl, timeoutMs: 20 });
  await assert.rejects(api.get('slow', '/api/slow', { timeout: 20 }), (e) => e.kind === 'timeout' && /No answer/.test(e.message));
  assert.equal(api.status('slow').failures, 1);
});

test('describeFailure for 403 mentions the host', () => {
  assert.match(describeFailure('http', 403, '', 1000), /127\.0\.0\.1/);
});
