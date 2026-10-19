// `verifyHooks` (02 3.7, T-IN-08, ADR 0070): the seven checks. The logic is tested with a scripted `exec` and `httpGet` (no process,
// no network, a clock that only moves when a test moves it); the failure modes of a real handler (it prints, it exits non-zero,
// it hangs, it floods its output) are tested with a few lines of Node as the stable copy. The real bundled handler and a real
// server socket are in `test/hooks-verify.int.test.ts`. Every test lives in a temporary world with the test guard on.
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { HooksVerifyResultSchema, routes } from '@mcs/shared';
import type { HooksVerifyResult } from '@mcs/shared';
import {
  HANDLER_VERSION,
  INSTALLED_HOOK_EVENTS,
  PROBE_SESSION_PREFIX,
  normalizePath,
  spoolSegmentName,
} from '@mcs/shared/protocol';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { HANDLER_V1, HANDLER_V2, makeHarness, treeOf, type Harness } from '../../../test/fixtures/settings/harness.ts';
import { writeRouteFile } from '../../ingest/routes-file.ts';
import type { HttpAttempt } from '../../ops/probe.ts';
import type { ChildResult, ChildSpec } from '../../platform/exec.ts';
import { stableScriptPath } from './script-copy.ts';
import {
  PROBE_PAYLOAD_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  ROUND_TRIP_MS,
  VERSION_TIMEOUT_MS,
  probePayload,
  verifyHooks,
  type VerifyHooksInput,
  type VerifyInstance,
  type VerifySeams,
} from './verify.ts';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 9, 20, 10, 30, 0);
const PROBE_ID = `${PROBE_SESSION_PREFIX}abcdef012345`;
const SERVER = 'http://127.0.0.1:18123';

// ---- a world -------------------------------------------------------------------------------------------------------------------

interface World {
  readonly h: Harness;
  readonly instance: VerifyInstance;
  readonly workspace: string;
  /** `<workspace>/data/spool` */
  readonly spool: string;
  readonly clock: { ms: number };
}

interface WorldOptions {
  /** The text of the bundled hook script (and so of the stable copy). */
  readonly script?: string;
  /** `process.execPath` by default; the Node of the entries. */
  readonly nodePath?: string;
  readonly route?: 'valid' | 'none';
  readonly install?: boolean;
}

async function world(options: WorldOptions = {}): Promise<World> {
  const h = makeHarness(makeTemp);
  if (options.script !== undefined) h.setSource(options.script);
  if (options.install !== false) await h.install({ nodePath: options.nodePath ?? process.execPath });
  const workspace = path.join(h.root, 'workspace');
  const transcriptsDir = path.join(h.root, 'projects', 'p');
  const repoDir = path.join(h.root, 'repo');
  for (const dir of [workspace, transcriptsDir, repoDir]) mkdirSync(dir, { recursive: true });
  if (options.route !== 'none') {
    await writeRouteFile(
      {
        instanceId: INSTANCE_ID,
        instanceDir: workspace,
        mcsHome: h.mcsHome,
        repoDir,
        hooksEnabled: true,
        sessionIds: [],
        transcriptsDir,
        projectsRoot: path.join(h.root, 'projects'),
      },
      { stoppedAt: null },
      { now: NOW },
    );
  }
  return {
    h,
    instance: { instanceId: INSTANCE_ID, transcriptsDir, repoDir },
    workspace,
    spool: path.join(workspace, 'data', 'spool'),
    clock: { ms: NOW },
  };
}

function child(over: Partial<ChildResult> = {}): ChildResult {
  const error = over.error ?? null;
  return {
    ok: error === null && (over.code ?? 0) === 0,
    code: error === null ? 0 : null,
    stdout: '',
    stderr: '',
    error,
    truncated: false,
    durationMs: 71,
    ...over,
  };
}

/** What the real handler does with a probe: one envelope line of kind `probe` in the segment of the current hour. */
function writeProbeLine(w: World, stdin: string | undefined, at: number = w.clock.ms): void {
  const payload = JSON.parse(stdin ?? '{}') as { session_id?: string };
  mkdirSync(w.spool, { recursive: true });
  const envelope = { v: 1, kind: 'probe', event: 'Notification', session_id: payload.session_id ?? null };
  appendFileSync(path.join(w.spool, spoolSegmentName(at)), JSON.stringify(envelope) + LF);
}

interface ScriptedExec {
  readonly exec: VerifySeams['exec'];
  readonly specs: ChildSpec[];
}

interface ExecScript {
  /** What `--version` answers (default: the runtime's version). */
  readonly version?: Partial<ChildResult>;
  /** What the probe run answers (default: a clean exit). */
  readonly probe?: Partial<ChildResult>;
  /** The handler writes the probe envelope (default true). */
  readonly spool?: boolean;
  /** Called with the spec of the probe run, before it answers. */
  readonly onProbe?: (spec: ChildSpec) => void;
}

function scriptedExec(w: World, script: ExecScript = {}): ScriptedExec {
  const specs: ChildSpec[] = [];
  const exec = (spec: ChildSpec): Promise<ChildResult> => {
    specs.push(spec);
    if (spec.args.includes('--version'))
      return Promise.resolve(child({ stdout: `${HANDLER_VERSION}${LF}`, ...script.version }));
    script.onProbe?.(spec);
    if (script.spool !== false) writeProbeLine(w, spec.stdin);
    return Promise.resolve(child(script.probe));
  };
  return { exec, specs };
}

