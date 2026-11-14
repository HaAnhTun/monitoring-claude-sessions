import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FIXTURE_EPOCH_MS, useTempDirs, waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { LOG_FIELD_NAMES } from '../log/logger.ts';
import {
  OWNER_START_TOLERANCE_MS,
  REGISTRY_FILE_MAX_BYTES,
  REGISTRY_MAX_CHILDREN,
  SPAWN_WINDOW_AFTER_MS,
  SPAWN_WINDOW_BEFORE_MS,
  createChildRegistry,
  registryFileName,
  type RegistryDeps,
  type RegistryLogger,
} from './registry.ts';

const tempDir = useTempDirs();

const T0 = FIXTURE_EPOCH_MS;
const OWNER = { pid: 1000, startedAtMs: T0 + 5000 };
const OWN_FILE = `${String(OWNER.pid)}-${String(OWNER.startedAtMs)}.json`;

interface Owner {
  pid: number;
  startedAtMs: number;
}
interface Child {
  pid: number;
  spawnedAtMs: number;
}

/** The process table of a test: who is alive since when, what was asked, what was killed. */
class FakeProcesses {
  readonly alive = new Map<number, number>();
  readonly aliveProbes: number[] = [];
  readonly startQueries: (readonly number[])[] = [];
  readonly killed: number[] = [];
  readonly killFailures = new Set<number>();
  queryResult: 'answer' | 'null' | 'throw' = 'answer';

  live(pid: number, startedAtMs: number): void {
    this.alive.set(pid, startedAtMs);
  }

  readonly pidAlive = (pid: number): boolean => {
    this.aliveProbes.push(pid);
    return this.alive.has(pid);
  };

  readonly processStartTimes = (pids: readonly number[]): Promise<Map<number, number> | null> => {
    this.startQueries.push([...pids]);
    if (this.queryResult === 'throw') return Promise.reject(new Error('query failed'));
    if (this.queryResult === 'null') return Promise.resolve(null);
    const answer = new Map<number, number>();
    for (const pid of pids) {
      const start = this.alive.get(pid);
      if (start !== undefined) answer.set(pid, start);
    }
    return Promise.resolve(answer);
  };

  readonly killTree = (pid: number): Promise<void> => {
    if (this.killFailures.has(pid)) return Promise.reject(new Error('taskkill failed'));
    this.killed.push(pid);
    this.alive.delete(pid);
    return Promise.resolve();
  };
}

interface LogCall {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function capturingLogger(): { logger: RegistryLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: string) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      calls.push({ level, event, fields });
    };
  return { calls, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

function rig(overrides: Partial<RegistryDeps> = {}, logger?: RegistryLogger) {
  const home = tempDir('registry').path;
  const procs = new FakeProcesses();
  const registry = createChildRegistry({
    mcsHome: home,
    owner: OWNER,
    deps: {
      pidAlive: procs.pidAlive,
      processStartTimes: procs.processStartTimes,
      killTree: procs.killTree,
      ...overrides,
    },
    ...(logger === undefined ? {} : { logger }),
  });
  return { home, dir: path.join(home, 'terminals'), procs, registry };
}

/** A registry file as another owner left it. */
function plant(dir: string, owner: Owner, children: readonly Child[], name?: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name ?? registryFileName(owner));
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, owner, children }));
  return file;
}

function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return parsed;
}

/** The pids of the `children` of a registry file text (empty for anything else). */
function childPidsIn(text: string): number[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('children' in parsed) || !Array.isArray(parsed.children)) {
    return [];
  }
  return parsed.children.flatMap((child: unknown) =>
    typeof child === 'object' && child !== null && 'pid' in child && typeof child.pid === 'number' ? [child.pid] : [],
  );
}

const STALE_OWNER = { pid: 2000, startedAtMs: T0 };

// ---- file format and atomic writes -------------------------------------------------------------------------------

