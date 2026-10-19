// `analytics` section (03 section 6.2 `features.usageTrend`, 04 section 4.4.6).
import { boolKey, sectionSchema } from './section.ts';

export const AnalyticsSectionKeys = {
  // The trend chart of the Analytics page; it gates only the chart, never the analytics routes. On by default since the series
  // route exists (WP-58); a task that does not want the chart sets it to false.
  usageTrend: boolKey(true),
};

export const AnalyticsSectionSchema = sectionSchema(AnalyticsSectionKeys);
