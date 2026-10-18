// WP-87: the POSIX process branches with real processes (ADR 0065 item 4): a detached child survives its parent in its own
// session, a SIGKILL of a marker-verified child, the /proc listing finds a real child by its command line and ignores one
// without the instance token, and LC_ALL=C reaches the children of execFileText. Mutex contention between real processes on
// the abstract socket is covered by mutex.int.test.ts (it runs on Linux in the Docker harness).
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { killAllTracked, spawnTracked, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { execFileText, spawnDetached } from '../../src/platform/exec.ts';
import { hasRuntimeMarker, listRuntimeProcesses } from '../../src/platform/markers.ts';
import { commandLineOf, forceKill, pidAlive, waitForExit } from '../../src/platform/process.ts';

const makeTemp = useTempDirs();
const linux = process.platform === 'linux';
const extraPids: number[] = [];

afterEach(async () => {
  for (const pid of extraPids.splice(0)) if (pidAlive(pid)) await forceKill(pid);
  await killAllTracked();
});

/** Field 6 of /proc/<pid>/stat is the session id; the command name in field 2 may hold spaces, so parse after the `)`. */
function sessionOf(pid: number): number {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[3]);
}

/** A fake server entry under `<root>/runtime` that idles until killed. */
function fakeRuntime(root: string): { runtimeDir: string; entry: string } {
  const runtimeDir = path.join(root, 'runtime');
  const dist = path.join(runtimeDir, 'packages', 'server', 'dist');
  mkdirSync(dist, { recursive: true });
  const entry = path.join(dist, 'main.js');
  writeFileSync(entry, 'setInterval(() => undefined, 1000);\n');
  return { runtimeDir, entry };
}

describe.runIf(linux)('POSIX processes on Linux', () => {
  it('a detached child survives its parent and leads its own session', async () => {
    const dir = makeTemp('posix-detached').path;
    const pidFile = path.join(dir, 'child.pid');
    const parent = path.join(dir, 'parent.mjs');
    // A plain parent that detaches a child the way spawnDetached does, then exits.
    writeFileSync(
      parent,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { detached: true, stdio: 'ignore' });",
        'child.unref();',
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        '',
      ].join('\n'),
    );
    const p = spawnTracked(process.execPath, [parent]);
    expect(await p.exited).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    extraPids.push(pid);
    expect(pidAlive(pid)).toBe(true);
    expect(sessionOf(pid)).toBe(pid);
    expect(sessionOf(pid)).not.toBe(sessionOf(process.pid));
  });

  it('spawnDetached starts a child in a new session that outlives an unref', () => {
    const dir = makeTemp('posix-spawn-detached').path;
    const out = openSync(path.join(dir, 'out.log'), 'a');
    const child = spawnDetached(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '' },
      stdoutFd: out,
      stderrFd: out,
    });
    closeSync(out);
    child.on('error', () => undefined);
    const pid = child.pid ?? 0;
    extraPids.push(pid);
    expect(pid).toBeGreaterThan(0);
    expect(sessionOf(pid)).toBe(pid);
  });

  it('lists a real runtime child by its command line, ignores one without the token, and SIGKILLs the verified one', async () => {
    const root = makeTemp('posix-lister').path;
    const { runtimeDir, entry } = fakeRuntime(root);
    const id = randomUUID();
    const marked = spawnTracked(process.execPath, [entry, `--mcs-instance=${id}`, `--instance-dir=${root}`]);
    const unmarked = spawnTracked(process.execPath, [entry, 'serve']);
    // the instance token without a server entry: never a runtime process
    const other = spawnTracked(process.execPath, ['-e', 'setInterval(() => undefined, 1000)', `--mcs-instance=${id}`]);
    const rows = await waitFor(
      async () => {
        const list = await listRuntimeProcesses(runtimeDir);
        return list.some((r) => r.pid === marked.pid) ? list : null;
      },
      { timeoutMs: 10_000, what: 'the marked child in the /proc listing' },
    );
    const mine = rows.find((r) => r.pid === marked.pid);
    expect(mine).toMatchObject({ instanceId: id, instanceDir: root });
    // the unmarked child runs the entry too, so it is listed, but without an instance id it is never a match
    expect(rows.find((r) => r.pid === unmarked.pid)?.instanceId ?? null).toBeNull();
    expect(rows.some((r) => r.pid === other.pid)).toBe(false);
    expect(hasRuntimeMarker((await commandLineOf(other.pid)) ?? '', id)).toBe(false);

    const line = await commandLineOf(marked.pid);
    expect(line).not.toBeNull();
    expect(hasRuntimeMarker(line ?? '', id)).toBe(true);
    expect(hasRuntimeMarker((await commandLineOf(unmarked.pid)) ?? '', id)).toBe(false);
    expect(hasRuntimeMarker(line ?? '', id.toUpperCase())).toBe(false);

    await forceKill(marked.pid);
    expect(await waitForExit(marked.pid, 5000)).toBe(true);
    expect(await marked.exited).toBeNull();
    expect(pidAlive(unmarked.pid)).toBe(true);
  });

  it('passes LC_ALL=C to the children of execFileText, whatever the parent has', async () => {
    const before = process.env['LC_ALL'];
    process.env['LC_ALL'] = 'vi_VN.UTF-8';
    try {
      const result = await execFileText({
        kind: 'node',
        file: process.execPath,
        args: ['-p', 'process.env.LC_ALL + "|" + (process.env.MCS_HOOK_DISABLE ?? "")'],
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        encoding: 'utf8',
      });
      expect(result.ok).toBe(true);
      expect(result.stdout.trim()).toBe('C|1');
    } finally {
      if (before === undefined) delete process.env['LC_ALL'];
      else process.env['LC_ALL'] = before;
    }
  });

  it('a dead pid is not alive and its command line is gone', async () => {
    const child = spawnTracked(process.execPath, ['-e', '']);
    await child.exited;
    expect(existsSync(`/proc/${String(child.pid)}/cmdline`) && pidAlive(child.pid)).toBe(false);
    expect(await commandLineOf(child.pid)).toBeNull();
  });
});
