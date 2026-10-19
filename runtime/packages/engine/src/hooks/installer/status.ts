// `hooks status` as the engine computes it (02 3.1, ADR 0070): which settings files carry our entries, whether the stable copy of
// the hook script is current, what the handler's own log says, and when each instance last received an envelope. It reads and
// never writes: no settings file, no manifest, no folder is created or changed.
//
// What is trusted. The settings files are the source of truth for what is installed; the manifest is a register that names the
// files to look at and the Node and handler version that were installed. Nothing the manifest or a route file says is used as
// a path to run or to hash: the stable copy is always `$MCS_HOME/hooks/mcs-hook.mjs`, and a spool folder is looked at only when
// the route names exactly `<workspace>/data/spool`. In test mode a settings file named by the manifest that lies outside the
// temporary folder is not opened at all (the test guard of ADR 0070 item 6).
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import type { HookScriptState, HooksScope, HooksStatusResult } from '@mcs/shared';
import { INSTALLED_HOOK_EVENTS, ROUTES_MAX_FILES, normalizePath, type EnvLike } from '@mcs/shared/protocol';

import { listSegments } from '../../ingest/spool/segments.ts';
import { readRouteFile } from '../../ingest/routes-file.ts';
import { summarizeHandlerLog, handlerLogPath } from './handler-log.ts';
import { installsOf, manifestKey, readManifest, type HookInstallRecord } from './manifest.ts';
import { ourHandlers, parseSettings } from './plan.ts';
import { hookScriptState, inspectHookScript, stableScriptPath, type HookScriptCopy } from './script-copy.ts';
import { assertNotRealInTest, decodeSettings, realSettingsIo, type SettingsIo } from './settings-io.ts';

/** A settings file to look at besides the ones the manifest names: the known scopes of the repository and of the user. */
export interface HooksScanTarget {
  readonly scope: HooksScope;
  /** Absolute path of the settings file (`settingsPathFor(scope, ...)`). */
  readonly settingsPath: string;
}

/** What a test replaces. */
export interface StatusSeams {
  readonly io: Pick<SettingsIo, 'read'>;
  /** The folder the test guard compares with (default `os.tmpdir()`). */
  readonly tmpdir?: () => string;
}

export interface HooksStatusInput {
  /** `resolveMcsHome(env)`: the manifest, the stable copy, the log and the route files live here. */
  readonly mcsHome: string;
  /** The environment of the command; `MCS_TEST` and `VITEST` in it turn the test guard on. */
  readonly env: EnvLike;
  /** Settings files to scan in addition to the manifest's. A file with none of our entries is left out of the result. */
  readonly scan?: readonly HooksScanTarget[];
  /** The bundled hook script (`mcs-hook.mjs` of the bundle layout), to tell a stale copy. Without it the state is `unknown`. */
  readonly source?: string | null;
  /** Report these instances in `lastEnvelopeAt` (each, `null` when unknown). Default: every valid route file of `MCS_HOME`. */
  readonly instanceIds?: readonly string[];
  readonly seams?: Partial<StatusSeams>;
}

const UUID_JSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]json$/;
const UNKNOWN_VERSION = 'unknown';

function absolute(file: string, what: string): string {
  if (!path.isAbsolute(file)) {
    throw new McsError('USAGE', `the ${what} must be an absolute path`, { details: { value: file.slice(0, 200) } });
  }
  return path.resolve(file);
}

/** How many of the 21 installed events have one of our handlers in the file; 0 for a file that is gone, too large or damaged. */
async function eventsIn(io: Pick<SettingsIo, 'read'>, file: string): Promise<number> {
  try {
    const snapshot = await io.read(file);
    if (snapshot.bytes === null) return 0;
    const ours = ourHandlers(parseSettings(decodeSettings(snapshot.bytes)));
    return INSTALLED_HOOK_EVENTS.filter((event) => ours.has(event)).length;
  } catch {
    return 0;
  }
}

function insideTestRoot(env: EnvLike, tmpdir: (() => string) | undefined, file: string): boolean {
  try {
    assertNotRealInTest({
      env,
      targets: [{ label: 'settings file', path: file }],
      ...(tmpdir === undefined ? {} : { tmpdir }),
    });
    return true;
  } catch {
    return false;
  }
}

interface Candidate {
  readonly settingsPath: string;
  readonly scope: HooksScope;
  readonly record: HookInstallRecord | null;
}

