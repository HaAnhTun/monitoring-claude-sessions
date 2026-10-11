// Text renderer (01 6.1, 6.2): result lines on stdout, `ERROR:` / `hint:` / `warning:` lines on stderr, and the help pages that
// are generated from the option tables. Every line goes through `io/terminal.ts`, which escapes untrusted text (ADR 0046).
import type { CliError } from '@mcs/shared';

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
    ].filter((n): n is string => n !== null);
    const text = note.length === 0 ? spec.description : `${spec.description} (${note.join('; ')})`;
    return `  ${optionLabel(name, spec).padEnd(width)}  ${text}`;
  });
}

/** `mcs <name> <synopsis>`: the usage line of a command. */
export function usageLine(def: CommandDefinition): string {
  return def.synopsis === '' ? `mcs ${def.name}` : `mcs ${def.name} ${def.synopsis}`;
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
    'mcs: monitor Claude Code sessions (reads transcripts in place, serves a loopback dashboard).',
    '',
    'usage: mcs <command> [options]',
    '       mcs help <command>',
    '',
    'commands:',
    ...defs.map((d) => `  ${d.name.padEnd(width)}  ${d.summary}`),
    '',
    'common options (every command):',
    ...optionLines(globals),
  ];
}
