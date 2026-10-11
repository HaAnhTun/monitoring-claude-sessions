// Arguments and environment for a `claude` process started by monitor tooling (02 2.9, registry 2.4). Such a session must
// never be observed by this monitor's own hooks, or the monitor would feed on itself: every `claude` launched by server
// features or tests goes through `claudeArgsWithoutHooks`. This module only builds the pieces; it starts nothing.

/** The `--settings` value that turns every hook of the child session off. */
export const DISABLE_ALL_HOOKS_SETTINGS = '{"disableAllHooks":true}';

export interface ClaudeLaunch {
  /** `--settings <json>` followed by the caller's arguments. */
  args: string[];
  /** Variables to merge over the child environment; hook processes inherit them, so grandchildren are covered. */
  env: Record<string, string>;
}

/**
 * Arguments for a `claude` child that must not be observed: our `--settings` first, then `args` unchanged. `env` carries
 * `MCS_HOOK_DISABLE=1`, the switch every hook handler checks before it does anything (02 2.2 step 2). Calling it on its
 * own output returns the same arguments.
 */
export function claudeArgsWithoutHooks(args: readonly string[]): ClaudeLaunch {
  const alreadyDisabled = args[0] === '--settings' && args[1] === DISABLE_ALL_HOOKS_SETTINGS;
  return {
    args: alreadyDisabled ? [...args] : ['--settings', DISABLE_ALL_HOOKS_SETTINGS, ...args],
    env: { MCS_HOOK_DISABLE: '1' },
  };
}
