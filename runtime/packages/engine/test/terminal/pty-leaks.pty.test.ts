// Many sessions at once, and what is left when they end (CAW-56; design 08 section 3.4, id TC-PTY-10): eight concurrent sessions
// that never hear each other; after a kill no process of a session, no console host of it and no registry entry is left; after a
// session that exited by itself no process and no registry entry is left either, and what the host process keeps for it stays
// inside the bound that was measured (below). Windows only; a missing addon FAILS the run (`describePtyTests`).
//
// This suite goes over three live sessions, as the other real-terminal suites do not: TC-PTY-10 is the one that asks for eight (the
// default `terminal.maxSessions`), and the ninth is refused.
//
// Measured, and the reason for the two bounded checks: @lydell/node-pty 1.2.0-beta.18 does not release everything of a pseudo
// console whose child exited by itself. The inbox console host (`conhost.exe`) stays until the process that created it ends, a
// `PipeWrap` of the host stays for every session that ended (kill or exit), and a `MessagePort` of the output worker stays for
// every session that exited by itself. A bare node-pty shows the same (the console host and the pipe also stay after `kill()` and
// `destroy()` on the dead pty), so it is not the adapter. A kill of a live session releases the console host and the worker. The
// checks below are the upper bound of that behaviour (one of each per session): a second handle per session, or a console host
// left by a kill, turns them red, and a package that fixes the leak passes them.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describePtyTests, waitFor } from '@mcs/testkit';
import { expect, it } from 'vitest';

import { REGISTRY_DIR } from '../../src/terminal/index.ts';
import { addedHosts, consoleHosts, waitUntilHostsGone, type ProcessRow } from './process-tree.ts';
import {
  PER_TEST_TIMEOUT_MS,
  exitWaitMs,
  outputWaitMs,
  sameFolder,
  useRealHarnesses,
  type RealHarness,
} from './real-harness.ts';

const EIGHT = 8;

