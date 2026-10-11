import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANARY } from './canary.ts';
import { buildClaudeHome, type SessionSpec } from './claude-home.ts';
import { useTempDirs } from './temp.ts';
import { projectDirName } from './transcript.ts';

const tempDir = useTempDirs();
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const IDS = {
  done: '00000000-0000-4000-8000-0000000000a1',
  failing: '00000000-0000-4000-8000-0000000000a2',
  running: '00000000-0000-4000-8000-0000000000a3',
  pending: '00000000-0000-4000-8000-0000000000a4',
  parent: '00000000-0000-4000-8000-0000000000a5',
};

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The spec that corresponds to tests/fixtures/make.py build_home (5 sessions, one subagent, one workflow agent). */
function makePySpecs(): SessionSpec[] {
  const talk = (b: Parameters<SessionSpec['build']>[0]): void => {
    b.user('FIXTURE Please run the build job');
    const id = b.toolUse('Bash', { command: 'echo FIXTURE' });
    b.toolResult(id);
    b.assistant({ messageId: 'msg_final', stop: 'end_turn' });
  };
  return [
    { id: IDS.done, project: 'demo', build: talk, mtimeAgeMs: 600_000 },
    { id: IDS.failing, project: 'demo', build: talk, mtimeAgeMs: 600_000 },
    { id: IDS.running, project: 'demo', build: talk },
    { id: IDS.pending, project: 'demo', build: talk, mtimeAgeMs: 300_000 },
    {
      id: IDS.parent,
      project: 'demo',
      build: talk,
      mtimeAgeMs: 600_000,
      subagents: [
        { agentId: 'aaa111', meta: { model: 'haiku' }, build: talk },
        { agentId: 'bbb222', meta: {}, build: talk },
      ],
      workflow: { runId: 'wf1', finished: true, agents: ['bbb222'] },
    },
  ];
}

