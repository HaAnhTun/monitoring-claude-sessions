// The alert inputs of 02 8.3, produced for the alerts service (WP-59, 03 10.2). They are evaluated after the commit, by the
// health refresh of the DB scheduler, and never inside the ingest path. Each condition has a stable id and a change key; an input
// is delivered when its condition begins or its change key moves, and not again while it stays the same (T-HE-07).
import type { IngestHealth } from '@mcs/shared';

const TEN_MINUTES_MS = 600_000;
// The number of errors of one code within 10 minutes from which `ingest_errors_repeated` fires (02 8.3).
const REPEATED_ERRORS = 10;
const DISK_CODES: ReadonlySet<string> = new Set(['db_full', 'ENOSPC', 'SQLITE_FULL']);

export type AlertInputCode =
  | 'no_activity'
  | 'ingest_errors_repeated'
  | 'runtime_unavailable'
  | 'import_lag'
  | 'hook_gap'
  | 'hook_failing'
  | 'db_error'
  | 'disk';

/** A payload holds numbers, short names and lists of ids; never a path, a prompt or a message (02 8.3). */
export type AlertPayload = Readonly<Record<string, string | number | readonly string[]>>;

export interface AlertInput {
  readonly code: AlertInputCode;
  /** The identity of the condition (one per session or per error code where the input is per entity). */
  readonly key: string;
  readonly payload: AlertPayload;
}

/** What the evaluation reads: the report and the few facts that the report does not carry. */
export interface AlertInputSnapshot {
  readonly report: IngestHealth;
  /** Sessions in a working state now (at most 50). */
  readonly workingSessionUids: readonly string[];
  /** `ingest_errors` of the last 10 minutes by code. */
  readonly errorsByCode10min: Readonly<Record<string, number>>;
  /** The newest `runtime_unavailable` reconciliation of the last hour. */
  readonly downtime: { readonly from: number; readonly to: number; readonly envelopes: number } | null;
  /** Sessions with partial hook coverage. */
  readonly gaps: readonly {
    readonly sessionId: string;
    readonly missingTools: number;
    readonly missingTurns: number;
  }[];
  /** The quiet time from which a silent provider counts as `no_activity`. */
  readonly noActivityMs: number;
}

interface Condition {
  readonly input: AlertInput;
  /** Changes when the condition changed in a way that warrants a new alert input. */
  readonly changeKey: string;
}

/** Every condition that holds now (pure). */
export function activeAlertConditions(s: AlertInputSnapshot): AlertInput[] {
  return conditionsOf(s).map((condition) => condition.input);
}

function conditionsOf(s: AlertInputSnapshot): Condition[] {
  const { report } = s;
  const out: Condition[] = [];
  const add = (code: AlertInputCode, key: string, changeKey: string, payload: AlertPayload): void => {
    out.push({ input: { code, key, payload }, changeKey });
  };

  const { provider } = report;
  if (provider.status === 'silent' && provider.lastActivityAt !== null && s.workingSessionUids.length > 0) {
    const quietMs = report.evaluatedAt - provider.lastActivityAt;
    if (quietMs >= s.noActivityMs) {
      const sessionIds = [...s.workingSessionUids].sort();
      add('no_activity', 'no_activity', sessionIds.join(','), { sessionIds, quietMs });
    }
  }

  for (const [code, count] of Object.entries(s.errorsByCode10min).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count >= REPEATED_ERRORS) {
      add('ingest_errors_repeated', `ingest_errors_repeated:${code}`, 'on', { code, count, windowMs: TEN_MINUTES_MS });
    }
  }

  const { hooks, transcripts } = report.receiving;
  if (s.downtime !== null) {
    const { from, to, envelopes } = s.downtime;
    add('runtime_unavailable', `runtime_unavailable:${String(from)}-${String(to)}`, 'on', { from, to, envelopes });
  }
  const unavailable = hooks.handlerErrors.find((entry) => entry.code === 'HANDLER_UNAVAILABLE');
  if (unavailable !== undefined) {
    add('runtime_unavailable', 'runtime_unavailable:handler', 'on', {
      from: unavailable.lastAt,
      to: unavailable.lastAt,
      envelopes: 0,
    });
  }

  if (transcripts.status === 'lagging') {
    add('import_lag', 'import_lag', 'on', { maxLagMs: transcripts.maxLagMs, files: transcripts.filesTracked });
  }

  for (const gap of s.gaps) {
    add('hook_gap', `hook_gap:${gap.sessionId}`, `${String(gap.missingTools)}/${String(gap.missingTurns)}`, {
      sessionId: gap.sessionId,
      missingTools: gap.missingTools,
      missingTurns: gap.missingTurns,
    });
  }

  if (hooks.transcriptHookFailures > 0) {
    add('hook_failing', 'hook_failing', String(hooks.transcriptHookFailures), {
      count: hooks.transcriptHookFailures,
      lastAt: report.evaluatedAt,
    });
  }

  const { persisted } = report;
  if (persisted.status === 'db_error' && persisted.lastError !== null) {
    add('db_error', 'db_error', persisted.lastError.code, { errorCode: persisted.lastError.code, where: 'persisted' });
    if (DISK_CODES.has(persisted.lastError.code)) {
      add('disk', 'disk:persisted', persisted.lastError.code, {
        errorCode: persisted.lastError.code,
        where: 'persisted',
      });
    }
  }
  if (hooks.handlerErrors.some((entry) => entry.code === 'SPOOL_FULL')) {
    add('disk', 'disk:spool', 'on', { errorCode: 'SPOOL_FULL', where: 'spool' });
  }
  return out;
}

export interface AlertInputTracker {
  /** The inputs whose condition began or changed since the previous call; a condition that is gone is forgotten. */
  evaluate(snapshot: AlertInputSnapshot): AlertInput[];
}

export function createAlertInputTracker(): AlertInputTracker {
  let known = new Map<string, string>();
  return {
    evaluate(snapshot) {
      const fired: AlertInput[] = [];
      const next = new Map<string, string>();
      for (const { input, changeKey } of conditionsOf(snapshot)) {
        next.set(input.key, changeKey);
        if (known.get(input.key) !== changeKey) fired.push(input);
      }
      known = next;
      return fired;
    },
  };
}

// ---- delivery -------------------------------------------------------------------------------------------------------------------

export type AlertInputListener = (inputs: readonly AlertInput[]) => void;

const listeners = new WeakMap<object, Set<AlertInputListener>>();

/** The alerts service subscribes to the inputs of one runtime (`target` is its instance context). Returns the unsubscribe function. */
export function subscribeAlertInputs(target: object, listener: AlertInputListener): () => void {
  let set = listeners.get(target);
  if (set === undefined) {
    set = new Set();
    listeners.set(target, set);
  }
  set.add(listener);
  const owner = set;
  return () => {
    owner.delete(listener);
  };
}

/** Delivers `inputs` to the subscribers; one that throws never stops the others. An empty list is not delivered. */
export function emitAlertInputs(target: object, inputs: readonly AlertInput[]): void {
  if (inputs.length === 0) return;
  for (const listener of [...(listeners.get(target) ?? [])]) {
    try {
      listener(inputs);
    } catch {
      // a failing subscriber must not take the health refresh down with it
    }
  }
}
