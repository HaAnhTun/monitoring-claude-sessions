// The machine panel sampler (06 3.7, ADR 0050-0052). Four sources become one `MachinePanel`:
//   - memory and cpu: computed in the request that finds them older than 1.8 s, from `os` (the macOS available memory comes
//     from `vm_stat`, because `os.freemem()` counts free pages only);
//   - processes: the watched processes with their count and memory, from one process listing per OS (Windows: a one-shot
//     hidden PowerShell, Linux: `/proc` read in Node, macOS and other POSIX: `ps`), at most once per
//     `panelOptions.machineProcessIntervalMs` and only while somebody asks (demand driven, single flight, stale while
//     revalidating, last good value kept);
//   - docker: `docker ps`, when enabled.
// The watched list is applied in Node to the listing; it never reaches a command. Nothing here reads `process.platform`:
// the platform comes from `platform/host.ts` (injectable for tests).
import os from 'node:os';

import { isoMsZ, type Clock, type MachinePanel, type PanelStats } from '@mcs/shared';

import type { ExecApi } from '../runtime/context.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import { hostPlatform as realHostPlatform, type HostPlatform } from '../platform/host.ts';
import { PANEL_SOURCE_TABLE, specFor, type SourceTiming } from './constants.ts';
import { createDockerSource } from './docker.ts';
import { COMM_MAX_CHARS, createLinuxLister, realProcFs, type ProcFs } from './proc-linux.ts';
import { createPosixLister, readMacAvailableBytes } from './proc-posix.ts';
import { createWin32Lister } from './proc-win32.ts';
import { SourceCache, sourceState, type CacheRead, type PanelSample, type SourceResult } from './source-cache.ts';

/** One running process as the listings report it: the image name and the resident (working set) size. */
export interface ProcessEntry {
  name: string;
  workingSetBytes: number;
}

/** What the sampler needs to start a child. */
export type MachineExec = Pick<ExecApi, 'execFileText' | 'resolveExecutable'>;

export interface MachineCpu {
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

/** The slice of `node:os` that the sampler reads; tests inject fixed numbers. */
export interface MachineOs {
  totalmem(): number;
  freemem(): number;
  cpus(): readonly MachineCpu[];
}

export type ProcessRow = MachinePanel['procs'][number];

const GiB = 1_073_741_824;
const MiB = 1_048_576;
/** Memory and cpu are sampled again when the last sample is older than this (06 3.5 source table). */
const BASICS_TTL_MS = PANEL_SOURCE_TABLE.memory.ttlMs;
const VM_STAT_RETRY_MS = 300_000;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Free and total in GiB (2 and 1 decimals) and the used share in whole percent; free is held within 0..total. */
export function memorySample(
  totalBytes: number,
  freeBytes: number,
): { freeGb: number; totalGb: number; usedPct: number } {
  const total = Math.max(0, totalBytes);
  const free = Math.min(Math.max(0, freeBytes), total);
  return {
    freeGb: round(free / GiB, 2),
    totalGb: round(total / GiB, 1),
    usedPct: total > 0 ? Math.round((100 * (total - free)) / total) : 0,
  };
}

/** Legacy contract: the first sample is `null`, then the busy share of all cores since the previous call. */
export class CpuSampler {
  readonly #read: () => readonly MachineCpu[];
  #previous: { busy: number; total: number } | null = null;

  constructor(read: () => readonly MachineCpu[] = () => os.cpus()) {
    this.#read = read;
  }

