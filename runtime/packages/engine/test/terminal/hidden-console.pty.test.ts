// A terminal host that is detached and hidden, as `start` starts the server, must not make a console window of its own while it
// starts, runs and kills pseudo consoles (CAW-55; design 01 section 8, id TC-PTY-08: kill() forks a console list agent, a short
// Node child). This is the terminal's counterpart of `test/platform/hidden-console.int.test.ts`: the same detector and the same
// positive control. The detector reads `MainWindowHandle` of every descendant of the host; it never compiles anything (no
// `Add-Type`, no C#: the rule of the owner, enforced by `tests/tooling/no-csharp.test.ts`).
//
// The host is `support/terminal-host.mjs`: the production TerminalService over the real backend in a process of its own. Windows only.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describePtyTests, waitFor } from '@mcs/testkit';
import { expect, it } from 'vitest';

import { execFileText, powershellEncodedArgs, resolveExecutable, spawnDetached } from '../../src/platform/exec.ts';
import { commandLineOf, forceKillTree, listDescendantPids, pidAlive } from '../../src/platform/process.ts';
import {
  ENGINE_TERMINAL_URL,
  GRANDCHILD_COMMAND_LINE_PART,
  PER_TEST_TIMEOUT_MS,
  SOURCE_NODE_FLAGS,
  exitWaitMs,
  outputWaitMs,
  supportScript,
  useRealHarnesses,
} from './real-harness.ts';

interface Row {
  pid: number;
  name: string;
  handle: number;
}

interface HostSession {
  name: string;
  pid: number;
  fakePid: number;
  childPid: number;
}

interface HostReady {
  hostPid: number;
  sessions: HostSession[];
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isHostReady(value: unknown): value is HostReady {
  if (typeof value !== 'object' || value === null) return false;
  const hostPid: unknown = Reflect.get(value, 'hostPid');
  const sessions: unknown = Reflect.get(value, 'sessions');
  if (!isNumber(hostPid) || !Array.isArray(sessions)) return false;
  const list: unknown[] = sessions;
  return list.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof Reflect.get(item, 'name') === 'string' &&
      isNumber(Reflect.get(item, 'pid')) &&
      isNumber(Reflect.get(item, 'fakePid')) &&
      isNumber(Reflect.get(item, 'childPid')),
  );
}

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

async function powershell(script: string, timeoutMs: number): Promise<string> {
  const file = await resolveExecutable('powershell');
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file: file ?? '',
    args: powershellEncodedArgs(script),
    timeoutMs,
    maxOutputBytes: 65_536,
    encoding: 'utf8',
  });
  if (!result.ok) throw new Error(`the window query failed: ${result.error ?? 'unknown'}`);
  return result.stdout;
}