describe('buildClaudeHome', () => {
  it('has the structure of make.py build_home (file list compare)', () => {
    const root = tempDir('home').path;
    const home = buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    const expected = [
      ...Object.values(IDS).map((id) => `projects/demo/${id}.jsonl`),
      `projects/demo/${IDS.parent}/subagents/agent-aaa111.jsonl`,
      `projects/demo/${IDS.parent}/subagents/agent-aaa111.meta.json`,
      `projects/demo/${IDS.parent}/subagents/workflows/wf1/agent-bbb222.jsonl`,
      `projects/demo/${IDS.parent}/subagents/workflows/wf1/agent-bbb222.meta.json`,
      `projects/demo/${IDS.parent}/workflows/wf1.json`,
    ].sort();
    // The testkit also writes the marker and the journal that real Claude Code writes next to workflow agents.
    const actual = files(root).filter((f) => f !== 'FIXTURE.md' && !f.endsWith('/journal.jsonl'));
    expect(actual).toEqual(expected);
    expect(files(root)).toContain('FIXTURE.md');
    expect(files(root)).toContain(`projects/demo/${IDS.parent}/subagents/workflows/wf1/journal.jsonl`);
    expect(home.root).toBe(root);
    expect(home.projectsDir).toBe(join(root, 'projects'));
    expect(home.sessionPath(IDS.done)).toBe(join(root, 'projects', 'demo', `${IDS.done}.jsonl`));
    expect(() => home.sessionPath('nope')).toThrow(/nope/);
  });

  it('sets every mtime from nowMs and the age, never from the clock', () => {
    const root = tempDir('home2').path;
    const home = buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    expect(Math.round(statSync(home.sessionPath(IDS.done)).mtimeMs)).toBe(NOW - 600_000);
    expect(Math.round(statSync(home.sessionPath(IDS.running)).mtimeMs)).toBe(NOW);
    const agent = join(root, 'projects', 'demo', IDS.parent, 'subagents', 'agent-aaa111.jsonl');
    expect(Math.round(statSync(agent).mtimeMs)).toBe(NOW - 600_000);
  });

  it('writes subagent meta files and transcripts that carry the agent id', () => {
    const root = tempDir('home3').path;
    buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    const sub = join(root, 'projects', 'demo', IDS.parent, 'subagents');
    expect(JSON.parse(readFileSync(join(sub, 'agent-aaa111.meta.json'), 'utf8'))).toEqual({ model: 'haiku' });
    const first = JSON.parse(readFileSync(join(sub, 'agent-aaa111.jsonl'), 'utf8').split('\n')[0] ?? '') as Record<
      string,
      unknown
    >;
    expect(first['agentId']).toBe('aaa111');
    expect(first['isSidechain']).toBe(true);
    expect(first['sessionId']).toBe(IDS.parent);
  });

  it('finished workflow: json file, journal with started and result for every agent (shape 19)', () => {
    const root = tempDir('home4').path;
    buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    const session = join(root, 'projects', 'demo', IDS.parent);
    const meta = JSON.parse(readFileSync(join(session, 'workflows', 'wf1.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ runId: 'wf1', status: 'completed', agentCount: 1 });
    const journal = readFileSync(join(session, 'subagents', 'workflows', 'wf1', 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(journal.map((j) => j['type'])).toEqual(['launched', 'started', 'result']);
    expect(journal[1]).toMatchObject({ agentId: 'bbb222' });
  });

  it('running workflow: no json file and fewer results than started lines (shape 19)', () => {
    const root = tempDir('home5').path;
    const talk: SessionSpec['build'] = (b) => {
      b.user();
    };
    buildClaudeHome(root, {
      nowMs: NOW,
      sessions: [
        {
          id: IDS.parent,
          project: 'demo',
          build: talk,
          subagents: [
            { agentId: 'aaa111', meta: {}, build: talk },
            { agentId: 'bbb222', meta: {}, build: talk },
          ],
          workflow: { runId: 'wf_00000001-001', finished: false, agents: ['aaa111', 'bbb222'] },
        },
      ],
    });
    const session = join(root, 'projects', 'demo', IDS.parent);
    expect(existsSync(join(session, 'workflows', 'wf_00000001-001.json'))).toBe(false);
    const journal = readFileSync(join(session, 'subagents', 'workflows', 'wf_00000001-001', 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(journal.filter((j) => j['type'] === 'started')).toHaveLength(2);
    expect(journal.filter((j) => j['type'] === 'result')).toHaveLength(1);
  });

  it('writes registry entries as <pid>.json and decoy keys that hold only the canary (shape 24)', () => {
    const root = tempDir('home6').path;
    buildClaudeHome(root, {
      nowMs: NOW,
      sessions: [],
      registry: [
        { pid: 4101, sessionId: IDS.done, status: 'waiting', waitingFor: 'FIXTURE permission prompt' },
        { pid: 4102, sessionId: IDS.running, status: 'busy' },
      ],
      keyDecoys: true,
    });
    expect(JSON.parse(readFileSync(join(root, 'sessions', '4101.json'), 'utf8'))).toMatchObject({ status: 'waiting' });
    expect(files(root)).toEqual([
      'FIXTURE.md',
      'sessions/4101.json',
      'sessions/4101.key',
      'sessions/4102.json',
      'sessions/4102.key',
    ]);
    expect(readFileSync(join(root, 'sessions', '4101.key'), 'utf8')).toBe(CANARY.key);
  });

  it('writes no key files unless asked and rejects a registry entry without a pid', () => {
    const root = tempDir('home7').path;
    buildClaudeHome(root, { nowMs: NOW, sessions: [], registry: [{ pid: 7, status: 'idle' }] });
    expect(files(root).some((f) => f.endsWith('.key'))).toBe(false);
    expect(() =>
      buildClaudeHome(tempDir('home8').path, { nowMs: NOW, sessions: [], registry: [{ status: 'idle' }] }),
    ).toThrow(/pid/);
  });

  it('is idempotent: building twice gives the same files and bytes', () => {
    const root = tempDir('home9').path;
    buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    const first = files(root).map((f) => [f, readFileSync(join(root, f), 'utf8')]);
    buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    expect(files(root).map((f) => [f, readFileSync(join(root, f), 'utf8')])).toEqual(first);
  });

  it('keeps transcripts parseable and labelled FIXTURE, with timestamps before nowMs', () => {
    const root = tempDir('home10').path;
    const home = buildClaudeHome(root, { sessions: makePySpecs(), nowMs: NOW });
    const lines = readFileSync(home.sessionPath(IDS.done), 'utf8').trimEnd().split('\n');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(JSON.stringify(parsed[0])).toContain('FIXTURE');
    for (const r of parsed) expect(Date.parse(String(r['timestamp']))).toBeLessThanOrEqual(NOW);
  });

  it('accepts the project folder name of a POSIX cwd, which starts with a dash (survey shape 25)', () => {
    const root = tempDir('home13').path;
    const project = projectDirName('/tmp/x/FIXTURE-demo');
    expect(project.startsWith('-')).toBe(true);
    const home = buildClaudeHome(root, {
      nowMs: NOW,
      sessions: [
        {
          id: IDS.done,
          project,
          build: (b) => {
            b.user();
          },
        },
      ],
    });
    expect(home.sessionPath(IDS.done)).toBe(join(root, 'projects', project, `${IDS.done}.jsonl`));
    expect(existsSync(home.sessionPath(IDS.done))).toBe(true);
  });

  it('still rejects empty, dot and separator project names', () => {
    const talk: SessionSpec['build'] = (b) => {
      b.user();
    };
    const backslash = String.fromCharCode(92);
    for (const project of ['', '.', '..', 'a/b', `a${backslash}b`]) {
      expect(
        () => buildClaudeHome(tempDir('h14').path, { nowMs: NOW, sessions: [{ id: IDS.done, project, build: talk }] }),
        project,
      ).toThrow(RangeError);
    }
  });

  it('rejects a project or id that could escape the home', () => {
    const talk: SessionSpec['build'] = (b) => {
      b.user();
    };
    expect(() =>
      buildClaudeHome(tempDir('h11').path, { nowMs: NOW, sessions: [{ id: IDS.done, project: '../x', build: talk }] }),
    ).toThrow(RangeError);
    expect(() =>
      buildClaudeHome(tempDir('h12').path, { nowMs: NOW, sessions: [{ id: '../x', project: 'demo', build: talk }] }),
    ).toThrow(RangeError);
  });
});
