# Transcript survey: real Claude Code data on this machine

Date: 2026-10-11. Purpose: verify and extend `reference/transcript-format.md` for the Node/TypeScript importer.
Method: throw-away scripts in `D:/mvp/private/scratch/mcs-v3/survey/` (Python, plus one Node file). They print only structure
(key names, counts, types, short enums). No prompt, response, tool text or file content was printed or is quoted here.

## 0. Scope and method

- Corpus: `~/.claude/projects/*` (10 project folders, one empty). A byte-size **snapshot was taken at 2026-10-11 06:41:56Z**
  (`snapshot.json`). Every later analysis read each file only up to that size, cut at the last newline. Counts below come from that
  snapshot unless stated "approx." (a few early listings were taken minutes earlier and can differ by 1 or by about 0.1%).
- Claude Code versions in the `version` field (records carrying it): 2.1.289 (100,525), 2.1.270 (36,078), 2.1.296 (3,033),
  2.1.287 (1,882), 2.1.160 (27), 2.1.283 (20). Source: `census2.py`. Only 1 of 25 session files holds two versions.
- Totals at the snapshot: 25 session files (176.6 MB, 43,297 lines), 125 top-level subagent files (210.9 MB, 37,947 lines),
  380 workflow subagent files (385.9 MB, 73,806 lines), 44 workflow `journal.jsonl` (4.0 MB, 787 lines).
- Model ids vary by machine and time. Do not hard-code them.

## 1. File layout

Under `~/.claude/projects/<project>/` (counts at survey time):

| Path pattern | Count | Notes |
|---|---|---|
| `<sessionId>.jsonl` | 25 | Session transcript. `sessionId` = file stem = the `sessionId` of every record (25 of 25). |
| `<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` | 125 + 125 | Subagents started by the `Agent` tool. `<id>` is 17 lowercase hex chars (all meta files). |
| `<sessionId>/subagents/workflows/wf_<hex8>-<hex3>/agent-<id>.jsonl` + `.meta.json` | 380 + 380 | Subagents of a Workflow run. |
| `<sessionId>/subagents/workflows/wf_<..>/journal.jsonl` | 44 | One per run; section 6. |
| `<sessionId>/workflows/wf_<..>.json` | 42 | Written only for finished runs (all 42 `status: completed`). Two runs had a directory and journal but no json (still running). |
| `<sessionId>/workflows/scripts/<name>-wf_<..>.js` | 36 | Workflow script source. Not needed by a monitor. |
| `<sessionId>/tool-results/*.txt, *.png, *.jpg` | 167 | Spilled large tool outputs and MCP screenshots (`b<base36>.txt`, `toolu_<id>.txt`, `mcp-<server>-blob-<ms>-<rand>.png`). Up to 67 MB. |
| `<sessionId>/custom-title.json` | 2 | `{customTitle: string}`. |
| `<sessionId>/auto-mode-classifier-error.txt` | 2 | Up to 408 KB error text. Ignore. |
| `memory/*.md` | 17 | Per-project auto-memory. Private. Never ingest. |

There is no index file and no `summary` file next to the transcripts.

### Project folder name and cwd

- Rule (confirmed): `<project>` = launch cwd with every non-`[A-Za-z0-9]` character replaced by `-`. Evidence: for all 24 session files that carry
  a cwd, the first record's cwd sanitized this way equals the folder name case-insensitively (`path2.py`). Case follows how the cwd was spelled at
  launch (`D--mvp` vs `d--work-frontend`), so compare case-insensitively on Windows. A `.claude` path component gives `--claude`
  (folder `D--mvp--claude-skills-monitoring-claude-sessions` exists).
- Longest folder name seen: 52 chars. Behavior for very long paths (truncation/hash) is UNVERIFIED (no sample).
- Per-record `cwd` **changes inside one session** (worktrees, `cd`). Over 29,812 session records: 18,001 equal the folder's cwd, 11,811 are a
  descendant of it, 0 are elsewhere. Map a session to a project by folder; treat `cwd` as "current directory".
- One 216-byte session file has no `cwd` (bookkeeping records only).
- Registry `~/.claude/sessions/<pid>.json` has `sessionId` (5 of 5 match a transcript) and its own `cwd`.

## 2. Record census

### 2.1 Types per file kind (snapshot)

Session file (43,297 lines): `assistant` 13,415, `attachment` 8,716, `user` 7,295, `last-prompt` 2,294, `atis-latch` 2,284, `ai-title` 1,970,
`mode` 1,816, `permission-mode` 1,672, `agent-name` 1,491, `queue-operation` 1,107, `file-history-delta` 404, `system/turn_duration` 311,
`file-history-snapshot` 254, `custom-title` 150, `system/away_summary` 43, `cost-state` 33, `system/local_command` 17,
`system/compact_boundary` 12, `bridge-session` 6, `continued-in` 4, `system/informational` 3.

Subagent files hold only `assistant`, `user`, `attachment` (`agent`: 19,376 / 11,420 / 7,151; `wf_agent`: 36,564 / 22,051 / 15,191).
No bookkeeping, `system` or title records inside subagent files. Journal (787): `launched` 44, `started` 380, `result` 362, `failed` 1.

Not present in this corpus: `summary` (old summary record), `progress`, and any `system` subtype for API errors, retries or hook results
(hooks are `attachment` records). A tolerant parser must still accept unknown `type` and `subtype`.

### 2.2 Keys per type

Counted over all records of each type (`census.json`).

- **Conversation records** (`user`, `assistant`, `attachment`, `system/*`): always `type`, `uuid`, `parentUuid` (may be `null`), `sessionId`, `timestamp`,
  `cwd`, `gitBranch`, `version`, `entrypoint`, `userType` (always `external`), `isSidechain`. Subagent files add `agentId` to all three types.
