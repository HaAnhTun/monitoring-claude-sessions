// Text renderer (01 6.1, 6.2): result lines on stdout, `ERROR:` / `hint:` / `warning:` lines on stderr, and the help pages that
// are generated from the option tables. Every line goes through `io/terminal.ts`, which escapes untrusted text (ADR 0046).
import { CLI_NAME, PRODUCT_NAME, type CliError } from '@mcs/shared';

import { printErrorLine, printLine } from '../io/terminal.ts';
import type { CommandDefinition, OptionSpec, OptionTable } from '../main.ts';

/** Result lines of a command, one per element. */
export function renderLines(lines: readonly string[]): void {
  for (const line of lines) printLine(line);
}

/** `warning: <text>` on stderr (legacy: warnings never mix into the result on stdout). */
export function renderWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) printErrorLine(`warning: ${warning}`);
}

/** `ERROR: <message>` and, when there is one, `hint: <hint>` on stderr (legacy: `ERROR: ` prefix, exit code by the caller). */
export function renderError(error: CliError): void {
  printErrorLine(`ERROR: ${error.message}`);
  if (error.hint !== null) printErrorLine(`hint: ${error.hint}`);
}

/** The one-line form of an option: `--name VALUE`, `-h, --help`. */
export function optionLabel(name: string, spec: OptionSpec): string {
  const long = spec.type === 'string' ? `--${name} ${spec.valueName ?? 'VALUE'}` : `--${name}`;
  return spec.short === undefined ? long : `-${spec.short}, ${long}`;
}

function optionLines(table: OptionTable): string[] {
  const entries = Object.entries(table);
  const width = Math.max(0, ...entries.map(([name, spec]) => optionLabel(name, spec).length));
  return entries.map(([name, spec]) => {
    const note = [
      spec.multiple === true ? 'repeatable' : null,
      spec.choices === undefined ? null : `one of ${spec.choices.join(', ')}`,
      spec.scope === undefined ? null : spec.scope === 'user' ? 'app instance only' : 'task only',
    ].filter((n): n is string => n !== null);
    const text = note.length === 0 ? spec.description : `${spec.description} (${note.join('; ')})`;
    return `  ${optionLabel(name, spec).padEnd(width)}  ${text}`;
  });
}

/** `<cli> <name> <synopsis>`: the usage line of a command; the name of the program is `CLI_NAME`. */
export function usageLine(def: CommandDefinition): string {
  return def.synopsis === '' ? `${CLI_NAME} ${def.name}` : `${CLI_NAME} ${def.name} ${def.synopsis}`;
}

/** The help page of one command: usage, summary, its options, then the options every command takes. */
export function commandHelpLines(def: CommandDefinition, globals: OptionTable): string[] {
  const lines = [`usage: ${usageLine(def)}`, '', def.summary];
  if (def.aliases !== undefined && def.aliases.length > 0) lines.push(`alias: ${def.aliases.join(', ')}`);
  if (Object.keys(def.options).length > 0) lines.push('', 'options:', ...optionLines(def.options));
  lines.push('', 'common options:', ...optionLines(globals));
  return lines;
}

/** The top-level help page: every command with its summary, then the common options. */
export function generalHelpLines(defs: readonly CommandDefinition[], globals: OptionTable): string[] {
  const width = Math.max(0, ...defs.map((d) => d.name.length));
  return [
    `${CLI_NAME}: ${PRODUCT_NAME} (monitors Claude Code sessions: reads transcripts in place, serves a loopback dashboard).`,
    '',
    `usage: ${CLI_NAME} <command> [options]`,
    `       ${CLI_NAME} help <command>`,
    '',
    'commands:',
    ...defs.map((d) => `  ${d.name.padEnd(width)}  ${d.summary}`),
    '',
    'scope: start, stop, restart, status, serve, verify, doctor and check act on the app instance unless --task, --repo or --root',
    'select a task; every other command acts on a task, and on the app with --user.',
    '',
    'common options (every command):',
    ...optionLines(globals),
  ];
}
