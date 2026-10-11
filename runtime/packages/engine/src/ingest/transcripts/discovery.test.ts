// Transcript discovery (02 5.1): the project folder of a repository (T-TR-13) and the files below it (T-TR-12). Real folders
// of the testkit's fake Claude home; the file system is wrapped by a recorder where a test must see which paths were touched.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SID_RE } from '@mcs/shared/protocol';
import { FIXTURE_EPOCH_MS, buildClaudeHome, makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { pathsCaseInsensitive } from '../../platform/host.ts';
import {
  detectTranscriptsDir,
  discoverSession,
  discoverTranscripts,
  nodeDiscoveryFs,
  projectsRoot,
  readAgentMeta,
  readCustomTitle,
  readWorkflowStatus,
  sanitizeProjectName,
  type DiscoveredFile,
  type DiscoveryFs,
  type DiscoveryPolicy,
} from './discovery.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 3_600_000;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const AGENT = 'a1b2c3d4e5f6a7b8c';
const WF_AGENT = 'wfagent0000000001';
const RUN = 'wf_fixture_run_1';

const policy = (over: Partial<DiscoveryPolicy> = {}): DiscoveryPolicy => ({
  nowMs: NOW,
  lookbackMs: 8 * HOUR,
  pinned: new Set(),
  isKnown: () => false,
  ...over,
});

function recording(): { fs: DiscoveryFs; touched: string[]; readdirs: string[] } {
  const touched: string[] = [];
  const readdirs: string[] = [];
  const fs: DiscoveryFs = {
    readdir: (dir) => {
      touched.push(dir);
      readdirs.push(dir);
      return nodeDiscoveryFs.readdir(dir);
    },
    lstat: (file) => {
      touched.push(file);
      return nodeDiscoveryFs.lstat(file);
    },
    readText: (file, max) => {
      touched.push(file);
      return nodeDiscoveryFs.readText(file, max);
    },
    readHead: (file, max) => {
      touched.push(file);
      return nodeDiscoveryFs.readHead(file, max);
    },
  };
  return { fs, touched, readdirs };
}

function byKind(files: readonly DiscoveredFile[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of files) (out[file.kind] ??= []).push(path.basename(file.path));
  return out;
}

function homeWithSessions(root: string): { projectsDir: string; tdir: string } {
  const home = buildClaudeHome(root, {
    nowMs: NOW,
    keyDecoys: true,
    registry: [{ pid: 4242, sessionId: S1 }],
    sessions: [
      {
        id: S1,
        project: 'p1',
        mtimeAgeMs: HOUR,
        build: (b) => b.user('first prompt'),
        subagents: [
          {
            agentId: AGENT,
            meta: { agentType: 'general-purpose', description: 'FIXTURE agent' },
            build: (b) => b.user('go'),
          },
          { agentId: WF_AGENT, meta: { agentType: 'workflow' }, build: (b) => b.user('wf') },
        ],
        workflow: { runId: RUN, finished: true, agents: [WF_AGENT] },
      },
      { id: S2, project: 'p1', mtimeAgeMs: 30 * HOUR, build: (b) => b.user('an old one') },
    ],
  });
  return { projectsDir: home.projectsDir, tdir: path.join(home.projectsDir, 'p1') };
}

describe('projectsRoot and sanitizeProjectName', () => {
  it('uses CLAUDE_CONFIG_DIR, else the .claude folder of the user', () => {
    expect(projectsRoot({ CLAUDE_CONFIG_DIR: path.join('x', 'cfg') })).toBe(path.join('x', 'cfg', 'projects'));
    expect(projectsRoot({ CLAUDE_CONFIG_DIR: '' })).toMatch(/\.claude[\\/]projects$/);
    expect(projectsRoot({})).toMatch(/\.claude[\\/]projects$/);
  });

  it('turns every character outside [A-Za-z0-9] into a dash', () => {
    expect(sanitizeProjectName('D:/mvp/my repo.v2')).toBe('D--mvp-my-repo-v2');
  });
});

describe('detectTranscriptsDir (T-TR-13)', () => {
  function rootWith(...names: string[]): string {
    const root = makeTemp('tdir').path;
    for (const name of names) mkdirSync(path.join(root, name), { recursive: true });
    return root;
  }

  function jsonl(dir: string, name: string, records: readonly unknown[], mtimeMs: number): void {
    const file = path.join(dir, name);
    writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  }

  it('finds the folder named like the sanitized repository', async () => {
    const root = rootWith('D--work-repo', 'other');
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBe(path.join(root, 'D--work-repo'));
  });

  it('finds the lower-case variant', async () => {
    const root = rootWith('d--work-repo');
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBe(path.join(root, 'd--work-repo'));
  });

  it('answers null when the projects folder is missing or is a file', async () => {
    const root = makeTemp('tdir').path;
    expect(await detectTranscriptsDir('D:/work/repo', path.join(root, 'missing'))).toBeNull();
    writeFileSync(path.join(root, 'file'), 'x');
    expect(await detectTranscriptsDir('D:/work/repo', path.join(root, 'file'))).toBeNull();
  });

  it('falls back to the cwd of the newest files when no folder carries the sanitized name', async () => {
    const root = rootWith('proj-a', 'proj-b');
    jsonl(path.join(root, 'proj-a'), 'one.jsonl', [{ type: 'user', cwd: 'D:/elsewhere' }], NOW - 2 * HOUR);
    jsonl(path.join(root, 'proj-b'), 'two.jsonl', [{ type: 'system' }, { type: 'user', cwd: 'D:/work/repo' }], NOW);
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBe(path.join(root, 'proj-b'));
  });

  it('looks at the three newest files of a folder only, and at its first 61 lines only', async () => {
    const root = rootWith('proj-a', 'proj-b');
    const dirA = path.join(root, 'proj-a');
    jsonl(dirA, 'old.jsonl', [{ cwd: 'D:/work/repo' }], NOW - 10 * HOUR);
    for (const [i, name] of ['n1', 'n2', 'n3'].entries()) {
      jsonl(dirA, `${name}.jsonl`, [{ cwd: 'D:/somewhere/else' }], NOW - i * 1000);
    }
    const late = [...Array.from({ length: 61 }, () => ({ type: 'system' })), { cwd: 'D:/work/repo' }];
    jsonl(path.join(root, 'proj-b'), 'late.jsonl', late, NOW);
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBeNull();
    const fits = [...Array.from({ length: 60 }, () => ({ type: 'system' })), { cwd: 'D:/work/repo' }];
    jsonl(path.join(root, 'proj-b'), 'late.jsonl', fits, NOW);
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBe(path.join(root, 'proj-b'));
  });

  it('compares the drive letter without case where the file system does not care', async () => {
    const root = rootWith('proj-a');
    jsonl(path.join(root, 'proj-a'), 'one.jsonl', [{ cwd: 'c:/Work/Repo' }], NOW);
    const found = await detectTranscriptsDir('C:\\work\\repo', root);
    expect(found).toBe(pathsCaseInsensitive ? path.join(root, 'proj-a') : null);
  });

  it('keeps the folder when the session later moved into a subfolder (fixture 25)', async () => {
    const root = rootWith('proj-a');
    jsonl(
      path.join(root, 'proj-a'),
      'one.jsonl',
      [
        { type: 'user', cwd: 'D:/work/repo' },
        { type: 'user', cwd: 'D:/work/repo/sub/folder' },
      ],
      NOW,
    );
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBe(path.join(root, 'proj-a'));
  });

  it('tolerates folders and files it cannot use', async () => {
    const root = rootWith('proj-a', 'empty');
    writeFileSync(path.join(root, 'stray.txt'), 'x');
    jsonl(path.join(root, 'proj-a'), 'bad.jsonl', [], NOW);
    writeFileSync(path.join(root, 'proj-a', 'junk.jsonl'), 'not json\n{"cwd": 5}\n');
    expect(await detectTranscriptsDir('D:/work/repo', root)).toBeNull();
  });
});

describe('discoverTranscripts (T-TR-12)', () => {
  it('classifies the files of a session folder by their place', async () => {
    const { tdir } = homeWithSessions(makeTemp('disc').path);
    const found = await discoverTranscripts(tdir, policy());
    expect(found.sessions.map((s) => s.sessionId)).toEqual([S1]);
    const files = found.sessions[0]?.files ?? [];
    expect(byKind(files)).toEqual({
      session: [`${S1}.jsonl`],
      subagent: [`agent-${AGENT}.jsonl`],
      workflow_agent: [`agent-${WF_AGENT}.jsonl`],
      workflow_journal: ['journal.jsonl'],
      workflow_status: [`${RUN}.json`],
    });
    const wfAgent = files.find((f) => f.kind === 'workflow_agent');
    expect(wfAgent).toMatchObject({ sessionId: S1, agentId: WF_AGENT, runId: RUN });
    expect(files.find((f) => f.kind === 'workflow_journal')).toMatchObject({ agentId: null, runId: RUN });
    expect(files.find((f) => f.kind === 'session')).toMatchObject({ agentId: null, runId: null });
    for (const file of files) {
      expect(file.size).toBeGreaterThan(0);
      expect(file.mtimeMs).toBeGreaterThan(0);
      expect(path.isAbsolute(file.path)).toBe(true);
    }
  });

  it('tracks an old session only when it is pinned, known, or already has hook events', async () => {
    const { tdir } = homeWithSessions(makeTemp('disc').path);
    const sessionIds = async (over: Partial<DiscoveryPolicy>): Promise<string[]> =>
      (await discoverTranscripts(tdir, policy(over))).sessions.map((s) => s.sessionId).sort();
    expect(await sessionIds({})).toEqual([S1]);
    expect(await sessionIds({ pinned: new Set([S2]) })).toEqual([S1, S2]);
    expect(await sessionIds({ isKnown: (id) => id === S2 })).toEqual([S1, S2]);
    expect(await sessionIds({ lookbackMs: 48 * HOUR })).toEqual([S1, S2]);
  });

  it('never treats the word "workflows" in the project path as a workflow (the legacy defect)', async () => {
    const root = path.join(makeTemp('disc').path, 'workflows', 'home');
    const { tdir } = homeWithSessions(root);
    const found = await discoverTranscripts(tdir, policy());
    const agent = found.sessions[0]?.files.find((f) => f.path.endsWith(`agent-${AGENT}.jsonl`));
    expect(agent).toMatchObject({ kind: 'subagent', runId: null });
  });

  it('reads agent files at other depths below subagents (at most 4) as plain subagents', async () => {
    const root = makeTemp('disc').path;
    const { tdir } = homeWithSessions(root);
    const deep = path.join(tdir, S1, 'subagents', 'x', 'y');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'agent-deepagent1.jsonl'), '{}\n');
    const tooDeep = path.join(tdir, S1, 'subagents', 'a', 'b', 'c', 'd', 'e');
    mkdirSync(tooDeep, { recursive: true });
    writeFileSync(path.join(tooDeep, 'agent-toodeepagent.jsonl'), '{}\n');
    const found = await discoverTranscripts(tdir, policy());
    const names = (found.sessions[0]?.files ?? []).map((f) => path.basename(f.path));
    expect(names).toContain('agent-deepagent1.jsonl');
    expect(names).not.toContain('agent-toodeepagent.jsonl');
  });

  it('ignores names that are not ids and the folders it must never open', async () => {
    const root = makeTemp('disc').path;
    const { tdir } = homeWithSessions(root);
    const session = path.join(tdir, S1);
    for (const dir of ['tool-results', 'memory', path.join('workflows', 'scripts')]) {
      mkdirSync(path.join(session, dir), { recursive: true });
      writeFileSync(path.join(session, dir, 'agent-hidden001.jsonl'), '{}\n');
    }
    writeFileSync(path.join(session, 'auto-mode-classifier-error.txt'), 'x');
    writeFileSync(path.join(tdir, 'notes.jsonl'), '{}\n');
    writeFileSync(path.join(tdir, 'ZZZZZZZZ-1111-4111-8111-111111111111.jsonl'), '{}\n');
    writeFileSync(path.join(session, 'subagents', 'agent-ab.jsonl'), '{}\n'); // id shorter than 3
    writeFileSync(path.join(session, 'subagents', 'agent-bad.name.jsonl'), '{}\n');
    const found = await discoverTranscripts(tdir, policy());
    const names = (found.sessions[0]?.files ?? []).map((f) => path.basename(f.path)).sort();
    expect(names).not.toContain('agent-hidden001.jsonl');
    expect(names).not.toContain('agent-ab.jsonl');
    expect(names).not.toContain('agent-bad.name.jsonl');
    expect(found.sessions.every((s) => SID_RE.test(s.sessionId))).toBe(true);
  });

  it('accepts only a workflow run id of the documented form for a workflow agent', async () => {
    const root = makeTemp('disc').path;
    const { tdir } = homeWithSessions(root);
    const odd = path.join(tdir, S1, 'subagents', 'workflows', 'notarun');
    mkdirSync(odd, { recursive: true });
    writeFileSync(path.join(odd, 'agent-oddagent01.jsonl'), '{}\n');
    writeFileSync(path.join(odd, 'journal.jsonl'), '{}\n');
    const found = await discoverTranscripts(tdir, policy());
    const files = found.sessions[0]?.files ?? [];
    expect(files.find((f) => f.path.endsWith('agent-oddagent01.jsonl'))).toMatchObject({
      kind: 'subagent',
      runId: null,
    });
    expect(files.filter((f) => f.kind === 'workflow_journal')).toHaveLength(1);
  });

  it('never opens or looks at a .key file, wherever it lies', async () => {
    const root = makeTemp('disc').path;
    const { projectsDir, tdir } = homeWithSessions(root);
    writeFileSync(path.join(tdir, 'secret.key'), 'FIXTURE-KEY');
    writeFileSync(path.join(tdir, S1, 'token.key'), 'FIXTURE-KEY');
    writeFileSync(path.join(tdir, S1, 'subagents', `agent-${AGENT}.key`), 'FIXTURE-KEY');
    const { fs, touched } = recording();
    await discoverTranscripts(tdir, policy(), fs);
    await discoverSession(tdir, S1, fs);
    await detectTranscriptsDir(path.join(root, 'FIXTURE-cwd', 'p1'), projectsDir, fs);
    expect(touched.length).toBeGreaterThan(5);
    expect(touched.filter((p) => p.endsWith('.key'))).toEqual([]);
  });

  it('skips a link, counts it, and does not follow it', async () => {
    const root = makeTemp('disc').path;
    const { tdir } = homeWithSessions(root);
    // a session folder that is a junction/link to a folder holding transcripts
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(path.join(elsewhere, 'subagents'), { recursive: true });
    writeFileSync(path.join(elsewhere, 'subagents', 'agent-linked0001.jsonl'), '{}\n');
    writeFileSync(path.join(tdir, `${S3}.jsonl`), '{}\n');
    utimesSync(path.join(tdir, `${S3}.jsonl`), new Date(NOW), new Date(NOW));
    makeJunction(path.join(tdir, S3), elsewhere);
    const found = await discoverTranscripts(tdir, policy());
    const s3 = found.sessions.find((s) => s.sessionId === S3);
    expect(s3?.files.map((f) => path.basename(f.path))).toEqual([`${S3}.jsonl`]);
    expect(found.counters.symlinksSkipped).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['subagents', 'agent-linkedagent0001.jsonl'],
    ['workflows', `${RUN}.json`],
  ])('does not enter a %s folder that is a link, counts it, and never lists it', async (name, outsideFile) => {
    const root = makeTemp('disc').path;
    const { tdir } = homeWithSessions(root);
    // a real session folder whose `subagents` or `workflows` entry is a junction/link to a folder outside the transcripts tree
    const outside = path.join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, outsideFile), '{}\n');
    const sessionDir = path.join(tdir, S3);
    mkdirSync(sessionDir);
    writeFileSync(path.join(tdir, `${S3}.jsonl`), '{}\n');
    utimesSync(path.join(tdir, `${S3}.jsonl`), new Date(NOW), new Date(NOW));
    const link = path.join(sessionDir, name);
    makeJunction(link, outside);
    const { fs, readdirs } = recording();
    const found = await discoverTranscripts(tdir, policy(), fs);
    const s3 = found.sessions.find((s) => s.sessionId === S3);
    expect(s3?.files.map((f) => path.basename(f.path))).toEqual([`${S3}.jsonl`]);
    expect(found.counters.symlinksSkipped).toBeGreaterThanOrEqual(1);
    expect(readdirs).not.toContain(link);
    expect(readdirs).not.toContain(outside);
    // the same through a hint: one session folder at once
    const hinted = recording();
    const one = await discoverSession(tdir, S3, hinted.fs);
    expect(one?.files.map((f) => path.basename(f.path))).toEqual([`${S3}.jsonl`]);
    expect(hinted.readdirs).not.toContain(link);
    expect(hinted.readdirs).not.toContain(outside);
  });

  it('skips a transcript file that is a link (the file system wrapper reports it as one)', async () => {
    const { tdir } = homeWithSessions(makeTemp('disc').path);
    const linked = path.join(tdir, `${S1}.jsonl`);
    const fs: DiscoveryFs = {
      ...nodeDiscoveryFs,
      lstat: async (file) => {
        const stat = await nodeDiscoveryFs.lstat(file);
        return file === linked && stat !== null ? { ...stat, kind: 'link' } : stat;
      },
    };
    const found = await discoverTranscripts(tdir, policy({ pinned: new Set([S1]) }), fs);
    expect(found.sessions.flatMap((s) => s.files).some((f) => f.kind === 'session')).toBe(false);
    expect(found.counters.symlinksSkipped).toBe(1);
  });

  it('discovers a folder on a hint, whatever the age policy says, and refuses a bad id', async () => {
    const { tdir } = homeWithSessions(makeTemp('disc').path);
    const hinted = await discoverSession(tdir, S2);
    expect(hinted?.files.map((f) => f.kind)).toEqual(['session']);
    expect(await discoverSession(tdir, 'not-a-session-id')).toBeNull();
    expect(await discoverSession(tdir, S3)).toBeNull();
  });

  it('returns nothing for a folder that does not exist', async () => {
    const root = makeTemp('disc').path;
    const found = await discoverTranscripts(path.join(root, 'missing'), policy());
    expect(found).toMatchObject({ sessions: [], missing: true });
  });

  it('records the birth time only where the platform has one', async () => {
    const { tdir } = homeWithSessions(makeTemp('disc').path);
    const found = await discoverTranscripts(tdir, policy());
    for (const file of found.sessions[0]?.files ?? []) {
      expect(file.birthMs === null || file.birthMs > 0).toBe(true);
    }
  });
});

