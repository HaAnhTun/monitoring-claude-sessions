import { describe, expect, it } from 'vitest';

import { Prng } from '../../test/support/prng.ts';
import type { HostPlatform } from '../platform/host.ts';
import {
  buildLaunch,
  isCmdSafeArg,
  quoteWindowsArg,
  resolveClaudeCommand,
  type ClaudeLaunch,
  type CommandFs,
  type ResolvedCommand,
} from './command.ts';
import type { EnvSource } from './env.ts';
import { TERMINAL_ERROR_CODES, TerminalError, isTerminalError, type TerminalErrorCode } from './errors.ts';
import { RESUME_ID_RE } from './limits.ts';

// ---- fakes ------------------------------------------------------------------------------------------------------

const canon = (p: string): string => p.replace(/\//g, '\\').toLowerCase();

interface FakeFs extends CommandFs {
  readonly probed: string[];
}

/** A Windows file system: case-insensitive, `/` and `\` alike. Records every path asked about. */
function winFs(files: readonly string[]): FakeFs {
  const set = new Set(files.map(canon));
  const probed: string[] = [];
  return {
    probed,
    isFile: (p) => {
      probed.push(p);
      return set.has(canon(p));
    },
  };
}

/** A POSIX file system: exact names; `executable` lists the files with an execute bit (all of them when omitted). */
function posixFs(files: readonly string[], executable?: readonly string[]): FakeFs & Required<CommandFs> {
  const present = new Set(files);
  const exec = new Set(executable ?? files);
  const probed: string[] = [];
  return {
    probed,
    isFile: (p) => {
      probed.push(p);
      return present.has(p);
    },
    isExecutable: (p) => {
      probed.push(p);
      return present.has(p) && exec.has(p);
    },
  };
}

function resolveWin(
  files: readonly string[],
  pathValue: string | undefined,
  o: { command?: string; pathext?: string | undefined; env?: EnvSource } = {},
): ResolvedCommand | null {
  const env: Record<string, string | undefined> = { ...o.env };
  if (pathValue !== undefined) env['Path'] = pathValue;
  if (o.pathext !== undefined) env['PATHEXT'] = o.pathext;
  return resolveClaudeCommand({ command: o.command ?? 'claude', env, platform: 'win32', fs: winFs(files) });
}

function codeOf(fn: () => unknown): TerminalErrorCode | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof TerminalError) return error.code;
    throw error;
  }
}

/** Reference parser: the argument rules of CommandLineToArgvW and the MSVC runtime (2008 and later), program name included. */
function parseCommandLine(line: string): string[] {
  const args: string[] = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i += 1;
    if (i >= n) break;
    let arg = '';
    let inQuote = false;
    while (i < n) {
      let backslashes = 0;
      while (line[i] === '\\') {
        backslashes += 1;
        i += 1;
      }
      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          arg += '"';
          i += 1;
        } else if (inQuote && line[i + 1] === '"') {
          arg += '"';
          i += 2;
        } else {
          inQuote = !inQuote;
          i += 1;
        }
        continue;
      }
      arg += '\\'.repeat(backslashes);
      if (i >= n) break;
      const c = line.charAt(i);
      if (!inQuote && (c === ' ' || c === '\t')) break;
      arg += c;
      i += 1;
    }
    args.push(arg);
  }
  return args;
}

/** What `cmd.exe /s` leaves of a `/c` string: the outer pair of quotes is removed, nothing else. */
function cmdInner(tail: string): string {
  const prefix = '/d /s /c ';
  expect(tail.startsWith(prefix), tail).toBe(true);
  const rest = tail.slice(prefix.length);
  expect(rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2, rest).toBe(true);
  return rest.slice(1, -1);
}

function shim(launch: ClaudeLaunch): { file: string; args: string } {
  if (launch.kind !== 'shim') throw new Error(`expected the shim route, got ${launch.kind}`);
  return { file: launch.file, args: launch.args };
}

// ---- resolveClaudeCommand ---------------------------------------------------------------------------------------

