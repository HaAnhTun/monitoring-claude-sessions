// @vitest-environment node
import {
  ACTIVE_STATES,
  BOARD_STATES,
  EVENT_CATEGORIES,
  LIFECYCLE_STATES,
  SESSION_SORTS as API_SESSION_SORTS,
  SessionListQuerySchema,
  fromQuery,
  toQuery,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { toSessionFilter } from '../data/endpoints.ts';
import {
  DETAIL_TABS,
  INVALID,
  SESSION_SORTS,
  activitySpec,
  analyticsSpec,
  apiSortOf,
  defaultPresetForWindow,
  flag,
  formatUrlState,
  idText,
  intRange,
  oneOf,
  parseUrlState,
  sessionDetailSpec,
  sessionsSpec,
  setOf,
  settingsSpec,
  tasksSpec,
  text,
  timeRange,
  type Spec,
} from './url-state.ts';

const sp = (q: string): URLSearchParams => new URLSearchParams(q);

describe('single codecs', () => {
  it('text trims, caps at the maximum and defaults to the empty string', () => {
    const c = text('q', 5);
    expect(c.parse(null)).toBe('');
    expect(c.parse('  abc  ')).toBe('abc');
    expect(c.parse('abcdefgh')).toBe('abcde');
    expect(c.parse('   ')).toBe('');
    expect(c.default).toBe('');
    expect(c.format('abc')).toBe('abc');
  });

  it('text caps by code point so a surrogate pair is never cut in half', () => {
    const c = text('q', 3);
    const parsed = c.parse('a\u{1F600}\u{1F600}\u{1F600}');
    expect(parsed).toBe('a\u{1F600}\u{1F600}');
  });

  it('oneOf accepts only listed values', () => {
    const c = oneOf('dir', ['desc', 'asc'] as const, 'desc');
    expect(c.parse(null)).toBe('desc');
    expect(c.parse('asc')).toBe('asc');
    expect(c.parse('ASC')).toBe(INVALID);
    expect(c.parse('')).toBe(INVALID);
    expect(c.parse('__proto__')).toBe(INVALID);
  });

  it('setOf dedupes, orders by the allowed list and rejects the whole param on an unknown member', () => {
    const c = setOf('state', LIFECYCLE_STATES);
    expect(c.default).toEqual([]);
    expect(c.parse(null)).toEqual([]);
    expect(c.parse('failed,running,failed')).toEqual(['running', 'failed']);
    expect(c.parse('running,bogus')).toBe(INVALID);
    expect(c.parse('running,')).toBe(INVALID);
    expect(c.parse('')).toEqual([]);
    expect(c.format(['running', 'failed'])).toBe('running,failed');
  });

  it('flag is "1" or absent', () => {
    const c = flag('errors');
    expect(c.parse(null)).toBe(false);
    expect(c.parse('1')).toBe(true);
    expect(c.parse('0')).toBe(INVALID);
    expect(c.parse('true')).toBe(INVALID);
    expect(c.format(true)).toBe('1');
  });

  it('intRange checks plain decimal digits and the bounds', () => {
    const c = intRange('tokMin', 0, 1000);
    expect(c.default).toBeNull();
    expect(c.parse(null)).toBeNull();
    expect(c.parse('0')).toBe(0);
    expect(c.parse('1000')).toBe(1000);
    expect(c.parse('1001')).toBe(INVALID);
    expect(c.parse('-1')).toBe(INVALID);
    expect(c.parse('1e3')).toBe(INVALID);
    expect(c.parse('0x10')).toBe(INVALID);
    expect(c.parse(' 5')).toBe(INVALID);
    expect(c.parse('')).toBe(INVALID);
    expect(c.parse('99999999999999999999999')).toBe(INVALID);
    expect(c.format(7)).toBe('7');
    const wide = intRange('task', 1, Number.MAX_SAFE_INTEGER);
    expect(wide.parse('9007199254740991')).toBe(9007199254740991);
    expect(wide.parse('9007199254740992')).toBe(INVALID);
  });

  it('idText keeps any characters up to 200 and does not trim', () => {
    const c = idText('project');
    expect(c.parse(null)).toBe('');
    expect(c.parse(' a b/c ')).toBe(' a b/c ');
    expect(c.parse('x'.repeat(250))).toHaveLength(200);
  });
});

describe('timeRange', () => {
  const spec = timeRange('24h');
  const codec = spec.range;

  it('defaults to the preset', () => {
    expect(codec.default).toEqual({ kind: 'preset', preset: '24h' });
    expect(parseUrlState(spec, sp('')).value.range).toEqual({ kind: 'preset', preset: '24h' });
  });

  it('reads a preset, a custom range with and without to', () => {
    expect(parseUrlState(spec, sp('range=7d')).value.range).toEqual({ kind: 'preset', preset: '7d' });
    expect(parseUrlState(spec, sp('from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z')).value.range).toEqual({
      kind: 'custom',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    });
    expect(parseUrlState(spec, sp('from=2026-10-01T00:00:00Z')).value.range).toEqual({
      kind: 'custom',
      from: '2026-10-01T00:00:00.000Z',
      to: null,
    });
  });

  it('ignores a custom range with from >= to, an invalid date, to without from, or mixed forms', () => {
    const bad = [
      'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
      'from=2026-10-02T00:00:00Z&to=2026-10-02T00:00:00Z',
      'from=garbage',
      'from=2026-10-01T00:00:00Z&to=garbage',
      'to=2026-10-01T00:00:00Z',
      'range=7d&from=2026-10-01T00:00:00Z',
      'range=2d',
    ];
    for (const q of bad) {
      const parsed = parseUrlState(spec, sp(q));
      expect(parsed.value.range, q).toEqual({ kind: 'preset', preset: '24h' });
      expect(parsed.ignored.length, q).toBeGreaterThan(0);
    }
  });

  it('formats presets and custom ranges, omitting the default', () => {
    expect(formatUrlState(spec, { range: { kind: 'preset', preset: '24h' } }).toString()).toBe('');
    expect(formatUrlState(spec, { range: { kind: 'preset', preset: '7d' } }).toString()).toBe('range=7d');
    const custom = formatUrlState(spec, {
      range: { kind: 'custom', from: '2026-10-01T00:00:00.000Z', to: null },
    });
    expect(custom.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(custom.has('to')).toBe(false);
    expect(custom.has('range')).toBe(false);
  });

  it('defaultPresetForWindow follows the window hours of the instance', () => {
    expect(defaultPresetForWindow(0.5)).toBe('1h');
    expect(defaultPresetForWindow(1)).toBe('1h');
    expect(defaultPresetForWindow(6)).toBe('6h');
    expect(defaultPresetForWindow(24)).toBe('24h');
    expect(defaultPresetForWindow(168)).toBe('7d');
    expect(defaultPresetForWindow(169)).toBe('30d');
    expect(defaultPresetForWindow(Number.NaN)).toBe('24h');
  });
});

describe('parseUrlState and formatUrlState', () => {
  interface Demo {
    q: string;
    state: string[];
    dir: 'asc' | 'desc';
    n: number | null;
    on: boolean;
  }
  const spec: Spec<Demo> = {
    q: text('q', 10),
    state: setOf('state', ['a', 'b', 'c'] as const),
    dir: oneOf('dir', ['desc', 'asc'] as const, 'desc'),
    n: intRange('n', 0, 100),
    on: flag('on'),
  };

  it('collects unknown keys and invalid values by key only, never by value, and uses defaults for them', () => {
    const parsed = parseUrlState(spec, sp('q=hi&state=zzz&dir=up&n=500&utm=secret&on=1&utm=again'));
    expect(parsed.value).toEqual({ q: 'hi', state: [], dir: 'desc', n: null, on: true });
    expect(parsed.ignored.sort()).toEqual(['dir', 'n', 'state', 'utm']);
    expect(JSON.stringify(parsed.ignored)).not.toContain('secret');
  });

  it('a repeated parameter is ignored as a whole', () => {
    const parsed = parseUrlState(spec, sp('q=a&q=b'));
    expect(parsed.value.q).toBe('');
    expect(parsed.ignored).toEqual(['q']);
  });

  it('omits defaults, keeps the spec order and compares arrays element-wise', () => {
    const out = formatUrlState(spec, { q: '', state: [], dir: 'desc', n: null, on: false });
    expect(out.toString()).toBe('');
    const full = formatUrlState(spec, { q: 'x y', state: ['c', 'a'], dir: 'asc', n: 0, on: true });
    expect([...full.keys()]).toEqual(['q', 'state', 'dir', 'n', 'on']);
    expect(full.get('state')).toBe('c,a');
    expect(full.get('n')).toBe('0');
  });

  it('round trips through the canonical text', () => {
    const value: Demo = { q: 'hello', state: ['a', 'c'], dir: 'asc', n: 42, on: true };
    const text1 = formatUrlState(spec, value).toString();
    expect(parseUrlState(spec, sp(text1)).value).toEqual(value);
    expect(formatUrlState(spec, parseUrlState(spec, sp(text1)).value).toString()).toBe(text1);
  });

  it('garbage never throws', () => {
    const garbage = [
      'q=%E0%A4%A',
      `q=${'x'.repeat(100000)}`,
      '%%%=%%%',
      'state=%00,%ff',
      '=&&=&',
      `n=${'9'.repeat(5000)}`,
      '\u0000=1',
    ];
    for (const g of garbage) {
      expect(() => parseUrlState(spec, sp(g)), g.slice(0, 20)).not.toThrow();
      const parsed = parseUrlState(spec, sp(g));
      expect(parsed.value.q.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('route specs (04 3.2)', () => {
  function roundTrip<S>(spec: Spec<S>, query: string): string {
    const first = parseUrlState(spec, sp(query));
    expect(first.ignored, query).toEqual([]);
    const canonical = formatUrlState(spec, first.value).toString();
    const second = parseUrlState(spec, sp(canonical));
    expect(second.value, query).toEqual(first.value);
    expect(formatUrlState(spec, second.value).toString()).toBe(canonical);
    return canonical;
  }

  it('/sessions: every key round trips and defaults are omitted', () => {
    const spec = sessionsSpec(24);
    expect(formatUrlState(spec, parseUrlState(spec, sp('')).value).toString()).toBe('');
    const canonical = roundTrip(
      spec,
      'q=nightly&state=failed,running&project=my-project&task=12&model=m1&errors=1&range=7d&tokMin=10&tokMax=5000&sort=tokens&dir=asc&unmatched=1',
    );
    const out = new URLSearchParams(canonical);
    expect(out.get('state')).toBe('running,failed');
    expect(out.get('task')).toBe('12');
    expect(out.get('sort')).toBe('tokens');
    expect(out.get('range')).toBe('7d');
    const defaults = parseUrlState(spec, sp('sort=lastActivity&dir=desc&range=24h')).value;
    expect(formatUrlState(spec, defaults).toString()).toBe('');
  });

  it('/sessions: the default range comes from the instance window', () => {
    expect(parseUrlState(sessionsSpec(168), sp('')).value.range).toEqual({ kind: 'preset', preset: '7d' });
    expect(formatUrlState(sessionsSpec(168), parseUrlState(sessionsSpec(168), sp('range=7d')).value).toString()).toBe(
      '',
    );
    expect(formatUrlState(sessionsSpec(168), parseUrlState(sessionsSpec(168), sp('range=24h')).value).toString()).toBe(
      'range=24h',
    );
  });

  it('/sessions: invalid members are reported and replaced by defaults', () => {
    const parsed = parseUrlState(sessionsSpec(24), sp('state=running,nope&task=0&sort=bogus&tokMax=-5&from=x'));
    expect(parsed.ignored.sort()).toEqual(['from', 'sort', 'state', 'task', 'tokMax']);
    expect(parsed.value.state).toEqual([]);
    expect(parsed.value.task).toBeNull();
    expect(parsed.value.sort).toBe('lastActivity');
    expect(parsed.value.tokMax).toBeNull();
  });

  it('/sessions/:id: tab, agent, jump index and client filters round trip', () => {
    const canonical = roundTrip(
      sessionDetailSpec,
      'tab=events&agent=a-1&i=42&kinds=tool,prompt&tq=hello&tool=Bash&terr=1&types=tool,error',
    );
    const out = new URLSearchParams(canonical);
    expect(out.get('kinds')).toBe('prompt,tool');
    expect(out.get('types')).toBe('tool,error');
    expect(parseUrlState(sessionDetailSpec, sp('')).value.tab).toBe('transcript');
    expect(parseUrlState(sessionDetailSpec, sp('tab=nope')).ignored).toEqual(['tab']);
    expect(parseUrlState(sessionDetailSpec, sp('kinds=think,zzz')).value.kinds).toEqual([]);
    expect(parseUrlState(sessionDetailSpec, sp('tq=' + 'x'.repeat(500))).value.tq).toHaveLength(200);
  });

  it('/sessions/:id: the tabs are in the order of the tab bar and the old timeline tab reads as events', () => {
    expect([...DETAIL_TABS]).toEqual(['transcript', 'errors', 'agents', 'tokens', 'events']);
    const old = parseUrlState(sessionDetailSpec, sp('tab=timeline&agent=a-1'));
    expect(old.value.tab).toBe('events');
    expect(old.ignored).toEqual([]);
    expect(formatUrlState(sessionDetailSpec, old.value).toString()).toBe('tab=events&agent=a-1');
    expect(parseUrlState(sessionDetailSpec, sp('tab=toString')).ignored).toEqual(['tab']);
    expect(parseUrlState(sessionDetailSpec, sp('tab=errors')).value.tab).toBe('errors');
  });

  it('/activity: categories, severity, scope ids and a 24h default', () => {
    const spec = activitySpec;
    expect(parseUrlState(spec, sp('')).value.range).toEqual({ kind: 'preset', preset: '24h' });
    roundTrip(spec, 'types=agent,tool&session=s1&project=p&tool=Bash&severity=error,warning&q=oops&range=1h');
    expect(new URLSearchParams(roundTrip(spec, 'severity=error,info')).get('severity')).toBe('info,error');
    for (const c of EVENT_CATEGORIES) expect(parseUrlState(spec, sp(`types=${c}`)).ignored).toEqual([]);
    expect(parseUrlState(spec, sp('severity=fatal')).ignored).toEqual(['severity']);
  });

  it('/tasks: board states and text', () => {
    roundTrip(tasksSpec, 'q=release&state=working,failed');
    for (const s of BOARD_STATES) expect(parseUrlState(tasksSpec, sp(`state=${s}`)).ignored).toEqual([]);
    expect(parseUrlState(tasksSpec, sp('state=running')).ignored).toEqual(['state']);
  });

  it('/analytics: grouping, bucket and a 7d default', () => {
    expect(parseUrlState(analyticsSpec, sp('')).value).toEqual({
      range: { kind: 'preset', preset: '7d' },
      by: 'model',
      bucket: 'day',
    });
    roundTrip(analyticsSpec, 'range=30d&by=task&bucket=hour');
    expect(parseUrlState(analyticsSpec, sp('by=user')).ignored).toEqual(['by']);
  });

  it('/settings: section', () => {
    expect(parseUrlState(settingsSpec, sp('')).value.section).toBe('health');
    roundTrip(settingsSpec, 'section=preferences');
    expect(parseUrlState(settingsSpec, sp('section=other')).ignored).toEqual(['section']);
  });
});

describe('the state alias "active" (R-22)', () => {
  const spec = sessionsSpec(24);
  const parse = (query: string) => parseUrlState(spec, sp(query));

  it('expands to the four active states, in the order of the lifecycle', () => {
    const parsed = parse('state=active');
    expect(parsed.ignored).toEqual([]);
    expect(parsed.value.state).toEqual([...ACTIVE_STATES]);
  });

  it('mixes with concrete states, deduplicates and keeps the lifecycle order', () => {
    expect(parse('state=failed,active').value.state).toEqual([...ACTIVE_STATES, 'failed']);
    expect(parse('state=waiting_tool,active,active').value.state).toEqual([...ACTIVE_STATES]);
    expect(parse('state=waiting_input,active').value.state).toEqual([
      'running',
      'working',
      'waiting_input',
      'waiting_tool',
      'waiting_agent',
    ]);
  });

  it('is written back as the alias, so a link to ?state=active is already canonical', () => {
    const state = parse('state=active').value;
    expect(formatUrlState(spec, state).toString()).toBe('state=active');
    expect(formatUrlState(spec, parse('state=failed,active').value).toString()).toBe('state=active%2Cfailed');
    expect(formatUrlState(spec, parse('state=active,failed').value).get('state')).toBe('active,failed');
  });

  it('reads a bookmarked V3 address that lists the four states the same way', () => {
    const v3 = parse('state=running,working,waiting_tool,waiting_agent');
    expect(v3.ignored).toEqual([]);
    expect(v3.value).toEqual(parse('state=active').value);
    expect(formatUrlState(spec, v3.value).get('state')).toBe('active');
  });

  it('keeps a partial selection as the concrete list', () => {
    expect(formatUrlState(spec, parse('state=running,working').value).get('state')).toBe('running,working');
    expect(formatUrlState(spec, parse('state=failed,running').value).get('state')).toBe('running,failed');
  });

  it('still refuses unknown members, other spellings and an empty member', () => {
    for (const bad of [
      'state=bogus',
      'state=active,bogus',
      'state=Active',
      'state=ACTIVE',
      'state=active,',
      'state=constructor',
    ]) {
      const parsed = parse(bad);
      expect(parsed.value.state, bad).toEqual([]);
      expect(parsed.ignored, bad).toEqual(['state']);
    }
  });

  it('round trips through the canonical text', () => {
    for (const query of ['state=active', 'state=active,failed', 'state=waiting_input,active,stale']) {
      const first = parse(query).value;
      const text1 = formatUrlState(spec, first).toString();
      expect(parse(text1).value, query).toEqual(first);
      expect(formatUrlState(spec, parse(text1).value).toString()).toBe(text1);
    }
  });

  it('is an option of setOf, not of every set', () => {
    const plain = setOf('state', LIFECYCLE_STATES);
    expect(plain.parse('active')).toBe(INVALID);
    const aliased = setOf('s', ['a', 'b', 'c'] as const, { ab: ['a', 'b'] });
    expect(aliased.parse('ab')).toEqual(['a', 'b']);
    expect(aliased.parse('ab,c')).toEqual(['a', 'b', 'c']);
    expect(aliased.format(['a', 'b'])).toBe('ab');
    expect(aliased.format(['a'])).toBe('a');
    expect(aliased.parse('__proto__')).toBe(INVALID);
  });
});

describe('the session sorts (R-34)', () => {
  const spec = sessionsSpec(24);

  it('adds errors (a server sort) and attention (a UI sort) to the V3 list', () => {
    expect([...SESSION_SORTS]).toEqual([
      'lastActivity',
      'started',
      'duration',
      'tokens',
      'state',
      'label',
      'errors',
      'attention',
    ]);
    for (const sort of API_SESSION_SORTS) expect(SESSION_SORTS).toContain(sort);
    for (const sort of SESSION_SORTS) {
      const parsed = parseUrlState(spec, sp(`sort=${sort}`));
      expect(parsed.ignored, sort).toEqual([]);
      expect(parsed.value.sort).toBe(sort);
    }
    expect(parseUrlState(spec, sp('sort=Attention')).ignored).toEqual(['sort']);
  });

  it('writes the default sort as nothing and the others by name', () => {
    const state = parseUrlState(spec, sp('sort=errors&dir=asc')).value;
    expect(formatUrlState(spec, state).toString()).toBe('sort=errors&dir=asc');
    expect(formatUrlState(spec, parseUrlState(spec, sp('sort=attention')).value).toString()).toBe('sort=attention');
  });

  it('reads the bookmarked V3 addresses the same way', () => {
    expect(parseUrlState(spec, sp('sort=tokens&dir=asc'))).toEqual({
      value: { ...parseUrlState(spec, sp('')).value, sort: 'tokens', dir: 'asc' },
      ignored: [],
    });
    expect(parseUrlState(spec, sp('state=active&sort=label&dir=asc&range=7d&errors=1')).ignored).toEqual([]);
  });

  it('never sends the attention sort to the API', () => {
    const base = parseUrlState(spec, sp('')).value;
    expect(apiSortOf({ sort: 'attention', dir: 'asc' })).toEqual({ sort: 'lastActivity', dir: 'desc' });
    expect(apiSortOf({ sort: 'attention', dir: 'desc' })).toEqual({ sort: 'lastActivity', dir: 'desc' });
    expect(apiSortOf({ sort: 'errors', dir: 'asc' })).toEqual({ sort: 'errors', dir: 'asc' });
    const query = toQuery(toSessionFilter({ ...base, sort: 'attention', dir: 'asc' }));
    expect(query['sort']).toBe('lastActivity');
    expect(query['dir']).toBe('desc');
    expect(() => fromQuery(SessionListQuerySchema, query)).not.toThrow();
    const errors = toQuery(toSessionFilter({ ...base, sort: 'errors' }));
    expect(errors['sort']).toBe('errors');
    expect(() => fromQuery(SessionListQuerySchema, errors)).not.toThrow();
  });

  it('sends the alias as the four concrete states, which the route accepts', () => {
    const state = parseUrlState(spec, sp('state=active')).value;
    const query = toQuery(toSessionFilter(state));
    expect(query['state']).toBe('running,working,waiting_tool,waiting_agent');
    expect(() => fromQuery(SessionListQuerySchema, query)).not.toThrow();
  });
});
