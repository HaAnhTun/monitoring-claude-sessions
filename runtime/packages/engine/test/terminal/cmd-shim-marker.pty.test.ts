// The `.cmd` shim route against cmd.exe (CAW-55; design 01 D7 and amendment A1, design 08 section 3.4, id TC-PTY-06). cmd.exe parses
// its command line again, so the service lets only a short list of characters through to it and starts the child with
// `NoDefaultCurrentDirectoryInExePath=1`. Every case here ends with a file system fact: a marker file that a hostile argument, a
// hostile folder name or a planted `node.cmd` would create if cmd.exe ever ran it. Each case carries a POSITIVE CONTROL: the same
// text, run the way a naive launcher would run it, does create the marker, so an absent marker means something.
// Windows only; a missing addon FAILS the run.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describePtyTests } from '@mcs/testkit';
import { expect, it } from 'vitest';

import { E_ACUTE, PER_TEST_TIMEOUT_MS, exitWaitMs, useRealHarnesses, type RealHarness } from './real-harness.ts';

/** Arguments that cmd.exe would read as commands, redirections, expansions or line breaks; `MARKER` is replaced by the path of the marker file. */
const HOSTILE_ARGS: readonly string[] = [
  'x & echo pwned > MARKER',
  'x && echo pwned > MARKER',
  'x | echo pwned > MARKER',
  'x > MARKER',
  'x < nul & echo pwned > MARKER',
  '(echo pwned > MARKER)',
  'x" & echo pwned > "MARKER',
  'x ^& y',
  '%COMSPEC%',
  '!COMSPEC!',
  'line one\nline two',
  'x; y',
];

/** What a naive launcher would do: hand `cmd.exe /d /s /c` the text, unchanged and unquoted. Returns once cmd.exe has ended. */
function runNaively(line: string, cwd: string, env: Record<string, string>): void {
  spawnSync('cmd.exe', ['/d', '/s', '/c', line], {
    cwd,
    env,
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: 'ignore',
    timeout: exitWaitMs(),
  });
}

/** A shim that calls a bare `node`, as the npm shim of the real claude does when the program is not next to it. */
const BARE_NODE_SHIM = '@ECHO off\r\nnode "%~dp0fake-claude.mjs" %*\r\n';

function shimLine(h: RealHarness, args: string): string {
  return `""${h.install.shim}" ${args}"`;
}

describePtyTests('cmd.exe shim route and metacharacters', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-06 a hostile argument or resume id is refused before any process starts, and no marker file appears',
    async () => {
      const h = start({ route: 'shim' });
      const folder = h.projectDir();
      const marker = path.join(folder, 'pwned.txt');

      // Positive control: the text of the first case, run through cmd.exe the naive way, writes the marker.
      runNaively(shimLine(h, `x & echo pwned > "${marker}"`), folder, h.env);
      expect(existsSync(marker), 'the control did not write the marker: the detector cannot be trusted').toBe(true);
      rmSync(marker);

      for (const template of HOSTILE_ARGS) {
        h.config.args = [template.replaceAll('MARKER', marker)];
        await expect(h.service.create({ folder }), template).rejects.toMatchObject({ code: 'ARGS_UNSAFE' });
        expect(existsSync(marker), `marker after ${JSON.stringify(template)}`).toBe(false);
      }

      // The resume id is the other way an argument arrives (the client sends only an id, which must look like one).
      h.config.args = [];
      for (const resume of ['x & echo pwned > MARKER', '../x', 'abc', 'a b c d e f g h', 'id"x', 'id\nx']) {
        await expect(
          h.service.create({ folder, resume: resume.replaceAll('MARKER', marker) }),
          resume,
        ).rejects.toMatchObject({ code: 'ARGS_UNSAFE' });
      }
      expect(existsSync(marker)).toBe(false);
      expect(h.service.list()).toEqual([]);
      expect(h.service.liveCount()).toBe(0);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-06 arguments inside the allowed set (spaces, backslashes, letters outside ASCII, = : , + @) reach the child exactly',
    async () => {
      const safe = [
        '--model',
        'two words',
        'C:\\Program Files\\x y\\z',
        'C:\\x y\\',
        `--tag=caf${E_ACUTE}`,
        'a,b:c=d+e@f',
        '/slash/path',
        ' padded ',
        '-',
      ];
      const h = start({ route: 'shim', config: { args: safe } });
      const s = await h.open({ cols: 300 });
      const args: unknown = JSON.parse(await s.ask('/args', 'ARGS:'));
      expect(args).toEqual(safe);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-06 a node.cmd planted in the project folder never runs when the shim calls a bare node',
    async () => {
      const h = start({
        route: 'shim',
        afterInstall: ({ install }) => {
          writeFileSync(install.shim, BARE_NODE_SHIM);
        },
      });
      const folder = h.projectDir('planted');
      const ran = path.join(h.root, 'planted-ran.txt');
      writeFileSync(path.join(folder, 'node.cmd'), `@ECHO off\r\necho planted> "${ran}"\r\n`);

      // Positive control: cmd.exe, without NoDefaultCurrentDirectoryInExePath, looks in the current folder first and runs the plant.
      expect(h.env['NoDefaultCurrentDirectoryInExePath']).toBeUndefined();
      runNaively('node --version', folder, h.env);
      expect(existsSync(ran), 'the control did not run the planted node.cmd: the detector cannot be trusted').toBe(
        true,
      );
      rmSync(ran);

      // The service starts the shim in that folder: the READY line proves the REAL node ran the fake claude, not the plant.
      const s = await h.open({ folder });
      expect(await s.ask('after the shim called node', 'ECHO:')).toBe('after the shim called node');
      expect(await s.ask('/envnames NoDefault', 'ENVNAMES:')).toBe('NoDefault:NoDefaultCurrentDirectoryInExePath');
      expect(existsSync(ran)).toBe(false);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-06 a shim folder whose name holds command separators and cmd.exe characters runs nothing but the shim',
    async () => {
      // `md pwned` between `&` separators: cmd.exe would make a folder `pwned` in the current folder if it parsed the name.
      const h = start({ route: 'shim', binDirName: 'a & md pwned & b (c) ^d !e!' });
      const folder = h.projectDir('separators');
      const made = path.join(folder, 'pwned');

      runNaively('echo control & md pwned', folder, h.env);
      expect(existsSync(made), 'the control did not make the folder: the detector cannot be trusted').toBe(true);
      rmSync(made, { recursive: true });

      const s = await h.open({ folder });
      expect(await s.ask('through the odd folder', 'ECHO:')).toBe('through the odd folder');
      expect(existsSync(made)).toBe(false);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-06 a shim path with a percent sign is refused, because %VAR% expands even inside quotes',
    async () => {
      const h = start({ route: 'shim', binDirName: 'x%COMSPEC%y' });
      await expect(h.service.create({ folder: h.projectDir() })).rejects.toMatchObject({ code: 'COMMAND_UNSUPPORTED' });
      expect(h.service.list()).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
