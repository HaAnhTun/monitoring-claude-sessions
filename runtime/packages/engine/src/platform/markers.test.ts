import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { killAllTracked, spawnTracked, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChildResult, ChildSpec } from './exec.ts';
import { pathsCaseInsensitive } from './host.ts';
import { commandLineOf } from './process.ts';
import {
  LIST_RUNTIME_END,
  LIST_RUNTIME_SCRIPT,
  RUNTIME_ENTRY,
  createRuntimeLister,
  hasLegacyMarker,
  hasRuntimeMarker,
  listRuntimeProcesses,
  matchRuntimeMarker,
  parseRuntimeCommandLine,
  splitCommandLine,
  type ListerDeps,
} from './markers.ts';

const makeTemp = useTempDirs();

const ID_A = '3f2b8c1e-5a47-4d0e-9c6a-1b2d3e4f5a6b';
const ID_B = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

afterEach(async () => {
  await killAllTracked();
});

function result(stdout: string, extra: Partial<ChildResult> = {}): ChildResult {
  return { ok: true, code: 0, stdout, stderr: '', error: null, truncated: false, durationMs: 1, ...extra };
}

/** One record of the PowerShell listing: the process id, a tab, the command line as base64 of its UTF-8 bytes. */
function wireRecord(pid: number | string, commandLine: string): string {
  return `${String(pid)}\t${Buffer.from(commandLine, 'utf8').toString('base64')}`;
}

/** What the listing script prints for `lines`: the records, then the end marker, with Windows line ends. */
function wireListing(...lines: string[]): string {
  return `${[...lines, LIST_RUNTIME_END].join('\r\n')}\r\n`;
}

/**
 * Turns plain rows (`pid<TAB>command line`, one per line) into what the listing script prints for them; a line without a
 * tab stays as it is. The scripted tests below are written with plain rows and run through the real wire format.
 */
function wire(rows: string): string {
  return wireListing(
    ...rows.split(/\r?\n/).map((line) => {
      const tab = line.indexOf('\t');
      return tab < 0 ? line : wireRecord(line.slice(0, tab), line.slice(tab + 1));
    }),
  );
}

describe('RUNTIME_ENTRY', () => {
  it('is the server entry below a runtime folder, with / separators', () => {
    expect(RUNTIME_ENTRY).toBe('/packages/server/dist/main.js');
  });
});

describe('splitCommandLine', () => {
  it('splits on whitespace and keeps a quoted argument whole', () => {
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" a "b c" --x="y z" \'q\'')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'a',
      'b c',
      '--x=y z',
      "'q'",
    ]);
  });

  it('collapses runs of whitespace and ignores leading and trailing ones', () => {
    expect(splitCommandLine('  a \t b\r\n c  ')).toEqual(['a', 'b', 'c']);
    expect(splitCommandLine('')).toEqual([]);
  });

  it('keeps an empty quoted argument and an unterminated quote to the end', () => {
    expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b']);
    expect(splitCommandLine('a "b c')).toEqual(['a', 'b c']);
  });
});

