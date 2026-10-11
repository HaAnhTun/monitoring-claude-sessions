import test from 'node:test';
import assert from 'node:assert/strict';
import { pairEvents, unitSig, isErrorUnit, toolDurationSec, mergeEvents, followReducer, initialFollow, atLatestEdge, stepError, parseJump } from '../../src/frontend/modules/timeline-model.js';
import { defaultFilters, unitVisible, collectToolNames, searchQuery, hasActiveFilters } from '../../src/frontend/modules/filters.js';
import { buildSessionView, groupAgents, stateSummary, diffStates, stateMap } from '../../src/frontend/modules/sessions.js';
import { computeHealth, titleFor, countStates } from '../../src/frontend/modules/health.js';

const T = '2026-10-11T10:00:00Z';
const ev = (i, k, extra = {}) => ({ i, t: T, k, ...extra });
const sample = [
  ev(0, 'prompt', { text: 'Do the thing' }),
  ev(1, 'say', { text: 'Sure, running ls' }),
  ev(2, 'tool', { id: 'a', name: 'Bash', summary: 'ls -la', input: '{"command":"ls -la"}' }),
  ev(3, 'tool', { id: 'b', name: 'Read', summary: 'file.txt', input: '{}' }),
  { ...ev(4, 'result', { id: 'a', text: 'total 0', err: false }), t: '2026-10-11T10:00:05Z' },
  ev(5, 'think', { text: 'hmm' }),
  ev(6, 'result', { id: 'zzz', text: 'orphan error', err: true }),
];

test('pairEvents nests results in tools and classifies status', () => {
  const units = pairEvents(sample);
  assert.deepEqual(units.map((u) => u.key), ['e0', 'e1', 'e2', 'e3', 'e5', 'e6']);
  const a = units.find((u) => u.key === 'e2');
  const b = units.find((u) => u.key === 'e3');
  assert.equal(a.status, 'completed');
  assert.equal(a.result.i, 4);
  assert.equal(b.status, 'active'); // no result yet
  assert.equal(b.result, null);
  const orphan = units.find((u) => u.key === 'e6');
  assert.equal(orphan.orphan, true);
  assert.equal(isErrorUnit(orphan), true);
});

test('failed tool when result has err; sig changes when result arrives', () => {
  const before = pairEvents(sample.slice(0, 4));
  const after = pairEvents([...sample.slice(0, 4), ev(4, 'result', { id: 'b', text: 'nope', err: true })]);
  const ub = before.find((u) => u.key === 'e3');
  const ua = after.find((u) => u.key === 'e3');
  assert.equal(ua.status, 'failed');
  assert.notEqual(unitSig(ub), unitSig(ua));
  assert.equal(isErrorUnit(ua), true);
});

test('orphan result is dropped once its tool is loaded (older events arrive later)', () => {
  const onlyResult = pairEvents([ev(4, 'result', { id: 'a', text: 'x' })]);
  assert.equal(onlyResult.length, 1);
  const both = pairEvents([ev(2, 'tool', { id: 'a', name: 'Bash' }), ev(4, 'result', { id: 'a', text: 'x' })]);
  assert.equal(both.length, 1);
  assert.equal(both[0].kind, 'tool');
});

test('tool duration: running uses now, finished uses result time', () => {
  const units = pairEvents(sample);
  const done = units.find((u) => u.key === 'e2');
  assert.equal(toolDurationSec(done, Date.now()), 5);
  const active = units.find((u) => u.key === 'e3');
  assert.equal(toolDurationSec(active, Date.parse(T) + 12000), 12);
});

test('mergeEvents appends, dedupes and reports older additions', () => {
  const a = [ev(5, 'say'), ev(6, 'say')];
  assert.deepEqual(mergeEvents(a, [ev(7, 'say')]).events.map((e) => e.i), [5, 6, 7]);
  const r = mergeEvents(a, [ev(3, 'say'), ev(4, 'say')]);
  assert.deepEqual(r.events.map((e) => e.i), [3, 4, 5, 6]);
  assert.equal(r.olderAdded, 2);
  const d = mergeEvents(a, [ev(6, 'say'), ev(7, 'say')]);
  assert.deepEqual(d.events.map((e) => e.i), [5, 6, 7]);
  assert.equal(d.added, 1);
  assert.equal(mergeEvents(a, []).added, 0);
});