function reply(status: number, body: unknown = {}): HttpAttempt {
  return { ok: true, reply: { status, body: JSON.stringify(body) } };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface Run {
  readonly result: HooksVerifyResult;
  readonly specs: ChildSpec[];
  readonly urls: string[];
}

async function run(
  w: World,
  over: {
    readonly script?: ExecScript;
    readonly exec?: VerifySeams['exec'];
    readonly http?: (url: string, n: number) => HttpAttempt | Promise<HttpAttempt>;
    readonly input?: Partial<VerifyHooksInput>;
  } = {},
): Promise<Run> {
  const scripted = scriptedExec(w, over.script);
  const urls: string[] = [];
  const seams: Partial<VerifySeams> = {
    tmpdir: () => w.h.root,
    exec: over.exec ?? scripted.exec,
    httpGet: (url) => {
      urls.push(url);
      return Promise.resolve(over.http?.(url, urls.length) ?? reply(404));
    },
    sleep: (ms) => {
      w.clock.ms += ms;
      return Promise.resolve();
    },
    now: () => w.clock.ms,
    randomHex: () => 'abcdef012345',
  };
  const { seams: more, ...rest } = over.input ?? {};
  const result = await verifyHooks({
    settingsPath: w.h.settingsPath,
    mcsHome: w.h.mcsHome,
    env: w.h.env,
    instance: w.instance,
    source: w.h.source,
    ...rest,
    seams: { ...seams, ...more },
  });
  return { result, specs: scripted.specs, urls };
}

function check(result: HooksVerifyResult, id: string): HooksVerifyResult['checks'][number] {
  const found = result.checks.find((c) => c.check === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

const oks = (result: HooksVerifyResult): (boolean | null)[] => result.checks.map((c) => c.ok);

/** The installed entry of an event, as it stands in the settings file. */
function entryOf(w: World, event: string): { command: string; args: string[] } {
  const settings = JSON.parse(w.h.settings()) as {
    hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
  };
  const entry = settings.hooks[event]?.[0]?.hooks[0];
  if (entry === undefined) throw new Error(`no entry for ${event}`);
  return entry;
}

function editSettings(w: World, change: (hooks: Record<string, unknown>) => void): void {
  const settings = JSON.parse(w.h.settings()) as { hooks: Record<string, unknown> };
  change(settings.hooks);
  w.h.writeSettings(`${JSON.stringify(settings, null, 2)}${LF}`);
}

// ---- the happy path -----------------------------------------------------------------------------------------------------------------

describe('verifyHooks: after a good install', () => {
  it('passes V1 to V6 and skips V7 while no server runs; the answer matches the schema', async () => {
    const w = await world();
    const { result } = await run(w);
    HooksVerifyResultSchema.parse(result);
    expect(result.checks.map((c) => c.check)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']);
    expect(oks(result)).toEqual([true, true, true, true, true, true, null]);
    expect(check(result, 'V7').detail).toMatch(/not running/);
  });

  it('V4 starts the installed command up to the script with --version, V6 starts the Notification entry as it is installed', async () => {
    const w = await world();
    const { specs } = await run(w);
    const notification = entryOf(w, 'Notification');
    expect(specs).toHaveLength(2);
    const [version, probe] = specs;
    expect(version).toMatchObject({
      kind: 'node',
      file: notification.command,
      args: [notification.args[0], notification.args[1], '--version'],
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    expect(version?.stdin).toBeUndefined();
    expect(probe).toMatchObject({
      kind: 'node',
      file: notification.command,
      args: notification.args,
      timeoutMs: PROBE_TIMEOUT_MS,
      extraEnv: { MCS_HOME: w.h.mcsHome, MCS_HOOK_DISABLE: '0' },
    });
    // the script that runs is the stable copy of MCS_HOME, and the folder of the bundle is named nowhere
    expect(notification.args[1]).toBe(stableScriptPath(w.h.mcsHome));
    expect(JSON.stringify(specs)).not.toContain(normalizePath(path.dirname(w.h.source)));
  });

  it('V6 sends a probe of the family that the server stores as a probe and never as a session', async () => {
    const w = await world();
    const { specs } = await run(w);
    const payload = JSON.parse(specs[1]?.stdin ?? '') as Record<string, unknown>;
    expect(payload).toEqual({
      session_id: PROBE_ID,
      transcript_path: `${normalizePath(w.instance.transcriptsDir)}/${PROBE_ID}.jsonl`,
      cwd: normalizePath(w.instance.repoDir),
      hook_event_name: 'Notification',
      notification_type: 'mcs_probe',
      message: 'mcs probe',
    });
    expect(PROBE_ID).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    expect(Buffer.byteLength(specs[1]?.stdin ?? '')).toBeLessThanOrEqual(PROBE_PAYLOAD_MAX_BYTES);
  });

  it('writes no settings file, no manifest, no backup and no copy', async () => {
    const w = await world();
    const settings = readFileSync(w.h.settingsPath);
    const mtime = statSync(w.h.settingsPath).mtimeMs;
    const before = {
      claude: treeOf(w.h.claudeHome),
      hooks: treeOf(path.join(w.h.mcsHome, 'hooks')),
      backups: treeOf(path.join(w.h.mcsHome, 'backups')),
    };
    await run(w);
    await run(w, { script: { probe: { stdout: 'noise' } } });
    expect(readFileSync(w.h.settingsPath).equals(settings)).toBe(true);
    expect(statSync(w.h.settingsPath).mtimeMs).toBe(mtime);
    expect({
      claude: treeOf(w.h.claudeHome),
      hooks: treeOf(path.join(w.h.mcsHome, 'hooks')),
      backups: treeOf(path.join(w.h.mcsHome, 'backups')),
    }).toEqual(before);
  });

  it('never repeats text of the settings file or of the handler output in a detail', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      hooks['Stop'] = [
        { hooks: [{ type: 'command', command: 'echo FIXTURE-SECRET-USER-HOOK --token FIXTURE-SECRET-TOKEN' }] },
        ...(hooks['Stop'] as unknown[]),
      ];
    });
    const { result } = await run(w, {
      script: { probe: { stdout: 'FIXTURE-SECRET-OUTPUT', stderr: 'FIXTURE-SECRET-ERROR' } },
    });
    expect(JSON.stringify(result)).not.toContain('FIXTURE-SECRET');
    expect(check(result, 'V6').ok).toBe(false);
  });

  it('is the same for a settings file in a user folder that has other, unrelated hooks around ours', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      for (const event of ['Stop', 'Notification', 'PreToolUse']) {
        hooks[event] = [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo FIXTURE one' }] },
          ...(hooks[event] as unknown[]),
          { hooks: [{ type: 'command', command: 'echo FIXTURE two' }] },
        ];
      }
    });
    const { result } = await run(w);
    expect(oks(result)).toEqual([true, true, true, true, true, true, null]);
  });
});

