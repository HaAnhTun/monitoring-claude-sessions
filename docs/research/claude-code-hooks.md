# Claude Code hooks: verified specification for the monitor (v3)

Status: research input for the Node/TypeScript migration. Reviewed 2026-10-11 on Windows 11, Claude Code 2.1.289
(`claude --version`), Node 24.14.1, Git Bash present.

## 0. Sources and method

| Id | Source | How it was used |
|---|---|---|
| D1 | https://code.claude.com/docs/en/hooks.md (hooks reference, 4159 lines), fetched 2026-10-11 with curl | Primary spec. Cited below as `D1:<line>` |
| D2 | https://code.claude.com/docs/en/hooks-guide.md, fetched 2026-10-11 | Guide, limitations, troubleshooting. `D2:<line>` |
| D3 | https://code.claude.com/docs/en/settings.md and settings-reference.md, fetched 2026-10-11 | Precedence, reload, `hooks` key. `D3:<line>` / `D3r:<line>` |
| D4 | https://code.claude.com/docs/en/headless.md, sub-agents.md, workflows.md, fetched 2026-10-11 | `-p`, subagents, workflows |
| H | `claude --help` (2.1.289), run 2026-10-11 | Flags (`--settings`, `--setting-sources`, `--include-hook-events`, `--bare`, `--safe-mode`, `-p` notes) |
| B | String scan of the installed binary `.../npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (249 MB) with `grep -a -o '"<Event>"'` | Every one of the 33 event names below occurs as a quoted string (counts 7 to 97) |
| L | Hook lab: 4 `claude -p` runs on 2026-10-11 under `D:/mvp/private/scratch/mcs-v3/hook-lab/run1..run4` | Observed payloads, order, exit handling. Section 8 |

The docs mirror (D1) is newer than the installed binary: it documents features that need v2.1.290 to v2.1.296 (see 9.1).
Anything below that only the docs state is labeled (docs); anything also observed in the lab is labeled (observed).

## 1. Hook events

33 event names. All 33 are present as strings in the 2.1.289 binary (B). Events marked "obs" fired in the lab (L).

| Event | When it fires (D1:37-71 and per-event section) | Matcher field | Can block / alter | obs |
|---|---|---|---|---|
| SessionStart | New session, resume, `/clear`, compaction, fork (D1:1188-1194) | `source`: startup, resume, clear, compact, fork | No block; plain stdout and `additionalContext` become context (D1:810, 1269) | yes |
| Setup | Only `--init-only`, or `-p --init` / `-p --maintenance` (D1:1346) | `trigger`: init, maintenance | No | no |
| InstructionsLoaded | CLAUDE.md / rules file loaded, at start and lazily (D1:1385) | `load_reason` | No, async, output discarded (D1:1418) | yes |
| UserPromptSubmit | Prompt submitted; also scheduled tasks, `/loop`, background subagent reports, cross-session messages (D1:1426-1430) | none | Yes; plain stdout becomes context (D1:1461) | yes |
| UserPromptExpansion | A typed slash command / MCP prompt expands (D1:1499) | `command_name` | Yes; stdout becomes context (D1:810) | no |
| MessageDisplay | Assistant text displayed; in `-p` once per message with `final: true` (D1:1563) | none | Display-only rewrite via `displayContent` (D1:1597) | yes (main agent only) |
| PreToolUse | After Claude builds tool params, before execution; not for `EndConversation` (D1:1681-1688) | `tool_name` | Yes (deny/ask/allow/defer, `updatedInput`) | yes |
| PermissionRequest | A permission prompt would be shown, or a call would be auto-denied because nothing can prompt (D1:2020, 2035) | `tool_name` | Yes via `decision.behavior`; exit 2 ignored (D1:938) | yes |
| PermissionDenied | Auto mode denies a call; only in auto mode (D1:2346) | `tool_name` | `retry: true` only | no |
| PostToolUse | Tool completed successfully (D1:2120) | `tool_name` | `decision: block`, `updatedToolOutput`, context | yes |
| PostToolUseFailure | Tool started and failed; not for validation rejects or permission denials (D1:2227-2233) | `tool_name` | Context only | yes |
| PostToolBatch | Once after all calls of a batch resolve, before next model call (D1:2289) | none | Yes: block / `continue:false` stops the loop (D1:2342) | yes |
| Notification | permission_prompt (after ~6 s), idle_prompt (~60 s), auth_success, elicitation_*, agent_needs_input, agent_completed, quota_auto_resume_* (D1:2398-2411) | `notification_type` | No | no |
| SubagentStart | Agent tool spawns or resumes a subagent; each message an in-process teammate handles (D1:2486) | `agent_type` | Context only | yes |
| SubagentStop | Subagent finished; also internal agents (prompt suggestions, `/btw`) with empty or session `agent_type` (D1:2524-2532) | `agent_type` | Yes (keeps subagent running) | yes |
| TaskCreated | `TaskCreate` tool (D1:2559) | none | Yes (rolls back) | no |
| TaskCompleted | `TaskUpdate` to completed, or teammate ends turn with in-progress tasks (D1:2614) | none | Yes | no |
| Stop | Main agent finished responding; not on user interrupt; API errors fire StopFailure (D1:2671-2673) | none | Yes (continues the turn) | yes |
| StopFailure | Turn ended by API error (D1:2775) | `error` | No; output ignored | no |
| TeammateIdle | Agent-team teammate about to go idle (D1:2803) | none | Yes | no |
| ConfigChange | Settings / managed / skill file changed mid-session (D1:2853) | `source` | Yes (except policy) | no |
| CwdChanged | Shell command in main conversation changes cwd (D1:2922) | none | No | no |
| DirectoryAdded | `/add-dir` or SDK `register_repo_root` (D1:2957) | `source` | No; runs in background | no |
| FileChanged | Watched file changes; matcher is the watch list (D1:3001) | literal filenames | No | no |
| WorktreeCreate | Worktree creation; a hook REPLACES default git behavior and must print the path (D1:3080, 3123) | none | Yes, any non-zero fails creation | no |
| WorktreeRemove | Removal of a hook-created worktree (D1:3138) | none | Yes | no |
| PreCompact | Before compaction (D1:3198) | `trigger`: manual, auto | Yes (blocks compaction) | no |
| PostCompact | After compaction (D1:3230) | `trigger` | No | no |
| PreModelSwitch | Before a requested model switch, v2.1.251+ (D1:3258) | canonical target model | Yes; a timed-out hook blocks the switch (D1:3407) | no |
| PostModelSwitch | After any model change, including resume/fallback (D1:3413) | canonical target model | Context only; stdout becomes context (D1:810) | no |
| Elicitation | MCP server requests user input (D1:3511) | MCP server name | Yes | no |
| ElicitationResult | After user answers an elicitation (D1:3711) | MCP server name | Yes | no |
| SessionEnd | Session terminates (D1:3466) | `reason`: clear, resume, logout, prompt_input_exit, other | No | yes (`reason: "other"` in `-p`) |

Cadence (D1:21-25): per session SessionStart/SessionEnd; per turn UserPromptSubmit/Stop/StopFailure; per tool call
PreToolUse/PostToolUse.

## 2. Stdin payload

### 2.1 Common fields

| Field | Type | Presence (docs D1:732-752) | Observed (L) |
|---|---|---|---|
| `session_id` | string (UUID) | always | every event, all runs |
| `transcript_path` | string, absolute | always; file may lag the in-memory conversation (D1:736) | every event; Windows backslashes; shape `C:/Users/<user>/.claude/projects/<cwd-slug>/<session_id>.jsonl`; file existed |
| `cwd` | string, absolute | always; follows `cd` and worktrees (D1:613) | every event; backslashes; equal to the hook process cwd |
| `hook_event_name` | string | always | every event |
| `prompt_id` | string (UUID) | absent until first user input (D1:735) | absent on InstructionsLoaded, SessionStart; present from UserPromptSubmit on, including SubagentStart/Stop and SessionEnd; same value through one turn |
| `permission_mode` | enum string | "not all events" (D1:739) | present on UserPromptSubmit, Pre/PostToolUse, PostToolUseFailure, PermissionRequest, PostToolBatch, SubagentStop, Stop; absent on SessionStart, InstructionsLoaded, SubagentStart, MessageDisplay, SessionEnd |
| `agent_id`, `agent_type` | string | inside a subagent / teammate, or with `--agent` (D1:743-748) | present on SubagentStart/Stop; tool events inside a subagent not exercised |
| `scratchpad_dir` | string | v2.1.257+, absent when no scratchpad (D1:738) | never present in `-p` runs |
| `effort` | object `{level}` | tool-context events when the model supports effort (D1:740) | never present (model was Haiku 4.5) |

There is no `model` field except optionally on SessionStart (D1:750); it was absent in all four lab runs.
There is NO per-event unique id in any payload (docs and observed). Section 7 proposes keys.

### 2.2 Event-specific fields (docs, with observed key sets where available)

Observed key sets are exact (values replaced by types; enums shown when short). Lab session flags: `-p`, `--model haiku`.

- **SessionStart**: `source`; optional `model`, `agent_type`, `session_title`; on resume/fork also
  `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (D1:1208-1226).
  Observed: `{session_id, transcript_path, cwd, hook_event_name, source:"startup"}` (317 bytes).