function registryFiles(h: RealHarness): string[] {
  const dir = path.join(h.mcsHome, REGISTRY_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

async function expectRegistryEmpty(h: RealHarness): Promise<void> {
  await waitFor(() => registryFiles(h).length === 0, {
    timeoutMs: outputWaitMs(),
    intervalMs: 100,
    what: 'the registry file to be removed',
  });
}

/** Waits until no more than `allowed` console hosts are left beyond the baseline (the known leak of a session that exited by itself). */
async function expectHostsWithin(baseline: readonly ProcessRow[], allowed: number): Promise<void> {
  await waitFor(async () => addedHosts(baseline, await consoleHosts()).length <= allowed, {
    timeoutMs: exitWaitMs(),
    intervalMs: 300,
    what: `at most ${String(allowed)} console host(s) to be left beyond the baseline`,
  });
}

/** The two kinds of handle that @lydell/node-pty leaves with the host for an ended pseudo console. */
function leakedHandles(): { pipes: number; ports: number } {
  const counts = new Map<string, number>();
  for (const name of process.getActiveResourcesInfo()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return { pipes: counts.get('PipeWrap') ?? 0, ports: counts.get('MessagePort') ?? 0 };
}

describePtyTests('pty leaks and crosstalk', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-10 eight concurrent sessions never hear each other, the ninth is refused, and killing all leaves no process or console host',
    async () => {
      const h = start({ route: 'direct' });
      const baseline = await consoleHosts();
      const sessions = await Promise.all(
        Array.from({ length: EIGHT }, (_unused, index) => h.open({ folder: h.projectDir(`leak-${String(index)}`) })),
      );
      expect(sessions).toHaveLength(EIGHT);
      expect(new Set(sessions.map((s) => s.name)).size).toBe(EIGHT);
      expect(new Set(sessions.map((s) => s.fakePid)).size).toBe(EIGHT);
      expect(h.service.liveCount()).toBe(EIGHT);
      expect(h.service.list()).toHaveLength(EIGHT);
      await expect(h.service.create({ folder: h.projectDir('leak-extra') })).rejects.toMatchObject({
        code: 'SESSION_LIMIT',
      });

      // The detector sees them: one console host per session, below this process.
      const live = addedHosts(baseline, await consoleHosts());
      expect(live).toHaveLength(EIGHT);

      // Three rounds of lines, typed into all eight in the same tick, each with its own token.
      const tokens = sessions.map((_unused, index) => `TOKEN-${String(index)}-${h.marker.slice(4, 12)}`);
      for (const round of [1, 2, 3]) {
        sessions.forEach((s, index) => {
          s.line(`${tokens[index] ?? ''} round${String(round)}`);
        });
        await Promise.all(sessions.map((s, index) => s.waitText(`ECHO:${tokens[index] ?? ''} round${String(round)}`)));
      }
      const folders = await Promise.all(sessions.map((s) => s.ask('/cwd', 'CWD:')));
      sessions.forEach((s, index) => {
        const text = s.output.text();
        const own = tokens[index] ?? '';
        expect(text.split(`ECHO:${own} round`).length - 1, `${s.name} answers to its own token three times`).toBe(3);
        for (const [other, token] of tokens.entries()) {
          if (other !== index) expect(text, `${s.name} heard ${token}`).not.toContain(token);
        }
        expect(sameFolder(folders[index] ?? '', s.folder), `${s.name} reports its own folder`).toBe(true);
      });

      // Kill all, in parallel: every session ends as killed, every process of the eight is gone, and so are their console hosts.
      const pids = sessions.flatMap((s) => [s.pid, s.fakePid]);
      await h.service.killAll();
      await Promise.all(sessions.map((s) => s.waitEnd()));
      for (const s of sessions) expect(s.endedView()?.end.reason).toBe('killed');
      await h.waitGone(pids, 'every process of the eight sessions to end');
      await waitUntilHostsGone(baseline, live, exitWaitMs());
      expect(h.service.liveCount()).toBe(0);
      expect(h.service.list()).toEqual([]);
      await expectRegistryEmpty(h);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-10 three shim sessions with grandchildren, killed, leave no process, console host or registry entry',
    async () => {
      const h = start({ route: 'shim' });
      const baseline = await consoleHosts();
      const sessions = await Promise.all(
        [0, 1, 2].map((index) => h.open({ folder: h.projectDir(`cycle-${String(index)}`) })),
      );
      // A grandchild each: the tree is cmd.exe, the fake claude and a Node child, below one console host per session.
      const children = await Promise.all(sessions.map((s) => s.ask('/spawn', 'CHILD:')));
      const pids = [...sessions.flatMap((s) => [s.pid, s.fakePid]), ...children.map(Number)];
      expect(new Set(pids).size).toBe(9);
      const live = addedHosts(baseline, await consoleHosts());
      expect(live).toHaveLength(3);

      await h.service.killAll();
      const ends = await Promise.all(sessions.map((s) => s.waitEnd()));
      expect(ends.map((exit) => exit.reason)).toEqual(['killed', 'killed', 'killed']);
      await h.waitGone(pids, 'the roots, the fake claudes and the grandchildren to end');
      await waitUntilHostsGone(baseline, live, exitWaitMs());
      expect(h.service.liveCount()).toBe(0);
      expect(h.service.list()).toEqual([]);
      await expectRegistryEmpty(h);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-10 three shim sessions with grandchildren that exit by themselves leave no process or registry entry, and at most one console host each',
    async () => {
      const h = start({ route: 'shim' });
      const baseline = await consoleHosts();
      const sessions = await Promise.all(
        [0, 1, 2].map((index) => h.open({ folder: h.projectDir(`exits-${String(index)}`) })),
      );
      const children = await Promise.all(sessions.map((s) => s.ask('/spawn', 'CHILD:')));
      const pids = [...sessions.flatMap((s) => [s.pid, s.fakePid]), ...children.map(Number)];
      expect(new Set(pids).size).toBe(9);
      expect(addedHosts(baseline, await consoleHosts())).toHaveLength(3);

      for (const s of sessions) s.line('/exit');
      const ends = await Promise.all(sessions.map((s) => s.waitEnd()));
      expect(ends).toEqual([
        { code: 0, reason: 'exited' },
        { code: 0, reason: 'exited' },
        { code: 0, reason: 'exited' },
      ]);
      // Nothing of the program runs on: the console closing took the grandchild with it.
      await h.waitGone(pids, 'the roots, the fake claudes and the grandchildren to end');
      expect(h.service.liveCount()).toBe(0);
      expect(h.service.list()).toEqual([]);
      await expectRegistryEmpty(h);
      await expectHostsWithin(baseline, sessions.length);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-10 the handles the host keeps for an ended session stay inside what was measured: a pipe each, and a message port for a session that exited by itself',
    async () => {
      const h = start({ route: 'direct' });
      const baseline = await consoleHosts();
      const before = leakedHandles();
      const sessions = await Promise.all(
        [0, 1, 2, 3].map((index) => h.open({ folder: h.projectDir(`handles-${String(index)}`) })),
      );
      const [first, second, third, fourth] = sessions;
      if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
        throw new Error('the four sessions did not open');
      }
      const live = addedHosts(baseline, await consoleHosts());
      expect(live).toHaveLength(sessions.length);

      first.line('/exit');
      second.line('/exit');
      const exited = await Promise.all([first.waitEnd(), second.waitEnd()]);
      expect(exited.map((exit) => exit.reason)).toEqual(['exited', 'exited']);
      await Promise.all([h.service.kill(third.name), h.service.kill(fourth.name)]);
      await h.waitGone(
        sessions.map((s) => s.pid),
        'the four sessions to end',
      );

      // The two that were killed give their console host back; the two that exited may keep theirs (the known leak).
      await expectHostsWithin(baseline, exited.length);
      await waitFor(
        () => {
          const now = leakedHandles();
          return now.pipes - before.pipes <= sessions.length && now.ports - before.ports <= exited.length;
        },
        {
          timeoutMs: outputWaitMs(),
          intervalMs: 200,
          what: 'the handles of the ended sessions to stay inside the bound',
        },
      );
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
