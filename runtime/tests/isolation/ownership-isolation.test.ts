// No conflicting ownership of ports, processes or state (01 3.5, brief 4 bullet 7): T-ISO-18 (equal configured ports end on
// distinct ports), T-ISO-19 (two concurrent starts make one process), T-ISO-20 (a server started by hand loses the instance
// lock with exit 12), T-ISO-21 (a copied workspace is refused) and T-ISO-22 (a live process that is not our runtime is never
// signalled). V4 has no T-ISO-23 (there is no second engine, ADR 0066). The instances are real processes of the built runtime.
import { pidAlive } from '@mcs/engine';
import { CliEnvelopeSchema } from '@mcs/shared';
import { allocatePort, assertPortClosed, spawnImpostor, spawnTracked } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { copyWorkspaceAs, serverEntryPath, twoInstances, twoWorkspaces, writeStateNaming } from './_setup.ts';

const STARTED = /^(?:started|already running): (http:\/\/127\.0\.0\.1:\d+) \(pid (\d+)\)$/m;

describe('ownership isolation (T-ISO-18 to T-ISO-22)', () => {
  it.each([
    ['two repositories', false],
    ['one repository', true],
  ])(
    'T-ISO-18 the same configured port (%s): started together, A and B end on distinct ports and each health returns its own instance id',
    async (_name, sameRepo) => {
      const { a, b } = await twoWorkspaces({ sameRepo, samePort: true });
      expect(a.configuredPort).toBe(b.configuredPort);
      const [ra, rb] = await Promise.all([a.startRaw(), b.startRaw()]);
      expect(ra.code, ra.stderr).toBe(0);
      expect(rb.code, rb.stderr).toBe(0);

      const stateA = a.readState();
      const stateB = b.readState();
      expect(stateA).not.toBeNull();
      expect(stateB).not.toBeNull();
      if (stateA === null || stateB === null) return;
      expect(stateA.port).not.toBe(stateB.port);
      expect(stateA.pid).not.toBe(stateB.pid);
      expect(stateA).toMatchObject({ instanceId: a.instanceId, url: `http://127.0.0.1:${String(stateA.port)}` });
      expect(stateB).toMatchObject({ instanceId: b.instanceId, url: `http://127.0.0.1:${String(stateB.port)}` });
      expect(await a.health(stateA.port)).toEqual({ status: 200, instanceId: a.instanceId });
      expect(await b.health(stateB.port)).toEqual({ status: 200, instanceId: b.instanceId });
      expect((await a.markerProcesses()).map((p) => p.pid)).toEqual([stateA.pid]);
      expect((await b.markerProcesses()).map((p) => p.pid)).toEqual([stateB.pid]);

      expect((await a.stopRaw()).code).toBe(0);
      expect((await b.stopRaw()).code).toBe(0);
      await assertPortClosed(stateA.port);
      await assertPortClosed(stateB.port);
      expect(await a.markerProcesses()).toEqual([]);
      expect(await b.markerProcesses()).toEqual([]);
    },
    180_000,
  );

  it('T-ISO-19 two concurrent starts of A: exactly one process carries the marker of A and both calls exit 0 with the same URL', async () => {
    const { a } = await twoWorkspaces();
    const [first, second] = await Promise.all([a.startRaw(), a.startRaw()]);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const one = STARTED.exec(first.stdout);
    const two = STARTED.exec(second.stdout);
    expect(one, first.stdout).not.toBeNull();
    expect(two, second.stdout).not.toBeNull();
    expect(one?.[1]).toBe(two?.[1]);
    expect(one?.[1]).toBe(`http://127.0.0.1:${String(a.configuredPort)}`);
    expect(one?.[2]).toBe(two?.[2]);

    const processes = await a.markerProcesses();
    expect(processes).toHaveLength(1);
    expect(processes[0]?.pid).toBe(Number(one?.[2]));
    expect(a.readState()?.pid).toBe(processes[0]?.pid);
    expect(await a.health(a.configuredPort)).toEqual({ status: 200, instanceId: a.instanceId });

    expect((await a.stopRaw()).code).toBe(0);
    await assertPortClosed(a.configuredPort);
    expect(await a.markerProcesses()).toEqual([]);
  }, 180_000);

  it('T-ISO-20 a serve started by hand while A runs exits 12 within 1 s and leaves A unaffected', async () => {
    const pair = await twoInstances();
    const { a, b } = pair;
    const stateBefore = a.stateBytes();
    const spare = await allocatePort();

    const started = performance.now();
    const hand = spawnTracked(
      process.execPath,
      [
        serverEntryPath(),
        'serve',
        `--mcs-instance=${a.instanceId}`,
        `--instance-dir=${a.dir}`,
        `--port=${String(spare)}`,
      ],
      { env: a.env },
    );
    const code = await hand.exited;
    const elapsedMs = performance.now() - started;
    expect(code).toBe(12);
    expect(elapsedMs).toBeLessThan(1000);
    await assertPortClosed(spare);

    expect(pidAlive(a.pid)).toBe(true);
    expect(await a.health(a.port)).toEqual({ status: 200, instanceId: a.instanceId });
    expect(a.stateBytes()?.equals(stateBefore ?? Buffer.alloc(0))).toBe(true);
    expect((await a.markerProcesses()).map((p) => p.pid)).toEqual([a.pid]);
    expect(await b.health(b.port)).toEqual({ status: 200, instanceId: b.instanceId });

    await pair.teardown();
  }, 180_000);

  it('T-ISO-21 a copied workspace is refused with IDENTITY_MISMATCH and the repair hint, and nothing is started', async () => {
    const { a } = await twoWorkspaces();
    copyWorkspaceAs(a, 'c');
    const port = await allocatePort();

    const refused = await a.mcs(['start', '--task', 'c', '--port', String(port), '--json']);
    expect(refused.code).toBe(1);
    const envelope = CliEnvelopeSchema.parse(JSON.parse(refused.stdout));
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('IDENTITY_MISMATCH');
    expect(envelope.error?.message).toContain("belongs to 'a' but sits in 'c'");
    expect(envelope.error?.hint ?? '').toContain('instances repair --task c');

    await assertPortClosed(port);
    expect(await a.markerProcesses()).toEqual([]);
    expect(a.readState()).toBeNull();
  }, 120_000);

  it('T-ISO-22 a live impostor named by state.json: status says not running, stop kills nothing, start succeeds and overwrites the file', async () => {
    const { a } = await twoWorkspaces();
    const impostor = spawnImpostor([`--mcs-instance=${a.instanceId}`]);
    expect(pidAlive(impostor.pid)).toBe(true);

    writeStateNaming(a, { pid: impostor.pid, port: a.configuredPort });
    const status = await a.mcs(['status', '--task', 'a']);
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: false, probe: 'foreign-pid' });
    expect(pidAlive(impostor.pid)).toBe(true);

    const stopped = await a.mcs(['stop', '--task', 'a']);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain('nothing was killed');
    expect(pidAlive(impostor.pid)).toBe(true);
    expect(a.readState()).toBeNull();

    // the file is back, the impostor still alive: a start replaces the file with the real runtime
    writeStateNaming(a, { pid: impostor.pid, port: a.configuredPort });
    const started = await a.startRaw();
    expect(started.code, started.stderr).toBe(0);
    const state = a.readState();
    expect(state).not.toBeNull();
    expect(state?.pid).not.toBe(impostor.pid);
    expect(state).toMatchObject({ port: a.configuredPort, instanceId: a.instanceId });
    expect(pidAlive(impostor.pid)).toBe(true);
    expect((await a.markerProcesses()).map((p) => p.pid)).toEqual([state?.pid]);

    expect((await a.stopRaw()).code).toBe(0);
    await assertPortClosed(a.configuredPort);
    expect(pidAlive(impostor.pid)).toBe(true);
  }, 180_000);
});
