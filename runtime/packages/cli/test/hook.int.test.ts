// T-HK-01..14, T-HK-16 and T-HK-17 (02 2.12) against the real built handler, started through the installed stub
// (`scripts/mcs-hook.mjs`) or directly (`dist/hook.js`). Every test runs with a temp `MCS_HOME`; none touches real
// settings. The integration gate builds the runtime first.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HookEnvelopeV1Schema } from '@mcs/shared';
import {
  ENVELOPE_MAX_BYTES,
  HANDLER_VERSION,
  HOOK_EVENT_POLICY,
  INSTALLED_HOOK_EVENTS,
  SPOOL_SEGMENT_HARD_CAP,
  SPOOL_SEGMENT_RE,
  SPOOL_SEGMENT_SOFT_CAP,
  routeKey,
  sanitizeProjectName,
  spoolSegmentName,
  type HookEnvelopeV1,
  type HookRouteV1,
} from '@mcs/shared/protocol';
import {
  allocatePort,
  buildRepo,
  buildTaskWorkspace,
  hookPayload,
  killAllTracked,
  runHookHandler,
  snapshotTree,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SKILL = join(import.meta.dirname, '..', '..', '..', '..');
const STUB = join(SKILL, 'scripts', 'mcs-hook.mjs');
const HOOK_JS = join(SKILL, 'runtime', 'packages', 'cli', 'dist', 'hook.js');
const PERF = Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1;
const LF = String.fromCharCode(10);

const SID = '11111111-2222-4333-8444-555555555555';
const PROBE_SID = '00000000-0000-4000-8000-0123456789ab';
const INSTANCE_A = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';
const INSTANCE_B = '7b1f4d2f-2c3d-4e4f-8f51-123456789abc';

const servers: Server[] = [];
afterEach(async () => {
  await killAllTracked();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

interface Setup {
  root: string;
  repo: string;
  mcsHome: string;
  routesDir: string;
  transcriptsDir: string;
  workspace: string;
  spoolDir: string;
  route: HookRouteV1;
  base: { sessionId: string; cwd: string; transcriptPath: string };
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const fwd = (path: string): string => path.split(sep).join('/');

function writeRoute(routesDir: string, route: HookRouteV1): void {
  writeFileSync(join(routesDir, `${route.instanceId}.json`), JSON.stringify(route));
}

/** A temp MCS_HOME with one running route, its workspace and its transcripts folder. */
function setup(opts: { root?: string; instanceId?: string; slug?: string; route?: Partial<HookRouteV1> } = {}): Setup {
  const root = opts.root ?? makeTemp('hook').path;
  const instanceId = opts.instanceId ?? INSTANCE_A;
  const { repo } = buildRepo(join(root, 'repo'));
  const workspace = fwd(
    buildTaskWorkspace(repo, { slug: opts.slug ?? 'task-a', config: {}, instance: { instanceId } }),
  );
  const transcriptsDir = fwd(join(root, 'claude', 'projects', 'proj'));
  mkdirSync(transcriptsDir, { recursive: true });
  const mcsHome = join(root, 'mcs-home');
  const routesDir = join(mcsHome, 'routes');
  mkdirSync(routesDir, { recursive: true });
  const route: HookRouteV1 = {
    v: 1,
    instanceId,
    workspace,
    spoolDir: `${workspace}/data/spool`,
    stateFile: `${workspace}/state.json`,
    enabled: true,
    match: { transcriptsDirs: [routeKey(transcriptsDir)], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: Date.now(),
    ...opts.route,
  };
  writeRoute(routesDir, route);
  return {
    root,
    repo,
    mcsHome,
    routesDir,
    transcriptsDir,
    workspace,
    spoolDir: route.spoolDir,
    route,
    base: { sessionId: SID, cwd: fwd(repo), transcriptPath: `${transcriptsDir}/${SID}.jsonl` },
  };
}

function spoolText(spoolDir: string): string {
  if (!existsSync(spoolDir)) return '';
  return readdirSync(spoolDir)
    .sort()
    .map((name) => readFileSync(join(spoolDir, name), 'utf8'))
    .join('');
}

function spoolLines(spoolDir: string): HookEnvelopeV1[] {
  return spoolText(spoolDir)
    .split(LF)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HookEnvelopeV1);
}

interface LogLine {
  code: string;
  event: string;
  instanceId: string | null;
  detail: string;
}

function handlerLog(mcsHome: string): LogLine[] {
  const file = join(mcsHome, 'logs', 'hook-handler.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(LF)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

function expectSilentSuccess(result: { code: number | null; stdout: string; stderr: string }): void {
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
}

interface Raw {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
}

/** Runs `node --no-warnings <entry> <args>` with a chosen stdin (kept open without ending when `holdStdin`). */
function runNode(
  entry: string,
  args: string[],
  opts: { env: Record<string, string>; stdin?: string; holdStdin?: boolean },
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--no-warnings', entry, ...args], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    if (opts.holdStdin !== true) child.stdin.end(opts.stdin);
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        wallMs: performance.now() - started,
      });
    });
  });
}