// ---- V1 -------------------------------------------------------------------------------------------------------------------------------

describe('V1: the settings file parses', () => {
  it('fails for a missing file, and the checks that need the file are skipped; V5 still runs', async () => {
    const w = await world();
    rmSync(w.h.settingsPath);
    const { result, specs } = await run(w);
    expect(check(result, 'V1')).toMatchObject({ ok: false, detail: 'the settings file does not exist' });
    expect(oks(result)).toEqual([false, null, null, null, true, null, null]);
    expect(check(result, 'V2').detail).toMatch(/^skipped: /);
    expect(specs).toEqual([]);
  });

  it('fails for text that is not JSON and says where, without quoting the text', async () => {
    const w = await world();
    w.h.writeSettings('{ "hooks": FIXTURE-SECRET-TEXT }');
    const { result } = await run(w);
    expect(check(result, 'V1').ok).toBe(false);
    expect(check(result, 'V1').detail).toMatch(/not valid JSON/);
    expect(JSON.stringify(result)).not.toContain('FIXTURE-SECRET');
  });

  it('fails for a top level that is not an object and for a hooks key that is not an object', async () => {
    const w = await world();
    w.h.writeSettings('[1, 2]');
    expect(check((await run(w)).result, 'V1')).toMatchObject({ ok: false });
    w.h.writeSettings('{"hooks": []}');
    const v1 = check((await run(w)).result, 'V1');
    expect(v1.ok).toBe(false);
    expect(v1.detail).toMatch(/hooks.*not a JSON object/);
  });

  it('fails for a file that is not UTF-8 text', async () => {
    const w = await world();
    writeFileSync(w.h.settingsPath, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    expect(check((await run(w)).result, 'V1').ok).toBe(false);
  });

  it('accepts a file with a byte order mark, CRLF and tabs', async () => {
    const w = await world();
    const text = w.h.settings().replaceAll(LF, `\r${LF}`);
    w.h.writeSettings(String.fromCharCode(0xfeff) + text);
    expect(check((await run(w)).result, 'V1').ok).toBe(true);
  });

  it('treats a blank file as no entries: V1 passes and V2 fails', async () => {
    const w = await world();
    w.h.writeSettings('  ');
    const { result } = await run(w);
    expect(oks(result).slice(0, 4)).toEqual([true, false, null, null]);
  });
});

// ---- V2 -------------------------------------------------------------------------------------------------------------------------------

describe('V2: one entry of ours for each event', () => {
  it('names the events that someone removed by hand', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      Reflect.deleteProperty(hooks, 'Stop');
      Reflect.deleteProperty(hooks, 'SessionEnd');
    });
    const { result } = await run(w);
    expect(check(result, 'V2')).toMatchObject({ ok: false });
    expect(check(result, 'V2').detail).toContain('Stop, SessionEnd');
    expect(check(result, 'V2').detail).toContain('hooks install --yes');
  });

  it('fails for two entries of ours on one event', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      const groups = hooks['Stop'] as { hooks: unknown[] }[];
      groups.push({ hooks: [{ ...(groups[0]?.hooks[0] as object) }] });
    });
    const v2 = check((await run(w)).result, 'V2');
    expect(v2.ok).toBe(false);
    expect(v2.detail).toContain('more than one entry for Stop');
  });

  it('fails for an entry of ours on an event that is not installed', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      hooks['FixtureOtherEvent'] = [
        { hooks: [{ type: 'command', command: 'x', args: ['--mcs-hook', 'FixtureOtherEvent'] }] },
      ];
    });
    const { result } = await run(w);
    expect(check(result, 'V2').detail).toContain('FixtureOtherEvent');
    expect(check(result, 'V2').ok).toBe(false);
  });

  it('with nothing installed V2 fails and the checks that run entries are skipped', async () => {
    const w = await world({ install: false });
    w.h.writeSettings(`${JSON.stringify({ theme: 'dark' })}${LF}`);
    const { result, specs } = await run(w);
    expect(oks(result)).toEqual([true, false, null, null, true, null, null]);
    expect(check(result, 'V3').detail).toMatch(/holds no entry of ours/);
    expect(specs).toEqual([]);
  });

  it('keeps its detail short when an event name is a hundred thousand characters', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      hooks['X'.repeat(100_000)] = [{ hooks: [{ type: 'command', command: 'x', args: ['--mcs-hook', 'E'] }] }];
      hooks['Y' + String.fromCharCode(27) + '[31mred'] = [
        { hooks: [{ type: 'command', command: 'x', args: ['--mcs-hook', 'E'] }] },
      ];
    });
    const detail = check((await run(w)).result, 'V2').detail;
    expect(detail.length).toBeLessThan(400);
    expect(detail).not.toContain(String.fromCharCode(27));
  });
});

