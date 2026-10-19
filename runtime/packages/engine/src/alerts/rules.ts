// The effective alert rules (03 10.1, ADR 0027): the `alerts` section of the resolved configuration, completed by the schema, as
// one typed list. The ids of the built-in rules equal their kinds. Rules are configuration, not records: a change needs a restart
// (`mcs configure` reports `restart_needed`), so the list is read once when the service is created.
import type { AlertRuleKind, RuntimeConfig } from '@mcs/shared';

type RulesConfig = RuntimeConfig['alerts']['rules'];

export type AlertScopeKind = 'instance' | 'session' | 'code';

/** Where each rule keeps its state (03 10.1, column "Scope key"). */
export const RULE_SCOPE_KIND: Readonly<Record<AlertRuleKind, AlertScopeKind>> = {
  inactivity: 'session',
  ingest_errors: 'code',
  runtime_unavailable: 'instance',
  token_threshold: 'session',
  import_lag: 'instance',
  db_disk: 'instance',
  hook_gap: 'session',
  hook_failing: 'instance',
};

/** The scope key of an instance scoped rule. */
export const INSTANCE_SCOPE_KEY = 'instance';

export type EffectiveRule =
  | ({ readonly kind: 'inactivity'; readonly enabled: boolean } & Omit<RulesConfig['inactivity'], 'enabled'>)
  | ({ readonly kind: 'ingest_errors'; readonly enabled: boolean } & Omit<RulesConfig['ingest_errors'], 'enabled'>)
  | ({ readonly kind: 'runtime_unavailable'; readonly enabled: boolean } & Omit<
      RulesConfig['runtime_unavailable'],
      'enabled'
    >)
  | {
      readonly kind: 'token_threshold';
      readonly enabled: boolean;
      readonly tokens: number | null;
      readonly field: 'total' | 'output';
    }
  | ({ readonly kind: 'import_lag'; readonly enabled: boolean } & Omit<RulesConfig['import_lag'], 'enabled'>)
  | ({ readonly kind: 'db_disk'; readonly enabled: boolean } & Omit<RulesConfig['db_disk'], 'enabled'>)
  | ({ readonly kind: 'hook_gap'; readonly enabled: boolean } & Omit<RulesConfig['hook_gap'], 'enabled'>)
  | ({ readonly kind: 'hook_failing'; readonly enabled: boolean } & Omit<RulesConfig['hook_failing'], 'enabled'>);

export interface EffectiveRules {
  /** The master switch of the section (`alerts.enabled`). */
  readonly enabled: boolean;
  /** Seconds between two sweeps, kept inside 15..600. */
  readonly sweepSeconds: number;
  readonly rules: readonly EffectiveRule[];
}

export const MIN_SWEEP_SECONDS = 15;
export const MAX_SWEEP_SECONDS = 600;

function clampSweep(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60;
  return Math.min(MAX_SWEEP_SECONDS, Math.max(MIN_SWEEP_SECONDS, Math.trunc(seconds)));
}

/**
 * The rules in force. A rule is enabled when the section and the rule are; `token_threshold` without a threshold has nothing to
 * compare with, so it is off whatever its `enabled` says.
 */
export function effectiveRules(config: { readonly runtime: Pick<RuntimeConfig, 'alerts'> }): EffectiveRules {
  const { alerts } = config.runtime;
  const on = (rule: { enabled: boolean }): boolean => alerts.enabled && rule.enabled;
  const { rules } = alerts;
  const list: EffectiveRule[] = [
    { ...rules.inactivity, kind: 'inactivity', enabled: on(rules.inactivity) },
    { ...rules.ingest_errors, kind: 'ingest_errors', enabled: on(rules.ingest_errors) },
    { ...rules.runtime_unavailable, kind: 'runtime_unavailable', enabled: on(rules.runtime_unavailable) },
    {
      ...rules.token_threshold,
      kind: 'token_threshold',
      enabled: on(rules.token_threshold) && rules.token_threshold.tokens !== null,
    },
    { ...rules.import_lag, kind: 'import_lag', enabled: on(rules.import_lag) },
    { ...rules.db_disk, kind: 'db_disk', enabled: on(rules.db_disk) },
    { ...rules.hook_gap, kind: 'hook_gap', enabled: on(rules.hook_gap) },
    { ...rules.hook_failing, kind: 'hook_failing', enabled: on(rules.hook_failing) },
  ];
  return { enabled: alerts.enabled, sweepSeconds: clampSweep(alerts.sweepSeconds), rules: list };
}

/** The rule of a kind when it is enabled, typed by its kind. */
export function enabledRule<K extends EffectiveRule['kind']>(
  set: EffectiveRules,
  kind: K,
): Extract<EffectiveRule, { kind: K }> | undefined {
  return set.rules.find((rule): rule is Extract<EffectiveRule, { kind: K }> => rule.kind === kind && rule.enabled);
}

export function ruleById(set: EffectiveRules, ruleId: string): EffectiveRule | undefined {
  return set.rules.find((rule) => rule.kind === ruleId);
}

/** The cooldown after a resolution, in milliseconds; 0 for the rules without a `cooldownMinutes` setting. */
export function cooldownMs(rule: EffectiveRule): number {
  return 'cooldownMinutes' in rule ? rule.cooldownMinutes * 60_000 : 0;
}
