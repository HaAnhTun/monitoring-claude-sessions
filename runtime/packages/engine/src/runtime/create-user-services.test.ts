// The real user services (CAW-31, design 06 1.7, design 02 9, design 03 7.3, ADR 0091, 0093, 0094): what `createUserServices` builds
// for a user instance and how it starts and stops. The context is a real one over a temp workspace; the terminal service is either
// the real one over a scripted pseudo terminal or a script, and the folder dialog and the DA memory of the person are never touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { ACCESS_CODE_RE } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { createDaMemoryReader } from '../folders/da-memory.ts';
import type { LogFields, LogLevel, Logger } from '../log/logger.ts';
import { hostPlatform } from '../platform/host.ts';
import { FakePtyBackend } from '../terminal/fake-pty.ts';
import type { FolderPickerPort } from '../terminal/folder-picker.ts';
import type { TerminalService } from '../terminal/manager.ts';
import type { SweepResult } from '../terminal/types.ts';
import { initWorkspace } from '../workspace/init.ts';
import { buildInstanceContext, type InstanceContext } from './context.ts';
import { createUserServices, type CreateUserServicesOptions } from './create-user-services.ts';
import type { RuntimeComponent } from './instance-runtime.ts';
import type { UserServices } from './user-services.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const TOKEN = 'ab'.repeat(32);

interface Logged {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields;
}

function fakeLogger(): { logger: Logger; calls: Logged[] } {
  const calls: Logged[] = [];
  const record =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      calls.push({ level, event, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
  return { logger, calls };
}

const contexts: InstanceContext[] = [];
const started: UserServices[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const services of started.splice(0)) {
    for (const component of [...services.components].reverse()) await component.stop(Number.MAX_SAFE_INTEGER);
  }
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

interface Env {
  readonly root: string;
  readonly ctx: InstanceContext;
  readonly calls: Logged[];
  readonly ingest: { hintSession: ReturnType<typeof vi.fn<(id: string) => void>> };
}

async function makeEnv(): Promise<Env> {
  const root = makeTemp('user-services').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID, kind: 'user' });
  const { logger, calls } = fakeLogger();
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger,
    processInfo: { pid: 4_000_001 },
  });
  contexts.push(ctx);
  return { root, ctx, calls, ingest: { hintSession: vi.fn<(id: string) => void>() } };
}

/** Options that keep the services inside the test: a scripted pseudo terminal, no folder dialog, no DA memory of the person. */
function inside(env: Env, over: CreateUserServicesOptions = {}, defaultPicker = false): CreateUserServicesOptions {
  return {
    terminal: { backend: new FakePtyBackend(), env: () => ({}) },
    ...(defaultPicker ? {} : { picker: null }),
    folders: {
      daMemory: createDaMemoryReader({ dir: path.join(env.root, 'no-da-memory'), cacheMs: 0 }),
      homeDir: env.root,
    },
    ...over,
  };
}

function build(env: Env, over: CreateUserServicesOptions = {}, defaultPicker = false): UserServices {
  const services = createUserServices(env.ctx, { ingest: env.ingest }, inside(env, over, defaultPicker));
  started.push(services);
  return services;
}

async function startAll(services: UserServices): Promise<void> {
  for (const component of services.components) await component.start();
}

