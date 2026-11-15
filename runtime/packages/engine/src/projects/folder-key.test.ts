// The project key rules (CAW design 03 2.5, 4.1): the key of a Claude folder name, the key of a working directory, the match
// between the two (also for a name that Claude cut at 200 characters), and the project that a `session.seen` names.
import { describe, expect, it } from 'vitest';

import { PROJECT_NAME_MAX } from '../ingest/transcripts/discovery.ts';
import {
  PROJECT_DIR_NAME_RE,
  dirMatchesKey,
  dirNameOfTranscript,
  folderKeyOfPath,
  keyOfDirName,
  projectOfSeen,
} from './folder-key.ts';

const BS = String.fromCharCode(92);
const LONG_PATH = '/srv/' + 'b'.repeat(295);

describe('keyOfDirName', () => {
  it('lower-cases a valid folder name and keeps every dash', () => {
    expect(keyOfDirName('D--Work-App')).toBe('d--work-app');
    expect(keyOfDirName('d--work--claude')).toBe('d--work--claude');
    expect(keyOfDirName('-home-me-App')).toBe('-home-me-app');
    expect(keyOfDirName('a')).toBe('a');
  });

  it('accepts 255 characters and refuses 256, the empty name and any other character', () => {
    expect(keyOfDirName('a'.repeat(255))).toBe('a'.repeat(255));
    expect(keyOfDirName('a'.repeat(256))).toBeNull();
    for (const name of ['', 'a b', 'a.b', 'a_b', 'a/b', `a${BS}b`, 'caf\u00e9', 'a\nb', '..']) {
      expect(keyOfDirName(name), JSON.stringify(name)).toBeNull();
    }
  });

  it('is the pattern the design names', () => {
    expect(PROJECT_DIR_NAME_RE.source).toBe('^[A-Za-z0-9-]{1,255}$');
  });
});

describe('folderKeyOfPath', () => {
  it('is the lower-cased folder name Claude derives from the directory', () => {
    expect(folderKeyOfPath(['D:', 'Work', 'App'].join(BS))).toEqual({ key: 'd--work-app', prefix: false });
    expect(folderKeyOfPath('/home/me/My App')).toEqual({ key: '-home-me-my-app', prefix: false });
    expect(folderKeyOfPath(['D:', 'work', '.claude'].join(BS))).toEqual({ key: 'd--work--claude', prefix: false });
  });

  it('ignores trailing separators and the case of the drive letter', () => {
    expect(folderKeyOfPath('/home/me/app/')).toEqual(folderKeyOfPath('/home/me/app'));
    expect(folderKeyOfPath(['d:', 'work', 'app', ''].join(BS)).key).toBe(
      folderKeyOfPath(['D:', 'work', 'app'].join(BS)).key,
    );
  });

  it('marks a name cut at 200 characters as a prefix', () => {
    const cut = folderKeyOfPath(LONG_PATH);
    expect(cut.prefix).toBe(true);
    expect(cut.key).toHaveLength(PROJECT_NAME_MAX);
    expect(cut.key).toBe(cut.key.toLowerCase());
    expect(folderKeyOfPath('/a'.repeat(100))).toEqual({ key: '-a'.repeat(100), prefix: false });
  });

  it('agrees with the key of the folder name of the same directory', () => {
    const folder = 'D--Work-App';
    expect(folderKeyOfPath(['D:', 'Work', 'App'].join(BS)).key).toBe(keyOfDirName(folder));
  });
});

describe('dirMatchesKey', () => {
  it('matches the whole name, without case', () => {
    const key = folderKeyOfPath(['D:', 'work', 'app'].join(BS));
    expect(dirMatchesKey('D--work-app', key)).toBe(true);
    expect(dirMatchesKey('d--WORK-app', key)).toBe(true);
    expect(dirMatchesKey('D--work-app-2', key)).toBe(false);
    expect(dirMatchesKey('D--work', key)).toBe(false);
  });

  it('matches a name that Claude cut and gave a hash by its prefix and the dash', () => {
    const key = folderKeyOfPath(LONG_PATH);
    expect(dirMatchesKey(`${key.key}-1x2y3z`, key)).toBe(true);
    expect(dirMatchesKey(`${key.key.toUpperCase()}-1X2Y3Z`, key)).toBe(true);
    // the bare prefix is a shorter directory, not the cut one
    expect(dirMatchesKey(key.key, key)).toBe(false);
    expect(dirMatchesKey(`${key.key}x-1x2y3z`, key)).toBe(false);
  });

  it('never matches a name that cannot be a project folder', () => {
    expect(dirMatchesKey('', { key: '', prefix: false })).toBe(false);
    expect(dirMatchesKey('a b', { key: 'a b', prefix: false })).toBe(false);
  });
});

describe('dirNameOfTranscript', () => {
  it('is the folder that holds the file, whichever separator the path uses', () => {
    expect(dirNameOfTranscript('/home/me/.claude/projects/-home-me-app/s.jsonl')).toBe('-home-me-app');
    expect(dirNameOfTranscript(['C:', 'Users', 'me', '.claude', 'projects', 'C--work-app', 's.jsonl'].join(BS))).toBe(
      'C--work-app',
    );
    expect(dirNameOfTranscript(`C:/Users/me/.claude/projects/C--work-app${BS}s.jsonl`)).toBe('C--work-app');
  });

  it('is null when the path has no folder', () => {
    expect(dirNameOfTranscript('s.jsonl')).toBeNull();
    expect(dirNameOfTranscript('')).toBeNull();
    expect(dirNameOfTranscript('/s.jsonl')).toBeNull();
  });
});

describe('projectOfSeen', () => {
  const FILE = '/home/me/.claude/projects/D--Work-App/s.jsonl';

  it('names the key, the folder name as written and the first working directory', () => {
    expect(projectOfSeen(FILE, ['D:', 'Work', 'App'].join(BS))).toEqual({
      key: 'd--work-app',
      dirName: 'D--Work-App',
      root: ['D:', 'Work', 'App'].join(BS),
    });
  });

  it('has no root without a working directory', () => {
    expect(projectOfSeen(FILE, undefined)).toEqual({ key: 'd--work-app', dirName: 'D--Work-App', root: null });
    expect(projectOfSeen(FILE, '')).toEqual({ key: 'd--work-app', dirName: 'D--Work-App', root: null });
  });

  it('clips a long working directory to the 1,024 characters of the column', () => {
    const found = projectOfSeen(FILE, '/' + 'x'.repeat(2000));
    expect(found?.root).toHaveLength(1024);
  });

  it('is none for a folder name that is not a project name, and for no transcript path', () => {
    expect(projectOfSeen('/home/me/odd folder/s.jsonl', '/x')).toBeNull();
    expect(projectOfSeen('/home/me/a.b/s.jsonl', '/x')).toBeNull();
    expect(projectOfSeen('s.jsonl', '/x')).toBeNull();
    expect(projectOfSeen(undefined, '/x')).toBeNull();
  });
});
