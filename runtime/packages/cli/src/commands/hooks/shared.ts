// What the `hooks install|uninstall|verify|status` commands share (01 6.3, 6.4; 02 3.6, 3.8; ADR 0070 item 7): the selector
// options, the text of a plan or a result, and the consent prompt. Option tables and rendering only; every decision is an
// engine operation (`ops.hooks.*`).
import { createInterface } from 'node:readline';

import { McsError, type HooksApplyResult } from '@mcs/shared';

import { isInteractive, printErrorLine, printLine } from '../../io/terminal.ts';
import type { CommandContext, CommandResult, OptionTable, ParsedArgs } from '../../main.ts';

/** The consent text of 01 6.4: a settings change reaches sessions that already run. */
export const CONSENT_TEXT =
  'Hook settings apply to every Claude Code session that reads this settings file, including sessions that are already running.';

/** Exec-form hooks (`command` plus `args`, no shell) need a Claude Code release that accepts `args` (ADR 0070). */
export const EXEC_FORM_NOTE =
  'note: the entries use the exec form (command plus args): they need a Claude Code release that supports "args" in command hooks.';

export const DRY_RUN_LAST_LINE = 'dry run: nothing was written; re-run with --yes after the user agreed';

/** `--scope`, `--settings-file` and `--task`: which settings file a hooks command works on, and whose audit trail records it. */
export function targetOptions(taskRequired: boolean): OptionTable {
  return {
    scope: {
      type: 'string',
      valueName: 'SCOPE',
      choices: ['project-local', 'user', 'project'],
      description:
        'project-local (default): <repo>/.claude/settings.local.json; user: the settings file of this user, only when you ask for it; project is refused',
    },
    'settings-file': {
      type: 'string',
      valueName: 'FILE',
      description: 'use this settings file instead of a scope (tests and experts); excludes --scope',
    },
    task: {
      type: 'string',
      valueName: 'SLUG',
      ...(taskRequired ? { required: true } : {}),
      description: taskRequired
        ? 'the task whose instance is checked'
        : 'the task whose audit trail records the change',
    },
  };
}

export interface TargetArgs {
  readonly scope?: string;
  readonly settingsFile?: string;
  readonly task?: string;
}

/** The selectors as engine input; a relative `--settings-file` is resolved against the current folder here, where the folder is known. */
export function targetArgs(args: ParsedArgs, resolve: (file: string) => string): TargetArgs {
  const scope = args.string('scope');
  const settingsFile = args.string('settings-file');
  const task = args.string('task');
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(settingsFile === undefined ? {} : { settingsFile: resolve(settingsFile) }),
    ...(task === undefined ? {} : { task }),
  };
}

function eventLines(result: HooksApplyResult): string[] {
  const lines: string[] = [];
  for (const event of result.added) lines.push(`+ ${event}`);
  for (const event of result.replaced) lines.push(`~ ${event}`);
  for (const event of result.removed) lines.push(`- ${event}`);
  for (const event of result.kept) lines.push(`= ${event}`);
  return lines;
}

function scriptLine(result: HooksApplyResult, dryRun: boolean): string {
  const verb: Record<HooksApplyResult['script']['action'], string> = {
    created: dryRun ? 'would be created' : 'created',
    refreshed: dryRun ? 'would be refreshed' : 'refreshed',
    current: 'current',
    removed: dryRun ? 'would be removed' : 'removed',
    kept: 'kept (another install still uses it)',
    absent: 'absent',
  };
  return `script copy ${result.script.path}: ${verb[result.script.action]}`;
}

/** The lines of a dry run (02 3.6): the file and scope, the event lines, the script copy, the diff, the consent text. */
export function planLines(op: 'install' | 'uninstall', result: HooksApplyResult): string[] {
  const lines = [`settings file: ${result.settingsPath} (scope ${result.scope})`];
  if (result.action === 'noop' && result.script.action !== 'created' && result.script.action !== 'refreshed') {
    lines.push(
      op === 'install'
        ? 'hooks are already installed here; nothing would change'
        : 'no hooks of ours here; nothing would change',
    );
  } else {
    lines.push(...eventLines(result));
  }
  lines.push(scriptLine(result, true));
  if (result.diff !== '') lines.push('', ...result.diff.replace(/\n$/, '').split('\n'));
  if (op === 'install') lines.push('', EXEC_FORM_NOTE);
  lines.push('', CONSENT_TEXT, DRY_RUN_LAST_LINE);
  return lines;
}

