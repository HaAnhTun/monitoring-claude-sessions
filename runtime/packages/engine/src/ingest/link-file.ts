// The link of a transcript file to its session, agent and workflow run rows (02 5.3, 5.6; 03 3.6). Token usage needs it: a
// usage record of a file is accounted to the session and the agent the file is linked to. The ingest writer links a file
// inside the transaction that applies its usage (so the usage of a batch that creates the session lands in that batch), and the
// importer links a file as soon as its rows exist. Both go through `linkTranscriptFile`, which is idempotent.
import type { RepoContext } from '../db/open.ts';
import type { AgentsRepo } from '../db/repos/agents.ts';
import type { SessionsRepo } from '../db/repos/sessions.ts';
import type { TranscriptFileKind, TranscriptFilesRepo } from '../db/repos/transcript-files.ts';
import type { WorkflowRunsRepo } from '../db/repos/workflow-runs.ts';
import type { WriteTx } from '../db/write.ts';

/** What the link needs to know about a file: its row id and the identities its path names. */
export interface LinkableFile {
  readonly id: number;
  readonly kind: TranscriptFileKind;
  readonly sessionUid: string;
  readonly agentUid: string | null;
  readonly runUid: string | null;
}

export interface LinkRepos {
  readonly sessions: SessionsRepo;
  readonly agents: AgentsRepo;
  readonly runs: WorkflowRunsRepo;
  readonly files: TranscriptFilesRepo;
}

export interface FileLink {
  readonly sessionId: number;
  /** The agent row of an agent file; null for a session file (its usage goes to the main agent). */
  readonly agentId: number | null;
  /** null while the run row of a workflow agent file does not exist yet. */
  readonly runId: number | null;
  /** True when every row the file names exists and is linked: nothing is left to do for this file. */
  readonly complete: boolean;
}

/**
 * Links the file to the rows of its session (and agent, and workflow run): registers the relink on the file row and sets
 * `sessions.transcript_file_id` or `agents.transcript_file_id`. A missing agent row of an agent file is created. Returns null
 * when the session row does not exist yet (nothing is written). Throws a `RangeError` when the stored file row belongs to
 * another session than `file` says, or when the file row does not exist.
 */
export function linkTranscriptFile(
  scope: RepoContext,
  tx: WriteTx,
  repos: LinkRepos,
  file: LinkableFile,
): FileLink | null {
  const row = repos.files.get(scope, file.id);
  if (row === undefined) throw new RangeError('a transcript file that has no row');
  if (row.sessionUid !== file.sessionUid) throw new RangeError('a transcript file of another session');
  const sessionId = repos.sessions.idByUid(scope, file.sessionUid);
  if (sessionId === undefined) return null;
  if (row.sessionId !== null && row.sessionId !== sessionId)
    throw new RangeError('a transcript file of another session');

  const runId = file.runUid === null ? null : (repos.runs.byUid(scope, sessionId, file.runUid)?.id ?? null);
  let agentId: number | null = null;
  if (file.agentUid !== null) {
    const known = repos.agents.byUid(scope, sessionId, file.agentUid);
    if (known !== undefined) agentId = known.id;
    else {
      const main = repos.agents.byUid(scope, sessionId, 'main');
      agentId = repos.agents.upsert(
        scope,
        tx,
        {
          sessionId,
          agentUid: file.agentUid,
          parentAgentId: main?.id ?? null,
          kind: file.kind === 'workflow_agent' ? 'workflow_agent' : 'subagent',
          depth: 1,
          startedAt: tx.now,
          ...(runId === null ? {} : { workflowRunId: runId }),
        },
        null,
      ).id;
    }
  }

  if (
    row.sessionId === null ||
    (agentId !== null && row.agentId === null) ||
    (runId !== null && row.workflowRunId === null)
  ) {
    repos.files.register(scope, tx, {
      path: row.path,
      pathKey: row.pathKey,
      kind: row.kind,
      sessionUid: row.sessionUid,
      agentUid: row.agentUid,
      runUid: row.runUid,
      sessionId,
      agentId,
      workflowRunId: runId,
      birthMs: row.birthMs,
      firstSeenMtimeMs: row.firstSeenMtimeMs,
      mtimeSeen: row.mtimeSeen,
    });
  }
  if (file.kind === 'session') {
    const session = repos.sessions.byUid(scope, file.sessionUid);
    if (session?.transcriptFileId !== file.id) {
      repos.sessions.update(scope, tx, sessionId, { transcriptFileId: file.id }, null);
    }
  }
  if (agentId !== null) {
    const agent = repos.agents.byUid(scope, sessionId, file.agentUid ?? '');
    if (agent?.transcriptFileId !== file.id)
      repos.agents.update(scope, tx, agentId, { transcriptFileId: file.id }, null);
  }
  return { sessionId, agentId, runId, complete: file.runUid === null || runId !== null };
}
