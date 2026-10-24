// Calibration of the child processes the runtime spawns (design 06 sections 8.2 and 8.3, ADR 0051): for each `ChildKind` that has a
// command on this OS, `--runs` runs measure the wall time (a plain spawn) and, where the OS allows it without a privileged tool,
// the CPU time of the child:
//  - Windows: `TotalProcessorTime` read through a one-shot PowerShell that starts the command with `ProcessStartInfo`;
//  - Linux: `cutime` and `cstime` of `/proc/<shell>/stat` after the shell waited for the command (10 ms clock ticks);
//  - macOS: the `user` and `sys` lines of `/usr/bin/time -p` (10 ms resolution; UNVERIFIED, not run on this machine);
//  - anything else: `cpuMs: null`, and the B7 CPU row says NOT MEASURED.
// The kinds without a safe command (`opener` would open a window, `docker` needs a daemon and is only run with `--docker`) are
// reported as NOT MEASURED with the reason. Everything runs in a temp folder with a neutral environment.
// Output: bench/results/calibration-<UTC stamp>.json `{ kinds: { <kind>: { wallMsMedian, wallMsMax, cpuMsMedian, cpuMsMax, ... } } }`,
// read by `bench-idle.mjs` to turn spawn counts into child CPU.
// Usage: node bench/calibrate-children.mjs [--runs 6] [--docker]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { intOption } from './lib/instance.mjs';
import { check, judge, LIMITS, maximum, median, round } from './lib/stats.mjs';
import { writeResult } from './lib/target.mjs';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { runs: { type: 'string' }, docker: { type: 'boolean' } },
  strict: true,
});
const runs = intOption(values.runs, 6, 'runs');
const platform = process.platform;
const TIMEOUT_MS = 60_000;

// the scripts below are copies of the constants of the engine (`panels/proc-win32.ts`, `platform/process.ts`); a drift only
// changes the calibrated figure, never a result of the product
const PROC_SCRIPT_NET = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  'foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {',
  '[Console]::Out.Write($p.ProcessName + "`t" + $p.Id + "`t" + $p.WorkingSet64 + "`n")',
  '}',
].join(' ');
const cmdlineScript = (pid) =>
  "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`;
const encoded = (script) => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
];

const WRAPPER_SCRIPT = [
  '$psi = New-Object System.Diagnostics.ProcessStartInfo;',
  '$psi.FileName = $env:MCS_CAL_FILE; $psi.Arguments = $env:MCS_CAL_ARGS;',
  '$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true;',
  '$p = [System.Diagnostics.Process]::Start($psi);',
  '$o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync();',
  '$p.WaitForExit(); [void]$o.Result; [void]$e.Result;',
  "[Console]::Out.Write('cpuMs=' + [math]::Round($p.TotalProcessorTime.TotalMilliseconds, 1) + ' exit=' + $p.ExitCode)",
].join(' ');

const quoteWin = (arg) => (/[\s"]/.test(arg) || arg === '' ? `"${arg.replace(/"/g, '\\"')}"` : arg);

function whichSync(name) {
  const probe = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0) return null;
  return (
    probe.stdout
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? null
  );
}

/** Runs `file args` once with a plain spawn and resolves `{ wallMs, code }`. */
function timedRun(file, args, env, cwd) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    child.stdout.resume();
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      resolvePromise({ wallMs: performance.now() - started, code: -1 });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ wallMs: performance.now() - started, code: code ?? -1 });
    });
  });
}