// ---- V3 -------------------------------------------------------------------------------------------------------------------------------

describe('V3: the paths are current', () => {
  it('fails when the stable copy is gone', async () => {
    const w = await world();
    rmSync(stableScriptPath(w.h.mcsHome));
    const { result } = await run(w);
    expect(check(result, 'V3').ok).toBe(false);
    expect(check(result, 'V3').detail).toMatch(/stable copy of the hook script is missing/);
    expect(check(result, 'V3').detail).toContain('hooks install --yes');
  });

  it('fails when the copy differs from the bundled script (the plugin was updated)', async () => {
    const w = await world();
    w.h.setSource(HANDLER_V2);
    const { result } = await run(w);
    expect(check(result, 'V3')).toMatchObject({ ok: false });
    expect(check(result, 'V3').detail).toMatch(/differs from the bundled script/);
  });

  it('fails when the stable copy is a link, with or without the bundled script to compare', async () => {
    const w = await world();
    const decoy = path.join(w.h.root, 'decoy');
    mkdirSync(decoy);
    rmSync(stableScriptPath(w.h.mcsHome));
    makeJunction(stableScriptPath(w.h.mcsHome), decoy); // a junction on Windows, no privilege needed
    for (const source of [w.h.source, null]) {
      const { result } = await run(w, { input: { source } });
      expect(check(result, 'V3').ok).toBe(false);
      expect(check(result, 'V3').detail).toMatch(/link/);
    }
  });

  it('passes without the bundled script, and says that it did not compare', async () => {
    const w = await world();
    const { result } = await run(w, { input: { source: null } });
    expect(check(result, 'V3').ok).toBe(true);
    expect(check(result, 'V3').detail).toMatch(/not compared/);
  });

  it('passes with a bundled script that cannot be read, and says that it did not compare', async () => {
    const w = await world();
    const { result } = await run(w, { input: { source: path.join(w.h.root, 'nowhere', 'mcs-hook.mjs') } });
    expect(check(result, 'V3')).toMatchObject({ ok: true });
    expect(check(result, 'V3').detail).toMatch(/could not be read/);
  });

  it('says that the copy is current when it was compared', async () => {
    const w = await world();
    expect(check((await run(w)).result, 'V3').detail).toMatch(/matches the bundled script/);
  });

  it('fails when the Node executable of the entries does not exist', async () => {
    const w = await world({ nodePath: path.join(path.parse(process.cwd()).root, 'fixture-no-such-dir', 'node') });
    const { result } = await run(w);
    expect(check(result, 'V3').ok).toBe(false);
    expect(check(result, 'V3').detail).toMatch(/Node executable .* does not exist/);
  });

  it('fails for a command that is not an absolute path', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      const entry = (hooks['Stop'] as { hooks: { command: string }[] }[])[0]?.hooks[0];
      if (entry !== undefined) entry.command = 'node';
    });
    expect(check((await run(w)).result, 'V3').detail).toMatch(/not an absolute path/);
  });

  it('fails when an entry runs another script than the stable copy, even one that exists', async () => {
    const w = await world();
    const other = path.join(w.h.root, 'other-hook.mjs');
    writeFileSync(other, HANDLER_V1);
    editSettings(w, (hooks) => {
      const entry = (hooks['Stop'] as { hooks: { args: string[] }[] }[])[0]?.hooks[0];
      if (entry !== undefined) entry.args[1] = normalizePath(other);
    });
    const { result } = await run(w);
    expect(check(result, 'V3').ok).toBe(false);
    expect(check(result, 'V3').detail).toMatch(/instead of the stable copy/);
  });

  it('fails for an entry in shell form, and V2 still counts it as ours', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      hooks['Stop'] = [{ hooks: [{ type: 'command', command: 'node hook.mjs --mcs-hook Stop' }] }];
    });
    const { result } = await run(w);
    expect(check(result, 'V2').ok).toBe(true);
    expect(check(result, 'V3').detail).toMatch(/not in the exec form/);
  });

  it('copes with an entry whose arguments are not text', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      hooks['Notification'] = [{ hooks: [{ type: 'command', command: 'x', args: ['--mcs-hook', 1, {}, null] }] }];
    });
    const { result, specs } = await run(w);
    expect(check(result, 'V3').ok).toBe(false);
    expect(check(result, 'V6')).toMatchObject({ ok: null });
    expect(check(result, 'V6').detail).toMatch(/exec form/);
    // V4 ran one of the other entries
    expect(specs.length).toBe(1);
  });

  it('does not depend on the folder of the bundle for anything but the comparison', async () => {
    const w = await world();
    const { result, specs } = await run(w);
    expect(check(result, 'V3').ok).toBe(true);
    for (const spec of specs) expect(JSON.stringify(spec)).not.toContain(normalizePath(w.h.source));
  });
});

// ---- V4 -------------------------------------------------------------------------------------------------------------------------------

