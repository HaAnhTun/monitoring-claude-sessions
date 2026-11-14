import { describe, expect, it } from 'vitest';

import { folderPathIssue, folderPathKey, lastSegment, windowsFolderPath } from './path.ts';

describe('windowsFolderPath: the MTOP normalize_path table', () => {
  it.each([
    ['D:\\a\\b\\', 'D:\\a\\b'],
    ['d:/a/b', 'D:\\a\\b'],
    ['/mnt/d/a/b', 'D:\\a\\b'], // DA memory written from WSL
    ['"D:\\x y"', 'D:\\x y'],
    ['D:\\', 'D:\\'],
    ['  d:\\x  ', 'D:\\x'],
    ['/mnt/d', 'D:\\'],
    ['/mnt/d/', 'D:\\'],
    ['c:/Users/Some Folder/', 'C:\\Users\\Some Folder'],
    ['D:\\a\\\\b', 'D:\\a\\b'],
  ])('%j becomes %j', (raw, expected) => {
    expect(windowsFolderPath(raw)).toBe(expected);
  });

  it('keeps the case of the segments and upper-cases only the drive letter', () => {
    expect(windowsFolderPath('d:\\My\\Project')).toBe('D:\\My\\Project');
  });

  it.each([
    [''],
    ['   '],
    ['relative\\dir'],
    ['.\\dir'],
    ['..\\dir'],
    ['D:'],
    ['D:dir'],
    ['\\rooted'],
    ['/usr/local'], // an absolute POSIX path has no drive to live on, on a Windows host
    ['/mnt/D/x'], // WSL mounts are lower case
    ['\\\\host\\share\\x'],
    ['//host/share'],
    ['\\\\wsl$\\distro\\home'],
    ['\\\\?\\C:\\x'],
    ['\\\\.\\pipe\\name'],
    ['\\??\\C:\\x'],
    ['D:\\x:evil'],
    ['D:\\x::$INDEX_ALLOCATION'],
    ['D:\\x\\CON'],
    ['D:\\x\\nul.txt'],
    ['D:\\NUL.txt'],
    ['D:\\a\\COM1\\b'],
    ['D:\\a\\lpt9'],
    ['D:\\a\\aux.tar.gz\\b'],
    ['D:\\a\\CON \\b'],
    ['D:\\a\\b\u202e'],
    ['D:\\a\\\u200bb'],
    ['D:\\a\\b\u0000'],
    ['D:\\a\nb'],
    ['D:\\a\\b\u007f'],
    ['D:\\a\\b\u0085'],
    [`D:\\${'a'.repeat(238)}`], // 241 characters
  ])('refuses %j', (raw) => {
    expect(windowsFolderPath(raw)).toBeNull();
  });

  it('accepts a segment that only starts with a reserved device name', () => {
    expect(windowsFolderPath('D:\\console')).toBe('D:\\console');
    expect(windowsFolderPath('D:\\COM10')).toBe('D:\\COM10');
    expect(windowsFolderPath('D:\\com0')).toBe('D:\\com0');
    expect(windowsFolderPath('D:\\lpt')).toBe('D:\\lpt');
    expect(windowsFolderPath('D:\\a.con\\b')).toBe('D:\\a.con\\b');
  });

  it('allows 240 characters and refuses 241 (the length of the normalized path)', () => {
    const at240 = `D:\\${'a'.repeat(237)}`;
    const at241 = `D:\\${'a'.repeat(238)}`;
    expect(at240).toHaveLength(240);
    expect(at241).toHaveLength(241);
    expect(windowsFolderPath(at240)).toBe(at240);
    expect(windowsFolderPath(at241)).toBeNull();
    // the trailing separator does not count, the forward slashes are the same length
    expect(windowsFolderPath(`${at240}\\`)).toBe(at240);
    expect(windowsFolderPath(at240.replaceAll('\\', '/'))).toBe(at240);
  });

  it('keeps an absolute POSIX path on a POSIX host and refuses it on Windows', () => {
    expect(windowsFolderPath('/home/x/project/', false)).toBe('/home/x/project');
    expect(windowsFolderPath('/', false)).toBe('/');
    expect(windowsFolderPath('/home//x', false)).toBe('/home/x');
    expect(windowsFolderPath('/home/x', true)).toBeNull();
    expect(windowsFolderPath('relative/x', false)).toBeNull();
    // a colon is an ordinary character of a POSIX folder name; a UNC prefix is still refused
    expect(windowsFolderPath('/home/x:y', false)).toBe('/home/x:y');
    expect(windowsFolderPath('//host/share', false)).toBeNull();
    // format and control characters are refused everywhere
    expect(windowsFolderPath('/home/\u200bx', false)).toBeNull();
    expect(windowsFolderPath('/home/x\u0007', false)).toBeNull();
    // a Windows drive path is normalized the same way on either host
    expect(windowsFolderPath('d:/a/b', false)).toBe('D:\\a\\b');
    expect(windowsFolderPath('/mnt/d/a/b', false)).toBe('D:\\a\\b');
  });

  it('defaults to a Windows host', () => {
    expect(windowsFolderPath('/home/x')).toBeNull();
    expect(windowsFolderPath('/home/x', true)).toBeNull();
  });
});