/** The lines of a change that was made (or found already made). */
export function appliedLines(op: 'install' | 'uninstall', result: HooksApplyResult): string[] {
  const counts = `${String(result.added.length)} added, ${String(result.replaced.length)} replaced, ${String(result.removed.length)} removed, ${String(result.kept.length)} unchanged`;
  const lines: string[] = [];
  if (result.action === 'applied') {
    lines.push(
      `${op === 'install' ? 'installed hooks in' : 'removed hooks from'} ${result.settingsPath} (scope ${result.scope}): ${counts}`,
    );
    if (result.backupPath !== null) lines.push(`backup of the previous file: ${result.backupPath}`);
  } else {
    lines.push(
      op === 'install'
        ? `hooks are already installed in ${result.settingsPath} (scope ${result.scope}); the settings file was not changed`
        : `no hooks of ours in ${result.settingsPath} (scope ${result.scope}); the settings file was not changed`,
    );
  }
  lines.push(scriptLine(result, false));
  if (op === 'install')
    lines.push(EXEC_FORM_NOTE, 'next: mcs hooks verify --task SLUG (and mcs hooks enable --task SLUG)');
  return lines;
}

/** True when the dry run found something that `--yes` would write: the settings file or the copy of the script. */
export function wouldWrite(op: 'install' | 'uninstall', result: HooksApplyResult): boolean {
  if (result.action === 'plan') return true;
  return op === 'install'
    ? result.script.action === 'created' || result.script.action === 'refreshed'
    : result.script.action === 'removed';
}

// ---- the consent prompt ------------------------------------------------------------------------------------------------------------

/** The terminal side of the prompt; a test passes a scripted one. */
export interface ConsentIo {
  /** True when stdin and stdout are both terminals: the only case in which a person can be asked. */
  isTty(): boolean;
  /** Shows the lines, reads one line of the answer. */
  ask(lines: readonly string[]): Promise<string>;
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

export const realConsentIo: ConsentIo = {
  isTty: isInteractive,
  async ask(lines) {
    for (const line of lines) printErrorLine(line);
    return readLine();
  },
};

/** The question of the prompt: it names the settings file and the scope and the word that applies the plan. */
export function consentQuestion(word: 'install' | 'uninstall', result: HooksApplyResult): string[] {
  return [
    `${word === 'install' ? 'Install' : 'Remove'} hooks ${word === 'install' ? 'into' : 'from'} ${result.settingsPath} (scope ${result.scope})?`,
    CONSENT_TEXT,
    `Type the word ${word} to apply, anything else to leave everything as it is:`,
  ];
}

// ---- install and uninstall share one flow ------------------------------------------------------------------------------------------------

/**
 * The flow of `hooks install` and `hooks uninstall`: a dry run unless `--yes`; on a terminal (stdin and stdout both TTYs) the
 * dry run ends with a prompt that applies the plan only when the word is typed; in a pipe, a CI job or an agent session nothing
 * is ever asked. `--json`, `--no-prompt` and `--dry-run` never prompt. `call(yes)` is the engine operation.
 */
export async function runChange(
  op: 'install' | 'uninstall',
  ctx: Pick<CommandContext, 'args' | 'json'>,
  call: (yes: boolean) => Promise<HooksApplyResult>,
  consent: ConsentIo,
): Promise<CommandResult> {
  const yes = ctx.args.flag('yes');
  if (yes && ctx.args.flag('dry-run')) {
    throw new McsError('USAGE', '--yes and --dry-run exclude each other', {
      hint: 'a dry run is the default; pass --yes only to apply',
    });
  }
  let result = await call(yes);
  let applied = yes;
  const askable = !yes && !ctx.args.flag('dry-run') && !ctx.args.flag('no-prompt') && !ctx.json;
  if (askable && wouldWrite(op, result) && consent.isTty()) {
    // the plan is shown before the question, so the person decides on what they have read
    for (const line of planLines(op, result)) printLine(line);
    for (const warning of result.warnings) printErrorLine(`warning: ${warning.message}`);
    const answer = await consent.ask(consentQuestion(op, result));
    if (answer.trim() !== op) {
      return { data: result, text: ['not applied; nothing was written'], exitCode: 0 };
    }
    result = await call(true);
    applied = true;
  }
  return {
    data: result,
    text: applied ? appliedLines(op, result) : planLines(op, result),
    warnings: result.warnings.map((warning) => warning.message),
  };
}
