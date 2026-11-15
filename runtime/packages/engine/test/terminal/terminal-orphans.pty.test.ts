// Orphan safety of the terminal service against real processes (CAW-56; design 01 section 5 and section 8, id TC-PTY-11).
// A host that is ended by force must not leave a pseudo console process behind (the console closes with its pipes), and what a
// crash leaves, a registry file under `<mcsHome>/terminals`, is cleared by the next sweep, which ends a process only when it proves
// to be the recorded one: a creation time inside the recorded window and an owner that is not alive as itself.
// Windows only; a missing addon FAILS the run (`describePtyTests`). The survivors are stand-ins started by the test (a Node process
// that only waits), because a real pseudo console never lets one live: the sweep is the net for what the console cannot catch.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describePtyTests, waitFor } from '@mcs/testkit';
import { expect, it } from 'vitest';

import { spawnDetached } from '../../src/platform/exec.ts';
import { forceKill, forceKillTree, pidAlive, processStartTimes } from '../../src/platform/process.ts';
import {
  REGISTRY_DIR,
  REGISTRY_FILE_MAX_BYTES,
  REGISTRY_MAX_CHILDREN,
  RegistryFileSchema,
  registryFileName,
} from '../../src/terminal/index.ts';
import { startTerminalHost } from './host-process.ts';
import { consoleHosts, listProcesses, noneOfThemRuns } from './process-tree.ts';
import { PER_TEST_TIMEOUT_MS, exitWaitMs, useRealHarnesses, type RealHarness } from './real-harness.ts';

const HOUR_MS = 3_600_000;
/** The sweep takes a process as the recorded one inside [spawned - 10 s, spawned + 2 s]; the stand-ins are recorded 250 ms late. */
const RECORDED_LATE_MS = 250;
/** A stand-in for a survivor: it only waits. The marker is its last argument, so the command line proves it is ours. */
const STAND_IN_SCRIPT = 'setInterval(function () {}, 60000)';
const SHORT_LIVED_SCRIPT = '0';

function registryDir(h: RealHarness): string {
  return path.join(h.mcsHome, REGISTRY_DIR);
}