- `assistant`: always `message`, `requestId` (all but the 1 `<synthetic>` error record). `apiBlockIndex` is on all subagent records and all but 15 session records.
  Sometimes: `effort`/`perTurnEffort`, `advisorModel`, `serverClassifierRequest`, `wireToolInputs`, `wireIngestContext`, `thinkingDurationMs`, `thinkingDisplay`,
  `requestedModel`, `attributionSkill/Plugin/McpServer/McpTool`, `slug`, `sessionKind`, `session_id`; for errors `isApiErrorMessage`, `apiErrorStatus`, `error`, `isAbortedMidStream`.
  `attributionAgent` is on every subagent assistant record.
- `user`: always `message` (`{role, content}`). Sometimes: `promptId` (nearly all), `toolUseResult`, `sourceToolAssistantUUID`, `isMeta`, `isCompactSummary`,
  `isVisibleInTranscriptOnly`, `origin`, `promptSource`, `turnOrigin`, `turnPosition`, `permissionMode`, `permissionDecision`, `toolDenialKind`, `interruptedMessageId`,
  `sourceToolUseID`, `toolEndsTurn`, `queueSkipAttachments`, `imagePasteIds`, `mcpMeta`, `serverClassifierContext`, `classifierMetaLines`, `userFeedback`.
- `attachment`: always `attachment` (object with its own `type`) plus the common keys. Sometimes `rendered`, `renderedRole`, `slug`.
- **Bookkeeping records have no `uuid`, and most have no `timestamp`.**
  - No `timestamp`: `last-prompt`, `atis-latch`, `ai-title`, `mode`, `permission-mode`, `agent-name`, `custom-title`, `file-history-snapshot` (only `snapshot.timestamp`),
    `cost-state`, `bridge-session`, and journal `launched/started/result/failed`.
  - `timestamp` but no `uuid`: `queue-operation`, `file-history-delta`, `continued-in`.
  - `queue-operation`: `operation` (`enqueue` ~554, `dequeue` ~343, `remove` ~210), `sessionId`, `timestamp`; sometimes `content`, `reason` (`absorbed_mid_turn`), `commandUuid`, `deliveryId`.
  - `last-prompt`: `leafUuid` (always resolves to a uuid in the same file, 2,294 of 2,294), `lastPrompt` (private text).
  - `ai-title {aiTitle}`, `custom-title {customTitle}`, `agent-name {agentName}`, `mode {mode: "normal"}`, `permission-mode {permissionMode: auto|default}`, `atis-latch {atis: opaque string}`; all with `sessionId`.
  - `file-history-snapshot {messageId, snapshot{messageId, trackedFileBackups, timestamp}, isSnapshotUpdate}`; `file-history-delta {messageId, snapshotMessageId, trackingPath, backup(object), timestamp}`.
  - `bridge-session {bridgeSessionId, lastSequenceNum, ownerAccountUuid, ownerOrganizationUuid, sessionId}` holds account ids: never store.
  - `continued-in {continuedInSessionId, sessionId, timestamp}`.
  - `cost-state {totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration, totalDuration, totalLinesAdded, totalLinesRemoved, startTime (epoch ms),
    modelUsage{<model>{inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD}}, hasUnknownModelCost, sessionId}`.
- The bookkeeping bundle (`ai-title`, `last-prompt`, `mode`, `permission-mode`, `agent-name`, `custom-title`, `atis-latch`) is **re-appended repeatedly**, roughly every 15-25
  records (median `ai-title` gap 15-24), mostly with identical payloads (1 distinct `ai-title` in 545 copies; only `last-prompt` changes). Trigger UNVERIFIED.
  Dedupe by payload and never count these as activity (`bk.py`).

### 2.3 `system` subtypes (session files only)

| subtype | n | Extra keys | Notes |
|---|---|---|---|
| `turn_duration` | 311 | `durationMs`, `messageCount`, `isMeta`; sometimes `pendingBackgroundAgentCount` (156), `pendingWorkflowCount` (49) | Only in `entrypoint: cli` sessions (0 in `sdk-cli` and `claude-vscode`). 309 of 311 follow an assistant `end_turn` and have it as `parentUuid`. |
| `away_summary` | 43 | `content` (string) | "While you were away" recap. |
| `local_command` | 17 | `content`, `level: info`, sometimes `commandRun` | Slash-command output. |
| `compact_boundary` | 12 | `compactMetadata`, `logicalParentUuid`, `content` (22 chars), `level: info` | Section 3.6. |
| `informational` | 3 | `level` (`warning` 2, `notice` 1), `content` | |

### 2.4 Attachment kinds (`attachment.type`, session files)

`total_tokens_reminder` 4,755, `deferred_tools_record` 1,327, `environment` 856, `task_reminder` 413, `silent_turn_reminder` 299, `edited_text_file` 224, `queued_command` 129,
`prompt_snapshot` 62, `date` 51, `deferred_tools_delta` 49, `skill_listing` 45, `file` 39, `mcp_instructions_delta` 38, `model` 35, `remote_session_change` 35, `hook_success` 34,
`hook_additional_context` 34, `agent_listing_delta` 32, `session_context` 31, `language` 30, `nested_memory` 28, `instructions` 27, `command_permissions` 26, `credential_org` 21,
`compact_file_reference` 20, `ultra_effort_enter` 16, `auto_mode` 14, `invoked_skills` 12, `diagnostics` 12, `thinking_drop` 5, plus a tail (`hook_system_message`, `task_status`,
`read_truncation_notice`, `bash_output_audience_note`, `plan_mode`, `plan_mode_exit`, `opened_file_in_ide`, `ultra_effort_exit`). Workflow agents add `structured_output` (255).