  sample(): number | null {
    let busy = 0;
    let total = 0;
    for (const cpu of this.#read()) {
      const t = cpu.times;
      const used = t.user + t.nice + t.sys + t.irq;
      busy += used;
      total += used + t.idle;
    }
    const previous = this.#previous;
    this.#previous = { busy, total };
    if (previous === null) return null;
    const dt = total - previous.total;
    const db = busy - previous.busy;
    if (!(dt > 0) || db < 0) return null;
    return Math.min(100, Math.round((100 * db) / dt));
  }
}

function stem(name: string): string {
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}

/**
 * The first watched entry (config order) that names the process, or `null`. Case-insensitive, with or without `.exe` on
 * either side, so the Windows-centric defaults (`node.exe`) also match `node` on Linux and macOS. A process name of exactly
 * 15 characters may be a name cut by the kernel: it also matches a longer watched name that starts with it. Entries are plain
 * text, never patterns, and an empty entry matches nothing.
 */
export function matchWatched(processName: string, watched: readonly string[]): string | null {
  const name = stem(processName.toLowerCase());
  if (name === '') return null;
  for (const entry of watched) {
    const wanted = stem(entry.trim().toLowerCase());
    if (wanted === '') continue;
    if (wanted === name) return entry;
    if (name.length === COMM_MAX_CHARS && wanted.length > COMM_MAX_CHARS && wanted.startsWith(name)) return entry;
  }
  return null;
}

function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Counts and sums the watched processes under the display name of the first matching config entry: the megabytes are floored
 * per process, then added (legacy), and the rows are sorted by `mb` descending, then by name.
 */
export function aggregateWatched(entries: readonly ProcessEntry[], watched: readonly string[]): ProcessRow[] {
  const rows = new Map<string, { count: number; mb: number }>();
  for (const entry of entries) {
    const display = matchWatched(entry.name, watched);
    if (display === null) continue;
    const row = rows.get(display) ?? { count: 0, mb: 0 };
    row.count += 1;
    row.mb += Math.floor(entry.workingSetBytes / MiB);
    rows.set(display, row);
  }
  return [...rows]
    .map(([name, row]) => ({ name, count: row.count, mb: row.mb }))
    .sort((a, b) => b.mb - a.mb || compareNames(a.name, b.name));
}

export interface MachineSamplerDeps {
  clock: Clock;
  errors: ErrorRing;
  exec: MachineExec;
  /** `config.watched_processes`, as written: matching and the display name are done here. */
  watchedProcesses: readonly string[];
  /** `config.docker`. */
  docker: boolean;
  /** `panelOptions.machineProcessIntervalMs`; default 20000. */
  processIntervalMs?: number;
  /** Default: the host platform. */
  hostPlatform?: HostPlatform;
  /** Default: `node:os`. */
  os?: MachineOs;
  /** Default: the real `/proc` (used on Linux only). */
  procFs?: ProcFs;
  /** Replaces fields of the source table (tests use short waits). */
  timings?: Partial<Record<'processes' | 'docker', Partial<SourceTiming>>>;
}

export interface MachineSampler {
  /** Reads the sources and shapes `MachinePanel`; memory and cpu are always present. */
  read(): Promise<PanelSample<MachinePanel>>;
  /** Aborts the running calls (the panel service closes). */
  abort(): void;
  /** Counters of the sources read at least once. */
  stats(): PanelStats;
}

interface Basics {
  at: number;
  free: number;
  total: number;
  cpuPct: number | null;
}

const NOTHING_TO_WATCH: CacheRead<ProcessRow[]> = {
  value: [],
  sampledAt: null,
  status: 'disabled',
  message: null,
};

export function createMachineSampler(deps: MachineSamplerDeps): MachineSampler {
  const { clock, errors, exec } = deps;
  const platform = deps.hostPlatform ?? realHostPlatform;
  const machineOs: MachineOs = deps.os ?? {
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    cpus: () => os.cpus(),
  };
  const watched = [...deps.watchedProcesses];
  const processTiming = deps.timings?.processes;
  const processTimeoutMs = processTiming?.timeoutMs ?? PANEL_SOURCE_TABLE.processes.timeoutMs;

  // ---- processes: one listing per OS, filtered and summed in Node
  const lister: { load(signal: AbortSignal): Promise<SourceResult<ProcessEntry[]>> } =
    platform === 'win32'
      ? createWin32Lister({ exec, timeoutMs: processTimeoutMs })
      : platform === 'linux'
        ? createLinuxLister({ fs: deps.procFs ?? realProcFs })
        : createPosixLister({ exec, timeoutMs: processTimeoutMs });

  const processes = new SourceCache<ProcessRow[]>(
    specFor<ProcessRow[]>(
      'processes',
      async (signal) => {
        const listed = await lister.load(signal);
        return listed.status === 'ok' ? { status: 'ok', value: aggregateWatched(listed.value, watched) } : listed;
      },
      { ...(deps.processIntervalMs === undefined ? {} : { ttlMs: deps.processIntervalMs }), ...processTiming },
    ),
    clock,
    errors,
  );

  const docker = createDockerSource({
    enabled: deps.docker,
    clock,
    errors,
    exec,
    ...(deps.timings?.docker === undefined ? {} : { timing: deps.timings.docker }),
  });

  // ---- memory and cpu: sampled by the request that finds them stale (06 3.7.6)
  // macOS: the available memory of `vm_stat` is read inside the (single flight, TTL bound) basics sample and awaited, so the
  // figure is as fresh as the sample. It is not cached on its own: a stale-while-revalidate cache would show an old figure as
  // current. A vm_stat that is missing or fails is not asked again for 5 minutes; os.freemem() answers meanwhile.
  const vmStatAbort = new AbortController();
  let vmStatRetryAt = 0;

  async function macAvailableBytes(): Promise<number | null> {
    if (platform !== 'darwin' || clock.now() < vmStatRetryAt) return null;
    let available: number | null;
    try {
      available = await readMacAvailableBytes(exec, vmStatAbort.signal);
    } catch {
      available = null;
    }
    if (available === null) vmStatRetryAt = clock.now() + VM_STAT_RETRY_MS;
    return available;
  }

  const cpu = new CpuSampler(() => machineOs.cpus());
  let basics: Basics | null = null;
  let basicsInflight: Promise<Basics> | null = null;
  let refreshes = 0;

  async function sampleBasics(): Promise<Basics> {
    const available = await macAvailableBytes();
    const total = machineOs.totalmem();
    const next: Basics = {
      at: clock.now(),
      total,
      free: available ?? machineOs.freemem(),
      cpuPct: cpu.sample(),
    };
    basics = next;
    refreshes += 1;
    return next;
  }

  function currentBasics(): Promise<Basics> {
    if (basics !== null && clock.now() - basics.at < BASICS_TTL_MS) return Promise.resolve(basics);
    basicsInflight ??= sampleBasics().finally(() => {
      basicsInflight = null;
    });
    return basicsInflight;
  }

  /** A listing that no longer describes the machine (tool missing, nothing to watch) shows no rows even if an old one is kept. */
  function shown<T>(read: CacheRead<T>): T | null {
    return read.status === 'unavailable' || read.status === 'unsupported' || read.status === 'disabled'
      ? null
      : read.value;
  }

  return {
    async read(): Promise<PanelSample<MachinePanel>> {
      const [mem, procs, dock] = await Promise.all([
        currentBasics(),
        watched.length === 0 ? Promise.resolve(NOTHING_TO_WATCH) : processes.read(),
        docker.read(),
      ]);
      const memory = memorySample(mem.total, mem.free);
      const sampledAt = isoMsZ(mem.at);
      const data: MachinePanel = {
        sampledAt,
        ...memory,
        cpuPct: mem.cpuPct,
        procs: shown(procs) ?? [],
        docker: shown(dock) ?? [],
        platform,
        procsSampledAt: procs.sampledAt === null ? null : isoMsZ(procs.sampledAt),
        procsStatus: procs.status,
        dockerEnabled: docker.enabled,
        dockerSampledAt: dock.sampledAt === null ? null : isoMsZ(dock.sampledAt),
        dockerStatus: dock.status,
      };
      const sampled: CacheRead<unknown> = { value: null, sampledAt: mem.at, status: 'ok', message: null };
      return {
        data,
        sources: [
          sourceState('memory', sampled),
          sourceState('cpu', sampled),
          sourceState('processes', procs),
          sourceState('docker', dock),
        ],
      };
    },

    abort(): void {
      processes.abort();
      docker.abort();
      vmStatAbort.abort();
    },

    stats(): PanelStats {
      const out: PanelStats = {};
      if (refreshes > 0) {
        out.memory = { refreshes, failures: 0, lastDurationMs: 0, lastStatus: 'ok' };
        out.cpu = { refreshes, failures: 0, lastDurationMs: 0, lastStatus: 'ok' };
      }
      const procStats = processes.stats();
      if (procStats.refreshes > 0) out.processes = procStats;
      const dockerStats = docker.stats();
      if (dockerStats !== null && dockerStats.refreshes > 0) out.docker = dockerStats;
      return out;
    },
  };
}
