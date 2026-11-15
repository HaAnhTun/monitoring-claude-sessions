// The resume decision (CAW design 03 section 6, ADR 0090): one function over what the database knows about a session, the registry
// and the linker, with the six rows in the order they are checked, the fork path, `redirectTo`, and the plan that `claude --resume`
// is started from. Everything is a fake: a set of folders that exist, a list of registry entries, an owner table.
import { ResumeEligibilitySchema, type ResumeEligibility } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { RegistryEntry } from '../external/registry.ts';
import type { ResumeFacts } from '../query/projects.ts';
import { ResumeRefusal, decideResume, resumePlanOf, type ResumeEnvironment, type ResumePlan } from './resume.ts';

const uid = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = uid(1);
const KEY = 'd--work-app';
const ROOT = 'D:\\work\\app';
const TRANSCRIPT = 'C:\\claude\\projects\\D--work-app\\one.jsonl';

function facts(over: Partial<ResumeFacts> = {}): ResumeFacts {
  return {
    sessionId: SESSION,
    projectKey: KEY,
    dirName: 'D--work-app',
    rootPath: ROOT,
    sessionCwd: ROOT,
    entrypoint: 'cli',
    continuedIn: null,
    mainFile: { path: TRANSCRIPT, state: 'active' },
    ...over,
  };
}

function entry(pid: number, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid,
    sessionId: SESSION,
    status: 'idle',
    waitingFor: null,
    cwd: ROOT,
    startedAtMs: 1,
    updatedAtMs: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    alive: true,
    ...over,
  };
}

interface Fake {
  readonly env: ResumeEnvironment;
  readonly statted: string[];
}

/** An environment where `ROOT` is a folder and the transcript file exists, unless the test says otherwise. */
function fake(
  over: Partial<ResumeEnvironment> & { folders?: readonly string[]; transcriptFile?: boolean | null } = {},
): Fake {
  const { folders = [ROOT], transcriptFile = null, ...rest } = over;
  const existing = new Set(folders.map((folder) => folder.toLowerCase()));
  const statted: string[] = [];
  const env: ResumeEnvironment = {
    facts: facts(),
    catalogRoot: null,
    registry: [],
    sessionOwner: () => null,
    ownedPids: new Set(),
    isDirectory: (path) => {
      statted.push(path);
      return Promise.resolve(existing.has(path.toLowerCase()));
    },
    transcriptExists: transcriptFile === null ? null : () => Promise.resolve(transcriptFile),
    knowsSession: () => false,
    win32: true,
    ...rest,
  };
  return { env, statted };
}

async function decide(over: Parameters<typeof fake>[0] = {}): Promise<ResumeEligibility> {
  const { env } = fake(over);
  const decision = await decideResume(SESSION, env);
  expect(ResumeEligibilitySchema.safeParse(decision).success).toBe(true);
  return decision;
}

const REFUSED = { allowed: false, forkAllowed: false, liveElsewhere: false, liveTerminal: null, redirectTo: null };

describe('row 1: the session is not known', () => {
  it('is a refusal, not an eligibility: the route answers 404', async () => {
    const error = await decideResume(SESSION, fake({ facts: null }).env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeRefusal);
    expect(error).toMatchObject({ code: 'session_not_found', liveTerminal: null });
    expect((error as Error).message).not.toContain(SESSION);
  });
});

