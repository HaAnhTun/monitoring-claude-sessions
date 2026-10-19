// The alert evaluator (03 10.1, DA-T-AL-5): one pure function per rule kind that turns the facts of the instance into the scopes
// where the rule holds now, each with severity, title and detail. It reads nothing, writes nothing and never looks at the clock:
// the service gathers `AlertFacts` and applies the results (`service.ts`).
//
// Titles are fixed templates with numbers only ("No activity for 47 min"); an error code is the one name a title may carry and it
// is cut to its own alphabet first. Details hold numbers, booleans and short names. Never a label, a prompt, a path or a message.
import type { IngestHealth } from '@mcs/shared';

import type { AlertDetail, AlertSeverity } from '../db/repos/alerts.ts';
import { INSTANCE_SCOPE_KEY, type EffectiveRule } from './rules.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const SECOND_MS = 1000;
const TITLE_MAX = 200;
/** Codes of a failed write that mean the disk is full (the alert inputs of 02 8.3 use the same list). */
const DISK_CODES: ReadonlySet<string> = new Set(['db_full', 'ENOSPC', 'SQLITE_FULL']);
const FULL_SPOOL_CODES: ReadonlySet<string> = new Set(['SPOOL_FULL', 'ENOSPC']);
const CODE_ALPHABET = /^[A-Z][A-Z0-9_]{0,63}$/;
/** An alert whose lag is this many times the warning threshold is critical (03 10.1). */
const LAG_CRITICAL_FACTOR = 10;
/** `inactivity` turns critical at this many times its threshold (03 10.1). */
const INACTIVITY_CRITICAL_FACTOR = 4;
/** `token_threshold` turns critical at this many times its threshold (03 10.1). */
const TOKEN_CRITICAL_FACTOR = 2;

/** A session as the facts name it: the row id for the alert row, the uid for the change row and the scope key. */
export interface SessionRef {
  readonly rowId: number;
  readonly uid: string;
}

/** The newest sign that the monitor was not receiving (the reconciliation of a downtime, or the hook handler's own report). */
export type Downtime =
  | {
      readonly source: 'reconciliation';
      readonly at: number;
      readonly from: number;
      readonly to: number;
      readonly envelopes: number;
    }
  | { readonly source: 'handler'; readonly at: number; readonly count: number };

/** What the rules read. The service fills only what the enabled rules need; the rest stays empty. */
export interface AlertFacts {
  readonly now: number;
  /** The last ingestion health report, or null before the first. */
  readonly health: IngestHealth | null;
  /** `health.importLagWarnMs`. */
  readonly importLagWarnMs: number;
  /** Sessions in an active state with their last activity. */
  readonly activeSessions: readonly (SessionRef & { readonly lastActivityAt: number })[];
  /** Sessions with their token totals, lower bounds: only what the importer has counted (03 10.1 notes, DA-I9). */
  readonly tokenSessions: readonly (SessionRef & { readonly total: number; readonly output: number })[];
  /** `ingest_errors` rows per code within the window of the `ingest_errors` rule. */
  readonly errorCounts: Readonly<Record<string, number>>;
  readonly downtime: Downtime | null;
  /** Free space of the disk that holds the database, in MB; null when unknown. */
  readonly freeDiskMb: number | null;
  /** Size of the database and its WAL, in MB. */
  readonly dbMb: number;
  /** Sessions with partial hook coverage. */
  readonly gaps: readonly (SessionRef & { readonly missingTools: number; readonly missingTurns: number })[];
}

/** The answer of the evaluator for one scope, and the argument of `AlertService.apply` (03 10.2). */
export interface AlertResult {
  readonly holds: boolean;
  readonly severity: AlertSeverity;
  /** The measured number, stored as `alert_state.last_value`. */
  readonly value: number | null;
  readonly title: string;
  readonly detail: AlertDetail;
  /** `sessions.id` of a session scoped alert. */
  readonly sessionId: number | null;
  readonly sessionUid: string | null;
}

export interface ScopedResult {
  readonly scopeKey: string;
  readonly result: AlertResult;
}

function held(
  scopeKey: string,
  severity: AlertSeverity,
  value: number | null,
  title: string,
  detail: AlertDetail,
  session: SessionRef | null = null,
): ScopedResult {
  return {
    scopeKey,
    result: {
      holds: true,
      severity,
      value,
      title: title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) : title,
      detail,
      sessionId: session?.rowId ?? null,
      sessionUid: session?.uid ?? null,
    },
  };
}