describe('V4: the handler version', () => {
  it('fails when the installed handler prints another version, and names both', async () => {
    const w = await world();
    const { result } = await run(w, { script: { version: { stdout: `3.9.9${LF}` } } });
    expect(check(result, 'V4').ok).toBe(false);
    expect(check(result, 'V4').detail).toContain('3.9.9');
    expect(check(result, 'V4').detail).toContain(HANDLER_VERSION);
  });

  it('fails when --version prints more than the version', async () => {
    const w = await world();
    const { result } = await run(w, { script: { version: { stdout: `${HANDLER_VERSION} and more${LF}` } } });
    expect(check(result, 'V4').ok).toBe(false);
  });

  it('fails for a non-zero exit, a timeout, an output flood and a command that cannot start', async () => {
    const cases: [Partial<ChildResult>, RegExp][] = [
      [{ ok: false, code: 3, error: 'NONZERO_EXIT' }, /exited with code 3/],
      [{ error: 'TIMEOUT' }, /did not finish within 2000 ms/],
      [{ error: 'OUTPUT_LIMIT', truncated: true }, /printed more than/],
      [{ error: 'ENOENT' }, /could not be started \(ENOENT\)/],
    ];
    for (const [version, pattern] of cases) {
      const w = await world();
      const { result } = await run(w, { script: { version } });
      expect(check(result, 'V4').ok).toBe(false);
      expect(check(result, 'V4').detail).toMatch(pattern);
    }
  });

  it('does not run the bundled script, only the installed command', async () => {
    const w = await world();
    const { specs } = await run(w);
    expect(specs.map((spec) => spec.file)).toEqual([
      entryOf(w, 'Notification').command,
      entryOf(w, 'Notification').command,
    ]);
  });

  it('survives an exec that throws', async () => {
    const w = await world();
    const { result } = await run(w, { exec: () => Promise.reject(new Error('FIXTURE-SECRET boom')) });
    expect(check(result, 'V4').ok).toBe(false);
    expect(check(result, 'V6').ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('FIXTURE-SECRET');
  });
});

// ---- V5 -------------------------------------------------------------------------------------------------------------------------------

describe('V5: the route file', () => {
  function rewriteRoute(w: World, change: (route: Record<string, unknown>) => void): void {
    const file = path.join(w.h.mcsHome, 'routes', `${INSTANCE_ID}.json`);
    const route = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    change(route);
    writeFileSync(file, JSON.stringify(route));
  }

  it('fails when there is no route file, and V6 then has nowhere to look', async () => {
    const w = await world({ route: 'none' });
    const { result } = await run(w);
    expect(check(result, 'V5')).toMatchObject({ ok: false });
    expect(check(result, 'V5').detail).toMatch(/no route file/);
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/no usable route file/);
  });

  it('fails when the route file is damaged or of another version', async () => {
    const w = await world();
    writeFileSync(path.join(w.h.mcsHome, 'routes', `${INSTANCE_ID}.json`), '{ damaged');
    expect(check((await run(w)).result, 'V5').detail).toMatch(/not a valid version 1 route/);
  });

  it('fails when the route is disabled', async () => {
    const w = await world();
    rewriteRoute(w, (route) => {
      route['enabled'] = false;
    });
    expect(check((await run(w)).result, 'V5').detail).toMatch(/disabled/);
  });

  it('fails when the route does not list the transcripts folder of the instance', async () => {
    const w = await world();
    rewriteRoute(w, (route) => {
      route['match'] = { transcriptsDirs: [normalizePath(path.join(w.h.root, 'elsewhere'))], sessionIds: [] };
    });
    const { result } = await run(w);
    expect(check(result, 'V5').ok).toBe(false);
    expect(check(result, 'V5').detail).toMatch(/does not list the transcripts folder/);
  });

  it('fails for a stopped instance whose spool window is over, and passes inside the window', async () => {
    const w = await world();
    rewriteRoute(w, (route) => {
      route['stoppedAt'] = NOW - 10_000;
      route['spoolUntil'] = NOW - 1;
    });
    expect(check((await run(w)).result, 'V5').detail).toMatch(/spool window is over/);
    rewriteRoute(w, (route) => {
      route['spoolUntil'] = NOW + 3_600_000;
    });
    const inside = check((await run(w)).result, 'V5');
    expect(inside.ok).toBe(true);
    expect(inside.detail).toMatch(/stopped but still spools/);
  });

  it('does not depend on the settings file', async () => {
    const w = await world();
    w.h.writeSettings('not json');
    expect(check((await run(w)).result, 'V5').ok).toBe(true);
  });
});

// ---- V6 -------------------------------------------------------------------------------------------------------------------------------

