// What an instance reads and shows (CAW design 03 2.1, 2.6, D11). One place decides three things that used to be inline or
// absent: whether the instance reads every project under the Claude home (`projects.scope`, `auto` follows the kind of the
// instance), whether the sessions that no rule matched are listed, and which panels are on. The kind is a plain parameter, so
// the rules are tested with literals; `instanceKindOfConfig` is how the query layer, which only has the resolved configuration,
// learns it.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  InstanceFileSchema,
  PANEL_CONFIG_KEY,
  instanceKindOf,
  type InstanceKind,
  type ProjectScope,
} from '@mcs/shared';

/** The configuration values `unmatchedVisible` reads; a `ResolvedConfig` has them. */
export interface ScopeConfig {
  readonly monitor: { readonly include_unmatched: boolean };
  readonly runtime: { readonly projects: { readonly scope: ProjectScope } };
}

/** The part of a resolved configuration that tells where the workspace is: the files it was read from. */
export interface ConfigFiles {
  readonly files: readonly { readonly name: string; readonly path: string }[];
}

/**
 * True when the instance reads the transcripts of every project (`all`): the key says `all`, or it says `auto` and the instance
 * is the user instance. A task instance stays on its repository unless the key forces `all` (tests, odd setups).
 */
export function isAllScope(scope: ProjectScope, kind: InstanceKind): boolean {
  return scope === 'all' || (scope === 'auto' && kind === 'user');
}

/** `<claude home>/projects`: the folder that holds one folder per project. */
export function projectsRootOf(claudeHome: string): string {
  return path.join(claudeHome, 'projects');
}

/**
 * Whether the sessions that no rule matched are part of a list, a tile or an agent count: the monitor setting
 * `include_unmatched`, the request flag, or the scope `all` (most of its projects have no rule, and `matched` stays a badge).
 */
export function unmatchedVisible(
  config: ScopeConfig,
  kind: InstanceKind,
  query: { readonly includeUnmatched?: boolean | undefined },
): boolean {
  return (
    query.includeUnmatched === true ||
    config.monitor.include_unmatched ||
    isAllScope(config.runtime.projects.scope, kind)
  );
}

/** The panels that read one repository: the user instance has none, so they stay off whatever `config.json` says. */
const REPOSITORY_PANELS: readonly string[] = [
  PANEL_CONFIG_KEY.git,
  PANEL_CONFIG_KEY.attempts,
  PANEL_CONFIG_KEY.ledger,
  PANEL_CONFIG_KEY.chainLog,
];

/** The panels as the instance offers them: those of `config.json`, minus the per-repository ones for the user instance. */
export function effectivePanels(
  panels: Readonly<Record<string, boolean>>,
  kind: InstanceKind,
): Readonly<Record<string, boolean>> {
  if (kind !== 'user') return panels;
  const effective: Record<string, boolean> = { ...panels };
  for (const key of REPOSITORY_PANELS) effective[key] = false;
  return effective;
}

const kindsByConfig = new WeakMap<ConfigFiles, InstanceKind>();

/**
 * The kind of the instance that a resolved configuration belongs to: the `kind` of the `instance.json` next to `config.json`
 * (`task` when the file or the key is absent or the file is damaged). It is read once per configuration object: the kind of an
 * instance is fixed for the life of the process.
 */
export function instanceKindOfConfig(config: ConfigFiles): InstanceKind {
  const known = kindsByConfig.get(config);
  if (known !== undefined) return known;
  const kind = readKind(config);
  kindsByConfig.set(config, kind);
  return kind;
}

function readKind(config: ConfigFiles): InstanceKind {
  const file = config.files.find((entry) => entry.name === 'config.json');
  if (file === undefined) return 'task';
  try {
    const instance = InstanceFileSchema.safeParse(
      JSON.parse(readFileSync(path.join(path.dirname(file.path), 'instance.json'), 'utf8')),
    );
    return instance.success ? instanceKindOf(instance.data) : 'task';
  } catch {
    return 'task';
  }
}
