// `state.json` of the Node runtime (01 1.7, 4.4 step 10, 4.6, 4.13): the exact content with the seven pre-4.0 keys first,
// the atomic write, and the decision about a file that is already there at boot (always stale: there is no other engine).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { StateFileSchema } from '@mcs/shared';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  STATE_FILE_NAME,
  buildStateFile,
  readExistingState,
  writeStateFile,
  type ExistingStateDeps,
  type StateFileInput,
} from './state-file.ts';

const makeTemp = useTempDirs();

const INPUT: StateFileInput = {
  pid: 4242,
  port: 18123,
  startedAtMs: Date.UTC(2026, 9, 12, 8, 30, 15, 250),
  runtimeVersion: '3.0.0',
  codeStamp: 'abcdef0123',
  slug: 'demo',
  instanceId: '11111111-1111-4111-8111-111111111111',
  nodeVersion: 'v24.14.1',
  control: String.raw`\\.\pipe\mcs-11111111-1111-4111-8111-111111111111`,
};

describe('buildStateFile (01 1.7)', () => {
  it('writes the seven legacy keys first, in the legacy order, then the Node keys', () => {
    const { bytes } = buildStateFile(INPUT);
    const text = Buffer.from(bytes).toString('utf8');
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      'pid',
      'url',
      'port',
      'started',
      'version',
      'task',
      'config',
      'schema_version',
      'engine',
      'instanceId',
      'runtimeVersion',
      'codeStamp',
      'startedAt',
      'nodeVersion',
      'control',
    ]);
  });

  it('has the values of the contract: url without a trailing slash, started in epoch seconds, config null', () => {
    const { state } = buildStateFile(INPUT);
    expect(state).toEqual({
      pid: 4242,
      url: 'http://127.0.0.1:18123',
      port: 18123,
      started: 1_791_793_815.25,
      version: '3.0.0',
      task: 'demo',
      config: null,
      schema_version: 1,
      engine: 'node',
      instanceId: INPUT.instanceId,
      runtimeVersion: '3.0.0',
      codeStamp: 'abcdef0123',
      startedAt: '2026-10-12T08:30:15.250Z',
      nodeVersion: 'v24.14.1',
      control: INPUT.control,
    });
    expect(state.engine).toBe('node');
  });

  it('is Python-compatible JSON: indent 2, one LF at the end, started is always a float, pid and port are ints', () => {
    const whole = Buffer.from(buildStateFile({ ...INPUT, startedAtMs: 1_760_000_000_000 }).bytes).toString('utf8');
    expect(whole.endsWith('}\n')).toBe(true);
    expect(whole).toContain('\n  "pid": 4242,\n');
    expect(whole).toContain('\n  "port": 18123,\n');
    expect(whole).toContain('\n  "started": 1760000000.0,\n');
    expect(whole).toContain('\n  "config": null,\n');
    expect(whole).not.toContain('\r');
  });

  it('validates with the shared schema, so a value it cannot hold is refused before anything is written', () => {
    expect(
      StateFileSchema.safeParse(JSON.parse(Buffer.from(buildStateFile(INPUT).bytes).toString('utf8'))).success,
    ).toBe(true);
    expect(() => buildStateFile({ ...INPUT, port: 0 })).toThrow();
    expect(() => buildStateFile({ ...INPUT, codeStamp: 'not-hex' })).toThrow();
    expect(() => buildStateFile({ ...INPUT, instanceId: 'x' })).toThrow();
    expect(() => buildStateFile({ ...INPUT, pid: -1 })).toThrow();
  });

  it('is deterministic: the same input gives the same bytes (the watchdog compares bytes)', () => {
    expect(Buffer.from(buildStateFile(INPUT).bytes).equals(Buffer.from(buildStateFile(INPUT).bytes))).toBe(true);
  });
});

