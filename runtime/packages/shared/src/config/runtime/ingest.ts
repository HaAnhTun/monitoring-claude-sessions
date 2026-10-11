// `ingest` section: bounds of the writer queue (02 section 4.7, 1.2).
import { MIB, intKey, sectionSchema } from './section.ts';

export const IngestSectionKeys = {
  queueMaxItems: intKey(100, 100_000, 5000),
  queueMaxBytes: intKey(MIB, 512 * MIB, 32 * MIB),
};

export const IngestSectionSchema = sectionSchema(IngestSectionKeys);