describe('TC-UNIT-10 registry file', () => {
  it('names the file <ownerPid>-<ownerStartedAtMs>.json below <mcsHome>/terminals', () => {
    expect(registryFileName(OWNER)).toBe(OWN_FILE);
    const t = rig();
    t.registry.add(4001, T0 + 7000);
    return t.registry.flush().then(() => {
      expect(readdirSync(t.dir)).toEqual([OWN_FILE]);
    });
  });

  it('holds the schema version, the owner and the children, as JSON with a final line feed', async () => {
    const t = rig();
    t.registry.add(4001, T0 + 7000);
    t.registry.add(4002, T0 + 8000);
    await t.registry.flush();
    const file = path.join(t.dir, OWN_FILE);
    expect(readJson(file)).toEqual({
      schemaVersion: 1,
      owner: { pid: OWNER.pid, startedAtMs: OWNER.startedAtMs },
      children: [
        { pid: 4001, spawnedAtMs: T0 + 7000 },
        { pid: 4002, spawnedAtMs: T0 + 8000 },
      ],
    });
    expect(readFileSync(file, 'utf8').endsWith('}\n')).toBe(true);
    expect(statSync(file).size).toBeLessThan(REGISTRY_FILE_MAX_BYTES);
  });

  it.runIf(process.platform !== 'win32')('is readable by its owner only (mode 600)', async () => {
    const t = rig();
    t.registry.add(4001, T0);
    await t.registry.flush();
    expect(statSync(path.join(t.dir, OWN_FILE)).mode & 0o777).toBe(0o600);
  });

  it('creates nothing until the first child, and creates the folder when it is missing', async () => {
    const t = rig();
    await t.registry.flush();
    expect(existsSync(t.dir)).toBe(false);
    t.registry.add(4001, T0);
    await t.registry.flush();
    expect(existsSync(path.join(t.dir, OWN_FILE))).toBe(true);
  });

  it('follows add and remove, deletes the file with the last child and recreates it with the next', async () => {
    const t = rig();
    const file = path.join(t.dir, OWN_FILE);
    t.registry.add(4001, T0 + 1);
    t.registry.add(4002, T0 + 2);
    await t.registry.flush();
    t.registry.remove(4001);
    await t.registry.flush();
    expect(readJson(file)).toMatchObject({ children: [{ pid: 4002, spawnedAtMs: T0 + 2 }] });
    t.registry.remove(4002);
    await t.registry.flush();
    expect(existsSync(file)).toBe(false);
    t.registry.add(4003, T0 + 3);
    await t.registry.flush();
    expect(readJson(file)).toMatchObject({ children: [{ pid: 4003, spawnedAtMs: T0 + 3 }] });
  });

  it('removing a pid it does not hold changes nothing, and adding the same pid again replaces its record', async () => {
    const t = rig();
    const file = path.join(t.dir, OWN_FILE);
    t.registry.remove(9);
    t.registry.add(4001, T0 + 1);
    t.registry.add(4001, T0 + 9);
    await t.registry.flush();
    expect(readJson(file)).toMatchObject({ children: [{ pid: 4001, spawnedAtMs: T0 + 9 }] });
  });

  it('never leaves a temporary file behind and every state on disk parses', async () => {
    const t = rig();
    for (let i = 1; i <= 20; i += 1) {
      t.registry.add(5000 + i, T0 + i);
      await t.registry.flush();
      expect(readdirSync(t.dir)).toEqual([OWN_FILE]);
      expect(readJson(path.join(t.dir, OWN_FILE))).toMatchObject({ schemaVersion: 1 });
    }
  });

  it('writes through the injected atomic writer, and coalesces writes made in the same tick', async () => {
    const writes: { file: string; text: string }[] = [];
    const t = rig({
      writeFile: (file, text) => {
        writes.push({ file, text });
        return Promise.resolve();
      },
    });
    for (let i = 1; i <= 10; i += 1) t.registry.add(4000 + i, T0 + i);
    await t.registry.flush();
    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes.every((write) => path.basename(write.file) === OWN_FILE)).toBe(true);
    const last = writes[writes.length - 1];
    expect(childPidsIn(last?.text ?? '{}')).toEqual([4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010]);
  });

  it('keeps the last state when a write is slow: writes never overtake each other', async () => {
    const gates: (() => void)[] = [];
    const written: string[] = [];
    const t = rig({
      writeFile: (_file, text) =>
        new Promise<void>((resolve) => {
          gates.push(() => {
            written.push(text);
            resolve();
          });
        }),
    });
    t.registry.add(4001, T0 + 1);
    t.registry.add(4002, T0 + 2);
    t.registry.remove(4001);
    const flushed = t.registry.flush();
    // The first write is on its way (the folder is created first, which is real I/O); nothing else may start before it ends.
    await waitFor(() => gates.length >= 1, { what: 'the first write' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gates).toHaveLength(1);
    gates[0]?.();
    await waitFor(() => gates.length >= 2, { what: 'the second write' });
    gates[1]?.();
    await flushed;
    const last: unknown = JSON.parse(written[written.length - 1] ?? '{}');
    expect(last).toMatchObject({ children: [{ pid: 4002, spawnedAtMs: T0 + 2 }] });
    expect(gates).toHaveLength(2);
  });

  it('ignores an invalid pid and refuses a 65th child, so the file always stays valid', async () => {
    const t = rig();
    t.registry.add(0, T0);
    t.registry.add(-5, T0);
    t.registry.add(1.5, T0);
    t.registry.add(Number.NaN, T0);
    t.registry.add(4001, Number.NaN);
    t.registry.add(4001, -1);
    for (let i = 1; i <= REGISTRY_MAX_CHILDREN + 5; i += 1) t.registry.add(6000 + i, T0 + i);
    await t.registry.flush();
    const content = childPidsIn(readFileSync(path.join(t.dir, OWN_FILE), 'utf8'));
    expect(content).toHaveLength(REGISTRY_MAX_CHILDREN);
    expect(content[0]).toBe(6001);
    expect(content.every((pid) => pid > 6000)).toBe(true);
    // a known pid may still be updated when the file is full
    t.registry.add(6001, T0 + 99);
    t.registry.remove(6002);
    t.registry.add(7001, T0 + 100);
    await t.registry.flush();
    const again = childPidsIn(readFileSync(path.join(t.dir, OWN_FILE), 'utf8'));
    expect(again).toHaveLength(REGISTRY_MAX_CHILDREN);
    expect(again).toContain(7001);
    expect(again).not.toContain(6002);
  });

  it('close() waits for a pending write, deletes the file and makes later calls no-ops', async () => {
    const t = rig();
    const file = path.join(t.dir, OWN_FILE);
    t.registry.add(4001, T0);
    await t.registry.close();
    expect(existsSync(file)).toBe(false);
    t.registry.add(4002, T0);
    t.registry.remove(4002);
    await t.registry.flush();
    expect(existsSync(file)).toBe(false);
    await expect(t.registry.close()).resolves.toBeUndefined();
  });

  it('close() with nothing written is fine, and never rejects', async () => {
    const t = rig();
    await expect(t.registry.close()).resolves.toBeUndefined();
  });

  it('swallows a failed write, logs only its code, and writes again at the next change', async () => {
    const { logger, calls } = capturingLogger();
    let failNext = true;
    const t = rig(
      {
        writeFile: (file, text) => {
          if (failNext) {
            failNext = false;
            const error: NodeJS.ErrnoException = new Error(`cannot write ${file}`);
            error.code = 'EPERM';
            return Promise.reject(error);
          }
          writeFileSync(file, text);
          return Promise.resolve();
        },
      },
      logger,
    );
    mkdirSync(t.dir, { recursive: true });
    t.registry.add(4001, T0);
    await t.registry.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      level: 'warn',
      event: 'terminal.registry',
      fields: { phase: 'write_failed', code: 'EPERM' },
    });
    expect(JSON.stringify(calls)).not.toContain('cannot write');
    t.registry.add(4002, T0);
    await t.registry.flush();
    expect(readJson(path.join(t.dir, OWN_FILE))).toMatchObject({
      children: [{ pid: 4001 }, { pid: 4002 }],
    });
    const names: ReadonlySet<string> = new Set(LOG_FIELD_NAMES);
    for (const call of calls) for (const key of Object.keys(call.fields ?? {})) expect(names.has(key)).toBe(true);
  });
});

