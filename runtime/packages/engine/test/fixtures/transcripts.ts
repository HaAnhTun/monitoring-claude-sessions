// Transcript fixtures for the ingestion tests (02 9.1, 5.10). The record shapes come from the testkit's
// `TranscriptBuilder` (survey shapes, placeholder strings); this file adds the composite sessions the normalizer and
// tailer tests need and the sentinel strings of the privacy test T-TR-16.
import { FIXTURE_EPOCH_MS, TranscriptBuilder } from '@mcs/testkit';

import type { TrackedFile } from '../../src/ingest/transcripts/normalize-record.ts';

export const FIXTURE_SESSION = '55555555-5555-4555-8555-555555555555';
export const FIXTURE_AGENT = 'a9f8e7d6c5b4a3921';
export const FIXTURE_RUN = 'wf_fixture_run_1';

/** One string per field that must never reach a row or a logical event (02 5.7). */
export const SENTINEL = {
  prompt: 'SENTINEL-PROMPT-TEXT-0001',
  assistant: 'SENTINEL-ASSISTANT-TEXT-0002',
  thinking: 'SENTINEL-THINKING-TEXT-0003',
  signature: 'SENTINEL-THINKING-SIGNATURE-0004',
  toolInput: 'SENTINEL-TOOL-INPUT-BODY-0005',
  toolResult: 'SENTINEL-TOOL-RESULT-BODY-0006',
  toolUseResult: 'SENTINEL-TOOL-USE-RESULT-0007',
  attachment: 'SENTINEL-ATTACHMENT-BODY-0008',
  queued: 'SENTINEL-QUEUED-COMMAND-0009',
  account: 'SENTINEL-ACCOUNT-ID-0010',
  organization: 'SENTINEL-ORGANIZATION-ID-0011',
  lastPrompt: 'SENTINEL-LAST-PROMPT-0012',
  queueContent: 'SENTINEL-QUEUE-CONTENT-0013',
  awaySummary: 'SENTINEL-AWAY-SUMMARY-0014',
  localCommand: 'SENTINEL-LOCAL-COMMAND-0015',
  compactSummary: 'SENTINEL-COMPACT-SUMMARY-0016',
  notificationResult: 'SENTINEL-NOTIFICATION-RESULT-0017',
  notificationSummary: 'SENTINEL-NOTIFICATION-SUMMARY-0018',
  promptSnapshot: 'SENTINEL-PROMPT-SNAPSHOT-0019',
  fileHistory: 'SENTINEL-FILE-HISTORY-0020',
  workflowScript: 'SENTINEL-WORKFLOW-SCRIPT-0021',
  journalResult: 'SENTINEL-JOURNAL-RESULT-0022',
} as const;

/** The file a record is read from, for a main session transcript. */
export function sessionFile(over: Partial<TrackedFile> = {}): TrackedFile {
  return { fileId: 7, kind: 'session', sessionId: FIXTURE_SESSION, agentId: null, runId: null, ...over };
}

/** A subagent transcript file of `FIXTURE_AGENT`. */
export function subagentFile(over: Partial<TrackedFile> = {}): TrackedFile {
  return sessionFile({ fileId: 8, kind: 'subagent', agentId: FIXTURE_AGENT, ...over });
}

export function builder(over: { agentId?: string; startMs?: number } = {}): TranscriptBuilder {
  return new TranscriptBuilder({
    sessionId: FIXTURE_SESSION,
    cwd: 'FIXTURE/project',
    startMs: over.startMs ?? FIXTURE_EPOCH_MS,
    ...(over.agentId === undefined ? {} : { agentId: over.agentId }),
  });
}

/** A short ordinary session: prompt, a tool pair, a failing tool, a final answer and the turn end. */
export function ordinarySession(): TranscriptBuilder {
  const b = builder();
  b.user();
  const ok = b.toolUse('Bash', { command: 'echo FIXTURE' });
  b.toolResult(ok);
  const failing = b.toolUse('Bash', { command: 'false' });
  b.toolResult(failing, { isError: true, content: 'FIXTURE failure' });
  b.turnEnd();
  return b;
}

/** Fixture 17: a background agent launch and the notifications that announce its end. */
export function notificationSession(): TranscriptBuilder {
  const b = builder();
  b.user();
  const launch = b.agentLaunch({ agentId: FIXTURE_AGENT, background: true });
  b.taskNotification({ taskId: 'task_fixture_a', toolUseId: launch, status: 'completed' });
  b.taskNotification({ taskId: 'task_fixture_b', toolUseId: launch, status: 'failed' });
  b.taskNotification({ taskId: 'task_fixture_c', toolUseId: launch, status: 'killed' });
  b.taskNotification({ taskId: 'task_fixture_d', toolUseId: launch, status: 'stopped' });
  b.taskNotification({ taskId: 'task_fixture_e', toolUseId: launch });
  return b;
}