function envFor(mcsHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { TZ: 'UTC', MCS_HOME: mcsHome };
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

interface NudgeServer {
  port: number;
  requests: { method: string | undefined; url: string | undefined; headers: Record<string, unknown>; body: string }[];
}

/** A loopback server for the nudge: `answer` replies 204 at once, `hang` accepts and never replies. */
async function startNudgeServer(mode: 'answer' | 'hang'): Promise<NudgeServer> {
  const port = await allocatePort();
  const state: NudgeServer = { port, requests: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (mode === 'answer') {
        res.statusCode = 204;
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return state;
}

function writeState(s: Setup, fields: Record<string, unknown>): void {
  writeFileSync(`${s.workspace}/state.json`, JSON.stringify({ pid: 1, started: 0, version: '3.0.0', ...fields }));
}

function nodeState(s: Setup, port: number, extra: Record<string, unknown> = {}): void {
  writeState(s, {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    task: null,
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId: s.route.instanceId,
    runtimeVersion: HANDLER_VERSION,
    codeStamp: '0123456789',
    ...extra,
  });
}

describe('T-HK-01 never blocks, never prints, always exit 0 (and T-HK-03 shape and privacy)', () => {
  it.each(INSTALLED_HOOK_EVENTS.map((event) => [event]))(
    '%s writes one valid private envelope and prints nothing',
    async (event) => {
      const s = setup();
      // A field that the policy also summarizes into a redacted `*_preview` (StopFailure `error_details`) keeps that preview.
      const previewed = HOOK_EVENT_POLICY[event].summarized
        .filter((rule) => rule.into.some((key) => key.endsWith('_preview')))
        .map((rule) => rule.from);
      const dropped = HOOK_EVENT_POLICY[event].dropped.filter((field) => !previewed.includes(field));
      const extra = Object.fromEntries(dropped.map((field) => [field, `SENTINEL_DROP_${field}`]));
      const result = await runHookHandler(hookPayload(event, s.base, extra), { mcsHome: s.mcsHome });
      expectSilentSuccess(result);
      const text = spoolText(s.spoolDir);
      const lines = text.split(LF).filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      expect(Buffer.byteLength(`${lines[0] ?? ''}${LF}`)).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
      const envelope: unknown = JSON.parse(lines[0] ?? 'null');
      expect(HookEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
      expect(text).not.toContain('SENTINEL_DROP_');
      expect(envelope).toMatchObject({ event, instance_id: INSTANCE_A, kind: 'hook', session_id: SID });
    },
  );

  const rawCases: [string, string][] = [
    ['invalid JSON', '{"session_id": '],
    ['a JSON array', '[1,2,3]'],
    ['empty stdin', ''],
    ['a payload with only unknown fields', JSON.stringify({ unrelated: true })],
  ];
  it.each(rawCases)('%s: exit 0, silent, no spool line', async (_name, rawStdin) => {
    const s = setup();
    const result = await runHookHandler(undefined, { mcsHome: s.mcsHome, event: 'Stop', rawStdin });
    expectSilentSuccess(result);
    expect(spoolLines(s.spoolDir)).toHaveLength(0);
  });

  it('invalid JSON is logged as STDIN_PARSE_ERROR with the argv event only', async () => {
    const s = setup();
    await runHookHandler(undefined, { mcsHome: s.mcsHome, event: 'Stop', rawStdin: '{"prompt": "SENTINEL_BODY' });
    const logged = handlerLog(s.mcsHome);
    expect(logged.map((entry) => entry.code)).toEqual(['STDIN_PARSE_ERROR']);
    expect(logged[0]?.event).toBe('Stop');
    expect(JSON.stringify(logged)).not.toContain('SENTINEL_BODY');
  });

  it('a 9 MiB stdin: exit 0, silent, nothing oversized is written', async () => {
    const s = setup();
    const big = JSON.stringify({
      session_id: SID,
      transcript_path: s.base.transcriptPath,
      hook_event_name: 'Stop',
      last_assistant_message: 'x'.repeat(9 * 1024 * 1024),
    });
    const result = await runHookHandler(undefined, { mcsHome: s.mcsHome, event: 'Stop', rawStdin: big });
    expectSilentSuccess(result);
    for (const line of spoolText(s.spoolDir).split(LF)) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    }
  });

  it('an unknown event name keeps only the key names', async () => {
    const s = setup();
    const payload = { ...hookPayload('Stop', s.base), hook_event_name: 'NoSuchEvent', secret_body: 'SENTINEL_DROP_x' };
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome, event: 'Stop' }));
    const [line] = spoolLines(s.spoolDir);
    expect(line?.event).toBe('NoSuchEvent');
    expect(line?.argv_event).toBe('Stop');
    expect(line?.flags).toContain('event_mismatch');
    expect(asText(line?.data['data_keys'])).toContain('secret_body');
    expect(spoolText(s.spoolDir)).not.toContain('SENTINEL_DROP_x');
  });

  it('no routes folder: exit 0, silent, nothing is created', async () => {
    const s = setup();
    const empty = join(s.root, 'empty-home');
    mkdirSync(empty);
    const before = snapshotTree(empty);
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: empty }));
    expect(snapshotTree(empty)).toBe(before);
  });

  it('an unreadable routes folder (a file) is logged as ROUTES_UNREADABLE, exit 0', async () => {
    const s = setup();
    const home = join(s.root, 'odd-home');
    mkdirSync(home);
    writeFileSync(join(home, 'routes'), 'not a folder');
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: home }));
    expect(handlerLog(home).map((entry) => entry.code)).toContain('ROUTES_UNREADABLE');
  });

  it('a route file with invalid JSON is skipped and logged, the good route still gets the line', async () => {
    const s = setup();
    writeFileSync(join(s.routesDir, `${INSTANCE_B}.json`), '{ nope');
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
    const invalid = handlerLog(s.mcsHome).filter((entry) => entry.code === 'ROUTE_INVALID');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.detail).toContain(`${INSTANCE_B}.json`);
  });

  it('a spool path that cannot be written is logged as SPOOL_WRITE_FAILED, exit 0', async () => {
    const s = setup();
    mkdirSync(join(s.workspace, 'data'), { recursive: true });
    writeFileSync(s.spoolDir, 'a file where the folder should be');
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    const failed = handlerLog(s.mcsHome).find((entry) => entry.code === 'SPOOL_WRITE_FAILED');
    expect(failed?.instanceId).toBe(INSTANCE_A);
  });

  it('a missing spool folder is created below an existing workspace', async () => {
    const s = setup();
    expect(existsSync(s.spoolDir)).toBe(false);
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
  });

  it('a workspace that no longer exists is not re-created', async () => {
    const s = setup();
    const gone = fwd(join(s.root, 'gone'));
    writeRoute(s.routesDir, {
      ...s.route,
      workspace: gone,
      spoolDir: `${gone}/data/spool`,
      stateFile: `${gone}/state.json`,
    });
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(existsSync(join(s.root, 'gone'))).toBe(false);
    expect(handlerLog(s.mcsHome).map((entry) => entry.code)).toContain('SPOOL_WRITE_FAILED');
  });

  it('an invalid state.json: the line is written, no request is made, exit 0', async () => {
    const s = setup();
    writeFileSync(`${s.workspace}/state.json`, '{ not json');
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
  });

  it('invalid ids become null with an invalid_<field> flag; the event still counts', async () => {
    const s = setup();
    const payload = hookPayload('PreToolUse', s.base, {
      agent_id: 'bad id!',
      tool_use_id: 'bad id!',
      prompt_id: 'x'.repeat(200),
    });
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome }));
    const [line] = spoolLines(s.spoolDir);
    expect(line?.agent_id).toBeNull();
    expect(line?.tool_use_id).toBeNull();
    expect(line?.prompt_id).toBeNull();
    expect(line?.flags).toEqual(
      expect.arrayContaining(['invalid_agent_id', 'invalid_tool_use_id', 'invalid_prompt_id']),
    );
  });
});

