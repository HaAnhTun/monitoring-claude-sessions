import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { TerminalSectionSchema, type TerminalSection } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import type * as ProcessModule from '../platform/process.ts';
import { forceKillTree, listDescendantPids } from '../platform/process.ts';
import { createDefaultTerminalService, realTerminalFs, selectTerminalBackend } from './default.ts';
import { TerminalError } from './errors.ts';
import { FakePtyBackend } from './fake-pty.ts';
import type { TerminalLogger } from './manager.ts';
import type { LoadedNodePty, NodePtyModule, NodePtySpawnOptions, NodePtyTerm } from './node-pty-loader.ts';
import { KILL_TREE_WAIT_MS } from './session.ts';
import type { PtyBackend } from './types.ts';

// The two process helpers are replaced so that the wiring can be seen without killing or listing a real process. Everything
// else of the module (the registry's pidAlive, the real file system) is the real thing.
vi.mock('../platform/process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessModule>();
  return { ...actual, forceKillTree: vi.fn(), listDescendantPids: vi.fn() };
});

// FIXTURE: invented values. Pids of the stale registry files are far above any real pid.
const tempDir = useTempDirs();
const DEAD_OWNER = 2_147_000_001;
const DEAD_CHILD = 2_147_000_002;

interface LogCall {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function capturingLogger(): { logger: TerminalLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: string) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      calls.push({ level, event, fields });
    };
  return { calls, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

function terminalConfig(overrides: Partial<TerminalSection> = {}): TerminalSection {
  return { ...TerminalSectionSchema.parse(undefined), ...overrides };
}

// ---- a scripted native module ------------------------------------------------------------------------------------------

class ScriptedTerm {
  pid = 0;
  readonly kills: unknown[][] = [];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: { exitCode: number }) => void>();

  readonly onData = (listener: (data: string) => void): { dispose: () => void } => {
    this.#data.add(listener);
    return {
      dispose: () => {
        this.#data.delete(listener);
      },
    };
  };

  readonly onExit = (listener: (event: { exitCode: number }) => void): { dispose: () => void } => {
    this.#exit.add(listener);
    return {
      dispose: () => {
        this.#exit.delete(listener);
      },
    };
  };

  emitData(text: string): void {
    for (const listener of [...this.#data]) listener(text);
  }

  write(): void {
    // nothing is written in these tests
  }

  resize(): void {
    // nothing is resized in these tests
  }

  kill(...args: unknown[]): void {
    this.kills.push(args);
  }
}

class ScriptedNative {
  readonly options: NodePtySpawnOptions[] = [];
  readonly terms: ScriptedTerm[] = [];
  readonly module: NodePtyModule = {
    spawn: (_file, _args, options) => {
      this.options.push(options);
      const term = new ScriptedTerm();
      this.terms.push(term);
      // The scripted term has only the members the adapter uses.
      return term as unknown as NodePtyTerm;
    },
  };

  loaded(): LoadedNodePty {
    return { module: this.module, via: 'bundle', dir: 'C:\\caw\\bundle\\native\\win32-x64' };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// ---- backend selection ---------------------------------------------------------------------------------------------------

describe('selectTerminalBackend: the backend of a host (design 01 sections 3.11, 3.12 and 6)', () => {
  interface Row {
    readonly platform: HostPlatform;
    readonly arch: string;
    readonly release: string;
    readonly expected: { backend: 'node-pty' } | { backend: 'unsupported'; reason: string };
  }

  const rows: readonly Row[] = [
    { platform: 'win32', arch: 'x64', release: '10.0.26200', expected: { backend: 'node-pty' } },
    { platform: 'win32', arch: 'arm64', release: '10.0.22631', expected: { backend: 'node-pty' } },
    { platform: 'win32', arch: 'x64', release: '10.0.17763', expected: { backend: 'node-pty' } },
    {
      platform: 'win32',
      arch: 'x64',
      release: '10.0.17134',
      expected: { backend: 'unsupported', reason: 'os-too-old' },
    },
    {
      platform: 'win32',
      arch: 'ia32',
      release: '10.0.26200',
      expected: { backend: 'unsupported', reason: 'unsupported-os' },
    },
    {
      platform: 'win32',
      arch: 'riscv64',
      release: '10.0.26200',
      expected: { backend: 'unsupported', reason: 'unsupported-os' },
    },
    {
      platform: 'linux',
      arch: 'x64',
      release: '6.8.0',
      expected: { backend: 'unsupported', reason: 'unsupported-os' },
    },
    {
      platform: 'linux',
      arch: 'arm64',
      release: '6.8.0',
      expected: { backend: 'unsupported', reason: 'unsupported-os' },
    },
    {
      platform: 'darwin',
      arch: 'arm64',
      release: '24.1.0',
      expected: { backend: 'unsupported', reason: 'unsupported-os' },
    },
    {
      platform: 'other',
      arch: 'x64',
      release: '1.0.0',
      expected: { backend: 'unsupported', reason: 'unsupported-os' },
    },
  ];

  for (const row of rows) {
    const label = `${row.platform} ${row.arch} ${row.release}`;
    it(`${label}: ${row.expected.backend === 'node-pty' ? 'the addon backend' : row.expected.reason}`, () => {
      const native = new ScriptedNative();
      const load = vi.fn(() => native.loaded());
      const backend = selectTerminalBackend({
        config: terminalConfig(),
        logger: capturingLogger().logger,
        platform: row.platform,
        arch: row.arch,
        release: row.release,
        load,
      });
      expect(backend.name).toBe(row.expected.backend);
      if (row.expected.backend === 'node-pty') {
        expect(backend.support).toEqual({ supported: true });
        expect(load).toHaveBeenCalledTimes(1);
      } else {
        expect(backend.support).toEqual({ supported: false, reason: row.expected.reason });
        // a host that cannot run the terminal never loads the addon
        expect(load).not.toHaveBeenCalled();
      }
    });
  }

  it('is native-missing when the addon is not there and native-load-failed when it does not load', () => {
    const base = {
      config: terminalConfig(),
      logger: capturingLogger().logger,
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26200',
    } as const;
    const missing = selectTerminalBackend({
      ...base,
      load: () => {
        throw new TerminalError('NATIVE_MISSING');
      },
    });
    expect(missing.support).toEqual({ supported: false, reason: 'native-missing' });
    const broken = selectTerminalBackend({
      ...base,
      load: () => {
        throw new Error('dlopen failed at C:\\secret\\conpty.node');
      },
    });
    expect(broken.support).toEqual({ supported: false, reason: 'native-load-failed' });
  });

  it('logs terminal.native by phase, and never the text of a load error', () => {
    const { logger, calls } = capturingLogger();
    selectTerminalBackend({
      config: terminalConfig(),
      logger,
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26200',
      load: () => {
        throw new Error('dlopen failed at C:\\secret\\conpty.node');
      },
    });
    expect(calls).toEqual([{ level: 'warn', event: 'terminal.native', fields: { phase: 'failed' } }]);
  });

  it('gives terminal.conptyDll and terminal.startTimeoutMs to the backend', async () => {
    vi.useFakeTimers();
    const native = new ScriptedNative();
    const backend = selectTerminalBackend({
      config: terminalConfig({ conptyDll: true, startTimeoutMs: 2000 }),
      logger: capturingLogger().logger,
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26200',
      load: () => native.loaded(),
    });
    const pty = backend.spawn('C:\\tools\\claude.exe', [], 'D:\\work', 120, 30, {});
    expect(native.options[0]).toMatchObject({ useConptyDll: true, cols: 120, rows: 30, cwd: 'D:\\work' });
    let settled = false;
    const outcome = pty.started.then(
      () => 'started',
      (error: unknown) => error,
    );
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: 'START_TIMEOUT' });
  });

  it('leaves the conpty flavour off by default', () => {
    const native = new ScriptedNative();
    const backend = selectTerminalBackend({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      platform: 'win32',
      arch: 'x64',
      release: '10.0.26200',
      load: () => native.loaded(),
    });
    backend.spawn('C:\\tools\\claude.exe', [], 'D:\\work', 120, 30, {});
    expect(native.options[0]).toMatchObject({ useConptyDll: false });
  });
});

// ---- the default service -------------------------------------------------------------------------------------------------

describe('createDefaultTerminalService', () => {
  beforeEach(() => {
    vi.mocked(forceKillTree).mockResolvedValue(undefined);
    vi.mocked(listDescendantPids).mockResolvedValue([4000, 4001]);
  });

  /** A real folder with a claude that the real file system finds, for the host the test runs on. */
  function workspace() {
    const root = tempDir('terminal-default').path;
    const bin = path.join(root, 'bin');
    const work = path.join(root, 'work');
    const mcsHome = path.join(root, 'mcs-home');
    mkdirSync(bin);
    mkdirSync(work);
    const program = path.join(bin, hostPlatform === 'win32' ? 'claude.exe' : 'claude');
    writeFileSync(program, '');
    if (hostPlatform !== 'win32') chmodSync(program, 0o755);
    const env = (): Record<string, string | undefined> => ({
      PATH: bin,
      PATHEXT: '.exe',
      SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
      MCS_HOME: mcsHome,
      CLAUDECODE: '1',
    });
    return { root, bin, work, mcsHome, program, env };
  }

  function fakeBackend(): FakePtyBackend {
    return new FakePtyBackend();
  }

  it('reports an unsupported host as such, needs no home folder, and shuts down cleanly', async () => {
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      platform: 'linux',
      arch: 'x64',
      release: '6.8.0',
      // no MCS_HOME, no HOME: resolving the instance home would throw, and an unsupported service has no registry to place
      env: () => ({}),
    });
    expect(service.status()).toMatchObject({
      supported: false,
      reason: 'unsupported-os',
      backend: 'unsupported',
      sessions: 0,
    });
    await expect(service.sweepOrphans()).resolves.toEqual({ files: 0, killed: 0, skipped: 0 });
    await expect(service.create({ folder: '/tmp' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OS' });
    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  it('uses the backend it is given, whatever the platform says', () => {
    const backend: PtyBackend = fakeBackend();
    const w = workspace();
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend,
      platform: 'linux',
      arch: 'x64',
      env: w.env,
      mcsHome: w.mcsHome,
    });
    expect(service.status()).toMatchObject({ supported: true, backend: 'fake' });
  });

  it('finds claude and the folder through the real file system and the environment it is given', async () => {
    const w = workspace();
    const backend = fakeBackend();
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend,
      env: w.env,
      mcsHome: w.mcsHome,
    });
    expect(service.status().claude).toMatchObject({ found: true, kind: 'exe' });
    const info = await service.create({ folder: w.work });
    expect(info.name).toBe('work-1');
    expect(backend.spawns[0]?.cmd.toLowerCase()).toBe(w.program.toLowerCase());
    // the environment function is the one of the options, and the stripping applies
    expect(backend.spawns[0]?.env['CLAUDECODE']).toBeUndefined();
    expect(backend.spawns[0]?.env['MCS_HOME']).toBe(w.mcsHome);
    await expect(service.create({ folder: path.join(w.work, 'missing') })).rejects.toMatchObject({
      code: 'FOLDER_NOT_FOUND',
    });
    // a file is not a folder
    await expect(service.create({ folder: w.program })).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    await service.shutdown();
  });

  it('does not take a folder for the program: claude must be a file', () => {
    const w = workspace();
    mkdirSync(path.join(w.root, 'dirs', hostPlatform === 'win32' ? 'claude.exe' : 'claude'), { recursive: true });
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: () => ({ PATH: path.join(w.root, 'dirs'), PATHEXT: '.exe', MCS_HOME: w.mcsHome }),
      mcsHome: w.mcsHome,
    });
    expect(service.status().claude).toEqual({ found: false, kind: null, display: null });
  });

  it('keeps the child registry under MCS_HOME and removes its file at shutdown', async () => {
    const w = workspace();
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
      clock: new FakeClock(FIXTURE_EPOCH_MS),
    });
    await service.create({ folder: w.work });
    const dir = path.join(w.mcsHome, 'terminals');
    const file = await waitFor(() => readdirSync(dir).find((name) => name.endsWith('.json')), {
      what: 'the registry file',
    });
    const record: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    expect(record).toMatchObject({
      schemaVersion: 1,
      owner: { pid: process.pid },
      children: [{ pid: 1000, spawnedAtMs: FIXTURE_EPOCH_MS }],
    });
    expect(file.startsWith(`${String(process.pid)}-`)).toBe(true);
    await service.shutdown();
    expect(existsSync(path.join(dir, file))).toBe(false);
  });

  it('places the registry under the mcsHome option before MCS_HOME', async () => {
    const w = workspace();
    const elsewhere = path.join(w.root, 'elsewhere');
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
      mcsHome: elsewhere,
    });
    await service.create({ folder: w.work });
    await waitFor(() => existsSync(path.join(elsewhere, 'terminals')), { what: 'the registry folder' });
    expect(existsSync(path.join(w.mcsHome, 'terminals'))).toBe(false);
    await service.shutdown();
  });

  it('sweeps the files of dead owners under MCS_HOME at the first sweep', async () => {
    const w = workspace();
    const dir = path.join(w.mcsHome, 'terminals');
    mkdirSync(dir, { recursive: true });
    const name = `${String(DEAD_OWNER)}-1700000000000.json`;
    writeFileSync(
      path.join(dir, name),
      JSON.stringify({
        schemaVersion: 1,
        owner: { pid: DEAD_OWNER, startedAtMs: 1_700_000_000_000 },
        children: [{ pid: DEAD_CHILD, spawnedAtMs: 1_700_000_001_000 }],
      }),
    );
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
    });
    await expect(service.sweepOrphans()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(existsSync(path.join(dir, name))).toBe(false);
    await service.shutdown();
  });

  it('escalates a kill with forceKillTree', async () => {
    const w = workspace();
    const backend = new FakePtyBackend({ pty: { autoExitOnKill: false } });
    const service = createDefaultTerminalService({
      config: terminalConfig({ killTimeoutMs: 500 }),
      logger: capturingLogger().logger,
      backend,
      env: w.env,
      mcsHome: w.mcsHome,
    });
    await service.create({ folder: w.work });
    vi.useFakeTimers();
    const ended = service.kill('work-1');
    await vi.advanceTimersByTimeAsync(500 + KILL_TREE_WAIT_MS);
    await ended;
    expect(forceKillTree).toHaveBeenCalledWith(1000);
    // Like every other test here, it shuts the service down: a registry write still in flight would recreate the folder of the
    // test after its clean-up and leave a temp folder behind. Real timers: the registry's retries must not wait for a fake clock.
    vi.useRealTimers();
    await service.shutdown();
    const registryDir = path.join(w.mcsHome, 'terminals');
    expect(existsSync(registryDir) ? readdirSync(registryDir) : []).toEqual([]);
  });

  it('asks listDescendantPids for the processes of a session', async () => {
    const w = workspace();
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
      mcsHome: w.mcsHome,
    });
    await service.create({ folder: w.work });
    await expect(service.claudePids('work-1')).resolves.toEqual([1000, 4000, 4001]);
    expect(listDescendantPids).toHaveBeenCalledWith(1000);
    await service.shutdown();
  });

  it('ends the root pids with process.kill at the exit hook', async () => {
    const w = workspace();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
      mcsHome: w.mcsHome,
    });
    await service.create({ folder: w.work });
    service.emergencyKillSync();
    expect(kill).toHaveBeenCalledWith(1000, 'SIGKILL');
    await service.shutdown();
  });

  it('shortens the program shown by status with the home folder it is given', () => {
    const w = workspace();
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
      mcsHome: w.mcsHome,
      home: w.root,
    });
    const shown = service.status().claude.display ?? '';
    expect(shown.startsWith('~')).toBe(true);
    expect(shown).not.toContain(w.root);
  });

  it('reads the clock it is given for the start time of a session', async () => {
    const w = workspace();
    const clock = new FakeClock(FIXTURE_EPOCH_MS + 777);
    const service = createDefaultTerminalService({
      config: terminalConfig(),
      logger: capturingLogger().logger,
      backend: fakeBackend(),
      env: w.env,
      mcsHome: w.mcsHome,
      clock,
    });
    const info = await service.create({ folder: w.work });
    expect(info.startedAt).toBe(FIXTURE_EPOCH_MS + 777);
    await service.shutdown();
  });
});

