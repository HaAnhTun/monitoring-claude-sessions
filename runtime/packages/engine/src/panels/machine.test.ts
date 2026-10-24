import { isoMsZ, MachinePanelSchema, type MachinePanel } from '@mcs/shared';
import { FakeClock, FIXTURE_EPOCH_MS } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { ChildResult, ChildSpec } from '../platform/exec.ts';
import { createErrorRing } from '../runtime/error-ring.ts';
import {
  aggregateWatched,
  CpuSampler,
  createMachineSampler,
  matchWatched,
  memorySample,
  type MachineCpu,
  type MachineOs,
  type MachineSamplerDeps,
} from './machine.ts';
import type { ProcFs } from './proc-linux.ts';
import { panelStatus } from './source-cache.ts';

/** Lets a background refresh (microtasks only: the fakes answer at once) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

const GiB = 1_073_741_824;
const MiB = 1_048_576;
const POWERSHELL = 'C:\\fixture\\powershell.exe';

const result = (over: Partial<ChildResult>): ChildResult => ({
  ok: over.error === undefined && (over.code ?? 0) === 0,
  code: 0,
  stdout: '',
  stderr: '',
  error: null,
  truncated: false,
  durationMs: 1,
  ...over,
});

describe('memorySample', () => {
  it('rounds free to 2 decimals, total to 1 decimal and used to a whole percent', () => {
    expect(memorySample(17_179_869_184, 5_000_000_000)).toEqual({ freeGb: 4.66, totalGb: 16, usedPct: 71 });
    expect(memorySample(34_000_000_000, 1_000_000_000)).toEqual({ freeGb: 0.93, totalGb: 31.7, usedPct: 97 });
  });

  it('survives a zero total and a free amount above the total', () => {
    expect(memorySample(0, 0)).toEqual({ freeGb: 0, totalGb: 0, usedPct: 0 });
    expect(memorySample(GiB, 2 * GiB)).toEqual({ freeGb: 1, totalGb: 1, usedPct: 0 });
    expect(memorySample(GiB, -5)).toEqual({ freeGb: 0, totalGb: 1, usedPct: 100 });
  });
});

describe('CpuSampler', () => {
  const cpu = (user: number, sys: number, idle: number) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

  it('gives null on the first sample and the busy share since the previous call afterwards', () => {
    let cpus = [cpu(100, 100, 800)];
    const sampler = new CpuSampler(() => cpus);
    expect(sampler.sample()).toBeNull();
    cpus = [cpu(150, 150, 900)]; // delta: busy 100 of 200 total
    expect(sampler.sample()).toBe(50);
    cpus = [cpu(151, 150, 1000)]; // delta: busy 1 of 101 total -> 0.99 -> 1
    expect(sampler.sample()).toBe(1);
  });

  it('sums all cores and counts nice and irq as busy', () => {
    let cpus = [cpu(0, 0, 0), cpu(0, 0, 0)];
    const sampler = new CpuSampler(() => cpus);
    sampler.sample();
    cpus = [
      { times: { user: 10, nice: 10, sys: 10, idle: 0, irq: 10 } },
      { times: { user: 0, nice: 0, sys: 0, idle: 160, irq: 0 } },
    ];
    expect(sampler.sample()).toBe(20);
  });

  it('gives null for a zero delta and keeps going afterwards', () => {
    let cpus = [cpu(10, 10, 80)];
    const sampler = new CpuSampler(() => cpus);
    sampler.sample();
    expect(sampler.sample()).toBeNull();
    cpus = [cpu(20, 10, 170)];
    expect(sampler.sample()).toBe(10);
  });

  it('gives null for a counter that went backwards', () => {
    let cpus = [cpu(100, 100, 800)];
    const sampler = new CpuSampler(() => cpus);
    sampler.sample();
    cpus = [cpu(1, 1, 1)];
    expect(sampler.sample()).toBeNull();
  });
});

describe('matchWatched', () => {
  it('matches case-insensitively and with or without .exe on either side', () => {
    expect(matchWatched('code', ['Code.exe'])).toBe('Code.exe');
    expect(matchWatched('Code', ['code.exe'])).toBe('code.exe');
    expect(matchWatched('vmmemWSL', ['vmmemWSL'])).toBe('vmmemWSL');
    expect(matchWatched('NODE', ['node.exe'])).toBe('node.exe');
    expect(matchWatched('node.exe', ['node'])).toBe('node');
    expect(matchWatched('node', ['node.exe'])).toBe('node.exe');
    expect(matchWatched('nodejs', ['node.exe'])).toBeNull();
    expect(matchWatched('node', [])).toBeNull();
  });

  it('matches a name cut at 15 characters against the longer watched name', () => {
    expect(matchWatched('com.docker.back', ['com.docker.backend.exe'])).toBe('com.docker.backend.exe');
    expect(matchWatched('com.docker.back', ['com.docker.backend'])).toBe('com.docker.backend');
    // only the kernel's limit counts as a cut: a shorter name must match whole
    expect(matchWatched('com.docker.bac', ['com.docker.backend.exe'])).toBeNull();
    expect(matchWatched('com.docker.back', ['com.other.backend.exe'])).toBeNull();
  });

  it('lets the first config entry win and returns its spelling', () => {
    expect(matchWatched('node', ['NODE', 'node.exe'])).toBe('NODE');
    expect(matchWatched('node', ['x', 'node.exe', 'node'])).toBe('node.exe');
  });

  it('never matches an empty or blank entry and treats regex characters as plain text', () => {
    expect(matchWatched('', [''])).toBeNull();
    expect(matchWatched('node', ['', '  ', 'node'])).toBe('node');
    expect(matchWatched('node', ['n.*', '(', '[a-z]+', 'no|de', '^node$'])).toBeNull();
    expect(matchWatched('a.b', ['a.b'])).toBe('a.b');
    expect(matchWatched('axb', ['a.b'])).toBeNull();
  });
});

describe('aggregateWatched', () => {
  it('floors megabytes per process before it sums, counts, and sorts by mb then name', () => {
    const rows = aggregateWatched(
      [
        { name: 'node', workingSetBytes: Math.floor(1.9 * MiB) },
        { name: 'node', workingSetBytes: Math.floor(1.9 * MiB) },
        { name: 'Code', workingSetBytes: 5 * MiB },
        { name: 'chrome', workingSetBytes: 5 * MiB },
        { name: 'unwatched', workingSetBytes: 900 * MiB },
        { name: 'java', workingSetBytes: MiB - 1 },
      ],
      ['node.exe', 'Code.exe', 'chrome.exe', 'java.exe', 'missing.exe'],
    );
    expect(rows).toEqual([
      { name: 'chrome.exe', count: 1, mb: 5 },
      { name: 'Code.exe', count: 1, mb: 5 },
      { name: 'node.exe', count: 2, mb: 2 },
      { name: 'java.exe', count: 1, mb: 0 },
    ]);
  });

  it('is empty without a watched list or without processes', () => {
    expect(aggregateWatched([{ name: 'node', workingSetBytes: MiB }], [])).toEqual([]);
    expect(aggregateWatched([], ['node'])).toEqual([]);
  });
});

// ---- the sampler ----------------------------------------------------------------------------------------------------

interface Harness {
  sampler: ReturnType<typeof createMachineSampler>;
  clock: FakeClock;
  os: { total: number; free: number; cpus: MachineCpu[] };
  calls: ChildSpec[];
  setAnswer(fn: (spec: ChildSpec) => Partial<ChildResult>): void;
  resolved: string[];
}

function harness(over: Partial<MachineSamplerDeps> = {}, answer?: (spec: ChildSpec) => Partial<ChildResult>): Harness {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const calls: ChildSpec[] = [];
  const resolved: string[] = [];
  let handler: (spec: ChildSpec) => Partial<ChildResult> =
    answer ?? (() => ({ stdout: `node\t1\t${String(10 * MiB)}\n` }));
  const osState: Harness['os'] = {
    total: 16 * GiB,
    free: 4 * GiB,
    cpus: [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
  };
  const machineOs: MachineOs = {
    totalmem: () => osState.total,
    freemem: () => osState.free,
    cpus: () => osState.cpus,
  };
  const sampler = createMachineSampler({
    clock,
    errors: createErrorRing(clock),
    watchedProcesses: ['node.exe'],
    docker: false,
    hostPlatform: 'win32',
    os: machineOs,
    exec: {
      resolveExecutable: (name) => {
        resolved.push(name);
        return Promise.resolve(name === 'powershell' ? POWERSHELL : name === 'ps' ? '/bin/ps' : '/usr/bin/docker');
      },
      execFileText: (spec) => {
        calls.push(spec);
        return Promise.resolve(result(handler(spec)));
      },
    },
    ...over,
  });
  return {
    sampler,
    clock,
    os: osState,
    calls,
    resolved,
    setAnswer: (fn) => {
      handler = fn;
    },
  };
}

const dataOf = (sample: { data: MachinePanel | null }): MachinePanel => {
  if (sample.data === null) throw new Error('expected data');
  return sample.data;
};

describe('createMachineSampler', () => {
  it('assembles memory, cpu, processes and docker into a MachinePanel that fits the contract', async () => {
    const h = harness();
    const sample = await h.sampler.read();
    const data = dataOf(sample);
    expect(MachinePanelSchema.parse(data)).toEqual(data);
    expect(data).toEqual({
      sampledAt: isoMsZ(FIXTURE_EPOCH_MS),
      freeGb: 4,
      totalGb: 16,
      usedPct: 75,
      cpuPct: null,
      procs: [{ name: 'node.exe', count: 1, mb: 10 }],
      docker: [],
      platform: 'win32',
      procsSampledAt: isoMsZ(FIXTURE_EPOCH_MS),
      procsStatus: 'ok',
      dockerEnabled: false,
      dockerSampledAt: null,
      dockerStatus: 'disabled',
    });
    expect(sample.sources.map((s) => [s.source, s.status])).toEqual([
      ['memory', 'ok'],
      ['cpu', 'ok'],
      ['processes', 'ok'],
      ['docker', 'disabled'],
    ]);
    expect(panelStatus(sample.sources, true)).toBe('ok');
  });

  it('gives a null cpu on the first sample and a delta once the cache is older than 1.8 s', async () => {
    const h = harness();
    expect(dataOf(await h.sampler.read()).cpuPct).toBeNull();
    h.os.cpus = [{ times: { user: 50, nice: 0, sys: 0, idle: 50, irq: 0 } }];
    h.clock.advance(1000); // inside the ttl: the cached sample is served
    expect(dataOf(await h.sampler.read()).cpuPct).toBeNull();
    h.clock.advance(1000);
    expect(dataOf(await h.sampler.read()).cpuPct).toBe(50);
    h.clock.advance(2000); // nothing moved: zero delta
    expect(dataOf(await h.sampler.read()).cpuPct).toBeNull();
  });

  it('re-reads memory only when the sample is older than 1.8 s', async () => {
    const h = harness();
    expect(dataOf(await h.sampler.read()).usedPct).toBe(75);
    h.os.free = 8 * GiB;
    h.clock.advance(1000);
    expect(dataOf(await h.sampler.read()).usedPct).toBe(75);
    h.clock.advance(1000);
    const data = dataOf(await h.sampler.read());
    expect(data.usedPct).toBe(50);
    expect(data.freeGb).toBe(8);
  });

  it('samples the process list on demand, once for many readers, and at most once per interval', async () => {
    const h = harness();
    expect(h.calls).toHaveLength(0);
    await Promise.all(Array.from({ length: 20 }, () => h.sampler.read()));
    expect(h.calls).toHaveLength(1);
    h.clock.advance(19_000);
    await h.sampler.read();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(2000);
    await h.sampler.read();
    await flush();
    expect(h.calls).toHaveLength(2);
  });

  it('takes the process interval from the configuration', async () => {
    const h = harness({ processIntervalMs: 60_000 });
    await h.sampler.read();
    h.clock.advance(59_000);
    await h.sampler.read();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(2000);
    await h.sampler.read();
    await flush();
    expect(h.calls).toHaveLength(2);
  });

  it('reports the real time of the process sample, not the time of the request', async () => {
    const h = harness();
    h.setAnswer(() => {
      h.clock.advance(150);
      return { stdout: 'node\t1\t' + String(MiB) + '\n' };
    });
    const data = dataOf(await h.sampler.read());
    expect(data.procsSampledAt).toBe(isoMsZ(FIXTURE_EPOCH_MS + 150));
  });

  it('serves the last list when a refresh times out, with the error status', async () => {
    const h = harness();
    await h.sampler.read();
    h.setAnswer(() => ({ ok: false, code: null, error: 'TIMEOUT' }));
    h.clock.advance(21_000);
    await h.sampler.read();
    await flush();
    const sample = await h.sampler.read();
    const data = dataOf(sample);
    expect(data.procs).toEqual([{ name: 'node.exe', count: 1, mb: 10 }]);
    expect(data.procsStatus).toBe('error');
    expect(data.procsSampledAt).toBe(isoMsZ(FIXTURE_EPOCH_MS));
    expect(panelStatus(sample.sources, true)).toBe('partial');
    expect(sample.sources.find((s) => s.source === 'processes')?.message).toBe('the process list timed out');
  });

  it('keeps memory and cpu when PowerShell is not available', async () => {
    const h = harness({}, () => ({ ok: false, code: null, error: 'ENOENT' }));
    const sample = await h.sampler.read();
    const data = dataOf(sample);
    expect(data.procs).toEqual([]);
    expect(data.procsStatus).toBe('unavailable');
    expect(data.procsSampledAt).toBeNull();
    expect(data.totalGb).toBe(16);
    expect(MachinePanelSchema.safeParse(data).success).toBe(true);
  });

  it('does not spawn anything for an empty watched list', async () => {
    const h = harness({ watchedProcesses: [] });
    const data = dataOf(await h.sampler.read());
    expect(h.calls).toHaveLength(0);
    expect(data.procs).toEqual([]);
    expect(data.procsStatus).toBe('disabled');
  });

  it('matches the watched list when the list holds an empty string and regex characters', async () => {
    const h = harness({ watchedProcesses: ['', '.*', 'node.exe'] }, () => ({
      stdout: ['node\t1\t' + String(2 * MiB), 'other\t2\t' + String(9 * MiB), ''].join('\n'),
    }));
    expect(dataOf(await h.sampler.read()).procs).toEqual([{ name: 'node.exe', count: 1, mb: 2 }]);
  });

  describe('platform dispatch', () => {
    it('windows: PowerShell with kind powershell.processes', async () => {
      const h = harness({ hostPlatform: 'win32' });
      await h.sampler.read();
      expect(h.calls.map((c) => [c.kind, c.file])).toEqual([['powershell.processes', POWERSHELL]]);
    });

    function linuxFs(): { fs: ProcFs; reads: string[] } {
      const reads: string[] = [];
      const fs: ProcFs = {
        readdir: () => Promise.resolve(['1', '2', 'self']),
        readFile: (file) => {
          reads.push(file);
          if (file === '/proc/1/status') return Promise.resolve('Name:\tnode\nVmRSS:\t 20480 kB\n');
          if (file === '/proc/2/status') return Promise.resolve('Name:\tkthreadd\n');
          return Promise.reject(new Error('unexpected'));
        },
      };
      return { fs, reads };
    }

    it('linux: reads /proc and spawns nothing', async () => {
      const { fs, reads } = linuxFs();
      const h = harness({ hostPlatform: 'linux', procFs: fs });
      const data = dataOf(await h.sampler.read());
      expect(data.platform).toBe('linux');
      expect(data.procs).toEqual([{ name: 'node.exe', count: 1, mb: 20 }]);
      expect(h.calls).toHaveLength(0);
      expect(h.resolved).toEqual([]);
      expect(reads).toEqual(['/proc/1/status', '/proc/2/status']);
    });

    it('linux: /proc missing is an unavailable source', async () => {
      const fs: ProcFs = {
        readdir: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })),
        readFile: () => Promise.reject(new Error('x')),
      };
      const h = harness({ hostPlatform: 'linux', procFs: fs });
      const data = dataOf(await h.sampler.read());
      expect(data.procsStatus).toBe('unavailable');
      expect(data.procs).toEqual([]);
    });

    it('darwin: ps for the list and vm_stat for the available memory', async () => {
      const h = harness({ hostPlatform: 'darwin' }, (spec) =>
        spec.file === '/usr/bin/vm_stat'
          ? {
              stdout:
                'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 262144.\nPages inactive: 131072.\n',
            }
          : { stdout: '/usr/bin/node 20480\n' },
      );
      h.os.free = GiB; // what os.freemem() says: understated on macOS
      const data = dataOf(await h.sampler.read());
      expect(data.platform).toBe('darwin');
      expect(data.procs).toEqual([{ name: 'node.exe', count: 1, mb: 20 }]);
      // (262144 + 131072) pages * 16384 bytes = 6 GiB
      expect(data.freeGb).toBe(6);
      expect(data.usedPct).toBe(63);
      expect(h.calls.map((c) => [c.kind, c.file]).sort()).toEqual([
        ['ps', '/bin/ps'],
        ['ps', '/usr/bin/vm_stat'],
      ]);
    });

    it('darwin: falls back to os.freemem() when vm_stat gives nothing', async () => {
      const h = harness({ hostPlatform: 'darwin' }, (spec) =>
        spec.file === '/usr/bin/vm_stat' ? { stdout: 'garbage' } : { stdout: 'node 20480\n' },
      );
      h.os.free = 3 * GiB;
      expect(dataOf(await h.sampler.read()).freeGb).toBe(3);
    });

    describe('darwin: vm_stat is read by the request that finds the sample stale', () => {
      const vmStatText = (freePages: number): string =>
        `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${String(freePages)}.\nPages inactive: 0.\n`;

      it('shows the new figure in the very next read after the sample expired', async () => {
        let freePages = 100_000;
        const h = harness({ hostPlatform: 'darwin' }, (spec) =>
          spec.file === '/usr/bin/vm_stat' ? { stdout: vmStatText(freePages) } : { stdout: 'node 20480\n' },
        );
        const first = dataOf(await h.sampler.read());
        expect(first.freeGb).toBe(1.53);
        freePages = 20_000;
        h.clock.advance(60 * 60 * 1000);
        const next = dataOf(await h.sampler.read());
        expect(next.freeGb).toBe(0.31);
        expect(next.sampledAt).toBe(new Date(h.clock.now()).toISOString());
      });

      it('does not run vm_stat again inside the 1.8 s window', async () => {
        const h = harness({ hostPlatform: 'darwin' }, (spec) =>
          spec.file === '/usr/bin/vm_stat' ? { stdout: vmStatText(100_000) } : { stdout: 'node 20480\n' },
        );
        await h.sampler.read();
        h.clock.advance(500);
        await h.sampler.read();
        expect(h.calls.filter((c) => c.file === '/usr/bin/vm_stat')).toHaveLength(1);
      });

      it('falls back to os.freemem() when vm_stat starts failing, and asks again after 5 minutes', async () => {
        let failing = false;
        const h = harness({ hostPlatform: 'darwin' }, (spec) =>
          spec.file === '/usr/bin/vm_stat'
            ? failing
              ? { ok: false, code: 1, error: 'NONZERO_EXIT', stdout: '' }
              : { stdout: vmStatText(100_000) }
            : { stdout: 'node 20480\n' },
        );
        h.os.free = 3 * GiB;
        expect(dataOf(await h.sampler.read()).freeGb).toBe(1.53);
        failing = true;
        h.clock.advance(2000);
        expect(dataOf(await h.sampler.read()).freeGb).toBe(3);
        const count = (): number => h.calls.filter((c) => c.file === '/usr/bin/vm_stat').length;
        expect(count()).toBe(2);
        h.clock.advance(2000);
        await h.sampler.read();
        expect(count()).toBe(2); // backing off
        failing = false;
        h.clock.advance(300_000);
        expect(dataOf(await h.sampler.read()).freeGb).toBe(1.53);
        expect(count()).toBe(3);
      });
    });

    it('other: ps only, no vm_stat', async () => {
      const h = harness({ hostPlatform: 'other' }, () => ({ stdout: 'node 20480\n' }));
      const data = dataOf(await h.sampler.read());
      expect(data.platform).toBe('other');
      expect(h.calls.map((c) => c.file)).toEqual(['/bin/ps']);
    });
  });

  describe('docker', () => {
    it('adds the docker lines and their state when enabled', async () => {
      const h = harness({ docker: true }, (spec) =>
        spec.kind === 'docker'
          ? { stdout: 'web (Up 1 hour)\ndb (Up 2 hours)\n' }
          : { stdout: 'node\t1\t' + String(MiB) + '\n' },
      );
      const sample = await h.sampler.read();
      const data = dataOf(sample);
      expect(data.dockerEnabled).toBe(true);
      expect(data.docker).toEqual(['web (Up 1 hour)', 'db (Up 2 hours)']);
      expect(data.dockerStatus).toBe('ok');
      expect(data.dockerSampledAt).toBe(isoMsZ(FIXTURE_EPOCH_MS));
    });

    it('shows no lines when docker is down, and the panel is partial', async () => {
      const h = harness({ docker: true }, (spec) =>
        spec.kind === 'docker'
          ? { ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'daemon is down' }
          : { stdout: 'node\t1\t' + String(MiB) + '\n' },
      );
      const sample = await h.sampler.read();
      const data = dataOf(sample);
      expect(data.docker).toEqual([]);
      expect(data.dockerStatus).toBe('error');
      expect(panelStatus(sample.sources, true)).toBe('partial');
    });

    it('makes no docker call when disabled', async () => {
      const h = harness({ docker: false });
      await h.sampler.read();
      expect(h.calls.some((c) => c.kind === 'docker')).toBe(false);
      expect(h.resolved).not.toContain('docker');
    });
  });

  it('counts refreshes per source in stats()', async () => {
    const h = harness();
    expect(h.sampler.stats()).toEqual({});
    await h.sampler.read();
    const stats = h.sampler.stats();
    expect(Object.keys(stats).sort()).toEqual(['cpu', 'memory', 'processes']);
    expect(stats.processes).toMatchObject({ refreshes: 1, failures: 0, lastStatus: 'ok' });
  });

  it('abort() lets a later read start again', async () => {
    const h = harness();
    await h.sampler.read();
    h.sampler.abort();
    h.clock.advance(21_000);
    const data = dataOf(await h.sampler.read());
    await flush();
    expect(data.procsStatus).toBe('ok');
    expect(h.calls).toHaveLength(2);
  });
});
