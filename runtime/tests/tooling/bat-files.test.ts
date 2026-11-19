// The three batch files at the repository root (06 4, ADR 0095): `start.bat`, `stop.bat` and `install-skill.bat`. A batch file is
// the one piece of the product that no type checker and no linter reads, so the rules that keep it working are tests:
//
// 1. the bytes: CRLF line endings only (an LF-only file can break `goto` labels), no byte order mark, ASCII only, and the
//    attribute rule that keeps them that way in a checkout;
// 2. the shape: the find-node block is identical in the three files, the launcher block in `start.bat` and `stop.bat`, the
//    wildcard finds a real launcher, every `goto` has its label, no parenthesized block (`%ERRORLEVEL%` would be expanded when
//    the block is parsed), every pause is behind `CAW_NO_PROMPT`;
// 3. what they must never contain: Python, a download, a compiler, a PATH edit;
// 4. on Windows, what they do: run each file in a throw-away copy next to a fake launcher and read back the arguments and the
//    exit codes, with the Node of this test, a temp home and no real skill, instance or Claude folder involved.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FILES = ['start.bat', 'stop.bat', 'install-skill.bat'] as const;
const CR = '\r';
const LF = '\n';

function bytesOf(file: string): Buffer {
  return readFileSync(join(REPO, file));
}

function textOf(file: string): string {
  return bytesOf(file).toString('latin1');
}

function linesOf(file: string): string[] {
  return textOf(file).split(CR + LF);
}

/** The lines from the one that holds `from` to the one that holds `to`, both included. */
function blockOf(file: string, from: string, to: string): string {
  const lines = linesOf(file);
  const first = lines.findIndex((line) => line.includes(from));
  const last = lines.findIndex((line) => line.includes(to));
  if (first === -1 || last < first) throw new Error(`${file}: no block from '${from}' to '${to}'`);
  return lines.slice(first, last + 1).join(LF);
}

const NODE_FROM = 'rem ---- find node';
const NODE_TO = 'if not defined CAW_NODE goto :no_node';
const LAUNCHER_FROM = 'rem ---- find the launcher';
const LAUNCHER_TO = 'if not defined CAW_LAUNCHER goto :no_launcher';

