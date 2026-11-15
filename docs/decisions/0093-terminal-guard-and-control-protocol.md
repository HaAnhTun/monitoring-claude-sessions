# 0093 Terminal guard and control protocol extension: the server decides, `signal` is never refused

Status: Accepted (CAW, 2026-11-15). Owner: lifecycle area (lif), work package CAW-22. Extends 0005 (the control channel) by two operations, one flag and two error codes; relies on
0006 (process identity) and 0091 (the user instance) and does not change them. Related: 0079 (the stance), 0085 (the access ticket), 0094 (the control op that mints the code).

## Context
Terminal sessions live inside the user instance and die when it stops (spec decision Q11). `caw stop`, `caw restart` and an update that restarts must therefore not end them by accident:
a person with three `claude` sessions open who runs `caw restart` loses all three. The guard has to work for a CLI that asks first (to print a good message), for a CLI that does not
(an older one, a script), and for the moments in between: a session can start between the count that the CLI read and the stop that it then sends.

The control channel (0005) is the one lifecycle path: a named pipe, one JSON line each way, the instance id and the 256-bit token of `run/control.token`, a browser cannot reach it.
Its identity probe `identify` carries no secret and must stay that way.

## Decision
1. **The protocol (still v1, still one line each way, still at most 4096 bytes a request) gains two operations, one flag and two error codes.**
   `terminals` asks for the census and `access` mints the access code (0094); both need the instance id and the token. `shutdown` takes an optional `force`, present only when it is
   exactly `true` (`force: false` is not a request). The new error codes are `TERMINALS_LIVE` (a `shutdown` refused because terminals are live) and `UNSUPPORTED` (`access` asked of an
   instance that has no access service). The reply of `terminals` is `{live, max, sessions}`: `live` counts every session that has or may still get a process (starting, live and
   lost; amendment A4), `max` is `terminal.maxSessions`, and `sessions` lists at most 50 entries, oldest first, each with its name and its start time and nothing else. `identify` still
   carries no secret and no terminal data.
2. **The server decides, atomically.** `onShutdown(reason, { force })` is answered by one rule (`decideShutdown`, `engine/src/runtime/user-services.ts`): a `shutdown` of a user instance
   is refused with `TERMINALS_LIVE` when the census counts a session, the reason is not `signal` and the request does not force. The count is read once, in the same call that
   triggers the stop, so the CLI's earlier count can only produce a better message, never a different outcome. The decision reads `count()` and never the length of the list, which
   is shorter while a session is starting or lost. Only exactly zero means "no terminals": a count that is not a number refuses.
3. **The drain starts on the allow decision and on nothing else.** When the rule allows the shutdown it calls `census.beginDrain()` in that same call, and the shutdown gate is asked right
   after, in the same tick: from then on the terminal service refuses a new session, so none can start between the decision and the stop. A refusal never starts the drain. A
   `beginDrain` that throws does not stop the shutdown (the phase is `stopping` as soon as the gate has the request, and the terminal service refuses new sessions outside `ready`
   anyway); the failure is logged by event name and phase only.
4. **What is never guarded.** The reason `signal` (Ctrl+C of `caw serve`, SIGTERM, logoff): the process dies anyway, and refusing it would hang a logoff. A task instance: it has no
   terminal, and its census is the empty one. A request that arrives while the instance is already stopping: there is nothing left to protect, and no second drain is started.
   The guard protects a person from an accident; it is not a barrier against a process that holds the control token, which has the same trust as the person (0084).
5. **Phases.** `terminals` is answered in every phase and needs the token in all of them, but the census is asked only while the phase is `ready`: while `starting` no terminal can exist
   yet, and while `stopping` they are going down, so both answer the empty census. `access` needs the phase `ready`. `shutdown` is decided in every phase.
6. **Optional services.** The channel takes the census and the minter as optional callbacks. Without them it answers an empty census and `UNSUPPORTED`, which is exactly what a task
   instance reports, so the task boot is unchanged. A callback that throws is answered `INTERNAL` with no message; the log carries the failing code only.