// ---- sweep -------------------------------------------------------------------------------------------------------

describe('TC-UNIT-10 sweep: nothing to do', () => {
  it('with no folder answers zeros and asks the system nothing', async () => {
    const t = rig();
    await expect(t.registry.sweep()).resolves.toEqual({ files: 0, killed: 0, skipped: 0 });
    expect(t.procs.aliveProbes).toEqual([]);
    expect(t.procs.startQueries).toEqual([]);
  });

  it('leaves its own file and files with other names alone', async () => {
    const t = rig();
    t.registry.add(4001, T0);
    await t.registry.flush();
    for (const name of [
      'README.txt',
      'notes.json',
      '12-ab.json',
      '0-5.json',
      `${OWN_FILE}.tmp`,
      '1000-5.json.77.ab12cd34.tmp',
    ]) {
      writeFileSync(path.join(t.dir, name), 'not ours');
    }
    t.procs.live(4001, T0);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 0, killed: 0, skipped: 0 });
    expect(readdirSync(t.dir).sort()).toHaveLength(7);
    expect(t.procs.killed).toEqual([]);
    expect(t.procs.aliveProbes).toEqual([]);
  });

  it('a stale file whose owner and children are all dead is deleted without any query', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [
      { pid: 2001, spawnedAtMs: T0 + 100 },
      { pid: 2002, spawnedAtMs: T0 + 200 },
    ]);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(existsSync(file)).toBe(false);
    expect(t.procs.startQueries).toEqual([]);
    expect(t.procs.killed).toEqual([]);
  });

  it('a stale file without children is deleted', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, []);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(existsSync(file)).toBe(false);
    expect(t.procs.startQueries).toEqual([]);
  });
});