- **InstructionsLoaded**: `file_path`, `memory_type`, `load_reason`, optional `globs`, `trigger_file_path`,
  `parent_file_path` (D1:1395-1402). Observed: `{session_id, transcript_path, cwd, hook_event_name, file_path, memory_type:"Project", load_reason:"session_start"}`.
- **UserPromptSubmit**: `prompt` (full text, pasted blocks expanded), optional `session_title` (D1:1440-1442).
  Observed: `{session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt}`.
- **UserPromptExpansion**: `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` (D1:1507).
- **MessageDisplay**: `turn_id`, `message_id` (not the API msg id), `index`, `final`, `delta` (D1:1569-1575).
  Observed: `{..., prompt_id, hook_event_name, turn_id, message_id, index:0, final:true, delta}`. Did not fire for the subagent's text (run2).
- **PreToolUse**: `tool_name`, `tool_input` (per tool, D1:1722-1901), `tool_use_id`; `mcp_server {name, source}` for MCP tools (v2.1.274+, D1:1699).
  File paths are absolute, backslashes on Windows (D1:1701-1706). Observed Bash: `tool_input:{command, description}`, `tool_use_id` = `toolu_` + 24 chars;
  Agent: `tool_input:{description, prompt, subagent_type, run_in_background}`.
- **PermissionRequest**: `tool_name`, `tool_input`, optional `permission_suggestions`, `mcp_server`; NO `tool_use_id` (D1:2031).
  Observed: `{..., tool_name:"Bash", tool_input:{command, description}, permission_suggestions:array(0)}`.
- **PostToolUse**: `tool_name`, `tool_input`, `tool_response` (tool-specific structured object), `tool_use_id`, optional `duration_ms` (D1:2131-2156).
  Observed Bash `tool_response:{stdout, stderr, interrupted, isImage, noOutputExpected}` (`noOutputExpected` is undocumented).
  Observed Agent `tool_response:{status:"completed", prompt, agentId, agentType, harnessNoteCount, harnessTailCount, harnessSectionHash, content, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage}`;
  `agentType`, `prompt`, `harness*` are undocumented (D1:1862-1872 lists the rest). `agentId` equals the SubagentStart `agent_id`.
