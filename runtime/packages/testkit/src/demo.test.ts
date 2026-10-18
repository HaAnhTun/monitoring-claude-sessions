import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { INSTALLED_HOOK_EVENTS } from '@mcs/shared/protocol';
import { basename } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildDemo, DEMO_LETTERS, type DemoLetter, type DemoOptions, type DemoResult } from './demo.ts';
import { useTempDirs } from './temp.ts';
import type * as TranscriptModule from './transcript.ts';
import { snapshotTree } from './workspace.ts';

// A switch that makes the demo derive its project folder name as a POSIX host does (a leading dash, survey shape 25).
const host = vi.hoisted(() => ({ posix: false }));
vi.mock('./transcript.ts', async (importOriginal) => {
  const original = await importOriginal<typeof TranscriptModule>();
  return {
    ...original,
    projectDirName: (cwd: string): string =>
      host.posix ? original.projectDirName(`/tmp/x/${basename(cwd)}`) : original.projectDirName(cwd),
  };
});

const tempDir = useTempDirs();
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

type Rec = Record<string, unknown>;

function parseLines(path: string): Rec[] {
  const text = readFileSync(path, 'utf8');
  expect(text.endsWith('\n'), path).toBe(true);
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Rec);
}

/** Every transcript file of one letter: the session file and its agents. */
function transcriptsOf(demo: DemoResult, letter: DemoLetter): string[] {
  const session = demo.sessions[letter];
  return [session.transcriptPath, ...session.agents.map((a) => a.transcriptPath)];
}

/** Independent re-computation of the totals: dedupe by message id, last snapshot of an id wins. */
function usageFromFiles(paths: string[]): { input: number; output: number; cacheCreation: number; cacheRead: number } {
  const byId = new Map<string, Rec>();
  for (const path of paths) {
    for (const record of parseLines(path)) {
      if (record['type'] !== 'assistant') continue;
      const message = record['message'] as Rec;
      byId.set(message['id'] as string, message['usage'] as Rec);
    }
  }
  const total = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const usage of byId.values()) {
    total.input += usage['input_tokens'] as number;
    total.output += usage['output_tokens'] as number;
    total.cacheCreation += usage['cache_creation_input_tokens'] as number;
    total.cacheRead += usage['cache_read_input_tokens'] as number;
  }
  return total;
}

function countTools(paths: string[]): { calls: number; errors: number } {
  const ids = new Set<string>();
  let errors = 0;
  for (const path of paths) {
    for (const record of parseLines(path)) {
      const content = (record['message'] as Rec | undefined)?.['content'];
      if (!Array.isArray(content)) continue;
      for (const block of content as Rec[]) {
        if (block['type'] === 'tool_use') ids.add(block['id'] as string);
        if (block['type'] === 'tool_result' && block['is_error'] === true) errors += 1;
      }
    }
  }
  return { calls: ids.size, errors };
}

