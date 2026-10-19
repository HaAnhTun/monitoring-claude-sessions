// `hooks verify` as the engine runs it (02 3.7; ADR 0014, ADR 0070): seven checks that prove what Claude Code will run. It
// never writes a settings file, never starts Claude Code and never runs anything but the command that the settings file names.
//
//   V1 the settings file parses               V5 the route file takes this instance's transcripts folder
//   V2 one entry of ours for each event       V6 a synthetic probe through the installed Notification entry reaches the spool
//   V3 the paths are current                  V7 the running server committed the probe (`ok: null` while it is stopped)
//   V4 the handler prints this version
//
// V4 and V6 start EXACTLY the `command` and `args` of the installed entry (V4 only adds `--version` in place of the event), with
// `MCS_HOME` pointed at the folder under verification, so a pass proves the stable path works. Every path comes from the settings
// file or from `MCS_HOME`; the bundled script is only compared by hash (V3) and is never run. Text that comes from a settings
// file or a child (event names, paths, output) is shortened and cleaned before it is put in a detail, and the output of a child
// is never quoted at all.
//
// The probe is a `Notification` of type `mcs_probe` for a session id of the probe family (`PROBE_SESSION_PREFIX`). The handler
// writes it to the spool as an envelope of kind `probe`, which the server stores as a `hook_probes` row and never as a session.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { HookProbeResultSchema, McsError, buildPath, routes } from '@mcs/shared';
import type { HooksVerifyResult } from '@mcs/shared';
import {
  HANDLER_VERSION,
  INSTALLED_HOOK_EVENTS,
  PROBE_NOTIFICATION_TYPE,
  PROBE_SESSION_PREFIX,
  matchRoute,
  normalizePath,
  routeKey,
  spoolSegmentName,
  type EnvLike,
  type HookRouteV1,
  type RouteMatchIds,
} from '@mcs/shared/protocol';

import { readRouteFile, routeFilePath } from '../../ingest/routes-file.ts';
import { httpGet as loopbackGet, isLoopbackBase, type HttpAttempt } from '../../ops/probe.ts';
import { execFileText, type ChildResult, type ChildSpec } from '../../platform/exec.ts';
import { samePath } from '../../platform/paths.ts';
import { readFileTail, wholeLines } from './handler-log.ts';
import { HOOK_MARKER, ourHandlers, parseSettings } from './plan.ts';
import { hookScriptState, inspectHookScript, stableScriptPath } from './script-copy.ts';
import { assertNotRealInTest, decodeSettings, realSettingsIo, type SettingsIo } from './settings-io.ts';

/** V6: the whole probe run, process start to exit, must stay below this (the handler's own hard exit is 1200 ms). */
export const PROBE_TIMEOUT_MS = 1500;
/** V4: `--version` must answer within this. */
export const VERSION_TIMEOUT_MS = 2000;
/** V7: how long the server gets to commit the probe, and how often it is asked. */
export const ROUND_TRIP_MS = 3000;
export const ROUND_TRIP_POLL_MS = 100;
/** V6 looks for the probe in this many bytes at the end of a spool segment. */
export const SPOOL_SCAN_BYTES = 64 * 1024;
/** Output that a hook handler may print before it is killed; a healthy one prints nothing (V6) or one line (V4). */
export const VERIFY_OUTPUT_CAP = 8 * 1024;
/** The probe goes through the child's stdin, which allows at most this many bytes (`ChildSpec.stdin`). */
export const PROBE_PAYLOAD_MAX_BYTES = 4096;

type Check = HooksVerifyResult['checks'][number];
type CheckId = Check['check'];

/** What a test replaces. */
export interface VerifySeams {
  readonly io: Pick<SettingsIo, 'read'>;
  readonly exec: (spec: ChildSpec) => Promise<ChildResult>;
  readonly httpGet: (
    url: string,
    options: { readonly timeoutMs: number; readonly maxBytes?: number },
  ) => Promise<HttpAttempt>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Epoch ms. */
  readonly now: () => number;
  /** `n` random bytes as lower case hex. */
  readonly randomHex: (n: number) => string;
  /** The folder the test guard compares with (default `os.tmpdir()`). */
  readonly tmpdir?: () => string;
  /** Longer limits for a test that starts real processes on a loaded machine. The defaults are the limits of the design. */
  readonly limits?: { readonly probeMs?: number; readonly versionMs?: number };
}

