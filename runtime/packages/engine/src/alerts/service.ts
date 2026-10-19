// The alert service (03 10.2, ADR 0027): the rules of `rules.ts`, the facts of the instance, the pure evaluator of `evaluator.ts`
// and the one place that writes `alerts` and `alert_state`.
//
//   apply(ruleId, scopeKey, result)  one scope of one rule, in its own small write transaction: at most one open alert per rule
//                                    and scope, a cooldown after a resolution, a change row only when an alert opens, resolves
//                                    or changes its severity
//   sweep(now)                       every enabled rule over fresh facts, every `alerts.sweepSeconds` (the `alerts` job of the
//                                    schedule calls `sweepIfDue`); an open alert whose scope no longer holds is resolved
//   onInputs(inputs)                 the alert inputs of the ingest health refresh (02 8.3), which run after the commit that
//                                    produced the condition: the rules they concern are evaluated at once
//
// Evaluation can never break ingestion: nothing here runs inside an ingest transaction, every entry point catches what it
// calls, and a failure becomes an `ingest_errors` row with source `alerts` (code and rule only, never a message) and a line in
// the error ring. There is no network code in this folder (D15, a test scans it): webhooks are deferred (03 10.4).
import { statSync } from 'node:fs';
import path from 'node:path';

import { ACTIVE_STATES, type AlertRuleKind, type Clock, type IngestHealth, type RuntimeConfig } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { AlertsRepo, type AlertDetail, type AlertResolvedReason, type AlertRow } from '../db/repos/alerts.ts';
import { IngestErrorsRepo } from '../db/repos/ingest-errors.ts';
import { withWriteTx, type WriteTx } from '../db/write.ts';
import { ingestHealthEvaluatorOf } from '../health/ingest-health.ts';
import { subscribeAlertInputs, type AlertInput, type AlertInputCode } from '../health/alert-inputs.ts';
import type { Logger } from '../log/logger.ts';
import { createDiskProbe } from '../query/health.ts';
import type { InstanceContext } from '../runtime/context.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import type { RuntimeComponent } from '../runtime/instance-runtime.ts';
import { bindScheduledJob } from '../maintenance/schedule.ts';
import {
  cleared,
  evaluate as evaluateRule,
  type AlertFacts,
  type AlertResult,
  type Downtime,
  type ScopedResult,
} from './evaluator.ts';
import {
  RULE_SCOPE_KIND,
  cooldownMs,
  effectiveRules,
  enabledRule,
  ruleById,
  type EffectiveRule,
  type EffectiveRules,
} from './rules.ts';

const MB = 1024 * 1024;
/** At most this many scopes of one rule are read and kept per evaluation (the oldest or the largest first). */
export const MAX_SCOPES_PER_RULE = 500;
/** A stored detail stays well under the 2,048 of the column (03 3.5), in bytes. */
const MAX_DETAIL_BYTES = 1800;
const ACTIVE_LIST = ACTIVE_STATES.map((state) => `'${state}'`).join(', ');

/** The part of the instance context the service reads. `InstanceContext` satisfies it (`alertContextOf`). */
export interface AlertServiceContext {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly clock: Clock;
  readonly config: { readonly runtime: Pick<RuntimeConfig, 'alerts' | 'health'> };
  readonly instanceDir: string;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly errors: Pick<ErrorRing, 'push'>;
  /** The last ingestion health report of this instance, or null before the first. */
  health(): IngestHealth | null;
}

/** Seams for tests: the evaluator and the two disk figures. */
export interface AlertServiceOptions {
  readonly evaluate?: (rule: EffectiveRule, facts: AlertFacts) => ScopedResult[];
  readonly freeDiskMb?: () => number | null;
  readonly dbMb?: () => number;
}

export type ApplyOutcome = 'opened' | 'refired' | 'resolved' | 'suppressed' | 'idle' | 'failed';

export interface AlertService {
  /** The rules in force (read once; a configuration change needs a restart). */
  readonly rules: EffectiveRules;
  /** One scope of one rule, in its own transaction. Never throws: a failure is recorded and answers `failed`. */
  apply(ruleId: string, scopeKey: string, result: AlertResult, now?: number): ApplyOutcome;
  /** Every enabled rule over fresh facts. Never throws. */
  sweep(now?: number): void;
  /** The sweep when `alerts.sweepSeconds` have passed since the last one (or `force`). True when it ran. */
  sweepIfDue(now: number, force?: boolean): boolean;
  /** The rules that the inputs concern, evaluated at once. Never throws; any number of inputs is one evaluation. */
  onInputs(inputs: readonly AlertInput[]): void;
  /** Startup: resolves the open alerts of every rule that is switched off with `rule_disabled`. Returns the count. */
  resolveDisabled(now?: number): number;
}

