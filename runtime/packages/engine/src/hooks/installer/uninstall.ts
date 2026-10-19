// `hooks uninstall` (02 3.1, ADR 0070 item 4): removes every handler that carries our marker from one settings file, with the
// same guard, mutex, backup, verification and restore as an install (`apply.ts` runs both). It also takes the settings file out
// of the install manifest, and deletes the stable copy of the hook script when no install is left. A dry run (no `yes`) writes
// nothing.
import { runHooksChange, type HooksOutcome, type UninstallHooksInput } from './apply.ts';

export type { UninstallHooksInput };

/** Removes our entries from the settings file (`removed` in the result); the result's `script` says what happened to the copy. */
export function uninstallHooks(input: UninstallHooksInput): Promise<HooksOutcome> {
  return runHooksChange('uninstall', input, null);
}
