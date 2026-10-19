// The cost estimate (03 8.3, D15): configured prices only. No price ships; without `pricing.models` there is no estimate at
// all (`null`, never 0). The estimate is always labelled `estimate` with a note, and the cost the provider reports
// (`cost_states`) is a separate figure that is never added to it.
//
// The only SQL of the estimate is the grouping of the instance values of `usage` by (model, UTC day) and, for the rows of a
// report, by session or agent as well; the prices are applied in TypeScript. Synthetic messages are never priced.
import type { CostEstimate, CostSummary, PricingModel } from '@mcs/shared';

import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { usageFilterSql, type UsageFilter } from '../tokens/aggregate.ts';

/** The note of every cost summary (03 8.3). */
export const COST_NOTE = 'Estimate from prices configured in runtime.json; not a bill.';
/** The label of the cost the provider reports (02 6.6). */
export const REPORTED_COST_LABEL =
  'Reported by Claude Code (cumulative per process, may include calls not in transcripts; not a bill)';

// ---- the price of a model on a day ----------------------------------------------------------------------------------------------

/** Does `match` (a model id, or a glob where `*` stands for any text) select `model`? Comparison is case-sensitive. */
export function matchesModel(match: string, model: string): boolean {
  if (!match.includes('*')) return match === model;
  const parts = match.split('*');
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!model.startsWith(first) || !model.endsWith(last) || model.length < first.length + last.length) return false;
  let at = first.length;
  const limit = model.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = model.indexOf(part, at);
    if (found < 0 || found + part.length > limit) return false;
    at = found + part.length;
  }
  return true;
}

/** How many characters of a glob are literal (the specificity of a match). */
export function literalLength(match: string): number {
  return match.replaceAll('*', '').length;
}

/**
 * The entry that prices `model` on the UTC day `day` (`YYYY-MM-DD`), or `undefined` (unpriced). Entries that are not in force
 * yet (`effectiveFrom` after the day) are ignored. Among the others an exact id beats a glob, a glob with more literal
 * characters beats one with fewer, then the latest `effectiveFrom` wins, and a remaining tie goes to the first entry in file
 * order. A `Date`-free comparison: `effectiveFrom` and `day` are ISO dates, so text order is date order.
 */
export function resolvePrice(entries: readonly PricingModel[], model: string, day: string): PricingModel | undefined {
  let best: PricingModel | undefined;
  let bestRank = -1;
  for (const entry of entries) {
    if (entry.effectiveFrom > day || !matchesModel(entry.match, model)) continue;
    // an exact id outranks every glob, whatever the glob's length
    const rank = entry.match.includes('*') ? literalLength(entry.match) : Number.MAX_SAFE_INTEGER;
    const better =
      best === undefined || rank > bestRank || (rank === bestRank && entry.effectiveFrom > best.effectiveFrom);
    if (better) {
      best = entry;
      bestRank = rank;
    }
  }
  return best;
}

// ---- pricing one group ------------------------------------------------------------------------------------------------------------

/** The sums of the non-synthetic messages of one (model, day), the split of the cache writes already resolved (see `costRows`). */
export interface CostGroup {
  readonly model: string;
  /** UTC day of the messages, `YYYY-MM-DD`. */
  readonly day: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Cache writes priced at the 5 minute tier: the 5m split, plus every write whose split is missing. */
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  /** Messages whose cache writes had no 5m/1h split (priced at the 5m tier). */
  readonly assumedTierMessages: number;
}

function tokensOf(group: CostGroup): number {
  return group.input + group.output + group.cacheRead + group.cacheWrite5m + group.cacheWrite1h;
}

/** `(input x in + output x out + cache read x read + 5m x w5 + 1h x w1) / 1e6`. */
export function priceOf(price: PricingModel, group: CostGroup): number {
  return (
    (group.input * price.inputPerMTok +
      group.output * price.outputPerMTok +
      group.cacheRead * price.cacheReadPerMTok +
      group.cacheWrite5m * price.cacheWrite5mPerMTok +
      group.cacheWrite1h * price.cacheWrite1hPerMTok) /
    1e6
  );
}

export interface CostTotals {
  readonly amount: number;
  readonly pricedTokens: number;
  readonly totalTokens: number;
  readonly pricedModels: string[];
  readonly unpricedModels: string[];
  readonly assumedCacheWriteTier: boolean;
}

/** Prices the groups. A group without any token needs no price and is ignored; a model without a price on a day is unpriced. */
export function priceGroups(entries: readonly PricingModel[], groups: readonly CostGroup[]): CostTotals {
  let amount = 0;
  let pricedTokens = 0;
  let totalTokens = 0;
  let assumed = false;
  const priced = new Set<string>();
  const unpriced = new Set<string>();
  for (const group of groups) {
    const tokens = tokensOf(group);
    if (tokens === 0) continue;
    totalTokens += tokens;
    const price = resolvePrice(entries, group.model, group.day);
    if (price === undefined) {
      unpriced.add(group.model);
      continue;
    }
    priced.add(group.model);
    pricedTokens += tokens;
    amount += priceOf(price, group);
    if (group.assumedTierMessages > 0) assumed = true;
  }
  return {
    amount,
    pricedTokens,
    totalTokens,
    pricedModels: [...priced].sort(),
    unpricedModels: [...unpriced].sort(),
    assumedCacheWriteTier: assumed,
  };
}

function pricedPercent(totals: CostTotals): number {
  return totals.totalTokens === 0 ? 0 : (100 * totals.pricedTokens) / totals.totalTokens;
}