describe('V6: the synthetic probe', () => {
  it('passes when the handler is silent, quick and the probe is in the spool; the detail names the segment', async () => {
    const w = await world();
    const { result } = await run(w);
    expect(check(result, 'V6')).toMatchObject({ ok: true });
    expect(check(result, 'V6').detail).toContain(spoolSegmentName(NOW));
  });

  it('fails when the handler prints to stdout or to stderr, without quoting what it printed', async () => {
    for (const probe of [{ stdout: 'hello FIXTURE-SECRET' }, { stderr: 'warning FIXTURE-SECRET' }]) {
      const w = await world();
      const { result } = await run(w, { script: { probe } });
      expect(check(result, 'V6').ok).toBe(false);
      expect(check(result, 'V6').detail).toMatch(/prints nothing/);
      expect(JSON.stringify(result)).not.toContain('FIXTURE-SECRET');
    }
  });

  it('fails for a non-zero exit, a timeout, an output flood and a command that cannot start', async () => {
    const cases: [Partial<ChildResult>, RegExp][] = [
      [{ ok: false, code: 1, error: 'NONZERO_EXIT' }, /exited with code 1/],
      [{ error: 'TIMEOUT' }, /did not finish within 1500 ms and was killed/],
      [{ error: 'OUTPUT_LIMIT', truncated: true }, /printed more than/],
      [{ error: 'EACCES' }, /could not be started \(EACCES\)/],
    ];
    for (const [probe, pattern] of cases) {
      const w = await world();
      const { result } = await run(w, { script: { probe } });
      expect(check(result, 'V6').ok).toBe(false);
      expect(check(result, 'V6').detail).toMatch(pattern);
      expect(check(result, 'V7').ok).toBe(null);
    }
  });

  it('fails when the run took 1500 ms or more even though it exited 0', async () => {
    const w = await world();
    const { result } = await run(w, { script: { probe: { durationMs: PROBE_TIMEOUT_MS } } });
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/took 1500 ms/);
    const quick = await run(w, { script: { probe: { durationMs: PROBE_TIMEOUT_MS - 1 } } });
    expect(check(quick.result, 'V6').ok).toBe(true);
  });

  it('fails when the handler is clean but the probe is not in the spool', async () => {
    const w = await world();
    const { result } = await run(w, { script: { spool: false } });
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/did not reach the spool/);
  });

  it('does not take the line of another probe, or an ordinary event of the same session, for its own', async () => {
    const w = await world();
    const other = `${PROBE_SESSION_PREFIX}ffffffffffff`;
    const { result } = await run(w, {
      script: {
        spool: false,
        onProbe: () => {
          mkdirSync(w.spool, { recursive: true });
          const segment = path.join(w.spool, spoolSegmentName(NOW));
          appendFileSync(segment, JSON.stringify({ v: 1, kind: 'probe', session_id: other }) + LF);
          appendFileSync(segment, JSON.stringify({ v: 1, kind: 'hook', session_id: PROBE_ID }) + LF);
        },
      },
    });
    expect(check(result, 'V6').ok).toBe(false);
  });

  it('finds the probe at the end of a spool segment that is much larger than 64 KiB', async () => {
    const w = await world();
    mkdirSync(w.spool, { recursive: true });
    const filler = JSON.stringify({ v: 1, kind: 'hook', session_id: 'FIXTURE', data: { text: 'x'.repeat(900) } }) + LF;
    writeFileSync(path.join(w.spool, spoolSegmentName(NOW)), filler.repeat(500));
    const { result } = await run(w);
    expect(check(result, 'V6').ok).toBe(true);
  });

  it('does not find a probe line that lies before the last 64 KiB of the segment', async () => {
    const w = await world();
    const { result } = await run(w, {
      script: {
        spool: false,
        onProbe: () => {
          mkdirSync(w.spool, { recursive: true });
          const line = JSON.stringify({ v: 1, kind: 'probe', session_id: PROBE_ID }) + LF;
          const filler =
            JSON.stringify({ v: 1, kind: 'hook', session_id: 'FIXTURE', data: { text: 'x'.repeat(900) } }) + LF;
          writeFileSync(path.join(w.spool, spoolSegmentName(NOW)), line + filler.repeat(200));
        },
      },
    });
    expect(check(result, 'V6').ok).toBe(false);
  });

  it('looks in the next hour too when the run crosses the end of the hour', async () => {
    const w = await world();
    w.clock.ms = Date.UTC(2026, 9, 20, 10, 59, 59, 900);
    const crossing = Date.UTC(2026, 9, 20, 11, 0, 0, 100);
    const { result } = await run(w, {
      exec: (spec) => {
        if (spec.args.includes('--version')) return Promise.resolve(child({ stdout: `${HANDLER_VERSION}${LF}` }));
        writeProbeLine(w, spec.stdin, crossing);
        w.clock.ms = crossing + 50;
        return Promise.resolve(child());
      },
    });
    expect(check(result, 'V6').ok).toBe(true);
    expect(check(result, 'V6').detail).toContain(spoolSegmentName(crossing));
  });

  it('reads the spool folder of the route only, and only when it is the workspace data/spool', async () => {
    const w = await world();
    const stray = path.join(w.h.root, 'stray-spool');
    const file = path.join(w.h.mcsHome, 'routes', `${INSTANCE_ID}.json`);
    const route = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    route['spoolDir'] = normalizePath(stray);
    writeFileSync(file, JSON.stringify(route));
    mkdirSync(stray, { recursive: true });
    const { result } = await run(w, {
      script: {
        spool: false,
        onProbe: (spec) => {
          const payload = JSON.parse(spec.stdin ?? '{}') as { session_id: string };
          writeFileSync(
            path.join(stray, spoolSegmentName(NOW)),
            JSON.stringify({ kind: 'probe', session_id: payload.session_id }) + LF,
          );
        },
      },
    });
    expect(check(result, 'V6').ok).toBe(false);
  });

  it('is skipped when there is no Notification entry', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      Reflect.deleteProperty(hooks, 'Notification');
    });
    const { result, specs } = await run(w);
    expect(check(result, 'V6')).toMatchObject({ ok: null });
    expect(check(result, 'V6').detail).toMatch(/no Notification entry/);
    // V4 still ran another installed entry
    expect(specs).toHaveLength(1);
    expect(specs[0]?.args.at(-1)).toBe('--version');
  });

  it('refuses a probe that would not fit the 4096 bytes of the child input', async () => {
    const w = await world();
    const longDir = path.join(w.h.root, 'projects', 'd'.repeat(5000));
    const instance: VerifyInstance = { ...w.instance, transcriptsDir: longDir };
    expect(Buffer.byteLength(probePayload(instance, PROBE_ID))).toBeGreaterThan(PROBE_PAYLOAD_MAX_BYTES);
    const { result, specs } = await run(w, { input: { instance } });
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/longer than 4096 bytes/);
    expect(specs.filter((spec) => spec.stdin !== undefined)).toEqual([]);
  });
});

// ---- V7 -------------------------------------------------------------------------------------------------------------------------------

