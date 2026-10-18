// The link of a transcript file to its rows (WP-98): idempotent, an agent file creates its missing agent row, the right
// `transcript_file_id` is set, and a file of another session is refused.
import { join } from 'node:path';

import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_INSTANCE_ID, FIXTURE_SESSION_ID } from '../../test/fixtures/hook-sequences.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { AgentsRepo } from '../db/repos/agents.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { TranscriptFilesRepo, type TranscriptFileKind } from '../db/repos/transcript-files.ts';
import { WorkflowRunsRepo } from '../db/repos/workflow-runs.ts';
import { withWriteTx } from '../db/write.ts';
import { linkTranscriptFile, type LinkableFile, type LinkRepos } from './link-file.ts';

const tempDir = useTempDirs();
const CTX = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = Date.UTC(2026, 0, 2, 3, 0, 0);
const OTHER_SESSION = '77777777-7777-4777-8777-777777777777';
const AGENT_UID = 'a0123456789abcdef';

const dbs: InstanceDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function setup(): { db: InstanceDb; repos: LinkRepos } {
  const db = openInstanceDb({
    path: join(tempDir('link-file').path, 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(NOW),
  });
  dbs.push(db);
  const repos: LinkRepos = {
    sessions: new SessionsRepo(db),
    agents: new AgentsRepo(db),
    runs: new WorkflowRunsRepo(db),
    files: new TranscriptFilesRepo(db),
  };
  return { db, repos };
}

function register(db: InstanceDb, repos: LinkRepos, kind: TranscriptFileKind, sessionUid: string): LinkableFile {
  const agentUid = kind === 'session' ? null : AGENT_UID;
  const { id } = withWriteTx(db, CTX, (tx) =>
    repos.files.register(CTX, tx, {
      path: `/transcripts/${kind}.jsonl`,
      pathKey: `/transcripts/${kind}.jsonl`,
      kind,
      sessionUid,
      agentUid,
      runUid: null,
      sessionId: null,
      agentId: null,
      workflowRunId: null,
      birthMs: null,
      firstSeenMtimeMs: null,
      mtimeSeen: null,
    }),
  );
  return { id, kind, sessionUid, agentUid, runUid: null };
}

function ensureSession(db: InstanceDb, repos: LinkRepos, uid: string): number {
  return withWriteTx(db, CTX, (tx) =>
    repos.sessions.ensure(CTX, tx, { sessionUid: uid, projectId: null, startedAt: NOW }),
  ).id;
}

describe('linkTranscriptFile', () => {
  it('links a session file, sets sessions.transcript_file_id, and a second call changes nothing', () => {
    const { db, repos } = setup();
    const file = register(db, repos, 'session', FIXTURE_SESSION_ID);
    const sessionId = ensureSession(db, repos, FIXTURE_SESSION_ID);
    const link = withWriteTx(db, CTX, (tx) => linkTranscriptFile(CTX, tx, repos, file));
    expect(link).toEqual({ sessionId, agentId: null, runId: null, complete: true });
    expect(repos.files.get(CTX, file.id)?.sessionId).toBe(sessionId);
    expect(repos.sessions.byUid(CTX, FIXTURE_SESSION_ID)?.transcriptFileId).toBe(file.id);

    const before = {
      file: repos.files.get(CTX, file.id),
      session: repos.sessions.byUid(CTX, FIXTURE_SESSION_ID),
    };
    const again = withWriteTx(db, CTX, (tx) => linkTranscriptFile(CTX, tx, repos, file));
    expect(again).toEqual(link);
    expect(repos.files.get(CTX, file.id)).toEqual(before.file);
    expect(repos.sessions.byUid(CTX, FIXTURE_SESSION_ID)).toEqual(before.session);
  });

  it('creates the missing agent row of an agent file and sets agents.transcript_file_id', () => {
    const { db, repos } = setup();
    const file = register(db, repos, 'subagent', FIXTURE_SESSION_ID);
    const sessionId = ensureSession(db, repos, FIXTURE_SESSION_ID);
    expect(repos.agents.byUid(CTX, sessionId, AGENT_UID)).toBeUndefined();
    const link = withWriteTx(db, CTX, (tx) => linkTranscriptFile(CTX, tx, repos, file));
    const agent = repos.agents.byUid(CTX, sessionId, AGENT_UID);
    expect(agent).toMatchObject({ kind: 'subagent', transcriptFileId: file.id });
    expect(link?.agentId).toBe(agent?.id);
    expect(repos.files.get(CTX, file.id)).toMatchObject({ sessionId, agentId: agent?.id });
    // the session row keeps its own transcript (an agent file is not the session's file)
    expect(repos.sessions.byUid(CTX, FIXTURE_SESSION_ID)?.transcriptFileId).toBeNull();
    withWriteTx(db, CTX, (tx) => linkTranscriptFile(CTX, tx, repos, file));
    expect(repos.agents.listBySession(CTX, sessionId)).toHaveLength(2);
  });

  it('writes nothing while the session row does not exist', () => {
    const { db, repos } = setup();
    const file = register(db, repos, 'session', FIXTURE_SESSION_ID);
    expect(withWriteTx(db, CTX, (tx) => linkTranscriptFile(CTX, tx, repos, file))).toBeNull();
    expect(repos.files.get(CTX, file.id)?.sessionId).toBeNull();
  });

  it('refuses a file whose stored session differs from the one it is linked to', () => {
    const { db, repos } = setup();
    const file = register(db, repos, 'session', FIXTURE_SESSION_ID);
    ensureSession(db, repos, OTHER_SESSION);
    expect(() =>
      withWriteTx(db, CTX, (tx) => linkTranscriptFile(CTX, tx, repos, { ...file, sessionUid: OTHER_SESSION })),
    ).toThrow(RangeError);
    expect(repos.files.get(CTX, file.id)?.sessionId).toBeNull();
    expect(repos.sessions.byUid(CTX, OTHER_SESSION)?.transcriptFileId).toBeNull();
  });
});
