// Self-test of the shared setup of the isolation suite (05 4.8, 01 3.5): `twoInstances` starts two real instances on distinct
// ports, each answering health with its own instance id, and its teardown leaves both ports closed and no process that
// carries either instance marker. Every later isolation row reuses this setup, so a defect here must show up here first.
import { assertPortClosed } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { markerProcesses, twoInstances, twoWorkspaces } from './_setup.ts';

describe('twoInstances (setup self-test)', () => {
  it('starts two instances on distinct ports and the teardown leaves both ports closed and no marker process', async () => {
    const pair = await twoInstances();
    const { a, b } = pair;
    expect(a.port).not.toBe(b.port);
    expect(a.pid).not.toBe(b.pid);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(a.slug).toBe('a');
    expect(b.slug).toBe('b');
    expect(a.repo).not.toBe(b.repo);

    expect(await a.health(a.port)).toEqual({ status: 200, instanceId: a.instanceId });
    expect(await b.health(b.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect(a.readState()).toMatchObject({ pid: a.pid, port: a.port, instanceId: a.instanceId });
    expect(b.readState()).toMatchObject({ pid: b.pid, port: b.port, instanceId: b.instanceId });
    expect((await a.markerProcesses()).map((p) => p.pid)).toEqual([a.pid]);
    expect((await b.markerProcesses()).map((p) => p.pid)).toEqual([b.pid]);
    // by slug the same processes are found
    expect((await markerProcesses('a')).map((p) => p.pid)).toEqual([a.pid]);

    await pair.teardown();
    await assertPortClosed(a.port);
    await assertPortClosed(b.port);
    expect(await a.markerProcesses()).toEqual([]);
    expect(await b.markerProcesses()).toEqual([]);
    expect(a.readState()).toBeNull();
    expect(b.readState()).toBeNull();
    // a second teardown is a no-op
    await pair.teardown();
  }, 120_000);

  it('sameRepo puts both tasks in one repository and still starts them on distinct ports', async () => {
    const pair = await twoInstances({ sameRepo: true });
    const { a, b } = pair;
    expect(a.repo).toBe(b.repo);
    expect(a.dir).not.toBe(b.dir);
    expect(a.port).not.toBe(b.port);
    expect(await a.health(a.port)).toMatchObject({ status: 200, instanceId: a.instanceId });
    expect(await b.health(b.port)).toMatchObject({ status: 200, instanceId: b.instanceId });
    await pair.teardown();
    expect(await markerProcesses(a)).toEqual([]);
    expect(await markerProcesses(b)).toEqual([]);
  }, 120_000);

  it('twoWorkspaces initialises two stopped workspaces; samePort configures both with one port', async () => {
    const { a, b } = await twoWorkspaces({ samePort: true });
    expect(a.configuredPort).toBe(b.configuredPort);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(a.readState()).toBeNull();
    expect(await a.markerProcesses()).toEqual([]);
    expect(await b.markerProcesses()).toEqual([]);
    await assertPortClosed(a.configuredPort);
  }, 60_000);
});
