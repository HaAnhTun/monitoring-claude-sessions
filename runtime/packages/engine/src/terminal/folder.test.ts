import { describe, expect, it } from 'vitest';

import { folderKey, normalizeFolder, type FolderFs } from './folder.ts';
import { FOLDER_MAX_CHARS, FOLDER_MAX_CHARS_POSIX } from './limits.ts';

const win = (raw: string): string | null => normalizeFolder(raw, 'win32');
const posix = (raw: string, platform: 'linux' | 'darwin' | 'other' = 'linux'): string | null =>
  normalizeFolder(raw, platform);

describe('TC-UNIT-05 normalizeFolder on win32: the spellings that are accepted (MTOP normalize_path)', () => {
  it.each([
    ['D:\\x', 'D:\\x'],
    ['d:\\x', 'D:\\x'],
    ['D:/a/b', 'D:\\a\\b'],
    ['D:/a/b/', 'D:\\a\\b'],
    ['D:\\a\\b\\', 'D:\\a\\b'],
    ['D:\\a\\b\\\\', 'D:\\a\\b'],
    ['D:\\', 'D:\\'],
    ['D:', 'D:\\'],
    ['d:', 'D:\\'],
    ['D:/', 'D:\\'],
    ['"D:\\a b"', 'D:\\a b'],
    ['""D:\\x""', 'D:\\x'],
    [' D:\\x ', 'D:\\x'],
    ['  "D:\\x"  ', 'D:\\x'],
    ['D:\\Work\\Proj', 'D:\\Work\\Proj'],
    ['D:\\a b\\c.d', 'D:\\a b\\c.d'],
    ['D:\\.hidden', 'D:\\.hidden'],
    ['D:\\a.b.c', 'D:\\a.b.c'],
    ['D:\\D\u1ef1 \u00e1n\\b\u00e0i', 'D:\\D\u1ef1 \u00e1n\\b\u00e0i'],
    ['D:\\e\u0301', 'D:\\e\u0301'],
    ['D:\\\u65e5\u672c', 'D:\\\u65e5\u672c'],
    ['D:\\\u{1f600}', 'D:\\\u{1f600}'],
  ])('%j -> %j', (raw, expected) => {
    expect(win(raw)).toBe(expected);
  });

  it.each([
    ['/mnt/d/x', 'D:\\x'],
    ['/mnt/D/x/y/', 'D:\\x\\y'],
    ['/mnt/d', 'D:\\'],
    ['/mnt/d/', 'D:\\'],
    ['/mnt/c/Work/dev/proj', 'C:\\Work\\dev\\proj'],
    ['"/mnt/e/my dir"', 'E:\\my dir'],
  ])('a path written from WSL: %j -> %j', (raw, expected) => {
    expect(win(raw)).toBe(expected);
  });

  it.each([
    ['D:\\a\\..\\b', 'D:\\b'],
    ['D:\\a\\.\\b', 'D:\\a\\b'],
    ['D:\\\\a\\\\\\b', 'D:\\a\\b'],
    ['D:\\a\\..\\..\\b', 'D:\\b'],
    ['D:/a/../../..', 'D:\\'],
    ['D:\\a\\b\\..', 'D:\\a'],
  ])('collapses dots and repeated separators: %j -> %j', (raw, expected) => {
    expect(win(raw)).toBe(expected);
  });

  it.each([
    ['\\\\?\\D:\\x', 'D:\\x'],
    ['//?/d:/x', 'D:\\x'],
    ['\\\\?\\d:\\', 'D:\\'],
    ['\\\\?\\D:\\a b\\', 'D:\\a b'],
  ])('strips the extended prefix: %j -> %j', (raw, expected) => {
    expect(win(raw)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const raw of ['D:/a/b/', '/mnt/d/x/y', '"d:\\q"', 'D:\\a\\..\\b', '\\\\?\\D:\\x']) {
      const once = win(raw);
      expect(once).not.toBeNull();
      expect(win(once ?? '')).toBe(once);
    }
  });
});