describe('TC-UNIT-04 resolveClaudeCommand on win32 (the semantics of shutil.which)', () => {
  it('the first PATH directory that holds a match wins', () => {
    const files = ['C:\\a\\claude.cmd', 'C:\\b\\claude.cmd', 'C:\\b\\claude.exe'];
    expect(resolveWin(files, 'C:\\a;C:\\b', { pathext: '.exe;.cmd' })).toEqual({
      path: 'C:\\a\\claude.cmd',
      ext: '.cmd',
    });
    expect(resolveWin(files, 'C:\\b;C:\\a', { pathext: '.exe;.cmd' })).toEqual({
      path: 'C:\\b\\claude.exe',
      ext: '.exe',
    });
  });

  it.each([
    ['.COM;.EXE;.BAT;.CMD', 'claude.exe'],
    ['.cmd;.exe', 'claude.cmd'],
    ['.BAT;.CMD;.EXE', 'claude.cmd'],
    ['.BAT;.EXE', 'claude.exe'],
  ])('PATHEXT %s picks %s when a folder holds both', (pathext, expected) => {
    const found = resolveWin(['C:\\a\\claude.exe', 'C:\\a\\claude.cmd'], 'C:\\a', { pathext });
    expect(found?.path.toLowerCase()).toBe(`c:\\a\\${expected}`);
    expect(found?.ext).toBe(expected.slice('claude'.length));
  });

  it('skips an extensionless launcher and takes the .cmd next to it', () => {
    const files = ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\npm\\claude.ps1'];
    expect(resolveWin(files, 'C:\\npm', { pathext: '.exe;.cmd' })).toEqual({
      path: 'C:\\npm\\claude.cmd',
      ext: '.cmd',
    });
  });

  it('an extensionless launcher alone is no match, and a later folder with a real one is found', () => {
    expect(resolveWin(['C:\\npm\\claude'], 'C:\\npm', { pathext: '.exe;.cmd' })).toBeNull();
    expect(resolveWin(['C:\\npm\\claude', 'C:\\z\\claude.exe'], 'C:\\npm;C:\\z', { pathext: '.exe;.cmd' })).toEqual({
      path: 'C:\\z\\claude.exe',
      ext: '.exe',
    });
  });

  it('a file whose extension is not in PATHEXT is no match', () => {
    expect(resolveWin(['C:\\a\\claude.ps1', 'C:\\a\\claude.js'], 'C:\\a', { pathext: '.exe;.cmd' })).toBeNull();
  });

  it.each([[undefined], ['']])('PATHEXT %j falls back to .COM;.EXE;.BAT;.CMD', (pathext) => {
    const env: EnvSource = pathext === undefined ? {} : { PATHEXT: pathext };
    const fs = winFs(['C:\\a\\claude.bat', 'C:\\a\\claude.cmd']);
    const found = resolveClaudeCommand({ command: 'claude', env: { ...env, Path: 'C:\\a' }, platform: 'win32', fs });
    expect(found?.path.toLowerCase()).toBe('c:\\a\\claude.bat');
    expect(found?.ext).toBe('.bat');
  });

  it('ignores junk PATHEXT entries and empty fields', () => {
    const files = ['C:\\a\\claude.cmd', 'C:\\a\\claude'];
    expect(resolveWin(files, 'C:\\a', { pathext: ';;exe;.;..\\x;. cmd;.C:\\x;.cmd;' })?.path).toBe('C:\\a\\claude.cmd');
  });

  it('reads Path and PATHEXT under any case of the key', () => {
    const fs = winFs(['C:\\a\\claude.exe']);
    const found = resolveClaudeCommand({
      command: 'claude',
      env: { pAtH: 'C:\\a', pathext: '.exe' },
      platform: 'win32',
      fs,
    });
    expect(found).toEqual({ path: 'C:\\a\\claude.exe', ext: '.exe' });
  });

  it('trims PATH entries, removes their quotes, skips empty ones', () => {
    const files = ['C:\\Program Files\\tool\\claude.exe'];
    const found = resolveWin(files, ' ; "C:\\Program Files\\tool" ;;', { pathext: '.exe' });
    expect(found).toEqual({ path: 'C:\\Program Files\\tool\\claude.exe', ext: '.exe' });
  });

  it('ignores relative PATH entries, even when the file exists there', () => {
    const fs = winFs(['bin\\claude.exe', '.\\claude.exe', 'claude.exe', '\\rooted\\claude.exe', 'C:rel\\claude.exe']);
    const found = resolveClaudeCommand({
      command: 'claude',
      env: { Path: 'bin;.;;\\rooted;C:rel', PATHEXT: '.exe' },
      platform: 'win32',
      fs,
    });
    expect(found).toBeNull();
    expect(fs.probed).toEqual([]);
  });

  it('never looks in the current directory first (a planted claude.exe in the project folder is not found)', () => {
    const fs = winFs(['claude.exe', '.\\claude.exe', 'D:\\project\\claude.exe']);
    const found = resolveClaudeCommand({
      command: 'claude',
      env: { Path: 'C:\\real', PATHEXT: '.exe' },
      platform: 'win32',
      fs,
    });
    expect(found).toBeNull();
    expect(fs.probed.every((p) => p.startsWith('C:\\real\\'))).toBe(true);
  });

  it('accepts a UNC PATH entry', () => {
    expect(resolveWin(['\\\\host\\share\\bin\\claude.exe'], '\\\\host\\share\\bin', { pathext: '.exe' })?.ext).toBe(
      '.exe',
    );
  });

  it('a command that already ends in a PATHEXT extension is tried as it is', () => {
    const files = ['C:\\a\\claude.cmd', 'C:\\a\\claude.exe'];
    expect(resolveWin(files, 'C:\\a', { command: 'claude.cmd', pathext: '.exe;.cmd' })).toEqual({
      path: 'C:\\a\\claude.cmd',
      ext: '.cmd',
    });
    expect(resolveWin(files, 'C:\\a', { command: 'CLAUDE.EXE', pathext: '.exe;.cmd' })?.ext).toBe('.exe');
  });

  it('with an extension that is not in PATHEXT the extensions are appended', () => {
    expect(resolveWin(['C:\\a\\my.tool.exe'], 'C:\\a', { command: 'my.tool', pathext: '.exe' })?.ext).toBe('.exe');
  });

  describe('a command that is a path', () => {
    it('is tried as it is when it has a PATHEXT extension', () => {
      expect(resolveWin(['D:\\tools\\claude.exe'], undefined, { command: 'D:\\tools\\claude.exe' })).toEqual({
        path: 'D:\\tools\\claude.exe',
        ext: '.exe',
      });
    });

    it('then with each PATHEXT extension appended', () => {
      const found = resolveWin(['D:\\tools\\claude.cmd'], undefined, {
        command: 'D:\\tools\\claude',
        pathext: '.exe;.cmd',
      });
      expect(found).toEqual({ path: 'D:\\tools\\claude.cmd', ext: '.cmd' });
    });

    it('accepts forward slashes', () => {
      expect(resolveWin(['D:\\tools\\claude.exe'], undefined, { command: 'D:/tools/claude.exe' })?.ext).toBe('.exe');
    });

    it('does not consult PATH', () => {
      expect(resolveWin(['C:\\a\\claude.exe'], 'C:\\a', { command: 'D:\\tools\\claude.exe' })).toBeNull();
    });

    it('never matches an extensionless file', () => {
      expect(resolveWin(['D:\\tools\\claude'], undefined, { command: 'D:\\tools\\claude' })).toBeNull();
    });

    it.each([
      ['tools\\claude.exe'],
      ['.\\claude.exe'],
      ['..\\claude.exe'],
      ['bin/claude.exe'],
      ['\\claude.exe'],
      ['D:claude.exe'],
    ])('a relative path (%s) is never resolved against the server folder', (command) => {
      const fs = winFs([command, `C:\\work\\${command}`]);
      const found = resolveClaudeCommand({ command, env: { Path: 'C:\\work' }, platform: 'win32', fs });
      expect(found).toBeNull();
      expect(fs.probed).toEqual([]);
    });
  });

  it.each([[''], ['   '], ['cla"ude'], ['claude\u0000'], ['cla\tude'], ['a|b']])(
    'refuses the command %j',
    (command) => {
      expect(resolveWin(['C:\\a\\claude.exe'], 'C:\\a', { command, pathext: '.exe' })).toBeNull();
    },
  );

  it('with no PATH at all there is nothing to find', () => {
    expect(resolveWin(['C:\\a\\claude.exe'], undefined, { pathext: '.exe' })).toBeNull();
    expect(resolveWin(['C:\\a\\claude.exe'], '', { pathext: '.exe' })).toBeNull();
  });
});

