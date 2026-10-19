// The file side of the installer: scope paths, the test guard (T-IN-07 at its lowest layer), the io seams and the backups
// (T-IN-06). Nothing here opens a real settings file: the guard cases use path strings that are only resolved.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McsError, type HooksScope } from '@mcs/shared';
import type { EnvLike } from '@mcs/shared/protocol';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { pathsCaseInsensitive } from '../../platform/host.ts';
import {
  BACKUPS_KEPT,
  RENAME_RETRIES,
  RENAME_RETRY_DELAY_MS,
  SETTINGS_MAX_BYTES,
  assertNotRealInTest,
  assertScopeAllowed,
  backupFolder,
  decodeSettings,
  displayPath,
  encodeSettings,
  isTestMode,
  realSettingsIo,
  renameWithRetry,
  settingsPathFor,
  sha256Hex,
  tempPathFor,
  writeBackup,
  type GuardInput,
  type SettingsIo,
} from './settings-io.ts';

const makeTemp = useTempDirs();
const BOM = String.fromCharCode(0xfeff);

function failure(run: () => unknown): McsError {
  try {
    run();
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected a McsError');
}

async function failureOf(run: () => Promise<unknown>): Promise<McsError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected a McsError');
}

/** The guards return nothing; these wrappers return `null`, so a test can hand them over as an arrow shorthand. */
function guard(input: GuardInput): null {
  assertNotRealInTest(input);
  return null;
}

function scopeCheck(scope: HooksScope, file: string, env: EnvLike): null {
  assertScopeAllowed(scope, file, env);
  return null;
}

function reasonOf(error: McsError): unknown {
  return error.details?.['reason'];
}

describe('settingsPathFor (02 3.2)', () => {
  it('puts the project-local file in .claude/settings.local.json of the repository', () => {
    const repo = path.join(makeTemp('sp').path, 'repo');
    expect(settingsPathFor('project-local', { repoRoot: repo, env: {} })).toBe(
      path.join(repo, '.claude', 'settings.local.json'),
    );
  });

  it('needs a repository for the project-local scope', () => {
    expect(failure(() => settingsPathFor('project-local', { env: {} })).code).toBe('USAGE');
    expect(failure(() => settingsPathFor('project-local', { repoRoot: '', env: {} })).code).toBe('USAGE');
  });

  it('puts the user file in CLAUDE_CONFIG_DIR when it is set', () => {
    const dir = path.join(makeTemp('sp').path, 'claude-home');
    expect(settingsPathFor('user', { env: { CLAUDE_CONFIG_DIR: dir } })).toBe(path.join(dir, 'settings.json'));
  });

  it('puts the user file in .claude of the home folder otherwise (a string, never opened)', () => {
    expect(settingsPathFor('user', { env: {} })).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });

  it('refuses the shared project scope and an unknown scope', () => {
    const project = failure(() => settingsPathFor('project', { env: {} }));
    expect(project.code).toBe('HOOKS_FAILED');
    expect(reasonOf(project)).toBe('SCOPE_NOT_ALLOWED');
    expect(reasonOf(failure(() => settingsPathFor('global', { env: {} })))).toBe('SCOPE_NOT_ALLOWED');
  });
});

describe('assertScopeAllowed: --settings-file never names the shared project file', () => {
  const env = { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'FIXTURE-claude-home') };

  it('refuses <folder>/.claude/settings.json for an explicit file', () => {
    const shared = path.join(os.tmpdir(), 'FIXTURE-repo', '.claude', 'settings.json');
    expect(reasonOf(failure(() => scopeCheck('file', shared, env)))).toBe('SCOPE_NOT_ALLOWED');
  });

  it('accepts settings.local.json, other names and other scopes', () => {
    const base = path.join(os.tmpdir(), 'FIXTURE-repo', '.claude');
    expect(() => scopeCheck('file', path.join(base, 'settings.local.json'), env)).not.toThrow();
    expect(() => scopeCheck('file', path.join(os.tmpdir(), 'FIXTURE-repo', 'settings.json'), env)).not.toThrow();
    expect(() => scopeCheck('project-local', path.join(base, 'settings.json'), env)).not.toThrow();
  });

  it('accepts the user settings file even when the config folder is called .claude', () => {
    const claude = path.join(os.tmpdir(), 'FIXTURE-home', '.claude');
    expect(() => scopeCheck('file', path.join(claude, 'settings.json'), { CLAUDE_CONFIG_DIR: claude })).not.toThrow();
  });
});