Monitor-relevant:
- `hook_success {hookName, hookEvent, toolUseID, command, content, stdout, stderr, exitCode, durationMs}` (hook runs are attachments, not `system`).
- `queued_command {prompt, commandMode: prompt|task-notification, source_uuid?, origin?, delivery_id?, usage?, runId?}`.
- `task_status {taskId, taskType: local_agent, description, status: running|completed, deltaSummary, outputFilePath}` (3 samples).
- `structured_output` marks the end of a workflow agent (4.2).
- Most others are prompt-size noise (`total_tokens_reminder`, `deferred_tools_record`, `prompt_snapshot` embeds a system prompt). Skip their bodies.

### 2.5 `message` object

- `assistant.message`: `id`, `type: "message"`, `role`, `model`, `content[]`, `stop_reason`, `stop_sequence`, `stop_details` (always null), `usage`, `container` (null),
  `context_management` (null; `{applied_edits}` in 4), `diagnostics` (null; `cache_miss_reason` object in 172), sometimes `input_transformations`.
  `id` starts `msg_` (69,353 of 69,355; the 2 exceptions are `<synthetic>` with 36-char uuid-like ids). `requestId` starts `req_`.
- **Each assistant record carries exactly one content block** (all but 2 of 69,355). `apiBlockIndex` is the block index. Block types: `thinking {thinking, signature}`,
  `text {text}`, `tool_use {id, name, input, caller}`. **Thinking text is empty in 95%** (21,961 of 23,039); only the signature remains.
- `user.message.content` is a string (about 7% of session user records) or a list: `tool_result {tool_use_id, type, content (string or list), is_error?}`, `text`, `image`.
- `stop_reason`: session `tool_use` 12,750, `end_turn` 658, `stop_sequence` 2, null 5; `wf_agent` null 29,265, `tool_use` 7,178, `end_turn` 121; `agent` null 14,153, `tool_use` 5,132,
  `end_turn` 91. Null is an intermediate snapshot (section 3). Not seen: `max_tokens`, `refusal`, `pause_turn`.
- Tool names (session, top): `Bash` 4,216, `Edit` 660, `Read` 499, `Write` 408, `mcp__*` 158, `Agent` 146, `PowerShell` 101, `TaskUpdate` 98, `Workflow` 50, `ToolSearch` 50, `SendMessage` 39.
  The subagent tool is **`Agent`** (not `Task`). Subagent end tools: `SubagentHandback` (60), `StructuredOutput` (259).
- `toolUseResult` (sibling of `message` on the user record; non-null on 6,638 of 7,295 session user records): dict 6,366, list 154, string 118. Dict keys are tool specific (Bash `stdout, stderr,
  interrupted, isImage, noOutputExpected`; Edit `filePath, structuredPatch, originalFile, oldString, newString`; Agent `agentId, status, prompt, resolvedModel...`; Workflow `runId, scriptPath, status,
  summary, taskId, taskType, transcriptDir, workflowName`). It can be huge (`originalFile`): a monitor should never load it.
- `origin.kind`: `human` 220, `task-notification` 204 (126 + 78 with `producer: session-task`), `coordinator` 29, `peer` (with `from` agent id and `senderTaskId`). `promptSource`: `system` 246, `sdk` 132,
  `typed` 87, `suggestion_accepted` 4. `isMeta` user records (288) are system-injected, not human prompts.
- `entrypoint` (session records): `cli` 22,779, `sdk-cli` 3,637, `claude-vscode` 3,396. `sessionKind: "bg"` appears on 18,236 records, including `cli` sessions the registry lists as `kind: interactive`,
  so its meaning is UNVERIFIED; do not use it as "background".
- `timestamp` format: `YYYY-MM-DDTHH:MM:SS.mmmZ` on 143,080 of 143,080 records that have one; UTC.

## 3. Token accounting

### 3.1 `usage` sub-fields (all 69,355 assistant records)