describe('TC-UNIT-04 resolveClaudeCommand on a POSIX host', () => {
  const resolvePosix = (
    fs: CommandFs,
    pathValue: string | undefined,
    command = 'claude',
    platform: HostPlatform = 'linux',
  ) => resolveClaudeCommand({ command, env: pathValue === undefined ? {} : { PATH: pathValue }, platform, fs });

  it('takes the first executable file on PATH, in order', () => {
    const fs = posixFs(['/usr/bin/claude', '/opt/bin/claude']);
    expect(resolvePosix(fs, '/opt/bin:/usr/bin')).toEqual({ path: '/opt/bin/claude', ext: '' });
    expect(resolvePosix(fs, '/usr/bin:/opt/bin')).toEqual({ path: '/usr/bin/claude', ext: '' });
  });

  it('skips a file without the execute bit', () => {
    const fs = posixFs(['/opt/bin/claude', '/usr/bin/claude'], ['/usr/bin/claude']);
    expect(resolvePosix(fs, '/opt/bin:/usr/bin')?.path).toBe('/usr/bin/claude');
  });

  it('falls back to isFile when the file system has no execute test', () => {
    const fs = winFs(['/usr/bin/claude']);
    expect(resolvePosix(fs, '/usr/bin')?.path).toBe('/usr/bin/claude');
  });

  it('is case-sensitive, ignores relative and empty PATH entries and does not append extensions', () => {
    const fs = posixFs(['/usr/bin/Claude', 'bin/claude', '/usr/bin/claude.sh']);
    expect(resolvePosix(fs, 'bin::.:/usr/bin')).toBeNull();
    expect(fs.probed.filter((p) => !p.startsWith('/'))).toEqual([]);
  });

  it('a command that is an absolute path is used as it is, and a relative one is refused', () => {
    const fs = posixFs(['/srv/tools/claude']);
    expect(resolvePosix(fs, '/usr/bin', '/srv/tools/claude')).toEqual({ path: '/srv/tools/claude', ext: '' });
    expect(resolvePosix(fs, '/usr/bin', '/srv/tools/missing')).toBeNull();
    expect(resolvePosix(fs, '/usr/bin', 'tools/claude')).toBeNull();
    expect(resolvePosix(fs, '/usr/bin', './claude')).toBeNull();
  });

  it('works on darwin and with no PATH', () => {
    const fs = posixFs(['/usr/local/bin/claude']);
    expect(resolvePosix(fs, '/usr/local/bin', 'claude', 'darwin')?.path).toBe('/usr/local/bin/claude');
    expect(resolvePosix(fs, undefined)).toBeNull();
  });
});

