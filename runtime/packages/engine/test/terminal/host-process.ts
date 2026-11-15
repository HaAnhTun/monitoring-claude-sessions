// The terminal host of the real-process suites as a process of its own (CAW-56): `support/terminal-host.mjs` runs the production
// TerminalService over the real backend, started detached and hidden the way `start` starts the server. A suite that needs a host
// it can end by force (terminal-orphans) starts it here; the hidden-console suite of CAW-55 has its own copy of these steps.
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { waitFor } from '@mcs/testkit';
import { z } from 'zod';

import { spawnDetached } from '../../src/platform/exec.ts';
import {
  ENGINE_TERMINAL_URL,
  GRANDCHILD_COMMAND_LINE_PART,
  SOURCE_NODE_FLAGS,
  outputWaitMs,
  supportScript,
  type RealHarness,
} from './real-harness.ts';

const Pid = z.number().int().positive();

/** What the host writes to `ready.json` once every session shows READY (and CHILD with `spawnChild`). */
const HostReadySchema = z.object({
  hostPid: Pid,
  sessions: z.array(z.object({ name: z.string(), pid: Pid, fakePid: Pid, childPid: Pid.nullable() })),
});

export interface HostSession {
  readonly name: string;
  /** The root of the pseudo console: `cmd.exe` on the shim route, the fake claude on the direct route. */
  readonly pid: number;
  readonly fakePid: number;
  readonly childPid: number | null;
}

export interface StartedHost {
  readonly hostPid: number;
  /** The folder of the request files: `config.json`, `ready.json`, `kill`, `stop`, `killed.json`, `stopped.json`, `error.json`. */
  readonly control: string;
  readonly sessions: readonly HostSession[];
  /** Every pid of the sessions (roots, fake claudes, grandchildren), without the host. */
  readonly sessionPids: readonly number[];
}

export interface HostOptions {
  /** Sessions the host opens before it reports ready. */
  sessions: number;
  /** Each session starts a grandchild with `/spawn`. */
  spawnChild: boolean;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Starts the host with the configuration and the environment of the harness, waits until its sessions are up and records every
 * pid in the harness (so that `close()` ends what a failed test leaves). The host's own streams go to files below the temp root.
 */
export async function startTerminalHost(h: RealHarness, options: HostOptions): Promise<StartedHost> {
  const control = path.join(h.root, 'control');
  mkdirSync(control, { recursive: true });
  writeFileSync(
    path.join(control, 'config.json'),
    JSON.stringify({
      config: h.config,
      mcsHome: h.mcsHome,
      folder: h.projectDir(),
      sessions: options.sessions,
      spawnChild: options.spawnChild,
    }),
  );
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
  const { pid } = host;
  if (pid === undefined) throw new Error('startTerminalHost: the host process did not start');
  h.track(pid);

  const ready = await waitFor(
    () => {
      const failure = readJson(path.join(control, 'error.json'));
      if (failure !== null) throw new Error(`the terminal host failed: ${JSON.stringify(failure)}`);
      const parsed = HostReadySchema.safeParse(readJson(path.join(control, 'ready.json')));
      return parsed.success ? parsed.data : null;
    },
    { timeoutMs: outputWaitMs() * 2, intervalMs: 100, what: 'the terminal host to report its sessions' },
  );
  if (ready.hostPid !== pid) throw new Error('startTerminalHost: the host reports another pid than the one started');
  const sessionPids: number[] = [];
  for (const session of ready.sessions) {
    h.track(session.pid);
    h.track(session.fakePid);
    sessionPids.push(session.pid, session.fakePid);
    if (session.childPid !== null) {
      h.track(session.childPid, GRANDCHILD_COMMAND_LINE_PART);
      sessionPids.push(session.childPid);
    }
  }
  return { hostPid: pid, control, sessions: ready.sessions, sessionPids: [...new Set(sessionPids)] };
}
