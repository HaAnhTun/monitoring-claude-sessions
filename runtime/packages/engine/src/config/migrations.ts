// Explicit file migrations (01 section 2.7). The registry is empty in v1: adding version 2 of a file means one step here,
// its tests and its documentation. `mcs config migrate` (WP-62) plans with `planFileMigrations`, applies with
// `applyMigrations` and writes the results itself.
//
// A `config.json` step must keep the file readable by the legacy engine or bump its `schema_version`; the legacy engine
// then refuses the file safely, which is the designed behaviour (research F.3).
import { McsError } from '@mcs/shared';

import type { PyJsonValue } from '../pyjson/index.ts';

export type MigratedFile = 'config.json' | 'runtime.json' | 'instance.json';

export interface FileMigration {
  readonly file: MigratedFile;
  readonly from: number;
  readonly to: number;
  readonly describe: string;
  apply(doc: PyJsonValue): PyJsonValue;
}

export const FILE_MIGRATIONS: readonly FileMigration[] = [];

/** Every file starts at version 1 (the only version that has ever shipped). */
const BASE_VERSION = 1;

/** The newest version the registry can produce for `file`: the highest `to` of its steps, else version 1. */
export function latestFileVersion(file: MigratedFile, registry: readonly FileMigration[] = FILE_MIGRATIONS): number {
  let latest = BASE_VERSION;
  for (const step of registry) if (step.file === file && step.to > latest) latest = step.to;
  return latest;
}

function unsupported(file: MigratedFile, version: number, latest: number): McsError {
  return new McsError(
    'CONFIG_SCHEMA_UNSUPPORTED',
    `${file} uses schema_version ${String(version)} but this skill supports up to ${String(latest)}; update the skill`,
    { hint: 'A file written by a newer version cannot be migrated down; update the skill instead.' },
  );
}

/**
 * The chain of steps that takes `file` from `current` to its newest version, in order. An empty list means nothing to
 * do. A version that is not an integer >= 1, or lies beyond the newest version, is `CONFIG_SCHEMA_UNSUPPORTED`.
 */
export function planFileMigrations(
  file: MigratedFile,
  current: number,
  registry: readonly FileMigration[] = FILE_MIGRATIONS,
): FileMigration[] {
  const latest = latestFileVersion(file, registry);
  if (!Number.isInteger(current) || current < BASE_VERSION || current > latest)
    throw unsupported(file, current, latest);
  const chain: FileMigration[] = [];
  let version = current;
  while (version < latest) {
    const next = registry.find((step) => step.file === file && step.from === version);
    if (next === undefined) throw unsupported(file, current, latest);
    chain.push(next);
    version = next.to;
  }
  return chain;
}

/** Runs the planned steps in order in memory; the input document is not modified. No step returns the same document. */
export function applyMigrations(doc: PyJsonValue, steps: readonly FileMigration[]): PyJsonValue {
  let out = doc;
  for (const step of steps) out = step.apply(out);
  return out;
}

/**
 * Checks the registry itself: every step moves forward by exactly one version, no two steps leave the same version of a
 * file, and the steps of a file form one chain starting at version 1. Used by the tests and by `doctor`.
 */
export function assertMigrationRegistry(registry: readonly FileMigration[]): void {
  const seen = new Set<string>();
  for (const step of registry) {
    if (!Number.isInteger(step.from) || step.to !== step.from + 1) {
      throw new Error(
        `migration ${step.file} ${String(step.from)} -> ${String(step.to)} must move forward by exactly one version`,
      );
    }
    const id = `${step.file}@${String(step.from)}`;
    if (seen.has(id))
      throw new Error(`two migrations of ${step.file} start at version ${String(step.from)} (${id} twice)`);
    seen.add(id);
  }
  for (const file of new Set(registry.map((s) => s.file))) {
    const latest = latestFileVersion(file, registry);
    for (let v = BASE_VERSION; v < latest; v += 1) {
      if (!seen.has(`${file}@${String(v)}`))
        throw new Error(`migrations of ${file} have a gap: nothing leaves version ${String(v)}`);
    }
  }
}
