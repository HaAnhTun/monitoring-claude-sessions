// `spool` section: hook spool drain (02 section 2.7, 1.2).
import { intKey, sectionSchema } from './section.ts';

export const SpoolSectionKeys = {
  pollMs: intKey(100, 10_000, 500),
  sealGraceMs: intKey(10_000, 3_600_000, 120_000),
  retainHours: intKey(1, 720, 24),
};

export const SpoolSectionSchema = sectionSchema(SpoolSectionKeys);
