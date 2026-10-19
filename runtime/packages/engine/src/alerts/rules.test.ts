// The effective rule set (03 10.1): the configuration, completed by the schema, as the typed list the evaluator and the service use.
import { RuntimeFileSchema } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { cooldownMs, RULE_SCOPE_KIND, effectiveRules, enabledRule, ruleById, type EffectiveRule } from './rules.ts';

function config(alerts: Record<string, unknown> = {}): { runtime: ReturnType<typeof RuntimeFileSchema.parse> } {
  return { runtime: RuntimeFileSchema.parse({ schema_version: 1, alerts }) };
}

function byKind(rules: readonly EffectiveRule[], kind: EffectiveRule['kind']): EffectiveRule {
  const found = rules.find((rule) => rule.kind === kind);
  if (found === undefined) throw new Error(`no rule ${kind}`);
  return found;
}

describe('effectiveRules (03 10.1)', () => {
  it('lists the eight built-in rules with the defaults of the rule table', () => {
    const set = effectiveRules(config());
    expect(set.sweepSeconds).toBe(60);
    expect(set.enabled).toBe(true);
    expect(set.rules.map((rule) => rule.kind)).toEqual([
      'inactivity',
      'ingest_errors',
      'runtime_unavailable',
      'token_threshold',
      'import_lag',
      'db_disk',
      'hook_gap',
      'hook_failing',
    ]);
    expect(byKind(set.rules, 'inactivity')).toMatchObject({ enabled: true, minutes: 30, cooldownMinutes: 10 });
    expect(byKind(set.rules, 'ingest_errors')).toMatchObject({
      enabled: true,
      count: 10,
      windowMinutes: 10,
      criticalCount: 50,
      cooldownMinutes: 10,
    });
    expect(byKind(set.rules, 'runtime_unavailable')).toMatchObject({ enabled: true, expireHours: 24 });
    expect(byKind(set.rules, 'db_disk')).toMatchObject({ minFreeMb: 500, maxDbMb: 2048, cooldownMinutes: 30 });
    expect(byKind(set.rules, 'hook_gap')).toMatchObject({ enabled: true, cooldownMinutes: 30 });
    expect(byKind(set.rules, 'hook_failing')).toMatchObject({ enabled: true, cooldownMinutes: 10 });
  });

  it('keeps token_threshold off by default and off while it has no threshold', () => {
    expect(byKind(effectiveRules(config()).rules, 'token_threshold').enabled).toBe(false);
    const noThreshold = config({ rules: { token_threshold: { enabled: true } } });
    expect(byKind(effectiveRules(noThreshold).rules, 'token_threshold').enabled).toBe(false);
    const on = effectiveRules(
      config({ rules: { token_threshold: { enabled: true, tokens: 2_000_000, field: 'output' } } }),
    );
    expect(byKind(on.rules, 'token_threshold')).toMatchObject({ enabled: true, tokens: 2_000_000, field: 'output' });
  });

  it('completes a partial override with the other defaults of the rule', () => {
    const set = effectiveRules(config({ rules: { inactivity: { minutes: 5 } } }));
    expect(byKind(set.rules, 'inactivity')).toMatchObject({ enabled: true, minutes: 5, cooldownMinutes: 10 });
  });

  it('turns every rule off when the section is disabled, and one rule off when it is disabled', () => {
    const off = effectiveRules(config({ enabled: false }));
    expect(off.enabled).toBe(false);
    expect(off.rules.every((rule) => !rule.enabled)).toBe(true);
    const one = effectiveRules(config({ rules: { import_lag: { enabled: false } } }));
    expect(byKind(one.rules, 'import_lag').enabled).toBe(false);
    expect(byKind(one.rules, 'hook_gap').enabled).toBe(true);
  });

  it('keeps the sweep interval inside 15..600 seconds', () => {
    expect(effectiveRules(config({ sweepSeconds: 15 })).sweepSeconds).toBe(15);
    expect(effectiveRules(config({ sweepSeconds: 600 })).sweepSeconds).toBe(600);
    const wild = { runtime: { ...config().runtime, alerts: { ...config().runtime.alerts, sweepSeconds: 1 } } };
    expect(effectiveRules(wild).sweepSeconds).toBe(15);
    const slow = { runtime: { ...config().runtime, alerts: { ...config().runtime.alerts, sweepSeconds: 9999 } } };
    expect(effectiveRules(slow).sweepSeconds).toBe(600);
  });

  it('names the scope kind and the cooldown of every rule', () => {
    expect(RULE_SCOPE_KIND).toEqual({
      inactivity: 'session',
      ingest_errors: 'code',
      runtime_unavailable: 'instance',
      token_threshold: 'session',
      import_lag: 'instance',
      db_disk: 'instance',
      hook_gap: 'session',
      hook_failing: 'instance',
    });
    const set = effectiveRules(config());
    expect(cooldownMs(byKind(set.rules, 'inactivity'))).toBe(10 * 60_000);
    expect(cooldownMs(byKind(set.rules, 'db_disk'))).toBe(30 * 60_000);
    // runtime_unavailable and token_threshold have no cooldown setting
    expect(cooldownMs(byKind(set.rules, 'runtime_unavailable'))).toBe(0);
    expect(cooldownMs(byKind(set.rules, 'token_threshold'))).toBe(0);
  });

  it('finds the enabled rule of a kind, typed by its kind', () => {
    const set = effectiveRules(config({ rules: { import_lag: { enabled: false }, inactivity: { minutes: 7 } } }));
    expect(enabledRule(set, 'inactivity')?.minutes).toBe(7);
    expect(enabledRule(set, 'import_lag')).toBeUndefined();
    expect(enabledRule(effectiveRules(config({ enabled: false })), 'inactivity')).toBeUndefined();
  });

  it('finds a rule by id', () => {
    const set = effectiveRules(config());
    expect(ruleById(set, 'hook_gap')?.kind).toBe('hook_gap');
    expect(ruleById(set, 'nope')).toBeUndefined();
  });
});
