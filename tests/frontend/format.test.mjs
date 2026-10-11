import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtAge, fmtBytes, fmtTok, fmtDuration, fmtClock, fmtRelative, timeTitle, tokenLine, tokenParts, usageBadge, plural } from '../../src/frontend/modules/format.js';

test('fmtAge', () => {
  assert.equal(fmtAge(0), '0s');
  assert.equal(fmtAge(45), '45s');
  assert.equal(fmtAge(120), '2m');
  assert.equal(fmtAge(7200), '2h');
  assert.equal(fmtAge(200000), '2d');
  assert.equal(fmtAge(-5), '0s');
  assert.equal(fmtAge(null), '');
});

test('fmtBytes / fmtTok / fmtDuration', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(5 * 1048576), '5.0 MB');
  assert.equal(fmtBytes(300 * 1048576), '300 MB');
  assert.equal(fmtBytes(-1), '');
  assert.equal(fmtTok(999), '999');
  assert.equal(fmtTok(12345), '12k');
  assert.equal(fmtTok(2500000), '2.5M');
  assert.equal(fmtTok(undefined), '0');
  assert.equal(fmtDuration(8), '8s');
  assert.equal(fmtDuration(125), '2m 05s');
  assert.equal(fmtDuration(3900), '1h 05m');
});

test('fmtClock is local HH:MM:SS and tolerates garbage', () => {
  const iso = '2026-10-11T12:34:56Z';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  assert.equal(fmtClock(iso), `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
  assert.equal(fmtClock('not a date'), '');
  assert.equal(fmtClock(''), '');
});

test('relative age and tooltip', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(fmtRelative('2026-10-11T11:57:00Z', now), '3m ago');
  assert.equal(fmtRelative('2026-10-11T11:59:58Z', now), 'just now');
  assert.equal(timeTitle('2026-10-11T11:57:00Z', now), '2026-10-11T11:57:00Z (3m ago)');
});

test('token line uses out / new input / cache read and never "processed"', () => {
  const u = { in: 100, cc: 900, out: 2000, cr: 5000000 };
  assert.deepEqual(tokenParts(u), { out: 2000, newInput: 1000, cacheRead: 5000000 });
  const line = tokenLine(u);
  assert.match(line, /out 2k/);
  assert.match(line, /new input 1k/);
  assert.match(line, /cache read 5\.0M/);
  assert.doesNotMatch(line, /processed/i);
  assert.equal(tokenLine(null), 'tokens n/a');
  assert.equal(tokenLine({ skipped: true }), 'tokens n/a');
});

test('usageBadge: partial, unavailable, complete', () => {
  assert.equal(usageBadge({ out: 1, complete: true }, { usage: 'complete' }), null);
  const p = usageBadge({ out: 1, complete: false, scanned_pct: 42 }, { usage: 'partial' });
  assert.equal(p.kind, 'partial');
  assert.equal(p.tip, 'lower bound, scan 42% complete');
  assert.equal(usageBadge({ out: 1 }, { usage: 'partial', usage_scanned_pct: 7 }).tip, 'lower bound, scan 7% complete');
  const u = usageBadge({ out: 0 }, { usage: 'unavailable' });
  assert.equal(u.kind, 'unavailable');
  assert.equal(u.tip, 'not available');
  assert.equal(usageBadge(null, null).kind, 'unavailable');
});

test('plural', () => {
  assert.equal(plural(1, 'error'), '1 error');
  assert.equal(plural(2, 'error'), '2 errors');
  assert.equal(plural(0, 'match', 'matches'), '0 matches');
});
