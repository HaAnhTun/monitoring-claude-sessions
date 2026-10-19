// Statistics and budget verdicts of the benchmarks (design 06 section 8.1). Pure functions, no I/O, so the tests can feed
// synthetic figures. Every figure a verdict uses comes from a timer or from `HealthReport`; the only constants here are the
// limits of the budget table itself.

/** The limits of design 06 section 8.1, for the budgets this harness measures. */
export const LIMITS = Object.freeze({
  B4: { wallMs: 8000, eventLoopP99Ms: 50, rssGrowthBytes: 200 * 1024 * 1024 },
  B5: { idleP95Ms: 50, duringImportP95Ms: 250 },
  B6: { startToHealthyMs: 3000 },
});

/** Every budget id of the table; the ones no script of this harness measures stay NOT MEASURED. */
export const BUDGET_IDS = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);

/** The host class of the budget table: Windows 11, 12 logical CPUs, Node 24. */
export const REFERENCE_HOST = Object.freeze({ platform: 'win32', minCpus: 12, nodeMajor: 24 });

function sorted(samples) {
  const numbers = samples.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.toSorted((a, b) => a - b);
}

/** Nearest-rank percentile (`p` in 0..100) of the finite numbers in `samples`; null for no samples. */
export function percentile(samples, p) {
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile: ${String(p)} is not between 0 and 100`);
  const values = sorted(samples);
  if (values.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * values.length));
  return values[rank - 1];
}

/** Median: the middle value, or the mean of the two middle values; null for no samples. */
export function median(samples) {
  const values = sorted(samples);
  if (values.length === 0) return null;
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

export function p95(samples) {
  return percentile(samples, 95);
}

export function maximum(samples) {
  const values = sorted(samples);
  return values.length === 0 ? null : values[values.length - 1];
}

/** `{ n, min, mean, p50, p95, p99, max }` of the samples (all null but `n` for none). */
export function summarizeSamples(samples) {
  const values = sorted(samples);
  if (values.length === 0) return { n: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    n: values.length,
    min: values[0],
    mean: sum / values.length,
    p50: median(values),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values[values.length - 1],
  };
}

/** Rounds to `digits` decimals for the JSON output (figures stay numbers). */
export function round(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * One check of a budget: a measured `figure` against a `limit` (the figure must not exceed it). A missing figure
 * (null, undefined, NaN) is "not measured", never a pass.
 */
export function check(name, figure, limit, unit) {
  const measured = typeof figure === 'number' && Number.isFinite(figure);
  return { name, figure: measured ? round(figure, 2) : null, limit, unit, ok: measured ? figure <= limit : null };
}

/**
 * The verdict row of one budget from its checks: FAIL when any check failed (the failing figure stays in the row), NOT MEASURED
 * when there is no check or a check has no figure, PASS otherwise. `note` explains a missing precondition.
 */
export function judge(id, checks, note = null) {
  let status = 'PASS';
  if (checks.some((c) => c.ok === false)) status = 'FAIL';
  else if (checks.length === 0 || checks.some((c) => c.ok === null)) status = 'NOT MEASURED';
  return { id, status, checks, note };
}

/** A NOT MEASURED row with the reason. */
export function notMeasured(id, note) {
  return { id, status: 'NOT MEASURED', checks: [], note };
}

/**
 * B4 from the runs of `bench-first-import`: `{ wallMs, eventLoopP99MaxMs, rssPeakBytes, rssIdleBytes }` each. The worst run
 * decides; the script reports the medians next to the runs.
 */
export function evaluateB4(runs) {
  if (runs.length === 0) return notMeasured('B4', 'no run completed');
  const worst = (key) => maximum(runs.map((run) => run[key]));
  const growth = maximum(
    runs.map((run) =>
      typeof run.rssPeakBytes === 'number' && typeof run.rssIdleBytes === 'number'
        ? run.rssPeakBytes - run.rssIdleBytes
        : null,
    ),
  );
  return judge('B4', [
    check('wall to complete import (worst run)', worst('wallMs'), LIMITS.B4.wallMs, 'ms'),
    check('event-loop delay p99 (worst run)', worst('eventLoopP99MaxMs'), LIMITS.B4.eventLoopP99Ms, 'ms'),
    check('RSS peak above idle (worst run)', growth, LIMITS.B4.rssGrowthBytes, 'bytes'),
  ]);
}

/**
 * B5 from `bench-api`. `idle` maps an endpoint name to `{ p95, n }` (p95 null when the endpoint was not measured, for
 * instance a panel that answered 404); `during` is `{ all: { p95 }, note }`. The idle phase needs the sessions page, the
 * transcript page and at least one panel (name `panel:<key>`); a missing one makes the row NOT MEASURED unless another
 * endpoint already failed.
 */
export function evaluateB5({ idle, during, requiredIdle = ['sessions', 'transcript'], panelPrefix = 'panel:' }) {
  const checks = [];
  const notes = [];
  for (const [name, entry] of Object.entries(idle)) {
    if (entry.p95 === null || entry.p95 === undefined) continue;
    checks.push(check(`idle p95 ${name}`, entry.p95, LIMITS.B5.idleP95Ms, 'ms'));
  }
  for (const name of requiredIdle) {
    if (idle[name]?.p95 === null || idle[name]?.p95 === undefined) {
      checks.push(check(`idle p95 ${name}`, null, LIMITS.B5.idleP95Ms, 'ms'));
      notes.push(`${name} was not measured`);
    }
  }
  if (!Object.entries(idle).some(([name, entry]) => name.startsWith(panelPrefix) && typeof entry.p95 === 'number')) {
    checks.push(check('idle p95 panels', null, LIMITS.B5.idleP95Ms, 'ms'));
    notes.push('no panel answered 200 (panels route missing or every panel disabled)');
  }
  const duringP95 = during?.all?.p95;
  checks.push(check('p95 during first import (all endpoints)', duringP95, LIMITS.B5.duringImportP95Ms, 'ms'));
  if (typeof duringP95 !== 'number') notes.push(during?.note ?? 'no request completed while the import ran');
  return judge('B5', checks, notes.length === 0 ? null : notes.join('; '));
}

/** B6 from the timed starts (`startToHealthyMs` per run). The worst start decides. */
export function evaluateB6(startToHealthyMs) {
  if (startToHealthyMs.length === 0) return notMeasured('B6', 'no start completed');
  return judge('B6', [
    check('start to healthy (worst run)', maximum(startToHealthyMs), LIMITS.B6.startToHealthyMs, 'ms'),
  ]);
}

/** True when the host is the class of the budget table (`host` is `{ platform, cpus, node }` of a result). */
export function isReferenceHost(host) {
  const major = Number.parseInt(String(host.node).split('.')[0], 10);
  return (
    host.platform === REFERENCE_HOST.platform &&
    host.cpus >= REFERENCE_HOST.minCpus &&
    major === REFERENCE_HOST.nodeMajor
  );
}

const NOT_IN_HARNESS = 'measured by the long-running benchmarks (WP-109), not by this harness';

/**
 * The summary of a run: one row per budget B1..B7 (rows not supplied are NOT MEASURED), the host class and the exit code.
 * On a host that is not the class of the budget table the figures are printed and a FAIL is marked as a deviation: the
 * budgets are not asserted there (`asserted: false`, exit code 0). `ids` narrows the table to the budgets of one script.
 */
export function summarize(rows, host, ids = BUDGET_IDS) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const all = ids.map((id) => byId.get(id) ?? notMeasured(id, NOT_IN_HARNESS));
  const asserted = isReferenceHost(host);
  const failed = all.filter((row) => row.status === 'FAIL').map((row) => row.id);
  return {
    host,
    asserted,
    rows: all,
    failed,
    deviations: asserted ? [] : failed,
    exitCode: asserted && failed.length > 0 ? 1 : 0,
  };
}

/** The printable lines of a row: `B4 FAIL` followed by one indented line per check. */
export function describeRow(row) {
  const lines = row.checks.map((c) =>
    c.figure === null
      ? `${c.name}: not measured`
      : `${c.name}: ${String(c.figure)} ${c.unit} (limit ${String(c.limit)})${c.ok ? '' : ' EXCEEDED'}`,
  );
  const note = row.note === null || row.note === undefined ? '' : ` [${row.note}]`;
  return `${row.id} ${row.status}${note}${lines.length === 0 ? '' : `\n  ${lines.join('\n  ')}`}`;
}