// ---- quoteWindowsArg --------------------------------------------------------------------------------------------

describe('TC-UNIT-04 quoteWindowsArg against the CommandLineToArgvW reference parser', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['two words', '"two words"'],
    ['tab\there', '"tab\there"'],
    ['C:\\dir\\file', 'C:\\dir\\file'],
    ['C:\\my dir\\', '"C:\\my dir\\\\"'],
    ['C:\\my dir\\\\', '"C:\\my dir\\\\\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['trailing\\', 'trailing\\'],
  ])('%j is written as %s', (arg, expected) => {
    expect(quoteWindowsArg(arg)).toBe(expected);
    expect(parseCommandLine(quoteWindowsArg(arg))).toEqual([arg]);
  });

  it('property: any list of arguments survives quote, join with spaces and parse', () => {
    const prng = new Prng(14_004);
    const alphabet = ['a', 'b', ' ', ' ', '\t', '\\', '\\', '"', '\u00e9', '-', '.'];
    for (let round = 0; round < 400; round += 1) {
      const args: string[] = [];
      for (let k = prng.range(1, 6); k > 0; k -= 1) {
        let arg = '';
        for (let i = prng.range(0, 8); i > 0; i -= 1) arg += prng.pick(alphabet);
        args.push(arg);
      }
      const line = args.map(quoteWindowsArg).join(' ');
      expect(parseCommandLine(line), `seed ${String(prng.seed)} line ${line}`).toEqual(args);
    }
  });
});

// ---- isCmdSafeArg -----------------------------------------------------------------------------------------------

/** Printable characters that cmd.exe expands or that end a quoted string, each with its own row. */
const CMD_METACHARACTERS = ['"', '%', '^', '&', '|', '<', '>', '(', ')', '!'];
/** Printable ASCII outside the allow-list that cmd.exe treats as ordinary text: refused all the same. */
const OTHER_REFUSED_PRINTABLE = ["'", ';', '~', '$', '*', '?', '#', '[', ']', '{', '}', '`'];
const CONTROL_CHARACTERS = ['\u0000', '\u0001', '\t', '\n', '\r', '\u001b', '\u001f', '\u007f', '\u0085'];
/** Not control characters, not letters or digits: refused on the cmd.exe route. */
const OTHER_UNICODE_REFUSED = ['\u00a0', '\u2028', '\u200b', '\u202e', '\u{1f600}'];
const ALLOWED_PUNCTUATION = [' ', '_', '.', ',', ':', '=', '@', '+', '/', '\\', '-'];

describe('TC-UNIT-04 isCmdSafeArg', () => {
  it.each([...CMD_METACHARACTERS, ...OTHER_REFUSED_PRINTABLE])('refuses %j', (c) => {
    expect(isCmdSafeArg(c)).toBe(false);
    expect(isCmdSafeArg(`a${c}b`)).toBe(false);
    expect(isCmdSafeArg(`ok${c}`)).toBe(false);
  });

  it.each([...CONTROL_CHARACTERS, ...OTHER_UNICODE_REFUSED])('refuses the character %j', (c) => {
    expect(isCmdSafeArg(`a${c}b`)).toBe(false);
  });

  it.each(ALLOWED_PUNCTUATION)('allows %j', (c) => {
    expect(isCmdSafeArg(`a${c}b`)).toBe(true);
    expect(isCmdSafeArg(c)).toBe(true);
  });

  it('allows empty text, letters and digits of any script, and the usual claude options', () => {
    for (const arg of [
      '',
      'abcXYZ019',
      '\u00e9',
      '\u0416',
      '\u65e5\u672c',
      '\u06f3',
      '--model',
      '--resume',
      'opus plan',
      'C:\\work dir\\x.txt',
      'a=b,c:d@e+f/g',
    ]) {
      expect(isCmdSafeArg(arg), JSON.stringify(arg)).toBe(true);
    }
  });

  it('agrees with an independent reading of the allow-list for all of printable ASCII', () => {
    const allowed = /[A-Za-z0-9 _.,:=@+/\\-]/;
    for (let code = 0x20; code < 0x7f; code += 1) {
      const c = String.fromCharCode(code);
      expect(isCmdSafeArg(c), JSON.stringify(c)).toBe(allowed.test(c));
    }
  });
});