describe('the small files beside the transcripts', () => {
  function write(name: string, content: string | object): string {
    const file = path.join(makeTemp('meta').path, name);
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  }

  it('reads the scalar metadata of an agent and clips and redacts it', async () => {
    const jsonl = write('agent-a1b2c3.jsonl', '{}\n');
    writeFileSync(
      jsonl.replace(/\.jsonl$/, '.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'lorem ipsum '.repeat(40),
        model: 'claude-sonnet-5-5',
        requestShape: 'background',
        spawnDepth: 2,
        toolUseId: 'toolu_abc',
        workflowPhase: 'build',
        label: 'FIXTURE label',
        junk: { nested: true },
      }),
    );
    const meta = await readAgentMeta(jsonl);
    expect(meta).toMatchObject({
      agentType: 'general-purpose',
      model: 'claude-sonnet-5-5',
      requestShape: 'background',
      spawnToolUseId: 'toolu_abc',
      workflowPhase: 'build',
    });
    expect(Array.from(meta?.description ?? '')).toHaveLength(160);
    expect(JSON.stringify(meta)).not.toContain('junk');
  });

  it('answers null for a meta file that is missing, invalid, not an object or larger than 64 KiB', async () => {
    const jsonl = write('agent-a1b2c3.jsonl', '{}\n');
    const meta = jsonl.replace(/\.jsonl$/, '.meta.json');
    expect(await readAgentMeta(jsonl)).toBeNull();
    writeFileSync(meta, 'not json');
    expect(await readAgentMeta(jsonl)).toBeNull();
    writeFileSync(meta, '[1]');
    expect(await readAgentMeta(jsonl)).toBeNull();
    writeFileSync(meta, JSON.stringify({ agentType: 'x', pad: 'p'.repeat(70_000) }));
    expect(await readAgentMeta(jsonl)).toBeNull();
  });

  it('reads the custom title, clipped to 120 code points', async () => {
    expect(await readCustomTitle(write('custom-title.json', { customTitle: 'My title' }))).toBe('My title');
    expect(
      Array.from((await readCustomTitle(write('custom-title.json', { customTitle: 'title words '.repeat(30) }))) ?? ''),
    ).toHaveLength(120);
    expect(await readCustomTitle(write('custom-title.json', { customTitle: 5 }))).toBeNull();
    expect(await readCustomTitle(write('custom-title.json', 'nope'))).toBeNull();
  });

  it('reads only the scalars of a workflow status file', async () => {
    const file = write(`${RUN}.json`, {
      runId: RUN,
      status: 'completed',
      workflowName: 'FIXTURE workflow',
      agentCount: 3,
      durationMs: 1000,
      startTime: FIXTURE_EPOCH_MS,
      script: 'SENTINEL-SCRIPT',
      result: { text: 'SENTINEL-RESULT' },
      logs: ['SENTINEL-LOG'],
      phases: [{ detail: 'SENTINEL-DETAIL' }],
    });
    const status = await readWorkflowStatus(file);
    expect(status).toEqual({
      runId: RUN,
      status: 'completed',
      workflowName: 'FIXTURE workflow',
      agentCount: 3,
      durationMs: 1000,
      startTime: FIXTURE_EPOCH_MS,
    });
    expect(JSON.stringify(status)).not.toContain('SENTINEL');
  });

  it('answers null for a status file that is invalid or larger than 8 MiB', async () => {
    expect(await readWorkflowStatus(write(`${RUN}.json`, 'not json'))).toBeNull();
    expect(
      await readWorkflowStatus(write(`${RUN}.json`, JSON.stringify({ status: 'x', pad: 'p'.repeat(9 * 1024 * 1024) }))),
    ).toBeNull();
  });
});

describe('a session folder next to its title', () => {
  it('names the custom title file of the session', async () => {
    const { tdir } = homeWithSessions(makeTemp('disc').path);
    writeFileSync(path.join(tdir, S1, 'custom-title.json'), JSON.stringify({ customTitle: 'Named' }));
    const found = await discoverTranscripts(tdir, policy());
    expect(found.sessions[0]?.customTitlePath).toBe(path.join(tdir, S1, 'custom-title.json'));
    const plain = await discoverSession(tdir, S2);
    expect(plain?.customTitlePath).toBeNull();
  });
});
