/**
 * Reading and writing a runtime environment variable under both of its names (07 section 4.2).
 *
 * A runtime variable has a canonical name with the prefix `CAW_` and a legacy name with the prefix `MCS_` and the same
 * rest. A reader names the variable by its canonical name; the first name that is DEFINED wins, whatever its value (an
 * empty string is defined), and the variable's own validation then runs on that value. So a bad canonical value never
 * falls back to the legacy name.
 *
 * Dependency-free: the hook handler imports this file through `@mcs/shared/protocol` and nothing else of the package.
 */
import type { EnvLike } from './routes.ts';

/** The prefix of every canonical runtime variable name. */
export const ENV_PREFIX = 'CAW_';
/** The prefix of the legacy spelling that is still read (07 section 7.6). */
export const LEGACY_ENV_PREFIX = 'MCS_';

/** What a read found: the value, the name it came from and whether that was the legacy spelling. */
export interface EnvRead {
  readonly value: string;
  readonly name: string;
  readonly legacy: boolean;
}

/** Maps the canonical name of a variable to its legacy name. Throws for a name without the canonical prefix and rest. */
export function legacyEnvName(name: string): string {
  if (!name.startsWith(ENV_PREFIX) || name.length === ENV_PREFIX.length) {
    throw new Error(`not a canonical environment variable name: it must start with ${ENV_PREFIX} and have a rest`);
  }
  return LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length);
}

function own(env: EnvLike, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}

/** The first defined of the canonical name and its legacy name, with the name that supplied it. */
export function readEnvEntry(env: EnvLike, name: string): EnvRead | undefined {
  const legacyName = legacyEnvName(name);
  const canonical = own(env, name);
  if (canonical !== undefined) return { value: canonical, name, legacy: false };
  const legacy = own(env, legacyName);
  if (legacy !== undefined) return { value: legacy, name: legacyName, legacy: true };
  return undefined;
}

/** The value of `readEnvEntry`, or `undefined` when neither name is defined. */
export function readEnv(env: EnvLike, name: string): string | undefined {
  return readEnvEntry(env, name)?.value;
}

/**
 * Sets the canonical name and the legacy name to the same value. A child process started by the product gets both, so a
 * hook handler copy or a child of an older version still sees the variable (07 section 4.3).
 */
export function setEnvBoth(target: Record<string, string>, name: string, value: string): void {
  const legacyName = legacyEnvName(name);
  target[name] = value;
  target[legacyName] = value;
}