// ---- buildLaunch ------------------------------------------------------------------------------------------------

const SYSTEM_ROOT = 'C:\\Windows';
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const WIN_ENV: EnvSource = { SystemRoot: SYSTEM_ROOT };

function launchWin(
  resolved: ResolvedCommand,
  args: readonly string[] = [],
  o: { env?: EnvSource; files?: readonly string[]; resume?: string; fork?: boolean } = {},
): ClaudeLaunch {
  const fs = winFs(o.files ?? [CMD_EXE]);
  return buildLaunch(resolved, args, {
    env: o.env ?? WIN_ENV,
    platform: 'win32',
    fs,
    ...(o.resume === undefined ? {} : { resume: o.resume }),
    ...(o.fork === undefined ? {} : { fork: o.fork }),
  });
}

const EXE: ResolvedCommand = { path: 'C:\\tools\\claude.exe', ext: '.exe' };
const SHIM: ResolvedCommand = { path: 'C:\\tools\\shim dir\\claude.cmd', ext: '.cmd' };
const RESUME_ID = '0a1b2c3d-1111-2222-3333-444455556666';

describe('TC-UNIT-04 buildLaunch: the direct route (.exe, .com)', () => {
  it('runs the program itself with an argv array', () => {
    expect(launchWin(EXE, ['--model', 'opus plan'])).toEqual({
      kind: 'exe',
      file: 'C:\\tools\\claude.exe',
      args: ['--model', 'opus plan'],
      display: 'C:\\tools\\claude.exe',
    });
  });

  it('treats .com the same way, whatever the case of the extension', () => {
    expect(launchWin({ path: 'C:\\tools\\claude.COM', ext: '.COM' }).kind).toBe('exe');
    expect(launchWin({ path: 'C:\\tools\\claude.EXE', ext: '.EXE' }).kind).toBe('exe');
  });

  it('needs no cmd.exe', () => {
    expect(launchWin(EXE, [], { env: {}, files: [] }).kind).toBe('exe');
  });

  it('appends --resume <id> after the configured arguments', () => {
    const launch = launchWin(EXE, ['--verbose'], { resume: RESUME_ID });
    expect(launch).toMatchObject({ kind: 'exe', args: ['--verbose', '--resume', RESUME_ID] });
  });

  it('allows a path with a percent sign (no cmd.exe is involved)', () => {
    expect(launchWin({ path: 'C:\\100%\\claude.exe', ext: '.exe' }).kind).toBe('exe');
  });

  it('accepts every printable character in an argument and passes it through unchanged', () => {
    const args = [...CMD_METACHARACTERS, ...OTHER_REFUSED_PRINTABLE, '\u00a0', '\u{1f600}', '', 'a b'];
    expect(launchWin(EXE, args)).toMatchObject({ args });
  });

  it.each(CONTROL_CHARACTERS)('refuses a control character (%j) in an argument with ARGS_UNSAFE', (c) => {
    expect(codeOf(() => launchWin(EXE, ['fine', `a${c}b`]))).toBe('ARGS_UNSAFE');
  });
});