/** Which rule an alert input concerns (02 8.3). */
const INPUT_RULE: Readonly<Record<AlertInputCode, AlertRuleKind>> = {
  no_activity: 'inactivity',
  ingest_errors_repeated: 'ingest_errors',
  runtime_unavailable: 'runtime_unavailable',
  import_lag: 'import_lag',
  hook_gap: 'hook_gap',
  hook_failing: 'hook_failing',
  db_error: 'db_disk',
  disk: 'db_disk',
};

/** Rules that read the ingestion health report: without one (before its first refresh) they know nothing, so they do not run. */
const HEALTH_RULES: ReadonlySet<AlertRuleKind> = new Set(['import_lag', 'hook_failing', 'db_disk']);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** The detail is cut key by key (last first) until it fits; titles and details are numbers, so this is a backstop. */
function fitDetail(detail: AlertDetail): AlertDetail {
  const copy: AlertDetail = { ...detail };
  const keys = Object.keys(copy);
  while (keys.length > 0 && Buffer.byteLength(JSON.stringify(copy)) > MAX_DETAIL_BYTES) {
    const last = keys.pop();
    if (last !== undefined) Reflect.deleteProperty(copy, last);
  }
  return copy;
}

/** Why an open alert that no longer holds is resolved. */
function resolutionReason(rule: EffectiveRule, open: AlertRow): AlertResolvedReason {
  // the condition of `runtime_unavailable` is a point in the past: it is not cleared, it runs out (03 10.1)
  if (rule.kind === 'runtime_unavailable') return 'expired';
  // a session scoped alert whose session is gone (retention) lost its scope
  if (RULE_SCOPE_KIND[rule.kind] === 'session' && open.sessionId === null) return 'scope_deleted';
  return 'condition_cleared';
}

interface Gathered {
  readonly facts: AlertFacts;
  /** Rules whose scope list was cut at `MAX_SCOPES_PER_RULE`: their absent scopes are not proof that a condition cleared. */
  readonly truncated: ReadonlySet<AlertRuleKind>;
}

