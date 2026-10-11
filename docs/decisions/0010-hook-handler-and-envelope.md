# ADR 0010: Hook handler contract and envelope v1

Status: Proposed (Phase 1 design, 2026-10-11). Design reference: `docs/design/02-ingestion-lifecycle.md` sections 2.1-2.5, 2.9-2.11.

## Context

Claude Code runs every configured command hook as a child process and waits for synchronous ones. A hook that hangs stalls the
agent loop (default timeout 600 s); plain stdout on SessionStart, UserPromptSubmit, UserPromptExpansion and PostModelSwitch is
added to the model's context; exit code 2 blocks on events that can block; a handler that cannot start appends a
`hook_non_blocking_error` attachment to the user's transcript on every firing. Payloads carry raw prompts, file contents,
command output and absolute paths, and have no unique id. Foundations D8 fixes a zero-dependency handler, exec form, no
stdout, exit 0, spool first, best-effort POST.

## Decision

1. Settings entry (exec form): `command` = absolute Node path of the installing CLI; `args` = `["--no-warnings",
   "<skill>/scripts/mcs-hook.mjs", "--mcs-hook", "<Event>"]` (+ `"--async"` for async events); `timeout` 5 s (SessionEnd 2 s).
2. `scripts/mcs-hook.mjs` is a committed stub that checks `MCS_HOOK_DISABLE`, dynamically imports the built handler
   (`runtime/packages/cli/dist/hook.js`, emitted from the entry `cli/src/hook.ts`, which re-exports `runHook` from
   `./hook/main.ts` and runs it only when it is the main module, design 1.1 and E10), and on import failure logs
   `HANDLER_UNAVAILABLE` and exits 0 (see design CHALLENGES C1).
3. The handler never writes stdout or stderr in hook mode, always exits 0, arms a 1200 ms hard exit, and catches every error.
4. It reads at most 8 MiB of stdin, routes (ADR 0011), sanitizes per the 21-event field policy (kept / summarized / dropped;
   previews redacted by rules R1-R7, clipped by code points), and writes one `HookEnvelopeV1` line (<= 16 KiB) per matched
   instance: `v, kind, instance_id, event_uid (randomUUID), received_at (handler start), event, argv_event, session_id,
   transcript_path, cwd, prompt_id, agent_id, agent_type, tool_use_id, permission_mode, claude_pid, payload_bytes,
   content_hash (sha256 of stdin, 32 hex), handler {version, pid, async}, flags[], data{}`.
5. Probes (`session_id` prefix `00000000-0000-4000-8000-`, Notification type `mcs_probe`) are marked `kind: "probe"`.

## Consequences

- Monitoring can never block or steer Claude Code; the worst case is about 0.07 s per synchronous event plus a capped
  300 ms nudge (E1).
- No prompt, message, tool input/output, error text or summary bodies are stored; only lengths, redacted previews and hashes
  where a feature needs them.
- `event_uid` plus `content_hash` give dedupe keys although the provider has none (ADR 0012 and design 4.4).
- The envelope has a version; a newer handler line is rejected by an older server (`ENVELOPE_VERSION`), never misread.

## Alternatives rejected

- HTTP hook type (no process spawn): no durability when the server is down, the URL would have to change with the port, and
  `allowedHttpHookUrls` policies may block it.
- Shell-form command: about 50 ms more, Git Bash profile output, quoting problems with spaces.
- Storing the full payload (CCAM): its own issue reports a 2 GB database; privacy.
- Handler without a stub pointing at the build output: transcript pollution during builds and upgrades (CHALLENGES C1).

## Evidence

- `docs/research/claude-code-hooks.md` sections 2-4, 8 (Claude Code 2.1.289, docs fetched 2026-10-11 from
  https://code.claude.com/docs/en/hooks.md).
- E1 `D:/mvp/private/scratch/mcs-v3/ingestion/e1/bench.mjs`, 2026-10-11, Node 24.14.1, Windows 11: median 65-72 ms per run.
- E9 `keys-attach.mjs` on the hook-lab run3 transcript, 2026-10-11: `hook_non_blocking_error.command` includes the args.
- Redaction rules executed on sample inputs, `D:/mvp/private/scratch/mcs-v3/ingestion/e10/t.mjs`, 2026-10-11.

## Requirements covered

Master brief MEGA-PROMT-V3 sections 5 (hook delivery requirements: validate input, preserve ids and timestamps, routing identity, bounded timeouts, fail safe, never block, diagnostics without secrets, no recursion, observable failures), 12 (validate hook payloads and sizes, timeouts, secrets out of logs, monitoring never blocks Claude Code).

## Open items

OI-7 (payload upper bound; the 8 MiB stdin cap bounds memory either way). Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-1 (protocol: envelope, policy table, sanitize), I-2 (handler and stub). Slice table: design section 13.
