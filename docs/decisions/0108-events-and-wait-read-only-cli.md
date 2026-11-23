# 0108 Events and wait in the CLI: read-only consumers of the durable stream

Status: Accepted (CAW, 2026-11-23). Owner: the attention block (contracts in `packages/shared/src/cli/watch.ts` and
`packages/shared/src/wait-machine.ts`; the follower and the two commands are built on them by the package that follows). Extends ADR 0008
(the CLI contract: the envelope accepts three more exit codes, decision 5). ADR 0079 (monitoring is read-only, the terminal is active) and
ADR 0060 (the read-only MCP server) are untouched. Related: 0107 (the attention classifier both commands use).

## Context
A script or an agent that starts an unattended `claude` run has to learn when it needs a person, when a turn ended and whether the run
really completed. Today it can only poll `status` and the HTTP API and re-implement the state reading. The server already has a durable
change stream with a cursor and a completion check with evidence; what is missing is a CLI surface that follows the stream as lines and one
that blocks until a condition holds, with an exit code a shell can branch on.

## Decision
1. **A line format `caw.event/1`.** `events` prints NDJSON, one strict object per line, discriminated on `type` (`CliEventSchema`,
   generated into `schemas/event.v1.schema.json`): `hello` (`instanceId`, `epoch`, `headSeq`, `serverTime`), `change` (`seq`, `at`, `kind`,
   `op`, `sessionId`, `session`), `reset` (`reason`, `headSeq`) and `end` (`headSeq`, `count`: a replay without follow ended). `session` is
   set only for a session upsert with readable data and holds `state`, `rule`, `basis`, `confidence`, `presence`, `waitReason`,
   `turnOutcome`, `since` and `attention: { posture, reason }`; it is `null` on every other change. A line carries ids, states and times
   only: no label, folder, project name, evidence text, transcript or registry text. Heartbeats are not printed. An error ends the stream
   with one `mcs.cli/1` error envelope line.
   This is the first `caw.` wire identifier. The `mcs.*` identifiers (`mcs.cli/1`, `mcs.export/1`, `mcs.diagnostics/1`, the `X-MCS-*`
   headers) are frozen because files and peers of older versions carry them; no old version reads or writes an event line, so nothing
   forces the old prefix on a new format, and the program's name is the honest one for it.
2. **Both commands are readers.** They read the open routes and the stream of a running instance. They start, stop, signal and write
   nothing, need no control token and no access code, and never touch a terminal. ADR 0079 keeps its line: only the terminal service acts.
3. **Wait conditions.** `wait --session ID --until needs_you|turn_ended|completed|failed|ended`, decided by the shared classifier:
   `needs_you` is the posture `needs_you` held for `--hold` (default 3 s, so that a `needs_you` that flips back at once does not count); `turn_ended` is
   rule S-8b, S-8c or S-8e, or a session that ended (S-8a, background work, and S-8f, nothing ran, do not count); `failed` is the posture
   `failed` (a failed session or a turn that ended in an error); `ended` is `presence: ended`. `--next` wants the condition to be seen
   false and then true after the wait began; without it a condition that already holds is met at once and the result says
   `alreadyTrue`. A reader cannot close the race between "send a prompt" and "wait"; `--next` and `alreadyTrue` are the honest
   substitute. `--appear` (default 30 s) is how long the session row may be missing. `--timeout` is `0` to `7d` (default `30m`; `0` checks
   once). The decision is a pure machine (`createWaitMachine`: `feed`, `tick`, `proof`; no clock, no I/O) so that every sequence is a
   table test. There is no selection by terminal name.
4. **`completed` means the completion check.** `--until completed` is met only when `explainCompletion` answers `completed`. The machine
   asks for that proof when the session looks over and never concludes it from a state: a transcript alone never proves completion.
5. **Exit codes 4, 5 and 6, and the widened envelope.** `met` is 0, `timeout` is 4, `ended` is 5 (the session ended another way and the
   condition can no longer come true: `needs_you` after the session completed, `completed` after it failed, a process that is gone, a row
   that was deleted), `missing` is 6 (no such session after `--appear`). 1 (error), 2 (usage), 3 (the stop guard, never used by a wait)
   and 130 keep their meaning. `CliEnvelope.exitCode` and `cliEnvelopeSchema` accept 4, 5 and 6; for an outcome other than `met` the
   envelope is `ok: false` with `error: null` and the `WaitResult` as `data`, a shape the envelope already allowed. An error still fixes
   its own code (1, 2 or 3), so 4 to 6 never appear with an error. `schemas/cli-envelope.v1.schema.json` is regenerated: a widening of an
   output.

## Consequences
- A consumer that validated `exitCode` against `0..3` must accept `4..6` for `wait`. Other commands do not use them.
- A second wire prefix exists. The guard that pins the frozen `mcs.*` identifiers must list `caw.event/1` as a new identifier, not as a
  rename.
- `--until completed` without hooks, a daemon job or an attempts row ends in a timeout or in 5 for a session that is gone; the result
  carries `completion.outcome: not_terminal` so the command can say why and suggest `--until turn_ended`.
- The agent-side wait of the control group reuses codes 4 and 5 and `parseDuration`.
- The follower (SSE parsing, reconnect with the last id, the re-read after a `reset`, the polling fallback) and the command kernel
  changes are decided with the package that builds them and are added to this ADR then.

## Alternatives rejected
- **`mcs.event/1`.** It would extend a frozen family with a format no old version knows, for a name the program is leaving.
- **Print the server's stream frames as they are.** They carry labels, folders and summaries; a line meant for logs and pipes must not.
- **`completed` from `state: completed` or from a finished turn.** That is the claim the completion check exists to refuse.
- **One exit code 1 for timeout, ended and missing.** A shell could not branch without parsing JSON.
- **Select by terminal name (`--terminal`, a reader route for terminal links).** Dropped after review: it needed a new reader route on the
  app instance; `--session` covers the scripts.

## Evidence
- `runtime/packages/shared/src/cli/watch.ts`, `watch.test.ts` (TC-EVW-03, 05); `runtime/packages/shared/src/wait-machine.ts`,
  `wait-machine.test.ts` (TC-EVW-04, 07); `runtime/packages/shared/src/cli/envelope.ts`, `envelope.test.ts`.
- `schemas/event.v1.schema.json`, `schemas/cli-envelope.v1.schema.json` (generated by `npm run schemas`).
- `runtime/packages/shared/src/api/stream.ts` (change kinds, reset reasons), `api/completion.ts` (the completion outcomes).
- Design `attention-trust`, amendment block A and sections 5.1, 5.3, 5.4 and 10 (working material of the program).
