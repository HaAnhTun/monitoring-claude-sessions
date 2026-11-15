// Where the user-wide instance lives (06 1.2). This is the only module that names its folders: the slug, the reserved root
// below the per-user folder, the default port and the browser profile. The per-user folder keeps its default name `mcs`
// (an environment variable can still relocate it); nothing here moves or migrates it (ADR 0091).
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { resolveMcsHome, type EnvLike } from '@mcs/shared/protocol';

import type { OpContext } from '../ops/workspace.ts';
import { samePath } from '../platform/paths.ts';

/** The slug of the one user instance, the name of its folder below the user root. */
export const USER_INSTANCE_SLUG = 'user';
/** The reserved tasks root below the per-user folder; it never lists a task of a repository. */
export const USER_ROOT_DIRNAME = 'instances';
/** The port `config.json` of a new user instance is seeded with; the port scan of the server starts here. */
export const USER_DEFAULT_PORT = 7690;
/** The title of the user instance. */
export const USER_INSTANCE_NAME = 'Claude Agent Workspace';

/**
 * `resolveMcsHome` returns a string with mixed separators on Windows (a backslash path that ends in a forward slash and
 * `mcs`), so it is always run through `path.resolve`. It throws without a home: that is `CONFIG_INVALID`, as `mcsHomeOf`
 * of the instance context says.
 */
function homeOf(env: EnvLike): string {
  try {
    return path.resolve(resolveMcsHome(env));
  } catch (error) {
    throw new McsError('CONFIG_INVALID', error instanceof Error ? error.message : 'no MCS home folder', {
      cause: error,
    });
  }
}

/** `<MCS_HOME>/instances`: the tasks root of the user instance, absolute. */
export function userRootOf(env: EnvLike): string {
  return path.join(homeOf(env), USER_ROOT_DIRNAME);
}

/** `<MCS_HOME>/instances/user`: the workspace folder of the user instance. */
export function userInstanceDirOf(env: EnvLike): string {
  return path.join(userRootOf(env), USER_INSTANCE_SLUG);
}

/** `<instance>/run/browser-profile`: the profile of the optional app window, kept apart from the person's own browser. */
export function userBrowserProfileDirOf(env: EnvLike): string {
  return path.join(userInstanceDirOf(env), 'run', 'browser-profile');
}

/**
 * True when `root` is the user root: canonical equality, with the case rule of the host (links and junctions are
 * followed). Boot refuses a `kind: "user"` workspace anywhere else, so a hand-edited task cannot become a terminal host.
 */
export function isUserRoot(root: string, env: EnvLike): boolean {
  return samePath(root, userRootOf(env));
}

/** The operation context of the user instance: the repository and the tasks root are both the user root. */
export function userOpContext(base: Omit<OpContext, 'repo' | 'root'>): OpContext {
  const root = userRootOf(base.env);
  return { ...base, repo: root, root };
}
