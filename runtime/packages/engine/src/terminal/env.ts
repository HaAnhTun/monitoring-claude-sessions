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
  // A terminal session is a user session that the hooks must see. `claudeArgsWithoutHooks` is for children the monitor launches.
  'MCS_HOOK_DISABLE',
]);
/** Removed from the in-app terminal only (MTOP: it is xterm.js, colour must be on whatever the parent set). A native window keeps them. */
const TERMINAL_ONLY_STRIPPED: ReadonlySet<string> = new Set(['NO_COLOR', 'FORCE_COLOR']);

/** Set last, replacing a value of the same name (any case on win32). */
const NO_DEFAULT_CWD: readonly [string, string] = ['NoDefaultCurrentDirectoryInExePath', '1'];
const FIXED: readonly (readonly [string, string])[] = [
  ['TERM', 'xterm-256color'],
  ['COLORTERM', 'truecolor'],
  ['TERM_PROGRAM', TERM_PROGRAM],
  // cmd.exe searches the current directory first for a bare command: without this a `node.cmd` planted in the project folder
  // would run when an npm `claude.cmd` shim calls `node`.
  NO_DEFAULT_CWD,
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
 * The one loop of both builders. Removed, unless named in `keep`: the `CLAUDE_CODE_*` family, `STRIPPED_NAMES` and `extraStripped`
 * (case-insensitive on win32). Dropped because no child can receive them: an undefined value, a NUL, a name that is empty or holds
 * `=`. On win32 the first spelling of two keys that differ only in case wins. `fixed` is set last over any value of the same name.
 */
function buildEnv(
  source: EnvSource,
  o: {
    readonly keep: readonly string[];
    readonly platform: HostPlatform;
    readonly extraStripped: ReadonlySet<string>;
    readonly fixed: readonly (readonly [string, string])[];
  },
): Record<string, string> {
  const fold = foldsCase(o.platform) ? (name: string) => name.toUpperCase() : (name: string) => name;
  const keep = new Set(o.keep.map(fold));
  const fixed = new Set(o.fixed.map(([name]) => fold(name)));
  const seen = new Set<string>();
  const entries = new Map<string, string>();
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined) continue;
    if (name === '' || name.includes('=') || name.includes('\u0000') || value.includes('\u0000')) continue;
    const key = fold(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const stripped = key.startsWith(STRIPPED_PREFIX) || STRIPPED_NAMES.has(key) || o.extraStripped.has(key);
    if (stripped && !keep.has(key)) continue;
    if (fixed.has(key)) continue;
    entries.set(name, value);
  }
  for (const [name, value] of o.fixed) entries.set(name, value);
  // Object.fromEntries defines own data properties, so a variable named `__proto__` is data and never the prototype.
  return Object.fromEntries(entries);
}

/**
 * The environment for a new `claude` session in the in-app terminal. Removed, unless named in `keep`: `CLAUDE_CODE_*`, `CLAUDECODE`,
 * `CLAUDE_SESSION_ID`, `NO_COLOR`, `FORCE_COLOR` and `MCS_HOOK_DISABLE` (case-insensitive on win32, exact elsewhere). Dropped
 * because no child can receive them: an undefined value, a NUL, a name that is empty or holds `=`. On win32 the first spelling
 * of two keys that differ only in case wins, because node-pty builds the environment block from the keys and would pass both.
 * Everything else passes through. The input is not changed.
 */
export function buildTerminalEnv(
  source: EnvSource,
  o: { readonly keep: readonly string[]; readonly platform: HostPlatform },
): Record<string, string> {
  return buildEnv(source, { ...o, extraStripped: TERMINAL_ONLY_STRIPPED, fixed: FIXED });
}

/**
 * The environment of a window of the person's own terminal (CAW-145, ADR 0136): the same strip of the Claude markers as the
 * terminal (`CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_SESSION_ID`, `MCS_HOOK_DISABLE`, unless named in `keep`), but the colour
 * variables stay as the person set them and `TERM`, `COLORTERM` and `TERM_PROGRAM` are not set (the terminal of the person sets
 * its own). Everything else, `PATH` first, passes through. `NoDefaultCurrentDirectoryInExePath` is set like in the terminal.
 */
export function buildNativeEnv(
  source: EnvSource,
  o: { readonly keep: readonly string[]; readonly platform: HostPlatform },
): Record<string, string> {
  return buildEnv(source, { ...o, extraStripped: new Set(), fixed: [NO_DEFAULT_CWD] });
}