describe('TC-UNIT-04 buildLaunch: the .cmd and .bat route through cmd.exe /d /s /c', () => {
  it('writes the command line byte for byte', () => {
    const launch = shim(launchWin(SHIM, ['--model', 'opus plan', '--add-dir', 'C:\\my dir\\'], { resume: RESUME_ID }));
    expect(launch.file).toBe(CMD_EXE);
    expect(launch.args).toBe(
      '/d /s /c ""C:\\tools\\shim dir\\claude.cmd" --model "opus plan" --add-dir "C:\\my dir\\\\" --resume 0a1b2c3d-1111-2222-3333-444455556666"',
    );
  });

  it('with no arguments the shim is the only thing inside the outer quotes', () => {
    expect(shim(launchWin({ path: 'C:\\tools\\claude.cmd', ext: '.cmd' })).args).toBe(
      '/d /s /c ""C:\\tools\\claude.cmd""',
    );
  });

  it('an empty argument is written as ""', () => {
    expect(shim(launchWin(SHIM, ['', 'x'])).args).toBe('/d /s /c ""C:\\tools\\shim dir\\claude.cmd" "" x"');
  });

  it('is typed as the shim route with the display of the shim', () => {
    const launch = launchWin(SHIM);
    expect(launch.kind).toBe('shim');
    expect(launch.display).toBe('C:\\tools\\shim dir\\claude.cmd');
  });

  it('handles .bat and an upper-case extension the same way', () => {
    expect(launchWin({ path: 'C:\\t\\claude.bat', ext: '.bat' }).kind).toBe('shim');
    expect(launchWin({ path: 'C:\\t\\claude.CMD', ext: '.CMD' }).kind).toBe('shim');
  });

  it('finds cmd.exe under SystemRoot or windir, in any case of the key, with or without a trailing separator', () => {
    expect(shim(launchWin(SHIM, [], { env: { SYSTEMROOT: 'C:\\Windows\\' } })).file).toBe(CMD_EXE);
    expect(shim(launchWin(SHIM, [], { env: { windir: 'C:\\Windows' } })).file).toBe(CMD_EXE);
    expect(
      shim(
        launchWin(SHIM, [], {
          env: { SystemRoot: 'D:\\WinNT', windir: 'C:\\Windows' },
          files: ['D:\\WinNT\\System32\\cmd.exe'],
        }),
      ).file,
    ).toBe('D:\\WinNT\\System32\\cmd.exe');
  });

  it('is COMMAND_UNSUPPORTED when cmd.exe cannot be found', () => {
    expect(codeOf(() => launchWin(SHIM, [], { files: [] }))).toBe('COMMAND_UNSUPPORTED');
    expect(codeOf(() => launchWin(SHIM, [], { env: {} }))).toBe('COMMAND_UNSUPPORTED');
    expect(codeOf(() => launchWin(SHIM, [], { env: { SystemRoot: '' } }))).toBe('COMMAND_UNSUPPORTED');
  });

  it('the line parses back to the shim and the arguments (reference parser, after the /s strip)', () => {
    const args = ['--model', 'opus plan', 'C:\\my dir\\', 'a=b,c:d@e+f', '', 'tab_free  two spaces'];
    const line = shim(launchWin(SHIM, args, { resume: RESUME_ID })).args;
    expect(parseCommandLine(cmdInner(line))).toEqual([SHIM.path, ...args, '--resume', RESUME_ID]);
  });

  it('property: random safe arguments survive the whole command line', () => {
    const prng = new Prng(14_005);
    const alphabet = ['a', 'B', '7', ' ', ' ', '\\', '_', '-', '.', ':', '=', '/', '\u00e9', '\u65e5'];
    for (let round = 0; round < 300; round += 1) {
      const args: string[] = [];
      for (let k = prng.range(0, 5); k > 0; k -= 1) {
        let arg = '';
        for (let i = prng.range(0, 10); i > 0; i -= 1) arg += prng.pick(alphabet);
        args.push(arg);
      }
      const line = shim(launchWin(SHIM, args)).args;
      expect(parseCommandLine(cmdInner(line)), `seed ${String(prng.seed)} ${line}`).toEqual([SHIM.path, ...args]);
    }
  });

  describe('a shim path that cmd.exe would expand or misread is COMMAND_UNSUPPORTED', () => {
    it.each([
      ['a percent sign', 'C:\\tools\\%PATH%\\claude.cmd'],
      ['a single percent sign', 'C:\\100%\\claude.cmd'],
      ['a double quote', 'C:\\to"ols\\claude.cmd'],
      ['a NUL', 'C:\\tools\u0000\\claude.cmd'],
      ['a tab', 'C:\\tools\t\\claude.cmd'],
      ['a newline', 'C:\\tools\n\\claude.cmd'],
      ['an escape character', 'C:\\tools\u001b\\claude.cmd'],
      ['DEL', 'C:\\tools\u007f\\claude.cmd'],
    ])('%s', (_label, path) => {
      let thrown: unknown;
      try {
        launchWin({ path, ext: '.cmd' }, ['--x']);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TerminalError);
      expect((thrown as TerminalError).code).toBe('COMMAND_UNSUPPORTED');
      expect((thrown as TerminalError).message).not.toContain('tools');
    });

    it('also for .bat', () => {
      expect(codeOf(() => launchWin({ path: 'C:\\t%x\\claude.bat', ext: '.bat' }))).toBe('COMMAND_UNSUPPORTED');
    });

    it('but a space, a dot, parentheses and an exclamation mark in the folder name are fine inside the quotes', () => {
      const path = 'C:\\Program Files (x86)\\my.tools!\\claude.cmd';
      expect(shim(launchWin({ path, ext: '.cmd' })).args).toBe(`/d /s /c ""${path}""`);
    });
  });

  describe('arguments pass the allow-list or the launch is refused with ARGS_UNSAFE', () => {
    it.each([...CMD_METACHARACTERS, ...OTHER_REFUSED_PRINTABLE])('one row for %j', (c) => {
      const secret = `leak${c}me`;
      let thrown: unknown;
      try {
        launchWin(SHIM, ['--fine', secret]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TerminalError);
      expect((thrown as TerminalError).code).toBe('ARGS_UNSAFE');
      expect((thrown as TerminalError).message).not.toContain('leak');
    });

    it.each([...CONTROL_CHARACTERS, ...OTHER_UNICODE_REFUSED])('one row for the character %j', (c) => {
      expect(codeOf(() => launchWin(SHIM, [`a${c}b`]))).toBe('ARGS_UNSAFE');
    });

    it('checks every argument, not only the first', () => {
      expect(codeOf(() => launchWin(SHIM, ['fine', 'fine', 'bad&bad']))).toBe('ARGS_UNSAFE');
    });

    it('the same characters are accepted on the direct route (checked above), so the hint can point to the real exe', () => {
      expect(codeOf(() => launchWin(EXE, ['bad&bad', '100%']))).toBeNull();
    });
  });
});

describe('TC-UNIT-04 buildLaunch: other kinds of command', () => {
  it.each([
    ['.js', 'C:\\t\\claude.js', '.js'],
    ['.ps1', 'C:\\t\\claude.ps1', '.ps1'],
    ['.vbs', 'C:\\t\\claude.vbs', '.vbs'],
    ['.msc', 'C:\\t\\claude.msc', '.msc'],
    ['.exe.txt', 'C:\\t\\claude.exe.txt', '.txt'],
    ['.cmd.exe.js', 'C:\\t\\claude.cmd.exe.js', '.js'],
    ['an empty extension', 'C:\\t\\claude', ''],
    ['a trailing dot', 'C:\\t\\claude.', '.'],
  ])('%s is COMMAND_UNSUPPORTED on win32', (_label, path, ext) => {
    expect(codeOf(() => launchWin({ path, ext }))).toBe('COMMAND_UNSUPPORTED');
  });

  it('decides by the extension of the path itself, never by the ext field a caller passes', () => {
    expect(launchWin({ path: 'C:\\t\\claude.cmd', ext: '.exe' }).kind).toBe('shim');
    expect(launchWin({ path: 'C:\\t\\claude.exe', ext: '.cmd' }).kind).toBe('exe');
    expect(codeOf(() => launchWin({ path: 'C:\\t\\claude.js', ext: '.exe' }))).toBe('COMMAND_UNSUPPORTED');
  });

  it('on a POSIX host the file is run directly, whatever its name', () => {
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      const launch = buildLaunch({ path: '/usr/bin/claude', ext: '' }, ['--x', 'a b'], {
        env: {},
        platform,
        fs: posixFs([]),
      });
      expect(launch).toEqual({
        kind: 'exe',
        file: '/usr/bin/claude',
        args: ['--x', 'a b'],
        display: '/usr/bin/claude',
      });
    }
    const odd = buildLaunch({ path: '/opt/x/claude.cmd', ext: '.cmd' }, [], {
      env: {},
      platform: 'linux',
      fs: posixFs([]),
    });
    expect(odd.kind).toBe('exe');
  });

  it('on a POSIX host a control character in an argument is refused, other characters pass', () => {
    const o = { env: {}, platform: 'linux' as const, fs: posixFs([]) };
    expect(codeOf(() => buildLaunch({ path: '/b/claude', ext: '' }, ['a\nb'], o))).toBe('ARGS_UNSAFE');
    expect(codeOf(() => buildLaunch({ path: '/b/claude', ext: '' }, ['a&b%'], o))).toBeNull();
  });

  it('resolves and launches a claude.cmd found on a PATH with a spaced folder', () => {
    const files = ['C:\\Tools\\npm dir\\claude', 'C:\\Tools\\npm dir\\claude.cmd', CMD_EXE];
    const fs = winFs(files);
    const env = { Path: 'C:\\Tools\\npm dir', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: SYSTEM_ROOT };
    const resolved = resolveClaudeCommand({ command: 'claude', env, platform: 'win32', fs });
    expect(resolved).not.toBeNull();
    const launch = buildLaunch(resolved!, ['--verbose'], { env, platform: 'win32', fs });
    expect(launch.kind).toBe('shim');
    expect(shim(launch).args.toLowerCase()).toBe('/d /s /c ""c:\\tools\\npm dir\\claude.cmd" --verbose"');
  });
});

