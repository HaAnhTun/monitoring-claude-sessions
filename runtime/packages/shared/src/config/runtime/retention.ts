// `retention` section (03 section 3.8, ADR 0028).
import { intKey, nullableIntKey, sectionSchema } from './section.ts';

export const RetentionSectionKeys = {
  changesMaxAgeHours: intKey(1, 720, 24),
  changesMaxRows: intKey(2000, 1_000_000, 20_000),
  ingestErrorsMaxRows: intKey(100, 100_000, 1000),
  resolvedAlertsDays: intKey(1, 3650, 30),
  instanceReconciliationsDays: intKey(1, 3650, 90),
  /** `applyRetention` default for sessions; null = keep. */
  sessionsDays: nullableIntKey(1, 3650),
  /** `applyRetention` default for timeline rows; null = keep. */
  eventsDays: nullableIntKey(1, 3650),
};

export const RetentionSectionSchema = sectionSchema(RetentionSectionKeys);
