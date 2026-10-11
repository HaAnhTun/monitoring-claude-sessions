// `backup` section (01 section 1.6, 5.5).
import { intKey, sectionSchema } from './section.ts';

export const BackupSectionKeys = {
  /** Automatic pruning of `data/backups`. */
  keep: intKey(1, 100, 5),
};

export const BackupSectionSchema = sectionSchema(BackupSectionKeys);