describe('TC-UNIT-04 buildLaunch: a copy of a session (--fork-session)', () => {
  it('appends --fork-session after --resume <id> on the direct route', () => {
    expect(launchWin(EXE, ['--verbose'], { resume: RESUME_ID, fork: true })).toMatchObject({
      kind: 'exe',
      args: ['--verbose', '--resume', RESUME_ID, '--fork-session'],
    });
  });

  it('quotes nothing special for it on the shim route', () => {
    const launch = launchWin(SHIM, [], { resume: RESUME_ID, fork: true });
    expect(parseCommandLine(cmdInner(shim(launch).args))).toEqual([SHIM.path, '--resume', RESUME_ID, '--fork-session']);
  });

  it('adds nothing for fork false or absent', () => {
    expect(launchWin(EXE, [], { resume: RESUME_ID, fork: false })).toMatchObject({ args: ['--resume', RESUME_ID] });
    expect(launchWin(EXE, [], { resume: RESUME_ID })).toMatchObject({ args: ['--resume', RESUME_ID] });
  });

  it('refuses a copy of nothing: fork needs a session id to resume (ARGS_UNSAFE)', () => {
    expect(codeOf(() => launchWin(EXE, [], { fork: true }))).toBe('ARGS_UNSAFE');
    expect(codeOf(() => launchWin(SHIM, [], { fork: true }))).toBe('ARGS_UNSAFE');
  });

  it('adds nothing at all when fork is false and nothing is resumed', () => {
    expect(launchWin(EXE, ['--verbose'], { fork: false })).toMatchObject({ args: ['--verbose'] });
  });
});

