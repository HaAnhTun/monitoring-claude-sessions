// The environment of a terminal session (design 01 section 3.4 and amendment A1). It reproduces MTOP `child_env`: the server
// may itself have been started from inside a Claude Code session, and that session's markers must not leak into new ones.
import type { HostPlatform } from '../platform/host.ts';
import { TERM_PROGRAM } from './limits.ts';

/** Windows compares environment variable names without regard to case; every other host compares them exactly. */
const foldsCase = (platform: HostPlatform): boolean => platform === 'win32';

/** What an environment looks like to this module: names to values, a value may be missing. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

const STRIPPED_PREFIX = 'CLAUDE_CODE_';
/** Names removed whole (exact, or upper-cased on win32). The prefix rule above covers the `CLAUDE_CODE_*` family. */
const STRIPPED_NAMES: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_SESSION_ID',
  // MTOP: the terminal is xterm.js, colour must be on whatever the parent set
  'NO_COLOR',
  'FORCE_COLOR',
  // A terminal session is a user session that the hooks must see. `claudeArgsWithoutHooks` is for children the monitor launches.
  'MCS_HOOK_DISABLE',
]);

/** Set last, replacing a value of the same name (any case on win32). */
const FIXED: readonly (readonly [string, string])[] = [
  ['TERM', 'xterm-256color'],
  ['COLORTERM', 'truecolor'],
  ['TERM_PROGRAM', TERM_PROGRAM],
  // cmd.exe searches the current directory first for a bare command: without this a `node.cmd` planted in the project folder
  // would run when an npm `claude.cmd` shim calls `node`.
  ['NoDefaultCurrentDirectoryInExePath', '1'],
];

/** The value of `name` in `env`: on win32 under any case of the key (the exact spelling first), elsewhere exact. */
export function envValue(env: EnvSource, name: string, platform: HostPlatform): string | undefined {
  const exact = env[name];
  if (exact !== undefined || !foldsCase(platform)) return exact;
  const wanted = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === wanted) return env[key];
  }
  return undefined;
}

/**
 * The environment for a new `claude` session. Removed, unless named in `keep`: `CLAUDE_CODE_*`, `CLAUDECODE`,
 * `CLAUDE_SESSION_ID`, `NO_COLOR`, `FORCE_COLOR` and `MCS_HOOK_DISABLE` (case-insensitive on win32, exact elsewhere). Dropped
 * because no child can receive them: an undefined value, a NUL, a name that is empty or holds `=`. On win32 the first spelling
 * of two keys that differ only in case wins, because node-pty builds the environment block from the keys and would pass both.
 * Everything else passes through. The input is not changed.
 */
export function buildTerminalEnv(
  source: EnvSource,
  o: { readonly keep: readonly string[]; readonly platform: HostPlatform },
): Record<string, string> {
  const fold = foldsCase(o.platform) ? (name: string) => name.toUpperCase() : (name: string) => name;
  const keep = new Set(o.keep.map(fold));
  const fixed = new Set(FIXED.map(([name]) => fold(name)));
  const seen = new Set<string>();
  const entries = new Map<string, string>();
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined) continue;
    if (name === '' || name.includes('=') || name.includes('\u0000') || value.includes('\u0000')) continue;
    const key = fold(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const stripped = key.startsWith(STRIPPED_PREFIX) || STRIPPED_NAMES.has(key);
    if (stripped && !keep.has(key)) continue;
    if (fixed.has(key)) continue;
    entries.set(name, value);
  }
  for (const [name, value] of FIXED) entries.set(name, value);
  // Object.fromEntries defines own data properties, so a variable named `__proto__` is data and never the prototype.
  return Object.fromEntries(entries);
}