/** The instance whose hooks are verified. */
export interface VerifyInstance {
  /** Lower case uuid: the name of its route file. */
  readonly instanceId: string;
  /** The transcripts folder the route lists (the resolved one, or the predicted one while none is found). */
  readonly transcriptsDir: string;
  /** The repository folder: the `cwd` of the probe. */
  readonly repoDir: string;
}

export interface VerifyHooksInput {
  /** Absolute path of the settings file to verify (`settingsPathFor(scope, ...)` or `--settings-file`). */
  readonly settingsPath: string;
  /** `resolveMcsHome(env)`: the stable copy, the route files and the spool lookup start here. */
  readonly mcsHome: string;
  /** The environment of the command; `MCS_TEST` and `VITEST` in it turn the test guard on. */
  readonly env: EnvLike;
  readonly instance: VerifyInstance;
  /** The bundled hook script, to tell a stale copy in V3. Without it V3 only checks that the copy exists. */
  readonly source?: string | null;
  /** `http://127.0.0.1:<port>` of the instance's server while it runs (V7); `null` or absent while it is stopped. */
  readonly serverBase?: string | null;
  readonly seams?: Partial<VerifySeams>;
}

function seamsOf(over: Partial<VerifySeams> | undefined): VerifySeams {
  return {
    io: realSettingsIo,
    exec: (spec) => execFileText(spec),
    httpGet: loopbackGet,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    randomHex: (n) => randomBytes(n).toString('hex'),
    ...over,
  };
}

// ---- small helpers -------------------------------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Printable ASCII only and at most `max` characters: text from a settings file or a child never reaches a terminal as it is. */
function shown(value: string, max = 80): string {
  const limit = Math.min(value.length, max);
  let out = '';
  for (let i = 0; i < limit; i += 1) {
    const code = value.charCodeAt(i);
    out += code >= 0x20 && code <= 0x7e ? value.charAt(i) : '?';
  }
  return value.length > max ? `${out}...` : out;
}

/** `A, B, C and 3 more` */
function listed(items: readonly string[], limit = 4): string {
  const head = items.slice(0, limit).map((item) => shown(item, 40));
  return items.length > limit ? `${head.join(', ')} and ${String(items.length - limit)} more` : head.join(', ');
}

function absolute(file: string, what: string): string {
  if (!path.isAbsolute(file)) {
    throw new McsError('USAGE', `the ${what} must be an absolute path`, { details: { value: file.slice(0, 200) } });
  }
  return path.resolve(file);
}

const done = (check: CheckId, ok: boolean | null, detail: string): Check => ({ check, ok, detail });

const REPAIR = 'run hooks install --yes to repair it';

/** The command of an entry in exec form, and what comes before the marker (`--no-warnings <script>`); `null` for anything else. */
interface ExecForm {
  readonly command: string;
  readonly args: readonly string[];
  /** The arguments before `--mcs-hook`: the Node flags and, last, the script. */
  readonly prefix: readonly string[];
  readonly script: string;
}