describe('displayPath (02 3.5 step 12)', () => {
  it('writes ~/<path> inside the home folder and the absolute path with slashes outside it', () => {
    const home = path.join(makeTemp('dp').path, 'home');
    expect(displayPath(path.join(home, '.claude', 'settings.json'), home)).toBe('~/.claude/settings.json');
    const outside = path.join(makeTemp('dp').path, 'elsewhere', 'settings.local.json');
    expect(displayPath(outside, home)).toBe(outside.replaceAll('\\', '/'));
    expect(displayPath(home, home)).toBe(home.replaceAll('\\', '/'));
  });
});

describe('isTestMode', () => {
  it('is on for MCS_TEST=1 or a set VITEST, and off for anything else', () => {
    expect(isTestMode({ MCS_TEST: '1' })).toBe(true);
    expect(isTestMode({ VITEST: 'true' })).toBe(true);
    expect(isTestMode({ MCS_TEST: '', VITEST: '' })).toBe(false);
    expect(isTestMode({ MCS_TEST: 'true' })).toBe(false);
    expect(isTestMode({ MCS_TEST: '0' })).toBe(false);
    expect(isTestMode({})).toBe(false);
  });
});

describe('T-IN-07 the test guard: real settings paths are refused in test mode, before any file is looked at', () => {
  // Path strings built at run time. They lie outside the temporary folder and are only resolved, never opened.
  const outsideRoot = path.join(path.parse(os.tmpdir()).root, 'FIXTURE-not-the-temp-folder');
  const realLooking = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(outsideRoot, 'repo', '.claude', 'settings.json'),
    path.join(outsideRoot, 'repo', '.claude', 'settings.local.json'),
  ];

  for (const mode of [{ MCS_TEST: '1' }, { VITEST: 'true' }]) {
    for (const file of realLooking) {
      it(`${Object.keys(mode).join('')}: refuses ${path.basename(file)} outside the temporary folder`, () => {
        const error = failure(() => guard({ env: mode, targets: [{ label: 'settings file', path: file }] }));
        expect(error.code).toBe('HOOKS_FAILED');
        expect(reasonOf(error)).toBe('REAL_SETTINGS_IN_TEST');
      });
    }
  }

  it('refuses a MCS_HOME outside the temporary folder, and names it', () => {
    const inside = path.join(makeTemp('guard').path, 'settings.json');
    const error = failure(() =>
      guard({
        env: { MCS_TEST: '1' },
        targets: [
          { label: 'settings file', path: inside },
          { label: 'MCS_HOME', path: path.join(outsideRoot, 'mcs') },
        ],
      }),
    );
    expect(error.message).toContain('MCS_HOME');
    expect(reasonOf(error)).toBe('REAL_SETTINGS_IN_TEST');
  });

  it('accepts paths below the temporary folder, existing or not', () => {
    const root = makeTemp('guard').path;
    expect(() =>
      guard({
        env: { MCS_TEST: '1' },
        targets: [
          { label: 'settings file', path: path.join(root, 'a', 'b', 'settings.json') },
          { label: 'MCS_HOME', path: path.join(root, 'mcs-home') },
        ],
      }),
    ).not.toThrow();
  });

  it('does not accept the temporary folder itself', () => {
    expect(
      reasonOf(failure(() => guard({ env: { MCS_TEST: '1' }, targets: [{ label: 'x', path: os.tmpdir() }] }))),
    ).toBe('REAL_SETTINGS_IN_TEST');
  });

  it('does not accept a folder whose name only starts like the temporary folder', () => {
    const root = makeTemp('guard').path;
    const sibling = `${root}-sibling`;
    const narrow = { env: { MCS_TEST: '1' }, tmpdir: () => root };
    expect(reasonOf(failure(() => guard({ ...narrow, targets: [{ label: 'x', path: sibling }] })))).toBe(
      'REAL_SETTINGS_IN_TEST',
    );
  });

  it('does nothing when test mode is off', () => {
    expect(() => guard({ env: {}, targets: realLooking.map((file) => ({ label: 'x', path: file })) })).not.toThrow();
    expect(() =>
      guard({ env: { MCS_TEST: '' }, targets: realLooking.map((file) => ({ label: 'x', path: file })) }),
    ).not.toThrow();
  });

  it('judges a path by its real location: a link inside the narrowed folder that leads outside is refused', () => {
    const root = makeTemp('guard').path;
    const narrow = path.join(root, 'tmp');
    const outside = path.join(root, 'outside');
    mkdirSync(narrow);
    mkdirSync(outside);
    makeJunction(path.join(narrow, 'link'), outside);
    const env = { MCS_TEST: '1' };
    const viaLink = failure(() =>
      guard({
        env,
        tmpdir: () => narrow,
        targets: [{ label: 'settings file', path: path.join(narrow, 'link', 'settings.json') }],
      }),
    );
    expect(reasonOf(viaLink)).toBe('REAL_SETTINGS_IN_TEST');
    // the same file by its real spelling is outside, and a plain file in the narrow folder is inside
    expect(() =>
      guard({
        env,
        tmpdir: () => narrow,
        targets: [{ label: 'x', path: path.join(narrow, 'settings.json') }],
      }),
    ).not.toThrow();
    expect(
      reasonOf(
        failure(() =>
          guard({
            env,
            tmpdir: () => narrow,
            targets: [{ label: 'x', path: path.join(outside, 'settings.json') }],
          }),
        ),
      ),
    ).toBe('REAL_SETTINGS_IN_TEST');
  });

  it('compares real paths on both sides: a temporary folder spelled through a link accepts the real spelling', () => {
    const root = makeTemp('guard').path;
    const real = path.join(root, 'real');
    mkdirSync(real);
    const alias = path.join(root, 'alias');
    makeJunction(alias, real);
    const env = { MCS_TEST: '1' };
    // the temporary folder is a link (the system gives /var on macOS, a short name on Windows); the file has the real spelling
    const realSpelling = realpathSync.native(real);
    expect(() =>
      guard({
        env,
        tmpdir: () => alias,
        targets: [{ label: 'x', path: path.join(realSpelling, 'settings.json') }],
      }),
    ).not.toThrow();
    // and a path that is neither spelled like the folder nor like its real path is refused (the guard fails closed)
    expect(
      reasonOf(
        failure(() =>
          guard({
            env,
            tmpdir: () => alias,
            targets: [{ label: 'x', path: path.join(root, 'other', 'settings.json') }],
          }),
        ),
      ),
    ).toBe('REAL_SETTINGS_IN_TEST');
  });

  it('accepts the spelling in the other letter case where the file system ignores case', () => {
    const root = makeTemp('guard').path;
    const target = path.join(root, 'Settings.JSON');
    const swapped = target.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const run = (): void => {
      guard({ env: { MCS_TEST: '1' }, tmpdir: () => root, targets: [{ label: 'x', path: swapped }] });
    };
    if (pathsCaseInsensitive) expect(run).not.toThrow();
    else expect(run).toThrow();
  });
});