/** The result that clears a scope (the service builds it for an open alert that no longer holds). */
export function cleared(sessionId: number | null = null, sessionUid: string | null = null): AlertResult {
  return { holds: false, severity: 'warning', value: null, title: '', detail: {}, sessionId, sessionUid };
}

/** An error code is a name of its own alphabet; anything else (a path, a message) is not allowed into a title. */
export function safeCode(code: string): string {
  return CODE_ALPHABET.test(code) ? code : 'UNKNOWN_CODE';
}

/** 999 -> "999", 1500 -> "1.5k", 2_000_000 -> "2M". */
export function compactNumber(n: number): string {
  const trim = (x: number): string => String(Math.round(x * 10) / 10);
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}G`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// ---- the rules -------------------------------------------------------------------------------------------------------------

type Of<K extends EffectiveRule['kind']> = Extract<EffectiveRule, { kind: K }>;

function inactivity(rule: Of<'inactivity'>, facts: AlertFacts): ScopedResult[] {
  const threshold = rule.minutes * MINUTE_MS;
  const out: ScopedResult[] = [];
  for (const session of facts.activeSessions) {
    const idle = facts.now - session.lastActivityAt;
    if (idle < threshold) continue;
    const minutes = Math.floor(idle / MINUTE_MS);
    const severity = idle >= INACTIVITY_CRITICAL_FACTOR * threshold ? 'critical' : 'warning';
    out.push(
      held(
        session.uid,
        severity,
        minutes,
        `No activity for ${String(minutes)} min`,
        { idleMinutes: minutes, thresholdMinutes: rule.minutes },
        session,
      ),
    );
  }
  return out;
}

function ingestErrors(rule: Of<'ingest_errors'>, facts: AlertFacts): ScopedResult[] {
  const out: ScopedResult[] = [];
  for (const [code, count] of Object.entries(facts.errorCounts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count < rule.count) continue;
    const safe = safeCode(code);
    out.push(
      held(
        code,
        count >= rule.criticalCount ? 'critical' : 'warning',
        count,
        `${String(count)} ${safe} errors in ${String(rule.windowMinutes)} min`,
        { count, windowMinutes: rule.windowMinutes, code: safe },
      ),
    );
  }
  return out;
}

function runtimeUnavailable(rule: Of<'runtime_unavailable'>, facts: AlertFacts): ScopedResult[] {
  const { downtime } = facts;
  if (downtime === null) return [];
  // after `expireHours` the alert does not hold any more and the service resolves it as expired
  if (facts.now - downtime.at >= rule.expireHours * HOUR_MS) return [];
  if (downtime.source === 'handler') {
    return [
      held(
        INSTANCE_SCOPE_KEY,
        'warning',
        downtime.count,
        `Hook handler could not reach the monitor ${String(downtime.count)} ${plural(downtime.count, 'time', 'times')}`,
        { source: 'handler', count: downtime.count },
      ),
    ];
  }
  const minutes = Math.max(0, Math.round((downtime.to - downtime.from) / MINUTE_MS));
  const events = plural(downtime.envelopes, 'event', 'events');
  return [
    held(
      INSTANCE_SCOPE_KEY,
      'warning',
      minutes,
      `Monitor was not running for ${String(minutes)} min while ${String(downtime.envelopes)} hook ${events} arrived`,
      { source: 'reconciliation', minutes, envelopes: downtime.envelopes },
    ),
  ];
}

function tokenThreshold(rule: Of<'token_threshold'>, facts: AlertFacts): ScopedResult[] {
  const threshold = rule.tokens;
  if (threshold === null) return [];
  const out: ScopedResult[] = [];
  for (const session of facts.tokenSessions) {
    const used = rule.field === 'output' ? session.output : session.total;
    if (used < threshold) continue;
    const kind = rule.field === 'output' ? 'output tokens' : 'tokens';
    out.push(
      held(
        session.uid,
        used >= TOKEN_CRITICAL_FACTOR * threshold ? 'critical' : 'warning',
        used,
        `Session used ${compactNumber(used)} ${kind} (threshold ${compactNumber(threshold)})`,
        { tokens: used, threshold, field: rule.field },
        session,
      ),
    );
  }
  return out;
}

function importLag(_rule: Of<'import_lag'>, facts: AlertFacts): ScopedResult[] {
  const transcripts = facts.health?.receiving.transcripts;
  if (transcripts?.status !== 'lagging') return [];
  const seconds = Math.round(transcripts.maxLagMs / SECOND_MS);
  return [
    held(
      INSTANCE_SCOPE_KEY,
      transcripts.maxLagMs > LAG_CRITICAL_FACTOR * facts.importLagWarnMs ? 'critical' : 'warning',
      seconds,
      `Transcript import ${String(seconds)} s behind`,
      { maxLagMs: Math.round(transcripts.maxLagMs), files: transcripts.filesTracked },
    ),
  ];
}

interface DiskCandidate {
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly value: number | null;
}

function dbDisk(rule: Of<'db_disk'>, facts: AlertFacts): ScopedResult[] {
  const candidates: DiskCandidate[] = [];
  let writeFailing = false;
  let spoolFull = false;
  const { health } = facts;
  if (health !== null) {
    const { persisted, receiving } = health;
    const lastCode = persisted.lastError?.code;
    writeFailing =
      persisted.status === 'db_error' ||
      (lastCode !== undefined && DISK_CODES.has(lastCode) && persisted.status !== 'ok');
    spoolFull = receiving.hooks.handlerErrors.some((entry) => FULL_SPOOL_CODES.has(entry.code));
    if (writeFailing) candidates.push({ severity: 'critical', title: 'Database writes are failing', value: null });
    if (spoolFull) candidates.push({ severity: 'critical', title: 'Hook spool is full', value: null });
  }
  const free = facts.freeDiskMb;
  if (free !== null && free < rule.minFreeMb) {
    candidates.push({
      severity: free < rule.minFreeMb / 4 ? 'critical' : 'warning',
      title: `Free disk space ${String(free)} MB`,
      value: free,
    });
  }
  if (facts.dbMb > rule.maxDbMb) {
    candidates.push({ severity: 'warning', title: `Database size ${String(facts.dbMb)} MB`, value: facts.dbMb });
  }
  const worst = candidates.find((candidate) => candidate.severity === 'critical') ?? candidates[0];
  if (worst === undefined) return [];
  return [
    held(INSTANCE_SCOPE_KEY, worst.severity, worst.value, worst.title, {
      freeDiskMb: free,
      dbMb: facts.dbMb,
      minFreeMb: rule.minFreeMb,
      maxDbMb: rule.maxDbMb,
      writeFailing,
      spoolFull,
    }),
  ];
}

function hookGap(_rule: Of<'hook_gap'>, facts: AlertFacts): ScopedResult[] {
  return facts.gaps.map((gap) => {
    const parts: string[] = [];
    if (gap.missingTools > 0) {
      parts.push(`${String(gap.missingTools)} ${plural(gap.missingTools, 'tool call', 'tool calls')}`);
    }
    if (gap.missingTurns > 0) {
      parts.push(`${String(gap.missingTurns)} ${plural(gap.missingTurns, 'turn', 'turns')}`);
    }
    const missed = parts.length === 0 ? 'some events' : parts.join(' and ');
    return held(
      gap.uid,
      'warning',
      gap.missingTools + gap.missingTurns,
      `Hooks missed ${missed} in this session`,
      { missingTools: gap.missingTools, missingTurns: gap.missingTurns },
      gap,
    );
  });
}

function hookFailing(_rule: Of<'hook_failing'>, facts: AlertFacts): ScopedResult[] {
  const hooks = facts.health?.receiving.hooks;
  if (hooks?.status !== 'failing') return [];
  const handlerErrors = hooks.handlerErrors.reduce((sum, entry) => sum + entry.count, 0);
  return [
    held(INSTANCE_SCOPE_KEY, 'warning', handlerErrors + hooks.transcriptHookFailures, 'Hook handler failing', {
      handlerErrors,
      transcriptHookFailures: hooks.transcriptHookFailures,
    }),
  ];
}

/** The scopes where `rule` holds now (a disabled rule holds nowhere). Pure: the same facts give the same answer. */
export function evaluate(rule: EffectiveRule, facts: AlertFacts): ScopedResult[] {
  if (!rule.enabled) return [];
  switch (rule.kind) {
    case 'inactivity':
      return inactivity(rule, facts);
    case 'ingest_errors':
      return ingestErrors(rule, facts);
    case 'runtime_unavailable':
      return runtimeUnavailable(rule, facts);
    case 'token_threshold':
      return tokenThreshold(rule, facts);
    case 'import_lag':
      return importLag(rule, facts);
    case 'db_disk':
      return dbDisk(rule, facts);
    case 'hook_gap':
      return hookGap(rule, facts);
    case 'hook_failing':
      return hookFailing(rule, facts);
  }
}