function execFormOf(handler: unknown): ExecForm | null {
  if (!isPlainObject(handler)) return null;
  const command = handler['command'];
  const args = handler['args'];
  if (typeof command !== 'string' || !Array.isArray(args)) return null;
  const list: unknown[] = args;
  if (!list.every((arg): arg is string => typeof arg === 'string')) return null;
  const strings: string[] = list.filter((arg): arg is string => typeof arg === 'string');
  const marker = strings.indexOf(HOOK_MARKER);
  if (marker < 1) return null;
  const prefix = strings.slice(0, marker);
  const script = prefix[prefix.length - 1];
  return script === undefined ? null : { command, args: strings, prefix, script };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function failure(result: ChildResult, limitMs: number): string | null {
  switch (result.error) {
    case null:
      return null;
    case 'TIMEOUT':
      return `did not finish within ${String(limitMs)} ms and was killed`;
    case 'OUTPUT_LIMIT':
      return `printed more than ${String(VERIFY_OUTPUT_CAP)} bytes and was killed (a hook handler prints almost nothing)`;
    case 'NONZERO_EXIT':
      return `exited with code ${result.code === null ? '?' : String(result.code)} (a hook handler always exits 0)`;
    case 'ABORTED':
    case 'EACCES':
    case 'ENOENT':
    case 'QUEUE_FULL':
    case 'SPAWN_FAILED':
      return `could not be started (${result.error})`;
  }
}

// ---- V1 and V2: the settings file ------------------------------------------------------------------------------------------------

type Loaded =
  { readonly ok: true; readonly settings: Record<string, unknown> } | { readonly ok: false; readonly detail: string };

async function loadSettings(io: Pick<SettingsIo, 'read'>, file: string): Promise<Loaded> {
  try {
    const snapshot = await io.read(file);
    if (snapshot.bytes === null) return { ok: false, detail: 'the settings file does not exist' };
    const settings = parseSettings(decodeSettings(snapshot.bytes));
    if (Object.hasOwn(settings, 'hooks') && !isPlainObject(settings['hooks'])) {
      return { ok: false, detail: 'the "hooks" key of the settings file is not a JSON object' };
    }
    return { ok: true, settings };
  } catch (error) {
    if (error instanceof McsError) return { ok: false, detail: error.message.replace(/; nothing was written$/, '') };
    return { ok: false, detail: 'the settings file could not be read' };
  }
}

function checkEntries(ours: ReadonlyMap<string, unknown[]>): Check {
  const wanted: readonly string[] = INSTALLED_HOOK_EVENTS;
  const missing = wanted.filter((event) => (ours.get(event)?.length ?? 0) === 0);
  const twice = wanted.filter((event) => (ours.get(event)?.length ?? 0) > 1);
  const extra = [...ours.keys()].filter((event) => !wanted.includes(event));
  if (missing.length + twice.length + extra.length === 0) {
    return done('V2', true, `one entry of ours for each of the ${String(wanted.length)} events`);
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`no entry for ${listed(missing)}`);
  if (twice.length > 0) parts.push(`more than one entry for ${listed(twice)}`);
  if (extra.length > 0) parts.push(`entries of ours on other events: ${listed(extra)}`);
  return done('V2', false, `${parts.join('; ')}; ${REPAIR}`);
}

// ---- V3: the paths -------------------------------------------------------------------------------------------------------------------

async function checkPaths(
  entries: readonly unknown[],
  mcsHome: string,
  source: string | null | undefined,
): Promise<Check> {
  const problems: string[] = [];
  const commands = new Set<string>();
  const scripts = new Set<string>();
  let shellForm = 0;
  for (const entry of entries) {
    const form = execFormOf(entry);
    if (form === null) shellForm += 1;
    else {
      commands.add(form.command);
      scripts.add(form.script);
    }
  }
  if (shellForm > 0) {
    problems.push(`${String(shellForm)} entries are not in the exec form (command plus args) that install writes`);
  }
  for (const command of commands) {
    if (!path.isAbsolute(command)) problems.push(`the command ${shown(command)} is not an absolute path`);
    else if (!(await isFile(command))) problems.push(`the Node executable ${shown(command)} does not exist`);
  }
  const stable = stableScriptPath(mcsHome);
  for (const script of scripts) {
    if (!samePath(script, stable)) {
      problems.push(`an entry runs ${shown(script)} instead of the stable copy ${shown(stable)}`);
    }
  }

  const copy = await inspectHookScript(mcsHome).catch(() => null);
  let note = '';
  let compared = false;
  if (copy === null) problems.push('the stable copy of the hook script cannot be looked at');
  else if (copy.kind === 'missing') problems.push(`the stable copy of the hook script is missing (${shown(stable)})`);
  else if (copy.kind === 'link')
    problems.push('the stable copy of the hook script is a link; install writes a real file');
  else if (source === undefined || source === null) note = '; the bundled script was not compared';
  else {
    const state = await hookScriptState({ source, mcsHome });
    if (state === 'stale') {
      problems.push('the stable copy differs from the bundled script (a plugin update?) or is a link');
    } else if (state === 'unknown') note = '; the bundled script could not be read, so the copy was not compared';
    else compared = true;
  }

  if (problems.length > 0) return done('V3', false, `${problems.slice(0, 4).join('; ')}; ${REPAIR}`);
  return done(
    'V3',
    true,
    `the Node executable and the stable copy exist${compared ? ' and the copy matches the bundled script' : ''}${note}`,
  );
}

// ---- V4: the version --------------------------------------------------------------------------------------------------------------------

async function checkVersion(form: ExecForm, seams: VerifySeams): Promise<Check> {
  const limit = seams.limits?.versionMs ?? VERSION_TIMEOUT_MS;
  let result: ChildResult | null;
  try {
    result = await seams.exec({
      kind: 'node',
      file: form.command,
      // exactly the installed command up to the script, then the one flag that makes the handler print its version
      args: [...form.prefix, '--version'],
      timeoutMs: limit,
      maxOutputBytes: VERIFY_OUTPUT_CAP,
      encoding: 'utf8',
    });
  } catch {
    result = null;
  }
  if (result === null) return done('V4', false, 'the installed command could not be run');
  const problem = failure(result, limit);
  if (problem !== null) return done('V4', false, `the installed command ${problem}`);
  const printed = result.stdout.trim();
  if (printed !== HANDLER_VERSION) {
    return done(
      'V4',
      false,
      `the installed handler prints "${shown(printed, 32)}" but this runtime is ${HANDLER_VERSION}; ${REPAIR}`,
    );
  }
  return done(
    'V4',
    true,
    `the installed handler is version ${HANDLER_VERSION} (${String(Math.round(result.durationMs))} ms)`,
  );
}

// ---- V5: the route file --------------------------------------------------------------------------------------------------------------

function probeIdentity(instance: VerifyInstance, probeId: string): { transcriptPath: string; ids: RouteMatchIds } {
  const transcriptPath = `${normalizePath(instance.transcriptsDir)}/${probeId}.jsonl`;
  return { transcriptPath, ids: { session_id: probeId, transcript_path: transcriptPath, cwd: instance.repoDir } };
}

function checkRoute(
  route: HookRouteV1 | null,
  routeExists: boolean,
  instance: VerifyInstance,
  probeId: string,
  now: number,
): Check {
  if (route === null) {
    return done(
      'V5',
      false,
      routeExists
        ? 'the route file of the instance is not a valid version 1 route'
        : 'there is no route file for the instance: the monitor writes it when it starts',
    );
  }
  if (!route.enabled) {
    return done('V5', false, 'the route is disabled (hooks are switched off for this instance)');
  }
  const { ids } = probeIdentity(instance, probeId);
  if (matchRoute(route, ids, now) !== null) {
    return done(
      'V5',
      true,
      route.stoppedAt === null
        ? 'the route lists the transcripts folder of the instance'
        : 'the route lists the transcripts folder; the instance is stopped but still spools',
    );
  }
  if (route.stoppedAt !== null && !(route.spoolUntil !== null && now < route.spoolUntil)) {
    return done('V5', false, 'the instance is stopped and its spool window is over, so hook events are dropped');
  }
  if (!route.match.transcriptsDirs.includes(routeKey(instance.transcriptsDir))) {
    return done('V5', false, 'the route does not list the transcripts folder of the instance');
  }
  return done('V5', false, 'the route does not take events of the instance');
}

// ---- V6: the probe ---------------------------------------------------------------------------------------------------------------------

/** The stdin payload of the probe (02 3.7). */
export function probePayload(instance: VerifyInstance, probeId: string): string {
  return JSON.stringify({
    session_id: probeId,
    transcript_path: probeIdentity(instance, probeId).transcriptPath,
    cwd: normalizePath(instance.repoDir),
    hook_event_name: 'Notification',
    notification_type: PROBE_NOTIFICATION_TYPE,
    message: 'mcs probe',
  });
}

/** The segment (of `segments`) whose last 64 KiB hold the probe envelope, or `null`. */
async function probeInSpool(spoolDir: string, segments: readonly string[], probeId: string): Promise<string | null> {
  for (const name of segments) {
    const tail = await readFileTail(path.join(spoolDir, name), SPOOL_SCAN_BYTES);
    if (tail === null) continue;
    for (const text of wholeLines(tail)) {
      if (!text.includes(probeId)) continue;
      try {
        const line: unknown = JSON.parse(text);
        if (isPlainObject(line) && line['kind'] === 'probe' && line['session_id'] === probeId) return name;
      } catch {
        // a torn line; the next one may be whole
      }
    }
  }
  return null;
}

async function checkProbe(
  form: ExecForm,
  route: HookRouteV1 | null,
  instance: VerifyInstance,
  probeId: string,
  mcsHome: string,
  seams: VerifySeams,
): Promise<{ readonly check: Check; readonly spooled: boolean }> {
  const payload = probePayload(instance, probeId);
  if (Buffer.byteLength(payload, 'utf8') > PROBE_PAYLOAD_MAX_BYTES) {
    return {
      check: done(
        'V6',
        false,
        `the probe is longer than ${String(PROBE_PAYLOAD_MAX_BYTES)} bytes (the paths are too long)`,
      ),
      spooled: false,
    };
  }
  const limit = seams.limits?.probeMs ?? PROBE_TIMEOUT_MS;
  const startedAt = seams.now();
  let result: ChildResult | null;
  try {
    result = await seams.exec({
      kind: 'node',
      file: form.command,
      args: [...form.args],
      timeoutMs: limit,
      maxOutputBytes: VERIFY_OUTPUT_CAP,
      encoding: 'utf8',
      // the handler finds its routes through MCS_HOME, and the recursion guard of our own children is switched off for it
      extraEnv: { MCS_HOME: mcsHome, MCS_HOOK_DISABLE: '0' },
      stdin: payload,
    });
  } catch {
    result = null;
  }
  const endedAt = seams.now();
  if (result === null) {
    return { check: done('V6', false, 'the installed Notification entry could not be run'), spooled: false };
  }
  const problem = failure(result, limit);
  if (problem !== null) {
    return { check: done('V6', false, `the installed Notification entry ${problem}`), spooled: false };
  }
  if (result.stdout.length > 0 || result.stderr.length > 0) {
    return {
      check: done(
        'V6',
        false,
        `the handler printed ${String(Buffer.byteLength(result.stdout))} bytes to stdout and ${String(Buffer.byteLength(result.stderr))} to stderr (a hook handler prints nothing)`,
      ),
      spooled: false,
    };
  }
  if (result.durationMs >= limit) {
    return {
      check: done(
        'V6',
        false,
        `the handler took ${String(Math.round(result.durationMs))} ms (the limit is ${String(limit)})`,
      ),
      spooled: false,
    };
  }

  // The envelope is in the segment of the UTC hour in which the handler started; look in the hour of both ends of the run.
  const usable = route !== null && route.spoolDir === `${route.workspace}/data/spool`;
  const segments = [...new Set([spoolSegmentName(startedAt), spoolSegmentName(endedAt)])];
  const found = usable ? await probeInSpool(route.spoolDir, segments, probeId) : null;
  if (found === null) {
    return {
      check: done(
        'V6',
        false,
        usable
          ? 'the handler ran cleanly but the probe did not reach the spool of the instance'
          : 'the handler ran cleanly but there is no usable route file, so it had nowhere to spool the probe',
      ),
      spooled: false,
    };
  }
  return {
    check: done(
      'V6',
      true,
      `exit 0 in ${String(Math.round(result.durationMs))} ms, no output; the probe is in ${found}`,
    ),
    spooled: true,
  };
}

// ---- V7: the server ----------------------------------------------------------------------------------------------------------------------

async function checkRoundTrip(
  serverBase: string | null | undefined,
  probeId: string,
  seams: VerifySeams,
): Promise<Check> {
  if (serverBase === undefined || serverBase === null) {
    return done('V7', null, 'the server is not running, so the round trip was not checked');
  }
  if (!isLoopbackBase(serverBase)) {
    return done('V7', false, 'the server address must be http://127.0.0.1:<port>; nothing was requested');
  }
  const url = `${serverBase}${buildPath(routes.ingestProbe, { probeSessionId: probeId })}`;
  const deadline = seams.now() + ROUND_TRIP_MS;
  for (;;) {
    const left = deadline - seams.now();
    let attempt: HttpAttempt;
    try {
      attempt = await seams.httpGet(url, { timeoutMs: Math.max(100, Math.min(1000, left)), maxBytes: 4096 });
    } catch {
      return done('V7', false, 'the request to the server could not be made');
    }
    if (attempt.ok) {
      if (attempt.reply.status === 200) {
        let body: unknown;
        try {
          body = JSON.parse(attempt.reply.body);
        } catch {
          body = undefined;
        }
        const parsed = HookProbeResultSchema.safeParse(body);
        if (!parsed.success) return done('V7', false, 'the server answered 200 with a body that is not a probe result');
        const latency = Math.max(0, Date.parse(parsed.data.committedAt) - Date.parse(parsed.data.receivedAt));
        return done('V7', true, `the server committed the probe ${String(latency)} ms after the handler received it`);
      }
      // 404 probe_not_found means "not committed yet" (03 6.3)
      if (attempt.reply.status !== 404) {
        return done('V7', false, `the server answered ${String(attempt.reply.status)} to the probe lookup`);
      }
    } else if (attempt.reason === 'refused') {
      return done('V7', null, 'no server answered at the given address, so the round trip was not checked');
    }
    const remaining = deadline - seams.now();
    if (remaining <= 0) {
      return done('V7', false, `the server did not commit the probe within ${String(ROUND_TRIP_MS / 1000)} s`);
    }
    await seams.sleep(Math.min(ROUND_TRIP_POLL_MS, remaining));
  }
}

// ---- the run ------------------------------------------------------------------------------------------------------------------------------

/**
 * Runs checks V1 to V7 (02 3.7) and returns all seven, in order. A check that cannot run because an earlier one found nothing to
 * work on is `ok: null` with the reason ("skipped ..."). Throws `USAGE` for a relative path and `HOOKS_FAILED`
 * `REAL_SETTINGS_IN_TEST` for a settings file or `MCS_HOME` outside the temporary folder in test mode; a check that fails is a
 * result, never an exception.
 */
export async function verifyHooks(input: VerifyHooksInput): Promise<HooksVerifyResult> {
  const seams = seamsOf(input.seams);
  const settingsPath = absolute(input.settingsPath, 'settings file');
  const mcsHome = absolute(input.mcsHome, 'MCS_HOME');
  assertNotRealInTest({
    env: input.env,
    targets: [
      { label: 'settings file', path: settingsPath },
      { label: 'MCS_HOME', path: mcsHome },
    ],
    ...(seams.tmpdir === undefined ? {} : { tmpdir: seams.tmpdir }),
  });
  const probeId = `${PROBE_SESSION_PREFIX}${seams.randomHex(6)}`;
  const skipped = (check: CheckId, why: string): Check => done(check, null, `skipped: ${why}`);

  // V1
  const loaded = await loadSettings(seams.io, settingsPath);
  const v1 = done('V1', loaded.ok, loaded.ok ? 'the settings file parses' : loaded.detail);

  // V2, and the entries the next checks work on
  const ours = loaded.ok ? ourHandlers(loaded.settings) : new Map<string, unknown[]>();
  const wanted: readonly string[] = INSTALLED_HOOK_EVENTS;
  const entries = wanted.flatMap((event) => ours.get(event) ?? []);
  const v2 = loaded.ok ? checkEntries(ours) : skipped('V2', 'the settings file did not parse');
  const noEntries = (check: CheckId): Check =>
    skipped(check, loaded.ok ? 'the settings file holds no entry of ours' : 'the settings file did not parse');

  // V3
  const v3 = entries.length === 0 ? noEntries('V3') : await checkPaths(entries, mcsHome, input.source);

  // V4 runs one installed entry (the Notification one, or any other when that is missing)
  const notification = ours.get('Notification')?.[0];
  const notificationForm = execFormOf(notification);
  const exemplar = notificationForm ?? execFormOf(entries.find((entry) => execFormOf(entry) !== null));
  const v4 =
    exemplar === null
      ? skipped('V4', entries.length === 0 ? 'there is no entry to run' : 'no entry is in the exec form')
      : await checkVersion(exemplar, seams);

  // V5 reads the route of the instance; it does not depend on the settings file
  const route = readRouteFile(mcsHome, input.instance.instanceId);
  const routeExists = route !== null || routeFileExists(mcsHome, input.instance.instanceId);
  const v5 = checkRoute(route, routeExists, input.instance, probeId, seams.now());

  // V6
  let v6: Check;
  let spooled = false;
  if (notificationForm === null) {
    v6 = skipped(
      'V6',
      notification === undefined
        ? 'there is no Notification entry to run'
        : 'the Notification entry is not in the exec form',
    );
  } else {
    const probe = await checkProbe(notificationForm, route, input.instance, probeId, mcsHome, seams);
    v6 = probe.check;
    spooled = probe.spooled;
  }

  // V7
  const v7 = spooled
    ? await checkRoundTrip(input.serverBase, probeId, seams)
    : input.serverBase === undefined || input.serverBase === null
      ? done('V7', null, 'the server is not running, so the round trip was not checked')
      : skipped('V7', 'the probe did not reach the spool');

  return { checks: [v1, v2, v3, v4, v5, v6, v7] };
}

/** Whether a file is at the route path of the instance, valid or not. */
function routeFileExists(mcsHome: string, instanceId: string): boolean {
  try {
    return existsSync(routeFilePath(mcsHome, instanceId));
  } catch {
    return false;
  }
}
