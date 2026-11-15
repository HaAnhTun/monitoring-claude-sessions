// The two ConPTY flavours against the fake claude (CAW-56; design 01 section 1.2 and section 8, design 08 section 3.4, ids TC-PTY-02,
// TC-PTY-07, TC-PTY-08 and TC-PTY-15): the inbox console host (`terminal.conptyDll` false, the default) and the bundled
// `conpty.dll` with `OpenConsole.exe` (true), each on the direct route and on the `.cmd` shim route. The flavours must behave the
// same for the user (banner, input, colours, size, exit codes, the last words of a process that exits, a kill that ends the tree),
// and the test checks that each one really is the flavour it names by the console host that runs below this process: `conhost.exe`
// of Windows, or the `OpenConsole.exe` of the package, which must be the pinned file.
// OpenConsole mode stalls the child about 3 s until something answers its DA1 query (nobody does here): no assertion is made on a
// time, only on a budget. Windows only; a missing addon FAILS the run (`describePtyTests`).
import { readFileSync } from 'node:fs';

import { BRACKETED_PASTE_ON, FAKE_BANNER, describePtyTests, parseReady, scaled, waitFor } from '@mcs/testkit';
import { expect, it } from 'vitest';

import { HOST_TARGET, hostPin, installedConptyFile, samePath, sha256Of } from './native-files.ts';
import { addedHosts, consoleHosts, loadedModulePaths, waitUntilHostsGone } from './process-tree.ts';
import { PER_TEST_TIMEOUT_MS, exitWaitMs, outputWaitMs, useRealHarnesses, type RealSession } from './real-harness.ts';

const ESC = String.fromCharCode(0x1b);

const FLAVOURS = [
  { flavour: 'inbox', dll: false },
  { flavour: 'dll', dll: true },
] as const;

const CASES = (['direct', 'shim'] as const).flatMap((route) => FLAVOURS.map((entry) => ({ route, ...entry })));

/** The size the child reports, asked again until it is the wanted one (the resize is debounced and then sent to the console). */
async function waitForSize(session: RealSession, cols: number, rows: number): Promise<void> {
  await waitFor(
    async () => ((await session.ask('/size', 'SIZE:')) === `${String(cols)}x${String(rows)}` ? true : null),
    { timeoutMs: exitWaitMs(), intervalMs: 100, what: `the child to report ${String(cols)}x${String(rows)}` },
  );
}

/** Every colour sequence the fake prints for `/colors` that is missing from the raw bytes a viewer received. */
function missingColours(raw: string): string[] {
  const missing: string[] = [];
  for (let i = 0; i < 256; i += 1) if (!raw.includes(`${ESC}[38;5;${String(i)}m`)) missing.push(`256:${String(i)}`);
  for (let i = 0; i < 64; i += 1) {
    const triple = `${String(i * 4)};${String(255 - i * 4)};128`;
    if (!raw.includes(`${ESC}[38;2;${triple}m`)) missing.push(`rgb:${triple}`);
  }
  for (let i = 0; i < 16; i += 1) {
    if (!raw.includes(`${ESC}[${String(i < 8 ? 30 + i : 82 + i)}m`)) missing.push(`fg:${String(i)}`);
    if (!raw.includes(`${ESC}[${String(i < 8 ? 40 + i : 92 + i)}m`)) missing.push(`bg:${String(i)}`);
  }
  return missing;
}