function component(services: UserServices, name: string): RuntimeComponent {
  const found = services.components.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no component ${name}`);
  return found;
}

/** A terminal service that is a script: every call is counted, nothing starts. */
function scripted(over: Partial<TerminalService> = {}): TerminalService & { calls: string[] } {
  const calls: string[] = [];
  const note =
    <T>(name: string, value: T) =>
    (): T => {
      calls.push(name);
      return value;
    };
  return {
    calls,
    status: () => ({
      supported: true,
      reason: null,
      backend: 'fake',
      claude: { found: true, kind: 'exe', display: null },
      sessions: 0,
      maxSessions: 8,
      conptyDll: false,
    }),
    create: () => Promise.reject(new Error('not scripted')),
    list: () => [],
    get: () => undefined,
    kill: () => Promise.resolve(false),
    killAll: note('killAll', Promise.resolve()),
    liveCount: note('liveCount', 3),
    beginDrain: note('beginDrain', undefined),
    onChange: () => () => undefined,
    claudePids: () => Promise.resolve([]),
    sweepOrphans: note('sweepOrphans', Promise.resolve({ files: 0, killed: 0, skipped: 0 })),
    shutdown: note('shutdown', Promise.resolve()),
    emergencyKillSync: note('emergencyKillSync', undefined),
    ...over,
  };
}

class FakeProcess {
  readonly listeners = new Set<() => void>();
  on(event: 'exit', listener: () => void): this {
    expect(event).toBe('exit');
    this.listeners.add(listener);
    return this;
  }
  off(event: 'exit', listener: () => void): this {
    expect(event).toBe('exit');
    this.listeners.delete(listener);
    return this;
  }
  exit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

describe('what createUserServices builds', () => {
  it('a census, the minter, the whole access service, the terminal host, the folder service and three components', async () => {
    const env = await makeEnv();
    const services = build(env);
    expect(services.access).not.toBeNull();
    expect(services.accessService).toBe(services.access);
    expect(services.terminal).not.toBeNull();
    expect(services.folders).not.toBeNull();
    expect(services.components.map((c) => c.name)).toEqual(['folders', 'terminal-link', 'terminal']);
    expect(services.census.count()).toBe(0);
    expect(services.census.sessions(10)).toEqual([]);
  });

  it('is the factory of RuntimeFactories: it takes the context and the services of the runtime', async () => {
    const env = await makeEnv();
    const factory: (ctx: InstanceContext, services: { ingest: Env['ingest'] }) => UserServices = (ctx, services) =>
      createUserServices(ctx, services, inside(env));
    started.push(factory(env.ctx, { ingest: env.ingest }));
    expect(started).toHaveLength(1);
  });

  it('mints a one-use access code for the control op and takes it back as a session credential', async () => {
    const env = await makeEnv();
    const services = build(env);
    const minted = services.access?.mint();
    expect(minted?.code).toMatch(ACCESS_CODE_RE);
    expect(minted?.ttlSeconds).toBe(120);
    const code = minted?.code ?? '';
    const outcome = services.accessService?.exchange(code);
    expect(outcome?.ok).toBe(true);
    expect(services.accessService?.exchange(code)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('does not apply the fake-terminals hook itself: the server wraps the census once', async () => {
    vi.stubEnv('MCS_TEST', '1');
    vi.stubEnv('MCS_TEST_FAKE_TERMINALS', '3');
    const env = await makeEnv();
    expect(build(env).census.count()).toBe(0);
  });

  it('gives the host the picker it is told to, none by default where there is no dialog, and the fake one under the test hook', async () => {
    const env = await makeEnv();
    const fake: FolderPickerPort = { pick: () => Promise.resolve(null) };
    expect(build(env, { picker: fake }).terminal?.picker).toBe(fake);
    expect(build(env, { picker: null }).terminal?.picker).toBeNull();
    const hooked = build(
      env,
      { env: { MCS_TEST: '1', MCS_TEST_FOLDER_PICKER: path.join(env.root, 'fake-picker.mjs') } },
      true,
    );
    expect(hooked.terminal?.picker).not.toBeNull();
    // without the hook and off Windows there is no dialog; on Windows the real one is the default
    const plain = build(env, { env: {} }, true);
    expect(plain.terminal?.picker === null).toBe(hostPlatform !== 'win32');
  });

  it('answers the capabilities of the terminal service it made (a scripted backend that is unsupported is unavailable)', async () => {
    const env = await makeEnv();
    const services = build(env, {
      terminal: {
        backend: new FakePtyBackend({ support: { supported: false, reason: 'native-missing' } }),
        env: () => ({}),
      },
    });
    expect(services.terminal?.capabilities()).toMatchObject({ available: false, reason: 'addon_missing' });
  });
});

describe('the control token as a Bearer value (design 02 A1)', () => {
  const tokenFile = (env: Env): string => path.join(env.ctx.instanceDir, 'run', 'control.token');

  it('is false while run/control.token does not exist, true once boot wrote it, and follows a new token', async () => {
    const env = await makeEnv();
    const services = build(env);
    const access = services.accessService;
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(false);
    mkdirSync(path.dirname(tokenFile(env)), { recursive: true });
    writeFileSync(tokenFile(env), `${TOKEN}\n`);
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(true);
    expect(access?.verifyBearer(`Bearer ${'cd'.repeat(32)}`)).toBe(false);
    const next = 'ef'.repeat(32);
    writeFileSync(tokenFile(env), `${next}\n`);
    expect(access?.verifyBearer(`Bearer ${next}`)).toBe(true);
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(false);
  });

  it('refuses a file that is not a token (wrong shape, too large)', async () => {
    const env = await makeEnv();
    const access = build(env).accessService;
    mkdirSync(path.dirname(tokenFile(env)), { recursive: true });
    writeFileSync(tokenFile(env), 'not-a-token\n');
    expect(access?.verifyBearer('Bearer not-a-token')).toBe(false);
    writeFileSync(tokenFile(env), `${TOKEN}\n${'x'.repeat(8000)}`);
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(false);
  });

  it('takes a token source from the options instead of the file (tests)', async () => {
    const env = await makeEnv();
    const access = build(env, { controlToken: () => TOKEN }).accessService;
    expect(access?.verifyBearer(`Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('the terminal component: start', () => {
  it('sweeps the registry of a dead run once at start (a stale file of another owner goes)', async () => {
    const env = await makeEnv();
    const dir = path.join(env.ctx.mcsHome, 'terminals');
    mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, '99999-1.json');
    writeFileSync(stale, 'this is not a registry file');
    const services = build(env);
    expect(existsSync(stale)).toBe(true);
    await startAll(services);
    expect(existsSync(stale)).toBe(false);
  });

  it('registers the exit hook before the sweep, and the hook ends every process synchronously', async () => {
    const env = await makeEnv();
    const service = scripted();
    const proc = new FakeProcess();
    const services = build(env, { terminalService: service, exitHook: proc });
    expect(proc.listeners.size).toBe(0);
    await component(services, 'terminal').start();
    expect(proc.listeners.size).toBe(1);
    expect(service.calls).toEqual(['sweepOrphans']);
    proc.exit();
    expect(service.calls).toContain('emergencyKillSync');
  });

  it('waits for the sweep at most the budget (10 s) and then goes on; the late sweep is not awaited', async () => {
    const env = await makeEnv();
    vi.useFakeTimers();
    const service = scripted({ sweepOrphans: () => new Promise<SweepResult>(() => undefined) });
    const services = build(env, { terminalService: service, exitHook: new FakeProcess() });
    let done = false;
    const starting = Promise.resolve(component(services, 'terminal').start()).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(done).toBe(true);
    expect(env.calls.some((c) => c.level === 'warn' && c.event === 'terminal_sweep_budget')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts also when the sweep fails: a registry that cannot be swept must not keep the app down', async () => {
    const env = await makeEnv();
    const service = scripted({ sweepOrphans: () => Promise.reject(new Error('disk')) });
    const services = build(env, { terminalService: service, exitHook: new FakeProcess() });
    await expect(component(services, 'terminal').start()).resolves.toBeUndefined();
    expect(env.calls.some((c) => c.event === 'terminal_sweep_failed')).toBe(true);
    // the text of the error is never logged
    expect(JSON.stringify(env.calls)).not.toContain('disk');
  });

  it('starts the folder service and the linker as their own components', async () => {
    const env = await makeEnv();
    const services = build(env);
    await component(services, 'folders').start();
    await component(services, 'terminal-link').start();
    const list = await services.folders?.list();
    expect(list).toBeDefined();
  });
});

describe('the terminal component: stop', () => {
  it('shuts the terminal service down once, takes the exit hook off and closes the host', async () => {
    const env = await makeEnv();
    const service = scripted();
    const proc = new FakeProcess();
    const services = build(env, { terminalService: service, exitHook: proc });
    await component(services, 'terminal').start();
    await component(services, 'terminal').stop(NOW + 5000);
    expect(service.calls.filter((c) => c === 'shutdown')).toHaveLength(1);
    // a second stop is harmless: the terminal service's own shutdown is idempotent and the hook is already off
    await expect(component(services, 'terminal').stop(NOW + 5000)).resolves.toBeUndefined();
    expect(proc.listeners.size).toBe(0);
    proc.exit();
    expect(service.calls).not.toContain('emergencyKillSync');
  });
});

describe('the census', () => {
  it('counts what the terminal service counts and hands the drain to it', async () => {
    const env = await makeEnv();
    const service = scripted();
    const services = build(env, { terminalService: service, exitHook: new FakeProcess() });
    expect(services.census.count()).toBe(3);
    services.census.beginDrain();
    expect(service.calls).toEqual(['liveCount', 'beginDrain']);
  });
});