describe('row 2: the transcript is gone', () => {
  it.each([
    ['has no main file', null],
    ['has a file the monitor saw go missing', { path: TRANSCRIPT, state: 'missing' as const }],
    ['has a file the monitor retired', { path: TRANSCRIPT, state: 'retired' as const }],
  ])('a session that %s cannot be resumed, nor copied', async (_why, mainFile) => {
    expect(await decide({ facts: facts({ mainFile }) })).toEqual({
      ...REFUSED,
      sessionId: SESSION,
      reason: 'transcript_gone',
      folder: null,
    });
  });

  it.each(['active', 'unreadable', 'untracked'] as const)('a file in state %s is not gone', async (state) => {
    const decision = await decide({ facts: facts({ mainFile: { path: TRANSCRIPT, state } }) });
    expect(decision.allowed).toBe(true);
  });

  it('the plan also asks the file system: a file the database still lists but that was cleaned away is gone', async () => {
    const gone = await decide({ transcriptFile: false });
    expect(gone).toMatchObject({ allowed: false, forkAllowed: false, reason: 'transcript_gone' });
    const there = await decide({ transcriptFile: true });
    expect(there).toMatchObject({ allowed: true, reason: null });
  });

  it('the plain eligibility does not touch the file system for the transcript', async () => {
    const { env, statted } = fake();
    await decideResume(SESSION, env);
    expect(statted).not.toContain(TRANSCRIPT);
  });
});