7. **Kind-aware boot.** The kind of `instance.json` is read at step 2 of the boot, before the configuration. A `kind: "user"` workspace anywhere but the reserved user root exits 17
   `WORKSPACE_INVALID` (0091 item 5), so a hand-edited task cannot become a terminal host. Only a user instance wires the census and the minter into the channel; the services themselves
   come from `RuntimeFactories.createUserServices`, called only for a user instance, whose components start after the alert components and stop before them (`InstanceRuntime.user`
   is `null` for a task instance). The census and the minter are bound late, when the request arrives, so a request before the runtime exists sees the empty ones.
8. **The CLI half (built by the lifecycle operations package).** `stop`, `restart` and `upgrade --restart` ask `terminals` first and refuse with exit 3 and a message that names the
   sessions on the person's own terminal; an instance that does not answer counts as "cannot tell" and is refused without `--force`; `--force` sends `force: true`. A refusal that
   arrives after a clean count (a session appeared meanwhile) is reported the same way. A forced kill of a hung user instance kills the process tree (`taskkill /T`), after the
   marker check of 0006, because the pseudo-console hosts and the `claude` processes are descendants of the server.
9. **Skew.** A new CLI never sends `terminals` to an instance whose `instance.json` says `task`; an older server answers `BAD_REQUEST` to it, which counts as "no terminals". An old CLI
   that sends `shutdown` without `force` to a new user instance is refused while terminals are live, which is the safe direction.
10. **Orphans.** The registry of the processes a crashed server left behind is the terminal service's own folder `<MCS_HOME>/terminals/`; the design's earlier `run/terminals.json` is dropped.

## Consequences
- `caw stop` can no longer end sessions by accident, and a plain `shutdown` over the pipe cannot either; `--force` is the one explicit way, and it is visible in the request.
- A lost or starting session blocks a stop although the list does not show it. That is intended: the process may still run, and the message says how many.
- Nothing about a session crosses the channel except its name and start time, and neither is ever logged: the events are `control_request` and `control_refused` with a route and a status.
- The decision and the drain are one function that two packages test and a third (the terminal host) feeds, so the rule has a single home.

## Alternatives rejected
- **The CLI decides, the server obeys:** the count and the stop are two requests, and a session can start between them.
- **Refusing `signal` too:** a logoff or a terminal closing would hang or leave a half-stopped server; the process dies anyway.
- **A separate "drain" request before the stop:** a second round trip that a crashed CLI would leave half done; the drain belongs to the allow decision.
- **Listing sessions with their folders or state in the reply:** the CLI needs a name to show and a count to decide; everything else is a path or a project name that the channel never needs to carry.
- **A guard in the terminal service itself:** the service does not know the reason of the stop, and `signal` must pass.

## Evidence
- `engine/src/runtime/user-services.test.ts`: the decision matrix (live, starting and lost sessions refuse; ended sessions do not; force, `signal`, a task and an already stopping instance are
  never guarded), the drain once on every allow and never on a refusal, a count that is not a number, a drain that throws.
- `server/src/control-channel.test.ts`: `force` reaches the decision as `false` when absent and `true` when present; `TERMINALS_LIVE` is a refusal, not a stop; the guard matrix over every
  reason with and without force; no decision for a wrong token, another instance or a malformed `force`; `terminals` and `access` in every phase; the cap of 50; the logs carry the route and
  the status only.
- `server/src/boot.test.ts`: the location refusal (exit 17, no path in the message, exit 10 without a home), the late-bound census and minter, `terminalsOutcome` reads the count,
  `answerShutdown` starts the drain before the trigger in the same tick and never on a refusal.
- `engine/src/runtime/instance-runtime.test.ts`: `ctx.kind`, no factory call and `user: null` for a task, the component order and the stop order of a user instance, the stub warning.
- `server/test/control.int.test.ts` and `boot.int.test.ts` pass unchanged: a task instance behaves as before.