describe('encoding', () => {
  it('keeps the byte order mark as a character and round-trips the bytes', () => {
    // a multi-byte character built at run time (no non-ASCII text in the source)
    const wide = String.fromCodePoint(0x1f642);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"a":"${wide}"}`, 'utf8')]);
    const text = decodeSettings(bytes);
    expect(text.startsWith(BOM)).toBe(true);
    expect(text).toContain(wide);
    expect(encodeSettings(text).equals(bytes)).toBe(true);
  });

  it('refuses bytes that are not UTF-8 text', () => {
    const error = failure(() => decodeSettings(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
    expect(reasonOf(error)).toBe('SETTINGS_INVALID_JSON');
  });
});

describe('realSettingsIo.read', () => {
  const io = realSettingsIo;

  it('answers null bytes for a missing file', async () => {
    const file = path.join(makeTemp('io').path, 'settings.json');
    expect(await io.read(file)).toEqual({ target: file, bytes: null, sha256: null, mode: null });
  });

  it('reads the bytes, their hash and the permission bits', async () => {
    const file = path.join(makeTemp('io').path, 'settings.json');
    writeFileSync(file, '{"a":1}\n');
    const snap = await io.read(file);
    expect(snap.target).toBe(file);
    expect(snap.bytes?.toString('utf8')).toBe('{"a":1}\n');
    expect(snap.sha256).toBe(createHash('sha256').update('{"a":1}\n').digest('hex'));
    expect(snap.mode).toBe(statSync(file).mode & 0o777);
  });

  it('refuses a folder, and a file above 8 MiB, as unreadable', async () => {
    const root = makeTemp('io').path;
    expect(reasonOf(await failureOf(() => io.read(root)))).toBe('SETTINGS_UNREADABLE');
    const big = path.join(root, 'big.json');
    writeFileSync(big, Buffer.alloc(SETTINGS_MAX_BYTES + 1, 0x20));
    expect(reasonOf(await failureOf(() => io.read(big)))).toBe('SETTINGS_UNREADABLE');
  });

  it('follows a link to the real file, which is then the target', async () => {
    const root = makeTemp('io').path;
    const real = path.join(root, 'real.json');
    const link = path.join(root, 'link.json');
    writeFileSync(real, '{}');
    try {
      symlinkSync(real, link, 'file');
    } catch {
      return; // no privilege for file links on this machine: the link cases of the integration suite are skipped the same way
    }
    const snap = await io.read(link);
    expect(path.resolve(snap.target).toLowerCase()).toBe(path.resolve(real).toLowerCase());
    expect(snap.bytes?.toString('utf8')).toBe('{}');
  });

  it('refuses a link that leads nowhere', async () => {
    const root = makeTemp('io').path;
    const link = path.join(root, 'link.json');
    try {
      symlinkSync(path.join(root, 'missing.json'), link, 'file');
    } catch {
      return;
    }
    expect(reasonOf(await failureOf(() => io.read(link)))).toBe('SETTINGS_UNREADABLE');
  });
});

describe('realSettingsIo writing', () => {
  const io = realSettingsIo;

  it('creates the temporary file exclusively with the bytes given, and never reuses one', async () => {
    const root = makeTemp('io').path;
    const tmp = path.join(root, '.settings.json.tmp');
    await io.writeTemp(tmp, Buffer.from('FIXTURE bytes'), 0o600);
    expect(readFileSync(tmp, 'utf8')).toBe('FIXTURE bytes');
    await expect(io.writeTemp(tmp, Buffer.from('other'), 0o600)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(tmp, 'utf8')).toBe('FIXTURE bytes');
  });

  it.skipIf(process.platform === 'win32')('gives the temporary file the permission bits asked for', async () => {
    const root = makeTemp('io').path;
    const tmp = path.join(root, '.settings.json.tmp');
    await io.writeTemp(tmp, Buffer.from('x'), 0o600);
    expect(statSync(tmp).mode & 0o777).toBe(0o600);
  });

  it('renames over an existing file, reads a file back, and removes quietly', async () => {
    const root = makeTemp('io').path;
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    writeFileSync(a, 'new');
    writeFileSync(b, 'old');
    await io.rename(a, b);
    expect((await io.readBack(b))?.toString('utf8')).toBe('new');
    expect(existsSync(a)).toBe(false);
    expect(await io.readBack(a)).toBeNull();
    await io.remove(b);
    await io.remove(b);
    expect(existsSync(b)).toBe(false);
  });

  it('creates folders on the way', async () => {
    const dir = path.join(makeTemp('io').path, 'a', 'b');
    await io.ensureDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('checkWritable passes for a normal file and names a read-only one', async () => {
    const root = makeTemp('io').path;
    const file = path.join(root, 'settings.json');
    writeFileSync(file, '{}');
    await expect(io.checkWritable(file)).resolves.toBeUndefined();
    chmodSync(file, 0o444);
    try {
      expect(reasonOf(await failureOf(() => io.checkWritable(file)))).toBe('SETTINGS_NOT_WRITABLE');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('temp names sit next to the target, are dot files and differ from run to run', () => {
    const target = path.join(makeTemp('io').path, 'settings.json');
    const one = tempPathFor(target);
    expect(path.dirname(one)).toBe(path.dirname(target));
    expect(path.basename(one)).toMatch(/^\.settings\.json\.mcs-\d+-[0-9a-f]{6}\.tmp$/);
    expect(tempPathFor(target)).not.toBe(one);
  });
});

describe('renameWithRetry (02 3.5 step 9, T-IN-05)', () => {
  function fakeIo(failures: (string | null)[]): { io: SettingsIo; calls: string[]; sleeps: number[] } {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const io: SettingsIo = {
      ...realSettingsIo,
      rename: (from, to) => {
        calls.push(`${from}>${to}`);
        const code = failures.shift();
        if (code === undefined || code === null) return Promise.resolve();
        return Promise.reject(Object.assign(new Error(code), { code }));
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
    return { io, calls, sleeps };
  }

  it('succeeds at once when nothing is in the way', async () => {
    const { io, calls, sleeps } = fakeIo([]);
    await renameWithRetry(io, 'a', 'b');
    expect(calls).toEqual(['a>b']);
    expect(sleeps).toEqual([]);
  });

  it('retries a sharing violation (EPERM three times, then success) 50 ms apart', async () => {
    const { io, calls, sleeps } = fakeIo(['EPERM', 'EPERM', 'EPERM']);
    await renameWithRetry(io, 'a', 'b');
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([50, 50, 50]);
  });

  it('retries EBUSY and EACCES as well', async () => {
    const { io, calls } = fakeIo(['EBUSY', 'EACCES']);
    await renameWithRetry(io, 'a', 'b');
    expect(calls).toHaveLength(3);
  });

  it('gives up after ten retries with RENAME_FAILED', async () => {
    const { io, calls, sleeps } = fakeIo(Array.from({ length: 50 }, () => 'EPERM'));
    const error = await failureOf(() => renameWithRetry(io, 'a', path.join('x', 'settings.json')));
    expect(reasonOf(error)).toBe('RENAME_FAILED');
    expect(calls).toHaveLength(RENAME_RETRIES + 1);
    expect(sleeps).toEqual(Array.from({ length: RENAME_RETRIES }, () => RENAME_RETRY_DELAY_MS));
  });

  it('does not retry another error', async () => {
    const { io, calls, sleeps } = fakeIo(['ENOENT']);
    const error = await failureOf(() => renameWithRetry(io, 'a', 'b'));
    expect(reasonOf(error)).toBe('RENAME_FAILED');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe('T-IN-06 backups', () => {
  const T0 = Date.UTC(2026, 9, 11, 14, 5, 7, 100);

  function setup(): { mcsHome: string; settingsPath: string } {
    const root = makeTemp('backup').path;
    return { mcsHome: path.join(root, 'mcs-home'), settingsPath: path.join(root, 'claude', 'settings.json') };
  }

  it('writes the original bytes, byte for byte, under backups/settings/<sha8 of the path>/<UTC time>-<op>.json', async () => {
    const { mcsHome, settingsPath } = setup();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n\t"a": 1\r\n}\r\n')]);
    const file = await writeBackup({ mcsHome, settingsPath, op: 'install', bytes, nowMs: T0 });
    expect(path.dirname(file)).toBe(backupFolder(mcsHome, settingsPath));
    expect(path.dirname(file)).toMatch(/[\\/]backups[\\/]settings[\\/][0-9a-f]{8}$/);
    expect(path.basename(file)).toBe('20261011T140507Z-install.json');
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it('records the backup in index.jsonl', async () => {
    const { mcsHome, settingsPath } = setup();
    const bytes = Buffer.from('{"a":1}');
    const file = await writeBackup({ mcsHome, settingsPath, op: 'uninstall', bytes, nowMs: T0 });
    const lines = readFileSync(path.join(path.dirname(file), 'index.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      path: path.resolve(settingsPath).replaceAll('\\', '/'),
      at: T0,
      op: 'uninstall',
      sha256: sha256Hex(bytes),
      backup: path.basename(file),
    });
  });

  it('keeps the newest 20 backups of a file and prunes the rest, in the index too', async () => {
    const { mcsHome, settingsPath } = setup();
    const files: string[] = [];
    for (let i = 0; i < BACKUPS_KEPT + 5; i += 1) {
      files.push(
        await writeBackup({
          mcsHome,
          settingsPath,
          op: 'install',
          bytes: Buffer.from(`v${String(i)}`),
          nowMs: T0 + i * 1000,
        }),
      );
    }
    const dir = backupFolder(mcsHome, settingsPath);
    const kept = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(kept).toHaveLength(20);
    expect(existsSync(files[4] ?? '')).toBe(false);
    expect(existsSync(files[5] ?? '')).toBe(true);
    expect(readFileSync(files[24] ?? '', 'utf8')).toBe('v24');
    const index = readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n');
    expect(index).toHaveLength(20);
    expect(index[19]).toContain(path.basename(files[24] ?? ''));
  });

  it('numbers backups made in one second so that the order stays that of time', async () => {
    const { mcsHome, settingsPath } = setup();
    const a = await writeBackup({ mcsHome, settingsPath, op: 'install', bytes: Buffer.from('a'), nowMs: T0 });
    const b = await writeBackup({ mcsHome, settingsPath, op: 'uninstall', bytes: Buffer.from('b'), nowMs: T0 + 5 });
    const c = await writeBackup({ mcsHome, settingsPath, op: 'install', bytes: Buffer.from('c'), nowMs: T0 + 9 });
    expect([a, b, c].map((file) => path.basename(file))).toEqual([
      '20261011T140507Z-install.json',
      '20261011T140507Z-uninstall-2.json',
      '20261011T140507Z-install-3.json',
    ]);
    expect(readFileSync(b, 'utf8')).toBe('b');
    // with the cap lowered the oldest of the three goes first
    const d = await writeBackup({
      mcsHome,
      settingsPath,
      op: 'install',
      bytes: Buffer.from('d'),
      nowMs: T0 + 20,
      keep: 2,
    });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(true);
    expect(existsSync(d)).toBe(true);
  });

  it('gives each settings file its own folder and leaves foreign files in the folder alone', async () => {
    const { mcsHome, settingsPath } = setup();
    const other = path.join(path.dirname(settingsPath), 'other.json');
    expect(backupFolder(mcsHome, other)).not.toBe(backupFolder(mcsHome, settingsPath));
    const file = await writeBackup({ mcsHome, settingsPath, op: 'install', bytes: Buffer.from('a'), nowMs: T0 });
    const note = path.join(path.dirname(file), 'NOTE.txt');
    writeFileSync(note, 'FIXTURE');
    for (let i = 1; i <= 25; i += 1) {
      await writeBackup({ mcsHome, settingsPath, op: 'install', bytes: Buffer.from('x'), nowMs: T0 + i * 1000 });
    }
    expect(readFileSync(note, 'utf8')).toBe('FIXTURE');
  });

  it('fails with BACKUP_FAILED when the folder cannot be made', async () => {
    const { mcsHome, settingsPath } = setup();
    mkdirSync(path.dirname(mcsHome), { recursive: true });
    writeFileSync(mcsHome, 'a file where the home folder should be');
    const error = await failureOf(() =>
      writeBackup({ mcsHome, settingsPath, op: 'install', bytes: Buffer.from('a'), nowMs: T0 }),
    );
    expect(reasonOf(error)).toBe('BACKUP_FAILED');
  });
});
