// `health` section: ingestion health thresholds (02 section 8.2, 1.2).
import { intKey, sectionSchema } from './section.ts';

export const HealthSectionKeys = {
  importLagWarnMs: intKey(1000, 3_600_000, 30_000),
  backlogWarnMs: intKey(1000, 3_600_000, 10_000),
};

export const HealthSectionSchema = sectionSchema(HealthSectionKeys);
