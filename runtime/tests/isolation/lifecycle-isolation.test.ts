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
  /** The leftovers of a crashed monitor of A: a state file that names `pid`, its token and a temp file older than ten minutes. */
  async function leaveCrashedMonitor(
    a: Awaited<ReturnType<typeof twoWorkspaces>>['a'],
    named: { pid: number; port: number; instanceId?: string },
  ): Promise<{ token: string; temp: string }> {
    const { mkdirSync, utimesSync, writeFileSync } = await import('node:fs');
    const nodePath = await import('node:path');
    writeStateNaming(a, named);
    mkdirSync(nodePath.join(a.dir, 'run'), { recursive: true });
    const token = nodePath.join(a.dir, 'run', 'control.token');
    writeFileSync(token, 'f'.repeat(64));
    const temp = nodePath.join(a.dir, 'config.json.4242.ab12cd34.tmp');
    writeFileSync(temp, 'x');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(temp, old, old);
    return { token, temp };
  }

  it('T-ISO-15 cleanup --scope stale-state of A with B running removes the leftovers of A and leaves B, its files and its process as they were', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const nodePath = await import('node:path');
    const { RUNTIME_MUTABLE_PATHS } = await import('@mcs/engine');
    const { snapshotTree, spawnImpostor } = await import('@mcs/testkit');
    const { a, b } = await twoWorkspaces();
    const running = await b.start();

    const gone = spawnImpostor(['FIXTURE-gone']);
    const gonePid = gone.pid;
    gone.kill();
    await gone.exited;
    const left = await leaveCrashedMonitor(a, { pid: gonePid, port: a.configuredPort });

    const configOfB = snapshotTree(b.dir, { exclude: RUNTIME_MUTABLE_PATHS });
    const stateOfB = b.stateBytes();
    const tokenOfB = readFileSync(nodePath.join(b.dir, 'run', 'control.token'));
    expect(stateOfB).not.toBeNull();

    const dry = await a.mcs(['cleanup', '--task', 'a', '--scope', 'stale-state']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(existsSync(a.statePath)).toBe(true);

    const run = await a.mcs(['cleanup', '--task', 'a', '--scope', 'stale-state', '--yes', '--json']);
    expect(run.code, run.stderr).toBe(0);
    expect(
      (JSON.parse(run.stdout) as { data: { targets: { path: string }[] } }).data.targets.map((t) => t.path).sort(),
    ).toEqual(['config.json.4242.ab12cd34.tmp', 'run/control.token', 'state.json']);
    expect(existsSync(a.statePath)).toBe(false);
    expect(existsSync(left.token)).toBe(false);
    expect(existsSync(left.temp)).toBe(false);

    expect(snapshotTree(b.dir, { exclude: RUNTIME_MUTABLE_PATHS })).toBe(configOfB);
    expect(b.stateBytes()?.equals(stateOfB ?? Buffer.alloc(0))).toBe(true);
    expect(readFileSync(nodePath.join(b.dir, 'run', 'control.token')).equals(tokenOfB)).toBe(true);
    expect(pidAlive(running.pid)).toBe(true);
    expect(await b.health(running.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect((await b.markerProcesses()).map((p) => p.pid)).toEqual([running.pid]);

    await running.handle.stop();
    await assertPortClosed(running.port);
  }, 180_000);

  it("T-ISO-15 a state.json of A that names B's pid, port and instance id is stale for A: cleanup removes it, B keeps running and keeps its own file", async () => {
    const { existsSync } = await import('node:fs');
    const { RUNTIME_MUTABLE_PATHS } = await import('@mcs/engine');
    const { snapshotTree } = await import('@mcs/testkit');
    const { a, b } = await twoWorkspaces();
    const running = await b.start();
    const stateOfB = b.stateBytes();
    const configOfB = snapshotTree(b.dir, { exclude: RUNTIME_MUTABLE_PATHS });

    await leaveCrashedMonitor(a, { pid: running.pid, port: running.port, instanceId: b.instanceId });
    const run = await a.mcs(['cleanup', '--task', 'a', '--scope', 'stale-state', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(existsSync(a.statePath)).toBe(false);

    expect(pidAlive(running.pid)).toBe(true);
    expect(await b.health(running.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect(b.stateBytes()?.equals(stateOfB ?? Buffer.alloc(0))).toBe(true);
    expect(snapshotTree(b.dir, { exclude: RUNTIME_MUTABLE_PATHS })).toBe(configOfB);
    expect((await b.markerProcesses()).map((p) => p.pid)).toEqual([running.pid]);

    await running.handle.stop();
    await assertPortClosed(running.port);
  }, 180_000);
  // @wp-end WP-107
});
