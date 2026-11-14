// `app` section: how the workspace presents itself (CAW design 06 1.6). The section is `app` and never `ui`: `ui` would
// collide with the keys that the runtime configuration already reserves for the web page.
import { z } from 'zod';

import { type KeySpec, boolKey, sectionSchema } from './section.ts';

const name: KeySpec<z.ZodString> = {
  /** Shown in the page header and title, and reported as `app.name` of the instance information. */
  schema: z
    .string()
    .min(1)
    .max(80)
    // printable characters only (no C0, DEL or C1 control, written as the allowed ranges)
    .regex(/^[\u0020-\u007e\u00a1-\uffff]+$/),
  default: 'Claude Agent Workspace',
};

export const AppSectionKeys = {
  name,
  /** true: `start` and `open` use an Edge or Chrome app window; false: a tab of the default browser. */
  openAppWindow: boolKey(false),
};

export const AppSectionSchema = sectionSchema(AppSectionKeys);
export type AppSection = z.output<typeof AppSectionSchema>;