describe('matchRuntimeMarker (01 4.1: "/" normalisation, instance token, entry path)', () => {
  const win = 'D:\\skills\\mcs\\runtime\\packages\\server\\dist\\main.js';
  const line = (extra = '') =>
    `"C:\\Program Files\\nodejs\\node.exe" ${win} serve --mcs-instance=${ID_A} --instance-dir=D:\\ws\\one${extra}`;

  it('accepts a Windows command line with backslashes', () => {
    expect(matchRuntimeMarker(line(), ID_A, true)).toBe(true);
    expect(matchRuntimeMarker(line(), ID_A, false)).toBe(true);
  });

  it('accepts forward slashes and the quoted forms of the entry and of the token', () => {
    const slashed = `node D:/skills/mcs/runtime/packages/server/dist/main.js serve --mcs-instance=${ID_A}`;
    expect(matchRuntimeMarker(slashed, ID_A, true)).toBe(true);
    const quoted = `node "${win}" serve "--mcs-instance=${ID_A}" "--instance-dir=D:\\my ws"`;
    expect(matchRuntimeMarker(quoted, ID_A, true)).toBe(true);
    expect(matchRuntimeMarker(slashed, ID_A, false)).toBe(true);
  });

  it('compares case-insensitively only where the file system is', () => {
    const upper = line().replace('packages', 'PACKAGES').replace('main.js', 'Main.JS');
    expect(matchRuntimeMarker(upper, ID_A, true)).toBe(true);
    expect(matchRuntimeMarker(upper, ID_A, false)).toBe(false);
    const upperId = line().replace(ID_A, ID_A.toUpperCase());
    expect(matchRuntimeMarker(upperId, ID_A, true)).toBe(true);
    expect(matchRuntimeMarker(upperId, ID_A, false)).toBe(false);
  });

  it('rejects another instance id, including an id that only shares a prefix', () => {
    expect(matchRuntimeMarker(line(), ID_B, true)).toBe(false);
    expect(matchRuntimeMarker(line().replace(ID_A, `${ID_A}0`), ID_A, true)).toBe(false);
    expect(matchRuntimeMarker(line().replace(ID_A, ID_A.slice(0, 20)), ID_A, true)).toBe(false);
  });

  it('requires the instance as its own argument, not inside another argument or a path', () => {
    expect(matchRuntimeMarker(`node ${win} --note=--mcs-instance=${ID_A}`, ID_A, true)).toBe(false);
    expect(
      matchRuntimeMarker(`node D:\\--mcs-instance=${ID_A}\\packages\\server\\dist\\main.js serve`, ID_A, true),
    ).toBe(false);
    expect(matchRuntimeMarker(`node ${win} serve x--mcs-instance=${ID_A}`, ID_A, true)).toBe(false);
  });

  it('requires the server entry as a whole path ending: no main.js.bak, no other script', () => {
    expect(matchRuntimeMarker(`node D:\\other\\main.js serve --mcs-instance=${ID_A}`, ID_A, true)).toBe(false);
    expect(matchRuntimeMarker(`node ${win}.bak serve --mcs-instance=${ID_A}`, ID_A, true)).toBe(false);
    expect(matchRuntimeMarker(`node ${win}on serve --mcs-instance=${ID_A}`, ID_A, true)).toBe(false);
    expect(
      matchRuntimeMarker(`node D:\\x\\packages\\server\\dist\\other.js serve --mcs-instance=${ID_A}`, ID_A, true),
    ).toBe(false);
  });

  it('rejects an empty command line and an empty instance id', () => {
    expect(matchRuntimeMarker('', ID_A, true)).toBe(false);
    expect(matchRuntimeMarker(line(), '', true)).toBe(false);
  });

  it('hasRuntimeMarker is the host-case version of the same rule', () => {
    expect(hasRuntimeMarker(line(), ID_A)).toBe(true);
    expect(hasRuntimeMarker(line(), ID_B)).toBe(false);
    const upper = line().replace('packages', 'PACKAGES');
    expect(hasRuntimeMarker(upper, ID_A)).toBe(pathsCaseInsensitive);
  });
});

describe('hasLegacyMarker (legacy cli.py rule: viewer.py in the command line)', () => {
  it('finds viewer.py anywhere in the command line, case-sensitively', () => {
    expect(hasLegacyMarker('python viewer.py serve --task x')).toBe(true);
    expect(hasLegacyMarker('"C:\\Python\\python.exe" D:\\skill\\scripts\\viewer.py serve')).toBe(true);
    expect(hasLegacyMarker('python3 /opt/skill/viewer.py')).toBe(true);
    expect(hasLegacyMarker('python Viewer.PY')).toBe(false);
    expect(hasLegacyMarker('node packages/server/dist/main.js')).toBe(false);
    expect(hasLegacyMarker('')).toBe(false);
  });
});

describe('parseRuntimeCommandLine', () => {
  it('reads the instance id and the instance directory', () => {
    const parsed = parseRuntimeCommandLine(
      `node main.js serve --mcs-instance=${ID_A} --instance-dir=D:\\ws\\one --port=8800 --log-level=info`,
    );
    expect(parsed).toEqual({ instanceId: ID_A, instanceDir: 'D:\\ws\\one' });
  });

  it('reads a directory with spaces from a quoted argument', () => {
    const parsed = parseRuntimeCommandLine(`node main.js serve --mcs-instance=${ID_A} "--instance-dir=D:\\my ws\\one"`);
    expect(parsed.instanceDir).toBe('D:\\my ws\\one');
  });

  it('gives null for a missing token and takes the first of a repeated one', () => {
    expect(parseRuntimeCommandLine('node main.js serve')).toEqual({ instanceId: null, instanceDir: null });
    const twice = parseRuntimeCommandLine(`node main.js --mcs-instance=${ID_A} --mcs-instance=${ID_B}`);
    expect(twice.instanceId).toBe(ID_A);
    expect(parseRuntimeCommandLine('node main.js --mcs-instance= --instance-dir=').instanceId).toBeNull();
  });
});