test('follow state machine', () => {
  let s = initialFollow();
  assert.deepEqual(s, { follow: true, unseen: 0, away: false });
  s = followReducer(s, { type: 'events', count: 3 });
  assert.equal(s.unseen, 0); // following: nothing unseen
  s = followReducer(s, { type: 'scroll', atEdge: false });
  assert.equal(s.follow, false);
  s = followReducer(s, { type: 'events', count: 4 });
  s = followReducer(s, { type: 'events', count: 2 });
  assert.equal(s.unseen, 6);
  const back = followReducer(s, { type: 'scroll', atEdge: true }); // user scrolled back to the edge
  assert.deepEqual(back, { follow: true, unseen: 0, away: false });
  s = followReducer(s, { type: 'resume' });
  assert.deepEqual(s, { follow: true, unseen: 0, away: false });
  // explicit off does not auto-resume when the user wiggles at the edge
  s = followReducer(s, { type: 'toggle' });
  assert.equal(s.follow, false);
  s = followReducer(s, { type: 'scroll', atEdge: true });
  assert.equal(s.follow, false);
  s = followReducer(s, { type: 'toggle' });
  assert.equal(s.follow, true);
  s = followReducer(followReducer(s, { type: 'scroll', atEdge: false }), { type: 'reset' });
  assert.deepEqual(s, initialFollow());
  // same state object when nothing changes
  const same = initialFollow();
  assert.equal(followReducer(same, { type: 'scroll', atEdge: true }), same);
});

test('atLatestEdge respects direction', () => {
  assert.equal(atLatestEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }, true), true);
  assert.equal(atLatestEdge({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }, true), false);
  assert.equal(atLatestEdge({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, false), true);
  assert.equal(atLatestEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }, false), false);
});

test('stepError walks forward and backward without wrapping', () => {
  const keys = ['e2', 'e5', 'e9'];
  assert.equal(stepError(keys, null, 1), 'e2');
  assert.equal(stepError(keys, null, -1), 'e9');
  assert.equal(stepError(keys, 'e2', 1), 'e5');
  assert.equal(stepError(keys, 'e9', 1), null);
  assert.equal(stepError(keys, 'e2', -1), null);
  assert.equal(stepError(keys, 'gone', 1), 'e2');
  assert.equal(stepError([], null, 1), null);
});

test('parseJump', () => {
  const now = new Date(2026, 9, 11, 15, 0, 0);
  assert.deepEqual(parseJump('#42'), { type: 'index', i: 42 });
  assert.deepEqual(parseJump(' 7 '), { type: 'index', i: 7 });
  const t = parseJump('12:30', now);
  assert.equal(t.type, 'time');
  assert.equal(new Date(t.ts).getHours(), 12);
  assert.equal(new Date(t.ts).getMinutes(), 30);
  assert.equal(parseJump('25:00', now), null);
  assert.deepEqual(parseJump('2026-10-11T10:00:00Z'), { type: 'time', ts: '2026-10-11T10:00:00.000Z' });
  assert.equal(parseJump('hello'), null);
  assert.equal(parseJump(''), null);
});

test('filters: kinds, text, tool, errors only', () => {
  const units = pairEvents(sample);
  const f = { ...defaultFilters({ show_prompts: true, show_thinking: true }) };
  const vis = (ff) => units.filter((u) => unitVisible(u, ff)).map((u) => u.key);
  assert.deepEqual(vis(f), ['e0', 'e1', 'e2', 'e3', 'e5', 'e6']);
  assert.deepEqual(vis(defaultFilters()), ['e1', 'e2', 'e3', 'e6']); // prompts and thinking off by default
  assert.deepEqual(vis({ ...f, q: 'LS -la' }), ['e2']);            // case-insensitive, tool summary
  assert.deepEqual(vis({ ...f, q: 'total 0' }), ['e2']);           // matches the nested result text
  assert.deepEqual(vis({ ...f, tool: 'Read' }), ['e3']);
  assert.deepEqual(vis({ ...f, errorsOnly: true }), ['e6']);
  assert.deepEqual(vis({ ...f, kinds: { ...f.kinds, tool: false } }), ['e0', 'e1', 'e2', 'e5', 'e6']); // e2 still has a result
  assert.deepEqual(vis({ ...f, kinds: { ...f.kinds, tool: false, result: false } }), ['e0', 'e1', 'e5']);
  assert.deepEqual(collectToolNames(units), ['Bash', 'Read']);
  assert.equal(hasActiveFilters(f), false);
  assert.equal(hasActiveFilters({ ...f, q: ' x ' }), true);
});

test('searchQuery mirrors filters', () => {
  const f = { ...defaultFilters(), q: ' foo bar ', tool: 'Bash', errorsOnly: true };
  const p = new URLSearchParams(searchQuery(f, 'sid1', ''));
  assert.equal(p.get('sid'), 'sid1');
  assert.equal(p.get('q'), 'foo bar');
  assert.equal(p.get('tool'), 'Bash');
  assert.equal(p.get('errors'), '1');
  assert.equal(p.get('kinds'), 'say,tool,result');
  const all = new URLSearchParams(searchQuery({ ...f, kinds: { prompt: true, say: true, think: true, tool: true, result: true } }, 's', 'a'));
  assert.equal(all.get('kinds'), null);
  assert.equal(all.get('agent'), 'a');
});

