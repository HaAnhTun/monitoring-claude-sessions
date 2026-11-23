# Watching sessions from a script: `caw events` and `caw wait`

Two commands let a script or an agent react to what Claude Code sessions do without polling. Both only read: they follow the
durable change stream of a running instance (`GET /api/v3/stream`) and ask two open read routes. They never write to a
transcript, never start, stop or signal a process and never touch a terminal (ADR 0079, ADR 0108).

Both act on the app instance by default. `--task SLUG` (with `--repo` or `--root` where needed) selects a task instance.
The instance must be running: there is no stream to follow on a stopped one.

## The rule: wait, never poll

```bash
caw wait --session "$ID" --until completed --timeout 8h
```

- Do not write a loop of `caw status` or `caw sessions show` calls. `caw wait` blocks until the condition holds and says how
  it ended with its exit code.
- **`turn_ended` is not completion.** A transcript that went quiet proves only that a turn ended. `--until completed` is met
  only when observed evidence proves it: a `SessionEnd` hook, a daemon job state or an attempts row (the same check as
  `caw verify-completion`). Without such evidence the wait runs into its timeout and says so.
- A condition that is already true is met at once (`alreadyTrue: true` in the result). Pass `--next` when the script needs
  the condition to become true after the wait began.

## `caw wait`

```
caw wait [--task SLUG] --session ID --until needs_you|turn_ended|completed|failed|ended
         [--timeout DURATION] [--hold SECONDS] [--next] [--appear SECONDS] [--json]
```

| Option         | Meaning                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--session ID` | The full session id (as `caw sessions list --json` shows it).                                                                                                         |
| `--until`      | The condition, see the table below.                                                                                                                                   |
| `--timeout`    | `0` to `7d`, default `30m`. Whole numbers with `s`, `m`, `h` or `d`; no unit means seconds. `0` reads once and does not wait (this also works on a stopped instance). |
| `--hold`       | Seconds the condition must keep holding before it counts. Default 3 for `needs_you` (a prompt that flickers is not a block), 0 otherwise.                             |
| `--next`       | The condition must be seen false first and true afterwards.                                                                                                           |
| `--appear`     | Seconds the session may take to appear (default 30), for a script that starts `claude -p` and waits at once.                                                          |

| `--until`    | Met when                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs_you`  | The session waits for a person (a permission or a question) and has done so for `--hold` seconds.                                                             |
| `turn_ended` | A turn ended (any outcome; the result reports `turnOutcome`) or the session ended. Background work that goes on and a session where nothing ran do not count. |
| `completed`  | The completion check answers `completed`. A transcript alone never does.                                                                                      |
| `failed`     | The session failed, or its last turn ended with an error.                                                                                                     |
| `ended`      | The session is known to have ended.                                                                                                                           |

### Exit codes

| Code | Outcome   | Meaning                                                                                                           |
| ---- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| 0    | `met`     | The condition holds.                                                                                              |
| 1    | error     | The instance is not running, the API failed, the change stream was lost.                                          |
| 2    | usage     | A bad option or value.                                                                                            |
| 4    | `timeout` | The timeout passed and the condition did not hold.                                                                |
| 5    | `ended`   | The session is over (ended, failed, completed, or its process is gone) and the condition can no longer come true. |
| 6    | `missing` | There is no such session, also after `--appear`.                                                                  |
| 130  |           | Ctrl+C.                                                                                                           |

Code 3 is never used by `caw wait` (it is the refusal of `stop` and `restart` while terminals are live).

Text output is one line. With `--json` the output is one `mcs.cli/1` envelope whose `data` is the result:

```json
{
  "outcome": "met",
  "until": "needs_you",
  "sessionId": "...",
  "state": {
    "state": "waiting_input",
    "rule": "S-6a",
    "basis": "observed",
    "confidence": "high",
    "presence": "open",
    "waitReason": "permission",
    "turnOutcome": null,
    "since": "..."
  },
  "attention": { "posture": "needs_you", "reason": "permission" },
  "completion": null,
  "waitedMs": 12400,
  "alreadyTrue": false
}
```

For an outcome other than `met` the envelope is `ok: false` with `error: null`, the data present and `exitCode` 4, 5 or 6.
`completion` is set for `--until completed` once the check was asked: `{ "outcome": "completed" | "failed" | "not_terminal", "ruleId": "..." }`.
After a timeout with `not_terminal` the text output adds a hint: nothing observed proves the end, so wait for `turn_ended`
or install the hooks.

```bash
caw wait --session "$ID" --until needs_you --timeout 2h
case $? in
  0) echo "the session needs a person" ;;
  4) echo "still working after two hours" ;;
  5) echo "the session ended without asking" ;;
  6) echo "no such session" ;;
  *) echo "the wait failed" ;;
esac
```

## `caw events`

```
caw events [--task SLUG] [--follow] [--since SEQ] [--kind session[,agent,tool_call,...]|all] [--json]
```

- No flag: prints the `hello` line and exits 0. Its `headSeq` is a cursor to keep.
- `--since SEQ`: replays the change log after SEQ, prints an `end` line and exits 0. A cursor that the log no longer holds
  (more than 2000 changes behind) gives a `reset` line instead of the replay: read the state again.
- `--follow`: replays from `--since` when given, else starts at the head, and stays until Ctrl+C or until the reader of
  its output goes away (`caw events --follow --json | head -5` ends).
- `--kind`: the kinds of change to print. The default is `session`; the other kinds (`agent`, `workflow`, `tool_call`,
  `event`, `transcript`, `work_item`, `usage`, `alert`, `health`, `attempt`) arrive per tool call and are chatty. `all` prints
  every kind.

With `--json` every line is one `caw.event/1` object (NDJSON; the schema is `schemas/event.v1.schema.json`):

| `type`   | Fields besides `schema`                                       |
| -------- | ------------------------------------------------------------- |
| `hello`  | `instanceId`, `epoch`, `headSeq`, `serverTime`                |
| `change` | `seq`, `at`, `kind`, `op`, `sessionId` (or `null`), `session` |
| `reset`  | `reason`, `headSeq`                                           |
| `end`    | `headSeq`, `count` (the change lines printed by the replay)   |

`session` is `null` except for a session upsert with readable data, where it is
`{ state, rule, basis, confidence, presence, waitReason, turnOutcome, since, attention: { posture, reason } }`.
A line carries ids, states and times only: no label, folder, project name, evidence text or transcript text.
Heartbeats are not printed. An error ends the stream with one `mcs.cli/1` error envelope on one line (a different `schema`
value) and exit code 1.

Without `--json` a line is text for a person, with 8-character ids:

```
2026-11-15T10:03:22Z #8841 session 3f2a9c1e waiting_input S-6a needs_you(permission)
```

## How the follower behaves

- It reconnects by itself after a dropped connection, with the last change it saw, so nothing is lost: the server replays
  what was missed, or says `reset` when it cannot. The pause before a reconnect grows 1, 2, 4, 8 seconds and stays at 8;
  after 8 reconnects in a row without a single frame the command ends with exit code 1.
- A connection that stays silent for 2.5 heartbeats (37.5 s) counts as dropped.
- It talks to `http://127.0.0.1:<port>` only and checks that the answer comes from the instance of the workspace.
- A follower holds one of the 16 stream slots of an instance (browser tabs hold the others). When all are taken,
  `caw events` ends with `API_ERROR` and the hint to close a monitor tab or another follower; `caw wait` goes on without a
  stream and reads the session every 3 seconds instead.
- `caw wait` reads the session first and follows the stream from the position of that read, so a change between the read
  and the subscription is not lost.