describe('folderPathIssue: the first issue code', () => {
  it.each([
    ['D:\\a\\b', null],
    ['"d:/a/b/"', null],
    ['/mnt/d/a', null],
    ['', 'relative'],
    ['dir\\sub', 'relative'],
    ['D:', 'relative'],
    ['D:dir', 'relative'],
    ['/usr/bin', 'relative'],
    ['\\\\host\\share', 'unc'],
    ['//host/share/x', 'unc'],
    ['\\\\?\\C:\\x', 'device'],
    ['//./pipe/x', 'device'],
    ['\\??\\C:\\x', 'device'],
    ['D:\\x:evil', 'stream'],
    ['D:\\x::$INDEX_ALLOCATION', 'stream'],
    ['D:\\x\\y:$DATA', 'stream'],
    ['D:\\CON', 'reserved_name'],
    ['D:\\x\\NUL.txt', 'reserved_name'],
    ['D:\\x\\com1', 'reserved_name'],
    ['D:\\x\\Lpt3.log\\y', 'reserved_name'],
    ['D:\\x\\com\u00b9', 'reserved_name'],
    ['D:\\x\u202e', 'format_char'],
    ['D:\\x\u200b\\y', 'format_char'],
    ['D:\\x\u0000', 'control'],
    ['D:\\x\ty', 'control'],
    ['D:\\x\u009fy', 'control'],
    [`D:\\${'a'.repeat(238)}`, 'too_long'],
  ])('%j gives %j', (raw, issue) => {
    expect(folderPathIssue(raw)).toBe(issue);
  });

  it('names one issue when there are several, in the order relative, unc, device, stream, reserved, format, control, length', () => {
    expect(folderPathIssue('D:\\CON\\x:y')).toBe('stream');
    expect(folderPathIssue('D:\\CON\\\u200b')).toBe('reserved_name');
    // a format character inside the segment makes it another name, so only the format issue is left
    expect(folderPathIssue('D:\\CON\u200b')).toBe('format_char');
    expect(folderPathIssue('D:\\\u200b\u0001')).toBe('format_char');
    expect(folderPathIssue(`D:\\${'a'.repeat(300)}\u0001`)).toBe('control');
  });

  it('agrees with windowsFolderPath: null exactly when the path is refused', () => {
    for (const raw of ['D:\\a', 'x', '\\\\h\\s', 'D:\\NUL', 'D:\\a\u202e', `D:\\${'a'.repeat(260)}`, '/mnt/e/q']) {
      expect(folderPathIssue(raw) === null, raw).toBe(windowsFolderPath(raw) !== null);
    }
    for (const raw of ['/home/x', '/home/x:y', 'a/b', '//h/s']) {
      expect(folderPathIssue(raw, false) === null, raw).toBe(windowsFolderPath(raw, false) !== null);
    }
  });

  it('never throws on a lone surrogate or a very long text', () => {
    expect(folderPathIssue('D:\\a\ud800b')).toBeNull();
    expect(folderPathIssue(`D:\\${'a/'.repeat(50_000)}`)).toBe('too_long');
  });
});

describe('folderPathKey', () => {
  it('is the same for every spelling of one folder (MTOP path_key)', () => {
    expect(folderPathKey('/mnt/d/A/B')).toBe(folderPathKey('D:\\a\\b\\'));
    expect(folderPathKey('d:/A/b')).toBe('d:\\a\\b');
    expect(folderPathKey('"D:\\X Y"')).toBe('d:\\x y');
  });

  it('has no trailing separator, also for a drive root', () => {
    expect(folderPathKey('D:\\')).toBe('d:');
    expect(folderPathKey('D:\\a\\')).toBe('d:\\a');
  });

  it('is empty for an empty path and still folds a path that cannot be a folder', () => {
    expect(folderPathKey('')).toBe('');
    expect(folderPathKey('  ')).toBe('');
    expect(folderPathKey('Rel/Dir/')).toBe('rel\\dir');
    expect(folderPathKey('\\\\Host\\Share\\')).toBe('\\\\host\\share');
  });
});

describe('lastSegment', () => {
  it.each([
    ['D:\\a\\b', 'b'],
    ['D:\\a\\b\\', 'b'],
    ['d:/a/b/', 'b'],
    ['D:\\', 'D:'],
    ['/home/x/p', 'p'],
    ['name', 'name'],
    ['', ''],
    ['\\\\', ''],
    ['D:\\my project.v2', 'my project.v2'],
  ])('%j gives %j', (raw, expected) => {
    expect(lastSegment(raw)).toBe(expected);
  });
});
