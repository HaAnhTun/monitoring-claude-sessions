// `formatCommand` and the copy-paste commands of `InstanceInfo.commands` (01 6.6, registry 2.1, plan section 10 D-17).
// The UI shows these strings on the Settings page with a copy button; the server never runs them. A value is double
// quoted only when it needs it, so the common case reads `node D:/skill/scripts/mcs.mjs status --task demo`. The quoting
// follows the rules of a POSIX shell (Git Bash, the shell of the plan); PowerShell and cmd read the common case alike.
import type { InstanceInfo, InstanceKind } from '@mcs/shared';

import { hostPlatform } from '../platform/host.ts';

const SPACE = ' ';
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const RETURN = String.fromCharCode(13);
const QUOTE = '"';
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);

/** Characters that a POSIX shell reads as syntax inside a word: quotes, expansion, redirection, lists, globs, braces. */
const SHELL_SYNTAX: ReadonlySet<string> = new Set([
  '"',
  "'",
  '$',
  '&',
  ';',
  '|',
  '<',
  '>',
  '(',
  ')',
  '*',
  '?',
  '[',
  ']',
  '{',
  '}',
  BACKSLASH,
  BACKTICK,
]);

/** The characters that keep their meaning inside double quotes and so need a backslash there. */
const ESCAPED_IN_QUOTES: ReadonlySet<string> = new Set([QUOTE, '$', BACKSLASH, BACKTICK]);

/** True when the shell would split the value into several words. */
function hasWhitespace(value: string): boolean {
  return [SPACE, TAB, NEWLINE, RETURN].some((c) => value.includes(c));
}

/** True when the value, written as it is, would be several words, nothing, a comment, a home folder or shell syntax. */
function needsQuotes(value: string): boolean {
  if (value === '' || value.startsWith('#') || value.startsWith('~') || hasWhitespace(value)) return true;
  for (const c of value) if (SHELL_SYNTAX.has(c)) return true;
  return false;
}

/** The value as it is written between double quotes. */
function escapeInQuotes(value: string): string {
  let escaped = '';
  for (const c of value) escaped += ESCAPED_IN_QUOTES.has(c) ? BACKSLASH + c : c;
  return escaped;
}

/**
 * One shell word per `argv` element, joined with single spaces. A value is wrapped in double quotes when it contains a
 * space (01 6.6), and also when it is empty (it would vanish) or holds shell syntax (`$`, a backtick, `;`, `&`, a quote,
 * a backslash, ...), because the user pastes the string into a shell and a repository path is not under our control.
 * Inside the quotes a double quote, a backslash, `$` and a backtick get a backslash, so nothing is expanded or run and a
 * trailing backslash cannot swallow the closing quote. Everything else is written as it is.
 */
export function formatCommand(argv: readonly string[]): string {
  return argv
    .map((value) => {
      if (!needsQuotes(value)) return value;
      return `${QUOTE}${escapeInQuotes(value)}${QUOTE}`;
    })
    .join(SPACE);
}

/** What the six commands are built from. All paths are absolute. */
export interface InstanceCommandInput {
  /** `<skill>/scripts/mcs.mjs`. */
  readonly launcherPath: string;
  /** The task slug: the workspace folder name. */
  readonly slug: string;
  /** The monitored repository (`config.monitor.repo`). */
  readonly repoDir: string;
  /** The workspace folder `<repo>/.claude/monitor/tasks/<slug>`. */
  readonly instanceDir: string;
  /** `user` builds the commands of the user instance, which take `--user` instead of `--task` and `--repo`; absent is `task`. */
  readonly kind?: InstanceKind;
}

/** A path as it is shown: forward slashes on Windows, so that Git Bash, PowerShell and cmd all read the same text. */
function shownPath(p: string): string {
  return hostPlatform === 'win32' ? p.replaceAll(BACKSLASH, '/') : p;
}

/**
 * The six display strings of `InstanceInfo.commands` (01 6.6): `node <launcher> <command> --task <slug>`, the options of
 * the command, then `--repo <repo>` last so that the command also works from another folder. `export` writes
 * `<workspace>/logs/export.ndjson`, never `.jsonl` (a `.jsonl` file inside a workspace breaks the legacy `audit`, 01 1.1).
 */
export function instanceCommands(i: InstanceCommandInput): InstanceInfo['commands'] {
  const launcher = shownPath(i.launcherPath);
  const repo = shownPath(i.repoDir);
  const exportFile = `${shownPath(i.instanceDir)}/logs/export.ndjson`;
  const build = (command: string, options: readonly string[] = []): string =>
    i.kind === 'user'
      ? formatCommand(['node', launcher, command, '--user', ...options])
      : formatCommand(['node', launcher, command, '--task', i.slug, ...options, '--repo', repo]);
  return {
    status: build('status'),
    restart: build('restart'),
    inspect: build('inspect'),
    export: build('export', ['--out', exportFile]),
    backup: build('backup'),
    cleanupDryRun: build('cleanup', ['--scope', 'logs']),
  };
}