/**
 * Every field that must never be persisted carries a sentinel (T-TR-16). Fields that are allowed to reach a row (ids,
 * tool names, the summary of a tool input) carry placeholders without a sentinel.
 */
export function sentinelSession(): TranscriptBuilder {
  const b = builder();
  b.user(SENTINEL.prompt);
  b.raw({
    type: 'assistant',
    uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
    parentUuid: null,
    timestamp: new Date(FIXTURE_EPOCH_MS + 1000).toISOString(),
    sessionId: FIXTURE_SESSION,
    message: {
      id: 'msg_fixture_think',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'thinking', thinking: SENTINEL.thinking, signature: SENTINEL.signature }],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  b.assistant({ messageId: 'msg_fixture_say', text: SENTINEL.assistant, stop: 'tool_use' });
  const write = b.toolUse('Write', { file_path: 'FIXTURE/out.txt', content: SENTINEL.toolInput });
  b.toolResult(write, {
    content: SENTINEL.toolResult,
    toolUseResult: { stdout: SENTINEL.toolUseResult, filePath: 'FIXTURE/out.txt', content: SENTINEL.toolUseResult },
  });
  b.attachment('hook_success', { stdout: SENTINEL.attachment, content: SENTINEL.attachment });
  b.attachment('queued_command', { prompt: SENTINEL.queued });
  b.attachment('task_status', { deltaSummary: SENTINEL.attachment });
  b.attachment('total_tokens_reminder', { content: SENTINEL.attachment });
  b.raw({
    type: 'bridge-session',
    sessionId: FIXTURE_SESSION,
    bridgeSessionId: SENTINEL.account,
    credential_org: { organizationUuid: SENTINEL.organization },
  });
  b.raw({ type: 'last-prompt', sessionId: FIXTURE_SESSION, lastPrompt: SENTINEL.lastPrompt });
  b.raw({ type: 'queue-operation', operation: 'enqueue', sessionId: FIXTURE_SESSION, content: SENTINEL.queueContent });
  b.raw({
    type: 'file-history-snapshot',
    messageId: 'msg_fixture_say',
    snapshot: { trackedFileBackups: { 'FIXTURE/a.txt': SENTINEL.fileHistory } },
  });
  b.raw({
    type: 'system',
    subtype: 'away_summary',
    uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
    timestamp: new Date(FIXTURE_EPOCH_MS + 2000).toISOString(),
    content: SENTINEL.awaySummary,
  });
  b.raw({
    type: 'system',
    subtype: 'local_command',
    uuid: 'aaaaaaaa-0000-4000-8000-000000000003',
    timestamp: new Date(FIXTURE_EPOCH_MS + 3000).toISOString(),
    content: SENTINEL.localCommand,
  });
  b.raw({
    type: 'user',
    uuid: 'aaaaaaaa-0000-4000-8000-000000000004',
    timestamp: new Date(FIXTURE_EPOCH_MS + 4000).toISOString(),
    isCompactSummary: true,
    message: { role: 'user', content: SENTINEL.compactSummary },
  });
  b.raw({
    type: 'user',
    uuid: 'aaaaaaaa-0000-4000-8000-000000000005',
    timestamp: new Date(FIXTURE_EPOCH_MS + 5000).toISOString(),
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: [
        '<task-notification>',
        '<task-id>task_fixture_s</task-id>',
        '<tool-use-id>toolu_fixture_s</tool-use-id>',
        '<status>completed</status>',
        `<result>${SENTINEL.notificationResult}</result>`,
        `<summary>${SENTINEL.notificationSummary}</summary>`,
        '</task-notification>',
      ].join('\n'),
    },
  });
  b.raw({ type: 'prompt_snapshot', sessionId: FIXTURE_SESSION, snapshot: SENTINEL.promptSnapshot });
  return b;
}

/** A journal record of a workflow run (02 5.1.2). */
export function journalRecord(
  type: string,
  fields: Record<string, unknown>,
  timestamp: number = FIXTURE_EPOCH_MS,
): Record<string, unknown> {
  return { type, timestamp: new Date(timestamp).toISOString(), ...fields };
}

/** Parsed records of a builder, in order (invalid lines are skipped). */
export function parsedRecords(b: TranscriptBuilder): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of b.lines()) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        out.push(Object.fromEntries(Object.entries(value)));
      }
    } catch {
      // an invalid fixture line is not a record
    }
  }
  return out;
}
