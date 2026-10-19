// `ops.diagnostics.bundle` (01 6.4, V4): the privacy canaries never reach the bundle, the bundle validates against
// `DiagnosticsBundleSchema`, strings of the configuration become markers, the file is written once and never over an
// existing one, and the collection changes nothing but that file.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHILD_KINDS, DiagnosticsBundleSchema, McsError, type HooksVerifyResult } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import {
  SAFE_ENUMS,
  bundle,
  classifyConfigValue,
  collect,
  logRecordOf,
  makeScrubber,
  type DiagnosticsDeps,
  type DiagnosticsSeams,
} from './diagnostics.ts';
import type { DoctorSeams } from './doctor-checks.ts';
import type { HttpAttempt, ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

const HERE = fileURLToPath(import.meta.url);
const LF = String.fromCharCode(10);
const AT = '2026-10-19T10:00:00.000Z';
/** Strings that must never appear in a bundle. */
const CANARIES = {
  prompt: 'CANARY_PROMPT_TEXT_91',
  regex: 'CANARY_REGEX_(sess|ion)+_77',
  regexWord: 'CANARY_REGEX_',
  title: 'CANARY_TITLE_55',
  envSecret: 'canary-env-secret-value-42',
  token: 'a'.repeat(32) + 'b'.repeat(32),
  logField: 'CANARY_LOG_FIELD_33',
};

const STOPPED: ProbeResult = {
  state: 'stopped',
  engine: null,
  pid: null,
  url: null,
  port: null,
  identity: null,
  stateFile: null,
  stateFileBytes: null,
  reason: 'no state file',
};

const DOCTOR_SEAMS: Partial<DoctorSeams> = {
  layoutOf: (runtimeDir) => ({
    mode: 'source',
    skillDir: path.dirname(runtimeDir),
    runtimeDir,
    launcherPath: HERE,
    serverEntry: HERE,
    hookEntry: HERE,
    webDir: path.dirname(HERE),
    migrationsDir: path.dirname(HERE),
    stampFile: path.join(runtimeDir, '.mcs-build.json'),
  }),
  probe: () => Promise.resolve(STOPPED),
  run: () => Promise.resolve(null),
  canBind: () => Promise.resolve(true),
  freeBytes: () => Promise.resolve(50 * 1024 ** 3),
  nodeVersion: '24.0.0',
  codeStamp: () => Promise.resolve('stamp-1'),
};

const SEAMS: Partial<DiagnosticsSeams> = { doctor: DOCTOR_SEAMS, arch: 'x64' };
const DEPS: DiagnosticsDeps = { lifecycle: { probe: () => Promise.resolve(STOPPED) } };

interface Setup {
  readonly ctx: OpContext;
  readonly root: string;
  readonly repo: string;
  readonly tasksRoot: string;
  readonly home: string;
  readonly claudeHome: string;
  readonly wsDir: string;
}

function setup(config: Record<string, unknown> = {}): Setup {
  const root = makeTemp('diagnostics').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  const home = path.join(root, 'home');
  const claudeHome = path.join(home, '.claude');
  const transcripts = path.join(root, 'transcripts');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    path.join(transcripts, 'one.jsonl'),
    `${JSON.stringify({ type: 'user', message: { content: CANARIES.prompt } })}${LF}`,
  );
  const wsDir = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: {
      title: CANARIES.title,
      transcripts_dir: transcripts,
      session_rules: [{ match: CANARIES.regex, label: 'x' }],
      window_hours: 6,
      ...config,
    },
    instance: { slug: 'demo' },
  });
  const skillDir = defaultSkillDir();
  return {
    root,
    repo,
    tasksRoot,
    home,
    claudeHome,
    wsDir,
    ctx: {
      repo,
      root: tasksRoot,
      skillDir,
      runtimeDir: path.join(skillDir, 'runtime'),
      launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
      env: {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: claudeHome,
        MCS_HOME: path.join(home, 'mcs'),
        API_TOKEN_CANARY: CANARIES.envSecret,
        CANARY_PLAIN_ENV: 'canary-plain-env-value-88',
      },
      clock: new FakeClock(Date.UTC(2026, 9, 19)),
      log: silent,
    },
  };
}

