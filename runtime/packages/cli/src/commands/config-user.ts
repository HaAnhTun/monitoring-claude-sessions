// `config get [KEY]` and `config set KEY VALUE` (06 2.8): the settings of the app that a person changes by name. A whitelist of
// seven keys; every other key goes through `caw configure --user`, which keeps the whole configuration reachable and these two
// commands small. `set` is `opsConfig.configure` for the task `user` with the reason `caw config set`, so it is validated as a
// whole (`RuntimeOverridesSchema`), written atomically and audited like every other change; `get` is the projection of
// `opsConfig.inspect`, so the source of a value is the one `caw inspect --user` shows. Both make the workspace of the app on first
// use: the usual way out of a failed `app.claude` check is `caw config set terminal.command ...`, which must work before the first start.
import {
  USER_INSTANCE_SLUG,
  ensureUserInstance,
  opsConfig,
  type ConfigureDeps,
  type ConfigureInput,
  type ConfigureReport,
  type InspectDeps,
  type InspectResult,
  type OpContext,
} from '@mcs/engine';
import { McsError, type ConfigSource } from '@mcs/shared';

import type { CommandContext, CommandDefinition, CommandResult } from '../main.ts';

/** The settings a person may read and change by name (06 2.8), in the order `config get` shows them. */
export const USER_CONFIG_KEYS = [
  'terminal.command',
  'terminal.args',
  'terminal.maxSessions',
  'app.name',
  'app.openAppWindow',
  'server.port',
  'server.portScan',
] as const;

export type UserConfigKey = (typeof USER_CONFIG_KEYS)[number];

/** The operations of the engine this module needs, replaceable in tests. */
export interface ConfigOps {
  inspect(ctx: OpContext, input: { readonly task: string }, deps?: InspectDeps): Promise<InspectResult>;
  configure(ctx: OpContext, input: ConfigureInput, deps?: ConfigureDeps): Promise<ConfigureReport>;
}

/** Makes the workspace of the app when it does not exist yet. */
export type EnsureApp = (ctx: OpContext) => Promise<unknown>;

const REAL_OPS: ConfigOps = {
  inspect: (ctx, input, deps) => opsConfig.inspect(ctx, input, deps),
  configure: (ctx, input, deps) => opsConfig.configure(ctx, input, deps),
};

const REAL_ENSURE: EnsureApp = (ctx) => ensureUserInstance(ctx);

const SET_REASON = 'caw config set';
const OTHER_KEYS_HINT = 'any other key: `caw configure --user --set KEY=JSON`';

/** The key of the command line, or a usage error that names the keys that exist. */
function keyOf(text: string | undefined): UserConfigKey {
  const key = USER_CONFIG_KEYS.find((candidate) => candidate === text);
  if (key !== undefined) return key;
  throw new McsError('USAGE', `unknown setting '${text ?? ''}'; the settings are ${USER_CONFIG_KEYS.join(', ')}`, {
    hint: OTHER_KEYS_HINT,
  });
}

/** The words of the design: the lowest layer is called `default`. */
function sourceOf(source: ConfigSource): string {
  return source === 'builtin' ? 'default' : source;
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface Setting {
  readonly key: UserConfigKey;
  readonly value: unknown;
  readonly source: string;
}

function settingOf(result: InspectResult, key: UserConfigKey): Setting {
  const entry = result.inspection.entries.find((candidate) => candidate.key === key);
  return { key, value: entry?.value ?? null, source: sourceOf(entry?.source ?? 'builtin') };
}

function inspectApp(ops: Pick<ConfigOps, 'inspect'>, ctx: CommandContext): Promise<InspectResult> {
  return ops.inspect(ctx.op, { task: USER_INSTANCE_SLUG }, ctx.deps);
}

export function makeGetCommand(
  ops: Pick<ConfigOps, 'inspect'> = REAL_OPS,
  ensure: EnsureApp = REAL_ENSURE,
): CommandDefinition {
  return {
    name: 'config get',
    summary: 'show the value and the source of a setting of the app (or of all seven)',
    synopsis: '[KEY]',
    options: {},
    positionals: { max: 1 },
    defaultScope: 'user',
    userOnly: true,
    async run(ctx): Promise<CommandResult> {
      const asked = ctx.args.positionals[0];
      const keys = asked === undefined ? USER_CONFIG_KEYS : [keyOf(asked)];
      await ensure(ctx.op);
      const result = await inspectApp(ops, ctx);
      const settings = keys.map((key) => settingOf(result, key));
      return {
        data: settings,
        text: settings.map((setting) => {
          const note =
            setting.key === 'server.port' && setting.value === null
              ? `${setting.source}; the first port tried is ${String(result.inspection.effectivePort)}`
              : setting.source;
          return `${setting.key} = ${valueText(setting.value)}  (${note})`;
        }),
      };
    },
  };
}

export function makeSetCommand(ops: ConfigOps = REAL_OPS, ensure: EnsureApp = REAL_ENSURE): CommandDefinition {
  return {
    name: 'config set',
    summary: 'change a setting of the app (the value is JSON, or plain text when it is not JSON)',
    synopsis: 'KEY VALUE',
    options: {},
    positionals: { max: 2 },
    defaultScope: 'user',
    userOnly: true,
    async run(ctx): Promise<CommandResult> {
      const [asked, value] = ctx.args.positionals;
      if (asked === undefined || value === undefined) {
        throw new McsError('USAGE', 'config set needs a KEY and a VALUE', { hint: 'usage: caw config set KEY VALUE' });
      }
      const key = keyOf(asked);
      await ensure(ctx.op);
      const report = await ops.configure(
        ctx.op,
        { task: USER_INSTANCE_SLUG, set: [`${key}=${value}`], reason: SET_REASON },
        ctx.deps,
      );
      const setting = settingOf(await inspectApp(ops, ctx), key);
      const restartNeeded = report.changed && report.restart_needed === true;
      const text = report.changed
        ? [`saved ${key} = ${valueText(setting.value)}`]
        : [`unchanged: ${key} is already ${valueText(setting.value)}`];
      if (restartNeeded) text.push('restart needed: the running app keeps the old value until caw restart');
      // a layer above `runtime.json` (the environment, the command line) wins over what was just saved
      const shadowed = report.changed && (setting.source === 'env' || setting.source === 'cli');
      return {
        data: { ...setting, changed: report.changed, restartNeeded },
        text,
        warnings: shadowed ? [`${key} is also set by the ${setting.source}, which wins over the saved value`] : [],
      };
    },
  };
}

export const getCommand: CommandDefinition = makeGetCommand();
export const setCommand: CommandDefinition = makeSetCommand();