describe('listRuntimeProcesses with a scripted command source', () => {
  function dirs() {
    const base = makeTemp('markers').path;
    const rt = path.join(base, 'rt');
    const rt2 = path.join(base, 'rt2');
    mkdirSync(rt);
    mkdirSync(rt2);
    const entry = (dir: string) => path.join(dir, 'packages', 'server', 'dist', 'main.js');
    return { base, rt, rt2, entry };
  }

  function lister(stdout: string, calls: ChildSpec[] = [], platform: ListerDeps['platform'] = 'win32') {
    return createRuntimeLister({
      platform,
      resolve: (name) => Promise.resolve(name === 'powershell' ? 'C:\\ps\\powershell.exe' : '/bin/ps'),
      exec: (spec) => {
        calls.push(spec);
        return Promise.resolve(result(platform === 'win32' ? wire(stdout) : stdout));
      },
      scanProc: () => Promise.resolve([]),
    });
  }

  it('lists the node processes of this runtime folder with their instance id and directory', async () => {
    const { base, rt, rt2, entry } = dirs();
    const ws = path.join(base, 'ws one');
    const out = [
      `101\t"C:\\Program Files\\nodejs\\node.exe" "${entry(rt)}" serve --mcs-instance=${ID_A} "--instance-dir=${ws}" --port=8800`,
      `102\tnode ${entry(rt2)} serve --mcs-instance=${ID_B} --instance-dir=${base}`,
      `103\tnode ${path.join(base, 'other', 'main.js')} serve --mcs-instance=${ID_A}`,
      `104\tnode ${entry(rt)} serve`,
      `105\tnode -e "console.log(1)"`,
    ].join('\r\n');
    const found = await lister(out)(rt);
    expect(found).toEqual([
      { pid: 101, instanceId: ID_A, instanceDir: ws },
      { pid: 104, instanceId: null, instanceDir: null },
    ]);
    expect(await lister(out)(rt2)).toEqual([{ pid: 102, instanceId: ID_B, instanceDir: base }]);
    expect(await lister(out)(path.join(base, 'unrelated'))).toEqual([]);
  });

  it('does not mix up a runtime folder with one that only shares its prefix', async () => {
    const { base, rt, rt2, entry } = dirs();
    const out = `7\tnode ${entry(rt2)} serve --mcs-instance=${ID_A} --instance-dir=${base}`;
    expect(await lister(out)(rt)).toEqual([]);
  });

  it('matches the runtime folder case-insensitively where the file system is', async () => {
    const { base, rt, entry } = dirs();
    const out = `8\tnode ${entry(rt.toUpperCase())} serve --mcs-instance=${ID_A} --instance-dir=${base}`;
    const found = await lister(out)(rt);
    expect(found.length).toBe(pathsCaseInsensitive ? 1 : 0);
  });

  it('ignores garbage: no tab, a bad pid, blank lines, an empty command line', async () => {
    const { rt, entry } = dirs();
    const out = [
      '',
      'no tab here',
      `abc\tnode ${entry(rt)} --mcs-instance=${ID_A}`,
      `0\tnode ${entry(rt)} --mcs-instance=${ID_A}`,
      `-5\tnode ${entry(rt)} --mcs-instance=${ID_A}`,
      `12345678901\tnode ${entry(rt)} --mcs-instance=${ID_A}`,
      '77\t',
      '   ',
    ].join('\n');
    expect(await lister(out)(rt)).toEqual([]);
  });

  it('lists a process once even when the listing repeats it', async () => {
    const { base, rt, entry } = dirs();
    const row = `9\tnode ${entry(rt)} serve --mcs-instance=${ID_A} --instance-dir=${base}`;
    expect(await lister(`${row}\n${row}`)(rt)).toHaveLength(1);
  });

  it('runs one constant -EncodedCommand PowerShell script of kind powershell.cmdline, with no runtime folder in it', async () => {
    const { rt } = dirs();
    const calls: ChildSpec[] = [];
    await lister('', calls)(rt);
    expect(calls).toHaveLength(1);
    const [spec] = calls;
    expect(spec).toMatchObject({
      kind: 'powershell.cmdline',
      file: 'C:\\ps\\powershell.exe',
      timeoutMs: 20_000,
      maxOutputBytes: 1_048_576,
      encoding: 'utf8',
    });
    const args = spec?.args ?? [];
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(args[4]).toBe('-EncodedCommand');
    const script = Buffer.from(args[5] ?? '', 'base64').toString('utf16le');
    expect(script).toBe(LIST_RUNTIME_SCRIPT);
    expect(script).toContain("Name='node.exe'");
    expect(script).not.toContain(rt);
    // A command line may hold line breaks and tabs: it travels as base64, never as text. A failing query ends the script.
    expect(script).toContain('ToBase64String');
    expect(script).toContain(`'${LIST_RUNTIME_END}'`);
    expect(script).toContain("$ErrorActionPreference='Stop'");
    expect(script).not.toContain('SilentlyContinue');
    expect(spec?.stdin).toBeUndefined();
  });

  it('fails loudly when the listing cannot run: an empty answer would wrongly allow npm ci', async () => {
    const { rt } = dirs();
    const failing = createRuntimeLister({
      platform: 'win32',
      resolve: () => Promise.resolve('C:\\ps\\powershell.exe'),
      exec: () => Promise.resolve(result('', { ok: false, code: null, error: 'TIMEOUT' })),
      scanProc: () => Promise.resolve([]),
    });
    const error = await failing(rt).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'INTERNAL' });

    const missing = createRuntimeLister({
      platform: 'win32',
      resolve: () => Promise.resolve(null),
      exec: () => Promise.resolve(result('')),
      scanProc: () => Promise.resolve([]),
    });
    await expect(missing(rt)).rejects.toBeInstanceOf(McsError);
  });

  it('on macOS reads ps -axo pid=,command= through kind ps', async () => {
    const { base, rt, entry } = dirs();
    const calls: ChildSpec[] = [];
    const out = [
      `  310 /usr/local/bin/node ${entry(rt)} serve --mcs-instance=${ID_A} --instance-dir=${base}`,
      '  311 /bin/zsh',
    ].join('\n');
    const found = await lister(out, calls, 'darwin')(rt);
    expect(found).toEqual([{ pid: 310, instanceId: ID_A, instanceDir: base }]);
    expect(calls[0]).toMatchObject({ kind: 'ps', file: '/bin/ps', args: ['-axo', 'pid=,command='] });
  });

  it('on Linux uses the /proc scan and quotes arguments that contain spaces', async () => {
    const { base, rt, entry } = dirs();
    const ws = path.join(base, 'my ws');
    const lister2 = createRuntimeLister({
      platform: 'linux',
      resolve: () => Promise.resolve(null),
      exec: () => Promise.reject(new Error('no process must be spawned on Linux')),
      scanProc: () =>
        Promise.resolve([
          { pid: 500, argv: ['/usr/bin/node', entry(rt), 'serve', `--mcs-instance=${ID_A}`, `--instance-dir=${ws}`] },
          { pid: 501, argv: ['/usr/bin/node', '-e', '1'] },
        ]),
    });
    expect(await lister2(rt)).toEqual([{ pid: 500, instanceId: ID_A, instanceDir: ws }]);
  });
});

