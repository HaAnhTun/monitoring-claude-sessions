// WP-104: the machine panel sampler against the real operating system. It runs unchanged on Windows, Linux and macOS:
//   - an idle child of the node binary (under a name of its own, so that no other node process counts) is found by the
//     watched-process matching with a size within 25 percent of what the child reports for itself;
//   - Windows exercises the real one-shot PowerShell path (kind powershell.processes), Linux proves that the process list
//     spawns no child at all (it reads /proc), macOS and other POSIX go through ps;
//   - B7: the cost of one refresh is measured and printed.
// macOS is UNVERIFIED until the macOS CI job has run this file.
import { copyFileSync, chmodSync, existsSync, linkSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { killAllTracked, spawnTracked, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { childStats, execFileText, resolveExecutable } from '../../src/platform/exec.ts';
import { hostPlatform } from '../../src/platform/host.ts';
import { createMachineSampler } from '../../src/panels/machine.ts';
import { createWin32Lister } from '../../src/panels/proc-win32.ts';
import { createErrorRing } from '../../src/runtime/error-ring.ts';

const makeTemp = useTempDirs();
const clock = { now: () => Date.now() };
const exec = { execFileText, resolveExecutable };

/** The image name of the idle child: at most 14 characters, so that no 15 character cut is involved. */
const FIXTURE_NAME = 'mcsidlefixture';
const IDLE_SCRIPT =
  'const fs = require("node:fs"); const write = () => fs.appendFileSync(process.argv[1], Date.now() + " " + process.memoryUsage().rss + "\\n"); write(); setInterval(write, 100);';

afterEach(async () => {
  await killAllTracked();
});

interface RssReading {
  at: number;
  bytes: number;
}

/**
 * A copy (or hard link) of the node binary under a unique name, started idle. The child appends its own rss every 100 ms:
 * a fresh binary path can step its working set by about ten megabytes at an unpredictable moment, so one snapshot does
 * not say what the sampler should see. The test compares the sampler with every reading around its read instead.
 */
async function startIdleChild(): Promise<{ readings: () => RssReading[]; pid: number }> {
  const dir = makeTemp('machine-os').path;
  const binary = path.join(dir, hostPlatform === 'win32' ? `${FIXTURE_NAME}.exe` : FIXTURE_NAME);
  try {
    linkSync(process.execPath, binary);
  } catch {
    copyFileSync(process.execPath, binary);
    chmodSync(binary, 0o755);
  }
  const rssFile = path.join(dir, 'rss.txt');
  const child = spawnTracked(binary, ['-e', IDLE_SCRIPT, rssFile]);
  const readings = (): RssReading[] => {
    if (!existsSync(rssFile)) return [];
    const out: RssReading[] = [];
    for (const line of readFileSync(rssFile, 'utf8').split('\n')) {
      const [at, bytes] = line.split(' ').map(Number);
      if (at !== undefined && bytes !== undefined && at > 0 && bytes > 0) out.push({ at, bytes });
    }
    return out;
  };
  await waitFor(() => (readings().length > 0 ? true : null), {
    timeoutMs: 30_000,
    what: 'the idle child to report its rss',
  });
  return { readings, pid: child.pid };
}

function sampler(watched: readonly string[]) {
  return createMachineSampler({
    clock,
    errors: createErrorRing(clock),
    exec,
    watchedProcesses: watched,
    docker: false,
    // A busy host can need more than the 3 s first-read wait of the table for one listing (a PowerShell start while other
    // processes load the machine); the test waits for the load itself, which is still bounded by the 10 s load timeout.
    timings: { processes: { firstWaitMs: 0 } },
  });
}

describe('machine sampler on the real OS', () => {
  it('finds an idle node child under its name with a size within 25 percent of its own rss', async () => {
    const child = await startIdleChild();
    const startedAt = Date.now();
    const read = await sampler([FIXTURE_NAME, 'node']).read();
    const endedAt = Date.now();
    // the readings that bracket the read: the last one at or before it started up to the first one after it ended
    const around = await waitFor(
      () => {
        const all = child.readings();
        const last = all.findIndex((r) => r.at > endedAt);
        if (last < 0) return null;
        const firstAfterStart = all.findIndex((r) => r.at > startedAt);
        return all.slice(Math.max(0, firstAfterStart - 1), last + 1);
      },
      { timeoutMs: 10_000, what: 'a reading of the idle child after the sampler read' },
    );
    const data = read.data;
    expect(data).not.toBeNull();
    expect(data?.procsStatus).toBe('ok');
    expect(data?.platform).toBe(hostPlatform);
    const fixture = data?.procs.find((row) => row.name === FIXTURE_NAME);
    expect(fixture?.count).toBeGreaterThanOrEqual(1);
    const ownMb = around.map((r) => r.bytes / 1_048_576);
    expect(fixture?.mb).toBeGreaterThan(Math.min(...ownMb) * 0.75);
    expect(fixture?.mb).toBeLessThan(Math.max(...ownMb) * 1.25);
    // the test runner itself is a node process too
    const node = data?.procs.find((row) => row.name === 'node');
    expect(node?.count).toBeGreaterThanOrEqual(1);
    expect(node?.mb ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it('reports memory, cpu and the time of the process sample', async () => {
    const before = Date.now();
    const data = (await sampler(['node']).read()).data;
    expect(data?.totalGb).toBeGreaterThan(0);
    expect(data?.freeGb).toBeGreaterThanOrEqual(0);
    expect(data?.usedPct).toBeGreaterThanOrEqual(0);
    expect(data?.usedPct).toBeLessThanOrEqual(100);
    expect(data?.cpuPct).toBeNull();
    expect(Date.parse(data?.procsSampledAt ?? '')).toBeGreaterThanOrEqual(before - 1);
  }, 30_000);

  it.runIf(hostPlatform === 'linux')('linux: the process list spawns no child process', async () => {
    const before = childStats();
    const data = (await sampler(['node']).read()).data;
    expect(data?.procsStatus).toBe('ok');
    expect(childStats()).toEqual(before);
  });

  it.runIf(hostPlatform === 'win32')(
    'windows: the one-shot PowerShell lists processes with the .NET script',
    async () => {
      const before = childStats()['powershell.processes'];
      const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
      const out = await lister.load(new AbortController().signal);
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') return;
      expect(lister.mode()).toBe('net');
      expect(out.value.some((p) => p.name.toLowerCase() === 'node' && p.workingSetBytes > 0)).toBe(true);
      const after = childStats()['powershell.processes'];
      expect(after.spawned - before.spawned).toBe(1);
      expect(after.failed - before.failed).toBe(0);
    },
    30_000,
  );

  it('B7: measures the cost of one process refresh', async () => {
    const kind = hostPlatform === 'win32' ? 'powershell.processes' : hostPlatform === 'linux' ? null : 'ps';
    const runs = 5;
    const before = childStats();
    const walls: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now();
      const data = (await sampler(['node']).read()).data;
      walls.push(performance.now() - started);
      expect(data?.procsStatus).toBe('ok');
    }
    const after = childStats();
    const childMs = kind === null ? 0 : (after[kind].totalMs - before[kind].totalMs) / runs;
    const spawned = kind === null ? 0 : after[kind].spawned - before[kind].spawned;
    const median = [...walls].sort((a, b) => a - b)[Math.floor(runs / 2)] ?? 0;
    process.stdout.write(
      `B7 ${hostPlatform}: ${median.toFixed(0)} ms wall per refresh (median of ${String(runs)}), ` +
        `${childMs.toFixed(0)} ms child wall per refresh, ${String(spawned)} children spawned\n`,
    );
    // Every loop iteration builds a new sampler, so its first read lists processes once. On macOS the same read also spawns
    // `vm_stat` for the available memory, and that child is counted under the same kind `ps`.
    const perRead = hostPlatform === 'darwin' ? 2 : 1;
    expect(spawned).toBe(kind === null ? 0 : runs * perRead);
    expect(median).toBeLessThan(5000);
  }, 120_000);
});
