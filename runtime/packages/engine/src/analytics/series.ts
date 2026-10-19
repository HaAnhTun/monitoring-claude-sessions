// `series` (03 8.2, 12.1): token usage over time in hour or day buckets.
//
//  - `bucketStart = floor((ts + off) / size) * size - off`, `off = tzOffsetMinutes * 60000`. The offset is fixed for the whole
//    range: a daylight saving change inside it shifts the day boundaries by one hour (documented, not corrected);
//  - an empty bucket is absent (a gap, never a zero bar); the buckets add up to the totals of the same filter;
//  - a bucket is `partial` when it holds a message that never got its final record;
//  - more than 2000 buckets in the range are refused (`range_too_large`).
import type { SeriesPoint, SeriesQuery, UsageSeries } from '@mcs/shared';
import { isoMsZ } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { QueryRefusal, resolveWindow, snapshot } from '../query/transitions.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { aggregateGroups, usageFilterSql, type UsageGroup } from '../tokens/aggregate.ts';
import { reportWindow, resolveUsageScope, usageFilterOf } from './usage.ts';

export interface SeriesQueries {
  series(ctx: RepoContext, q: SeriesQuery): UsageSeries;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The most buckets one request may span (03 8.2). */
export const MAX_BUCKETS = 2000;
const DEFAULT_RANGE = '7d';

/** The start of the bucket that holds `ts` (a floor that also holds for a time before the shifted epoch). */
export function bucketStart(ts: number, sizeMs: number, offsetMs: number): number {
  const shifted = ts + offsetMs;
  return shifted - (((shifted % sizeMs) + sizeMs) % sizeMs) - offsetMs;
}

/** How many buckets the half-open range `[fromMs, toMs)` touches. */
export function bucketSpan(fromMs: number, toMs: number, sizeMs: number, offsetMs: number): number {
  if (toMs <= fromMs) return 0;
  return Math.round((bucketStart(toMs - 1, sizeMs, offsetMs) - bucketStart(fromMs, sizeMs, offsetMs)) / sizeMs) + 1;
}

function pointOf(group: UsageGroup): SeriesPoint {
  const { agg } = group;
  return {
    start: isoMsZ(Number(group.key)),
    input: agg.sum.input,
    output: agg.sum.output,
    cacheCreation: agg.sum.cacheCreation,
    cacheRead: agg.sum.cacheRead,
    messages: agg.messages,
    completeness: agg.unfinalized > 0 ? 'partial' : 'complete',
  };
}

export function createSeriesQueries(db: InstanceDb, deps: QueryDeps): SeriesQueries {
  return {
    series: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq): UsageSeries => {
        const window = resolveWindow(deps, q, DEFAULT_RANGE, null);
        const sizeMs = q.bucket === 'hour' ? HOUR_MS : DAY_MS;
        const offsetMs = q.tzOffsetMinutes * MINUTE_MS;
        const scope = resolveUsageScope(db, q);
        const filter = usageFilterOf(window, scope);

        // the span of the range: `all` starts at the first message the filter selects
        let fromMs = window.fromMs;
        if (fromMs === null) {
          const sql = usageFilterSql(filter);
          fromMs =
            db.driver
              .prepare<{ first: number | null }>(`SELECT min(ts) AS first FROM ${sql.from} WHERE ${sql.where}`)
              .get(sql.params)?.first ?? null;
        }
        const answer = (points: SeriesPoint[], series: UsageSeries['series']): UsageSeries => ({
          asOfSeq,
          bucket: q.bucket,
          tzOffsetMinutes: q.tzOffsetMinutes,
          window: reportWindow(window, deps.now()),
          points,
          series,
        });
        if (fromMs === null) return answer([], q.groupBy === 'model' ? [] : null);
        if (bucketSpan(fromMs, window.toMs, sizeMs, offsetMs) > MAX_BUCKETS) throw new QueryRefusal('range_too_large');

        const total = aggregateGroups(db, ctx, filter, { by: 'bucket', sizeMs, offsetMs }).map(pointOf);
        if (q.groupBy !== 'model') return answer(total, null);

        const byModel = new Map<string, SeriesPoint[]>();
        for (const group of aggregateGroups(db, ctx, filter, { by: 'bucket', sizeMs, offsetMs, model: true })) {
          const model = group.model ?? '';
          const list = byModel.get(model);
          if (list === undefined) byModel.set(model, [pointOf(group)]);
          else list.push(pointOf(group));
        }
        const series = [...byModel.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, points]) => ({ key, label: key, points }));
        return answer(total, series);
      }),
  };
}