describe('T-HK-03 hostile nesting', () => {
  it('a tool_input nested far beyond the stack still spools the envelope, with data_truncated:data', async () => {
    const s = setup();
    const depth = 20000;
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const raw = JSON.stringify({ ...hookPayload('PreToolUse', s.base), tool_input: null }).replace(
      '"tool_input":null',
      `"tool_input":${nested}`,
    );
    expectSilentSuccess(await runHookHandler(undefined, { mcsHome: s.mcsHome, event: 'PreToolUse', rawStdin: raw }));
    const lines = spoolLines(s.spoolDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('PreToolUse');
    expect(lines[0]?.flags).toContain('data_truncated:data');
    expect(lines[0]?.data).toEqual({});
  });
});

describe('T-HK-02 recursion guard', () => {
  it.each([[false], [true]])('MCS_HOOK_DISABLE=1 (direct=%s): exit 0, nothing is created', async (direct) => {
    const s = setup();
    const before = snapshotTree(s.root);
    const result = await runHookHandler(hookPayload('Stop', s.base), {
      mcsHome: s.mcsHome,
      direct,
      env: { MCS_HOOK_DISABLE: '1' },
    });
    expectSilentSuccess(result);
    expect(snapshotTree(s.root)).toBe(before);
    expect(existsSync(join(s.mcsHome, 'logs'))).toBe(false);
  });
});

describe('T-HK-04 redaction in the spool line', () => {
  it('a bearer token in a Bash command is redacted, with the redacted flag', async () => {
    const s = setup();
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const payload = hookPayload('PreToolUse', s.base, {
      tool_input: { command: `curl -H "Authorization: Bearer ${token}" https://example.invalid` },
    });
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome }));
    const [line] = spoolLines(s.spoolDir);
    expect(line?.flags).toContain('redacted');
    expect(asText(line?.data['tool_summary'])).toContain('[redacted]');
    expect(spoolText(s.spoolDir)).not.toContain(token);
  });
});