describe('buildDemo options (registry C34)', () => {
  it('takes exactly {root, nowMs, letters?, project?}', () => {
    const options: DemoOptions = { root: 'r', nowMs: 1 };
    const withAll: DemoOptions = { root: 'r', nowMs: 1, letters: ['A'], project: 'FIXTURE-x' };
    expect(Object.keys(options)).toEqual(['root', 'nowMs']);
    expect(Object.keys(withAll).sort()).toEqual(['letters', 'nowMs', 'project', 'root']);
    expect(DEMO_LETTERS).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('rejects unusable options', async () => {
    const root = tempDir('demo-opts').path;
    await expect(buildDemo({ root, nowMs: Number.NaN })).rejects.toThrow(RangeError);
    await expect(buildDemo({ root, nowMs: NOW, letters: ['Z' as DemoLetter] })).rejects.toThrow(RangeError);
    await expect(buildDemo({ root, nowMs: NOW, letters: ['A', 'A'] })).rejects.toThrow(RangeError);
    await expect(buildDemo({ root, nowMs: NOW, project: '../x' })).rejects.toThrow(RangeError);
  });
});

describe('buildDemo result', () => {
  it('lays out claudeHome, repo, projectDir and the config under root', async () => {
    const root = tempDir('demo').path;
    const demo = await buildDemo({ root, nowMs: NOW });
    for (const path of [demo.claudeHome, demo.repo, demo.projectDir, demo.configPath]) {
      expect(path.startsWith(root), path).toBe(true);
      expect(existsSync(path), path).toBe(true);
    }
    expect(demo.projectDir.startsWith(join(demo.claudeHome, 'projects'))).toBe(true);
    expect(readFileSync(join(root, 'FIXTURE.md'), 'utf8')).toContain('Synthetic');
    expect(demo.repo.endsWith('FIXTURE-demo')).toBe(true);
    expect(Object.keys(demo.sessions)).toEqual([...DEMO_LETTERS]);
  });

  it('writes a legacy-compatible config with the attempts regexes and poll.stale_after_ms 4000', async () => {
    const demo = await buildDemo({ root: tempDir('demo2').path, nowMs: NOW });
    const written = JSON.parse(readFileSync(demo.configPath, 'utf8')) as Rec;
    expect(written).toEqual(demo.configJson);
    expect(written['schema_version']).toBe(1);
    expect(written['repo']).toBe(demo.repo);
    expect(written['transcripts_dir']).toBe(demo.projectDir);
    expect((written['poll'] as Rec)['stale_after_ms']).toBe(4000);
    expect(written['session_rules']).toBeInstanceOf(Array);
    expect(Object.keys(written['attempts'] as Rec)).toEqual(expect.arrayContaining(['start', 'end']));
    for (const key of ['start', 'end']) {
      expect(() => new RegExp(String((written['attempts'] as Rec)[key]), 'vy')).not.toThrow();
    }
    expect(written['port']).toBeUndefined();
  });

  it('writes valid JSON per line for every transcript of every letter', async () => {
    const demo = await buildDemo({ root: tempDir('demo3').path, nowMs: NOW });
    for (const letter of DEMO_LETTERS) {
      const paths = transcriptsOf(demo, letter);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) expect(parseLines(path).length, path).toBeGreaterThan(0);
    }
  });

  it('two runs with the same nowMs produce byte-identical trees', async () => {
    const root = tempDir('demo4').path;
    await buildDemo({ root, nowMs: NOW });
    const first = snapshotTree(root);
    await buildDemo({ root, nowMs: NOW });
    expect(snapshotTree(root)).toBe(first);
  });

  it('another nowMs changes the timestamps', async () => {
    const root = tempDir('demo5').path;
    await buildDemo({ root, nowMs: NOW });
    const first = snapshotTree(root);
    await buildDemo({ root, nowMs: NOW + 1000 });
    expect(snapshotTree(root)).not.toBe(first);
  });

  it('expected usage equals totals recomputed from the files (never from the builder)', async () => {
    const demo = await buildDemo({ root: tempDir('demo6').path, nowMs: NOW });
    for (const letter of DEMO_LETTERS) {
      expect(demo.expected[letter].usage, letter).toEqual(usageFromFiles(transcriptsOf(demo, letter)));
      expect(demo.expected[letter].usage.output, letter).toBeGreaterThan(0);
    }
  });

  it('expected tool call and error counts match the files', async () => {
    const demo = await buildDemo({ root: tempDir('demo7').path, nowMs: NOW });
    for (const letter of DEMO_LETTERS) {
      const counted = countTools(transcriptsOf(demo, letter));
      expect(demo.expected[letter].toolCalls, letter).toBe(counted.calls);
      expect(demo.expected[letter].errors, letter).toBe(counted.errors);
    }
    expect(demo.expected.B.errors).toBe(2);
    expect(demo.expected.E.toolCalls).toBe(420);
  });

  it('describes the eight scenarios of 04 11.5', async () => {
    const demo = await buildDemo({ root: tempDir('demo8').path, nowMs: NOW });
    const states = Object.fromEntries(DEMO_LETTERS.map((l) => [l, demo.expected[l].legacyState]));
    expect(states).toEqual({
      A: 'COMPLETED',
      B: 'FAILED',
      C: 'RUNNING',
      D: 'IDLE',
      E: 'IDLE',
      F: 'RUNNING',
      G: 'UNKNOWN',
      H: 'IDLE',
    });
    expect(DEMO_LETTERS.filter((l) => demo.expected[l].active)).toEqual(['C', 'F']);
    expect(demo.sessions.F.agents).toHaveLength(4);
    expect(demo.sessions.F.agents.every((a) => a.workflow === 'wf_fixture-review')).toBe(true);
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'G', 'H'] as const) expect(demo.sessions[letter].agents).toEqual([]);
  });

  it('sets transcript ages from nowMs (C running, A idle for a while)', async () => {
    const demo = await buildDemo({ root: tempDir('demo9').path, nowMs: NOW });
    expect(Math.round(statSync(demo.sessions.C.transcriptPath).mtimeMs)).toBe(NOW - 25_000);
    expect(Math.round(statSync(demo.sessions.A.transcriptPath).mtimeMs)).toBe(NOW - 2_400_000);
  });

  it('keeps every user-like string labelled FIXTURE, in transcripts and hook payloads', async () => {
    const demo = await buildDemo({ root: tempDir('demo10').path, nowMs: NOW });
    for (const letter of DEMO_LETTERS) {
      for (const path of transcriptsOf(demo, letter)) {
        for (const record of parseLines(path)) {
          const message = record['message'] as Rec | undefined;
          if (message === undefined) continue;
          const content = message['content'];
          if (typeof content === 'string') expect(content, path).toMatch(/^FIXTURE/);
          else if (Array.isArray(content)) {
            for (const block of content as Rec[]) {
              if (block['type'] === 'text') expect(block['text'], path).toMatch(/^FIXTURE/);
              if (block['type'] === 'tool_result' && typeof block['content'] === 'string')
                expect(block['content'], path).toMatch(/^FIXTURE/);
            }
          }
        }
      }
      for (const { payload } of demo.hookPayloads[letter]) {
        for (const key of ['prompt', 'last_assistant_message', 'message', 'title']) {
          if (typeof payload[key] === 'string') expect(payload[key], `${letter}.${key}`).toMatch(/^FIXTURE/);
        }
      }
    }
  });

  it('letter H carries hostile strings, still labelled', async () => {
    const demo = await buildDemo({ root: tempDir('demo11').path, nowMs: NOW });
    const text = readFileSync(demo.sessions.H.transcriptPath, 'utf8');
    expect(text).toContain('<script>');
    expect(text).toContain('javascript:');
    expect(text).toContain('\\u001b[');
    expect(text).toContain('FIXTURE');
  });

  it('hook payloads are raw payloads that agree with the transcripts', async () => {
    const demo = await buildDemo({ root: tempDir('demo12').path, nowMs: NOW });
    for (const letter of DEMO_LETTERS) {
      const session = demo.sessions[letter];
      const known = new Set<string>();
      const agentPaths = new Set(session.agents.map((a) => a.transcriptPath));
      for (const path of transcriptsOf(demo, letter)) {
        for (const record of parseLines(path)) {
          const content = (record['message'] as Rec | undefined)?.['content'];
          if (Array.isArray(content))
            for (const block of content as Rec[]) if (block['type'] === 'tool_use') known.add(block['id'] as string);
        }
      }
      const payloads = demo.hookPayloads[letter];
      expect(payloads.length, letter).toBeGreaterThan(0);
      expect(payloads[0]?.event, letter).toBe('SessionStart');
      for (const { event, payload } of payloads) {
        expect(INSTALLED_HOOK_EVENTS).toContain(event);
        expect(payload['hook_event_name']).toBe(event);
        expect(payload['session_id']).toBe(session.sessionId);
        expect(payload['transcript_path']).toBe(session.transcriptPath);
        expect('hook' in payload || 'envelope' in payload).toBe(false);
        if (typeof payload['agent_transcript_path'] === 'string')
          expect(agentPaths.has(payload['agent_transcript_path'])).toBe(true);
        if (typeof payload['tool_use_id'] === 'string' && event !== 'PermissionRequest')
          expect(known.has(payload['tool_use_id']), `${letter} ${payload['tool_use_id']}`).toBe(true);
      }
    }
  });

  it('delivers C with a pending tool and F with subagent hooks', async () => {
    const demo = await buildDemo({ root: tempDir('demo13').path, nowMs: NOW });
    const c = demo.hookPayloads.C.map((h) => h.event);
    expect(c.at(-1)).toBe('PreToolUse');
    expect(demo.hookPayloads.A.at(-1)?.event).toBe('SessionEnd');
    const f = demo.hookPayloads.F.map((h) => h.event);
    expect(f.filter((e) => e === 'SubagentStart')).toHaveLength(4);
    expect(f.filter((e) => e === 'SubagentStop')).toHaveLength(3);
  });

  it('writes the chain log and the ledger the attempts and ledger panels read', async () => {
    const demo = await buildDemo({ root: tempDir('demo14').path, nowMs: NOW });
    const log = readFileSync(join(demo.repo, 'logs', 'chain.log'), 'utf8');
    expect(log).toMatch(/STEP A START attempt 1/);
    expect(log).toMatch(/STEP A END exit=0 status=PASS/);
    expect(log).toMatch(/STEP B END exit=1 status=FAIL/);
    // The attempts patterns are JavaScript regexes (ADR 0067): compiled directly with the attempts flags, they match the lines.
    const attempts = demo.configJson['attempts'] as Rec;
    const start = new RegExp(String(attempts['start']), 'vy');
    const end = new RegExp(String(attempts['end']), 'vy');
    const lines = log.split(String.fromCharCode(10)).filter((line) => line !== '');
    const starts = lines.filter((line) => line.includes(' START '));
    const ends = lines.filter((line) => line.includes(' END '));
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.length).toBeGreaterThan(0);
    for (const line of starts) {
      start.lastIndex = 0;
      expect(start.exec(line)?.groups, line).toMatchObject({ n: '1', effort: expect.any(String) as unknown });
      end.lastIndex = 0;
      expect(end.exec(line), line).toBeNull();
    }
    for (const line of ends) {
      end.lastIndex = 0;
      expect(end.exec(line)?.groups?.['status'], line).toMatch(/^(PASS|FAIL)$/);
    }
    expect(readFileSync(join(demo.repo, 'docs', 'status.md'), 'utf8')).toMatch(/^\| Step \| Status/);
  });
});