async function installsOfStatus(
  input: HooksStatusInput,
  io: Pick<SettingsIo, 'read'>,
  records: readonly HookInstallRecord[],
  scan: readonly HooksScanTarget[],
): Promise<HooksStatusResult['installs']> {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const record of records) {
    seen.add(manifestKey(record.settingsPath));
    candidates.push({ settingsPath: record.settingsPath, scope: record.scope, record });
  }
  for (const target of scan) {
    const key = manifestKey(target.settingsPath);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ settingsPath: normalizePath(target.settingsPath), scope: target.scope, record: null });
  }
  const installs: HooksStatusResult['installs'] = [];
  for (const candidate of candidates) {
    // a path from the manifest is data of a file: it is opened only when it is absolute and, in test mode, inside the temporary folder
    const openable =
      path.isAbsolute(candidate.settingsPath) &&
      (candidate.record === null || insideTestRoot(input.env, input.seams?.tmpdir, candidate.settingsPath));
    const events = openable ? await eventsIn(io, candidate.settingsPath) : 0;
    if (candidate.record === null && events === 0) continue;
    installs.push({
      settingsPath: candidate.settingsPath,
      scope: candidate.scope,
      events,
      handlerVersion: candidate.record?.handlerVersion ?? UNKNOWN_VERSION,
      at: candidate.record?.at ?? 0,
    });
  }
  return installs.sort((a, b) => (a.settingsPath < b.settingsPath ? -1 : a.settingsPath > b.settingsPath ? 1 : 0));
}

async function scriptOf(
  input: HooksStatusInput,
  mcsHome: string,
  records: readonly HookInstallRecord[],
  anyInstall: boolean,
): Promise<HooksStatusResult['script']> {
  const where = stableScriptPath(mcsHome);
  let copy: HookScriptCopy | null;
  try {
    copy = await inspectHookScript(mcsHome);
  } catch {
    copy = null;
  }
  let state: HookScriptState;
  if (copy === null) state = 'unknown';
  else if (copy.kind === 'missing') state = anyInstall ? 'missing' : 'not_installed';
  else if (input.source === undefined || input.source === null) state = 'unknown';
  else state = await hookScriptState({ source: input.source, mcsHome });
  // The version that was installed: the newest install of the manifest. The copy is never run to ask it (a path from the
  // manifest must not decide what runs), and only an install replaces the copy.
  const newest = records.reduce<HookInstallRecord | null>(
    (best, r) => (best === null || r.at > best.at ? r : best),
    null,
  );
  return {
    state,
    path: where,
    sha256: copy?.kind === 'file' ? copy.sha256 : null,
    handlerVersion: newest?.handlerVersion ?? null,
  };
}

async function newestSegmentMs(spoolDir: string, workspace: string): Promise<number | null> {
  // the same invariant the handler enforces: a route that names another folder is not ours to look into
  if (spoolDir !== `${workspace}/data/spool`) return null;
  try {
    const listing = await listSegments(spoolDir);
    let newest: number | null = null;
    for (const segment of listing.segments) if (newest === null || segment.mtimeMs > newest) newest = segment.mtimeMs;
    return newest;
  } catch {
    return null;
  }
}

async function lastEnvelopes(
  mcsHome: string,
  instanceIds: readonly string[] | undefined,
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  let ids: string[];
  if (instanceIds === undefined) {
    let names: string[];
    try {
      names = (await readdir(path.join(mcsHome, 'routes'))).filter((name) => UUID_JSON.test(name)).sort();
    } catch {
      names = [];
    }
    ids = names.slice(0, ROUTES_MAX_FILES).map((name) => name.slice(0, -'.json'.length));
  } else {
    ids = [...new Set(instanceIds)].slice(0, ROUTES_MAX_FILES);
  }
  for (const id of ids) {
    const route = readRouteFile(mcsHome, id);
    if (route === null) {
      if (instanceIds !== undefined) out[id] = null;
      continue;
    }
    out[id] = await newestSegmentMs(route.spoolDir, route.workspace);
  }
  return out;
}

/**
 * The status of the hooks on this machine (02 3.1). `installs` lists every settings file of the manifest (with the number of
 * our events that are really in it now, so a file edited by hand shows) and every scanned file that holds our entries.
 * Throws `USAGE` for a relative path and `HOOKS_FAILED` `REAL_SETTINGS_IN_TEST` for a scan target or `MCS_HOME` outside the
 * temporary folder in test mode; everything else that cannot be read is reported as missing or empty, never thrown.
 */
export async function hooksStatus(input: HooksStatusInput): Promise<HooksStatusResult> {
  const io = input.seams?.io ?? realSettingsIo;
  const mcsHome = absolute(input.mcsHome, 'MCS_HOME');
  const scan = (input.scan ?? []).map((target) => ({
    scope: target.scope,
    settingsPath: absolute(target.settingsPath, 'settings file'),
  }));
  assertNotRealInTest({
    env: input.env,
    targets: [
      { label: 'MCS_HOME', path: mcsHome },
      ...scan.map((target) => ({ label: 'settings file', path: target.settingsPath })),
    ],
    ...(input.seams?.tmpdir === undefined ? {} : { tmpdir: input.seams.tmpdir }),
  });

  const { manifest } = await readManifest(mcsHome);
  const records = installsOf(manifest);
  const installs = await installsOfStatus(input, io, records, scan);
  const [script, handlerLog, lastEnvelopeAt] = await Promise.all([
    scriptOf(input, mcsHome, records, installs.length > 0),
    summarizeHandlerLog(handlerLogPath(mcsHome)),
    lastEnvelopes(mcsHome, input.instanceIds),
  ]);
  return { installs, script, handlerLog, lastEnvelopeAt };
}