describe('batch files: the bytes', () => {
  it.each(FILES)('%s exists at the repository root', (file) => {
    expect(existsSync(join(REPO, file))).toBe(true);
  });

  it.each(FILES)('%s has CRLF line endings only, and ends with one', (file) => {
    const text = textOf(file);
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith(CR + LF)).toBe(true);
    // every LF has a CR before it, and every CR an LF after it
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it.each(FILES)('%s is ASCII: no byte order mark and no code page surprise', (file) => {
    const bytes = bytesOf(file);
    for (const byte of bytes) expect(byte).toBeLessThan(0x80);
    expect(bytes.subarray(0, 3).toString('hex')).not.toBe('efbbbf');
  });

  it.each(FILES)('%s starts with @echo off', (file) => {
    expect(linesOf(file)[0]).toBe('@echo off');
  });

  it('.gitattributes gives *.bat and *.cmd CRLF after the rule for every other file', () => {
    const lines = readFileSync(join(REPO, '.gitattributes'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '' && !line.startsWith('#'));
    const all = lines.indexOf('* text=auto eol=lf');
    const bat = lines.indexOf('*.bat text eol=crlf');
    const cmd = lines.indexOf('*.cmd text eol=crlf');
    expect(all).toBeGreaterThanOrEqual(0);
    // the later rule wins, so the batch rules come after the catch-all
    expect(bat).toBeGreaterThan(all);
    expect(cmd).toBeGreaterThan(all);
  });
});

describe('batch files: the shape', () => {
  it('the find-node block is identical in the three files', () => {
    const blocks = FILES.map((file) => blockOf(file, NODE_FROM, NODE_TO));
    expect(blocks[1]).toBe(blocks[0]);
    expect(blocks[2]).toBe(blocks[0]);
  });

  it('the find-node block honors CAW_NODE_PATH first, then PATH, then the three install places of Node', () => {
    const block = blockOf('start.bat', NODE_FROM, NODE_TO);
    const order = [
      'CAW_NODE_PATH',
      'where node.exe',
      '%ProgramFiles%\\nodejs\\node.exe',
      '%LOCALAPPDATA%\\Programs\\nodejs\\node.exe',
      '%ProgramFiles(x86)%\\nodejs\\node.exe',
      'goto :no_node',
    ];
    let at = -1;
    for (const part of order) {
      const found = block.indexOf(part);
      expect(found, part).toBeGreaterThan(at);
      at = found;
    }
  });

  it('the launcher block is identical in start.bat and stop.bat', () => {
    expect(blockOf('stop.bat', LAUNCHER_FROM, LAUNCHER_TO)).toBe(blockOf('start.bat', LAUNCHER_FROM, LAUNCHER_TO));
  });

  it('the launcher is found by a wildcard over skills, so the rename of the skill folder needs no edit, and it resolves a real file', () => {
    const block = blockOf('start.bat', LAUNCHER_FROM, LAUNCHER_TO);
    const match = /in \("%~dp0([^"*]+)\\\*"\) do if exist "%%~fD\\([^"]+)"/.exec(block);
    expect(match).not.toBeNull();
    const base = match?.[1] ?? '';
    const launcher = (match?.[2] ?? '').split('\\');
    expect(base).toBe('skills');
    expect(launcher).toEqual(['scripts', 'caw.mjs']);
    const folders = readdirSync(join(REPO, base), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const hits = folders.filter((entry) => existsSync(join(REPO, base, entry.name, ...launcher)));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it.each(FILES)('%s: every goto and call names a label that exists in the file', (file) => {
    const lines = linesOf(file);
    const labels = new Set(
      lines.filter((line) => /^:[A-Za-z_]/.test(line)).map((line) => line.slice(1).split(/\s/)[0]?.toLowerCase()),
    );
    const targets = lines.flatMap((line) =>
      [...line.matchAll(/\b(?:goto|call)\s+:?([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => (m[1] ?? '').toLowerCase()),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      if (target === 'eof') continue;
      expect(labels.has(target), `${file}: label :${target}`).toBe(true);
    }
  });

  it.each(FILES)(
    '%s has no parenthesized block: labels are used instead, so ERRORLEVEL is read when it runs',
    (file) => {
      for (const line of linesOf(file)) {
        if (line.startsWith('rem ')) continue;
        expect(line.trimEnd().endsWith('('), line).toBe(false);
        expect(line.trimStart().startsWith(')'), line).toBe(false);
      }
    },
  );

  it.each(FILES)('%s: every pause and every question is behind CAW_NO_PROMPT', (file) => {
    const lines = linesOf(file);
    const pauses = lines.filter((line) => /\bpause\b/i.test(line) && !line.startsWith('rem '));
    expect(pauses.length).toBeGreaterThan(0);
    for (const line of pauses) expect(line, line).toBe('if not defined CAW_NO_PROMPT pause');
    const text = lines.join(LF);
    if (/\bchoice\b/i.test(text)) {
      // the question is behind the variable: the line before it (or a jump above it) skips it
      expect(text).toMatch(/if defined CAW_NO_PROMPT (?:goto :\w+|exit \/b 3)/);
    }
  });

  it('start.bat passes its arguments to `caw start` and fails with exit 1', () => {
    const text = textOf('start.bat');
    expect(text).toContain('"%CAW_NODE%" "%CAW_LAUNCHER%" start %*');
    expect(text).toContain('if errorlevel 1 goto :failed');
    expect(text).toContain(':no_node');
    expect(text).toContain(':no_launcher');
    expect(text).toContain('Node.js 22.22 or newer');
  });

  it('stop.bat asks only on exit code 3, then stops with --force, and exits 3 for a no or without a person', () => {
    const lines = linesOf('stop.bat');
    const text = lines.join(LF);
    expect(text).toContain('"%CAW_NODE%" "%CAW_LAUNCHER%" stop %*');
    expect(text).toContain('if "%CAW_RC%"=="3" goto :live');
    const live = lines.indexOf(':live');
    expect(live).toBeGreaterThan(0);
    expect(lines[live + 1]).toBe('if defined CAW_NO_PROMPT exit /b 3');
    expect(lines[live + 2]).toMatch(/^choice \/c YN \/n \/m "Terminal sessions are live\./);
    expect(lines[live + 3]).toBe('if errorlevel 2 exit /b 3');
    expect(lines[live + 4]).toBe('"%CAW_NODE%" "%CAW_LAUNCHER%" stop --force %*');
  });

  it('install-skill.bat runs `install.mjs --force` with the arguments of the call', () => {
    expect(textOf('install-skill.bat')).toContain('"%CAW_NODE%" "%~dp0install.mjs" --force %*');
  });

  it('install-skill.bat says to stop the app first when the instance has a state.json', () => {
    const lines = linesOf('install-skill.bat');
    const check = lines.find((line) => line.includes('state.json'));
    expect(check).toBeDefined();
    expect(check).toContain('\\instances\\user\\state.json');
    expect(check).toContain('stop the app first (caw stop; terminals end)');
    // the home of the instance follows MCS_HOME like the runtime does, and defaults to %LOCALAPPDATA%\mcs
    const text = lines.join(LF);
    expect(text).toContain('set "CAW_HOME_DIR=%MCS_HOME%"');
    expect(text).toContain('set "CAW_HOME_DIR=%LOCALAPPDATA%\\mcs"');
    // the warning comes before the installer runs
    expect(text.indexOf('state.json')).toBeLessThan(text.indexOf('install.mjs" --force'));
  });

  it('install-skill.bat writes caw.cmd as one line that calls the launcher, in WindowsApps, and edits no PATH', () => {
    const lines = linesOf('install-skill.bat');
    const writes = lines.filter((line) => /caw\.cmd"\s+echo\b/.test(line));
    expect(writes).toHaveLength(1);
    // one echo line: `@"<node>" "<launcher>" %*`, the percent sign doubled so that the written file holds one
    expect(writes[0]).toBe('>"%CAW_APPS_DIR%\\caw.cmd" echo @"%CAW_NODE%" "%CAW_INSTALLED%" %%*');
    expect(lines.join(LF)).toContain('set "CAW_APPS_DIR=%LOCALAPPDATA%\\Microsoft\\WindowsApps"');
    // the offer is a question, only for a person and only for a plain call
    expect(lines.join(LF)).toContain('if defined CAW_NO_PROMPT goto :done');
    expect(lines.join(LF)).toContain('if not "%~1"=="" goto :done');
    expect(lines.join(LF)).toMatch(/choice \/c YN \/n \/m "Write caw\.cmd into /);
  });
});

describe('batch files: what they never contain', () => {
  const FORBIDDEN: readonly [string, RegExp][] = [
    ['Python', /\bpythonw?\b|\bpy\.exe\b|\.py\b/i],
    [
      'a download',
      /\b(?:curl|wget|bitsadmin|certutil|Invoke-WebRequest|Invoke-RestMethod|DownloadFile|DownloadString)\b/i,
    ],
    // Built from parts: the no-C# guard (no-csharp.test.ts) scans this file too and must not find the compiler words spelled out.
    [
      'a compiler or a compile step',
      new RegExp(
        `\\b(?:${['cs', 'c'].join('')}|${['ms', 'build'].join('')}|dotnet|Add-Type|${['Type', 'Definition'].join('')}|${['Member', 'Definition'].join('')})\\b`,
        'i',
      ),
    ],
    ['PowerShell', /\bpowershell\b|\bpwsh\b/i],
    ['a PATH edit', /\bsetx\b|\breg\s+add\b|\bsetx?\s+"?PATH=|\bPATH=/i],
    ['a program file other than node.exe', /\b(?!node\b)[A-Za-z0-9_-]+\.exe\b/i],
    ['an address other than the Node download page', /https?:\/\/(?!nodejs\.org\/)/i],
  ];

  it.each(FILES)('%s has none of them', (file) => {
    const lines = linesOf(file);
    for (const [what, pattern] of FORBIDDEN) {
      for (const line of lines) expect(pattern.test(line), `${file} has ${what}: ${line}`).toBe(false);
    }
  });

  it.each(FILES)('%s does not mention a terminal, an access code or a token', (file) => {
    expect(textOf(file)).not.toMatch(/#code=|control\.token|access code/i);
  });
});

describe('batch files: the variables are documented', () => {
  it.each(['CAW_NODE_PATH', 'CAW_NO_PROMPT'])('%s is read by the files and listed in docs/configuration.md', (name) => {
    for (const file of FILES) expect(textOf(file), `${file} reads ${name}`).toContain(name);
    expect(readFileSync(join(REPO, 'docs', 'configuration.md'), 'utf8')).toContain(`\`${name}\``);
  });
});

// ---- what they do (Windows) -----------------------------------------------------------------------------------------------------

const temps: ReturnType<typeof makeTempDir>[] = [];

afterEach(() => {
  for (const temp of temps.splice(0)) temp.remove();
});

const IS_WINDOWS = process.platform === 'win32';

/** The name of the variable the fake launcher reads for its exit code: no product prefix, it is the test's own. */
const FAKE_EXIT = 'FAKE_EXIT';
const FAKE_NAME = 'launcher-copy-of-this-test';

interface Copy {
  readonly dir: string;
  readonly log: string;
  readonly env: Record<string, string>;
}

/**
 * A copy of the batch files next to a fake `skills/<name>/scripts/caw.mjs` and a fake `install.mjs`: each appends its arguments, one
 * per line, to a log and exits with the code of `FAKE_EXIT` (or 0 when the arguments hold `--force`, so that the second call
 * of `stop.bat` can succeed). The environment holds this test's Node, a temp home and no real Claude, skill or instance folder.
 */
function copyOf(purpose: string): Copy {
  const temp = makeTempDir(purpose);
  temps.push(temp);
  const dir = join(temp.path, 'repo');
  const scripts = join(dir, 'skills', FAKE_NAME, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const log = join(temp.path, 'calls.log');
  const fake = [
    "import { appendFileSync } from 'node:fs';",
    `const args = process.argv.slice(2);`,
    `appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
    `process.exit(args[0] === 'stop' && args.includes('--force') ? 0 : Number(process.env.${FAKE_EXIT} ?? '0'));`,
    '',
  ].join('\n');
  writeFileSync(join(scripts, 'caw.mjs'), fake);
  writeFileSync(join(dir, 'install.mjs'), fake);
  for (const file of FILES) writeFileSync(join(dir, file), bytesOf(file));
  const home = join(temp.path, 'home');
  const local = join(temp.path, 'local');
  mkdirSync(local, { recursive: true });
  const env: Record<string, string> = {
    SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
    ComSpec: process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe',
    PATH: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32'),
    TEMP: temp.path,
    TMP: temp.path,
    USERPROFILE: home,
    LOCALAPPDATA: local,
    ProgramFiles: join(temp.path, 'pf'),
    'ProgramFiles(x86)': join(temp.path, 'pf86'),
    MCS_HOME: join(temp.path, 'mcs-home'),
    CAW_NODE_PATH: process.execPath,
    CAW_NO_PROMPT: '1',
  };
  return { dir, log, env };
}

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly calls: string[];
}

function runBat(copy: Copy, file: string, args: readonly string[], env: Record<string, string> = {}, input = ''): Ran {
  const result = spawnSync(copy.env['ComSpec'] ?? 'cmd.exe', ['/d', '/c', join(copy.dir, file), ...args], {
    env: { ...copy.env, ...env },
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const calls = existsSync(copy.log)
    ? readFileSync(copy.log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
  return { status: result.status, stdout: result.stdout, calls };
}

describe.runIf(IS_WINDOWS)('batch files: run in a copy next to a fake launcher', () => {
  it('start.bat passes every argument to `start` and exits 0', () => {
    const copy = copyOf('bat-start');
    const ran = runBat(copy, 'start.bat', ['--no-open', '--port', '18123']);
    expect(ran.status).toBe(0);
    expect(ran.calls).toEqual(['start --no-open --port 18123']);
  });

  it('start.bat exits 1 when `start` fails, and does not pause under CAW_NO_PROMPT', () => {
    const copy = copyOf('bat-start-fail');
    const ran = runBat(copy, 'start.bat', [], { [FAKE_EXIT]: '1' });
    expect(ran.status).toBe(1);
    expect(ran.calls).toEqual(['start']);
  });

  it('start.bat finds the launcher whatever the skill folder is called', () => {
    const copy = copyOf('bat-wildcard');
    expect(readdirSync(join(copy.dir, 'skills'))).toEqual([FAKE_NAME]);
    expect(runBat(copy, 'start.bat', []).status).toBe(0);
  });

  it('start.bat uses the Node on PATH when CAW_NODE_PATH is not set', () => {
    const copy = copyOf('bat-path-node');
    const nodeDir = join(process.execPath, '..');
    const ran = runBat(copy, 'start.bat', ['--print'], {
      CAW_NODE_PATH: '',
      PATH: `${copy.env['PATH'] ?? ''};${nodeDir}`,
    });
    expect(ran.status).toBe(0);
    expect(ran.calls).toEqual(['start --print']);
  });

  it('start.bat says that Node is missing, and exits 1, when there is none', () => {
    const copy = copyOf('bat-no-node');
    const ran = runBat(copy, 'start.bat', [], { CAW_NODE_PATH: join(copy.dir, 'missing', 'node.exe') });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('Node.js 22.22 or newer was not found');
    expect(ran.calls).toEqual([]);
  });

  it('start.bat says that the launcher is missing, and exits 1', () => {
    const copy = copyOf('bat-no-launcher');
    rmSync(join(copy.dir, 'skills', FAKE_NAME, 'scripts', 'caw.mjs'));
    const ran = runBat(copy, 'start.bat', []);
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('The caw launcher was not found under');
    expect(ran.calls).toEqual([]);
  });

  it('stop.bat passes its arguments to `stop` and exits 0', () => {
    const copy = copyOf('bat-stop');
    const ran = runBat(copy, 'stop.bat', ['--timeout-ms', '5000']);
    expect(ran.status).toBe(0);
    expect(ran.calls).toEqual(['stop --timeout-ms 5000']);
  });

  it('stop.bat exits 3 under CAW_NO_PROMPT when terminals are live, and does not stop again', () => {
    const copy = copyOf('bat-stop-live');
    const ran = runBat(copy, 'stop.bat', [], { [FAKE_EXIT]: '3' });
    expect(ran.status).toBe(3);
    expect(ran.calls).toEqual(['stop']);
  });

  it('stop.bat asks, and stops with --force on a yes', () => {
    const copy = copyOf('bat-stop-yes');
    const ran = runBat(copy, 'stop.bat', ['--timeout-ms', '5000'], { [FAKE_EXIT]: '3', CAW_NO_PROMPT: '' }, 'Y');
    expect(ran.stdout).toContain('Terminal sessions are live. Stop anyway and end them?');
    expect(ran.calls).toEqual(['stop --timeout-ms 5000', 'stop --force --timeout-ms 5000']);
    expect(ran.status).toBe(0);
  });

  it('stop.bat asks, and leaves everything running on a no (exit 3)', () => {
    const copy = copyOf('bat-stop-no');
    const ran = runBat(copy, 'stop.bat', [], { [FAKE_EXIT]: '3', CAW_NO_PROMPT: '' }, 'N');
    expect(ran.calls).toEqual(['stop']);
    expect(ran.status).toBe(3);
  });

  it('stop.bat passes any other failure through, without asking', () => {
    const copy = copyOf('bat-stop-fail');
    const ran = runBat(copy, 'stop.bat', [], { [FAKE_EXIT]: '1' });
    expect(ran.status).toBe(1);
    expect(ran.calls).toEqual(['stop']);
    expect(ran.stdout).not.toContain('Terminal sessions are live');
  });

  it('install-skill.bat runs the installer with --force and the arguments, and exits 0', () => {
    const copy = copyOf('bat-install');
    const ran = runBat(copy, 'install-skill.bat', ['--dry-run']);
    expect(ran.status).toBe(0);
    expect(ran.calls).toEqual(['--force --dry-run']);
    expect(ran.stdout).not.toContain('stop the app first');
  });

  it('install-skill.bat exits 1 when the installer fails', () => {
    const copy = copyOf('bat-install-fail');
    const ran = runBat(copy, 'install-skill.bat', [], { [FAKE_EXIT]: '1' });
    expect(ran.status).toBe(1);
  });

  it('install-skill.bat says to stop the app first when the instance has a state.json, and still installs', () => {
    const copy = copyOf('bat-install-running');
    const instance = join(copy.env['MCS_HOME'] ?? '', 'instances', 'user');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'state.json'), '{}');
    const ran = runBat(copy, 'install-skill.bat', []);
    expect(ran.stdout).toContain('stop the app first (caw stop; terminals end)');
    expect(ran.calls).toEqual(['--force']);
    expect(ran.status).toBe(0);
  });

  it('install-skill.bat follows %LOCALAPPDATA%\\mcs when MCS_HOME is not set', () => {
    const copy = copyOf('bat-install-default-home');
    const instance = join(copy.env['LOCALAPPDATA'] ?? '', 'mcs', 'instances', 'user');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'state.json'), '{}');
    const ran = runBat(copy, 'install-skill.bat', [], { MCS_HOME: '' });
    expect(ran.stdout).toContain('stop the app first');
  });

  it('install-skill.bat writes caw.cmd on a yes: one CRLF line, in WindowsApps, no PATH edit', () => {
    const copy = copyOf('bat-install-cmd');
    const apps = join(copy.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps');
    mkdirSync(apps, { recursive: true });
    const claude = join(copy.dir, '..', 'claude-home');
    const installed = join(claude, 'skills', FAKE_NAME, 'scripts');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'caw.mjs'), '');
    const ran = runBat(copy, 'install-skill.bat', [], { CAW_NO_PROMPT: '', CLAUDE_CONFIG_DIR: claude }, 'Y');
    expect(ran.status).toBe(0);
    const bytes = readFileSync(join(apps, 'caw.cmd')).toString('latin1');
    const launcher = join(installed, 'caw.mjs');
    expect(bytes).toBe(`@"${process.execPath}" "${launcher}" %*\r\n`);
    expect(bytes.split('\r\n')).toHaveLength(2);
    expect(bytes).not.toMatch(/PATH|setx/i);
  });

  it('install-skill.bat writes nothing on a no, and nothing for a call with arguments or under CAW_NO_PROMPT', () => {
    const copy = copyOf('bat-install-no-cmd');
    const apps = join(copy.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps');
    mkdirSync(apps, { recursive: true });
    const claude = join(copy.dir, '..', 'claude-home');
    const installed = join(claude, 'skills', FAKE_NAME, 'scripts');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'caw.mjs'), '');
    const env = { CLAUDE_CONFIG_DIR: claude };
    expect(runBat(copy, 'install-skill.bat', [], { ...env, CAW_NO_PROMPT: '' }, 'N').status).toBe(0);
    expect(existsSync(join(apps, 'caw.cmd'))).toBe(false);
    expect(runBat(copy, 'install-skill.bat', ['--dry-run'], { ...env, CAW_NO_PROMPT: '' }, 'Y').status).toBe(0);
    expect(existsSync(join(apps, 'caw.cmd'))).toBe(false);
    expect(runBat(copy, 'install-skill.bat', [], env, 'Y').status).toBe(0);
    expect(existsSync(join(apps, 'caw.cmd'))).toBe(false);
  });
});