describePtyTests('the two ConPTY flavours', () => {
  const start = useRealHarnesses();

  it.each(CASES)(
    'TC-PTY-02 the $route route with the $flavour console host: banner, READY, echo, colours byte for byte, resize, the process chain and the host',
    async ({ route, dll, flavour }) => {
      const h = start({ route, config: { conptyDll: dll } });
      expect(h.service.status()).toMatchObject({
        supported: true,
        conptyDll: dll,
        claude: { found: true, kind: route === 'shim' ? 'shim' : 'exe' },
      });
      const baseline = await consoleHosts();
      const s = await h.open();

      expect(parseReady(s.output.text())).toMatchObject({ pid: s.fakePid, cols: 120, rows: 30, args: [] });
      expect(s.output.text()).toContain(FAKE_BANNER);
      expect(s.output.raw().toString('latin1')).toContain(BRACKETED_PASTE_ON);
      expect(await s.ask('hello from the console host', 'ECHO:')).toBe('hello from the console host');
      s.line('/colors');
      await s.waitText('COLORS-DONE');
      expect(missingColours(s.output.raw().toString('latin1'))).toEqual([]);

      // A resize reaches the child in both flavours (in OpenConsole mode one sent while the child was stalled is in effect at once).
      s.session.resize(100, 40);
      await waitForSize(s, 100, 40);

      // The chain: cmd.exe and then the fake on the shim route, the fake alone on the direct one.
      const answer = /^(\d+) PPID:(\d+)$/.exec(await s.ask('/pid', 'PID:'));
      expect(Number(answer?.[1])).toBe(s.fakePid);
      if (route === 'shim') expect(Number(answer?.[2])).toBe(s.pid);
      else expect(s.fakePid).toBe(s.pid);

      // The console host: one per session, below this process, and it is the one the flavour names.
      const hosts = addedHosts(baseline, await consoleHosts());
      expect(hosts, flavour).toHaveLength(1);
      const [host] = hosts;
      if (dll) {
        expect(host?.name).toBe('OpenConsole.exe');
        expect(samePath(host?.path ?? '', installedConptyFile('OpenConsole.exe'))).toBe(true);
      } else {
        expect(host?.name.toLowerCase()).toBe('conhost.exe');
      }
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-02 the dll flavour runs the pinned OpenConsole.exe and loads the pinned conpty.dll, both from the package',
    async () => {
      const h = start({ route: 'direct', config: { conptyDll: true } });
      const baseline = await consoleHosts();
      const s = await h.open();
      const [host] = addedHosts(baseline, await consoleHosts());
      expect(host?.name).toBe('OpenConsole.exe');
      const opener = installedConptyFile('OpenConsole.exe');
      const library = installedConptyFile('conpty.dll');
      expect(samePath(host?.path ?? '', opener)).toBe(true);

      // The files of the package are the files of the pins (Microsoft's signed binaries, byte for byte) ...
      for (const [file, rel] of [
        [opener, 'conpty/OpenConsole.exe'],
        [library, 'conpty/conpty.dll'],
      ] as const) {
        const bytes = readFileSync(file);
        const pin = hostPin(rel);
        expect(bytes.length, rel).toBe(pin.bytes);
        expect(sha256Of(bytes), `${HOST_TARGET} ${rel}`).toBe(pin.sha256);
      }
      // ... and the library is the one that `conpty.node` loaded into this process.
      const loaded = await loadedModulePaths(process.pid, 'conpty.dll');
      expect(loaded.some((file) => samePath(file, library))).toBe(true);
      expect(await s.ask('still works', 'ECHO:')).toBe('still works');
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it.each(FLAVOURS)(
    'TC-PTY-15 start-up in the $flavour console host: the first byte and then the READY line arrive within the budget',
    async ({ dll }) => {
      const h = start({ route: 'direct', config: { conptyDll: dll } });
      const raw = h.rawSpawn();
      let received = Buffer.alloc(0);
      raw.pty.onData((chunk) => {
        received = Buffer.concat([received, chunk]);
      });
      // No assertion on how soon: OpenConsole mode holds the child for about 3 s, the inbox host about 60 ms. Only the budget.
      await waitFor(() => received.length > 0, {
        timeoutMs: scaled(20_000),
        intervalMs: 25,
        what: 'the first byte of the console',
      });
      await waitFor(() => /READY pid=\d+/.test(received.toString('latin1')), {
        timeoutMs: scaled(20_000),
        intervalMs: 50,
        what: 'the READY line of the fake claude',
      });
      // OpenConsole asks the terminal who it is (DA1, ESC [ c) before it lets the child run: that query is the reason the default
      // is the inbox host, and it is the proof that this really is the other host.
      if (dll) expect(received.toString('latin1')).toContain(`${ESC}[c`);
      raw.pty.kill();
      await raw.exited;
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it.each(FLAVOURS)(
    'TC-PTY-07 in the $flavour console host /exit ends the session with code 0 and /crash with code 3, each after its last words',
    async ({ dll }) => {
      const h = start({ route: 'direct', config: { conptyDll: dll } });
      const quiet = await h.open();
      quiet.line('/exit');
      expect(await quiet.waitEnd()).toEqual({ code: 0, reason: 'exited' });
      expect(quiet.endedView()?.text).toContain('BYE:0');

      const crashing = await h.open();
      crashing.line('/crash');
      expect(await crashing.waitEnd()).toEqual({ code: 3, reason: 'exited' });
      expect(crashing.endedView()?.text).toContain('CRASH');
      expect(h.service.liveCount()).toBe(0);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-07 with the bundled conpty.dll the final output of a process that exits in the same tick still arrives before the exit, six times',
    async () => {
      // OpenConsole reports the exit about 60 ms after the last output (the inbox host: a second): the order must hold anyway.
      const h = start({ route: 'direct', config: { conptyDll: true } });
      const failures: string[] = [];
      for (const round of [0, 1]) {
        const sessions: RealSession[] = [];
        for (let i = 0; i < 3; i += 1) sessions.push(await h.open());
        for (const s of sessions) s.line('/last-words');
        const exits = await Promise.all(sessions.map((s) => s.waitEnd()));
        sessions.forEach((s, i) => {
          const number = round * 3 + i + 1;
          const exit = exits[i];
          if (exit?.code !== 0 || exit.reason !== 'exited') {
            failures.push(`round ${String(number)}: ended with ${JSON.stringify(exit)}`);
          }
          if (!/LAST-WORDS:1(?!\d)/.test(s.endedView()?.text ?? '')) {
            failures.push(`round ${String(number)}: the last words had not arrived when the session ended`);
          }
        });
      }
      expect(failures).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it.each(FLAVOURS)(
    'TC-PTY-08 in the $flavour console host a kill ends the cmd.exe, the fake claude and its grandchild, and the console host goes with them',
    async ({ dll }) => {
      const h = start({ route: 'shim', config: { conptyDll: dll } });
      const baseline = await consoleHosts();
      const s = await h.open();
      const child = Number(await s.ask('/spawn', 'CHILD:'));
      const pids = [s.pid, s.fakePid, child];
      expect(new Set(pids).size).toBe(3);
      const hosts = addedHosts(baseline, await consoleHosts());
      expect(hosts).toHaveLength(1);

      expect(await h.service.kill(s.name)).toBe(true);
      await h.waitGone(pids, 'the root, the fake claude and its grandchild to end');
      await waitUntilHostsGone(baseline, hosts, exitWaitMs());
      expect(s.endedView()?.end.reason).toBe('killed');
      expect(h.service.liveCount()).toBe(0);

      // Shutdown with two live sessions in this flavour leaves nothing either.
      const a = await h.open();
      const b = await h.open();
      const more = [a.pid, a.fakePid, b.pid, b.fakePid];
      await h.service.shutdown();
      await h.waitGone(more, 'both sessions to end at shutdown');
      expect(a.endedView()?.end.reason).toBe('shutdown');
      expect(b.endedView()?.end.reason).toBe('shutdown');
      await waitUntilHostsGone(baseline, [], outputWaitMs() + exitWaitMs());
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