export function createAlertService(ctx: AlertServiceContext, options: AlertServiceOptions = {}): AlertService {
  const { db, scope, clock } = ctx;
  const rules = effectiveRules(ctx.config);
  const repo = new AlertsRepo(db);
  const ingestErrors = new IngestErrorsRepo(db);
  const evaluate = options.evaluate ?? evaluateRule;
  const probe = createDiskProbe();
  let lastSweepAt: number | null = null;

  const freeDiskMb =
    options.freeDiskMb ??
    ((): number | null => {
      const bytes = probe.freeBytes(path.join(ctx.instanceDir, 'data'), clock.now());
      return bytes === null ? null : Math.floor(bytes / MB);
    });
  const dbMb =
    options.dbMb ??
    ((): number => {
      let bytes = 0;
      for (const suffix of ['', '-wal']) {
        try {
          bytes += statSync(path.join(ctx.instanceDir, 'data', `monitor.db${suffix}`)).size;
        } catch {
          // a file that is not there has no size
        }
      }
      return Math.ceil(bytes / MB);
    });

  // ---- failures ------------------------------------------------------------------------------------------------------------

  /** An alert failure is data, not a crash: one `ingest_errors` row (source alerts), one log line, one ring entry. */
  function recordFailure(where: string, code: string, error: unknown): void {
    const name = errorName(error);
    ctx.logger.warn('alert_failed', { phase: where, code });
    ctx.errors.push({ source: 'alerts', code, where: `alerts.${where}`, message: `alerts ${where} failed (${name})` });
    try {
      withWriteTx(db, scope, (tx) => {
        ingestErrors.insert(scope, tx, { at: clock.now(), source: 'alerts', code, detail: `${where} ${name}` });
      });
    } catch {
      // the error row itself could not be written (a full disk, a read-only database): the log and the ring have it
    }
  }

  // ---- apply ---------------------------------------------------------------------------------------------------------------

  function applyIn(
    tx: WriteTx,
    rule: EffectiveRule,
    scopeKey: string,
    r: AlertResult,
    now: number,
  ): Exclude<ApplyOutcome, 'failed'> {
    const open = repo.openFor(scope, rule.kind, scopeKey);
    const previous = repo.getState(scope, rule.kind, scopeKey);
    const cooldown = cooldownMs(rule);
    let conditionSince = previous?.conditionSince ?? null;
    let cooldownUntil = previous?.cooldownUntil ?? null;
    let outcome: Exclude<ApplyOutcome, 'failed'>;

    if (r.holds) {
      conditionSince ??= now;
      const title = r.title === '' ? rule.kind : r.title;
      if (open !== undefined) {
        // a clock that stepped back must not break `last_fired_at >= first_fired_at`
        repo.refire(scope, tx, open.id, {
          at: Math.max(now, open.lastFiredAt),
          severity: r.severity,
          detail: fitDetail(r.detail),
          title,
        });
        outcome = 'refired';
      } else if (cooldownUntil !== null && now < cooldownUntil && cooldownUntil - now <= cooldown) {
        // inside the cooldown after a resolution; a cooldown further away than its length is a clock that stepped back
        outcome = 'suppressed';
      } else {
        repo.insertOpen(scope, tx, {
          ruleId: rule.kind,
          ruleKind: rule.kind,
          scopeKind: RULE_SCOPE_KIND[rule.kind],
          scopeKey,
          sessionId: r.sessionId,
          sessionUid: r.sessionUid,
          severity: r.severity,
          title,
          detail: fitDetail(r.detail),
          at: now,
        });
        cooldownUntil = null;
        outcome = 'opened';
      }
    } else {
      if (open !== undefined) {
        const reason = resolutionReason(rule, open);
        repo.resolve(scope, tx, open.id, { at: Math.max(now, open.firstFiredAt), reason });
        cooldownUntil = reason === 'condition_cleared' && cooldown > 0 ? now + cooldown : null;
        outcome = 'resolved';
      } else {
        outcome = 'idle';
      }
      conditionSince = null;
    }

    // a scope that never held and has no state needs no row
    if (outcome === 'idle' && previous === undefined) return outcome;
    repo.saveState(scope, tx, {
      ruleId: rule.kind,
      scopeKey,
      conditionSince,
      lastValue: r.value,
      lastEvaluatedAt: now,
      cooldownUntil,
    });
    return outcome;
  }

  function apply(ruleId: string, scopeKey: string, result: AlertResult, now: number = clock.now()): ApplyOutcome {
    try {
      const rule = ruleById(rules, ruleId);
      if (rule === undefined) throw new RangeError('unknown alert rule');
      return withWriteTx(db, scope, (tx) => applyIn(tx, rule, scopeKey, result, now));
    } catch (error) {
      recordFailure(ruleId, 'ALERT_APPLY_FAILED', error);
      return 'failed';
    }
  }

  // ---- facts ---------------------------------------------------------------------------------------------------------------

  function downtimeOf(health: IngestHealth | null): Downtime | null {
    let best: Downtime | null = null;
    const row = db.driver
      .prepare<{ at: number; detail: string }>(
        "SELECT at, detail FROM reconciliations WHERE kind = 'runtime_unavailable' ORDER BY at DESC LIMIT 1",
      )
      .get();
    if (row !== undefined) {
      try {
        const detail: unknown = JSON.parse(row.detail);
        if (typeof detail === 'object' && detail !== null) {
          const num = (key: string): number => {
            const value: unknown = Reflect.get(detail, key);
            return typeof value === 'number' && Number.isFinite(value) ? value : 0;
          };
          best = {
            source: 'reconciliation',
            at: row.at,
            from: num('from'),
            to: num('to'),
            envelopes: num('envelopes'),
          };
        }
      } catch {
        // a damaged detail reads as a downtime of unknown length
        best = { source: 'reconciliation', at: row.at, from: row.at, to: row.at, envelopes: 0 };
      }
    }
    const unavailable = health?.receiving.hooks.handlerErrors.find((entry) => entry.code === 'HANDLER_UNAVAILABLE');
    if (unavailable !== undefined && (best === null || unavailable.lastAt > best.at)) {
      best = { source: 'handler', at: unavailable.lastAt, count: unavailable.count };
    }
    return best;
  }

  /** The facts that `kinds` need, read now. Rules that are off or not asked for get empty facts. */
  function gather(now: number, kinds: ReadonlySet<AlertRuleKind>): Gathered {
    const health = ctx.health();
    const truncated = new Set<AlertRuleKind>();
    const wants = (kind: AlertRuleKind): boolean => kinds.has(kind) && ruleById(rules, kind)?.enabled === true;
    const limit = MAX_SCOPES_PER_RULE;

    let activeSessions: AlertFacts['activeSessions'] = [];
    const inactivity = enabledRule(rules, 'inactivity');
    if (inactivity !== undefined && kinds.has('inactivity')) {
      const rows = db.driver
        .prepare<{ rowId: number; uid: string; lastActivityAt: number }>(
          `SELECT id AS rowId, session_uid AS uid, last_activity_at AS lastActivityAt FROM sessions
           WHERE state IN (${ACTIVE_LIST}) AND last_activity_at <= :cut ORDER BY last_activity_at, id LIMIT :limit`,
        )
        .all({ cut: now - inactivity.minutes * 60_000, limit });
      if (rows.length >= limit) truncated.add('inactivity');
      activeSessions = rows;
    }

    let tokenSessions: AlertFacts['tokenSessions'] = [];
    const tokens = enabledRule(rules, 'token_threshold');
    if (wants('token_threshold') && tokens?.tokens !== undefined && tokens.tokens !== null) {
      // the stored rollups count what the importer has seen: a lower bound, so the alert can be late, never early
      const column =
        tokens.field === 'output' ? 'tok_output' : '(tok_input + tok_output + tok_cache_read + tok_cache_creation)';
      const rows = db.driver
        .prepare<{ rowId: number; uid: string; total: number; output: number }>(
          `SELECT id AS rowId, session_uid AS uid, (tok_input + tok_output + tok_cache_read + tok_cache_creation) AS total,
                  tok_output AS output
           FROM sessions WHERE ${column} >= :tokens ORDER BY ${column} DESC, id LIMIT :limit`,
        )
        .all({ tokens: tokens.tokens, limit });
      if (rows.length >= limit) truncated.add('token_threshold');
      tokenSessions = rows;
    }

    let errorCounts: Record<string, number> = {};
    const errorsRule = enabledRule(rules, 'ingest_errors');
    if (wants('ingest_errors') && errorsRule !== undefined) {
      const rows = ingestErrors.codeCountsSince(scope, now - errorsRule.windowMinutes * 60_000);
      errorCounts = Object.fromEntries(rows.map((row) => [row.code, row.count]));
    }

    let gaps: AlertFacts['gaps'] = [];
    if (wants('hook_gap')) {
      const rows = db.driver
        .prepare<{ rowId: number; uid: string; missingTools: number; missingTurns: number }>(
          `SELECT id AS rowId, session_uid AS uid, hook_missing_tools AS missingTools, hook_missing_turns AS missingTurns
           FROM sessions WHERE hook_coverage = 'partial' ORDER BY last_activity_at DESC, id LIMIT :limit`,
        )
        .all({ limit });
      if (rows.length >= limit) truncated.add('hook_gap');
      gaps = rows;
    }

    const facts: AlertFacts = {
      now,
      health,
      importLagWarnMs: ctx.config.runtime.health.importLagWarnMs,
      activeSessions,
      tokenSessions,
      errorCounts,
      downtime: wants('runtime_unavailable') ? downtimeOf(health) : null,
      freeDiskMb: wants('db_disk') ? freeDiskMb() : null,
      dbMb: wants('db_disk') ? dbMb() : 0,
      gaps,
    };
    return { facts, truncated };
  }

  // ---- evaluation ----------------------------------------------------------------------------------------------------------

  /** The scopes of a rule that have something to clear: an open alert, or a condition the state still remembers. */
  function scopesToClear(kind: AlertRuleKind): { scopeKey: string; sessionId: number | null }[] {
    const open = db.driver
      .prepare<{ scopeKey: string; sessionId: number | null }>(
        "SELECT scope_key AS scopeKey, session_id AS sessionId FROM alerts WHERE rule_id = :kind AND status = 'open'",
      )
      .all({ kind });
    const remembered = db.driver
      .prepare<{ scopeKey: string }>(
        'SELECT scope_key AS scopeKey FROM alert_state WHERE rule_id = :kind AND condition_since IS NOT NULL',
      )
      .all({ kind })
      .map((row) => ({ scopeKey: row.scopeKey, sessionId: null }));
    return [...open, ...remembered];
  }

  function runRule(rule: EffectiveRule, gathered: Gathered, now: number): void {
    let results: ScopedResult[];
    try {
      results = evaluate(rule, gathered.facts);
    } catch (error) {
      // an evaluator that fails changes nothing: no alert is opened and none is cleared on a guess
      recordFailure(rule.kind, 'ALERT_EVALUATION_FAILED', error);
      return;
    }
    try {
      const holding = new Set<string>();
      for (const { scopeKey, result } of results) {
        holding.add(scopeKey);
        apply(rule.kind, scopeKey, result, now);
      }
      if (gathered.truncated.has(rule.kind)) return;
      const seen = new Set<string>();
      for (const { scopeKey, sessionId } of scopesToClear(rule.kind)) {
        if (holding.has(scopeKey) || seen.has(scopeKey)) continue;
        seen.add(scopeKey);
        apply(rule.kind, scopeKey, cleared(sessionId), now);
      }
    } catch (error) {
      recordFailure(rule.kind, 'ALERT_SWEEP_FAILED', error);
    }
  }

  function run(kinds: ReadonlySet<AlertRuleKind>, now: number): void {
    let gathered: Gathered;
    try {
      gathered = gather(now, kinds);
    } catch (error) {
      recordFailure('facts', 'ALERT_FACTS_FAILED', error);
      return;
    }
    for (const rule of rules.rules) {
      if (!rule.enabled || !kinds.has(rule.kind)) continue;
      // no report yet is no news: an open alert is not cleared on the strength of it
      if (HEALTH_RULES.has(rule.kind) && gathered.facts.health === null) continue;
      runRule(rule, gathered, now);
    }
  }

  const ALL_KINDS: ReadonlySet<AlertRuleKind> = new Set(rules.rules.map((rule) => rule.kind));

  function sweep(now: number = clock.now()): void {
    if (!rules.enabled) return;
    try {
      run(ALL_KINDS, now);
    } catch (error) {
      recordFailure('sweep', 'ALERT_SWEEP_FAILED', error);
    }
  }

  return {
    rules,
    apply,
    sweep,
    sweepIfDue(now, force = false) {
      if (!rules.enabled) return false;
      // a clock that stepped back (`now < lastSweepAt`) must not stall the sweep until it catches up
      const due = force || lastSweepAt === null || now < lastSweepAt || now - lastSweepAt >= rules.sweepSeconds * 1000;
      if (!due) return false;
      lastSweepAt = now;
      sweep(now);
      return true;
    },
    onInputs(inputs) {
      try {
        if (!rules.enabled || inputs.length === 0) return;
        const kinds = new Set<AlertRuleKind>();
        for (const input of inputs) {
          kinds.add(INPUT_RULE[input.code]);
        }
        if (kinds.size > 0) run(kinds, clock.now());
      } catch (error) {
        recordFailure('inputs', 'ALERT_INPUTS_FAILED', error);
      }
    },
    resolveDisabled(now = clock.now()) {
      let resolved = 0;
      for (const rule of rules.rules) {
        if (rule.enabled) continue;
        try {
          resolved += withWriteTx(db, scope, (tx) => {
            const open = db.driver
              .prepare<{ id: number }>("SELECT id FROM alerts WHERE rule_id = :kind AND status = 'open' ORDER BY id")
              .all({ kind: rule.kind });
            let count = 0;
            for (const { id } of open)
              if (repo.resolve(scope, tx, id, { at: now, reason: 'rule_disabled' })) count += 1;
            return count;
          });
        } catch (error) {
          recordFailure(rule.kind, 'ALERT_DISABLE_FAILED', error);
        }
      }
      return resolved;
    },
  };
}