/** Captures stdout and stderr of `file args`; resolves `{ code, stdout, stderr }`. */
function capture(file, args, env, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

const clockTicks = (() => {
  if (platform !== 'linux') return 100;
  const probe = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
  const value = Number.parseInt(probe.stdout ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : 100;
})();

/** The CPU of one run of `file args` in milliseconds, or null where this OS cannot measure it. */
async function cpuRun(file, args, env, cwd) {
  if (platform === 'win32') {
    const shell = whichSync('powershell.exe');
    if (shell === null) return null;
    const out = await capture(
      shell,
      encoded(WRAPPER_SCRIPT),
      { ...env, MCS_CAL_FILE: file, MCS_CAL_ARGS: args.map(quoteWin).join(' ') },
      cwd,
    );
    const match = /cpuMs=([\d.]+)/.exec(out.stdout);
    return match === null ? null : Number(match[1]);
  }
  if (platform === 'linux') {
    const out = await capture(
      '/bin/sh',
      ['-c', '"$@" >/dev/null 2>&1; cat /proc/$$/stat', 'sh', file, ...args],
      env,
      cwd,
    );
    const rest = out.stdout.slice(out.stdout.lastIndexOf(')') + 2).split(' ');
    const cutime = Number(rest[13]);
    const cstime = Number(rest[14]);
    if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) return null;
    return ((cutime + cstime) * 1000) / clockTicks;
  }
  if (platform === 'darwin') {
    const out = await capture('/usr/bin/time', ['-p', file, ...args], env, cwd);
    const user = /user\s+([\d.]+)/.exec(out.stderr);
    const sys = /sys\s+([\d.]+)/.exec(out.stderr);
    return user === null || sys === null ? null : (Number(user[1]) + Number(sys[1])) * 1000;
  }
  return null;
}

const root = mkdtempSync(join(tmpdir(), 'mcs-bench-cal-'));
const env = {
  PATH: process.env.PATH ?? '',
  ...(platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '', ComSpec: process.env.ComSpec ?? '' } : {}),
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  MCS_HOME: join(root, 'mcs'),
  CLAUDE_CONFIG_DIR: join(root, 'claude'),
  MCS_HOOK_DISABLE: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: root,
};
for (const dir of [env.HOME, env.MCS_HOME, env.CLAUDE_CONFIG_DIR]) mkdirSync(dir, { recursive: true });
writeFileSync(env.GIT_CONFIG_GLOBAL, '');

/** A held child (a sleeping Node) for the kinds that act on another process; `prepare` makes one per run. */
function holdChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  return { pid: child.pid, kill: () => child.kill() };
}

/** The measurable kinds of this OS: `{ command, file, args(): { args, cleanup? } }` (a description of the command, no paths). */
function plan() {
  const kinds = {};
  const repo = join(root, 'repo');
  const probeFile = join(root, 'acl-probe.txt');
  mkdirSync(repo, { recursive: true });
  writeFileSync(probeFile, 'FIXTURE\n');
  const git = whichSync('git');
  if (git !== null) {
    const init = spawnSync(git, ['init', '-q', repo], { env, encoding: 'utf8', windowsHide: true });
    if (init.status === 0) {
      kinds.git = {
        command: 'git status --porcelain=v2 --branch',
        file: git,
        cwd: repo,
        args: () => ({ args: ['status', '--porcelain=v2', '--branch'] }),
      };
    }
  }
  kinds.node = { command: 'node -e 0', file: process.execPath, cwd: root, args: () => ({ args: ['-e', '0'] }) };
  if (platform === 'win32') {
    const shell = whichSync('powershell.exe');
    if (shell !== null) {
      kinds['powershell.processes'] = {
        command: 'powershell -EncodedCommand <process list script>',
        file: shell,
        cwd: root,
        args: () => ({ args: encoded(PROC_SCRIPT_NET) }),
      };
      kinds['powershell.cmdline'] = {
        command: 'powershell -EncodedCommand <command line of one process>',
        file: shell,
        cwd: root,
        args: () => ({ args: encoded(cmdlineScript(process.pid)) }),
      };
    }
    const taskkill = whichSync('taskkill.exe');
    if (taskkill !== null) {
      kinds.taskkill = {
        command: 'taskkill /PID <held child> /F',
        file: taskkill,
        cwd: root,
        args: () => {
          const held = holdChild();
          return { args: ['/PID', String(held.pid), '/F'], cleanup: held.kill };
        },
      };
    }
    const icacls = whichSync('icacls.exe');
    if (icacls !== null) {
      kinds.icacls = { command: 'icacls <temp file>', file: icacls, cwd: root, args: () => ({ args: [probeFile] }) };
    }
  } else {
    const ps = whichSync('ps');
    if (ps !== null) {
      kinds.ps = {
        command: 'ps -A -o comm=,rss=',
        file: ps,
        cwd: root,
        args: () => ({ args: ['-A', '-o', 'comm=,rss='] }),
      };
    }
  }
  if (values.docker === true) {
    const docker = whichSync('docker');
    if (docker !== null) {
      kinds.docker = {
        command: 'docker ps --format <names and status>',
        file: docker,
        cwd: root,
        args: () => ({ args: ['ps', '--format', '{{.Names}} ({{.Status}})'] }),
      };
    }
  }
  return kinds;
}

