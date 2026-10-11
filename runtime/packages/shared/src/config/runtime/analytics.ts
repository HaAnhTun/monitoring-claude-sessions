// `analytics` section (03 section 6.2 `features.usageTrend`, 04 section 4.4.6).
import { boolKey, sectionSchema } from './section.ts';

export const AnalyticsSectionKeys = {
  usageTrend: boolKey(false),
};

export const AnalyticsSectionSchema = sectionSchema(AnalyticsSectionKeys);
