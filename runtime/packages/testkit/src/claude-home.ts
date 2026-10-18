// A fake CLAUDE_CONFIG_DIR (05 4.4): `projects/<project>/<session>.jsonl`, subagent and workflow folders, the pid registry and
// key decoys. It mirrors the home of the pre-4.0 Python fixture builder (removed in 4.0, ADR 0066) and the layout of the survey (docs/research/transcript-survey.md
// section 1). Every mtime is set from `nowMs`, never left to the clock (05 4.6 rule 3). The real ~/.claude is never read.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANARY } from './canary.ts';
import { writeFixtureMarker } from './temp.ts';
import { TranscriptBuilder } from './transcript.ts';

export interface SubagentSpec {
  agentId: string;
  /** Content of `agent-<id>.meta.json`. */
  meta: Record<string, unknown>;
  build(b: TranscriptBuilder): void;
  /** Age of the files; default: the age of the session. */
  mtimeAgeMs?: number;
  /** First record time; default: shortly before the session's last write. */
  startMs?: number;
}

export interface SessionSpec {
  id: string;
  /** Folder name below `projects/` (Claude Code uses the sanitized cwd, see `projectDirName`). */
  project: string;
  build(b: TranscriptBuilder): void;
  /** Age of the session file at `nowMs`; default 0. */
  mtimeAgeMs?: number;
  subagents?: SubagentSpec[];
  /** Agents listed here live in `subagents/workflows/<runId>/` and get a journal; `finished` writes `workflows/<runId>.json`. */
  workflow?: { runId: string; finished: boolean; agents: string[] };
  /** The `cwd` of every record; default `<root>/FIXTURE-cwd/<project>`. */
  cwd?: string;
  /** First record time of the session file; default `nowMs - age - 120 s`. */
  startMs?: number;
}

export interface ClaudeHome {
  readonly root: string;
  readonly projectsDir: string;
  sessionPath(id: string): string;
}

// A POSIX cwd maps to a folder name that starts with a dash (`/home/x` -> `-home-x`); '.', '..' and separators stay out.
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function check(what: string, value: string, re: RegExp): void {
  if (!re.test(value)) throw new RangeError(`buildClaudeHome: ${what} '${value}' is not a safe name`);
}

function touch(path: string, ms: number): void {
  const at = new Date(ms);
  utimesSync(path, at, at);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLines(path: string, lines: readonly unknown[]): void {
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

/** Path of a subagent transcript as `buildClaudeHome` lays it out (`runId` set for a workflow agent). */
export function subagentPath(
  projectsDir: string,
  project: string,
  sessionId: string,
  agentId: string,
  runId?: string,
): string {
  const base = join(projectsDir, project, sessionId, 'subagents');
  return join(runId === undefined ? base : join(base, 'workflows', runId), `agent-${agentId}.jsonl`);
}

export function buildClaudeHome(
  root: string,
  spec: { sessions: SessionSpec[]; registry?: Record<string, unknown>[]; keyDecoys?: boolean; nowMs: number },
): ClaudeHome {
  writeFixtureMarker(root);
  const projectsDir = join(root, 'projects');
  const paths = new Map<string, string>();
  for (const session of spec.sessions) {
    check('session id', session.id, SAFE_ID);
    check('project', session.project, SAFE_NAME);
    const projectDir = join(projectsDir, session.project);
    const sessionDir = join(projectDir, session.id);
    const age = session.mtimeAgeMs ?? 0;
    const cwd = session.cwd ?? join(root, 'FIXTURE-cwd', session.project);
    const startMs = session.startMs ?? spec.nowMs - age - 120_000;
    const file = join(projectDir, `${session.id}.jsonl`);
    const main = new TranscriptBuilder({ sessionId: session.id, cwd, startMs });
    session.build(main);
    main.write(file);
    touch(file, spec.nowMs - age);
    paths.set(session.id, file);

    const runId = session.workflow?.runId;
    const inWorkflow = new Set(session.workflow?.agents ?? []);
    const agents = session.subagents ?? [];
    for (const sub of agents) {
      check('agent id', sub.agentId, SAFE_ID);
      const subFile = subagentPath(
        projectsDir,
        session.project,
        session.id,
        sub.agentId,
        inWorkflow.has(sub.agentId) ? runId : undefined,
      );
      const subAge = sub.mtimeAgeMs ?? age;
      const builder = new TranscriptBuilder({
        sessionId: session.id,
        cwd,
        startMs: sub.startMs ?? spec.nowMs - subAge - 60_000,
        agentId: sub.agentId,
      });
      sub.build(builder);
      builder.write(subFile);
      const metaFile = subFile.replace(/\.jsonl$/, '.meta.json');
      writeJson(metaFile, sub.meta);
      touch(subFile, spec.nowMs - subAge);
      touch(metaFile, spec.nowMs - subAge);
    }

    if (session.workflow !== undefined && runId !== undefined) {
      check('run id', runId, SAFE_ID);
      const known = new Set(agents.map((a) => a.agentId));
      for (const id of session.workflow.agents) {
        if (!known.has(id))
          throw new RangeError(`buildClaudeHome: workflow ${runId} lists agent ${id} that is not in subagents`);
      }
      const wfDir = join(sessionDir, 'subagents', 'workflows', runId);
      mkdirSync(wfDir, { recursive: true });
      const members = session.workflow.agents;
      const resultsFor = session.workflow.finished ? members : members.slice(0, -1);
      const journal = join(wfDir, 'journal.jsonl');
      writeLines(journal, [
        { type: 'launched' },
        ...members.map((agentId) => ({
          type: 'started',
          agentId,
          key: `FIXTURE-key-${agentId}`,
          label: `FIXTURE label ${agentId}`,
          phase: 'FIXTURE phase',
        })),
        ...resultsFor.map((agentId) => ({
          type: 'result',
          agentId,
          key: `FIXTURE-key-${agentId}`,
          result: { ok: true },
        })),
      ]);
      touch(journal, spec.nowMs - age);
      if (session.workflow.finished) {
        const status = join(sessionDir, 'workflows', `${runId}.json`);
        mkdirSync(join(sessionDir, 'workflows'), { recursive: true });
        writeJson(status, {
          runId,
          status: 'completed',
          workflowName: 'FIXTURE workflow',
          agentCount: members.length,
          startTime: startMs,
          durationMs: 1000,
          summary: 'FIXTURE workflow summary',
        });
        touch(status, spec.nowMs - age);
      }
    }
  }

  const registry = spec.registry ?? [];
  const pids: number[] = [];
  if (registry.length > 0 || spec.keyDecoys === true) mkdirSync(join(root, 'sessions'), { recursive: true });
  for (const entry of registry) {
    const pid = entry['pid'];
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
      throw new RangeError('buildClaudeHome: every registry entry needs a numeric pid');
    }
    pids.push(pid);
    const file = join(root, 'sessions', `${String(pid)}.json`);
    writeJson(file, entry);
    touch(file, spec.nowMs);
  }
  if (spec.keyDecoys === true) {
    // A decoy `.key` file holds only the canary: nothing may ever open it (05 4.10, secrets-never-read).
    for (const pid of pids.length > 0 ? pids : [999_999]) {
      const file = join(root, 'sessions', `${String(pid)}.key`);
      writeFileSync(file, CANARY.key);
      touch(file, spec.nowMs);
    }
  }

  return {
    root,
    projectsDir,
    sessionPath: (id) => {
      const path = paths.get(id);
      if (path === undefined) throw new Error(`sessionPath: no session ${id} in this home`);
      return path;
    },
  };
}