describe('TC-UNIT-04 buildLaunch: the resume id', () => {
  it.each([['abcdef12'], ['0123456789'], [RESUME_ID], ['A1b2C3d4-e5f6'], ['x'.repeat(64)], ['9'.repeat(8)]])(
    'accepts %s',
    (id) => {
      expect(RESUME_ID_RE.test(id)).toBe(true);
      const launch = launchWin(SHIM, [], { resume: id });
      expect(parseCommandLine(cmdInner(shim(launch).args))).toEqual([SHIM.path, '--resume', id]);
      expect(launchWin(EXE, [], { resume: id })).toMatchObject({ args: ['--resume', id] });
    },
  );

  it.each([
    [''],
    ['short12'],
    ['x'.repeat(65)],
    ['-leading-dash-1'],
    ['has_underscore'],
    ['has space 1234'],
    ['has"quote123'],
    ['pct%20encoded'],
    ['..\\..\\evil1'],
    ['a;b&c|d12345'],
    ['ab\ncdefgh'],
    ['abc\u00e9defgh'],
    ['abcdefgh\u0000'],
    ['--resume'],
  ])('refuses %j with ARGS_UNSAFE on both routes', (id) => {
    expect(codeOf(() => launchWin(SHIM, [], { resume: id }))).toBe('ARGS_UNSAFE');
    expect(codeOf(() => launchWin(EXE, [], { resume: id }))).toBe('ARGS_UNSAFE');
  });

  it('is validated before anything is built, and the id never appears in the error', () => {
    try {
      launchWin(EXE, [], { resume: 'secret value' });
      expect.unreachable();
    } catch (error) {
      expect((error as TerminalError).message).not.toContain('secret');
    }
  });
});

// ---- TerminalError ----------------------------------------------------------------------------------------------

describe('TC-UNIT-04 TerminalError: a fixed English sentence per code', () => {
  it('lists every code of the design, SHUTTING_DOWN included', () => {
    expect([...TERMINAL_ERROR_CODES]).toEqual([
      'UNSUPPORTED_OS',
      'NATIVE_MISSING',
      'NATIVE_LOAD_FAILED',
      'CLAUDE_NOT_FOUND',
      'COMMAND_UNSUPPORTED',
      'ARGS_UNSAFE',
      'FOLDER_INVALID',
      'FOLDER_NOT_FOUND',
      'SESSION_LIMIT',
      'SPAWN_FAILED',
      'START_TIMEOUT',
      'SESSION_NOT_FOUND',
      'SESSION_ENDED',
      'NAME_INVALID',
      'MESSAGE_TOO_LARGE',
      'SHUTTING_DOWN',
    ]);
  });

  it.each([...TERMINAL_ERROR_CODES])('%s has a plain sentence with no path in it', (code) => {
    const error = new TerminalError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TerminalError');
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/^[A-Z][A-Za-z ,'-]+\.$/);
    expect(error.message).not.toMatch(/[\\/:]/);
    expect(isTerminalError(error)).toBe(true);
  });

  it('the sentences are distinct and the same every time', () => {
    const messages = TERMINAL_ERROR_CODES.map((code) => new TerminalError(code).message);
    expect(new Set(messages).size).toBe(messages.length);
    expect(TERMINAL_ERROR_CODES.map((code) => new TerminalError(code).message)).toEqual(messages);
  });

  it('keeps the cause for a debugger and never lets its text into the message', () => {
    const cause = new Error('ENOENT: C:\\Addons\\hidden-folder\\pty.node');
    const error = new TerminalError('NATIVE_LOAD_FAILED', { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('pty.node');
    expect(String(error)).not.toContain('hidden-folder');
  });

  it('has no cause unless one is given', () => {
    expect(new TerminalError('SESSION_ENDED').cause).toBeUndefined();
    expect('cause' in new TerminalError('SESSION_ENDED')).toBe(false);
  });

  it('isTerminalError is false for other values', () => {
    expect(isTerminalError(new Error('x'))).toBe(false);
    expect(isTerminalError({ code: 'SESSION_ENDED' })).toBe(false);
    expect(isTerminalError(null)).toBe(false);
  });
});