Always: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (integers), `service_tier` (`standard`; null on the 2 synthetic),
`cache_creation{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `inference_geo` (`global` | `not_available`; null on synthetic).
On most final records but not on streaming snapshots: `server_tool_use{web_search_requests, web_fetch_requests}` (all 0 here), `iterations[]`, `speed` (`standard`),
`output_tokens_details{thinking_tokens}`, `fallback_credit` (always null).

- `ephemeral_5m + ephemeral_1h == cache_creation_input_tokens` on 69,351 of 69,355 (the 4 exceptions are the zeroed records of 3.3). Main-session records use the 1h bucket (13,407 of 13,415);
  nearly all subagent records use 5m (55,931 of 55,940).
- `iterations` always has one element `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation{..}, type: "message"}`; its output equals the top-level
  `output_tokens` on all final records except the 3.3 case.
- `thinking_tokens <= output_tokens` (1 exception): thinking is included in `output_tokens`, not added.

### 3.2 Repetition of `message.id`

Assistant records / distinct ids **per file** (an id seen in two files counts twice; 29,857 total, 29,049 distinct globally): session 13,415 / 6,205 (2.16), `agent` 19,376 / 8,313 (2.33), `wf_agent` 36,564 / 15,339 (2.38). Session histogram: 1 record 1,675 ids, 2 records 2,391,
3 records 1,832, 4 records 191, up to 13. The repeats are one record per content block (`apiBlockIndex` unique within an id for all but 4 of 29,857 ids), same `requestId` (0 ids with two),
chained by `parentUuid` (consecutive same-id blocks: 17,342 of 17,342 in `wf_agent`, 9,547 of 9,547 in `agent`, 6,903 of 6,903 in session).

Behavior of `usage` within one id (`acct1.py`):
- **Session files**: identical in all records of an id (6,205 of 6,205).
- **Subagent files**: `input`, `cache_read`, `cache_creation` identical; only **`output_tokens` grows**, never decreasing, last record has the max (4,323 of 4,323 differing `agent` ids,
  6,067 of 6,067 `wf_agent`; first record never). "Per-field max" and "last record wins" give the same totals.
- `stop_reason` is null on early records and set on the last.
- Ids that **never get a final record** (all records `stop_reason: null`, no `iterations`): `agent` 3,142 of 8,313 (38%), `wf_agent` 8,169 of 15,339 (53%), session 3 of 6,205. They are tool-call messages followed by
  their tool results, so the call did complete. Their `output_tokens` is a partial count (median 8, max 92; final ids median 432-540). Result: **output tokens are undercounted in subagent files**; input and cache are exact (3.4).
- Nothing is cumulative across messages: each message reports its own API call. `cache_read_input_tokens` is the whole re-read context, so it grows with the conversation.

### 3.3 Zeroed top-level usage (rare)

2 ids in one session (4 records) have `stop_reason: tool_use`, all four top-level numbers 0, and `iterations[0]` with the real numbers (cache_read 959,572 and 965,349, i.e. right before two compactions;
`cache_creation` split non-zero). Suggested importer rule: if all four top-level numbers are 0 and `iterations[0]` exists, use `iterations[0]`. Cause UNVERIFIED.

### 3.4 Totals recomputed three ways

Method A = reference doc rule (dedupe by `message.id`, per-field max, sum) in Python (`cost2.py`). Method B = independent Node script, "last record per id wins", no shared code (`indep.mjs`).
Method C = the session's own `cost-state.modelUsage` (Claude Code's counter). Main file plus all its subagent files, tokens as in / out / cache_read / cache_creation:

| Session | Files | Ids | A = B | C (cost-state) |
|---|---|---|---|---|
| beb594ec | 1 | 1 | 2 / 495 / 35,686 / 19,500 | identical on all 4 |
| 17a38bae | 1 | 8 | 16 / 2,634 / 387,224 / 51,030 | identical on all 4 |
| eaad1e50 | 1 | 35 | 70 / 53,434 / 3,938,643 / 153,450 | identical on all 4 |
| 40300028 | 48 | 1,415 | 2,842 / 781,304 / 146,052,590 / 5,340,317 | input, cache_read, cache_creation identical; output 1,667,397 (transcripts 47%) |
| 84906918 | 20 | 804 | 3,302 / 711,626 / 162,721,177 / 3,755,371 | 176,876 / 713,237 / 172,847,861 / 3,700,523 (not equal) |

(45756235, also main-only, matches `cost-state` on all 4 as well: 10 / 680 / 0 / 39,549.)

- A and B agree to the token on all five. The documented rule is correct for main-session data.
- 40300028 has 997 subagent ids without a final record; at the average final output that is about 1.8M tokens, the same order as the 886k gap. Other fields match exactly, which also proves the subagent files hold
  each subagent's usage and must be added to the session.
- `cost-state` input exceeds the transcripts by orders of magnitude in some sessions (84906918: 176,876 vs 3,302; e7a0644c: 4.58M vs about 35k). Calls not written as assistant records are the likely cause
  (UNVERIFIED), so `cost-state` is not a drop-in replacement either.
- Workflow `wf_<..>.json.totalTokens` matches none of `in+out`, `in+out+cache_creation`, or all four (4 samples: 564,099 vs 122,678 / 619,365 / 8.3M; 848,070 vs 80,006 / 837,053 / 18.5M). Definition UNVERIFIED.
  Task-notification `<usage><subagent_tokens>` also matched no sum of the agent file. Definition UNVERIFIED.

### 3.5 Duplicates across files (resume/fork)

- 3,862 `uuid` values occur in exactly two files: 3,664 in two **session** files, 198 in two subagent directories. Within a file no uuid repeats.
- A resumed or continued session writes a **new session file containing copies of the old records**, `sessionId` rewritten to the new id, uuids kept (pairs sharing 1,362 / 1,254 / 1,048 uuids; copy is
  contiguous at the start in one case, interleaved in two). The old file may end with `continued-in {continuedInSessionId}`; its target file exists for 4 of 4 (last record in 2, third from last in 2).
  Copied subagent files keep their original `sessionId` (1 file differs from its directory).
- 808 message ids appear in two files (772 session pairs, 36 agent pairs); usage identical for 806, different for 2.
- Summing per file instead of deduping globally overcounts: input +2.4%, output +3.8%, cache_read +4.0%, cache_creation +2.6% (corpus, `acct6.py`).
  **Dedupe by `message.id` across all files**, and expect copied records when counting messages or activity.

### 3.6 Compaction

- Compaction stays in the **same file** and appends. 12 samples: `system/compact_boundary` (`parentUuid: null`, `logicalParentUuid` = a pre-compaction record present in the file); the next record's `parentUuid` is the
  boundary uuid in 12 of 12; that next record is a `user` with `isCompactSummary: true` in 5 and an `attachment` in 7 (12 `isCompactSummary` user records exist, with `isVisibleInTranscriptOnly: true`).
- `compactMetadata`: `trigger` (`auto`/`manual`), `preTokens` (about 820k-979k), `postTokens` (15k-36k), `cumulativeDroppedTokens`, `durationMs` (67-136 s), `preCompactDiscoveredTools[]`,
  `preservedSegment{headUuid, anchorUuid, tailUuid}`, `preservedMessages{anchorUuid, uuids, allUuids}`; optional `preCompactArtifactReadVersions` (2), `runningTurnSends` (1).
- Usage is not cumulative across compaction. Before: cache_read about 0.96M. After: `cache_read` falls to 0-43k and `cache_creation` rises to 30k-100k. `preTokens` is close to the last pre-compaction call's
  `cache_read + cache_creation`.
- Earlier lines are not rewritten (section 5). `parentUuid: null` therefore also occurs mid-file (12 session records), so "root = null parent" is not unique to the first record.
- The summarization call itself is not an assistant record (none found). `cost-state` may count it (UNVERIFIED).

## 4. Lifecycle evidence inside the transcript

### 4.1 Linking and pending tool calls

- `tool_use.id` to `tool_result.tool_use_id`: 100% matched in the same file (session 6,638, agent 11,192, wf_agent 21,463; 0 orphan results, 0 duplicate results).
- The result user record has `sourceToolAssistantUUID` and `parentUuid` equal to the uuid of the assistant record holding the `tool_use` (100%). Every `tool_result` is its own user record (0 records with more than one),
  also for parallel calls, so one assistant parent can have several children (594 session parents).
- Pending tool calls (tool_use without result) at the snapshot: 0 in sessions and `agent`, 2 in `wf_agent` (both within 6 records of EOF). Pending is rare and transient. `stop_reason` cannot detect it (null on 38-53% of
  completed subagent messages); use the tool_use / tool_result join.

### 4.2 End patterns

Last record of a **session file** (25): `cost-state` 16, `continued-in` 2, and one each of `attachment`, `permission-mode`, `system/away_summary`, `custom-title`, `agent-name`, `assistant`, `atis-latch`.
The last record is almost never the last conversational record. Last conversational record (ignoring bookkeeping): assistant `end_turn` text 8, `turn_duration` 4, `away_summary` 4, user string 3,
attachment 3, `local_command` 1, user text 1 (`life1.py`).

- **Trailing `cost-state`** coincides with process exit: all 16 such sessions are absent from `~/.claude/sessions/`; none of the 5 live processes has one as its last record. Sessions that were killed or
  are alive have none (a 12-hour-old session ends in an attachment; a 668-hour-old one in `permission-mode`). Inference, not proof: a trailing `cost-state` means a clean shutdown, its absence proves nothing alone.
- **Turn end**: assistant `end_turn`, then `system/turn_duration` (`cli` only). `pendingBackgroundAgentCount > 0` (156 records) or `pendingWorkflowCount > 0` (49) means the turn ended with background work outstanding.
  This confirms the reference doc's "a turn can end while background work still runs" with a machine-readable field.
- **Top-level subagent file end** (125): `assistant end_turn` 65; user `tool_result` of `SubagentHandback` with `toolEndsTurn: true` 58; user text (interrupt marker) 2.
- **Workflow agent file end** (380): user `tool_result` of `StructuredOutput` with `toolEndsTurn: true` 255; `assistant end_turn` 107; user text 8; user `tool_result` without `toolEndsTurn` 1; assistant with
  `stop_reason: null` 5; attachment 4. The other 18 were running, interrupted or killed at survey time (not individually classified).
- Background `Agent` results: `toolUseResult.status` is `async_launched` 142 (immediate) or `completed` 4 (synchronous). Real completion arrives later as a **user record with `origin.kind = "task-notification"`**
  whose content is an XML-like block with tags `task-id`, `tool-use-id`, `output-file`, `status`, `summary`, `result`, `usage`: status `completed` 176, `failed` 6, `killed` 3, `stopped` 1 (18 are `event` notifications
  with no status). This is the best in-transcript evidence of subagent success or failure. Parse tags only; never keep `result`.

### 4.3 Interrupts, errors, denials

- User interrupt: a user record whose text starts with `[Request interrupted by user` (plain 20, "for tool use" 1). In session files 4 of 6 carry `interruptedMessageId`. No assistant `stop_reason` marks it.
  Bash `toolUseResult.interrupted` was never true.
- Mid-stream abort: assistant `isAbortedMidStream: true`, `stop_reason: null` (1).
- API error: assistant with `isApiErrorMessage: true`, `apiErrorStatus: 529`, `error: "server_error"`, `model: "<synthetic>"`, `stop_reason: "stop_sequence"`, all-zero usage, non-`msg_` id (1 sample; other error
  shapes UNVERIFIED). Another `<synthetic>` record has `isApiErrorMessage: false`.
- Tool errors: `tool_result.is_error: true` 118 in sessions (false 4,259, absent 2,256). Denials: `toolDenialKind` (`automode-blocked`, `automode-unavailable`, `permission-rule`, `user-rejected`) and
  `permissionDecision {decision: accept|reject, source: config|user_temporary|...}` on the result user record.
- Session-level "waiting" is not in the transcript. The registry has it: `status` `busy`, `idle`, `waiting` with `waitingFor: "permission prompt"` (observed live, 1 of 5). The reference doc lists only busy/idle.

### 4.4 What can and cannot be inferred

Can: turn running (last conversational record is a user/tool_result or an assistant `tool_use` with a recent timestamp); turn finished (`end_turn`, `turn_duration`); background work outstanding
(`pending*Count`, subagent files still growing, a workflow with no `.json` and fewer `result` than `started` journal lines); subagent outcome (`task-notification` status); clean exit (trailing `cost-state`, registry entry gone).
Cannot: crash vs kill vs waiting-for-permission without the registry; the exit code of `claude -p`; whether a session ending in `end_turn` is finished or waiting for the user; a subagent's failure without a notification or error record.

## 5. Growth, rotation, encoding

- **Append-only** (live test `grow.py`: 20 s between two reads of 18 files modified within 15 minutes): 4 grew (up to +147,599 B). For all 18: same inode, never shrank, SHA-1 of the first `size0` bytes unchanged.
  No truncation, atomic replace or rewrite seen. Compaction does not rewrite earlier lines (all 12 boundaries are appended records). The "stop_reason null, then set" pattern is a later appended record (one block per record), not an edit.
- All 18 live files ended with a newline at read time. A concurrent reader can still see a partial last line while a write is in flight; UNVERIFIED whether it happens. Cut at the last newline and keep the offset.
- Integrity: invalid JSON lines 0, non-object lines 0, BOM 0, CRLF 0, non-UTF-8 files 0, files without trailing newline 0, blank lines only the final split artifact.
- Sizes: session min 216 B, median 0.91 MB, p90 23.8 MB, max 70.0 MB; `agent` median 1.1 MB, max 11.6 MB; `wf_agent` median 0.69 MB, max 15.6 MB; `journal` max 383 KB.
- Line length: session median 1,052 B, p99 31 KB, **max 1,315,795 B**, 8 lines over 1 MB, 89 over 256 KB; `agent` max 813,500 B; `wf_agent` max 680,615 B. Do not assume small line buffers.
- **Order is not strictly by timestamp**: 4,456 records (session 3,468, wf 573, agent 415) have a timestamp earlier than an earlier-written record (median 0.3 s, p95 79,000 s, max 494,000 s). Large jumps come from resumed
  copies (one file holds most) and late attachments. Use file order for sequence and `max(timestamp)` for "last activity".

## 6. Subagent and workflow facts

### 6.1 `Agent` tool to subagent file

- `agent-<id>.meta.json` keys (125-126 files): `agentType` (`general-purpose` 122, `Explore` 4), `description` (short label), `requestNonInteractive` (always true), `requestShape` (`background` 121, `foreground` 5),
  `spawnDepth` (always 1), `toolUseId`, optional `model` (alias `sonnet`/`opus`/`haiku`). **There is no `label` key.**
- Join chain (125 of 125): `meta.toolUseId` = `tool_use.id` of an `Agent` call in the parent session file; its result's `toolUseResult.agentId` = the file's `<id>`; every record inside has `agentId` = `<id>`.
  The subagent `sessionId` equals the parent's (124 of 125; the exception is a copy under a resumed session).
- `Agent` tool_use input keys: `description`, `prompt`, optional `subagent_type`, `model`, `run_in_background`. Async `toolUseResult`: `agentId, status, description, isAsync, outputFile, canReadOutputFile, prompt, resolvedModel`;
  synchronous also `content, handback, handbackReport, usage, totalTokens, totalDurationMs, totalToolUseCount, toolStats`.
- First record of every subagent file: `user`, `parentUuid: null`, string content (the prompt, private). Every record is `isSidechain: true`; session records are all `false`.

### 6.2 Workflow runs

- `Workflow` tool_use input: `script` or `scriptPath` (+ optional `args`, `description`). Its `toolUseResult` (49 of 49): `runId` (`wf_<hex8>-<hex3>`, equals the json stem 42 of 42), `taskId`, `taskType`, `workflowName`,
  `status: async_launched`, `summary`, `scriptPath`, `transcriptDir`. This is the join from the parent session to `workflows/<runId>.json` and `subagents/workflows/<runId>/`.
- `workflows/<runId>.json` (finished only): `runId, timestamp, taskId, script, scriptPath, args?, result, agentCount, logs, durationMs, summary, workflowName, status, startTime (epoch ms), phases[{title, detail}], defaultModel,
  workflowProgress[{type, index, title}], totalTokens, totalToolCalls`. `script` and `result` can be large and private; read scalars only. `agentCount` equals the agent file count for 40 of 42.
- Workflow agent `meta.json`: `agentType` (`workflow-subagent`), `description`, `requestNonInteractive`, `requestShape`, `spawnDepth`, `workflowPhase`, optional `model`. No `toolUseId`.
- `journal.jsonl`: first line `{type: "launched"}` (no timestamp, no ids), then `started {agentId, key, label, phase}` per agent and `result {agentId, key, result}` (259 dict, 107 string) or `failed {agentId, key}` (1).
  `started` ids equal the agent files in the directory for 44 of 44 runs. **The journal has no timestamps**; use file mtimes. A run is finished when `workflows/<runId>.json` exists. Running at survey time: 2 runs (results 4 of 10, 1 of 4, no json).
- Workflow agents: `attributionAgent: workflow-subagent`, final `StructuredOutput` result with `toolEndsTurn`, `entrypoint` inherited from the parent (`cli` or `sdk-cli`).

### 6.3 Registry and state outside transcripts

- `~/.claude/sessions/<pid>.json` (5 files): `pid, sessionId, cwd, startedAt (ms), procStart, version, peerProtocol, peerFeatures, kind (interactive|bg), entrypoint, pidDomain, messagingSocketPath, name, nameSource, nameSince,
  status, statusUpdatedAt, updatedAt`, plus `parkedJobId` or `jobId` on some and `waitingFor` when waiting. All 5 pids alive, all 5 sessions have transcripts. One is `entrypoint: sdk-cli` listed as `kind: interactive`, so
  "unattended `claude -p` runs are not listed" cannot be confirmed from this data (UNVERIFIED which sdk-cli sessions are `-p`). Never open the sibling `.key` files.
- `~/.claude/jobs/<id>/state.json` (4 daemon jobs): `state` (`working` 1, `done` 3), `backend: daemon`, `tempo`, `sessionId`, `resumeSessionId`, `cwd`, `createdAt`, `updatedAt`, `lastTerminalAt`, `tokens?`.
  A lifecycle source for daemon jobs. The folder also holds 6,000+ temp files from job work: do not walk it.

## 7. Confirmed, contradicted, extended

### 7.1 Confirms `reference/transcript-format.md`

- Project folder = non-alphanumerics replaced by `-`, lowercase in some cases; cwd match as fallback (section 1).
- `<sessionId>/subagents/**/agent-<id>.jsonl` + `agent-<id>.meta.json`; `workflows/<wf>.json` has `workflowName`, `status`, `agentCount`, `durationMs`.
- Conversation records have an ISO UTC `timestamp`.
- Usage field names; the same `message.id` repeats (2.0-2.4 records per id here, doc: 225 for 112); per-field max over deduped ids is right and was re-verified independently (3.4).
- Cache reads dwarf the rest (7.5B cache_read vs 24.6M output corpus-wide, before dedupe).
- Subagent usage lives in subagent files and must be added to the session (40300028 matches on three of four fields only with them).
- A trailing `end_turn` cannot prove finished vs waiting; background work can outlive the turn (now with a field).
- Transcripts reach tens of MB (70.0 MB max).

### 7.2 Contradicts or needs correction

1. "Every record has an ISO `timestamp`": false for 14 bookkeeping and journal types (2.2).
2. "There is no money cost in transcripts": false for this version. `cost-state.totalCostUSD` and per-model `costUSD` exist (33 records in 20 sessions). It is a per-process cumulative snapshot written at some lifecycle
   points, and it can include calls absent from the transcripts.
3. `meta.json` "with label and model": there is no `label`. Keys are `description`, `agentType`, `requestShape`, `spawnDepth`, `toolUseId` (or `workflowPhase`), and `model` only sometimes.
4. Registry `status` is `busy`/`idle` only: also `waiting` with `waitingFor`.
5. "Take the max of each field per message.id" is right but incomplete: 2 ids need `iterations[0]`; 38-53% of subagent ids lack a final record so subagent `output_tokens` is a lower bound; ids repeat across resumed session files.
6. "`stop_reason: tool_use` (or a tool_use without a later tool_result) means a pending call": the first half is unreliable (`stop_reason` is null for most subagent messages). Use the tool_use/tool_result join only.
7. "Unattended `claude -p` runs are not listed in the registry": NOT REFUTED either. An `sdk-cli` session is listed, but it is unknown whether it is a `-p` run (UNVERIFIED).

### 7.3 Extends

- Full record-type list (2.1), `system` subtypes, attachment kinds, `cost-state`, `queue-operation`, `last-prompt`, `file-history-*`, `bridge-session`, `continued-in`.
- One content block per assistant record; blank thinking text; full `usage` schema (`cache_creation` split, `iterations`, `output_tokens_details`).
- Resume = new file with copied records and rewritten `sessionId`; compaction = in-file boundary; neither rewrites history.
- Lifecycle markers: `turn_duration.pending*Count`, trailing `cost-state`, `toolEndsTurn` on `SubagentHandback`/`StructuredOutput`, `task-notification` statuses, the interrupt marker, `isApiErrorMessage`.
- Lines up to 1.3 MB; timestamps are not monotonic in file order; the journal has no timestamps.

## 8. Fixture records for importer tests

Shapes only: keep keys and value types, replace every string with a placeholder, one object per line.

1. **Streaming snapshots of one id (subagent)**: 3 assistant records, same `message.id` and `requestId`, blocks `thinking`, `text`, `tool_use`; `stop_reason` null, null, `tool_use`; `output_tokens` 8, 8, 412; other usage identical; last has `iterations`.
2. **Main-file id** with identical usage in 2 records, plus the same id in a second file (global dedupe).
3. **Unfinalized id**: 2 records, `stop_reason` null in both, `output_tokens: 8`, followed by a `tool_result`. Counted once, output flagged as lower bound.
4. **Zeroed top-level usage** with `iterations[0]` populated and a non-zero `cache_creation` split.
5. **`<synthetic>` API error**: `isApiErrorMessage: true`, `apiErrorStatus: 529`, `error: "server_error"`, `model: "<synthetic>"`, non-`msg_` id, `service_tier: null`, `output_tokens_details: null`.
6. **Aborted mid-stream**: `isAbortedMidStream: true`, `stop_reason: null`.
7. **Tool pair**: assistant `tool_use` (`id`, `name`, `input`, `caller`) then user `tool_result` (`tool_use_id`, `is_error: false`, string content) with `sourceToolAssistantUUID`, `parentUuid`, object `toolUseResult`; variants with list content, `is_error` absent, `toolUseResult: null`, and string `toolUseResult`.
8. **Parallel tool calls**: one `message.id`, two assistant records with one `tool_use` each, then two separate user records with one `tool_result` each.
9. **Pending `tool_use`** at EOF, and one mid-file whose result is missing.
10. **Interrupt**: user text block `[Request interrupted by user]` with `interruptedMessageId`; the "for tool use" variant.
11. **Denial**: `tool_result` with `is_error: true`, `toolDenialKind: user-rejected`, `permissionDecision {decision: reject, source}`.
12. **Turn end**: assistant `end_turn` text, then `system/turn_duration` with `durationMs`, `messageCount`, `isMeta`, `pendingBackgroundAgentCount: 2`, `pendingWorkflowCount: 1`; and one without the pending keys.
13. **Compaction**: `compact_boundary` (`parentUuid: null`, `logicalParentUuid`, full `compactMetadata` incl. `preservedSegment`, `preservedMessages`, optional `runningTurnSends`), a `user` `isCompactSummary: true` + `isVisibleInTranscriptOnly: true`, and an attachment variant; next assistant has `cache_read_input_tokens: 0`.
14. **Bookkeeping set**: `last-prompt {leafUuid}`, `ai-title`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `atis-latch`, `queue-operation` (enqueue/dequeue/remove, with and without `content`), `file-history-snapshot`, `file-history-delta`, `bridge-session`. None may count as activity; most have no `timestamp` or `uuid`.
15. **`cost-state`** as last record with `modelUsage` for two models (one key with a `[1m]` suffix) and an empty `modelUsage`; `continued-in` as last record.
16. **Attachments**: `hook_success`, `queued_command` (both `commandMode` values), `task_status`, `structured_output`, a large `total_tokens_reminder` (body must not be stored), `date`, `environment`.
17. **Agent launch**: assistant `tool_use` `name: "Agent"` with `run_in_background: true`; result `toolUseResult {agentId, status: "async_launched", isAsync: true, outputFile}`; later user record `origin {kind: "task-notification"}` whose content has `<task-id>`, `<tool-use-id>`, `<status>` (`completed`, `failed`, `killed`, `stopped`), `<usage>`; and an `event`-only notification without status.
18. **Subagent file**: first record user with string content, `parentUuid: null`, `isSidechain: true`, `agentId`; last record user `tool_result` of `SubagentHandback` with `toolEndsTurn: true`; matching `.meta.json` with and without `model`.
19. **Workflow dir**: `journal.jsonl` with `launched`, N `started`, M `result` (dict and string), one `failed`; once with no `workflows/<runId>.json` (running) and once with it (completed); parent `Workflow` result with `runId`, `transcriptDir`.
20. **Workflow agent end**: `StructuredOutput` tool_use then user `tool_result` with `toolEndsTurn: true`.
21. **Resume copy**: two session files sharing uuids and message ids with different `sessionId`; the older ends with `continued-in {continuedInSessionId}`.
22. **Order**: a record with a timestamp earlier than its predecessor; a `parentUuid: null` mid-file.
23. **Defensive encoding cases** (not seen in the corpus, so synthetic): no trailing newline (partial last line), a 1.3 MB single line, one invalid JSON line, CRLF, BOM.
24. **Registry**: `<pid>.json` with `status: waiting` + `waitingFor`, one `busy`, one `idle`, one `kind: bg`; a dead pid; a `.key` file that must never be opened.
25. **Project mapping**: cwd with `.` and spaces, drive-letter case difference, and a session whose cwd moves into a subfolder.

## 9. UNVERIFIED and open items

- Folder naming for very long project paths (truncation or hashing).
- Whether a concurrent reader ever sees a partial trailing line.
- Writer cause of zeroed top-level usage and of the 38-53% of subagent ids with no final record; whether later versions fix it.
- Meaning of `sessionKind: bg` on `cli` sessions; whether any registry entry exists for an unattended `claude -p` run.
- Other API error shapes (one `529` sample), `max_tokens` handling, refusals.
- Definitions of workflow `totalTokens` and notification `subagent_tokens`.
- Exact trigger of the re-appended bookkeeping bundle; whether `cost-state` is written only at exit or also periodically.

## 10. Reproduce

`D:/mvp/private/scratch/mcs-v3/survey/`: `common.py` (snapshot reader; run `python common.py` for a new snapshot), `census2.py` (types/keys), `deep1b.py` + `show.py` (nested enums), `acct1.py`-`acct6.py` (dedupe, partial usage,
cross-file), `cost2.py` + `indep.mjs` (three-way totals), `compact.py`, `life1.py`-`life3.py`, `link.py`, `link2.py`, `meta.py`, `wf*.py`, `grow.py`, `stats.py`, `turn.py`, `reg.py`, `bk.py`.

## 11. Verification log (2026-10-11)

Independent re-measurement over the same snapshot (`snapshot.json`) with fresh scripts `D:/mvp/private/scratch/mcs-v3/verify/{v,w,x}.py`, plus live registry and `meta.json` globbing.

| Claim | Verdict | Evidence |
|---|---|---|
| One content block per assistant record (69,355; 2 exceptions) | confirmed | recount: 69,355 assistant records, 2 with content length != 1 |
| 2.16 / 2.3-2.4 records per id; 29,857 ids | corrected | per-file ids match (6,205 + 8,313 + 15,339); globally distinct ids are 29,049 (header of 3.2 amended) |
| Session usage identical within an id; subagent only output grows, monotonic, last = max | confirmed | session 6,205 ids, 0 differ; agent 8,313 and wf_agent 15,339: other fields identical, output monotonic, last is max (all) |
| 38% / 53% of subagent ids never finalized | confirmed | recount per file: agent 3,141 of 8,277 (37.9%, global key) vs 3,142 of 8,313 (per-file key); wf_agent 8,169 of 15,339 (53.3%); session 3 |
| Zeroed top-level usage with iterations[0] (2 ids) | confirmed | 4 records, 2 ids, iterations[0].cache_read 959,572 and 965,349, stop_reason tool_use |
| Totals A=B on 5 sessions; 40300028 output 781,304 vs 1,667,397 cost-state; 84906918 not equal | confirmed | last-record-wins recomputed: 40300028 [2842, 781304, 146052590, 5340317], 84906918 [3302, 711626, 162721177, 3755371]; cost-state sums 2,842 / 1,667,397 / 146,052,590 / 5,340,317 and 176,876 / 713,237 / 172,847,861 / 3,700,523; the three small sessions' numbers also match the table |
| Trailing cost-state in 16 of 25 sessions, all absent from registry | confirmed | 16 of 25 last records; 0 of the 16 session ids among the 5 registry files (registry read now) |
| Resume duplicates: 3,862 uuids in exactly 2 files, 808 message ids in 2 files | confirmed | recount gives 3,862 (none in 3+ files) and 808 |
| Thinking blank 95% (21,961 of 23,039) | confirmed | recount identical |
| Max line 1,315,795 B, max file 70.0 MB | confirmed | recount 1,315,795 and 70.02 MB |
| 12 compact_boundary records; bookkeeping types have no timestamp | confirmed | 12 compact_boundary; no-timestamp counts for last-prompt, atis-latch, ai-title, mode, permission-mode, agent-name, custom-title, cost-state, bridge-session match section 2.2 |
| meta.json has no label key; workflows json all completed | confirmed | glob of all meta files now (512, grown since snapshot): keys agentType, description, spawnDepth, requestShape, requestNonInteractive, workflowPhase, model, toolUseId; no label. 42 workflow jsons, all completed |
| Reference doc claims (timestamp on every record, no money cost, busy/idle only, `-p` not listed) | confirmed as quoted | `reference/transcript-format.md` lines 7, 13, 19, 25 |
| Registry `waiting` with `waitingFor: "permission prompt"` | unverifiable now | the 5 live registry files now show only idle/busy and no waitingFor; the earlier observation cannot be reproduced |
| Append-only live growth test (20 s, 4 of 18 grew) | unverifiable | point-in-time test, not repeated |
| `-p` runs not listed (item 7.2.7) | corrected | softened to "not refuted, unknown whether the sdk-cli entry is a -p run" |

Privacy check: grep for emails, tokens, user paths found no emails, secrets or user paths (the only grep hits were the `<usage>` and `task-notification` tag names). The file contains shapes and counts only.