describe('TC-UNIT-10 sweep: damaged files', () => {
  it('deletes invalid JSON, a wrong shape, extra keys, a wrong version and a name that disagrees with the owner', async () => {
    const t = rig();
    mkdirSync(t.dir, { recursive: true });
    const good = { schemaVersion: 1, owner: STALE_OWNER, children: [] };
    const cases: [string, string][] = [
      ['2000-1.json', '{ not json'],
      ['2001-1.json', ''],
      ['2002-1.json', '[]'],
      ['2003-1.json', JSON.stringify({ ...good, extra: 1 })],
      ['2004-1.json', JSON.stringify({ ...good, schemaVersion: 2 })],
      ['2005-1.json', JSON.stringify({ ...good, owner: { ...STALE_OWNER, extra: 1 } })],
      ['2006-1.json', JSON.stringify({ ...good, children: [{ pid: 0, spawnedAtMs: 1 }] })],
      ['2007-1.json', JSON.stringify({ ...good, children: [{ pid: 5, spawnedAtMs: 1, extra: true }] })],
      ['2008-1.json', JSON.stringify({ ...good, children: [{ pid: 5, spawnedAtMs: -1 }] })],
      ['2009-1.json', JSON.stringify({ ...good, owner: { pid: 'x', startedAtMs: 1 } })],
      // valid content under the name of a different owner
      ['3000-9.json', JSON.stringify(good)],
      [
        '2010-1.json',
        JSON.stringify({
          ...good,
          owner: { pid: 2010, startedAtMs: 1 },
          children: Array.from({ length: REGISTRY_MAX_CHILDREN + 1 }, (_, i) => ({ pid: 100 + i, spawnedAtMs: 1 })),
        }),
      ],
    ];
    for (const [name, text] of cases) writeFileSync(path.join(t.dir, name), text);
    await expect(t.registry.sweep()).resolves.toEqual({ files: cases.length, killed: 0, skipped: 0 });
    expect(readdirSync(t.dir)).toEqual([]);
    expect(t.procs.aliveProbes).toEqual([]);
  });

  it('deletes a file over 64 KiB even when its content would be valid', async () => {
    const t = rig();
    mkdirSync(t.dir, { recursive: true });
    const name = registryFileName(STALE_OWNER);
    const children = Array.from({ length: 60 }, (_, i) => ({ pid: 100 + i, spawnedAtMs: 1 }));
    const padded =
      JSON.stringify({ schemaVersion: 1, owner: STALE_OWNER, children }) + ' '.repeat(REGISTRY_FILE_MAX_BYTES);
    writeFileSync(path.join(t.dir, name), padded);
    expect(statSync(path.join(t.dir, name)).size).toBeGreaterThan(REGISTRY_FILE_MAX_BYTES);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(existsSync(path.join(t.dir, name))).toBe(false);
    expect(t.procs.aliveProbes).toEqual([]);
  });
});