describe('realTerminalFs', () => {
  it('tells a directory, a file and an executable apart, and says no for what does not exist', () => {
    const root = tempDir('terminal-fs').path;
    const file = path.join(root, 'tool.exe');
    writeFileSync(file, '');
    expect(realTerminalFs.isDirectory(root)).toBe(true);
    expect(realTerminalFs.isDirectory(file)).toBe(false);
    expect(realTerminalFs.isFile(file)).toBe(true);
    expect(realTerminalFs.isFile(root)).toBe(false);
    expect(realTerminalFs.isDirectory(path.join(root, 'missing'))).toBe(false);
    expect(realTerminalFs.isFile(path.join(root, 'missing'))).toBe(false);
    expect(realTerminalFs.isDirectory(path.join(file, 'below-a-file'))).toBe(false);
    expect(realTerminalFs.isExecutable(path.join(root, 'missing'))).toBe(false);
    // a directory has the execute bit but is no program
    expect(realTerminalFs.isExecutable(root)).toBe(false);
  });

  it.runIf(hostPlatform !== 'win32')('treats a file without the execute bit as no program on a POSIX host', () => {
    const root = tempDir('terminal-fs').path;
    const plain = path.join(root, 'plain');
    const tool = path.join(root, 'tool');
    writeFileSync(plain, '');
    writeFileSync(tool, '');
    chmodSync(tool, 0o755);
    chmodSync(plain, 0o644);
    expect(realTerminalFs.isExecutable(plain)).toBe(false);
    expect(realTerminalFs.isExecutable(tool)).toBe(true);
  });
});