describe('T-HK-05 routing', () => {
  it('two matching routes give two lines with one event_uid and different instance ids', async () => {
    const s = setup();
    const b = setup({ root: s.root, instanceId: INSTANCE_B, slug: 'task-b' });
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    const [a] = spoolLines(s.spoolDir);
    const [other] = spoolLines(b.spoolDir);
    expect(a?.instance_id).toBe(INSTANCE_A);
    expect(other?.instance_id).toBe(INSTANCE_B);
    expect(a?.event_uid).toBe(other?.event_uid);
    expect(a?.event_uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('an event outside every route writes nothing', async () => {
    const s = setup();
    const elsewhere = { ...s.base, transcriptPath: `${fwd(join(s.root, 'other-projects'))}/${SID}.jsonl` };
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', elsewhere), { mcsHome: s.mcsHome }));
    expect(existsSync(s.spoolDir)).toBe(false);
  });

  it('a pinned session id routes with the routed_by_session_pin flag', async () => {
    const s = setup({ route: { match: { transcriptsDirs: [], sessionIds: [SID] } } });
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)[0]?.flags).toContain('routed_by_session_pin');
  });

  it('without a transcript path the sanitized cwd routes with the routed_by_cwd flag', async () => {
    const s = setup();
    const folder = fwd(join(s.root, 'claude', 'projects', sanitizeProjectName(s.base.cwd)));
    writeRoute(s.routesDir, { ...s.route, match: { transcriptsDirs: [routeKey(folder)], sessionIds: [] } });
    const payload = hookPayload('Stop', s.base, { transcript_path: undefined });
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome }));
    const [line] = spoolLines(s.spoolDir);
    expect(line?.flags).toContain('routed_by_cwd');
    expect(line?.transcript_path).toBeNull();
  });

  it('a disabled route and a route stopped past its spool window get nothing', async () => {
    const s = setup({ route: { enabled: false } });
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    writeRoute(s.routesDir, { ...s.route, enabled: true, stoppedAt: 1, spoolUntil: Date.now() - 1000 });
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(existsSync(s.spoolDir)).toBe(false);
    writeRoute(s.routesDir, { ...s.route, enabled: true, stoppedAt: 1, spoolUntil: Date.now() + 60_000 });
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
  });
});