/** The window handle of each live process of `pids`: one constant script, the pids are integers, `MainWindowHandle` only. */
async function windowHandles(pids: readonly number[]): Promise<Row[]> {
  const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (list.length === 0) return [];
  const script =
    `$ErrorActionPreference='SilentlyContinue'; foreach ($id in @(${list.join(',')})) { ` +
    `$p = Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
    `if ($p) { '' + $p.Id + ',' + $p.ProcessName + ',' + [int64]$p.MainWindowHandle } }`;
  const out = await powershell(script, 30_000);
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [pid, name, handle] = line.split(',');
      return { pid: Number(pid), name: name ?? '', handle: Number(handle) };
    });
}

/** Every descendant of the host (the console hosts, `cmd.exe`, the fake claude, its child, the console list agent) with its handle. */
async function descendantWindows(hostPid: number): Promise<Row[]> {
  const pids = await listDescendantPids(hostPid);
  if (pids === null) throw new Error('the process listing failed');
  return windowHandles(pids);
}

/** Starts a console program the visible way (a minimized window) and reads its window handle: the detector must see it. */
async function positiveControl(): Promise<{ pid: number; handle: number }> {
  const script =
    `$ErrorActionPreference='Stop'; ` +
    `$p = Start-Process -FilePath ping.exe -ArgumentList '-n','6','127.0.0.1' -WindowStyle Minimized -PassThru; ` +
    `$h = 0; for ($i = 0; $i -lt 25 -and $h -eq 0; $i++) { Start-Sleep -Milliseconds 200; $p.Refresh(); $h = [int64]$p.MainWindowHandle }; ` +
    `'' + $p.Id + ',' + $h`;
  const [pid, handle] = (await powershell(script, 30_000)).trim().split(',');
  return { pid: Number(pid), handle: Number(handle) };
}

describePtyTests('hidden console of a detached terminal host', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-08 the children of a detached, hidden host that starts and kills pseudo consoles have no window, and the detector sees a visible one',
    async () => {
      const h = start({ route: 'shim' });
      const control = path.join(h.root, 'control');
      mkdirSync(control);
      writeFileSync(
        path.join(control, 'config.json'),
        JSON.stringify({
          config: h.config,
          mcsHome: h.mcsHome,
          folder: h.projectDir(),
          sessions: 2,
          spawnChild: true,
        }),
      );

      // The host is started the way `start` starts the server: spawnDetached, hidden, with log descriptors and no stdin.
      const outFd = openSync(path.join(h.root, 'host.out.log'), 'a');
      const errFd = openSync(path.join(h.root, 'host.err.log'), 'a');
      const host = spawnDetached(
        process.execPath,
        [...SOURCE_NODE_FLAGS, supportScript('terminal-host.mjs'), ENGINE_TERMINAL_URL, control],
        { cwd: h.root, env: h.env, stdoutFd: outFd, stderrFd: errFd },
      );
      host.on('error', () => undefined);
      closeSync(outFd);
      closeSync(errFd);
      const hostPid = host.pid;
      expect(hostPid).toBeDefined();
      if (hostPid === undefined) return;
      h.track(hostPid);

      try {
        const ready = await waitFor(
          () => {
            const failure = readJson(path.join(control, 'error.json'));
            if (failure !== null) throw new Error(`the terminal host failed: ${JSON.stringify(failure)}`);
            const value = readJson(path.join(control, 'ready.json'));
            return isHostReady(value) ? value : null;
          },
          { timeoutMs: outputWaitMs() * 2, intervalMs: 100, what: 'the terminal host to report its sessions' },
        );
        expect(ready.hostPid).toBe(hostPid);
        expect(ready.sessions).toHaveLength(2);
        const recorded = ready.sessions.flatMap((s) => [s.pid, s.fakePid, s.childPid]);
        for (const s of ready.sessions) {
          h.track(s.pid);
          h.track(s.fakePid);
          h.track(s.childPid, GRANDCHILD_COMMAND_LINE_PART);
        }

        // The positive control comes first: a detector that cannot see a window proves nothing about the rest.
        const visible = await positiveControl();
        try {
          expect(visible.pid).toBeGreaterThan(0);
          expect(
            visible.handle,
            'the positive control shows no window: the detector cannot be trusted',
          ).toBeGreaterThan(0);
        } finally {
          const line = await commandLineOf(visible.pid);
          if (pidAlive(visible.pid) && line?.includes('127.0.0.1') === true) await forceKillTree(visible.pid);
        }

        // The host itself and everything below it, with the sessions alive.
        const samples: Row[][] = [await descendantWindows(hostPid), await windowHandles([hostPid])];
        const first = samples[0] ?? [];
        const names = first.map((row) => row.name.toLowerCase());
        // The sample holds what a pseudo console makes: the console host, cmd.exe of the shim, the fake claude and its child.
        expect(names).toEqual(expect.arrayContaining(['conhost', 'cmd', 'node']));
        expect(first.map((row) => row.pid)).toEqual(expect.arrayContaining(recorded));

        // Now the host kills a session (it forks the console list agent) while the descendants are looked at again and again.
        const killed = path.join(control, 'killed.json');
        writeFileSync(path.join(control, 'kill'), ready.sessions[0]?.name ?? '');
        await waitFor(
          async () => {
            samples.push(await descendantWindows(hostPid));
            return existsSync(killed);
          },
          { timeoutMs: exitWaitMs(), intervalMs: 1, what: 'the host to kill the session' },
        );
        expect(readJson(killed)).toMatchObject({ name: ready.sessions[0]?.name, reason: 'killed' });
        samples.push(await descendantWindows(hostPid));

        for (const row of samples.flat()) {
          expect(row.handle, `${row.name} (${String(row.pid)}) has a window`).toBe(0);
        }

        // The host stops the way the server does: shutdown of the service, then exit.
        writeFileSync(path.join(control, 'stop'), '');
        await waitFor(() => existsSync(path.join(control, 'stopped.json')), {
          timeoutMs: exitWaitMs(),
          intervalMs: 100,
          what: 'the host to stop',
        });
        await h.waitGone([hostPid, ...recorded], 'the host and every process of its sessions to end');
      } finally {
        if (await h.stillRuns(hostPid)) await forceKillTree(hostPid);
      }
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
