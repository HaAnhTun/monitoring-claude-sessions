// The pattern rules of `migrate-workspace` (ADR 0068): translate, keep or block, and never repeat a pattern text.
import { describe, expect, it } from 'vitest';

import { fromPlain, type JsonDoc } from '../json/index.ts';
import { compileRegex } from '../regex/index.ts';
import { planPatterns, sameConfig } from './patterns.ts';
import { auditSummary, reportLines } from './report.ts';

type JsonObject = Extract<JsonDoc, { k: 'obj' }>;

function config(plain: Record<string, unknown>): JsonObject {
  const value = fromPlain({ schema_version: 1, ...plain });
  if (value.k !== 'obj') throw new Error('not an object');
  return value;
}

function stringAt(doc: JsonObject, ...path: (string | number)[]): string {
  let current: JsonDoc | undefined = doc;
  for (const key of path) {
    if (current === undefined) break;
    if (typeof key === 'number') current = current.k === 'arr' ? current.v[key] : undefined;
    else current = current.k === 'obj' ? current.v.find(([k]) => k === key)?.[1] : undefined;
  }
  if (current?.k !== 'str') throw new Error(`no string at ${path.join('.')}`);
  return current.v;
}

const PY_RULE = 'step (?P<step>[0-9]+) done';
const JS_RULE = 'run-job[.]md.*?PART=([A-Z0-9]+)';
const SECRET = 'FIXTURE-CANARY-KEY-27d8f6b0';

describe('planPatterns', () => {
  it('translates every pattern of a workspace without instance.json and changes nothing else', () => {
    const doc = config({ title: 'FIXTURE', session_rules: [{ match: PY_RULE, label: 'x' }] });
    const plan = planPatterns(doc, false);
    expect(plan.steps).toEqual([{ where: 'session_rules[0].match', action: 'translate' }]);
    expect(plan.blockers).toEqual([]);
    const text = stringAt(plan.doc, 'session_rules', 0, 'match');
    expect(compileRegex(text, 'session_rule').exec('step 12 done')?.groupdict()).toEqual({ step: '12' });
    expect(stringAt(plan.doc, 'title')).toBe('FIXTURE');
    expect(stringAt(doc, 'session_rules', 0, 'match')).toBe(PY_RULE);
  });

  it('with instance.json keeps a JavaScript pattern (warning) and translates a Python one', () => {
    const doc = config({
      session_rules: [
        { match: JS_RULE, label: 'a' },
        { match: PY_RULE, label: 'b' },
      ],
    });
    const plan = planPatterns(doc, true);
    expect(plan.steps.map((s) => s.action)).toEqual(['keep', 'translate']);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('session_rules[0].match');
    expect(stringAt(plan.doc, 'session_rules', 0, 'match')).toBe(JS_RULE);
    expect(sameConfig(doc, plan.doc)).toBe(false);
  });

  it('keeps a pattern the translator refuses when it compiles as JavaScript', () => {
    const plan = planPatterns(config({ session_rules: [{ match: '(?<n>[0-9]+)', label: 'a' }] }), false);
    expect(plan.steps).toEqual([{ where: 'session_rules[0].match', action: 'keep' }]);
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
  });

  it('blocks a pattern that neither translates nor compiles, with code and position but no text', () => {
    const doc = config({ attempts: { start: `(?x) ${SECRET}`, end: '^done' } });
    const plan = planPatterns(doc, false);
    const start = plan.steps.find((s) => s.where === 'attempts.start');
    expect(start).toMatchObject({ action: 'blocked', code: 'UNSUPPORTED_FLAG' });
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatch(/^REGEX_UNSUPPORTED: attempts\.start /u);
    expect(JSON.stringify([plan.steps, plan.blockers, plan.warnings])).not.toContain(SECRET);
  });

  it('is current on a second pass over its own output', () => {
    const doc = config({ attempts: { start: '^(?P<a>[0-9]+) go', end: '^(?P<a>[0-9]+) end' } });
    const first = planPatterns(doc, false);
    const second = planPatterns(first.doc, true);
    expect(second.steps.map((s) => s.action)).toEqual(['keep', 'keep']);
    expect(sameConfig(first.doc, second.doc)).toBe(true);
  });
});

describe('report texts', () => {
  it('the audit summary names counts and locations only', () => {
    const summary = auditSummary(
      [
        { where: 'attempts.start', action: 'translate' },
        { where: 'session_rules[0].match', action: 'keep' },
      ],
      true,
    );
    expect(summary).toBe(
      'translated 1 pattern to the JavaScript dialect (attempts.start); kept 1 pattern as written; added instance.json, audit/, data/ and logs/',
    );
  });

  it('the dry-run lines end with the apply hint', () => {
    const lines = reportLines({
      slug: 'demo',
      verdict: 'needs-migration',
      mode: 'dry-run',
      actions: ['write config.json'],
      patterns: [],
      blockers: [],
      warnings: [],
      backup: null,
    });
    expect(lines).toEqual([
      "task 'demo': needs-migration (dry run, nothing written)",
      '  would write config.json',
      'run `mcs migrate-workspace --task demo --apply` to convert it (a backup is written first)',
    ]);
  });
});
