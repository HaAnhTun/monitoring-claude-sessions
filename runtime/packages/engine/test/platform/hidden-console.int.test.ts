// Port of hidden-console.mjs (06 4.7, E9): a detached, hidden Node process that spawns console programs through
// execFileText must not produce visible console windows. The detector is proven in the same run by a positive control:
// a console program that is started visible (minimized) must show a window handle, otherwise the test fails.
// The stand-in imports the built `dist/platform/exec.js`, so the integration gate builds the runtime first.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { execFileText, powershellEncodedArgs, resolveExecutable } from '../../src/platform/exec.ts';
import { forceKill, pidAlive, waitForExit } from '../../src/platform/process.ts';
import { spawnDetached } from '../../src/platform/exec.ts';

const isWin = process.platform === 'win32';
const runtimeDir = fileURLToPath(new URL('../../../../', import.meta.url));
const distExec = path.join(runtimeDir, 'packages', 'engine', 'dist', 'platform', 'exec.js');
const makeTemp = useTempDirs();
const toKill: number[] = [];

afterEach(async () => {
  for (const pid of toKill.splice(0)) {
    if (pidAlive(pid)) {
      await forceKill(pid);
      await waitForExit(pid, 5000);
    }
  }
});

/** The server stand-in: starts two long console children through execFileText, then reports and waits for them. */
const STAND_IN = `
import { writeFileSync } from 'node:fs';
const [, , execUrl, readyFile, doneFile] = process.argv;
const { execFileText, powershellEncodedArgs, resolveExecutable } = await import(execUrl);
const powershell = await resolveExecutable('powershell');
const common = { timeoutMs: 30000, maxOutputBytes: 65536, encoding: 'utf8' };
const calls = [
  execFileText({ ...common, kind: 'powershell.processes', file: powershell, args: powershellEncodedArgs('Start-Sleep -Seconds 7') }),
  execFileText({ ...common, kind: 'node', file: process.execPath, args: ['-e', 'setTimeout(() => {}, 7000)'] }),
];
writeFileSync(readyFile, String(process.pid));
const results = await Promise.all(calls);
writeFileSync(doneFile, JSON.stringify(results.map((r) => ({ ok: r.ok, error: r.error }))));
`;

interface Row {
  pid: number;
  name: string;
  handle: number;
}

/** Children of `parentPid` with their window handle, through one constant-shaped PowerShell script. */
async function childWindows(parentPid: number): Promise<Row[]> {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new RangeError('bad pid');
  const script =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${String(parentPid)}' | ForEach-Object { ` +
    `$p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; ` +
    `if ($p) { '' + $p.Id + ',' + $p.ProcessName + ',' + [int64]$p.MainWindowHandle } }`;
  const powershell = await resolveExecutable('powershell');
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file: powershell ?? '',
    args: powershellEncodedArgs(script),
    timeoutMs: 20_000,
    maxOutputBytes: 65_536,
    encoding: 'utf8',
  });
  if (!result.ok) throw new Error(`window query failed: ${result.error ?? 'unknown'}`);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [pid, name, handle] = line.split(',');
      return { pid: Number(pid), name: name ?? '', handle: Number(handle) };
    });
}

/** Starts a console program the visible way (minimized window) and reads its window handle. */
async function positiveControl(): Promise<{ pid: number; handle: number }> {
  const script =
    `$ErrorActionPreference='Stop'; ` +
    `$p = Start-Process -FilePath ping.exe -ArgumentList '-n','8','127.0.0.1' -WindowStyle Minimized -PassThru; ` +
    `$h = 0; for ($i = 0; $i -lt 25 -and $h -eq 0; $i++) { Start-Sleep -Milliseconds 200; $p.Refresh(); $h = [int64]$p.MainWindowHandle }; ` +
    `'' + $p.Id + ',' + $h`;
  const powershell = await resolveExecutable('powershell');
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file: powershell ?? '',
    args: powershellEncodedArgs(script),
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    encoding: 'utf8',
  });
  const [pid, handle] = result.stdout.trim().split(',');
  return { pid: Number(pid), handle: Number(handle) };
}

describe.runIf(isWin)('hidden console (Windows)', () => {
  it('children of a detached, hidden server have no console window, and the detector sees a visible one', async () => {
    if (!existsSync(distExec)) throw new Error(`${distExec} is missing: run the integration gate (it builds first)`);
    const dir = makeTemp('hidden-console').path;
    const logDir = path.join(dir, 'logs');
    mkdirSync(logDir);
    const standIn = path.join(dir, 'stand-in.mjs');
    writeFileSync(standIn, STAND_IN);
    const ready = path.join(dir, 'ready.txt');
    const done = path.join(dir, 'done.json');
    const outFd = openSync(path.join(logDir, 'boot.log'), 'a');
    const errFd = openSync(path.join(logDir, 'boot.err'), 'a');

    // The server is started the way `mcs start` starts it: spawnDetached with log descriptors (06 4.7).
    const env: Record<string, string> = {
      MCS_HOOK_DISABLE: '1',
      MCS_HOME: path.join(dir, 'home'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    };
    for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const server = spawnDetached(process.execPath, [standIn, pathToFileURL(distExec).href, ready, done], {
      cwd: dir,
      env,
      stdoutFd: outFd,
      stderrFd: errFd,
    });
    closeSync(outFd);
    closeSync(errFd);
    const serverPid = server.pid;
    expect(serverPid).toBeDefined();
    if (serverPid === undefined) return;
    toKill.push(serverPid);

    await waitFor(() => existsSync(ready) && readFileSync(ready, 'utf8') !== '', {
      timeoutMs: 30_000,
      what: 'the stand-in server',
    });

    const rows = await waitFor(
      async () => {
        const list = await childWindows(serverPid);
        const hasPowerShell = list.some((row) => row.name.toLowerCase() === 'powershell');
        const hasNode = list.some((row) => row.name.toLowerCase() === 'node');
        return hasPowerShell && hasNode ? list : null;
      },
      { timeoutMs: 30_000, intervalMs: 300, what: 'the two console children of the server' },
    );

    // Positive control in the same run: the detector must see a visible window for a visibly started console program.
    const control = await positiveControl();
    toKill.push(control.pid);
    expect(control.pid).toBeGreaterThan(0);
    expect(control.handle, 'the positive control shows no window: the detector cannot be trusted').toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.handle, `${row.name} (${String(row.pid)}) has a visible window`).toBe(0);
    }

    // The children finish on their own; the stand-in reports success and exits.
    await waitFor(() => existsSync(done) && readFileSync(done, 'utf8') !== '', {
      timeoutMs: 30_000,
      what: 'the stand-in to finish',
    });
    expect(JSON.parse(readFileSync(done, 'utf8'))).toEqual([
      { ok: true, error: null },
      { ok: true, error: null },
    ]);
    expect(await waitForExit(serverPid, 10_000)).toBe(true);
  }, 120_000);
});