const sess = (id, state, extra = {}) => ({ id, label: id, state, agents: [], age: 1, ...extra });

test('session view groups by state, filters, and keeps agents', () => {
  const list = [
    sess('s-run', 'RUNNING'), sess('s-idle', 'IDLE'), sess('s-ok', 'COMPLETED'), sess('s-bad', 'FAILED'), sess('s-unk', 'UNKNOWN'),
    sess('s-ag', 'IDLE', { agents: [{ agent: 'x1', label: 'planner', state: 'RUNNING', workflow: 'wf' }, { agent: 'x2', label: 'coder', state: 'COMPLETED', workflow: '' }] }),
    sess('s-nostate', undefined),
  ];
  const view = buildSessionView(list);
  assert.deepEqual(view.map((g) => [g.id, g.entries.length]), [['running', 1], ['idle', 2], ['done', 2], ['unknown', 2]]);
  const f = buildSessionView(list, 'planner');
  assert.equal(f.length, 1);
  assert.equal(f[0].entries[0].s.id, 's-ag');
  assert.equal(f[0].entries[0].agents.length, 1);
  assert.equal(f[0].entries[0].viaAgents, true);
  assert.equal(buildSessionView(list, 'zzz').length, 0);
  assert.equal(buildSessionView(list, 'failed').length, 1); // matches by state text
});

test('groupAgents: workflows, plain subagents, no cap, per-group summary', () => {
  const agents = [];
  for (let i = 0; i < 120; i += 1) agents.push({ agent: `a${i}`, label: `a${i}`, state: i % 2 ? 'RUNNING' : 'COMPLETED', workflow: i < 100 ? 'wf-1' : '' });
  const g = groupAgents(agents);
  assert.deepEqual(g.map((x) => [x.title, x.agents.length]), [['Subagents', 20], ['Workflow wf-1', 100]]);
  assert.equal(g[1].summary, '50 running, 50 completed');
  assert.equal(stateSummary([{ state: 'FAILED' }, { state: 'bogus' }]), '1 failed, 1 unknown');
});

test('state change detection', () => {
  const a = stateMap([sess('s1', 'RUNNING')]);
  const b = stateMap([sess('s1', 'COMPLETED'), sess('s2', 'RUNNING')]);
  assert.deepEqual(diffStates(a, b).map((c) => [c.label, c.from, c.to]), [['s1', 'RUNNING', 'COMPLETED']]);
});

test('computeHealth: connecting, ok, reconnecting, lost, stale', () => {
  const rec = (name, o = {}) => ({ name, lastSuccess: null, lastError: null, failures: 0, ...o });
  const core = ['health', 'sessions'];
  const now = 100000;
  assert.equal(computeHealth({ records: [], now, staleAfterMs: 20000, coreNames: core }).connection, 'connecting');
  let h = computeHealth({ records: [rec('health', { lastSuccess: 99000 }), rec('sessions', { lastSuccess: 98000 })], now, staleAfterMs: 20000, coreNames: core });
  assert.equal(h.connection, 'ok');
  assert.equal(h.stale, false);
  assert.equal(h.ageMs, 2000); // worst case of the two
  h = computeHealth({ records: [rec('health', { lastSuccess: 99000 }), rec('sessions', { lastSuccess: 95000, failures: 1, lastError: { message: 'x', t: 96000 } })], now, staleAfterMs: 20000, coreNames: core });
  assert.equal(h.connection, 'reconnecting');
  assert.equal(h.lastError.name, 'sessions');
  h = computeHealth({ records: [rec('health', { lastSuccess: 50000, failures: 4, lastError: { message: 'x', t: 90000 } }), rec('sessions', { lastSuccess: 50000 })], now, staleAfterMs: 20000, coreNames: core });
  assert.equal(h.connection, 'lost');
  assert.equal(h.stale, true);
  // never succeeded, three failures: lost
  h = computeHealth({ records: [rec('config', { failures: 3, lastError: { message: 'x', t: 1 } })], now, staleAfterMs: 20000, coreNames: ['config'] });
  assert.equal(h.connection, 'lost');
  // ok but throttled tab: stale without failures
  h = computeHealth({ records: [rec('health', { lastSuccess: 10000 }), rec('sessions', { lastSuccess: 10000 })], now, staleAfterMs: 20000, coreNames: core });
  assert.equal(h.connection, 'ok');
  assert.equal(h.stale, true);
});

test('page title uses words, not emoji', () => {
  const counts = countStates([{ state: 'RUNNING' }, { state: 'RUNNING' }, { state: 'FAILED' }, { state: 'x' }]);
  assert.equal(titleFor(counts, 'Nightly build', 'ok'), '2 running, 1 failed - Nightly build');
  assert.equal(titleFor(countStates([]), 'Nightly build', 'ok'), 'Nightly build');
  assert.equal(titleFor(counts, 'Nightly build', 'lost'), 'Monitor offline - Nightly build');
});
