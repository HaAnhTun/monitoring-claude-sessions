// The model behind the usage-over-time charts (04 4.4.6, UI-I9): the full bucket axis of a series and the scale of a chart. The
// server omits empty buckets, so the axis is rebuilt here from the bucket size and the window, and an omitted bucket stays a gap.
import type { SeriesPoint, UsageSeries } from '@mcs/shared';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** More buckets than this are not drawn (a bar would be thinner than a pixel); the latest ones stay. */
export const MAX_BUCKETS = 400;

export type SeriesMetric = 'output' | 'input' | 'cacheCreation' | 'cacheRead';

export const SERIES_METRICS: readonly SeriesMetric[] = ['output', 'input', 'cacheCreation', 'cacheRead'];

export function bucketMs(bucket: UsageSeries['bucket']): number {
  return bucket === 'hour' ? HOUR_MS : DAY_MS;
}

export interface Axis {
  /** Epoch milliseconds of the start of the first bucket. */
  startMs: number;
  stepMs: number;
  /** Number of buckets on the axis, gaps included. */
  count: number;
  /** The window had more buckets than `MAX_BUCKETS`; the oldest were cut. */
  clipped: boolean;
  /** The point of each slot, or null where the server sent no bucket (a gap). */
  slots: (SeriesPoint | null)[];
}

/**
 * The slots of the axis. The points are aligned by the server (to the time zone offset it was asked for), so the grid is anchored
 * on the first point and extended to the window on both sides; a bucket the server omitted is a null slot, never a zero.
 */
export function buildAxis(series: UsageSeries, maxBuckets = MAX_BUCKETS): Axis | null {
  const stepMs = bucketMs(series.bucket);
  const starts = series.points.map((point) => Date.parse(point.start));
  if (starts.length === 0 || starts.some((ms) => Number.isNaN(ms))) return null;
  const firstMs = Math.min(...starts);
  const lastMs = Math.max(...starts);
  const fromMs = series.window.from === null ? Number.NaN : Date.parse(series.window.from);
  const toMs = Date.parse(series.window.to);
  const before = Number.isNaN(fromMs) ? 0 : Math.max(0, Math.ceil((firstMs - fromMs) / stepMs));
  const after = Number.isNaN(toMs) ? 0 : Math.max(0, Math.floor((toMs - lastMs) / stepMs));
  const total = before + Math.round((lastMs - firstMs) / stepMs) + 1 + after;
  const count = Math.min(total, maxBuckets);
  const startMs = firstMs - before * stepMs + (total - count) * stepMs;
  const slots: (SeriesPoint | null)[] = Array.from({ length: count }, () => null);
  for (const point of series.points) {
    const index = Math.round((Date.parse(point.start) - startMs) / stepMs);
    if (index >= 0 && index < count) slots[index] = point;
  }
  return { startMs, stepMs, count, clipped: total > count, slots };
}

/** The upper end of a scale: the next 1, 2, 5 or 10 times a power of ten at or above the value. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const unit = value / base;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return step * base;
}

/** The slots to put a label under: the first, the middle and the last (one or two slots when the axis is that short). */
export function tickSlots(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  if (count === 2) return [0, 1];
  return [0, Math.floor((count - 1) / 2), count - 1];
}

/** The slot of the largest value of a metric among the present points, or null when there is none. */
export function peakSlot(slots: readonly (SeriesPoint | null)[], metric: SeriesMetric): number | null {
  let best: number | null = null;
  let bestValue = -1;
  slots.forEach((point, index) => {
    if (point !== null && point[metric] > bestValue) {
      best = index;
      bestValue = point[metric];
    }
  });
  return best;
}