function writeRuntimeLog(wsDir: string, lines: readonly object[]): void {
  mkdirSync(path.join(wsDir, 'logs'), { recursive: true });
  writeFileSync(path.join(wsDir, 'logs', 'runtime.log'), lines.map((l) => JSON.stringify(l)).join(LF) + LF);
}

function logFiles(wsDir: string): string[] {
  const dir = path.join(wsDir, 'logs');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('diagnostics-')) : [];
}

/** The real form of a path (the temp folder of Windows is often written in its 8.3 short form). */
function real(p: string): string {
  return path.join(realpathSync.native(path.dirname(p)), path.basename(p));
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('privacy', () => {
  it('holds no prompt, regex, title, environment value, token or raw home and repo path', async () => {
    const s = setup();
    mkdirSync(path.join(s.wsDir, 'run'), { recursive: true });
    writeFileSync(path.join(s.wsDir, 'run', 'control.token'), CANARIES.token);
    writeRuntimeLog(s.wsDir, [
      { ts: AT, level: 'info', event: 'started', port: 18000, pid: 4242, prompt: CANARIES.logField },
      { ts: AT, level: 'warn', event: 'slow', route: `${s.repo}/x`, code: 'E_SLOW' },
    ]);
    const result = await collect(s.ctx, { task: 'demo' }, DEPS, { ...SEAMS, homeDirs: [s.home] });
    const text = JSON.stringify(result);
    for (const [name, canary] of Object.entries(CANARIES)) expect(text.includes(canary), name).toBe(false);
    expect(text.includes('CANARY_PLAIN_ENV')).toBe(false);
    expect(text.includes('canary-plain-env-value-88')).toBe(false);
    for (const raw of [s.repo, s.home, s.root]) {
      expect(text.includes(raw), raw).toBe(false);
      expect(text.includes(raw.replace(/\\/g, '/')), raw).toBe(false);
      expect(text.includes(raw.replace(/\\/g, '\\\\')), raw).toBe(false);
    }
    expect(text).toContain('<repo>/.claude/monitor/tasks/demo/config.json');
    expect(DiagnosticsBundleSchema.safeParse(result).success).toBe(true);
    // the log field that is not on the allow-list is gone, the allowed ones stay
    expect(result.logTail[0]).toEqual({ ts: AT, level: 'info', event: 'started', port: 18000, pid: 4242 });
  });

  it('withholds the message of a failed config check, which can quote a pattern', async () => {
    const s = setup({ session_rules: [{ match: `${CANARIES.regexWord}(unclosed`, label: 'x' }] });
    const result = await collect(s.ctx, { task: 'demo' }, DEPS, SEAMS);
    const check = result.doctor.find((c) => c.id === 'config.valid');
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain('withheld');
    expect(JSON.stringify(result)).not.toContain(CANARIES.regexWord);
    expect(result.config).toBeNull();
    expect(result.notes.some((n) => n.startsWith('config: not resolved'))).toBe(true);
  });

  it('keeps only numbers, booleans and members of closed word lists in safeValues', async () => {
    const s = setup({ ui: { theme: 'dark', density: 'compact' } });
    const result = await collect(s.ctx, { task: 'demo' }, DEPS, SEAMS);
    const config = result.config;
    expect(config).not.toBeNull();
    const safe = config?.safeValues ?? {};
    for (const [key, value] of Object.entries(safe)) {
      if (typeof value === 'string') expect(SAFE_ENUMS[key]?.includes(value), key).toBe(true);
    }
    expect(safe['window_hours']).toBe(6);
    expect(safe['ui.theme']).toBe('dark');
    expect(safe['ui.density']).toBe('compact');
    expect(typeof safe['effectivePort']).toBe('number');
    expect(config?.redacted['title']).toBe(`<text length=${String(CANARIES.title.length)}>`);
    expect(config?.redacted['session_rules']).toBe('<list length=1>');
    expect(config?.redacted['transcripts_dir']).toBe('<path>');
    expect(Object.keys(safe).some((k) => k in (config?.redacted ?? {}))).toBe(false);
    expect(config?.provenance['title']).toBe('config');
  });

  it('every closed word list names a key of the configuration', async () => {
    const s = setup();
    const result = await collect(s.ctx, { task: 'demo' }, DEPS, SEAMS);
    const keys = new Set(Object.keys(result.config?.provenance ?? {}));
    for (const key of Object.keys(SAFE_ENUMS)) expect(keys.has(key), key).toBe(true);
  });
});

describe('classifyConfigValue', () => {
  it('keeps numbers, booleans and listed words; marks everything else', () => {
    expect(classifyConfigValue('port', 8765)).toEqual({ safe: 8765 });
    expect(classifyConfigValue('docker', false)).toEqual({ safe: false });
    expect(classifyConfigValue('ui.theme', 'dark')).toEqual({ safe: 'dark' });
    expect(classifyConfigValue('ui.theme', 'neon')).toEqual({ marker: '<text length=4>' });
    expect(classifyConfigValue('repo', '.')).toEqual({ marker: '<path>' });
    expect(classifyConfigValue('chain_log', 'a/b.log')).toEqual({ marker: '<path>' });
    expect(classifyConfigValue('attempts.pattern', 'x+')).toEqual({ marker: '<pattern length=2>' });
    expect(classifyConfigValue('title', 'My title')).toEqual({ marker: '<text length=8>' });
    expect(classifyConfigValue('ledger', null)).toEqual({ marker: '<unset>' });
    expect(classifyConfigValue('session_ids', ['a', 'b'])).toEqual({ marker: '<list length=2>' });
    expect(classifyConfigValue('x', { a: 1 })).toEqual({ marker: '<object keys=1>' });
    expect(classifyConfigValue('x', Number.NaN)).toEqual({ marker: '<number>' });
  });
});

describe('makeScrubber', () => {
  const env = { HOME: '/home/alice', API_KEY_X: 'super-secret-9' };

  it('rewrites the repository first, then the home, in either slash form', () => {
    const scrub = makeScrubber(env, ['/home/alice/work/repo'], [], false);
    expect(scrub.string('/home/alice/work/repo/.claude/a.json')).toBe('<repo>/.claude/a.json');
    expect(scrub.string('at /home/alice/.claude/x')).toBe('at <home>/.claude/x');
    expect(scrub.string('/home/alice/work/repository')).toBe('<home>/work/repository');
    const win = makeScrubber({ USERPROFILE: 'C:\\Users\\alice' }, ['C:\\Users\\alice\\repo'], [], true);
    expect(win.string('C:\\Users\\alice\\repo\\.claude\\a.json')).toBe('<repo>/.claude/a.json');
    expect(win.string('c:/users/alice/repo/x')).toBe('<repo>/x');
    expect(win.string('C:\\Users\\alice\\AppData\\Local\\mcs')).toBe('<home>/AppData/Local/mcs');
  });

  it('rewrites any other absolute path and keeps routes and plain text', () => {
    const scrub = makeScrubber(env, ['/srv/repo-not-here-xyz/r'], [], false);
    expect(scrub.string('D:\\other\\place\\f.txt failed')).toBe('<path> failed');
    expect(scrub.string('\\\\host\\share\\dir\\f')).toBe('<path>');
    expect(scrub.string('read /var/folders/ab/cd/T/x and /tmp/y')).toBe('read <path> and <path>');
    expect(scrub.string('GET /api/v3/health returned 200')).toBe('GET /api/v3/health returned 200');
    expect(scrub.string('ratio 3/4 and 12:30')).toBe('ratio 3/4 and 12:30');
  });

  it('replaces the value of an environment variable that looks like a secret', () => {
    const scrub = makeScrubber(env, ['/r/p'], [], false);
    expect(scrub.string('key super-secret-9 leaked')).toBe('key <redacted> leaked');
    expect(scrub.deep({ a: ['super-secret-9'], n: 3 })).toEqual({ a: ['<redacted>'], n: 3 });
  });
});

describe('logRecordOf', () => {
  it('keeps the allow-listed fields with short plain values and drops the rest', () => {
    expect(logRecordOf(JSON.stringify({ ts: AT, level: 'error', event: 'e', code: 'X', pid: 5, bytes: 1.5 }))).toEqual({
      ts: AT,
      level: 'error',
      event: 'e',
      code: 'X',
      pid: 5,
      bytes: 1.5,
    });
    expect(
      logRecordOf(JSON.stringify({ ts: AT, level: 'info', event: 'e', note: 'free text', code: { a: 1 } })),
    ).toEqual({
      ts: AT,
      level: 'info',
      event: 'e',
    });
    expect(logRecordOf(JSON.stringify({ ts: AT, level: 'info', event: 'e', code: 'x'.repeat(129) }))).toEqual({
      ts: AT,
      level: 'info',
      event: 'e',
    });
  });

  it('skips lines that are not records', () => {
    for (const line of ['', 'not json', '[]', '{"ts":1}', JSON.stringify({ ts: AT, level: 'loud', event: 'e' })]) {
      expect(logRecordOf(line), line).toBeNull();
    }
  });
});

describe('the sections', () => {
  it('without a task holds only the machine-wide sections', async () => {
    const s = setup();
    const result = await collect(s.ctx, {}, DEPS, SEAMS);
    expect(result).toMatchObject({
      schema: 'mcs.diagnostics/1',
      generatedAt: '2026-10-19T00:00:00.000Z',
      runtime: { node: '24.0.0', arch: 'x64', codeStamp: 'stamp-1', buildCurrent: null },
      instance: null,
      config: null,
      status: null,
      health: null,
      hooks: null,
      logTail: [],
      disk: { freeBytes: 50 * 1024 ** 3 },
    });
    expect(result.doctor.map((c) => c.id)).toContain('node.version');
  });

  it('with a stopped task holds the instance, the status and the last 200 log records', async () => {
    const s = setup();
    const lines = Array.from({ length: 250 }, (_unused, i) => ({ ts: AT, level: 'info', event: 'tick', count: i }));
    writeRuntimeLog(s.wsDir, lines);
    const result = await collect(s.ctx, { task: 'demo' }, DEPS, SEAMS);
    expect(result.instance).toMatchObject({ slug: 'demo', dbSchemaVersion: 0, hooksEnabled: false });
    expect(result.status).toMatchObject({ running: false, probe: 'stopped', pid: null, sessions: null });
    expect(result.health).toBeNull();
    expect(result.notes).toContain('health: no runtime runs');
    expect(result.logTail).toHaveLength(200);
    expect(result.logTail[0]?.['count']).toBe(50);
    expect(result.logTail[199]?.['count']).toBe(249);
  });

  it('reads the health of a running instance and reduces its alerts to numbers', async () => {
    const s = setup();
    const running: ProbeResult = {
      ...STOPPED,
      state: 'running',
      pid: 4242,
      url: 'http://127.0.0.1:18123',
      port: 18123,
    };
    const body = healthBody();
    const httpGet = (url: string): Promise<HttpAttempt> =>
      Promise.resolve(
        url.endsWith('/api/v3/health')
          ? { ok: true, reply: { status: 200, body: JSON.stringify(body) } }
          : { ok: true, reply: { status: 404, body: '{}' } },
      );
    const deps: DiagnosticsDeps = { lifecycle: { probe: () => Promise.resolve(running), httpGet } };
    const result = await collect(s.ctx, { task: 'demo' }, deps, SEAMS);
    expect(result.status).toMatchObject({ running: true, pid: 4242, url: 'http://127.0.0.1:18123' });
    expect(result.health?.db.schemaVersion).toBe(1);
    expect(result.instance?.dbSchemaVersion).toBe(1);
    expect(result.health?.alerts).toEqual([
      { rule: 'inactivity', severity: 'warning', status: 'open', since: AT, fireCount: 2 },
    ]);
    expect(JSON.stringify(result)).not.toContain('CANARY_ALERT_TITLE');
    expect(result.health?.errors[0]?.message).toBe('failed <path>');
  });

  it('says why the health is missing when the answer is wrong', async () => {
    const s = setup();
    const running: ProbeResult = { ...STOPPED, state: 'running', pid: 1, url: 'http://127.0.0.1:18124', port: 18124 };
    const httpGet = (): Promise<HttpAttempt> => Promise.resolve({ ok: true, reply: { status: 200, body: '{"a":1}' } });
    const result = await collect(
      s.ctx,
      { task: 'demo' },
      { lifecycle: { probe: () => Promise.resolve(running), httpGet } },
      SEAMS,
    );
    expect(result.health).toBeNull();
    expect(result.notes).toContain('health: the answer does not match the health schema');
  });

  it('takes the hooks section from the dependency and survives one that throws', async () => {
    const s = setup();
    const verify: HooksVerifyResult = { checks: [{ check: 'V1', ok: true, detail: 'settings found' }] };
    const withHooks = await collect(
      s.ctx,
      { task: 'demo' },
      { ...DEPS, hooksVerify: () => Promise.resolve(verify) },
      SEAMS,
    );
    expect(withHooks.hooks).toEqual(verify);
    const failing = await collect(
      s.ctx,
      { task: 'demo' },
      { ...DEPS, hooksVerify: () => Promise.reject(new Error('boom')) },
      SEAMS,
    );
    expect(failing.hooks).toBeNull();
    expect(failing.notes).toContain('hooks: not verified (Error)');
  });

  it('refuses an unknown task', async () => {
    const s = setup();
    expect(await codeOf(collect(s.ctx, { task: 'nope' }, DEPS, SEAMS))).toBe('TASK_NOT_FOUND');
  });
});

describe('ops.diagnostics.bundle', () => {
  it('writes logs/diagnostics-<UTC>.json once per call, never over a file, and changes nothing else', async () => {
    const s = setup();
    const before = snapshotTree(s.wsDir, { exclude: ['logs'] });
    const first = await bundle(s.ctx, { task: 'demo' }, DEPS, SEAMS);
    expect(first.path).toBe(path.join(real(s.wsDir), 'logs', 'diagnostics-20261019T000000Z.json'));
    const second = await bundle(s.ctx, { task: 'demo' }, DEPS, SEAMS);
    expect(second.path).toBe(path.join(real(s.wsDir), 'logs', 'diagnostics-20261019T000000Z-2.json'));
    expect(logFiles(s.wsDir).sort()).toEqual([
      'diagnostics-20261019T000000Z-2.json',
      'diagnostics-20261019T000000Z.json',
    ]);
    const text = readFileSync(first.path, 'utf8');
    expect(text.endsWith(LF)).toBe(true);
    expect(DiagnosticsBundleSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(first.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(snapshotTree(s.wsDir, { exclude: ['logs'] })).toEqual(before);
  });

  it('writes to --out, and refuses an existing file without touching it', async () => {
    const s = setup();
    const out = path.join(s.root, 'report.json');
    const made = await bundle(s.ctx, { out }, DEPS, SEAMS);
    expect(made.path).toBe(real(out));
    expect(made.bundle.config).toBeNull();
    const content = readFileSync(out, 'utf8');
    expect(await codeOf(bundle(s.ctx, { out }, DEPS, SEAMS))).toBe('OUTPUT_EXISTS');
    expect(await codeOf(bundle(s.ctx, { task: 'demo', out }, DEPS, SEAMS))).toBe('OUTPUT_EXISTS');
    expect(readFileSync(out, 'utf8')).toBe(content);
  });

  it('needs a task or an output file', async () => {
    const s = setup();
    expect(await codeOf(bundle(s.ctx, {}, DEPS, SEAMS))).toBe('USAGE');
  });

  it('never writes inside the Claude home, another place of the tasks folder or a missing folder', async () => {
    const s = setup();
    buildTaskWorkspace(s.repo, { slug: 'other', config: {}, instance: { slug: 'other' } });
    mkdirSync(path.join(s.wsDir, 'data'), { recursive: true });
    const targets = [
      { task: 'demo', out: path.join(s.claudeHome, 'diag.json') },
      { out: path.join(s.claudeHome, 'diag.json') },
      { task: 'demo', out: path.join(s.tasksRoot, 'other', 'logs', 'diag.json') },
      { task: 'demo', out: path.join(s.wsDir, 'data', 'diag.json') },
      { task: 'demo', out: path.join(s.wsDir, 'diag.json') },
      { out: path.join(s.wsDir, 'logs', 'diag.json') },
      { task: 'demo', out: path.join(s.wsDir, 'logs', 'diag.jsonl') },
      { out: path.join(s.root, 'no-such-folder', 'diag.json') },
    ];
    for (const target of targets) {
      expect(await codeOf(bundle(s.ctx, target, DEPS, SEAMS)), JSON.stringify(target)).toBe('OUTPUT_PATH_FORBIDDEN');
    }
    expect(existsSync(path.join(s.claudeHome, 'diag.json'))).toBe(false);
    expect(existsSync(path.join(s.tasksRoot, 'other', 'logs'))).toBe(false);
  });

  it('allows the logs folder of the task it describes as an explicit output', async () => {
    const s = setup();
    mkdirSync(path.join(s.wsDir, 'logs'), { recursive: true });
    const out = path.join(s.wsDir, 'logs', 'mine.json');
    expect((await bundle(s.ctx, { task: 'demo', out }, DEPS, SEAMS)).path).toBe(real(out));
  });

  it('the file holds no canary', async () => {
    const s = setup();
    const result = await bundle(s.ctx, { task: 'demo' }, DEPS, { ...SEAMS, homeDirs: [s.home] });
    const text = readFileSync(result.path, 'utf8');
    for (const canary of [CANARIES.prompt, CANARIES.regexWord, CANARIES.title, CANARIES.envSecret, s.repo, s.home]) {
      expect(text.includes(canary), canary).toBe(false);
    }
  });
});

function healthBody(): unknown {
  return {
    checkedAt: AT,
    status: 'ok',
    instanceId: '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b',
    asOfSeq: 12,
    epoch: 'deadbeef',
    runtime: {
      version: '4.0.0',
      codeStamp: 'abc123',
      outdated: false,
      pid: 4242,
      startedAt: AT,
      uptimeMs: 5000,
      eventLoopDelayP99Ms: 1.5,
      rssBytes: 100_000_000,
      heapUsedBytes: 20_000_000,
      cpuUserMicros: 123,
      cpuSystemMicros: 45,
      sseClients: 1,
      previousRunUnclean: false,
      ownershipConflict: false,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    },
    db: { ok: true, sizeBytes: 1000, walBytes: 0, freeDiskBytes: null, schemaVersion: 1, lastError: null },
    ingestion: {
      status: 'ok',
      reasons: [],
      hooks: {
        enabled: false,
        installed: null,
        lastReceivedAt: null,
        lastEventAt: null,
        spoolPendingBytes: 0,
        spoolLagMs: null,
        errorsLastHour: 0,
        lastError: null,
      },
      transcripts: {
        dirFound: true,
        filesTracked: 1,
        lastScanAt: AT,
        lastImportedAt: AT,
        importLagMs: 10,
        pendingBytes: 0,
        invalidLines: 0,
        errorsLastHour: 0,
        lastError: null,
      },
    },
    children: Object.fromEntries(CHILD_KINDS.map((k) => [k, { spawned: 0, failed: 0, timedOut: 0, totalMs: 0 }])),
    panels: {},
    alerts: [
      {
        id: 1,
        seq: 3,
        ruleId: 'inactivity',
        rule: 'inactivity',
        severity: 'warning',
        status: 'open',
        title: 'CANARY_ALERT_TITLE',
        scope: { kind: 'session', key: 'CANARY_ALERT_TITLE' },
        sessionId: null,
        since: AT,
        lastFiredAt: AT,
        fireCount: 2,
        resolvedAt: null,
        resolvedReason: null,
        detail: { note: 'CANARY_ALERT_TITLE' },
      },
    ],
    errors: [
      {
        at: AT,
        source: 'server',
        code: 'INTERNAL',
        where: 'listSessions',
        message: 'failed C:\\Users\\bob\\x.txt',
        sessionId: null,
      },
    ],
  };
}