describe('TC-UNIT-10 sweep: a dead owner and a surviving child', () => {
  it('kills a child that is alive and was started when the record says, then deletes the file', async () => {
    const t = rig();
    const spawned = T0 + 3000;
    const file = plant(t.dir, STALE_OWNER, [
      { pid: 2001, spawnedAtMs: spawned },
      { pid: 2002, spawnedAtMs: spawned + 10 },
    ]);
    t.procs.live(2001, spawned - 80);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 1, skipped: 0 });
    expect(t.procs.killed).toEqual([2001]);
    expect(existsSync(file)).toBe(false);
    // one query, only for the child that is alive
    expect(t.procs.startQueries).toEqual([[2001]]);
  });

  it('asks one query for all living children of a file', async () => {
    const t = rig();
    plant(t.dir, STALE_OWNER, [
      { pid: 2001, spawnedAtMs: T0 + 1000 },
      { pid: 2002, spawnedAtMs: T0 + 2000 },
      { pid: 2003, spawnedAtMs: T0 + 3000 },
    ]);
    t.procs.live(2001, T0 + 900);
    t.procs.live(2003, T0 + 2900);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 2, skipped: 0 });
    expect(t.procs.startQueries).toEqual([[2001, 2003]]);
    expect(t.procs.killed.sort()).toEqual([2001, 2003]);
  });

  it('kills inside the window [spawned - 10 s, spawned + 2 s] and only there', async () => {
    const spawned = T0 + 60_000;
    const edge = new Map<string, [number, boolean]>([
      ['10 s before', [spawned - SPAWN_WINDOW_BEFORE_MS, true]],
      ['10 s and 1 ms before', [spawned - SPAWN_WINDOW_BEFORE_MS - 1, false]],
      ['the same instant', [spawned, true]],
      ['2 s after', [spawned + SPAWN_WINDOW_AFTER_MS, true]],
      ['2 s and 1 ms after', [spawned + SPAWN_WINDOW_AFTER_MS + 1, false]],
    ]);
    expect(SPAWN_WINDOW_BEFORE_MS).toBe(10_000);
    expect(SPAWN_WINDOW_AFTER_MS).toBe(2000);
    for (const [label, [creation, kills]] of edge) {
      const t = rig();
      const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: spawned }]);
      t.procs.live(2001, creation);
      const result = await t.registry.sweep();
      expect(result.killed, label).toBe(kills ? 1 : 0);
      expect(t.procs.killed, label).toEqual(kills ? [2001] : []);
      expect(existsSync(file), label).toBe(false);
    }
  });

  it('leaves a process alone that reused the pid: created long after the record, file deleted', async () => {
    const t = rig();
    const spawned = T0 + 3000;
    const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: spawned }]);
    t.procs.live(2001, spawned + 3_600_000);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(t.procs.killed).toEqual([]);
    expect(t.procs.alive.has(2001)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('leaves a process alone that is older than the record (the pid belonged to something else)', async () => {
    const t = rig();
    const spawned = T0 + 3_600_000;
    plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: spawned }]);
    t.procs.live(2001, T0);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(t.procs.killed).toEqual([]);
  });

  it('does not kill a living child whose start time the system did not give', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(2001, T0 + 900);
    const registry = createChildRegistry({
      mcsHome: t.home,
      owner: OWNER,
      deps: {
        pidAlive: t.procs.pidAlive,
        processStartTimes: () => Promise.resolve(new Map()),
        killTree: t.procs.killTree,
      },
    });
    await expect(registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(t.procs.killed).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the file for the next sweep when the start times cannot be asked, and kills nothing', async () => {
    for (const mode of ['null', 'throw'] as const) {
      const t = rig();
      const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
      t.procs.live(2001, T0 + 900);
      t.procs.queryResult = mode;
      await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 1 });
      expect(t.procs.killed, mode).toEqual([]);
      expect(existsSync(file), mode).toBe(true);
    }
  });

  it('keeps the file when a kill fails, still kills the other children, and counts only the kills that worked', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [
      { pid: 2001, spawnedAtMs: T0 + 1000 },
      { pid: 2002, spawnedAtMs: T0 + 1000 },
    ]);
    t.procs.live(2001, T0 + 950);
    t.procs.live(2002, T0 + 950);
    t.procs.killFailures.add(2001);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 1, skipped: 1 });
    expect(t.procs.killed).toEqual([2002]);
    expect(existsSync(file)).toBe(true);
  });

  it('after a kill the next sweep finds nothing alive and removes the file without a query', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(2001, T0 + 950);
    t.procs.killFailures.add(2001);
    await t.registry.sweep();
    t.procs.killFailures.clear();
    t.procs.alive.delete(2001);
    t.procs.startQueries.length = 0;
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(existsSync(file)).toBe(false);
    expect(t.procs.startQueries).toEqual([]);
  });
});

