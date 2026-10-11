// `hooks` section (02 section 2.6.2, 1.2).
import { intKey, sectionSchema } from './section.ts';

export const HooksSectionKeys = {
  /** Hours the hook handler keeps spooling after the instance stopped; 0 = stop spooling at once. */
  spoolWhileStoppedHours: intKey(0, 720, 72),
};

export const HooksSectionSchema = sectionSchema(HooksSectionKeys);