- **PostToolUseFailure**: `tool_name`, `tool_input`, `tool_use_id`, `error` (string; Bash: first line `Exit code N` then combined output),
  optional `is_interrupt`, `duration_ms` (D1:2258-2268). Observed exactly that set; `error` contained the command's output (privacy).
- **PostToolBatch**: `tool_calls[] {tool_name, tool_input, tool_use_id, tool_response}`; `tool_response` is the serialized string or block array the model sees (D1:2293-2323).
  Observed: a permission-denied call appears here with the rejection text as `tool_response`.
- **PermissionDenied**: `tool_name`, `tool_input`, `tool_use_id`, `reason` (D1:2352).
- **Notification**: `message`, optional `title`, `notification_type` (D1:2468).
- **SubagentStart**: `agent_id`, `agent_type` (D1:2492). Observed: `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type:"general-purpose", hook_event_name}`;
  `agent_id` 17 hex chars; `transcript_path` is the MAIN transcript. No `tool_use_id` linking it to the Agent call.
- **SubagentStop**: `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` (D1:2528-2536).
  Observed exactly that set plus common fields; `agent_transcript_path` shape `.../projects/<cwd-slug>/<session_id>/subagents/agent-<agent_id>.jsonl`, file existed at hook time.
- **TaskCreated / TaskCompleted**: `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name` (deprecated), `agent_id` (v2.1.290+) (D1:2581-2644).
- **Stop**: `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` (D1:2681-2710).
  Observed: `{..., permission_mode, hook_event_name, stop_hook_active:false, last_assistant_message, background_tasks:array(0), session_crons:array(0)}`.
- **StopFailure**: `error` (enum), optional `error_details`, `last_assistant_message` (D1:2781-2785).
- **TeammateIdle**: `teammate_name`, `team_name`, `agent_id` (v2.1.290+) (D1:2823-2827).
- **ConfigChange**: `source`, optional `file_path` (D1:2887). **CwdChanged**: `old_cwd`, `new_cwd` (D1:2930).
  **DirectoryAdded**: `directory`, `source` (D1:2978). **FileChanged**: `file_path`, `event` change/add/unlink (D1:3048).
- **WorktreeCreate**: `name`. **WorktreeRemove**: `worktree_path` (D1:3111, 3179).
- **PreCompact**: `trigger`, `custom_instructions` (string or null). **PostCompact**: `trigger`, `compact_summary` (D1:3215, 3241).
- **PreModelSwitch / PostModelSwitch**: `from_model`, `to_model`, `requested_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` (D1:3344-3354, 3450).
- **Elicitation**: `mcp_server_name`, `message`, optional `mode`, `url`, `elicitation_id`, `requested_schema` (D1:3519).
- **SessionEnd**: `reason` (D1:3482). Observed: `{session_id, transcript_path, cwd, prompt_id, hook_event_name, reason:"other"}`.

### 2.3 Sizes observed

All 50 lab payloads were 317 to 1653 bytes (largest: PostToolUse for Agent). Payloads are not bounded in general:
Write `tool_input.content`, Read/PostToolBatch `tool_response`, `last_assistant_message`, `compact_summary` and
`prompt` carry full text (docs D1:2319 "Responses can be large"). Upper bound: UNVERIFIED.

## 3. Registration (settings schema)

### 3.1 Shape (D1:239-249, D3r:4110-4116)

```json
{ "hooks": { "<Event>": [ { "matcher": "<optional>", "hooks": [ { "type": "command", "command": "node", "args": ["<abs>/hook.mjs"], "timeout": 5 } ] } ] } }
```

- Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent` (agent is experimental) (D1:404-410).
- Common handler fields: `type`, `if` (permission-rule filter; only on tool events; on other events a hook with `if` NEVER runs),
  `timeout` (SECONDS), `statusMessage`, `once` (skill frontmatter only) (D1:422-428).
- Command fields: `command`, `args` (exec form, no shell), `async`, `asyncRewake`, `shell` (`bash` | `powershell`),
  `onFailure` (v2.1.295+, so not in 2.1.289 per docs) (D1:454-461).
- HTTP fields: `url`, `headers`, `allowedEnvVars`, `onFailure` (D1:510-515). Allowlists `allowedHttpHookUrls`,
  `httpHookAllowedEnvVars` apply to every source (D1:282-285).
- Matcher (D1:291-299): `"*"`, `""` or omitted = all; only `[A-Za-z0-9_\- ,|]` = exact name or list; anything else =
  unanchored JavaScript regex. Case-sensitive (D2:978). A matcher on an event without matcher support is ignored (D1:351).

### 3.2 Timeouts (D1:426, D2:956-962)

Defaults: 600 s for `command`/`http`/`mcp_tool`; 30 s on UserPromptSubmit, PreModelSwitch, PostModelSwitch; 10 s on
MessageDisplay; 30 s `prompt`; 60 s `agent`. SessionEnd hooks share a 1.5 s budget, raised by the largest per-hook
`timeout` up to 60 s, or by `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` (D1:3497-3502). A timed-out hook is canceled and
its output discarded; on PreToolUse it does not block; on PreModelSwitch it DOES block (D1:874-879).
Consequence: a monitor handler that hangs (for example an HTTP call to a dead server without its own timeout) stalls
every tool call for up to 10 minutes. Always set an explicit small `timeout`.

### 3.3 Async (D1:3971-4078)

`async: true` (command only): runs in background, cannot block, `timeout` not enforced. Output JSON
(`additionalContext`, `systemMessage`) is delivered to Claude on the next turn, so an async handler must also print nothing.
In `-p`, async hooks still running at teardown are killed with outcome `cancelled` (D1:4004). Observed (run4): an async
Stop handler that sleeps 1.5 s got `hook_response outcome:"cancelled" exit_code:1` and never wrote; an async
PostToolUseFailure handler with the same sleep completed. Debug log: `Registering async hook ... with timeout 600000ms`.

### 3.4 Environment and shell

- Placeholders `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` are substituted in both forms and
  exported as env vars (D1:496, 603-607). `CLAUDE_PROJECT_DIR` stays at the launch root; `cwd` in the payload follows
  Claude (D1:610-613). `CLAUDE_ENV_FILE` only for SessionStart, Setup, CwdChanged, FileChanged (D1:1341).
- Observed env var NAMES (values not recorded) in every hook process of all four runs: `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_PID`, `CLAUDE_PROJECT_DIR`. `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` were present on
  every event EXCEPT SessionEnd (absent on SessionEnd in all four runs). `CLAUDE_ENV_FILE` on SessionStart only. These were
  set by Claude Code itself (the lab launched `claude` with all `CLAUDE*` vars removed via `env -u`). 79 to 83 env names
  per hook process (79 on SessionEnd). (Corrected by verification, see the log at the end.)
  Whether `CLAUDE_CODE_SESSION_ID` equals the payload `session_id`: UNVERIFIED (values were not captured on purpose).
- The hook process inherits the parent env except `OTEL_*` exporter vars (D1:754). It includes a messaging token
  (observed name above), so a handler must never dump its environment.
- Shell form uses `sh -c` on macOS/Linux, Git Bash on Windows, PowerShell when Git Bash is absent (D1:471). Debug log
  confirms Git Bash (`Creating shell snapshot for bash (C:/Program Files/Git/bin/bash.exe)`). Git Bash may source the
  user profile and print text before JSON (D2:1033). Exec form (`args` set) spawns without a shell on every platform;
  on Windows `command` must be a real `.exe` (`node` qualifies; npm `.cmd` shims do not) (D1:469-475).
- Hooks run in the current directory; if it was deleted they fall back to session start dir, project root, home, temp (D1:414).

### 3.5 Where hooks live, merging, dedupe (D1:251-286, 412, 674-700)

User `~/.claude/settings.json`, project `.claude/settings.json`, project-local `.claude/settings.local.json`, managed
policy, plugin `hooks/hooks.json`, skill frontmatter (rest of session after the skill is invoked), subagent frontmatter
(while it runs; its `Stop` becomes `SubagentStop`). `--settings <file-or-json>` sits above user/project/local and below
managed (D3:566, 633). Entries MERGE across levels, they never replace (D1:280, D3r:4114). All matching handlers run in
PARALLEL. "If you define the same handler in more than one settings file, it runs once. A plugin's or skill's copy of the
same handler stays separate" (D1:412). Settings-file hooks also fire inside subagents with `agent_id`/`agent_type` (D1:269).
Kill switches: `disableAllHooks` (settings), `--settings '{"disableAllHooks": true}'`, `--bare`, `--safe-mode`,
`allowManagedHooksOnly` (managed) (D1:271-280, 714-716, H).

### 3.6 Snapshot or live reload

Docs: settings files are watched and hook edits apply to the running session without restart; a settings file created
mid-session is loaded if its folder existed at start (D3:584, D1:718, D2:841, D2:1002 "restart your session" if the
watcher missed it). Observed debug lines: `Watching for changes in setting files ...`, `Watching ... for .claude to appear`.
Not tested empirically: whether an edit to user settings reaches an already running session (UNVERIFIED), and whether a
`--settings` FILE is watched (UNVERIFIED). Design assumption: installing or removing our hooks may affect sessions that
are already running, including the owner's unattended chain.

### 3.7 Trust and consent (D1:4088-4095, D4 headless:41, sub-agents:751-753)

Interactive: hooks from every settings file (user included) are held back until the workspace trust dialog is accepted.
`-p` / SDK: no dialog, folder treated as trusted, so settings hooks run. Project subagent frontmatter hooks need explicit
trust even in `-p` (v2.1.218+). `claude --help` (H): in `-p`, "Settings files that fail validation are silently ignored".
Per D3:608 an unknown hook event name only drops that entry ("Settings Warning"). Consequence: an installer that writes
invalid JSON into `~/.claude/settings.json` would silently drop ALL user settings (permissions, model) for every `-p` run.

## 4. Exit codes and stdout (what our handler must avoid)

Outcome table (D1:782-794): exit 0 = success; exit 2 = blocking error on events that can block (stderr becomes the
reason); any other exit, failure to start, or invalid JSON = non-blocking error, action proceeds, a `<hook> hook error`
notice is shown. Exit-2 effect per event: D1:935-969 (summarized in the table in section 1).

Stdout parsing for non-async hooks (D1:812-819): a single JSON object = JSON output; text not starting with `{` = plain
text; malformed `{...}` = parse failure (non-blocking error). Plain stdout on exit 0 is ADDED TO CLAUDE'S CONTEXT on
UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch (D1:810); other events log it.

Behavior-changing JSON fields we must never emit: `continue`, `stopReason`, `decision`, `reason`, `systemMessage`,
`terminalSequence`, and any `hookSpecificOutput` (`permissionDecision`, `updatedInput`, `additionalContext`,
`updatedToolOutput`, `updatedMCPToolOutput`, `classifierContext`, `displayContent`, `initialUserMessage`, `sessionTitle`,
`watchPaths`, `reloadSkills`, `retry`, `decision.behavior`, `action`, `worktreePath`) (D1:1008-1014, 1102-1125, per-event).

Rule for our handler: read stdin fully, write nothing to stdout, nothing meaningful to stderr, always exit 0, catch every
error. Special cases:
- PermissionRequest in `-p` with no permission host: when no hook decides, the call is denied (D1:2020). A silent handler
  leaves that unchanged (observed: run3, call denied, `permission_denials: 1`).
- Elicitation: exit 0 with no output leaves the dialog to the user (D1:3565).
- WorktreeCreate: a configured hook REPLACES git worktree creation and must print a path; a silent handler would make
  every `--worktree` / `isolation: "worktree"` creation fail (D1:3080-3123). Never register it.
- MessageDisplay: each batch waits for the hook (D1:1557). Registering it adds display latency for no monitor value.
- PreModelSwitch: a timeout blocks the switch (D1:3407). Use PostModelSwitch instead.

Observed failure behavior (run3, four broken handlers on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop):
- Missing script, exec form (`node` + missing path): exit 1, stderr `Cannot find module`, outcome `error`.
- Missing script, shell form: exit 127, `bash: <path>: No such file or directory`.
- `process.exit(1)` and an uncaught throw: exit 1.
- The session was unaffected: result `success`, 3 turns, Bash still ran.
- BUT each failure appended a `hook_non_blocking_error` attachment entry to the session transcript JSONL (24 entries =
  4 handlers x 6 firings) and an `[ERROR] Hook ... error: status code 1` line to the debug log. Whether these entries
  reach the model context: UNVERIFIED. A buggy monitor handler therefore pollutes users' transcripts.
- Successful silent handlers left no hook entries in the transcript other than a `system:stop_hook_summary` entry.

## 5. Non-interactive runs, subagents, workflows

- `-p`: settings hooks run even in untrusted folders (3.7). MessageDisplay fires once per message (D1:1563, observed).
  `terminalSequence` ignored (D1:1040). `defer` only honored in `-p` (D1:1980). Async hooks are killed at teardown
  (observed). SessionEnd fired with `reason: "other"` in all four runs. On SIGTERM, Claude Code runs only SessionEnd
  hooks while exiting (D4 headless:96).
- `--output-format stream-json --verbose --include-hook-events` (H) streams `system` messages `hook_started` and
  `hook_response` with keys `type, subtype, hook_id, hook_name, hook_event, output, stdout, stderr, exit_code, outcome,
  uuid, session_id` (observed). Useful only for runs the monitor launches itself.
- In the stream, SessionStart and UserPromptSubmit hooks completed BEFORE the `system/init` message (observed, run1/run2).
- Subagents (observed run2, foreground general-purpose agent with no tools): PreToolUse(Agent) -> SubagentStart ->
  SubagentStop -> PostToolUse(Agent) -> PostToolBatch. The link Agent `tool_use_id` <-> `agent_id` exists only in
  PostToolUse `tool_response.agentId`. Background subagents return `status:"async_launched"` with `agentId` (D1:1864,
  1876); subagents default to background (D1:1864). Tool events inside a subagent carry `agent_id` (D1:269), not
  exercised in the lab (UNVERIFIED on 2.1.289).
- Workflows: the workflows page (D4) does not mention hooks. Whether workflow agents fire SubagentStart/Stop and tool
  events with `agent_id`: UNVERIFIED. A Workflow launch is itself a tool call (`Workflow` in the PreToolUse tool list, D1:1681).
- Denied calls (observed run3): PreToolUse fired, then PermissionRequest, then NO PostToolUse and NO PostToolUseFailure;
  only PostToolBatch shows the call (with the rejection text). PermissionDenied fires only in auto mode (D1:2346).
  A monitor must close such calls from PostToolBatch, Stop, or the transcript `tool_result`.
- Note: PreToolUse fires before the permission check, in every mode (D2:968).

## 6. Recursion and loop risks

1. Stop/SubagentStop blocking loops: `stop_hook_active` plus an 8-continuation cap (D1:2681-2683). We never block, so
   not applicable, but never emit `decision`.
2. Nested sessions: any `claude` process started by the handler or by the monitor server (summaries, "ask Claude",
   tests) loads the same user hooks and reports to the same monitor; a handler that spawns `claude` per event recurses.
   Mitigations: the handler never spawns any process; the server launches child sessions with
   `--settings '{"disableAllHooks": true}'` (documented kill switch, D1:714) and an env marker (for example
   `MCS_HOOK_DISABLE=1`) that the handler checks first and exits 0. Hook processes inherit the session env (D1:754), so
   the marker propagates to grandchildren.
3. Self-observation: monitor-launched sessions (E2E, smoke tests) will appear as monitored sessions unless tagged; tag via
   the env marker rather than filtering by path.
4. ConfigChange: our installer editing settings mid-session fires ConfigChange in running sessions (D3:586). Harmless if we
   do not register ConfigChange, or register it silent.
5. File watchers: FileChanged only watches configured names / `watchPaths` (D1:3001); keep spool files outside project
   `.claude/` folders and never return `watchPaths`.
6. Duplicate delivery: the same handler in user + project settings runs once, but a plugin or skill copy runs again
   (D1:412). Server-side dedupe must use natural keys, not only a handler-generated UUID.

## 7. Security and privacy

- Payloads carry raw prompts (`prompt`), assistant text (`last_assistant_message`, `delta`, `compact_summary`), full file
  contents (Write `tool_input.content`, Read results in PostToolBatch), command output (`tool_response.stdout`,
  PostToolUseFailure `error`, observed), absolute user paths (`transcript_path`, `cwd`, `file_path`), MCP server names.
  Treat every payload as sensitive: store locally only, cap and truncate large fields, never log raw payloads.
- Hook env includes a messaging token name (observed) and possibly credentials passed by the user's shell; never record
  env values.
- Command hooks run with full user permissions (D1:4084). HTTP hooks to localhost are subject to `allowedHttpHookUrls`
  if an org sets it (D1:284).
- `-p` runs hooks from a repository's `.claude/settings.json` without trust (D1:4093); our installer should prefer user
  scope and never commit hook config to a project.

## 8. Lab evidence (2026-10-11)

Setup: `D:/mvp/private/scratch/mcs-v3/hook-lab/runN/` each with `capture.mjs` (appends raw stdin JSON + env NAMES to
`captures.jsonl`, prints nothing, exits 0) and `settings.capture.json` registering 32 events (all except WorktreeCreate)
in exec form (`"command":"node","args":[<abs path>, <Event>]`, `timeout: 30`), plus a shell-form duplicate on
SessionStart and PreToolUse. Command template:

```
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID ... (all CLAUDE* vars) claude -p "<prompt>" --model haiku --max-budget-usd 0.30 \
  --settings settings.capture.json --setting-sources project --allowedTools "<rule>" \
  --output-format stream-json --verbose --include-hook-events --debug-file debug-X.log
```

`--setting-sources project` kept user settings and the user's 11 plugins out (debug: `Registered 0 hooks from 3 plugins`,
the three being built-ins). `--max-turns` is not listed in `claude --help` 2.1.289, so a budget cap was used instead.
All four runs exited 0; costs 0.025, 0.041, 0.023, 0.018 USD (from the `result` message); model `claude-haiku-4-5-20251001`.

| Run | Prompt intent | Observed event order (relative ms from first capture) |
|---|---|---|
| run1 | Bash `echo hi` (allowed) | InstructionsLoaded 0, SessionStart 131 (+shell form 177), UserPromptSubmit 1425, PreToolUse 3318 (+shell 3357), PostToolUse 4265, PostToolBatch 4323, MessageDisplay 5537, Stop 5615, SessionEnd 5701 |
| run2 | One foreground subagent, no tools | InstructionsLoaded, SessionStart, UserPromptSubmit, PreToolUse(Agent) 4620, SubagentStart 4734, SubagentStop 6338, PostToolUse(Agent) 6428, PostToolBatch 6505, MessageDisplay 9820, Stop 9882, SessionEnd 9974 |
| run3 | `ls /nonexistent...` (outside workspace) then `pwd`, plus 4 broken handlers | ..., PreToolUse(ls), PermissionRequest (denied), PostToolBatch, PreToolUse(pwd), PostToolUse, PostToolBatch, MessageDisplay, Stop, SessionEnd |
| run4 | `ls ./nonexistent...` (fails, exit 2), async handlers | ..., PreToolUse, PostToolUseFailure, PostToolBatch, MessageDisplay, Stop, SessionEnd (async Stop cancelled) |

Differences from the docs: InstructionsLoaded fired BEFORE SessionStart; `prompt_id` present on SubagentStart,
SubagentStop and SessionEnd; `permission_mode` absent on SubagentStart; undocumented `tool_response` keys
(`noOutputExpected` for Bash; `agentType`, `prompt`, `harnessNoteCount`, `harnessTailCount`, `harnessSectionHash` for
Agent); subagent text did not fire MessageDisplay; `agent_id` was 17 hex chars (the docs `agent_id` examples are `agent-abc123` and
`def456`, D1:2500, 2546; the 16-hex example `a4d2c8f1e0b3a297` is for `tool_response.agentId`, D1:1865); a `pwd` call was
auto-allowed without `--allowedTools` (read-only command); an `ls` outside the working directory prompted even though
`Bash(ls *)` was allowed (workspace path rule).

### 8.1 Timing (measured 2026-10-11 on this machine)

| Measurement (wall clock from Git Bash, 5 runs unless noted) | Result |
|---|---|
| `echo <payload> \| node capture.mjs` | 109, 102, 98, 118, 98 ms (median 102 ms) |
| `node -e ""` (bare Node start) | 67, 66, 66, 66, 68 ms |
| `bash -c true` (Git Bash start, 3 runs) | 53, 54, 49 ms |
| In-session: shell-form handler capture-timestamp lag vs exec-form sibling (all four runs) | 22 to 60 ms (SessionStart 46/33/26/22 ms; PreToolUse 39/41/50/60/36 ms) |
| `process.uptime()` of the handler at exit (in-session) | 19 to 61 ms |

So each synchronous node handler costs about 0.1 s per event on this machine, and a tool call fires at least
PreToolUse + PostToolUse (+ PostToolBatch), all blocking.

### 8.2 Minimum safe hook command (Windows + Git Bash)

Exec form, absolute paths, explicit timeout, no matcher:

```json
{ "type": "command", "command": "C:/Program Files/nodejs/node.exe", "args": ["<abs path>/mcs-hook.mjs"], "timeout": 5 }
```

Reasons: no shell (no Git Bash profile output, no quoting, ~50 ms saved), works when the path contains spaces (D1:503),
does not depend on `node` being on the PATH of GUI-launched sessions (bare `"node"` worked in the lab because it was on
PATH). The absolute node path should be resolved by the installer. For SessionEnd keep total work under 1.5 s or set
`timeout` (raises the shared budget, D1:3497).

## 9. Version notes and unverified items

### 9.1 Documented features newer than 2.1.289 (do not rely on them)

`onFailure` (2.1.295, D1:461; the string exists in the 2.1.289 binary but behavior untested), multi-line async JSON
(2.1.295, D1:4015), `Hooks: ... finished with status N (Xms)` debug lines (2.1.296, D1:4155; absent in our 2.1.289
logs, which show `completed with status 0` only for some events), `agent_id` on TaskCreated/TaskCompleted/TeammateIdle
(2.1.290), WebFetch `offset` (2.1.290), PowerShell `CLAUDE_ENV_FILE` (2.1.296).

### 9.2 UNVERIFIED

- Live reload of hook config into running sessions on 2.1.289; watching of `--settings` files.
- Tool events inside subagents carrying `agent_id`; background (`async_launched`) subagent ordering; workflow agents.
- Events not fired in the lab: Setup, UserPromptExpansion, PermissionDenied, Notification, TaskCreated, TaskCompleted,
  StopFailure, TeammateIdle, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove,
  PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult. Their payloads are docs-only.
- Interactive-mode behavior (trust dialog gating, MessageDisplay batching, SessionEnd reasons other than `other`).
- Whether `hook_non_blocking_error` transcript attachments are sent to the model.
- Whether `prompt_id` changes for turns started by crons / background subagent reports (UserPromptSubmit fires for them).
- Payload size upper bound; behavior of HTTP hooks (not tested); whether `CLAUDE_CODE_SESSION_ID` env equals `session_id`.
- Cause of the 1.6 s gap between Stop and SessionEnd in run4 (vs about 90 ms in run1-3); possibly waiting on the
  running async PostToolUseFailure handler.

## 10. Recommendations for the v3 hook ingester

1. Handler: one Node ESM script, exec form, absolute node path, `timeout` 5 s (SessionEnd: 2 s), no matcher. It reads
   stdin, checks a disable env marker, stamps `event_uid` (random UUID) and `received_at`, truncates large string fields
   (keep lengths and a hash), appends one line to a local spool file (append is a few ms), optionally POSTs to the local
   server with a 300 ms timeout, never prints, always exits 0 inside a global try/catch.
2. Register: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch (ids only),
   PermissionRequest, PermissionDenied, Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop,
   StopFailure, TeammateIdle, PreCompact, PostCompact, PostModelSwitch, CwdChanged, SessionEnd.
   Do NOT register: WorktreeCreate, WorktreeRemove, MessageDisplay, PreModelSwitch, Elicitation, ElicitationResult,
   FileChanged, Setup, ConfigChange. Optional: InstructionsLoaded, UserPromptExpansion, DirectoryAdded.
3. Sync vs async: keep Stop, SubagentStop, StopFailure, SessionEnd synchronous (async ones are cancelled at `-p`
   teardown, observed). High-frequency tool events may use `async: true` to remove ~0.1 s per event from the agent loop;
   accept possible loss of the last events of a `-p` run and rely on the transcript tail for reconciliation.
4. Treat hooks as a low-latency signal; the transcript JSONL stays the source of truth (`transcript_path`,
   `agent_transcript_path` give exact files).
5. Installer: merge into `~/.claude/settings.json` atomically (write temp, validate JSON, rename, keep a backup), mark our
   entries by script path for clean uninstall, never touch project settings, and require explicit owner consent because
   it changes every session on the machine, including running ones.

## 11. Event table for the ingester

| Event | Payload fields we will rely on | Idempotency key proposal | Notes |
|---|---|---|---|
| SessionStart | session_id, transcript_path, cwd, source, model? | `event_uid`; natural `session_id + SessionStart + source` (repeats on resume/clear/compact) | No prompt_id yet; fires before system init in `-p` |
| UserPromptSubmit | session_id, prompt_id, permission_mode, prompt (store length/hash only) | `session_id + prompt_id + UserPromptSubmit` | Also fires for crons, `/loop`, background-agent reports |
| PreToolUse | session_id, prompt_id, agent_id?, tool_name, tool_use_id, tool_input (summarized) | `tool_use_id + PreToolUse` | Fires before permission check |
| PermissionRequest | session_id, prompt_id, tool_name, tool_input | `session_id + prompt_id + sha256(tool_name + tool_input)` | No tool_use_id; correlate to the latest open PreToolUse with same input |
| PermissionDenied | tool_use_id, tool_name, reason | `tool_use_id + PermissionDenied` | Auto mode only |
| PostToolUse | tool_use_id, tool_name, duration_ms?, tool_response (summarized; Agent: agentId, status, totalTokens) | `tool_use_id + PostToolUse` | Agent `agentId` links tool_use_id to agent_id |
| PostToolUseFailure | tool_use_id, tool_name, is_interrupt?, duration_ms?, first line of error | `tool_use_id + PostToolUseFailure` | `error` holds command output; keep only `Exit code N` |
| PostToolBatch | tool_calls[].tool_use_id, tool_name | `session_id + sha256(sorted tool_use_ids)` | Only place a denied call is closed; drop tool_response bodies |
| Notification | session_id, notification_type, title? | `event_uid`; natural `session_id + notification_type + sha256(message) + minute` | Interactive timing gates (6 s / 60 s) |
| SubagentStart | session_id, agent_id, agent_type, prompt_id | `agent_id + SubagentStart + event_uid` (repeats on subagent resume / teammate messages) | transcript_path is the parent's |
| SubagentStop | agent_id, agent_type, agent_transcript_path, last_assistant_message (length only) | `agent_id + SubagentStop + stop_hook_active` (+ event_uid if resumed) | Also fires for internal agents with empty agent_type |
| TaskCreated / TaskCompleted | task_id, task_subject, agent_id? | `session_id + task_id + event` | Docs only |
| Stop | session_id, prompt_id, stop_hook_active, background_tasks[], session_crons[] | `session_id + prompt_id + Stop + stop_hook_active` | background_tasks distinguishes done vs waiting |
| StopFailure | session_id, prompt_id?, error | `session_id + prompt_id + StopFailure` | Output ignored by Claude Code |
| TeammateIdle | teammate_name, agent_id? | `event_uid` | Docs only |
| PreCompact / PostCompact | session_id, trigger | `event_uid`; natural `session_id + trigger + event` | compact_summary is sensitive |
| PostModelSwitch | from_model, to_model, source | `event_uid` | stdout would become context: stay silent |
| CwdChanged | old_cwd, new_cwd | `event_uid` | Main conversation only |
| SessionEnd | session_id, reason | `session_id + SessionEnd + event_uid` | 1.5 s shared budget; `reason:"other"` in `-p` |

`event_uid` = UUID generated once by the handler and reused on spool replay. Server dedupe: primary on `event_uid`,
secondary on the natural key where one exists (covers duplicate plugin/skill registrations, D1:412).

## Verification log (2026-10-11)

Adversarial re-check by a second agent. Primary sources re-opened: D1/D2 re-fetched with curl on 2026-10-11 and
byte-identical to the author's copies (`cmp`, 4159 and 1072 lines); installed binary re-scanned; lab files under
`D:/mvp/private/scratch/mcs-v3/hook-lab/run1..run4` re-parsed with a structure-only script
(`D:/mvp/private/scratch/mcs-v3/verify-hooks/shape.mjs`, prints event names, key sets, id lengths, flags; no values).

| Claim | Verdict | Evidence |
|---|---|---|
| All 33 event names occur as quoted strings in the 2.1.289 binary, counts 7 to 97 | confirmed | `grep -a -o` over `claude.exe` (`claude --version` = 2.1.289): 33 distinct names, min 7 (ConfigChange, DirectoryAdded, PostCompact), max 97 (PreToolUse). The D1 `###` event headings are the same 33 names |
| PermissionRequest has no `tool_use_id`; a denied call gets no PostToolUse/PostToolUseFailure, only PostToolBatch | confirmed | D1:2031; run3 PermissionRequest key set has no `tool_use_id`; that call's `tool_use_id` appears only in PreToolUse and PostToolBatch; `result.permission_denials` = 1 |
| `-p` order InstructionsLoaded, SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, MessageDisplay, Stop, SessionEnd(`other`) | confirmed | capture timestamps in run1 to run4; SessionEnd `reason` = `other` in all four; SessionStart and UserPromptSubmit `hook_response` came before `system/init` in all four `out-*.jsonl` |
| Subagent order and keys; `agent_id` 17 hex = `tool_response.agentId`; `agent_transcript_path` `<sid>/subagents/agent-<agent_id>.jsonl` | confirmed | run2: PreToolUse(Agent), SubagentStart, SubagentStop, PostToolUse(Agent), PostToolBatch; SubagentStart keys have no `tool_use_id` and no `permission_mode`; ids compared for equality (true) |
| `session_id` equals the transcript filename; `prompt_id` constant in a run, absent before UserPromptSubmit | confirmed | every capture: `transcript_path` ends with `<session_id>.jsonl`; one `prompt_id` per run; absent on InstructionsLoaded and SessionStart |
| Exit 0 plain stdout becomes context on UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch; exit 2 blocks; other codes non-blocking | confirmed | D1:810, D1:782-794; PermissionRequest ignores exit 2 (D1:938) |
| Broken handlers did not affect the run; 24 `hook_non_blocking_error` transcript entries in run3 | confirmed | run3 `result` subtype `success`, `num_turns` 3; 24 non-success `hook_response` (exit 1 and 127); run3 settings: 4 broken handlers x 6 firings; session transcript entry-type counts show 24 `attachment:hook_non_blocking_error` and 1 `system:stop_hook_summary` |
| Timeouts: 600 s default; 30 s on UserPromptSubmit/Pre/PostModelSwitch; 10 s MessageDisplay; SessionEnd 1.5 s shared budget; PreModelSwitch timeout blocks | confirmed | D1:426, D1:874-879, D1:3407, D1:3496-3502. "Stalls every tool call up to 10 minutes" is the author's inference from the 600 s default, not a documented statement |
| Async hooks cancelled at `-p` teardown; async Stop never wrote | confirmed | D1:4004; run4 stream: one non-success `hook_response` = Stop `cancelled` exit 1; `slow.jsonl` has a single line, labelled PostToolUseFailure-async; debug log shows `Registering async hook ... with timeout 600000ms` |
| WorktreeCreate hook replaces git worktree creation and must print a path | confirmed | D1:3080, D1:3123-3125 |
| Same handler in several settings files runs once; plugin/skill copies stay separate; entries merge | confirmed | D1:412, D1:280 |
| `-p` skips trust dialog; settings files failing validation are silently ignored | confirmed | `claude --help` (2.1.289) `-p` note; D1:4093; settings.md:607-608 (whole-file "Settings Error" vs entry-level "Settings Warning"). "Would drop all user settings" is an inference from these, not tested |
| Env var names "in every hook process", "81 env names total" | corrected | `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN` were absent on SessionEnd in all four runs; per-process name count was 79 to 83. Section 3.4 fixed |
| Shell-form lag 26 to 60 ms | corrected | the author's list omitted run4 (SessionStart 22 ms, PreToolUse 36 ms); value is a capture-timestamp difference, not a measured start time. Section 8.1 fixed |
| "docs example shows 16" hex for `agent_id` | corrected | D1 `agent_id` examples are `agent-abc123` and `def456` (D1:2500, 2546); the 16-hex example is `tool_response.agentId` (D1:1865). Section 8 fixed |
| Timing: capture.mjs ~0.1 s, bare node 66-68 ms, bash -c true 49-54 ms | confirmed (order of magnitude) | re-run 5x each on 2026-10-11 with a synthetic payload: 100-135 ms, 73-95 ms, 58-77 ms; somewhat slower than the author's numbers (machine load varies), conclusion "about 0.1 s per synchronous node handler" holds |

Privacy check: no emails, user names, tokens, session/tool ids, prompt text or file contents found in this file (regex scan
for emails, `toolu_` ids, UUIDs, `AppData`, user names; no literal backslash-u sequences; ASCII only).
