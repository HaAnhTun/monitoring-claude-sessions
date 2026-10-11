// @vitest-environment node
import { BOARD_STATES, EVENT_CATEGORIES, LIFECYCLE_STATES } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  INVALID,
  activitySpec,
  analyticsSpec,
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
      'tab=timeline&agent=a-1&i=42&kinds=tool,prompt&tq=hello&tool=Bash&terr=1&types=tool,error',
    );
    const out = new URLSearchParams(canonical);
    expect(out.get('kinds')).toBe('prompt,tool');
    expect(out.get('types')).toBe('tool,error');
    expect(parseUrlState(sessionDetailSpec, sp('')).value.tab).toBe('transcript');
    expect(parseUrlState(sessionDetailSpec, sp('tab=nope')).ignored).toEqual(['tab']);
    expect(parseUrlState(sessionDetailSpec, sp('kinds=think,zzz')).value.kinds).toEqual([]);
    expect(parseUrlState(sessionDetailSpec, sp('tq=' + 'x'.repeat(500))).value.tq).toHaveLength(200);
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