describe('row 3: the folder', () => {
  it('is the launch folder of the project, as the project reported it', async () => {
    const decision = await decide();
    expect(decision.folder).toEqual({ key: KEY, path: ROOT });
  });

  it('is written the way the host does: separators, a drive letter in upper case', async () => {
    const decision = await decide({
      facts: facts({ rootPath: 'd:/work/app/', sessionCwd: null }),
      folders: ['D:\\work\\app'],
    });
    expect(decision.folder).toEqual({ key: KEY, path: 'D:\\work\\app' });
  });

  // three different folders that Claude names with one key: `D:\work\app`, `D:\work-app` and `D:\work app` all give d--work-app
  const BY_PROJECT = 'D:\\work\\app';
  const BY_SESSION = 'D:\\work-app';
  const BY_CATALOG = 'D:\\work app';

  it('takes the first candidate that is a folder now: the root of the project, the folder of the session, the root of the catalog', async () => {
    const over = { facts: facts({ rootPath: BY_PROJECT, sessionCwd: BY_SESSION }), catalogRoot: BY_CATALOG };
    expect((await decide({ ...over, folders: [BY_PROJECT, BY_SESSION, BY_CATALOG] })).folder?.path).toBe(BY_PROJECT);
    expect((await decide({ ...over, folders: [BY_SESSION, BY_CATALOG] })).folder?.path).toBe(BY_SESSION);
    expect((await decide({ ...over, folders: [BY_CATALOG] })).folder?.path).toBe(BY_CATALOG);
    expect(await decide({ ...over, folders: [] })).toMatchObject({ reason: 'folder_missing', folder: null });
  });

  it('asks about the candidates in that order, stops at the first folder, and asks once about two spellings of one path', async () => {
    const none = fake({
      facts: facts({ rootPath: BY_PROJECT, sessionCwd: 'd:/work/APP/' }),
      catalogRoot: BY_CATALOG,
      folders: [],
    });
    await decideResume(SESSION, none.env);
    expect(none.statted).toEqual([BY_PROJECT, BY_CATALOG]);

    const first = fake({ facts: facts({ rootPath: BY_PROJECT, sessionCwd: BY_SESSION }), catalogRoot: BY_CATALOG });
    await decideResume(SESSION, first.env);
    expect(first.statted).toEqual([BY_PROJECT]);
  });

  it('a folder the session moved to later (another key) is not the folder to resume in', async () => {
    const decision = await decide({
      facts: facts({ sessionCwd: 'D:\\work\\app\\packages\\ui' }),
      folders: ['D:\\work\\app\\packages\\ui', ROOT],
    });
    expect(decision.folder).toEqual({ key: KEY, path: ROOT });
  });

  it('candidates exist and none is a folder: folder_missing, with no folder to show', async () => {
    expect(await decide({ folders: [] })).toEqual({
      ...REFUSED,
      sessionId: SESSION,
      reason: 'folder_missing',
      folder: null,
    });
  });

  it('no candidate has the key of the project: folder_unknown', async () => {
    expect(
      await decide({ facts: facts({ rootPath: null, sessionCwd: 'D:\\elsewhere' }), folders: ['D:\\elsewhere'] }),
    ).toEqual({ ...REFUSED, sessionId: SESSION, reason: 'folder_unknown', folder: null });
    expect(await decide({ facts: facts({ rootPath: null, sessionCwd: null }), catalogRoot: null })).toMatchObject({
      reason: 'folder_unknown',
    });
  });

  it('a session with no project has no folder to find', async () => {
    const decision = await decide({ facts: facts({ projectKey: null, dirName: null }) });
    expect(decision).toMatchObject({ allowed: false, reason: 'folder_unknown', folder: null });
  });

  it('a UNC or device path is never a candidate', async () => {
    const decision = await decide({
      facts: facts({ rootPath: '\\\\host\\share\\app', sessionCwd: null }),
      folders: ['\\\\host\\share\\app'],
    });
    expect(decision).toMatchObject({ reason: 'folder_unknown', folder: null });
  });

  it('a folder whose state cannot be told is not trusted', async () => {
    const decision = await decide({ isDirectory: () => Promise.resolve(null) });
    expect(decision).toMatchObject({ reason: 'folder_missing', folder: null });
  });

  it('a very long path, whose key Claude cut, still finds its project', async () => {
    // 218 characters: valid as a path (at most 240), and over the 200 that Claude keeps of a folder name before it adds a hash
    const long = `D:\\${'a'.repeat(215)}`;
    const dirName = `D--${'a'.repeat(197)}-abc123`;
    const decision = await decide({
      facts: facts({ projectKey: dirName.toLowerCase(), dirName, rootPath: long, sessionCwd: null }),
      folders: [long],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.folder?.key).toBe(dirName.toLowerCase());
  });
});

describe('row 4: the session is live in a terminal of this app', () => {
  it('is refused, a copy too, and the decision names the terminal', async () => {
    const decision = await decide({ sessionOwner: (id) => (id === SESSION ? 'app-1' : null) });
    expect(decision).toEqual({
      sessionId: SESSION,
      allowed: false,
      forkAllowed: false,
      reason: 'live_in_terminal',
      folder: { key: KEY, path: ROOT },
      liveElsewhere: false,
      liveTerminal: 'app-1',
      redirectTo: null,
    });
  });

  it('is checked after the folder and before the registry', async () => {
    const owner = { sessionOwner: () => 'app-1', registry: [entry(10)] };
    expect(await decide({ ...owner, folders: [] })).toMatchObject({ reason: 'folder_missing', liveTerminal: null });
    expect(await decide(owner)).toMatchObject({ reason: 'live_in_terminal', liveElsewhere: false });
  });
});

describe('row 5: the session is live somewhere else', () => {
  it('is refused, but a copy may be made: two writers on one file would interleave', async () => {
    const decision = await decide({ registry: [entry(10)] });
    expect(decision).toEqual({
      sessionId: SESSION,
      allowed: false,
      forkAllowed: true,
      reason: 'live_elsewhere',
      folder: { key: KEY, path: ROOT },
      liveElsewhere: true,
      liveTerminal: null,
      redirectTo: null,
    });
  });

  it('a background session counts as live too', async () => {
    expect(await decide({ registry: [entry(10, { kind: 'bg' })] })).toMatchObject({ reason: 'live_elsewhere' });
  });

  it('the process of a terminal of this app is not elsewhere', async () => {
    const decision = await decide({ registry: [entry(10)], ownedPids: new Set([10]) });
    expect(decision).toMatchObject({ allowed: true, reason: null, liveElsewhere: false });
  });

  it('an entry whose process is gone, or of another session, does not count', async () => {
    const decision = await decide({ registry: [entry(10, { alive: false }), entry(11, { sessionId: uid(2) })] });
    expect(decision).toMatchObject({ allowed: true, reason: null });
  });

  it('one process of this app and one of another program: elsewhere still holds', async () => {
    const decision = await decide({ registry: [entry(10), entry(11)], ownedPids: new Set([10]) });
    expect(decision).toMatchObject({ reason: 'live_elsewhere' });
  });
});

describe('row 6: nothing stands in the way', () => {
  it('both a resume and a copy are allowed', async () => {
    expect(await decide()).toEqual({
      sessionId: SESSION,
      allowed: true,
      forkAllowed: true,
      reason: null,
      folder: { key: KEY, path: ROOT },
      liveElsewhere: false,
      liveTerminal: null,
      redirectTo: null,
    });
  });

  it('a session started outside the app is eligible by the same rules: the transcript is what matters', async () => {
    const decision = await decide({ facts: facts({ entrypoint: 'sdk-cli' }) });
    expect(decision.allowed).toBe(true);
  });
});

describe('redirectTo', () => {
  it('names the session that carried this one on, when the database knows it', async () => {
    const decision = await decide({
      facts: facts({ continuedIn: uid(2) }),
      knowsSession: (id) => id === uid(2),
    });
    expect(decision).toMatchObject({ allowed: true, redirectTo: uid(2) });
  });

  it('is left out for a session the database has never seen, and for one that names itself', async () => {
    expect((await decide({ facts: facts({ continuedIn: uid(2) }) })).redirectTo).toBeNull();
    const self = await decide({ facts: facts({ continuedIn: SESSION }), knowsSession: () => true });
    expect(self.redirectTo).toBeNull();
  });

  it('is informational: it is carried by a refusal too', async () => {
    const decision = await decide({
      facts: facts({ continuedIn: uid(2), mainFile: null }),
      knowsSession: () => true,
    });
    expect(decision).toMatchObject({ reason: 'transcript_gone', redirectTo: uid(2) });
  });
});

describe('the plan', () => {
  async function plan(fork: boolean, over: Parameters<typeof fake>[0] = {}): Promise<ResumePlan> {
    return resumePlanOf(await decideResume(SESSION, fake(over).env), fork);
  }

  it('a resume continues the same session in the folder of the project', async () => {
    expect(await plan(false)).toEqual({
      sessionId: SESSION,
      folderPath: ROOT,
      folderKey: KEY,
      args: ['--resume', SESSION],
      mode: 'resume',
      expectsSameId: true,
      redirectTo: null,
    });
  });

  it('a copy adds --fork-session and expects a new id', async () => {
    expect(await plan(true)).toMatchObject({
      args: ['--resume', SESSION, '--fork-session'],
      mode: 'fork',
      expectsSameId: false,
    });
  });

  it('carries the redirect', async () => {
    const result = await plan(false, { facts: facts({ continuedIn: uid(2) }), knowsSession: () => true });
    expect(result.redirectTo).toBe(uid(2));
  });

  it('a session that is live elsewhere is refused as a resume and planned as a copy', async () => {
    const registry = [entry(10)];
    await expect(plan(false, { registry })).rejects.toMatchObject({ name: 'ResumeRefusal', code: 'live_elsewhere' });
    expect(await plan(true, { registry })).toMatchObject({
      mode: 'fork',
      args: ['--resume', SESSION, '--fork-session'],
    });
  });

  it('a session that is live in a terminal is refused either way, and the refusal names the terminal', async () => {
    const owned = { sessionOwner: () => 'app-3' };
    for (const fork of [false, true]) {
      const error = await plan(fork, owned).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResumeRefusal);
      expect(error).toMatchObject({ code: 'live_in_terminal', liveTerminal: 'app-3' });
    }
  });

  it.each([
    ['transcript_gone', { transcriptFile: false }],
    ['folder_missing', { folders: [] as string[] }],
    ['folder_unknown', { facts: facts({ rootPath: null, sessionCwd: null }) }],
  ] as const)('%s refuses a resume and a copy', async (code, over) => {
    for (const fork of [false, true]) {
      await expect(plan(fork, over)).rejects.toMatchObject({ code });
    }
  });

  it('a refusal says the code and nothing else: no id, no path, no terminal in the message', async () => {
    const error = await plan(false, { sessionOwner: () => 'secret-terminal' }).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toBe('resume refused: live_in_terminal');
    expect(message).not.toContain('secret-terminal');
    expect(message).not.toContain(SESSION);
  });
});