describe('listRuntimeProcesses: the PowerShell listing format (base64 records and an end marker)', () => {
  const base = (): { rt: string; ws: string; entry: string } => {
    const root = makeTemp('markers').path;
    const rt = path.join(root, 'rt');
    const ws = path.join(root, 'ws');
    mkdirSync(rt);
    mkdirSync(ws);
    return { rt, ws, entry: path.join(rt, 'packages', 'server', 'dist', 'main.js') };
  };

  function rawLister(stdout: string, extra: Partial<ChildResult> = {}) {
    return createRuntimeLister({
      platform: 'win32',
      resolve: () => Promise.resolve('C:\\ps\\powershell.exe'),
      exec: () => Promise.resolve(result(stdout, extra)),
      scanProc: () => Promise.resolve([]),
    });
  }

  it('decodes the command line from UTF-8, including non-ASCII text and a line break', async () => {
    const { rt, entry } = base();
    const ws = path.join(path.dirname(rt), `w${String.fromCodePoint(0xe9, 0x20, 0x4e2d, 0x6587)}`);
    const out = wireListing(
      wireRecord(11, `node "${entry}"\nserve --mcs-instance=${ID_A} "--instance-dir=${ws}"`),
      wireRecord(12, 'node -e 1'),
    );
    expect(await rawLister(out)(rt)).toEqual([{ pid: 11, instanceId: ID_A, instanceDir: ws }]);
  });

  it('cannot be forged by a line break, a tab and a fake row inside an argument', async () => {
    const { rt, ws, entry } = base();
    const forged = `\n987654321\t${entry} serve --mcs-instance=${ID_B} --instance-dir=${ws}`;
    const out = wireListing(
      wireRecord(21, `node "${entry}" serve --mcs-instance=${ID_A} --instance-dir=${ws}`),
      wireRecord(22, `node -e "setInterval(() => undefined, 1000)" "${forged}"`),
    );
    const found = await rawLister(out)(rt);
    expect(found).toEqual([{ pid: 21, instanceId: ID_A, instanceDir: ws }]);
  });

  it('ignores a plain-text row that tries to pass as a record, and everything after the end marker', async () => {
    const { rt, ws, entry } = base();
    const out = [
      'WARNING: something the host printed',
      `987654321\tnode ${entry} serve --mcs-instance=${ID_B} --instance-dir=${ws}`,
      '31\t!!not base64!!',
      '32\tabc',
      wireRecord(33, `node "${entry}" serve --mcs-instance=${ID_A} --instance-dir=${ws}`),
      LIST_RUNTIME_END,
      wireRecord(34, `node "${entry}" serve --mcs-instance=${ID_B} --instance-dir=${ws}`),
      '',
    ].join('\r\n');
    expect(await rawLister(out)(rt)).toEqual([{ pid: 33, instanceId: ID_A, instanceDir: ws }]);
  });

  it('answers an empty list when the listing ran to the end and found no node process', async () => {
    const { rt } = base();
    expect(await rawLister(wireListing())(rt)).toEqual([]);
  });

  it('fails when the end marker is missing: a silent failure (exit 0, no output) must not look like "no process"', async () => {
    const { rt, ws, entry } = base();
    const record = wireRecord(41, `node "${entry}" serve --mcs-instance=${ID_A} --instance-dir=${ws}`);
    for (const stdout of ['', '\r\n', `${record}\r\n`, `${record}\r\nMCS-LIST-EN`, `${LIST_RUNTIME_END}x\r\n`]) {
      const error = await rawLister(stdout)(rt).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(stdout)).toBeInstanceOf(McsError);
      expect(error, JSON.stringify(stdout)).toMatchObject({ code: 'INTERNAL' });
      expect(error instanceof Error ? error.message : '').toContain('end');
    }
  });
});

