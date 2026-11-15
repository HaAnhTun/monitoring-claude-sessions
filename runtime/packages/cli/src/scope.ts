// The scope rule of the CLI (06 2.2, ADR 0092). Every command acts on one of two worlds: the app instance of the user ("user",
// `<MCS_HOME>/instances/user`) or a monitored task ("task", `<repo>/.claude/monitor/tasks/<slug>`). The person selects one
// with `--user` or with `--task`, `--repo` or `--root`; a command that is given neither uses its own default (`defaultScope`:
// the lifecycle family starts at "user", everything else at "task"). This module is pure: `main.ts` reads the options, asks
// here, and builds the operation context for the answer. The same module words the texts of an app call (`appCommandText`): the
// engine speaks of the app as the task `user`, the person never did.
import { McsError, type CliError } from '@mcs/shared';

export type Scope = 'user' | 'task';

/**
 * What the person typed that selects a scope. A value counts as given when it is not `undefined`: `--task ""` is typed, and
 * fails later as the invalid slug it is, instead of silently selecting the other world.
 */
export interface ScopeSelectors {
  readonly user: boolean;
  readonly task?: string | undefined;
  readonly repo?: string | undefined;
  readonly root?: string | undefined;
}

export interface ScopeResolution {
  readonly scope: Scope;
  /** True when the person selected nothing and the default of the command decided. */
  readonly defaulted: boolean;
}

/**
 * `--user` is the app; `--task`, `--repo` or `--root` are a task; neither is the default scope of the command (a command that
 * names none is a task command). `--user` together with a task selector is a usage error: it would be a guess which one the
 * person meant. `hint` is the usage line the caller shows next to the error.
 */
export function resolveScope(
  def: { readonly defaultScope?: Scope },
  values: ScopeSelectors,
  hint?: string,
): ScopeResolution {
  const taskish = values.task !== undefined || values.repo !== undefined || values.root !== undefined;
  if (values.user) {
    if (taskish) {
      throw new McsError('USAGE', '--user cannot be combined with --task, --repo or --root', {
        ...(hint === undefined ? {} : { hint }),
      });
    }
    return { scope: 'user', defaulted: false };
  }
  if (taskish) return { scope: 'task', defaulted: false };
  return { scope: def.defaultScope ?? 'task', defaulted: true };
}

// ---- the wording of the app (06 2.2) ---------------------------------------------------------------------------------------------

/**
 * The operations of the engine know the app as a task with the slug `user`, so the commands they suggest carry `--task user`
 * (`mcs start --task user`). In the scope of the app that is wrong twice: a call with a task selector is a task call (the lifecycle
 * commands refuse `--task user` there, with "no task.json"), and the person never typed a task. The kernel therefore words every
 * text of an app call again, in one place, instead of each command repairing its own lines.
 */
const APP_DEFAULT_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'restart',
  'status',
  'serve',
  'verify',
  'doctor',
  'check',
]);

/**
 * `<program> <command words and values> --task user`: the program word, the first command word (its default scope decides), the
 * words in between (more command words, `--restart`, `--id X`), then the selector. A word never holds a space, a backtick or a quote,
 * so a hint that sits in backticks or quotes stops at its end.
 */
const TASK_USER_SELECTOR = /\b(mcs|caw) ([a-z][a-z-]*)((?: [^\s`'")]+)*?) --task user(?![\w-])/g;

/**
 * The text as the person of the app should read it: the selector `--task user` of a suggested command is dropped when the command
 * defaults to the app (`mcs doctor --task user` -> `mcs doctor`) and becomes `--user` when it does not (`mcs backup restore --task
 * user --id X` -> `mcs backup restore --user --id X`), which is what the call needs to reach the app.
 */
export function appCommandText(text: string): string {
  return text.replace(
    TASK_USER_SELECTOR,
    (_whole, program: string, command: string, between: string) =>
      `${program} ${command}${between}${APP_DEFAULT_COMMANDS.has(command) ? '' : ' --user'}`,
  );
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** {@link appCommandText} on every string of a JSON-like value (arrays and plain objects are copied, anything else is kept). */
export function inAppScope(value: unknown): unknown {
  if (typeof value === 'string') return appCommandText(value);
  if (Array.isArray(value)) return value.map(inAppScope);
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inAppScope(item)]));
  }
  return value;
}

/** What a `TASK_NOT_FOUND` of the app means: the workspace of the app is made by the first start, nobody makes it by hand. */
export const APP_NOT_CREATED_HINT = 'run `caw start` once to create the app instance';

/**
 * An error of an app call as the person should read it: the words of {@link appCommandText}, and for `TASK_NOT_FOUND` (a command
 * that works on a task, used with `--user` before the app was ever started) the hint to start it, instead of the engine's
 * `mcs init --slug user`, which would make a task named `user`.
 */
export function appErrorOf(error: CliError): CliError {
  const hint =
    error.code === 'TASK_NOT_FOUND' ? APP_NOT_CREATED_HINT : error.hint === null ? null : appCommandText(error.hint);
  return {
    code: error.code,
    message: appCommandText(error.message),
    hint,
    details:
      error.details === null
        ? null
        : Object.fromEntries(Object.entries(error.details).map(([key, item]) => [key, inAppScope(item)])),
  };
}