/**
 * The summary of a report, or `null` when no price is configured or no token was counted ("missing is never zero": an estimate
 * of nothing is no estimate).
 */
export function summarizeCost(
  entries: readonly PricingModel[],
  currency: string,
  groups: readonly CostGroup[],
): CostSummary | null {
  if (entries.length === 0) return null;
  const totals = priceGroups(entries, groups);
  if (totals.totalTokens === 0) return null;
  return {
    currency,
    basis: 'estimate',
    source: 'configured_prices',
    amount: totals.amount,
    pricedTokensPct: pricedPercent(totals),
    pricedModels: totals.pricedModels,
    unpricedModels: totals.unpricedModels,
    assumedCacheWriteTier: totals.assumedCacheWriteTier,
    note: COST_NOTE,
  };
}

/** The estimate of one row of a report (`UsageRow.cost`), `null` under the same conditions as the summary. */
export function estimateCost(
  entries: readonly PricingModel[],
  currency: string,
  groups: readonly CostGroup[],
): CostEstimate | null {
  if (entries.length === 0) return null;
  const totals = priceGroups(entries, groups);
  if (totals.totalTokens === 0) return null;
  return {
    amount: totals.amount,
    currency,
    basis: 'estimate',
    pricedTokensPct: pricedPercent(totals),
    unpricedModels: totals.unpricedModels,
  };
}

// ---- reading the groups -----------------------------------------------------------------------------------------------------------

/** The groups of one owner (a session or an agent) or of the whole selection (`owner` is `null`). */
export interface OwnedCostGroup extends CostGroup {
  readonly owner: number | null;
}

interface CostDbRow {
  owner: number | null;
  model: string;
  day: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  write5m: number | null;
  write1h: number | null;
  assumed: number | null;
}

/**
 * The (model, day) sums of the non-synthetic messages the filter selects, split by `by` when it is `session` or `agent`.
 *
 * The cache writes of a message are its known 5m and 1h split; a write the split does not account for (no split at all, or a
 * total larger than the two parts) goes to the 5m tier and counts the message in `assumedTierMessages` (03 8.3 rule 3).
 * A message with a missing field adds nothing for that field.
 */
export function costRows(
  db: InstanceDb,
  ctx: RepoContext,
  filter: UsageFilter,
  by: 'none' | 'session' | 'agent',
): OwnedCostGroup[] {
  db.assertScope(ctx);
  const sql = usageFilterSql(filter);
  const owner = by === 'session' ? 'session_id' : by === 'agent' ? 'agent_id' : 'NULL';
  const known = 'coalesce(cache_creation_5m_tokens, 0) + coalesce(cache_creation_1h_tokens, 0)';
  const rest = `max(0, coalesce(cache_creation_tokens, 0) - (${known}))`;
  const params: SqlValue[] = [...sql.params];
  const rows = db.driver
    .prepare<CostDbRow>(
      `SELECT ${owner} AS owner, model, strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
              sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cacheRead,
              sum(coalesce(cache_creation_5m_tokens, 0) + ${rest}) AS write5m,
              sum(coalesce(cache_creation_1h_tokens, 0)) AS write1h,
              sum(CASE WHEN ${rest} > 0 THEN 1 ELSE 0 END) AS assumed
         FROM ${sql.from} WHERE ${sql.where} AND synthetic = 0
        GROUP BY owner, model, day ORDER BY owner, model, day`,
    )
    .all(params);
  return rows.map((row) => ({
    owner: row.owner,
    model: row.model,
    day: row.day,
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheRead: row.cacheRead ?? 0,
    cacheWrite5m: row.write5m ?? 0,
    cacheWrite1h: row.write1h ?? 0,
    assumedTierMessages: row.assumed ?? 0,
  }));
}

// ---- the cost the provider reports ------------------------------------------------------------------------------------------------

export interface ReportedCost {
  /** The sum over the sessions that have a report; `null` when none has one. */
  readonly amountUsd: number | null;
  readonly sessionsWithReport: number;
  readonly sessionsInScope: number;
}

interface ReportedDbRow {
  inScope: number;
  withReport: number;
  amount: number | null;
}

/**
 * The latest `cost_states` value of every session that `where` selects (a condition over `sessions s`, with its named
 * `params`), summed (02 6.6); `amountUsd` is `null` when no selected session has one. It is cumulative per process and is
 * never added to the transcript tokens or to the estimate.
 */
export function reportedCost(db: InstanceDb, where: string, params: Readonly<Record<string, SqlValue>>): ReportedCost {
  const row = db.driver
    .prepare<ReportedDbRow>(
      `SELECT count(*) AS inScope, coalesce(sum(CASE WHEN r.amount IS NULL THEN 0 ELSE 1 END), 0) AS withReport,
              sum(r.amount) AS amount
         FROM sessions s
         LEFT JOIN (
           SELECT c.session_id AS sid, c.total_cost_usd AS amount FROM cost_states c
            WHERE c.total_cost_usd IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM cost_states d
                 WHERE d.session_id = c.session_id AND d.total_cost_usd IS NOT NULL
                   AND (d.observed_at > c.observed_at OR (d.observed_at = c.observed_at AND d.file_id > c.file_id)))
         ) r ON r.sid = s.id
        WHERE ${where}`,
    )
    .get(params);
  const withReport = row?.withReport ?? 0;
  return {
    amountUsd: withReport === 0 ? null : (row?.amount ?? null),
    sessionsWithReport: withReport,
    sessionsInScope: row?.inScope ?? 0,
  };
}