describe('TC-UNIT-10 sweep: the owner may still be alive', () => {
  it('skips a file whose owner is alive and was started when the file says, and touches none of its children', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(STALE_OWNER.pid, STALE_OWNER.startedAtMs + 40);
    t.procs.live(2001, T0 + 950);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 1 });
    expect(existsSync(file)).toBe(true);
    expect(t.procs.killed).toEqual([]);
    expect(t.procs.startQueries).toEqual([[STALE_OWNER.pid]]);
    expect(t.procs.aliveProbes).toEqual([STALE_OWNER.pid]);
  });

  it('accepts a start time within 5 s of the owner record and no more', async () => {
    expect(OWNER_START_TOLERANCE_MS).toBe(5000);
    for (const [offset, skipped] of [
      [OWNER_START_TOLERANCE_MS, 1],
      [-OWNER_START_TOLERANCE_MS, 1],
      [OWNER_START_TOLERANCE_MS + 1, 0],
      [-OWNER_START_TOLERANCE_MS - 1, 0],
    ] as const) {
      const t = rig();
      plant(t.dir, STALE_OWNER, []);
      t.procs.live(STALE_OWNER.pid, STALE_OWNER.startedAtMs + offset);
      const result = await t.registry.sweep();
      expect(result.skipped, String(offset)).toBe(skipped);
    }
  });

  it('treats an owner pid that was reused by another process as dead: its children are swept', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(STALE_OWNER.pid, STALE_OWNER.startedAtMs + 3_600_000);
    t.procs.live(2001, T0 + 950);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 1, skipped: 0 });
    expect(t.procs.killed).toEqual([2001]);
    expect(t.procs.alive.has(STALE_OWNER.pid)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('treats an owner that is alive but gives no start time as dead, and still needs the proof for each child', async () => {
    const t = rig();
    plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(STALE_OWNER.pid, STALE_OWNER.startedAtMs);
    t.procs.live(2001, T0 + 3_600_000);
    const original = t.procs.processStartTimes;
    const asked: (readonly number[])[] = [];
    const registry = createChildRegistry({
      mcsHome: t.home,
      owner: OWNER,
      deps: {
        pidAlive: t.procs.pidAlive,
        processStartTimes: async (pids) => {
          asked.push(pids);
          const full = await original(pids);
          if (full === null) return null;
          full.delete(STALE_OWNER.pid);
          return full;
        },
        killTree: t.procs.killTree,
      },
    });
    await expect(registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 0 });
    expect(asked).toEqual([[STALE_OWNER.pid], [2001]]);
  });

  it('keeps the file and touches nothing when the owner start time cannot be asked', async () => {
    const t = rig();
    const file = plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(STALE_OWNER.pid, STALE_OWNER.startedAtMs);
    t.procs.live(2001, T0 + 950);
    t.procs.queryResult = 'null';
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 0, skipped: 1 });
    expect(t.procs.killed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(t.procs.startQueries).toEqual([[STALE_OWNER.pid]]);
  });

  it('sweeps a file left by an earlier life of this very pid (same pid, other start time)', async () => {
    const t = rig();
    const earlier = { pid: OWNER.pid, startedAtMs: OWNER.startedAtMs - 86_400_000 };
    const file = plant(t.dir, earlier, [{ pid: 2001, spawnedAtMs: earlier.startedAtMs + 1000 }]);
    t.procs.live(OWNER.pid, OWNER.startedAtMs);
    t.procs.live(2001, earlier.startedAtMs + 950);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 1, killed: 1, skipped: 0 });
    expect(existsSync(file)).toBe(false);
  });
});