describe('T-HK-06 the nudge is bounded and carries no event data', () => {
  it('an answering server sees one request with only the instance id', async () => {
    const s = setup();
    const server = await startNudgeServer('answer');
    nodeState(s, server.port);
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    await waitFor(() => server.requests.length === 1, { what: 'the nudge request' });
    const [request] = server.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/v3/ingest/nudge');
    expect(request?.body).toBe(JSON.stringify({ instanceId: INSTANCE_A }));
    expect(request?.headers['origin']).toBeUndefined();
    expect(String(request?.headers['content-type'])).toContain('application/json');
  });

  it('a closed port costs under 400 ms of wall time, and the line is kept', async () => {
    const s = setup();
    const port = await allocatePort();
    nodeState(s, port);
    const result = await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome });
    expectSilentSuccess(result);
    expect(result.durationMs).toBeLessThan(400 * PERF);
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
  });

  it('a hanging server: the request arrives, the handler exits within the budget', async () => {
    const s = setup();
    const server = await startNudgeServer('hang');
    nodeState(s, server.port);
    const result = await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome });
    expectSilentSuccess(result);
    expect(result.durationMs).toBeLessThan(450 * PERF);
    await waitFor(() => server.requests.length === 1, { what: 'the nudge request' });
  });

  it.each([
    ['another instance id', { instanceId: INSTANCE_B }],
    ['engine legacy', { engine: undefined }],
    ['a port out of range', { port: 70000 }],
  ])('%s in state.json: no request', async (_name, override) => {
    const s = setup();
    const server = await startNudgeServer('answer');
    nodeState(s, server.port, override);
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
  });

  it('a stopped route (stoppedAt set) is not nudged but still spools inside its window', async () => {
    const s = setup({ route: { stoppedAt: Date.now() - 1000, spoolUntil: Date.now() + 60_000 } });
    const server = await startNudgeServer('answer');
    nodeState(s, server.port);
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
  });
});