describe('writeStateFile', () => {
  it('replaces the file atomically with exactly the built bytes and leaves no temp file behind', async () => {
    const dir = makeTemp('state-write').path;
    const file = path.join(dir, STATE_FILE_NAME);
    writeFileSync(file, 'old content that is not json');
    const built = buildStateFile(INPUT);
    await writeStateFile(file, built);
    expect(Buffer.compare(readFileSync(file), Buffer.from(built.bytes))).toBe(0);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a link as the parent folder (a workspace never writes through a link)', async () => {
    const root = makeTemp('state-link').path;
    const real = path.join(root, 'real');
    mkdirSync(real);
    const link = path.join(root, 'ws');
    makeJunction(link, real);
    await expect(writeStateFile(path.join(link, STATE_FILE_NAME), buildStateFile(INPUT))).rejects.toMatchObject({
      code: 'WORKSPACE_SYMLINK',
    });
    expect(readdirSync(real)).toEqual([]);
  });
});

describe('readExistingState (01 4.4 step 10, 4.13)', () => {
  function fakes(over: Partial<ExistingStateDeps> = {}): ExistingStateDeps {
    return {
      selfPid: 100,
      pidAlive: () => false,
      ...over,
    };
  }

  function stateFileWith(pid: number): string {
    const file = path.join(makeTemp('state-existing').path, STATE_FILE_NAME);
    writeFileSync(file, Buffer.from(buildStateFile({ ...INPUT, pid }).bytes));
    return file;
  }

  it('says absent for a missing file', async () => {
    const file = path.join(makeTemp('state-absent').path, STATE_FILE_NAME);
    expect(await readExistingState(file, fakes())).toEqual({ kind: 'absent' });
  });

  it('says stale/unparsable for a file that is not a state file (legacy read_state_file returns None)', async () => {
    const dir = makeTemp('state-garbage').path;
    const file = path.join(dir, STATE_FILE_NAME);
    for (const text of ['', '{', '[]', '{"pid": "x"}', 'null']) {
      writeFileSync(file, text);
      expect(await readExistingState(file, fakes()), text).toEqual({ kind: 'stale', reason: 'unparsable' });
    }
  });

  it('says stale/dead_pid when the named process is gone (a crash left the file)', async () => {
    expect(await readExistingState(stateFileWith(555), fakes({ pidAlive: () => false }))).toEqual({
      kind: 'stale',
      reason: 'dead_pid',
    });
  });

  it('says stale/own_pid when the file names this very process', async () => {
    expect(await readExistingState(stateFileWith(100), fakes({ pidAlive: () => true }))).toEqual({
      kind: 'stale',
      reason: 'own_pid',
    });
  });

  it('has no conflict kind: a live pid of a file that this runtime did not write (seven keys) is stale/foreign_pid', async () => {
    const file = path.join(makeTemp('state-foreign').path, STATE_FILE_NAME);
    const seven = { pid: 555, url: 'http://127.0.0.1:18123', port: 18123, started: 1.5, version: '2.0.2', task: null };
    writeFileSync(file, JSON.stringify({ ...seven, config: null }));
    const state = await readExistingState(file, fakes({ pidAlive: () => true }));
    expect(state).toEqual({ kind: 'stale', reason: 'foreign_pid' });
  });

  it('says stale/foreign_pid for a live process that is not this runtime (a reused pid)', async () => {
    const asked: number[] = [];
    const state = await readExistingState(
      stateFileWith(555),
      fakes({
        pidAlive: (pid) => {
          asked.push(pid);
          return true;
        },
      }),
    );
    expect(state).toEqual({ kind: 'stale', reason: 'foreign_pid' });
    expect(asked).toEqual([555]);
  });

  it('never stays silent forever over a live pid: the file is always replaced', async () => {
    const state = await readExistingState(stateFileWith(555), fakes({ pidAlive: () => true }));
    expect(state.kind).toBe('stale');
  });

  it('works with the real process helpers: this test process is alive and is a foreign pid', async () => {
    const file = stateFileWith(process.pid);
    expect(await readExistingState(file, { selfPid: process.pid + 1 })).toEqual({
      kind: 'stale',
      reason: 'foreign_pid',
    });
  }, 60_000);
});