describe('TC-UNIT-10 sweep: several files, failures and the contract', () => {
  it('counts every other file once and adds the kills', async () => {
    const t = rig();
    const live = { pid: 3000, startedAtMs: T0 + 10 };
    plant(t.dir, { pid: 2000, startedAtMs: T0 }, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    plant(t.dir, { pid: 2100, startedAtMs: T0 }, []);
    plant(t.dir, live, [{ pid: 3001, spawnedAtMs: T0 + 1000 }]);
    writeFileSync(path.join(t.dir, '2200-1.json'), 'broken');
    t.registry.add(4001, T0);
    await t.registry.flush();
    t.procs.live(2001, T0 + 950);
    t.procs.live(3000, live.startedAtMs);
    t.procs.live(3001, T0 + 950);
    await expect(t.registry.sweep()).resolves.toEqual({ files: 4, killed: 1, skipped: 1 });
    expect(t.procs.killed).toEqual([2001]);
    expect(readdirSync(t.dir).sort()).toEqual([OWN_FILE, '3000-' + String(live.startedAtMs) + '.json'].sort());
  });

  it('never rejects: a folder that cannot be listed, and a probe or kill that throws', async () => {
    const asFile = rig();
    writeFileSync(path.join(asFile.home, 'terminals'), 'a file where the folder should be');
    await expect(asFile.registry.sweep()).resolves.toEqual({ files: 0, killed: 0, skipped: 0 });

    const throwing = rig({
      pidAlive: () => {
        throw new Error('probe failed');
      },
    });
    plant(throwing.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 }]);
    const result = await throwing.registry.sweep();
    expect(result.killed).toBe(0);
    expect(result.files).toBe(1);
  });

  it('is safe to run twice at once: the second finds the work done', async () => {
    const t = rig();
    plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(2001, T0 + 950);
    const [a, b] = await Promise.all([t.registry.sweep(), t.registry.sweep()]);
    expect(a.killed + b.killed).toBeGreaterThanOrEqual(1);
    expect(t.procs.alive.has(2001)).toBe(false);
  });

  it('logs nothing about pids, owners or children during a sweep', async () => {
    const { logger, calls } = capturingLogger();
    const t = rig({}, logger);
    plant(t.dir, STALE_OWNER, [{ pid: 2001, spawnedAtMs: T0 + 1000 }]);
    t.procs.live(2001, T0 + 950);
    await t.registry.sweep();
    expect(JSON.stringify(calls)).not.toContain('2001');
    expect(JSON.stringify(calls)).not.toContain('2000');
  });
});