describe('T-HK-07 hard exit', () => {
  it('stdin kept open: exit 0 within 1300 ms of the spawn', async () => {
    const s = setup();
    const result = await runNode(STUB, ['--mcs-hook', 'Stop'], { env: envFor(s.mcsHome), holdStdin: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.wallMs).toBeLessThan(1300 * PERF);
  });
});

describe('T-HK-08 caps', () => {
  /** A segment of `size` bytes (a hole): the current UTC hour and the next one, in case the hour turns during the run. */
  function prefill(spoolDir: string, size: number): string[] {
    mkdirSync(spoolDir, { recursive: true });
    const names = [spoolSegmentName(Date.now()), spoolSegmentName(Date.now() + 3_600_000)];
    for (const name of names) {
      const fd = openSync(join(spoolDir, name), 'w');
      ftruncateSync(fd, size);
      closeSync(fd);
    }
    return names;
  }

  function tailLine(file: string): HookEnvelopeV1 {
    const size = statSync(file).size;
    const length = Math.min(size, 32 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, size - length);
    closeSync(fd);
    const text = buffer.toString('utf8');
    return JSON.parse(text.slice(text.indexOf('{"v":1'))) as HookEnvelopeV1;
  }

  it('a segment at the soft cap gets a minimal envelope', async () => {
    const s = setup();
    const names = prefill(s.spoolDir, SPOOL_SEGMENT_SOFT_CAP);
    const payload = hookPayload('PreToolUse', s.base, { tool_input: { command: 'echo hi' } });
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome }));
    const grown = names
      .map((name) => join(s.spoolDir, name))
      .filter((file) => statSync(file).size > SPOOL_SEGMENT_SOFT_CAP);
    expect(grown).toHaveLength(1);
    const line = tailLine(grown[0] ?? '');
    expect(line.flags).toContain('minimal');
    expect(Object.keys(line.data)).toEqual(['tool_name']);
  });

  it('a segment at the hard cap is not written and SPOOL_FULL is logged', async () => {
    const s = setup();
    const names = prefill(s.spoolDir, SPOOL_SEGMENT_HARD_CAP);
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    for (const name of names) expect(statSync(join(s.spoolDir, name)).size).toBe(SPOOL_SEGMENT_HARD_CAP);
    const full = handlerLog(s.mcsHome).find((entry) => entry.code === 'SPOOL_FULL');
    expect(full?.instanceId).toBe(INSTANCE_A);
  });

  it('an envelope over 16 KiB is replaced by the minimal one', async () => {
    const s = setup();
    const calls = Array.from({ length: 64 }, (_unused, i) => ({
      tool_use_id: `toolu_${String(i).padStart(2, '0')}_${'y'.repeat(90)}`,
      tool_name: 'mcp__server__' + 'x'.repeat(110),
    }));
    const payload = hookPayload('PostToolBatch', s.base, { tool_calls: calls });
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome }));
    const [line] = spoolLines(s.spoolDir);
    expect(line?.flags).toContain('minimal');
    expect((line?.data['calls'] as unknown[]).length).toBe(16);
    expect(Buffer.byteLength(spoolText(s.spoolDir))).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
  });
});

describe('T-HK-09 concurrency', () => {
  it('16 parallel runs on one route write 16 valid lines with distinct event_uid', async () => {
    const s = setup();
    const runs = Array.from({ length: 16 }, (_unused, i) =>
      runHookHandler(hookPayload('PreToolUse', s.base, { tool_use_id: `toolu_par_${String(i)}` }), {
        mcsHome: s.mcsHome,
      }),
    );
    for (const result of await Promise.all(runs)) expectSilentSuccess(result);
    const lines = spoolLines(s.spoolDir);
    expect(lines).toHaveLength(16);
    expect(new Set(lines.map((line) => line.event_uid)).size).toBe(16);
    for (const line of lines) expect(HookEnvelopeV1Schema.safeParse(line).success).toBe(true);
  });
});

describe('T-HK-10 performance (budgets of 02 2.10, times MCS_PERF_FACTOR)', () => {
  const RUNS = 30;
  const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const p90 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.9)] ?? 0;

  async function measure(s: Setup, payload: Record<string, unknown>): Promise<number[]> {
    await runHookHandler(payload, { mcsHome: s.mcsHome });
    const times: number[] = [];
    for (let i = 0; i < RUNS; i += 1) times.push((await runHookHandler(payload, { mcsHome: s.mcsHome })).durationMs);
    return times;
  }

  it('no route matches: 120 / 200 ms', async () => {
    const s = setup();
    const elsewhere = { ...s.base, transcriptPath: `${fwd(join(s.root, 'other'))}/${SID}.jsonl` };
    const times = await measure(s, hookPayload('Stop', elsewhere));
    expect(median(times)).toBeLessThan(120 * PERF);
    expect(p90(times)).toBeLessThan(200 * PERF);
  }, 60_000);

  it('route matches, server stopped: 120 / 200 ms', async () => {
    const s = setup();
    const times = await measure(s, hookPayload('Stop', s.base));
    expect(median(times)).toBeLessThan(120 * PERF);
    expect(p90(times)).toBeLessThan(200 * PERF);
  }, 60_000);

  it('route matches, server running: 150 / 250 ms', async () => {
    const s = setup();
    const server = await startNudgeServer('answer');
    nodeState(s, server.port);
    const times = await measure(s, hookPayload('Stop', s.base));
    expect(median(times)).toBeLessThan(150 * PERF);
    expect(p90(times)).toBeLessThan(250 * PERF);
  }, 60_000);

  it('server hung: 200 / 450 ms', async () => {
    const s = setup();
    const server = await startNudgeServer('hang');
    nodeState(s, server.port);
    const times = await measure(s, hookPayload('Stop', s.base));
    expect(median(times)).toBeLessThan(200 * PERF);
    expect(p90(times)).toBeLessThan(450 * PERF);
  }, 60_000);
});