// ---- the runtime component ---------------------------------------------------------------------------------------------------

/** The service context of an instance: its health report is the one the scheduler refreshes every 5 s. */
export function alertContextOf(ctx: InstanceContext): AlertServiceContext {
  return {
    db: ctx.db,
    scope: ctx.scope,
    clock: ctx.clock,
    config: ctx.config,
    instanceDir: ctx.instanceDir,
    logger: ctx.logger,
    errors: ctx.errors,
    health: () => ingestHealthEvaluatorOf(ctx).last(),
  };
}

/**
 * The factory the runtime registers (`registeredFactories.createAlertComponents`): one component that, once started, resolves
 * the alerts of disabled rules, listens to the alert inputs of the health refresh and gives the `alerts` job of the schedule its
 * work. Stopping detaches both; an alert already written stays.
 */
export function createAlertComponents(ctx: InstanceContext): readonly RuntimeComponent[] {
  const service = createAlertService(alertContextOf(ctx));
  let unsubscribe: (() => void) | null = null;
  return [
    {
      name: 'alerts',
      start: () => {
        service.resolveDisabled();
        unsubscribe = subscribeAlertInputs(ctx, (inputs) => {
          service.onInputs(inputs);
        });
        bindScheduledJob(ctx, 'alerts', (now, force) => {
          service.sweepIfDue(now, force);
        });
      },
      stop: () => {
        unsubscribe?.();
        unsubscribe = null;
        bindScheduledJob(ctx, 'alerts', () => undefined);
      },
    },
  ];
}