describe('V7: the server round trip', () => {
  const COMMITTED = (n: number): HttpAttempt => reply(200, { receivedAt: iso(NOW), committedAt: iso(NOW + n) });

  it('asks the probe route of the server, polls on 404 and reports the commit latency', async () => {
    const w = await world();
    const { result, urls } = await run(w, {
      input: { serverBase: SERVER },
      http: (_url, n) => (n < 3 ? reply(404, { error: 'probe_not_found' }) : COMMITTED(42)),
    });
    expect(check(result, 'V7')).toMatchObject({ ok: true });
    expect(check(result, 'V7').detail).toContain('42 ms');
    expect(urls).toEqual(Array(3).fill(`${SERVER}${routes.ingestProbe.path.replace(':probeSessionId', PROBE_ID)}`));
    expect(oks(result)).toEqual([true, true, true, true, true, true, true]);
  });

  it('fails when the server never commits the probe, after three seconds', async () => {
    const w = await world();
    const { result, urls } = await run(w, { input: { serverBase: SERVER }, http: () => reply(404) });
    expect(check(result, 'V7').ok).toBe(false);
    expect(check(result, 'V7').detail).toMatch(/within 3 s/);
    expect(w.clock.ms - NOW).toBeGreaterThanOrEqual(ROUND_TRIP_MS);
    expect(w.clock.ms - NOW).toBeLessThan(ROUND_TRIP_MS + 200);
    expect(urls.length).toBeGreaterThan(20);
  });

  it('is skipped (null) when nothing answers at the address: the server is stopped', async () => {
    const w = await world();
    const { result } = await run(w, { input: { serverBase: SERVER }, http: () => ({ ok: false, reason: 'refused' }) });
    expect(check(result, 'V7')).toMatchObject({ ok: null });
    expect(check(result, 'V7').detail).toMatch(/no server answered/);
  });

  it('retries a request that timed out, until the deadline', async () => {
    const w = await world();
    const { result } = await run(w, {
      input: { serverBase: SERVER },
      http: (_url, n) => (n < 3 ? { ok: false, reason: 'timeout' } : COMMITTED(7)),
    });
    expect(check(result, 'V7').ok).toBe(true);
  });

  it('fails on any other status, at once', async () => {
    for (const status of [400, 403, 500]) {
      const w = await world();
      const { result, urls } = await run(w, { input: { serverBase: SERVER }, http: () => reply(status) });
      expect(check(result, 'V7').ok).toBe(false);
      expect(check(result, 'V7').detail).toContain(String(status));
      expect(urls).toHaveLength(1);
    }
  });

  it('fails on a 200 whose body is not a probe result', async () => {
    const w = await world();
    for (const body of [{}, { receivedAt: 'yesterday', committedAt: 'today' }, 'text']) {
      const { result } = await run(w, { input: { serverBase: SERVER }, http: () => reply(200, body) });
      expect(check(result, 'V7').ok).toBe(false);
    }
    const garbled = await run(w, {
      input: { serverBase: SERVER },
      http: () => ({ ok: true, reply: { status: 200, body: '<html>' } }),
    });
    expect(check(garbled.result, 'V7').ok).toBe(false);
  });

  it('never talks to an address that is not a loopback server', async () => {
    const w = await world();
    for (const base of [
      'http://example.test:80',
      'http://127.0.0.1:18123/',
      'https://127.0.0.1:18123',
      'http://localhost:18123',
    ]) {
      const { result, urls } = await run(w, { input: { serverBase: base } });
      expect(check(result, 'V7').ok).toBe(false);
      expect(urls).toEqual([]);
    }
  });

  it('is skipped when the probe did not reach the spool, even though a server runs', async () => {
    const w = await world();
    const { result, urls } = await run(w, { input: { serverBase: SERVER }, script: { spool: false } });
    expect(check(result, 'V7')).toMatchObject({ ok: null });
    expect(check(result, 'V7').detail).toMatch(/^skipped: /);
    expect(urls).toEqual([]);
  });

  it('survives an httpGet that throws', async () => {
    const w = await world();
    const { result } = await run(w, {
      input: { serverBase: SERVER },
      http: () => {
        throw new RangeError('boom');
      },
    });
    expect(check(result, 'V7').ok).toBe(false);
  });
});

// ---- the guard and the arguments ------------------------------------------------------------------------------------------------

describe('the test guard and the arguments', () => {
  it('refuses a settings file outside the temporary folder in test mode, before it reads anything', async () => {
    const w = await world();
    const narrow = path.join(w.h.root, 'narrow');
    mkdirSync(narrow);
    const scripted = scriptedExec(w);
    await expect(
      verifyHooks({
        settingsPath: w.h.settingsPath,
        mcsHome: w.h.mcsHome,
        env: w.h.env,
        instance: w.instance,
        seams: { tmpdir: () => narrow, exec: scripted.exec },
      }),
    ).rejects.toMatchObject({ code: 'HOOKS_FAILED', details: { reason: 'REAL_SETTINGS_IN_TEST' } });
    expect(scripted.specs).toEqual([]);
  });

  it('refuses an MCS_HOME outside the temporary folder in test mode', async () => {
    const w = await world();
    const other = makeTemp('verify-elsewhere').path;
    await expect(
      verifyHooks({
        settingsPath: w.h.settingsPath,
        mcsHome: path.join(other, 'mcs-home'),
        env: w.h.env,
        instance: w.instance,
        seams: { tmpdir: () => w.h.root },
      }),
    ).rejects.toMatchObject({ code: 'HOOKS_FAILED', details: { reason: 'REAL_SETTINGS_IN_TEST' } });
  });

  it('is the environment that turns the guard on, not the process: without the test variables it reads the file', async () => {
    const w = await world();
    const narrow = path.join(w.h.root, 'narrow');
    mkdirSync(narrow);
    const { result } = await run(w, { input: { env: { HOME: w.h.root }, seams: { tmpdir: () => narrow } } });
    expect(check(result, 'V1').ok).toBe(true);
  });

  it('wants absolute paths', async () => {
    const w = await world();
    await expect(run(w, { input: { settingsPath: 'settings.json' } })).rejects.toMatchObject({ code: 'USAGE' });
    await expect(run(w, { input: { mcsHome: 'mcs-home' } })).rejects.toMatchObject({ code: 'USAGE' });
  });
});