describe('T-HK-11 runtime unavailable', () => {
  function copiedStub(root: string, hookJs: string | null): string {
    const skill = join(root, 'skill');
    mkdirSync(join(skill, 'scripts'), { recursive: true });
    copyFileSync(STUB, join(skill, 'scripts', 'mcs-hook.mjs'));
    if (hookJs !== null) {
      const dist = join(skill, 'runtime', 'packages', 'cli', 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'hook.js'), hookJs);
    }
    return join(skill, 'scripts', 'mcs-hook.mjs');
  }

  it.each([
    ['dist/hook.js is missing', null],
    ['dist/hook.js does not parse', 'export const = ;'],
    ['dist/hook.js has no runHook', 'export const other = 1;'],
  ])('%s: exit 0, empty output, HANDLER_UNAVAILABLE logged', async (_name, hookJs) => {
    const s = setup();
    const stub = copiedStub(s.root, hookJs);
    const payload = JSON.stringify(hookPayload('Stop', s.base));
    const result = await runNode(stub, ['--mcs-hook', 'Stop'], { env: envFor(s.mcsHome), stdin: payload });
    expectSilentSuccess(result);
    const logged = handlerLog(s.mcsHome);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.code).toBe('HANDLER_UNAVAILABLE');
    expect(logged[0]?.event).toBe('Stop');
    expect(existsSync(s.spoolDir)).toBe(false);
  });

  it('the disable switch is honoured before the import: nothing is logged', async () => {
    const s = setup();
    const stub = copiedStub(s.root, null);
    const env = envFor(s.mcsHome, { MCS_HOOK_DISABLE: '1' });
    expectSilentSuccess(await runNode(stub, ['--mcs-hook', 'Stop'], { env, stdin: '{}' }));
    expect(handlerLog(s.mcsHome)).toHaveLength(0);
  });
});

