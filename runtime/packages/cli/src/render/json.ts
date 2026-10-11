// `--json` renderer (01 6.2, ADR 0008): exactly one `mcs.cli/1` document on stdout. A command that found problems (a failed
// `audit`) is `ok: false` with exit code 1, its findings in `data` and no error object; a failure that raised an error carries
// the error and no data.
import { failureEnvelope, successEnvelope, type CliEnvelope, type CliError } from '@mcs/shared';

import { printJson } from '../io/terminal.ts';
import type { CommandDefinition, CommandResult, OptionTable } from '../main.ts';
import { usageLine } from './text.ts';

export function renderEnvelope(envelope: CliEnvelope<unknown>): void {
  printJson(envelope, 2);
}

/** The envelope of a command that ran: ok at exit 0, otherwise `ok: false`, exit code 1, `data` kept and `error: null`. */
export function resultEnvelope(command: string, result: CommandResult): CliEnvelope<unknown> {
  const warnings = result.warnings ?? [];
  if ((result.exitCode ?? 0) === 0) return successEnvelope(command, result.data, warnings);
  return {
    schema: 'mcs.cli/1',
    command,
    ok: false,
    exitCode: 1,
    data: result.data,
    error: null,
    warnings: [...warnings],
  };
}

/** The envelope of a failure: the error of an operation, or any other error as `INTERNAL`. */
export function errorEnvelope(command: string, error: CliError): CliEnvelope<unknown> {
  return failureEnvelope(command, error);
}

export interface OptionDescription {
  readonly name: string;
  readonly type: 'string' | 'boolean';
  readonly short: string | null;
  readonly multiple: boolean;
  readonly required: boolean;
  readonly choices: readonly string[] | null;
  readonly description: string;
}

export interface CommandDescription {
  readonly command: string;
  readonly summary: string;
  readonly usage: string;
  readonly aliases: readonly string[];
  readonly options: readonly OptionDescription[];
}

function describeOptions(table: OptionTable): OptionDescription[] {
  return Object.entries(table).map(([name, spec]) => ({
    name,
    type: spec.type,
    short: spec.short ?? null,
    multiple: spec.multiple === true,
    required: spec.required === true,
    choices: spec.choices ?? null,
    description: spec.description,
  }));
}

/** The `data` of `<command> --help --json` and of `help <command> --json`: the option table as data. */
export function describeCommand(def: CommandDefinition, globals: OptionTable): CommandDescription {
  return {
    command: def.name,
    summary: def.summary,
    usage: usageLine(def),
    aliases: def.aliases ?? [],
    options: [...describeOptions(def.options), ...describeOptions(globals)],
  };
}
