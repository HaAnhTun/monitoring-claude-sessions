// Stopping one instance never stops another (01 3.5, brief 4 bullet 5): T-ISO-13 (`mcs stop --task a` leaves B alone) and
// T-ISO-14 (a `state.json` of A that names B's pid and URL makes `stop` kill nothing). The instances are real: the built CLI
// starts them as processes, `stop` goes through the control channel and the process checks of the engine. Assertions use the
// pid, the port, the HTTP health and the bytes of `state.json`, which read the same on Windows, Linux and macOS.
// T-ISO-15 (`cleanup --scope stale-state` with B running) is added by WP-107 inside its block at the end of the `describe`.
import { controlAddressOf, identifyInstance, pidAlive } from '@mcs/engine';
import { assertPortClosed } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { twoInstances, twoWorkspaces, writeStateNaming } from './_setup.ts';

describe('lifecycle isolation (T-ISO-13, T-ISO-14)', () => {
  it('T-ISO-13 stopping A does not stop B: A is gone and its port closed, B keeps its pid, health, state.json bytes and control channel', async () => {
    const pair = await twoInstances();
    const { a, b } = pair;
    const stateBefore = b.stateBytes();
    expect(stateBefore).not.toBeNull();

    const stopped = await a.mcs(['stop', '--task', 'a']);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain(`stopped runtime pid ${String(a.pid)}`);
    expect(pidAlive(a.pid)).toBe(false);
    await assertPortClosed(a.port);
    expect(a.readState()).toBeNull();
    expect(await a.markerProcesses()).toEqual([]);

    expect(pidAlive(b.pid)).toBe(true);
    expect(await b.health(b.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect(b.stateBytes()?.equals(stateBefore ?? Buffer.alloc(0))).toBe(true);
    const identity = await identifyInstance(controlAddressOf(b.instanceId), 2000);
    expect(identity.kind).toBe('reply');
    if (identity.kind === 'reply') expect(identity.response).toMatchObject({ instanceId: b.instanceId, pid: b.pid });
    expect((await b.markerProcesses()).map((p) => p.pid)).toEqual([b.pid]);

    await pair.teardown();
  }, 180_000);

  it("T-ISO-14 a state.json of A that names B's pid and URL: stop kills nothing, removes A's stale file and says it is not this instance's runtime", async () => {
    const { a, b } = await twoWorkspaces();
    const running = await b.start();
    const stateOfB = b.stateBytes();

    writeStateNaming(a, { pid: running.pid, port: running.port });
    const stopped = await a.mcs(['stop', '--task', 'a']);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("not this instance's runtime");
    expect(stopped.stdout).toContain('nothing was killed');
    expect(a.readState()).toBeNull();

    expect(pidAlive(running.pid)).toBe(true);
    expect(await b.health(running.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect(b.stateBytes()?.equals(stateOfB ?? Buffer.alloc(0))).toBe(true);
    expect((await b.markerProcesses()).map((p) => p.pid)).toEqual([running.pid]);

    await running.handle.stop();
    await assertPortClosed(running.port);
  }, 180_000);

  it("T-ISO-14 the same when A's file also names B's instance id, as a byte copy of B's own state.json does", async () => {
    const { a, b } = await twoWorkspaces();
    const running = await b.start();
    const stateOfB = b.stateBytes();
    expect(stateOfB).not.toBeNull();

    writeStateNaming(a, { pid: running.pid, port: running.port, instanceId: b.instanceId });
    const stopped = await a.mcs(['stop', '--task', 'a']);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("not this instance's runtime");
    expect(a.readState()).toBeNull();

    expect(pidAlive(running.pid)).toBe(true);
    expect(await b.health(running.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect(b.stateBytes()?.equals(stateOfB ?? Buffer.alloc(0))).toBe(true);

    await running.handle.stop();
    await assertPortClosed(running.port);
  }, 180_000);

  // @wp-begin WP-107
  // @wp-end WP-107
});