/** The names of the files in the registry folder, sorted; none when the folder does not exist yet. */
function registryFiles(h: RealHarness): string[] {
  const dir = registryDir(h);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Writes the file of an owner the way the registry does (the name carries the owner), checked against the schema of the service. */
function putRegistryFile(
  h: RealHarness,
  owner: { pid: number; startedAtMs: number },
  children: readonly { pid: number; spawnedAtMs: number }[],
): string {
  const record = RegistryFileSchema.parse({ schemaVersion: 1, owner, children });
  const name = registryFileName(owner);
  mkdirSync(registryDir(h), { recursive: true });
  writeFileSync(path.join(registryDir(h), name), `${JSON.stringify(record, null, 2)}\n`);
  return name;
}

let counter = 0;

/** Starts a Node process of ours, detached and hidden, and records it in the harness. Returns its pid. */
function spawnStandIn(h: RealHarness, script: string): number {
  counter += 1;
  const outFd = openSync(path.join(h.root, `stand-in-${String(counter)}.out.log`), 'a');
  const errFd = openSync(path.join(h.root, `stand-in-${String(counter)}.err.log`), 'a');
  const child = spawnDetached(process.execPath, ['-e', script, h.marker], {
    cwd: h.root,
    env: h.env,
    stdoutFd: outFd,
    stderrFd: errFd,
  });
  child.on('error', () => undefined);
  closeSync(outFd);
  closeSync(errFd);
  const { pid } = child;
  if (pid === undefined) throw new Error('the stand-in did not start');
  h.track(pid);
  return pid;
}

/** Starts a stand-in that only waits. Returns its pid and the creation time Windows has for it. */
async function startStandIn(h: RealHarness): Promise<{ pid: number; createdAtMs: number }> {
  const pid = spawnStandIn(h, STAND_IN_SCRIPT);
  const createdAtMs = await waitFor(async () => (await processStartTimes([pid]))?.get(pid), {
    timeoutMs: exitWaitMs(),
    intervalMs: 200,
    what: 'the creation time of the stand-in',
  });
  return { pid, createdAtMs };
}

/** A pid that no process has any more: the pid of a short-lived process of ours that has ended. */
async function endedPid(h: RealHarness): Promise<number> {
  const pid = spawnStandIn(h, SHORT_LIVED_SCRIPT);
  await waitFor(() => !pidAlive(pid), {
    timeoutMs: exitWaitMs(),
    intervalMs: 50,
    what: 'the short-lived process to end',
  });
  return pid;
}

/** The creation time of this test process (the owner that is alive). */
async function ownStartMs(): Promise<number> {
  const times = await processStartTimes([process.pid]);
  const start = times?.get(process.pid);
  if (start === undefined) throw new Error('the creation time of this process is unknown');
  return start;
}

/** Ends a stand-in that the sweep was right to leave; `stillRuns` proves by its command line that it is ours. */
async function endStandIn(h: RealHarness, pid: number): Promise<void> {
  if (await h.stillRuns(pid)) await forceKillTree(pid);
  await h.waitGone([pid], 'the stand-in to end');
}

describePtyTests('terminal orphans and the sweep', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-11 a host ended by force leaves no root, fake claude, grandchild or console host, and the next sweep clears its file',
    async () => {
      const h = start({ route: 'shim' });
      const host = await startTerminalHost(h, { sessions: 2, spawnChild: true });
      expect(host.sessions).toHaveLength(2);
      // Two roots (cmd.exe), two fake claudes and two grandchildren; the host itself is a seventh process.
      expect(host.sessionPids).toHaveLength(6);
      for (const pid of [host.hostPid, ...host.sessionPids]) expect(pidAlive(pid)).toBe(true);

      // The host registers its roots: this is the file a crash leaves behind.
      const hostFile = await waitFor(
        () => {
          const names = registryFiles(h).filter((name) => name.startsWith(`${String(host.hostPid)}-`));
          const only = names.length === 1 ? names[0] : undefined;
          if (only === undefined) return null;
          const text = readFileSync(path.join(registryDir(h), only), 'utf8');
          const parsed = RegistryFileSchema.safeParse(JSON.parse(text));
          return parsed.success && parsed.data.children.length === 2 ? { name: only, record: parsed.data } : null;
        },
        { timeoutMs: exitWaitMs(), intervalMs: 100, what: 'the host to write its registry file' },
      );
      expect(hostFile.record.owner.pid).toBe(host.hostPid);
      expect(hostFile.record.children.map((child) => child.pid).sort((a, b) => a - b)).toEqual(
        host.sessions.map((session) => session.pid).sort((a, b) => a - b),
      );

      // Each pseudo console has a host process of its own; they must disappear with the process that made them.
      const consoleHostsBefore = await consoleHosts(host.hostPid);
      expect(consoleHostsBefore.length).toBeGreaterThanOrEqual(2);

      // A crash, not a shutdown: taskkill /F of the host alone (no /T), so nothing of the service gets to clean up.
      expect(await h.stillRuns(host.hostPid)).toBe(true);
      await forceKill(host.hostPid);
      await h.waitGone([host.hostPid, ...host.sessionPids], 'every process of the crashed host to end');
      await waitFor(async () => noneOfThemRuns(await listProcesses(), consoleHostsBefore), {
        timeoutMs: exitWaitMs(),
        intervalMs: 300,
        what: 'the console hosts of the crashed host to end',
      });

      // The crash cleaned nothing: the file is still there. A service that starts next sweeps it: the owner is gone, so are
      // the children, so the file goes and nothing is killed.
      expect(registryFiles(h)).toEqual([hostFile.name]);
      expect(await h.service.sweepOrphans()).toEqual({ files: 1, killed: 0, skipped: 0 });
      expect(registryFiles(h)).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-11 the sweep ends a survivor that is the recorded process, and removes the file of the dead owner',
    async () => {
      const h = start({ route: 'direct' });
      const survivor = await startStandIn(h);
      const owner = { pid: await endedPid(h), startedAtMs: Date.now() - HOUR_MS };
      const name = putRegistryFile(h, owner, [
        { pid: survivor.pid, spawnedAtMs: survivor.createdAtMs + RECORDED_LATE_MS },
      ]);
      expect(registryFiles(h)).toEqual([name]);
      expect(pidAlive(survivor.pid)).toBe(true);

      expect(await h.service.sweepOrphans()).toEqual({ files: 1, killed: 1, skipped: 0 });
      await h.waitGone([survivor.pid], 'the recorded survivor to be ended by the sweep');
      expect(registryFiles(h)).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-11 the sweep refuses a pid that was reused: a creation time outside the recorded window is left running',
    async () => {
      const h = start({ route: 'direct' });
      // Both are the survivor of an earlier run whose pid the system gave to another program: this process was created
      // long after the recorded spawn (the first), or long before it (the second). The sweep must end neither.
      const later = await startStandIn(h);
      const earlier = await startStandIn(h);
      const owner = { pid: await endedPid(h), startedAtMs: Date.now() - HOUR_MS };
      const other = { pid: owner.pid, startedAtMs: owner.startedAtMs - 1000 };
      putRegistryFile(h, owner, [{ pid: later.pid, spawnedAtMs: later.createdAtMs - HOUR_MS }]);
      putRegistryFile(h, other, [{ pid: earlier.pid, spawnedAtMs: earlier.createdAtMs + HOUR_MS }]);
      expect(registryFiles(h)).toHaveLength(2);

      // Two files looked at and nothing ended; neither file is kept, since a child that is not the recorded one is no
      // reason to look again.
      expect(await h.service.sweepOrphans()).toEqual({ files: 2, killed: 0, skipped: 0 });
      expect(registryFiles(h)).toEqual([]);
      expect(await h.stillRuns(later.pid)).toBe(true);
      expect(await h.stillRuns(earlier.pid)).toBe(true);

      await endStandIn(h, later.pid);
      await endStandIn(h, earlier.pid);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-11 the sweep skips the file of an owner that is alive, and leaves the survivor and the file as they are',
    async () => {
      const h = start({ route: 'direct' });
      const survivor = await startStandIn(h);
      // The owner is this test process, recorded with its real creation time (a second late, so that the name is not the
      // file of the service that runs here: the sweep skips its own file for another reason).
      const owner = { pid: process.pid, startedAtMs: (await ownStartMs()) + 1000 };
      const name = putRegistryFile(h, owner, [
        { pid: survivor.pid, spawnedAtMs: survivor.createdAtMs + RECORDED_LATE_MS },
      ]);

      expect(await h.service.sweepOrphans()).toEqual({ files: 1, killed: 0, skipped: 1 });
      expect(registryFiles(h)).toEqual([name]);
      expect(await h.stillRuns(survivor.pid)).toBe(true);

      await endStandIn(h, survivor.pid);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-11 a pid that is alive but was created at another time than the recorded owner does not protect its file',
    async () => {
      const h = start({ route: 'direct' });
      const survivor = await startStandIn(h);
      // The pid of the owner was reused by this process: alive, but created long after the recorded start of the owner.
      const owner = { pid: process.pid, startedAtMs: (await ownStartMs()) - HOUR_MS };
      putRegistryFile(h, owner, [{ pid: survivor.pid, spawnedAtMs: survivor.createdAtMs + RECORDED_LATE_MS }]);

      expect(await h.service.sweepOrphans()).toEqual({ files: 1, killed: 1, skipped: 0 });
      await h.waitGone([survivor.pid], 'the survivor of the impostor owner to be ended');
      expect(registryFiles(h)).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-11 the sweep deletes a corrupt, foreign-schema, mismatched or oversized file, and leaves a name it does not own',
    async () => {
      const h = start({ route: 'direct' });
      const survivor = await startStandIn(h);
      const dir = registryDir(h);
      const pid = await endedPid(h);
      const startedAtMs = Date.now() - HOUR_MS;
      const good = RegistryFileSchema.parse({
        schemaVersion: 1,
        owner: { pid, startedAtMs },
        children: [{ pid: survivor.pid, spawnedAtMs: survivor.createdAtMs + RECORDED_LATE_MS }],
      });
      const tooMany = Array.from({ length: REGISTRY_MAX_CHILDREN + 1 }, (_unused, index) => ({
        pid: survivor.pid,
        spawnedAtMs: index,
      }));

      // Five files of the registry's name pattern, each broken in another way and each able to name the live survivor: none of
      // them may end it, and all of them go.
      const oversized = `${' '.repeat(REGISTRY_FILE_MAX_BYTES)}${JSON.stringify(good)}`;
      const broken: Record<string, string> = {
        [`${String(pid)}-1.json`]: '{ this is not json',
        [`${String(pid)}-2.json`]: JSON.stringify({ ...good, extra: true }),
        [`${String(pid)}-3.json`]: JSON.stringify({ ...good, children: tooMany }),
        // valid content, but the name says another owner: the name is what the sweep trusts first
        [`${String(pid + 7)}-${String(startedAtMs)}.json`]: JSON.stringify(good),
        [`${String(pid)}-4.json`]: oversized,
      };
      // Not a registry name: the sweep does not read it, count it or delete it.
      const foreign: Record<string, string> = {
        'notes.txt': 'hello',
        [`${String(pid)}-x.json`]: '{}',
        'terminals.json': '{}',
      };
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries({ ...broken, ...foreign })) writeFileSync(path.join(dir, name), text);
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(REGISTRY_FILE_MAX_BYTES);

      expect(await h.service.sweepOrphans()).toEqual({ files: Object.keys(broken).length, killed: 0, skipped: 0 });
      expect(registryFiles(h)).toEqual(Object.keys(foreign).sort());
      expect(await h.stillRuns(survivor.pid)).toBe(true);

      await endStandIn(h, survivor.pid);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