// ---- adversarial settings -------------------------------------------------------------------------------------------------------------

describe('a hostile settings file', () => {
  it('a thousand hook groups on every event are checked quickly', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      for (const event of INSTALLED_HOOK_EVENTS) {
        const groups = hooks[event] as unknown[];
        for (let i = 0; i < 1000; i += 1)
          groups.unshift({ matcher: `FIXTURE-${String(i)}`, hooks: [{ type: 'command', command: 'echo FIXTURE' }] });
      }
    });
    const started = Date.now();
    const { result } = await run(w);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(oks(result)).toEqual([true, true, true, true, true, true, null]);
  });

  it('an event with a value that is not a list counts as having no entry', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      hooks['Stop'] = 'FIXTURE';
      hooks['SessionEnd'] = { hooks: [] };
    });
    const { result } = await run(w);
    expect(check(result, 'V2').ok).toBe(false);
    expect(check(result, 'V2').detail).toContain('Stop, SessionEnd');
  });

  it('a group whose hooks are not a list, and a null handler, are ignored', async () => {
    const w = await world();
    editSettings(w, (hooks) => {
      (hooks['Stop'] as unknown[]).push({ hooks: 'x' }, null, 7, { hooks: [null, 3, 'x', []] });
    });
    expect(check((await run(w)).result, 'V2').ok).toBe(true);
  });
});

// ---- a real handler process ---------------------------------------------------------------------------------------------------------

type Mode = 'good' | 'chatty' | 'exit3' | 'hang' | 'flood' | 'badversion' | 'silent';

/** A hook handler in a few lines of Node: only built-in imports, so the installer accepts it as the bundled script. */
function handlerScript(mode: Mode): string {
  const version = mode === 'badversion' ? '3.9.9' : HANDLER_VERSION;
  const hook: Record<Mode, string> = {
    good: [
      "let input = '';",
      'for await (const chunk of process.stdin) input += chunk;',
      'const payload = JSON.parse(input);',
      "const dir = process.env.MCS_HOME + '/routes';",
      'const stamp = new Date().toISOString();',
      "const segment = 'hooks-' + stamp.slice(0, 4) + stamp.slice(5, 7) + stamp.slice(8, 10) + 'T' + stamp.slice(11, 13) + 'Z.ndjson';",
      'for (const name of readdirSync(dir)) {',
      "  const route = JSON.parse(readFileSync(dir + '/' + name, 'utf8'));",
      '  mkdirSync(route.spoolDir, { recursive: true });',
      "  appendFileSync(route.spoolDir + '/' + segment, JSON.stringify({ v: 1, kind: 'probe', session_id: payload.session_id }) + LF);",
      '}',
    ].join(LF),
    chatty: "process.stdout.write('hello');",
    exit3: 'process.exit(3);',
    hang: 'setInterval(() => undefined, 1000);',
    flood: "setInterval(() => process.stdout.write('x'.repeat(65536)), 1);",
    badversion: 'process.exit(0);',
    silent: 'process.exit(0);',
  };
  return [
    "import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';",
    'const LF = String.fromCharCode(10);',
    'const args = process.argv.slice(2);',
    `if (args.includes('--version')) { process.stdout.write('${version}' + LF); process.exit(0); }`,
    hook[mode],
    '',
  ].join(LF);
}

describe('a real handler process', () => {
  /** The limits are the design's for the hang test (it needs only a timeout); a loaded machine gets more time for the others. */
  async function real(mode: Mode): Promise<HooksVerifyResult> {
    const w = await world({ script: handlerScript(mode) });
    const started = Date.now();
    const result = await verifyHooks({
      settingsPath: w.h.settingsPath,
      mcsHome: w.h.mcsHome,
      env: w.h.env,
      instance: w.instance,
      source: w.h.source,
      seams: { tmpdir: () => w.h.root, ...(mode === 'hang' ? {} : { limits: { probeMs: 20_000, versionMs: 20_000 } }) },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    return result;
  }

  it('passes V1 to V6 with a handler that behaves', async () => {
    const result = await real('good');
    expect(oks(result)).toEqual([true, true, true, true, true, true, null]);
  }, 20_000);

  it('V4 fails with a handler that prints another version', async () => {
    const result = await real('badversion');
    expect(check(result, 'V4').ok).toBe(false);
    expect(check(result, 'V4').detail).toContain('3.9.9');
  }, 20_000);

  it('V6 fails with a handler that prints to stdout', async () => {
    const result = await real('chatty');
    expect(check(result, 'V6')).toMatchObject({ ok: false });
    expect(check(result, 'V6').detail).toMatch(/prints nothing/);
  }, 20_000);

  it('V6 fails with a handler that exits non-zero', async () => {
    const result = await real('exit3');
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/exited with code 3/);
  }, 20_000);

  it('V6 fails with a handler that exits 0 without spooling the probe', async () => {
    const result = await real('silent');
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/did not reach the spool/);
  }, 20_000);

  it('V6 fails with a handler that hangs: it is killed at the limit', async () => {
    const result = await real('hang');
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/did not finish within 1500 ms and was killed/);
  }, 20_000);

  it('V6 fails with a handler that floods its output: it is killed at the cap', async () => {
    const result = await real('flood');
    expect(check(result, 'V6').ok).toBe(false);
    expect(check(result, 'V6').detail).toMatch(/printed more than 8192 bytes and was killed/);
  }, 20_000);
});