const NOT_APPLICABLE = {
  'powershell.processes': 'Windows only',
  'powershell.cmdline': 'Windows only',
  taskkill: 'Windows only',
  icacls: 'Windows only',
  ps: 'POSIX only',
};
const KIND_ORDER = [
  'powershell.processes',
  'powershell.cmdline',
  'git',
  'docker',
  'ps',
  'taskkill',
  'node',
  'icacls',
  'opener',
];

async function calibrate(spec) {
  const wall = [];
  const cpu = [];
  let cpuFailed = false;
  for (let i = 0; i < runs; i += 1) {
    const first = spec.args();
    const timed = await timedRun(spec.file, first.args, env, spec.cwd);
    first.cleanup?.();
    wall.push(timed.wallMs);
    const second = spec.args();
    const figure = await cpuRun(spec.file, second.args, env, spec.cwd);
    second.cleanup?.();
    if (figure === null) cpuFailed = true;
    else cpu.push(figure);
  }
  const measured = !cpuFailed && cpu.length === runs;
  return {
    status: 'measured',
    command: spec.command,
    runs,
    wallMsMedian: round(median(wall), 1),
    wallMsMax: round(maximum(wall), 1),
    cpuMsMedian: measured ? round(median(cpu), 1) : null,
    cpuMsMax: measured ? round(maximum(cpu), 1) : null,
    cpuNote: measured
      ? platform === 'linux' || platform === 'darwin'
        ? 'clock-tick resolution of 10 ms'
        : null
      : `child CPU cannot be measured on ${platform} without a privileged tool: NOT MEASURED`,
  };
}

const kinds = {};
try {
  const measurable = plan();
  for (const kind of KIND_ORDER) {
    if (measurable[kind] !== undefined) {
      process.stderr.write(`calibrate-children: ${kind}\n`);
      kinds[kind] = await calibrate(measurable[kind]);
    } else if (kind === 'opener') {
      kinds[kind] = {
        status: 'NOT MEASURED',
        reason: 'the opener starts a window or an application; it is never run by a benchmark',
        cpuMsMedian: null,
        cpuMsMax: null,
      };
    } else if (kind === 'docker') {
      kinds[kind] = {
        status: 'NOT MEASURED',
        reason:
          values.docker === true
            ? 'the docker command was not found'
            : 'skipped: pass --docker to list containers (read only)',
        cpuMsMedian: null,
        cpuMsMax: null,
      };
    } else if (
      NOT_APPLICABLE[kind] !== undefined &&
      (NOT_APPLICABLE[kind] === 'Windows only') !== (platform === 'win32')
    ) {
      kinds[kind] = {
        status: 'not applicable',
        reason: `${NOT_APPLICABLE[kind]} (this host is ${platform})`,
        cpuMsMedian: null,
        cpuMsMax: null,
      };
    } else {
      kinds[kind] = {
        status: 'NOT MEASURED',
        reason: 'the program was not found on this host',
        cpuMsMedian: null,
        cpuMsMax: null,
      };
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

const samplerKind = platform === 'win32' ? 'powershell.processes' : platform === 'darwin' ? 'ps' : null;
const samplerCpu = samplerKind === null ? null : (kinds[samplerKind]?.cpuMsMax ?? null);
const b7Cpu =
  samplerKind === null
    ? {
        id: 'B7',
        status: 'NOT MEASURED',
        checks: [],
        note: 'this host has no per-process sampler child; the CPU part of B7 does not apply',
      }
    : judge(
        'B7',
        [check(`child CPU per ${samplerKind} sample (worst run)`, samplerCpu, LIMITS.B7.childCpuMs, 'ms')],
        'CPU part only; the spawn part is evaluated by bench-idle.mjs',
      );
const doc = {
  schema: 'mcs.bench/1',
  bench: 'calibrate-children',
  at: new Date().toISOString(),
  host: { platform, arch: process.arch, node: process.versions.node, cpus: cpus().length, loadAverage: loadavg() },
  options: { runs, docker: values.docker === true },
  kinds,
  b7Cpu,
};
const file = writeResult('calibration', doc);
for (const [kind, entry] of Object.entries(kinds)) {
  const line =
    entry.status === 'measured'
      ? `wall ${String(entry.wallMsMedian)} ms median, cpu ${entry.cpuMsMedian === null ? 'NOT MEASURED' : `${String(entry.cpuMsMedian)} ms median`}`
      : `${entry.status}: ${entry.reason}`;
  process.stderr.write(`${kind}: ${line}\n`);
}
process.stderr.write(`B7 CPU part: ${b7Cpu.status}\nresult: ${file}\n`);
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
