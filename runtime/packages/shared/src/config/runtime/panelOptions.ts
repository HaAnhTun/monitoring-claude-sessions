// `panelOptions` section (06 section 3.5 key table, 3.10.3). The name keeps both keys away from the legacy L keys
// `attempts` and `panels`; the owner in `R_KEY_CATALOGUE` is '06'.
import { intKey, sectionSchema } from './section.ts';

export const PanelOptionsSectionKeys = {
  /** Attempts matching window and `runsToMatch` cut-off (06 3.10.3 step 7; D6). */
  attemptsWindowHours: intKey(1, 8760, 24),
  /** Processes source TTL (06 3.7.3). */
  machineProcessIntervalMs: intKey(10_000, 300_000, 20_000),
};

export const PanelOptionsSectionSchema = sectionSchema(PanelOptionsSectionKeys);