describe('buildDemo on a POSIX host', () => {
  it('builds with a project folder name that starts with a dash', async () => {
    host.posix = true;
    try {
      const demo = await buildDemo({ root: tempDir('demo-posix').path, nowMs: NOW, letters: ['A'] });
      expect(basename(demo.projectDir).startsWith('-')).toBe(true);
      expect(existsSync(demo.sessions.A.transcriptPath)).toBe(true);
    } finally {
      host.posix = false;
    }
  });
});

describe('buildDemo letters', () => {
  it('writes files only for the requested letters', async () => {
    const root = tempDir('demo15').path;
    const demo = await buildDemo({ root, nowMs: NOW, letters: ['A', 'C'] });
    const written = readdirSync(demo.projectDir).filter((n) => n.endsWith('.jsonl'));
    expect(written.sort()).toEqual([demo.sessions.A, demo.sessions.C].map((s) => `${s.sessionId}.jsonl`).sort());
    expect(existsSync(demo.sessions.B.transcriptPath)).toBe(false);
    expect(demo.hookPayloads.B).toEqual([]);
    expect(demo.hookPayloads.A.length).toBeGreaterThan(0);
  });

  it('keeps a letter identical whether or not the others are built (same root)', async () => {
    const root = tempDir('demo16').path;
    const some = await buildDemo({ root, nowMs: NOW, letters: ['D'] });
    const all = await buildDemo({ root, nowMs: NOW });
    expect(some.sessions.D.sessionId).toBe(all.sessions.D.sessionId);
    expect(some.expected.D).toEqual(all.expected.D);
    expect(some.hookPayloads.D.map((h) => h.event)).toEqual(all.hookPayloads.D.map((h) => h.event));
  });

  it('uses the project option for the repo folder', async () => {
    const demo = await buildDemo({
      root: tempDir('demo18').path,
      nowMs: NOW,
      project: 'FIXTURE-other',
      letters: ['A'],
    });
    expect(demo.repo.endsWith('FIXTURE-other')).toBe(true);
  });

  it('gives two demos in two roots different session ids (isolation tests need disjoint instances)', async () => {
    const a = await buildDemo({ root: tempDir('demo19').path, nowMs: NOW, letters: ['A'] });
    const b = await buildDemo({ root: tempDir('demo20').path, nowMs: NOW, letters: ['A'] });
    expect(a.sessions.A.sessionId).not.toBe(b.sessions.A.sessionId);
    expect(a.repo).not.toBe(b.repo);
    const ids = new Set(Object.values(a.sessions).map((s) => s.sessionId));
    expect(ids.size).toBe(DEMO_LETTERS.length);
  });
});