describe('listRuntimeProcesses with real processes', () => {
  /** A stand-in server: a script at <runtime>/packages/server/dist/main.js that idles. */
  function standIn(runtimeDir: string): string {
    const file = path.join(runtimeDir, 'packages', 'server', 'dist', 'main.js');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'setInterval(() => undefined, 1000);\n');
    return file;
  }

  it('finds a spawned marker process and neither an impostor nor a process of another runtime', async () => {
    const base = makeTemp('markers').path;
    const rtA = path.join(base, 'runtime-a');
    const rtB = path.join(base, 'runtime-b');
    const wsA = path.join(base, 'ws-a');
    const wsB = path.join(base, 'ws-b');
    mkdirSync(wsA);
    mkdirSync(wsB);
    const entryA = standIn(rtA);
    const entryB = standIn(rtB);

    const real = spawnTracked(process.execPath, [entryA, 'serve', `--mcs-instance=${ID_A}`, `--instance-dir=${wsA}`]);
    const other = spawnTracked(process.execPath, [entryB, 'serve', `--mcs-instance=${ID_B}`, `--instance-dir=${wsB}`]);
    // Impostor 1: the right instance id but a script that is not the runtime entry.
    const impostorFile = path.join(base, 'impostor.js');
    writeFileSync(impostorFile, 'setInterval(() => undefined, 1000);\n');
    const impostor = spawnTracked(process.execPath, [
      impostorFile,
      'serve',
      `--mcs-instance=${ID_A}`,
      `--instance-dir=${wsA}`,
    ]);
    // Impostor 2: a script inside the runtime folder that is not packages/server/dist/main.js.
    const inside = path.join(rtA, 'packages', 'server', 'dist', 'other.js');
    writeFileSync(inside, 'setInterval(() => undefined, 1000);\n');
    const insideProc = spawnTracked(process.execPath, [inside, 'serve', `--mcs-instance=${ID_A}`]);

    const found = await waitFor(
      async () => {
        const list = await listRuntimeProcesses(rtA);
        return list.some((entry) => entry.pid === real.pid) ? list : null;
      },
      { timeoutMs: 20_000, intervalMs: 200, what: 'the stand-in server in the process listing' },
    );
    expect(found.map((entry) => entry.pid)).toEqual([real.pid]);
    expect(found[0]?.instanceId).toBe(ID_A);
    expect(found[0]?.instanceDir).toBe(wsA);
    expect(found.map((entry) => entry.pid)).not.toContain(impostor.pid);
    expect(found.map((entry) => entry.pid)).not.toContain(insideProc.pid);
    expect(found.map((entry) => entry.pid)).not.toContain(other.pid);

    const foundB = await listRuntimeProcesses(rtB);
    expect(foundB.map((entry) => entry.pid)).toEqual([other.pid]);
    expect(await listRuntimeProcesses(path.join(base, 'no-runtime'))).toEqual([]);
  }, 60_000);

  it('a real process whose argument holds a line break and a fake row adds no phantom pid to the listing', async () => {
    const base = makeTemp('markers').path;
    const rt = path.join(base, 'runtime');
    const ws = path.join(base, 'ws');
    mkdirSync(ws);
    const entry = standIn(rt);
    const phantomPid = 987_654_321;
    const forged = `\n${String(phantomPid)}\t${entry} serve --mcs-instance=${ID_B} --instance-dir=${ws}`;
    const decoy = spawnTracked(process.execPath, ['-e', 'setInterval(() => undefined, 1000)', forged]);
    const real = spawnTracked(process.execPath, [entry, 'serve', `--mcs-instance=${ID_A}`, `--instance-dir=${ws}`]);

    const found = await waitFor(
      async () => {
        const list = await listRuntimeProcesses(rt);
        return list.some((item) => item.pid === real.pid) ? list : null;
      },
      { timeoutMs: 20_000, intervalMs: 200, what: 'the stand-in server in the process listing' },
    );
    expect(found).toEqual([{ pid: real.pid, instanceId: ID_A, instanceDir: ws }]);
    // The decoy was running while the listing ran (it was started first), so the absence of its fake row is not luck.
    expect(await commandLineOf(decoy.pid)).toContain(String(phantomPid));
  }, 60_000);

  it('commandLineOf plus hasRuntimeMarker tell the runtime from an impostor: the check before every kill', async () => {
    const base = makeTemp('markers').path;
    const entry = standIn(path.join(base, 'runtime'));
    const ws = path.join(base, 'ws');
    mkdirSync(ws);
    const idle = path.join(base, 'idle.js');
    writeFileSync(idle, 'setInterval(() => undefined, 1000);\n');

    const server = spawnTracked(process.execPath, [entry, 'serve', `--mcs-instance=${ID_A}`, `--instance-dir=${ws}`]);
    const wrongInstance = spawnTracked(process.execPath, [
      entry,
      'serve',
      `--mcs-instance=${ID_B}`,
      `--instance-dir=${ws}`,
    ]);
    const noMarker = spawnTracked(process.execPath, [idle, 'serve', `--instance-dir=${ws}`]);
    const legacy = spawnTracked(process.execPath, [idle, 'viewer.py', 'serve']);

    const serverLine = (await commandLineOf(server.pid)) ?? '';
    const wrongLine = (await commandLineOf(wrongInstance.pid)) ?? '';
    const noMarkerLine = (await commandLineOf(noMarker.pid)) ?? '';
    const legacyLine = (await commandLineOf(legacy.pid)) ?? '';

    expect(hasRuntimeMarker(serverLine, ID_A)).toBe(true);
    expect(hasRuntimeMarker(serverLine, ID_B)).toBe(false);
    expect(hasRuntimeMarker(wrongLine, ID_A)).toBe(false);
    expect(hasRuntimeMarker(wrongLine, ID_B)).toBe(true);
    expect(hasRuntimeMarker(noMarkerLine, ID_A)).toBe(false);
    expect(hasRuntimeMarker(noMarkerLine, ID_B)).toBe(false);
    expect(hasRuntimeMarker(legacyLine, ID_A)).toBe(false);
    expect(hasLegacyMarker(legacyLine)).toBe(true);
    expect(hasLegacyMarker(serverLine)).toBe(false);
    expect(hasLegacyMarker(noMarkerLine)).toBe(false);
  }, 60_000);
});