describe('TC-UNIT-05 TC-SEC-21 normalizeFolder on win32: what is refused', () => {
  it.each([[''], ['   '], ['""'], ['"  "'], ['\t\n'], ['" "']])('nothing: %j', (raw) => {
    expect(win(raw)).toBeNull();
  });

  it.each([
    ['D:\\x\u0000'],
    ['D:\\x\u0000y'],
    ['\u0000D:\\x'],
    ['D:\\x\ty'],
    ['D:\\x\ny'],
    ['D:\\x\ry'],
    ['D:\\x\u001by'],
    ['D:\\x\u007fy'],
    ['D:\\x\u0085y'],
  ])('a NUL or control character: %j', (raw) => {
    expect(win(raw)).toBeNull();
  });

  it.each([
    ['x'],
    ['x\\y'],
    ['foo/bar'],
    ['.\\x'],
    ['..\\x'],
    ['.'],
    ['..'],
    ['\\x'],
    ['\\x\\y'],
    ['D:x'],
    ['D:x\\y'],
    ['D:..\\x'],
    ['~\\x'],
    ['%USERPROFILE%\\x'],
  ])('a relative path (MTOP used the server folder; never here): %j', (raw) => {
    expect(win(raw)).toBeNull();
  });

  it.each([
    ['\\\\server\\share'],
    ['//server/share'],
    ['\\\\server\\share\\x'],
    ['\\\\?\\UNC\\server\\share\\x'],
    ['\\\\.\\C:\\x'],
    ['\\\\.\\COM1'],
    ['//./C:/x'],
    ['\\\\'],
    ['\\\\?\\GLOBALROOT\\Device\\x'],
    ['\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x'],
  ])('a UNC or device path (cmd.exe cannot use it as the current directory): %j', (raw) => {
    expect(win(raw)).toBeNull();
  });

  it.each([['/home/dev'], ['/'], ['/mnt'], ['/mnt/'], ['/mnt/dx/y'], ['/mnt/1/x'], ['/usr/bin']])(
    'a POSIX path that is not a WSL drive: %j',
    (raw) => {
      expect(win(raw)).toBeNull();
    },
  );

  it.each([
    ['D:\\x:evil'],
    ['D:\\x::$INDEX_ALLOCATION'],
    ['D:\\x:stream:$DATA'],
    ['D:\\x\\y:z'],
    ['D::\\x'],
    ['D:\\:'],
    ['D:\\x:'],
    ['D:\\x::$DATA'],
    ['C:\\a\\b\\:$I30:$INDEX_ALLOCATION'],
    ['/mnt/d/x:evil'],
    ['\\\\?\\D:\\x:evil'],
  ])('an NTFS stream spelling (a ":" after the drive): %j', (raw) => {
    expect(win(raw)).toBeNull();
  });

  it.each([
    ['D:\\CON'],
    ['D:\\con'],
    ['D:\\Con'],
    ['D:\\x\\NUL'],
    ['D:\\PRN.txt'],
    ['D:\\aux.tar.gz'],
    ['D:\\x\\COM1'],
    ['D:\\LPT9'],
    ['D:\\Com5.log'],
    ['D:\\COM9'],
    ['D:\\LPT1.'],
    ['D:\\nul.'],
    ['D:\\CON \\x'],
    ['D:\\CONIN$'],
    ['D:\\CONOUT$'],
    ['D:\\COM\u00b9'],
    ['D:\\LPT\u00b2.txt'],
    ['D:\\NUL\\..\\x'],
    ['D:\\x\\CON\\y'],
    ['/mnt/d/con'],
    ['D:/AUX'],
  ])('a reserved device name as a segment: %j', (raw) => {
    expect(win(raw)).toBeNull();
  });

  it.each([
    ['D:\\CONSOLE'],
    ['D:\\COM0'],
    ['D:\\COM10'],
    ['D:\\LPT0'],
    ['D:\\NULL'],
    ['D:\\AUXILIARY'],
    ['D:\\x.CON'],
    ['D:\\.con'],
    ['D:\\COM'],
    ['D:\\LPT'],
    ['D:\\prn1'],
    ['D:\\CONIN'],
    ['D:\\com1x'],
    ['D:\\my con'],
  ])('a name that only looks like a device name is fine: %j', (raw) => {
    expect(win(raw)).toBe(raw);
  });

  it.each([
    ['a zero width space', 'D:\\x\u200bevil'],
    ['a right-to-left override', 'D:\\x\u202egnp.exe'],
    ['a left-to-right mark', 'D:\\\u200ex'],
    ['a soft hyphen', 'D:\\x\u00ady'],
    ['a word joiner', 'D:\\x\u2060y'],
    ['an interior byte order mark', 'D:\\x\ufeffy'],
    ['a zero width joiner', 'D:\\x\u200dy'],
    ['a bidi isolate', 'D:\\x\u2066y'],
    ['a tag character', 'D:\\x\u{e0041}y'],
  ])('a Unicode format character (Cf): %s', (_label, raw) => {
    expect(win(raw)).toBeNull();
  });

  it('allows exactly 240 characters and refuses 241', () => {
    expect(FOLDER_MAX_CHARS).toBe(240);
    const ok = `D:\\${'a'.repeat(237)}`;
    expect(ok.length).toBe(240);
    expect(win(ok)).toBe(ok);
    expect(win(`${ok}a`)).toBeNull();
    expect(win(`D:\\${'a'.repeat(238)}`)).toBeNull();
  });

  it('counts the normalized path: WSL and slash spellings, trailing separators and dots do not change the verdict', () => {
    expect(win(`/mnt/d/${'a'.repeat(237)}`)?.length).toBe(240);
    expect(win(`/mnt/d/${'a'.repeat(238)}`)).toBeNull();
    expect(win(`D:/${'a'.repeat(237)}//`)?.length).toBe(240);
    expect(win(`D:\\${'a\\..\\'.repeat(100)}b`)).toBe('D:\\b');
  });

  it('counts many short segments the same way', () => {
    const fits = `D:\\${Array.from({ length: 22 }, () => 'abcdefghi').join('\\')}`;
    expect(fits.length).toBeLessThanOrEqual(240);
    expect(win(fits)).toBe(fits);
    const tooLong = `D:\\${Array.from({ length: 26 }, () => 'abcdefghi').join('\\')}`;
    expect(tooLong.length).toBeGreaterThan(240);
    expect(win(tooLong)).toBeNull();
  });

  it('refuses a huge input at once, before any work on it', () => {
    const started = performance.now();
    expect(win(`D:\\${'a'.repeat(200_000)}`)).toBeNull();
    expect(win(`D:\\${'\\.'.repeat(100_000)}`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('TC-UNIT-05 normalizeFolder on a POSIX host', () => {
  const PLATFORMS = ['linux', 'darwin', 'other'] as const;

  it.each([
    ['/home/dev/p', '/home/dev/p'],
    ['/home/dev/p/', '/home/dev/p'],
    ['/', '/'],
    ['//', '/'],
    ['/a/../b', '/b'],
    ['/a//b', '/a/b'],
    ['/a/./b', '/a/b'],
    ['/..', '/'],
    ['"/srv/my dir"', '/srv/my dir'],
    [' /srv/x ', '/srv/x'],
    ['/a\\b', '/a\\b'],
    ['/mnt/d/x', '/mnt/d/x'],
    ['/D:/x', '/D:/x'],
    ['/home/dev/D\u1ef1', '/home/dev/D\u1ef1'],
  ])('%j -> %j', (raw, expected) => {
    for (const platform of PLATFORMS) expect(posix(raw, platform), platform).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['a/b'],
    ['x'],
    ['./a'],
    ['../a'],
    ['~/x'],
    ['D:\\x'],
    ['D:/x'],
    ['C:'],
    ['\\\\server\\share'],
    ['/a\u0000b'],
    ['/a\nb'],
    ['"/a\tb"'],
  ])('refuses %j', (raw) => {
    for (const platform of PLATFORMS) expect(posix(raw, platform), platform).toBeNull();
  });

  it('allows 4096 characters and refuses 4097', () => {
    expect(FOLDER_MAX_CHARS_POSIX).toBe(4096);
    const ok = `/${'a'.repeat(4095)}`;
    expect(posix(ok)).toBe(ok);
    expect(posix(`${ok}a`)).toBeNull();
  });
});

describe('TC-UNIT-05 folderKey', () => {
  it.each([
    ['D:\\Work\\Proj\\', 'd:\\work\\proj'],
    ['d:/WORK/proj', 'd:\\work\\proj'],
    ['/mnt/d/Work/Proj/', 'd:\\work\\proj'],
    ['"D:\\X"', 'd:\\x'],
    ['D:\\', 'd:'],
    ['D:', 'd:'],
    ['D:\\D\u1ef0 \u00c1N', 'd:\\d\u1ef1 \u00e1n'],
  ])('win32: %j -> %j', (folder, expected) => {
    expect(folderKey(folder, 'win32')).toBe(expected);
  });

  it('win32: every spelling of one folder gives one key', () => {
    const keys = new Set(
      ['D:\\Work\\Proj', 'd:/work/proj/', '/mnt/D/WORK/proj', '"D:\\WORK\\PROJ\\"'].map((f) => folderKey(f, 'win32')),
    );
    expect(keys.size).toBe(1);
  });

  it('win32: a text that is no folder still gets a key and never throws', () => {
    expect(folderKey('Rel\\Dir\\', 'win32')).toBe('rel\\dir');
    expect(folderKey('\\\\Server\\Share\\', 'win32')).toBe('\\\\server\\share');
    expect(folderKey('', 'win32')).toBe('');
    expect(folderKey('  D:\\x\u0000  ', 'win32')).toBe('d:\\x\u0000');
  });

  it('linux keeps the case and has no trailing separator, the root stays "/"', () => {
    expect(folderKey('/Home/U/', 'linux')).toBe('/Home/U');
    expect(folderKey('/Home/U', 'linux')).toBe('/Home/U');
    expect(folderKey('/home/u', 'linux')).not.toBe(folderKey('/Home/U', 'linux'));
    expect(folderKey('/', 'linux')).toBe('/');
    expect(folderKey('/a/../b/', 'other')).toBe('/b');
  });

  it('darwin folds the case like its file system', () => {
    expect(folderKey('/Work/Dev/', 'darwin')).toBe('/work/dev');
  });

  it('the file system seam is only a type: a directory test over a path', () => {
    const fs: FolderFs = { isDirectory: (p) => p === 'D:\\x' };
    expect(fs.isDirectory(win('D:/x/') ?? '')).toBe(true);
  });
});
