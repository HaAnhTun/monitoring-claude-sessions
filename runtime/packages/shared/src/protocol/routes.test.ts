import { describe, expect, it } from 'vitest';

import { matchRoute, matchRoutes, resolveMcsHome, sanitizeProjectName, type HookRouteV1 } from './routes.ts';

const BS = String.fromCharCode(92);
const WIN = { win32: true } as const;
const POSIX = { win32: false } as const;

const NOW = 1_791_727_200_000;
const SID = '11111111-2222-4333-8444-555555555555';
const OTHER_SID = '99999999-2222-4333-8444-555555555555';
const PROJECTS = 'c:/users/me/.claude/projects';

function route(over: Partial<HookRouteV1> = {}, workspace = 'D:/work/task-a'): HookRouteV1 {
  return {
    v: 1,
    instanceId: '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab',
    workspace,
    spoolDir: workspace + '/data/spool',
    stateFile: workspace + '/state.json',
    enabled: true,
    match: { transcriptsDirs: [PROJECTS + '/d--repo'], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: NOW - 1000,
    ...over,
  };
}

const ids = (
  over: Partial<{ session_id: string | null; transcript_path: string | null; cwd: string | null }> = {},
) => ({
  session_id: SID,
  transcript_path: null,
  cwd: null,
  ...over,
});

const transcript = (dir: string, file = SID + '.jsonl'): string => dir + '/' + file;

describe('matchRoutes: routing by transcript folder (T-HK-05, unit part)', () => {
  it('matches the folder of transcript_path', () => {
    const r = route();
    const got = matchRoutes([r], ids({ transcript_path: transcript(PROJECTS + '/d--repo') }), NOW, WIN);
    expect(got).toEqual([r]);
  });

  it('accepts backslashes and a different drive letter case on win32', () => {
    const r = route();
    const variants = [
      ['C:', 'Users', 'me', '.claude', 'projects', 'D--repo', SID + '.jsonl'].join(BS),
      ['c:', 'USERS', 'Me', '.claude', 'Projects', 'd--REPO', SID + '.jsonl'].join(BS),
      'C:/Users/me/.claude/projects/D--repo/' + SID + '.jsonl',
      'C:/Users//me/.claude/projects/D--repo//' + SID + '.jsonl',
    ];
    for (const path of variants) {
      expect(matchRoutes([r], ids({ transcript_path: path }), NOW, WIN), path).toEqual([r]);
    }
  });

  it('is case sensitive off win32', () => {
    const lower = route({ match: { transcriptsDirs: ['/home/me/.claude/projects/-repo'], sessionIds: [] } });
    expect(
      matchRoutes([lower], ids({ transcript_path: '/home/me/.claude/projects/-repo/x.jsonl' }), NOW, POSIX),
    ).toEqual([lower]);
    expect(
      matchRoutes([lower], ids({ transcript_path: '/home/me/.claude/projects/-REPO/x.jsonl' }), NOW, POSIX),
    ).toEqual([]);
    expect(
      matchRoutes([lower], ids({ transcript_path: '/Home/me/.claude/projects/-repo/x.jsonl' }), NOW, POSIX),
    ).toEqual([]);
  });

  it('does not match a sub folder, a parent folder or a name that only shares a prefix', () => {
    const r = route();
    for (const dir of [
      PROJECTS + '/d--repo/sub',
      PROJECTS,
      PROJECTS + '/d--repo2',
      PROJECTS + '/d--rep',
      PROJECTS + '/x/d--repo',
      'c:/other/projects/d--repo',
    ]) {
      expect(matchRoutes([r], ids({ transcript_path: transcript(dir) }), NOW, WIN), dir).toEqual([]);
    }
  });

  it('matches any of up to 8 transcript folders of a route', () => {
    const dirs = Array.from({ length: 8 }, (_v, i) => PROJECTS + '/folder-' + String(i));
    const r = route({ match: { transcriptsDirs: dirs, sessionIds: [] } });
    for (const dir of dirs) {
      expect(matchRoutes([r], ids({ transcript_path: transcript(dir) }), NOW, WIN)).toHaveLength(1);
    }
    expect(matchRoutes([r], ids({ transcript_path: transcript(PROJECTS + '/folder-8') }), NOW, WIN)).toHaveLength(0);
  });

  it('handles a path without a folder, a root file and a drive root without throwing', () => {
    const rootRoute = route({ match: { transcriptsDirs: ['/', 'c:/'], sessionIds: [] } });
    expect(matchRoutes([rootRoute], ids({ transcript_path: '/x.jsonl' }), NOW, WIN)).toHaveLength(1);
    expect(matchRoutes([rootRoute], ids({ transcript_path: 'C:/x.jsonl' }), NOW, WIN)).toHaveLength(1);
    expect(matchRoutes([route()], ids({ transcript_path: 'x.jsonl' }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([route()], ids({ transcript_path: '' }), NOW, WIN)).toEqual([]);
  });

  it('returns every matching route in input order (two instances, one session)', () => {
    const a = route({ instanceId: 'aaaaaaaa-1b2c-4d3e-8f40-0123456789ab' }, 'D:/work/a');
    const b = route({ instanceId: 'bbbbbbbb-1b2c-4d3e-8f40-0123456789ab' }, 'D:/work/b');
    const c = route(
      {
        instanceId: 'cccccccc-1b2c-4d3e-8f40-0123456789ab',
        match: { transcriptsDirs: ['c:/elsewhere'], sessionIds: [] },
      },
      'D:/work/c',
    );
    const got = matchRoutes([a, c, b], ids({ transcript_path: transcript(PROJECTS + '/d--repo') }), NOW, WIN);
    expect(got.map((r) => r.instanceId)).toEqual([a.instanceId, b.instanceId]);
  });

  it('returns nothing for no routes and for no usable id', () => {
    expect(matchRoutes([], ids({ transcript_path: transcript(PROJECTS + '/d--repo') }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([route()], { session_id: null, transcript_path: null, cwd: null }, NOW, WIN)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const r = route();
    const copy = structuredClone(r);
    matchRoutes([r], ids({ transcript_path: transcript(PROJECTS + '/d--repo') }), NOW, WIN);
    expect(r).toEqual(copy);
  });
});

describe('matchRoutes: pinned session ids', () => {
  it('matches a pinned session id even when the transcript path points elsewhere', () => {
    const r = route({ match: { transcriptsDirs: [], sessionIds: [SID] } });
    expect(matchRoutes([r], ids({ transcript_path: transcript('c:/elsewhere') }), NOW, WIN)).toEqual([r]);
    expect(matchRoutes([r], ids({ transcript_path: null }), NOW, WIN)).toEqual([r]);
    expect(matchRoutes([r], ids({ session_id: OTHER_SID }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([r], ids({ session_id: null }), NOW, WIN)).toEqual([]);
  });

  it('compares session ids exactly (no prefix, no case folding)', () => {
    const pinned = 'abcdef01-2345-6789-abcd-ef0123456789';
    const r = route({ match: { transcriptsDirs: [], sessionIds: [pinned] } });
    expect(matchRoutes([r], ids({ session_id: pinned }), NOW, WIN)).toEqual([r]);
    expect(matchRoutes([r], ids({ session_id: pinned.toUpperCase() }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([r], ids({ session_id: pinned.slice(0, -1) }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([r], ids({ session_id: pinned + '0' }), NOW, WIN)).toEqual([]);
  });
});

describe('matchRoutes: cwd fallback', () => {
  it('matches the sanitized cwd with the last segment of a transcripts folder, ignoring case', () => {
    const r = route();
    for (const cwd of ['D:/repo', 'd:' + BS + 'repo', 'D:/repo/', 'D:' + BS + 'REPO']) {
      expect(matchRoutes([r], ids({ cwd }), NOW, WIN), cwd).toEqual([r]);
    }
  });

  it('is used only when transcript_path is null', () => {
    const r = route();
    expect(
      matchRoutes([r], ids({ cwd: 'D:/repo', transcript_path: transcript('c:/elsewhere/other') }), NOW, WIN),
    ).toEqual([]);
  });

  it('does not match another project name', () => {
    const r = route();
    expect(matchRoutes([r], ids({ cwd: 'D:/repo2' }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([r], ids({ cwd: 'D:/repo/sub' }), NOW, WIN)).toEqual([]);
    expect(matchRoutes([r], ids({ cwd: '' }), NOW, WIN)).toEqual([]);
  });

  it('sanitizes every character outside A-Za-z0-9 to a dash (TS:1)', () => {
    expect(sanitizeProjectName('D:/mvp')).toBe('D--mvp');
    expect(sanitizeProjectName(['D:', 'mvp', '.claude', 'skills'].join(BS))).toBe('D--mvp--claude-skills');
    expect(sanitizeProjectName('/home/me/my proj (x)')).toBe('-home-me-my-proj--x-');
    expect(sanitizeProjectName('abcXYZ019')).toBe('abcXYZ019');
    expect(sanitizeProjectName('')).toBe('');
    expect(sanitizeProjectName('caf' + String.fromCharCode(0xe9))).toBe('caf-');
  });
});

describe('matchRoute: the reason a route matched', () => {
  const r = route({ match: { transcriptsDirs: [PROJECTS + '/d--repo'], sessionIds: [SID] } });

  it('reports the transcript folder first, then the session pin, then the cwd', () => {
    expect(matchRoute(r, ids({ transcript_path: transcript(PROJECTS + '/d--repo') }), NOW, WIN)).toBe('transcript');
    expect(matchRoute(r, ids({ transcript_path: transcript('c:/elsewhere') }), NOW, WIN)).toBe('session_pin');
    expect(matchRoute(r, ids({ session_id: OTHER_SID, cwd: 'D:/repo' }), NOW, WIN)).toBe('cwd');
    expect(matchRoute(r, ids({ session_id: OTHER_SID, cwd: 'D:/nope' }), NOW, WIN)).toBeNull();
  });

  it('agrees with matchRoutes', () => {
    const cases = [
      ids({ transcript_path: transcript(PROJECTS + '/d--repo') }),
      ids({ transcript_path: transcript('c:/elsewhere') }),
      ids({ session_id: OTHER_SID, cwd: 'D:/repo' }),
      ids({ session_id: OTHER_SID, cwd: 'D:/nope' }),
    ];
    for (const c of cases) {
      expect(matchRoutes([r], c, NOW, WIN).length === 1).toBe(matchRoute(r, c, NOW, WIN) !== null);
    }
  });
});

describe('matchRoutes: enabled, version and the stopped window', () => {
  const where = ids({ transcript_path: transcript(PROJECTS + '/d--repo') });

  it('skips a disabled route', () => {
    expect(matchRoutes([route({ enabled: false })], where, NOW, WIN)).toEqual([]);
  });

  it('skips a route of another version or without the literal true', () => {
    const wrongVersion = { ...route(), v: 2 } as unknown as HookRouteV1;
    const truthy = { ...route(), enabled: 1 } as unknown as HookRouteV1;
    expect(matchRoutes([wrongVersion, truthy], where, NOW, WIN)).toEqual([]);
  });

  it('a running instance (stoppedAt null) always matches, whatever spoolUntil says', () => {
    expect(matchRoutes([route({ stoppedAt: null, spoolUntil: null })], where, NOW, WIN)).toHaveLength(1);
    expect(matchRoutes([route({ stoppedAt: null, spoolUntil: NOW - 1 })], where, NOW, WIN)).toHaveLength(1);
  });

  it('a stopped instance with no spool window does not match (spoolWhileStoppedHours = 0 or never set)', () => {
    expect(matchRoutes([route({ stoppedAt: NOW - 10, spoolUntil: null })], where, NOW, WIN)).toEqual([]);
  });

  it('a stopped instance matches strictly before spoolUntil and not at or after it', () => {
    const stopped = (spoolUntil: number): HookRouteV1 => route({ stoppedAt: NOW - 10_000, spoolUntil });
    expect(matchRoutes([stopped(NOW + 1)], where, NOW, WIN)).toHaveLength(1);
    expect(matchRoutes([stopped(NOW)], where, NOW, WIN)).toEqual([]);
    expect(matchRoutes([stopped(NOW - 1)], where, NOW, WIN)).toEqual([]);
    // the same route before and after its window closes
    const r = stopped(NOW + 5000);
    expect(matchRoutes([r], where, NOW, WIN)).toHaveLength(1);
    expect(matchRoutes([r], where, NOW + 5000, WIN)).toEqual([]);
    expect(matchRoutes([r], where, NOW + 6000, WIN)).toEqual([]);
  });
});

describe('matchRoutes: malformed spoolDir and stateFile are rejected, never trusted', () => {
  const where = ids({ transcript_path: transcript(PROJECTS + '/d--repo') });

  it.each([
    ['another folder', 'D:/elsewhere/data/spool'],
    ['trailing slash', 'D:/work/task-a/data/spool/'],
    ['dot dot', 'D:/work/task-a/data/../data/spool'],
    ['parent of the workspace', 'D:/work/data/spool'],
    ['different case', 'd:/work/task-a/data/spool'],
    ['backslashes', 'D:' + BS + 'work' + BS + 'task-a' + BS + 'data' + BS + 'spool'],
    ['empty', ''],
    ['workspace itself', 'D:/work/task-a'],
    ['sibling', 'D:/work/task-a/data/spool2'],
    ['nested', 'D:/work/task-a/data/spool/x'],
  ])('spoolDir %s', (_label, spoolDir) => {
    expect(matchRoutes([route({ spoolDir })], where, NOW, WIN)).toEqual([]);
  });

  it.each([
    ['another file', 'D:/work/task-a/other.json'],
    ['another folder', 'D:/elsewhere/state.json'],
    ['dot dot', 'D:/work/task-a/data/../state.json'],
    ['different case', 'D:/work/task-a/State.json'],
    ['empty', ''],
  ])('stateFile %s', (_label, stateFile) => {
    expect(matchRoutes([route({ stateFile })], where, NOW, WIN)).toEqual([]);
  });

  it('keeps the other, valid routes of the same call', () => {
    const good = route({ instanceId: 'aaaaaaaa-1b2c-4d3e-8f40-0123456789ab' });
    const bad = route({ instanceId: 'bbbbbbbb-1b2c-4d3e-8f40-0123456789ab', spoolDir: 'D:/elsewhere' });
    expect(matchRoutes([bad, good], where, NOW, WIN)).toEqual([good]);
  });
});

describe('resolveMcsHome (2.6.1, N8)', () => {
  it('uses MCS_HOME when it is absolute (drive, UNC, POSIX)', () => {
    expect(resolveMcsHome({ MCS_HOME: 'C:' + BS + 'tmp' + BS + 'mcs' }, { win32: true })).toBe(
      'C:' + BS + 'tmp' + BS + 'mcs',
    );
    expect(resolveMcsHome({ MCS_HOME: 'C:/tmp/mcs' }, { win32: true })).toBe('C:/tmp/mcs');
    expect(resolveMcsHome({ MCS_HOME: '/tmp/mcs' }, { win32: false })).toBe('/tmp/mcs');
    expect(resolveMcsHome({ MCS_HOME: BS + BS + 'server' + BS + 'share' + BS + 'mcs' }, { win32: true })).toBe(
      BS + BS + 'server' + BS + 'share' + BS + 'mcs',
    );
  });

  it('strips trailing separators but keeps a root', () => {
    expect(resolveMcsHome({ MCS_HOME: '/tmp/mcs/' }, { win32: false })).toBe('/tmp/mcs');
    expect(resolveMcsHome({ MCS_HOME: 'C:/tmp/mcs//' }, { win32: true })).toBe('C:/tmp/mcs');
    expect(resolveMcsHome({ MCS_HOME: 'C:' + BS + 'tmp' + BS }, { win32: true })).toBe('C:' + BS + 'tmp');
    expect(resolveMcsHome({ MCS_HOME: '/' }, { win32: false })).toBe('/');
  });

  it('ignores an empty or relative MCS_HOME', () => {
    const env = { LOCALAPPDATA: 'C:/Users/me/AppData/Local', XDG_STATE_HOME: '/state' };
    expect(resolveMcsHome({ ...env, MCS_HOME: '' }, { win32: true })).toBe('C:/Users/me/AppData/Local/mcs');
    expect(resolveMcsHome({ ...env, MCS_HOME: 'relative/dir' }, { win32: true })).toBe('C:/Users/me/AppData/Local/mcs');
    expect(resolveMcsHome({ ...env, MCS_HOME: '.' }, { win32: false })).toBe('/state/mcs');
    expect(resolveMcsHome({ ...env, MCS_HOME: '../up' }, { win32: false })).toBe('/state/mcs');
    expect(resolveMcsHome({ ...env, MCS_HOME: undefined }, { win32: false })).toBe('/state/mcs');
  });

  it('treats a POSIX style absolute path as relative on win32 and a drive path as relative off win32', () => {
    const win = { LOCALAPPDATA: 'C:/L' };
    expect(resolveMcsHome({ ...win, MCS_HOME: '/tmp/mcs' }, { win32: true })).toBe('C:/L/mcs');
    const posix = { XDG_STATE_HOME: '/state' };
    expect(resolveMcsHome({ ...posix, MCS_HOME: 'C:/tmp/mcs' }, { win32: false })).toBe('/state/mcs');
  });

  it('win32 default: %LOCALAPPDATA%/mcs, else <home>/AppData/Local/mcs', () => {
    expect(
      resolveMcsHome(
        { LOCALAPPDATA: 'C:' + BS + 'Users' + BS + 'me' + BS + 'AppData' + BS + 'Local' },
        { win32: true },
      ),
    ).toBe('C:' + BS + 'Users' + BS + 'me' + BS + 'AppData' + BS + 'Local/mcs');
    expect(resolveMcsHome({ USERPROFILE: 'C:/Users/me' }, { win32: true })).toBe('C:/Users/me/AppData/Local/mcs');
    expect(resolveMcsHome({ LOCALAPPDATA: '', USERPROFILE: 'C:/Users/me' }, { win32: true })).toBe(
      'C:/Users/me/AppData/Local/mcs',
    );
    expect(resolveMcsHome({}, { win32: true, homedir: 'C:/Users/home' })).toBe('C:/Users/home/AppData/Local/mcs');
  });

  it('POSIX default: $XDG_STATE_HOME/mcs, else <home>/.local/state/mcs', () => {
    expect(resolveMcsHome({ XDG_STATE_HOME: '/var/state' }, { win32: false })).toBe('/var/state/mcs');
    expect(resolveMcsHome({ HOME: '/home/me' }, { win32: false })).toBe('/home/me/.local/state/mcs');
    expect(resolveMcsHome({ XDG_STATE_HOME: '', HOME: '/home/me' }, { win32: false })).toBe(
      '/home/me/.local/state/mcs',
    );
    expect(resolveMcsHome({}, { win32: false, homedir: '/home/other' })).toBe('/home/other/.local/state/mcs');
  });

  it('ignores a relative XDG_STATE_HOME (the XDG rule, and the handler must never write under its cwd)', () => {
    expect(resolveMcsHome({ XDG_STATE_HOME: 'state', HOME: '/home/me' }, { win32: false })).toBe(
      '/home/me/.local/state/mcs',
    );
  });

  it('an explicit homedir option wins over the environment', () => {
    expect(resolveMcsHome({ HOME: '/home/env' }, { win32: false, homedir: '/home/opt' })).toBe(
      '/home/opt/.local/state/mcs',
    );
  });

  it('throws a clear error when no location can be found', () => {
    expect(() => resolveMcsHome({}, { win32: false })).toThrow(/home/i);
    expect(() => resolveMcsHome({}, { win32: true })).toThrow(/home/i);
  });

  it('defaults the platform to the host', () => {
    const host = process.platform === 'win32';
    const env = host ? { LOCALAPPDATA: 'C:/L' } : { XDG_STATE_HOME: '/s' };
    expect(resolveMcsHome(env)).toBe(host ? 'C:/L/mcs' : '/s/mcs');
  });

  it('returns a value that never depends on the working directory', () => {
    const home = resolveMcsHome(
      { MCS_HOME: 'x', XDG_STATE_HOME: 'y', HOME: '/h', USERPROFILE: 'C:/h', LOCALAPPDATA: 'z' },
      WIN,
    );
    expect(home).toBe('C:/h/AppData/Local/mcs');
  });
});
