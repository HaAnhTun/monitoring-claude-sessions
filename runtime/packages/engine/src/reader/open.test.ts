// `openInstanceReader` (01 6.1, T-CLI-05 unit part): the probe of 01 4.8 decides the mode on every call. Only `running` gives the
// `ApiReader`; every other state, `unmanaged-running` included, gives the `DbReader`, and a monitor that this runtime did not
// start is never asked over HTTP. A stopped or stale instance is read without leaving a file behind.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { openInstanceDb } from '../db/open.ts';
import type { ProbeResult, ProbeState } from '../ops/probe.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import { openInstanceReader, type InstanceReader, type ReaderDeps } from './open.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const URL = 'http://127.0.0.1:18001';

const opened: InstanceReader[] = [];
afterEach(async () => {
  for (const reader of opened.splice(0)) await reader.close();
});

function probeResult(state: ProbeState, url: string | null = state === 'running' ? URL : null): ProbeResult {
  return {
    state,
    engine: state === 'stopped' ? null : 'node',
    pid: state === 'stopped' ? null : 4242,
    url,
    port: url === null ? null : 18001,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: 'scripted',
  };
}

interface Fixture {
  readonly ws: WorkspaceRef;
  readonly dir: string;
  readonly deps: ReaderDeps;
  readonly runtimeDir: string;
}

function fixture(o: { db?: boolean; instance?: boolean } = {}): Fixture {
  const { repo, tasksRoot } = buildRepo(makeTemp('open-reader').path);
  const dir = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    ...(o.instance === false
      ? {}
      : { instance: { slug: 'demo', instanceId: ID, runtimeVersion: '4.0.0', dbSchemaVersion: 1 } }),
  });
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  if (o.db !== false) {
    openInstanceDb({
      path: path.join(dir, 'data', 'monitor.db'),
      expectedInstanceId: ID,
      mode: 'serve',
      runtimeVersion: '4.0.0',
    }).close();
  }
  const skillDir = defaultSkillDir();
  const runtimeDir = path.join(skillDir, 'runtime');
  return {
    ws: resolveWorkspace(tasksRoot, 'demo'),
    dir,
    runtimeDir,
    deps: { skillDir, runtimeDir, env: {}, clock: new FakeClock(NOW) },
  };
}

async function open(f: Fixture, over: Partial<ReaderDeps>): Promise<InstanceReader> {
  const reader = await openInstanceReader(f.ws, { ...f.deps, ...over });
  opened.push(reader);
  return reader;
}

describe('openInstanceReader: the mode follows the probe', () => {
  it.each([
    ['running', 'api'],
    ['starting', 'db'],
    ['stopping', 'db'],
    ['unhealthy', 'db'],
    ['stopped', 'db'],
    ['stale', 'db'],
    ['foreign-pid', 'db'],
    ['unmanaged-running', 'db'],
  ] as const)('%s gives the %s reader', async (state, mode) => {
    const f = fixture();
    const reader = await open(f, { probe: () => Promise.resolve(probeResult(state)) });
    expect(reader.mode).toBe(mode);
    expect(reader.instanceId).toBe(ID);
  });

  it('probes on every call, so a start or stop in between switches the mode', async () => {
    const f = fixture();
    const states: ProbeState[] = ['running', 'stopped', 'running'];
    const probe = vi.fn<NonNullable<ReaderDeps['probe']>>(() =>
      Promise.resolve(probeResult(states.shift() ?? 'stopped')),
    );
    const modes: string[] = [];
    for (let call = 0; call < 3; call += 1) modes.push((await open(f, { probe })).mode);
    expect(modes).toEqual(['api', 'db', 'api']);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('gives the probe the runtime folder, so that a hung runtime can be found', async () => {
    const f = fixture();
    const probe = vi.fn<NonNullable<ReaderDeps['probe']>>(() => Promise.resolve(probeResult('stopped')));
    await open(f, { probe });
    expect(probe.mock.calls[0]?.[1]).toEqual({ runtimeDir: f.runtimeDir });
  });

  it('a running instance without a loopback address is read through its database', async () => {
    const f = fixture();
    for (const url of ['http://10.0.0.5:18001', 'http://localhost:18001', null]) {
      const reader = await open(f, { probe: () => Promise.resolve(probeResult('running', url)) });
      expect(reader.mode, String(url)).toBe('db');
    }
  });

  it('never asks a monitor that this runtime did not start', async () => {
    const f = fixture({ db: false });
    const httpGet = vi.fn();
    const probe = (): Promise<ProbeResult> => Promise.resolve(probeResult('unmanaged-running', URL));
    await expect(openInstanceReader(f.ws, { ...f.deps, probe, httpGet })).rejects.toMatchObject({
      code: 'DB_ERROR',
      details: { reason: 'no_database' },
    });
    expect(httpGet).not.toHaveBeenCalled();
  });
});

describe('openInstanceReader: failures and residue', () => {
  it('a workspace without instance.json is not initialized', async () => {
    const f = fixture({ instance: false, db: false });
    const error = await openInstanceReader(f.ws, {
      ...f.deps,
      probe: () => Promise.resolve(probeResult('stopped')),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'INSTANCE_NOT_INITIALIZED' });
  });

  it('reads a stopped or stale instance without leaving a file behind, and the others as a plain read-only open', async () => {
    for (const state of ['stopped', 'stale'] as const) {
      const f = fixture();
      const before = snapshotTree(f.dir);
      const reader = await open(f, { probe: () => Promise.resolve(probeResult(state)) });
      await reader.sessions({ limit: 10, sort: 'lastActivity', range: 'all' } as never);
      await reader.close();
      expect(snapshotTree(f.dir), state).toBe(before);
    }
  });

  it('the API reader it returns is bound to the instance of the workspace', async () => {
    const f = fixture();
    const reader = await open(f, { probe: () => Promise.resolve(probeResult('running')) });
    expect(reader.mode).toBe('api');
    expect(reader.instanceId).toBe(ID);
  });
});
