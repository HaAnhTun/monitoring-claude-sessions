// `alerts` section: rules are configuration, not API-editable records (03 section 10.1). 03 states ranges only for
// `sweepSeconds`; the other bounds are chosen by 01 (1.6) and the owner may narrow them.
//
// The merge of 01 2.2 stays one level deep: `alerts.rules` replaces the skill layer value as a whole, and the schema of
// `rules` completes it, so a partial override (`alerts.rules.inactivity.minutes`) gets the other defaults.
import { z } from 'zod';

import { type KeySpec, boolKey, intKey, nullableIntKey, sectionOverridesSchema, sectionSchema } from './section.ts';

const cooldownMinutes = (def: number) => intKey(0, 10_080, def);

const tokenField: KeySpec<z.ZodEnum<{ total: 'total'; output: 'output' }>> = {
  schema: z.enum(['total', 'output']),
  default: 'total',
};

/** Key table of every rule; the defaults are the table of 03 10.1. */
export const AlertRuleKeys = {
  inactivity: { enabled: boolKey(true), minutes: intKey(1, 10_080, 30), cooldownMinutes: cooldownMinutes(10) },
  ingest_errors: {
    enabled: boolKey(true),
    count: intKey(1, 100_000, 10),
    windowMinutes: intKey(1, 1440, 10),
    criticalCount: intKey(1, 1_000_000, 50),
    cooldownMinutes: cooldownMinutes(10),
  },
  runtime_unavailable: { enabled: boolKey(true), expireHours: intKey(1, 720, 24) },
  token_threshold: {
    enabled: boolKey(false),
    tokens: nullableIntKey(1, Number.MAX_SAFE_INTEGER),
    field: tokenField,
  },
  import_lag: { enabled: boolKey(true), cooldownMinutes: cooldownMinutes(10) },
  db_disk: {
    enabled: boolKey(true),
    minFreeMb: intKey(0, 10_000_000, 500),
    maxDbMb: intKey(1, 10_000_000, 2048),
    cooldownMinutes: cooldownMinutes(30),
  },
  hook_gap: { enabled: boolKey(true), cooldownMinutes: cooldownMinutes(30) },
  hook_failing: { enabled: boolKey(true), cooldownMinutes: cooldownMinutes(10) },
};

export const ALERT_RULE_IDS = [
  'inactivity',
  'ingest_errors',
  'runtime_unavailable',
  'token_threshold',
  'import_lag',
  'db_disk',
  'hook_gap',
  'hook_failing',
] as const;

export type AlertRuleId = (typeof ALERT_RULE_IDS)[number];

/** Every rule is a strict object with `.prefault({})`, so a partial rule is completed by the schema. */
const RulesSchema = z.strictObject({
  inactivity: sectionSchema(AlertRuleKeys.inactivity),
  ingest_errors: sectionSchema(AlertRuleKeys.ingest_errors),
  runtime_unavailable: sectionSchema(AlertRuleKeys.runtime_unavailable),
  token_threshold: sectionSchema(AlertRuleKeys.token_threshold),
  import_lag: sectionSchema(AlertRuleKeys.import_lag),
  db_disk: sectionSchema(AlertRuleKeys.db_disk),
  hook_gap: sectionSchema(AlertRuleKeys.hook_gap),
  hook_failing: sectionSchema(AlertRuleKeys.hook_failing),
});

/** The same rules without defaults, for `runtime.json` itself: an overrides file never injects sibling defaults. */
const RulesOverridesSchema = z.strictObject({
  inactivity: sectionOverridesSchema(AlertRuleKeys.inactivity),
  ingest_errors: sectionOverridesSchema(AlertRuleKeys.ingest_errors),
  runtime_unavailable: sectionOverridesSchema(AlertRuleKeys.runtime_unavailable),
  token_threshold: sectionOverridesSchema(AlertRuleKeys.token_threshold),
  import_lag: sectionOverridesSchema(AlertRuleKeys.import_lag),
  db_disk: sectionOverridesSchema(AlertRuleKeys.db_disk),
  hook_gap: sectionOverridesSchema(AlertRuleKeys.hook_gap),
  hook_failing: sectionOverridesSchema(AlertRuleKeys.hook_failing),
});

const rules: KeySpec<typeof RulesSchema> = {
  schema: RulesSchema,
  default: {
    inactivity: { enabled: true, minutes: 30, cooldownMinutes: 10 },
    ingest_errors: { enabled: true, count: 10, windowMinutes: 10, criticalCount: 50, cooldownMinutes: 10 },
    runtime_unavailable: { enabled: true, expireHours: 24 },
    token_threshold: { enabled: false, tokens: null, field: 'total' },
    import_lag: { enabled: true, cooldownMinutes: 10 },
    db_disk: { enabled: true, minFreeMb: 500, maxDbMb: 2048, cooldownMinutes: 30 },
    hook_gap: { enabled: true, cooldownMinutes: 30 },
    hook_failing: { enabled: true, cooldownMinutes: 10 },
  },
  overrides: RulesOverridesSchema,
};

export const AlertsSectionKeys = {
  enabled: boolKey(true),
  sweepSeconds: intKey(15, 600, 60),
  rules,
};

export const AlertsSectionSchema = sectionSchema(AlertsSectionKeys);