describe('T-HK-12 probe and T-HK-13 hash identity', () => {
  it('a probe payload gets kind probe', async () => {
    const s = setup();
    const probe = { ...s.base, sessionId: PROBE_SID, transcriptPath: `${s.transcriptsDir}/${PROBE_SID}.jsonl` };
    const payload = hookPayload('Notification', probe, { notification_type: 'mcs_probe', message: 'mcs probe' });
    expectSilentSuccess(await runHookHandler(payload, { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)[0]).toMatchObject({ kind: 'probe', session_id: PROBE_SID });
  });

  it('the same Notification with another type stays a hook', async () => {
    const s = setup();
    expectSilentSuccess(await runHookHandler(hookPayload('Notification', s.base), { mcsHome: s.mcsHome }));
    expect(spoolLines(s.spoolDir)[0]?.kind).toBe('hook');
  });

  it('the same stdin twice gives equal content_hash and different event_uid', async () => {
    const s = setup();
    const rawStdin = JSON.stringify(hookPayload('Stop', s.base));
    await runHookHandler(undefined, { mcsHome: s.mcsHome, event: 'Stop', rawStdin });
    await runHookHandler(undefined, { mcsHome: s.mcsHome, event: 'Stop', rawStdin });
    const [first, second] = spoolLines(s.spoolDir);
    expect(first?.content_hash).toBe(second?.content_hash);
    expect(first?.content_hash).toBe(createHash('sha256').update(rawStdin).digest('hex').slice(0, 32));
    expect(first?.event_uid).not.toBe(second?.event_uid);
    expect(first?.payload_bytes).toBe(Buffer.byteLength(rawStdin));
  });
});

describe('T-HK-14 version mode', () => {
  it('--version prints HANDLER_VERSION and exits 0, also when the guard variable is set', async () => {
    const s = setup();
    for (const extra of [{}, { MCS_HOOK_DISABLE: '1' }]) {
      const result = await runNode(STUB, ['--version'], { env: envFor(s.mcsHome, extra), stdin: '' });
      expect(result).toMatchObject({ code: 0, stdout: `${HANDLER_VERSION}${LF}`, stderr: '' });
    }
  });

  it('without --mcs-hook and without --version nothing is printed and nothing is written', async () => {
    const s = setup();
    const before = snapshotTree(s.root);
    const result = await runNode(STUB, ['--other', 'Stop'], { env: envFor(s.mcsHome), stdin: '{}' });
    expectSilentSuccess(result);
    expect(snapshotTree(s.root)).toBe(before);
  });
});

describe('T-HK-16 legacy-audit-safe spool names', () => {
  it.each([
    [Date.UTC(2026, 9, 11, 14, 5), 'hooks-20261011T14Z.ndjson'],
    [Date.UTC(2026, 0, 1, 0, 0), 'hooks-20260101T00Z.ndjson'],
    [Date.UTC(2026, 11, 31, 23, 59), 'hooks-20261231T23Z.ndjson'],
  ])('spoolSegmentName(%s) is %s', (at, expected) => {
    const name = spoolSegmentName(at);
    expect(name).toBe(expected);
    expect(SPOOL_SEGMENT_RE.test(name)).toBe(true);
    expect(name.endsWith('.jsonl')).toBe(false);
  });

  it('after a routed event data/spool holds only *.ndjson files', async () => {
    const s = setup();
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    const names = readdirSync(s.spoolDir);
    expect(names).toHaveLength(1);
    for (const name of names) {
      expect(name.endsWith('.ndjson')).toBe(true);
      expect(SPOOL_SEGMENT_RE.test(name)).toBe(true);
    }
  });

  const python = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  it.skipIf(python.status !== 0)('the legacy audit accepts a workspace whose spool holds a segment', async () => {
    const s = setup();
    expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome }));
    mkdirSync(join(s.workspace, 'audit'), { recursive: true });
    writeFileSync(join(s.workspace, 'audit', 'changes.md'), '# Changes' + LF);
    const viewer = join(SKILL, 'template', 'viewer.py');
    const result = spawnSync('python', ['-B', viewer, 'audit', '--repo', s.repo, '--task', 'task-a'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...envFor(s.mcsHome), PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual([expect.objectContaining({ task: 'task-a', ok: true })]);
  });
});

describe('T-HK-17 the entry is importable and runnable', () => {
  it('importing dist/hook.js runs nothing', async () => {
    const s = setup();
    const script = join(s.root, 'import-hook.mjs');
    writeFileSync(script, 'await import(process.argv[2]);' + LF);
    const before = snapshotTree(s.root);
    const result = await runNode(script, [pathToFileURL(HOOK_JS).href], { env: envFor(s.mcsHome), stdin: '' });
    expectSilentSuccess(result);
    expect(snapshotTree(s.root)).toBe(before);
  });

  it('node dist/hook.js --mcs-hook <Event> with a probe payload writes one spool line', async () => {
    const s = setup();
    const probe = { ...s.base, sessionId: PROBE_SID, transcriptPath: `${s.transcriptsDir}/${PROBE_SID}.jsonl` };
    const payload = hookPayload('Notification', probe, { notification_type: 'mcs_probe' });
    const result = await runNode(HOOK_JS, ['--mcs-hook', 'Notification'], {
      env: envFor(s.mcsHome),
      stdin: JSON.stringify(payload),
    });
    expectSilentSuccess(result);
    expect(spoolLines(s.spoolDir)).toHaveLength(1);
    expect(spoolLines(s.spoolDir)[0]?.kind).toBe('probe');
  });

  it('runHookHandler default (stub) and direct both write one spool line (05 S3)', async () => {
    const s = setup();
    for (const direct of [false, true]) {
      expectSilentSuccess(await runHookHandler(hookPayload('Stop', s.base), { mcsHome: s.mcsHome, direct }));
    }
    expect(spoolLines(s.spoolDir)).toHaveLength(2);
  });
});
