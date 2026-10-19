// The install manifest `$MCS_HOME/hooks/installs.json` (02 3.5 step 11, ADR 0070): which settings files hold our entries, and
// with which Node executable and hook script. `hooks status` and `hooks verify` read it; install and uninstall keep it; the last
// uninstall removes it together with the stable copy of the hook script.
//
// The manifest is a register, not a source of truth: the settings files are. A manifest that is missing, damaged or out of
// date is read as empty (with a note) and repaired by the next `hooks install --yes`.
import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { HooksScopeSchema } from '@mcs/shared';
import { routeKey } from '@mcs/shared/protocol';
import { z } from 'zod';

import { atomicWriteFile, readSmallFile, unlinkWithRetry } from '../../platform/fsx.ts';
import { mutexName } from '../../platform/mutex.ts';

export const MANIFEST_VERSION = 1;
const MANIFEST_MAX_BYTES = 1024 * 1024;

/** One settings file that carries our entries. */
export const HookInstallRecordSchema = z.object({
  /** The settings file, forward slashes. */
  settingsPath: z.string().min(1),
  scope: HooksScopeSchema,
  op: z.literal('install'),
  /** Epoch ms of the install. */
  at: z.number(),
  /** Number of events installed. */
  events: z.number().int().nonnegative(),
  handlerVersion: z.string(),
  nodePath: z.string(),
  /** The stable copy the entries run. */
  hookEntryPath: z.string(),
  /** The four tool events run async (`false` after `--sync-tool-events`). */
  async: z.boolean(),
  /** The backup of the settings file this install replaced; `null` when the file was new. */
  backup: z.string().nullable(),
});

export type HookInstallRecord = z.infer<typeof HookInstallRecordSchema>;

export interface HooksManifest {
  readonly installs: Readonly<Record<string, HookInstallRecord>>;
}

const FileSchema = z.object({ v: z.literal(MANIFEST_VERSION), installs: z.record(z.string(), z.unknown()) });

export const EMPTY_MANIFEST: HooksManifest = { installs: {} };

/** `$MCS_HOME/hooks`: the manifest and the stable copy of the hook script live here. */
export function hooksFolder(mcsHome: string): string {
  return path.join(mcsHome, 'hooks');
}

export function manifestPath(mcsHome: string): string {
  return path.join(hooksFolder(mcsHome), 'installs.json');
}

/** The mutex that guards the manifest and the stable copy (the kind `settings`, keyed by the manifest path). */
export function manifestMutexName(mcsHome: string): string {
  return mutexName('settings', manifestPath(mcsHome));
}

/** The key of a settings file: its absolute path with forward slashes, in lower case where the file system ignores case. */
export function manifestKey(settingsPath: string): string {
  return routeKey(path.resolve(settingsPath));
}

export interface ManifestRead {
  readonly manifest: HooksManifest;
  /** Why the manifest was read as empty or partly dropped; `null` for a good file or no file. */
  readonly problem: string | null;
}

/** Reads the manifest. A missing file is an empty manifest; a damaged one is empty too, with `problem` saying so. */
export async function readManifest(mcsHome: string): Promise<ManifestRead> {
  let text: string;
  try {
    text = (await readSmallFile(manifestPath(mcsHome), MANIFEST_MAX_BYTES)).toString('utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { manifest: EMPTY_MANIFEST, problem: null };
    return { manifest: EMPTY_MANIFEST, problem: 'the manifest could not be read' };
  }
  let parsed: z.infer<typeof FileSchema>;
  try {
    parsed = FileSchema.parse(JSON.parse(text));
  } catch {
    return { manifest: EMPTY_MANIFEST, problem: 'the manifest is not valid' };
  }
  const installs: Record<string, HookInstallRecord> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(parsed.installs)) {
    const record = HookInstallRecordSchema.safeParse(value);
    if (record.success) installs[key] = record.data;
    else dropped += 1;
  }
  return {
    manifest: { installs },
    problem: dropped === 0 ? null : `${String(dropped)} manifest entries are not valid and were ignored`,
  };
}

/** Writes the manifest atomically (mode 0600). */
export async function writeManifest(mcsHome: string, manifest: HooksManifest): Promise<void> {
  await mkdir(hooksFolder(mcsHome), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify({ v: MANIFEST_VERSION, installs: manifest.installs }, null, 2)}\n`;
  await atomicWriteFile(manifestPath(mcsHome), text, { mode: 0o600 });
}

/** Deletes the manifest file (and the `hooks` folder when nothing else is in it). */
export async function removeManifest(mcsHome: string): Promise<void> {
  await unlinkWithRetry(manifestPath(mcsHome));
  try {
    await rmdir(hooksFolder(mcsHome));
  } catch {
    // The folder holds something else (the stable copy of the script) or is gone already.
  }
}

export function withInstall(manifest: HooksManifest, record: HookInstallRecord): HooksManifest {
  return { installs: { ...manifest.installs, [manifestKey(record.settingsPath)]: record } };
}

export function withoutInstall(manifest: HooksManifest, settingsPath: string): HooksManifest {
  const key = manifestKey(settingsPath);
  return { installs: Object.fromEntries(Object.entries(manifest.installs).filter(([k]) => k !== key)) };
}

export function findInstall(manifest: HooksManifest, settingsPath: string): HookInstallRecord | undefined {
  return manifest.installs[manifestKey(settingsPath)];
}

export function hasInstall(manifest: HooksManifest, settingsPath: string): boolean {
  return Object.hasOwn(manifest.installs, manifestKey(settingsPath));
}

/** The installs in the order of their settings paths. */
export function installsOf(manifest: HooksManifest): HookInstallRecord[] {
  return Object.values(manifest.installs).sort((a, b) => (a.settingsPath < b.settingsPath ? -1 : 1));
}

/**
 * Whether an uninstall of `settingsPath` removes the stable copy of the hook script (ADR 0070 item 4): only when the manifest
 * knew of installs and this was the last one. A manifest that is empty (lost, damaged) cannot tell whether another settings
 * file still runs the copy, so the copy stays.
 */
export function removesLastInstall(before: HooksManifest, settingsPath: string): boolean {
  return Object.keys(before.installs).length > 0 && installsOf(withoutInstall(before, settingsPath)).length === 0;
}
