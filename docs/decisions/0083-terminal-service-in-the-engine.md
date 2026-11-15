# 0083 Terminal service in the engine: PtyBackend seam, Windows-only support, replay, orphan safety

Status: Accepted (CAW, 2026-11-15). Owner: pty area, work package TERM-SERVICE (design 01, sections 3.9 to 3.12, 4, 5, 7 and 9). Amends 0051 (the
long-lived interactive child is spawned only through the `PtyBackend` seam, and the short-lived ones still only through `exec.ts`). The Status line of
0051 is updated by the documentation package of the program. Related: 0079 (the stance change itself: the monitor stays read-only, the terminal is
not), 0080 (the addon), 0082 (the native files in the bundle).

## Context

0079 lets the application start, write to and kill the `claude` processes that it started itself. 0051 knew two kinds of child: the short-lived
helper that runs through `execFileText` (`git`, `taskkill`, PowerShell one-shots) and the long-lived detached or foreground process of
`spawnDetached` and `spawnForeground`. A terminal session is neither. It is an interactive child that needs a pseudo console, lives for hours inside
the server process, and is read and written by several browsers. On Windows that is ConPTY, reached through the addon of 0080.

The design needs a place for the rules that belong to such a child and to nothing else: what the child sees, how its output is kept for a browser that
reconnects, what happens to it when the host dies, and what the application says on a host that cannot run it at all.

## Decision

1. **The seam.** `PtyBackend.spawn(cmd, args, cwd, cols, rows, env): Pty` is the one way to start an interactive child. `Pty` is platform-neutral
   (`started`, `onData` with `Buffer`, `onExit`, `write`, `resize`, `kill`; none of them throws). The terminal service holds a backend and never names
   the addon. Three backends implement it: `NodePtyBackend` (the adapter of the addon), `UnsupportedBackend` (it says why and its `spawn` throws the
   matching error) and `FakePtyBackend` (a script, exported as `@mcs/engine/testing`, never reached from a production file). 0051 stays as it is for
   everything short-lived. The rule in one sentence: a child with a pseudo console starts through `PtyBackend`, any other child through
   `platform/exec.ts`, and no file outside those two calls `child_process`. `terminal/boundary.test.ts` reads the source for it: the loader is the only
   file that loads the addon, the adapter is the only caller of its `spawn`, the service starts children only through `backend.spawn`, nothing outside
   `terminal/` imports the loader, the adapter or a platform package, and the scripted pty reaches no production file. The ESLint rule of 0082 bans the
   import itself.
2. **Windows only, with a platform-neutral interface.** The terminal is supported on Windows x64 and arm64 from build 17763 (Windows 10 1809, the first
   with ConPTY). Every other host gets `UnsupportedBackend` with a reason: `unsupported-os` (no shipped target, also an architecture such as ia32),
   `os-too-old`, `native-missing` (the bundle has no `native/<target>` folder, the package is not installed) or `native-load-failed`. The service then
   reports `supported: false` and the reason, `create` rejects with `UNSUPPORTED_OS`, `NATIVE_MISSING` or `NATIVE_LOAD_FAILED` before it looks at the folder, and
   the UI says "not supported on this OS". The monitoring part works everywhere. The POSIX branches already exist where the rules differ (argv array,
   byte data, absolute paths only, case rules) and are unit-tested with an injected platform. Linux and macOS later mean: more entries in
   `SHIPPED_TARGETS` and `native-pins.json`, the execute bit of the helper, a process-group kill in `forceKillTree`, start times from `/proc`, the
   registry enabled, the real-terminal tests un-gated. `Pty`, `Session` and the service do not change.
3. **The inbox ConPTY is the default.** `terminal.conptyDll` is `false`: node-pty uses the console host of Windows. The shipped `conpty.dll` and
   `OpenConsole.exe` (owner decision of 0080) stay selectable. The reason is the DA1 measurement below: OpenConsole 1.25 asks the terminal who it is
   and the child does not run until somebody answers. A session that is created through the API before any browser is attached has nobody to answer.
4. **The replay buffer is RAM only.** One buffer per session, 1 MiB by default (`terminal.replayBytes`, 64 KiB to 16 MiB), never written to a file
   or to the database. It drops whole oldest chunks (node-pty chunks are at most 8.3 KB, so the buffer stays within one chunk of its capacity). At
   every attach the snapshot is prepared: after a trim it restarts after the first line feed within the first 4 KB and gets an SGR reset in front, and
   **terminal queries are stripped** (DA1, DA2, DA3, DSR, DECRQM, the kitty keyboard query, XTVERSION, window reports, OSC colour queries, DECRQSS). A
   freshly attached xterm.js would answer an old query, and the answer (`ESC [ ? 1 ; 2 c`, `ESC [ 1 ; 1 R`) would arrive in the prompt of `claude` as
   typed text. The live stream is never filtered: its queries must reach the real terminal. The filter is one pass over the bytes, no regular
   expression, so a megabyte of hostile escape sequences costs a bounded time. Output reaches the viewers in attach order and the replay goes out in
   frames of at most 64 KiB; a viewer whose send throws, or that has more than 4 MiB queued, is evicted (`slow` or `error`) and the pty is never paused
   for it, because that would freeze the others (node-pty has no real flow control on Windows).
5. **The environment of the child.** The environment of the server, minus `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_SESSION_ID`, `NO_COLOR`, `FORCE_COLOR` and
   `MCS_HOOK_DISABLE` (unless named in `terminal.envKeep`), then `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=CAW` and
   `NoDefaultCurrentDirectoryInExePath=1` (cmd.exe then does not look in the project folder first when a `.cmd` shim calls a bare `node`). Names are
   compared without regard to case on Windows and the first spelling of a name wins, because node-pty builds the block from the keys. A session is a user
   session that the hooks must see, so the hook switch is stripped.
6. **The program and the cmd.exe route.** `claude` is found the way Python `shutil.which` does it (what MTOP used): the PATH of the server times PATHEXT,
   the first existing **file** wins, an extensionless file is never taken (on a machine with the npm shim `claude` is an `sh` script next to
   `claude.cmd`), relative PATH entries and relative command paths are ignored. `.exe` and `.com` run directly with an argv array. `.cmd` and `.bat` run as
   the string `cmd.exe /d /s /c ""<shim>" <args>"` (the array form fails: node-pty wraps the first element in escaped quotes and cmd answers "not
   recognized"). cmd.exe expands `%VAR%` and `!VAR!` even inside quotes, so on that route every argument must pass an allow-list (letters and digits of
   any script, space and `_ . , : = @ + / \ -`) and the shim path may hold no `%`, quote or control character; otherwise `ARGS_UNSAFE` or
   `COMMAND_UNSUPPORTED`, with the escape hatch of pointing `terminal.command` at the real `claude.exe`. A resume id must look like a session id. The root pid
   on the shim route is `cmd.exe`; `claudePids(name)` returns it with its descendants (the registry file and `CLAUDE_PID` of 0019 carry the `claude.exe`
   pid), cached for 5 s.
7. **Names are not reused.** A session is `<folder name>-<n>`, matching `^[A-Za-z0-9_-]{1,64}$`; `n` counts up per folder name for the life of the service.
   MTOP reused the lowest free number. Here a stale browser tab that holds `proj-1` can never reach a different `proj-1`. A start that fails burns a number.
8. **Limits.** `terminal.maxSessions` (default 8) counts starting plus live sessions, and the count is taken in the synchronous part of `create`, together
   with the name, so two creates that race can neither overshoot it nor share a name. `terminal.maxInputBytes` (256 KiB) bounds one write,
   `terminal.startTimeoutMs` (10 s) the wait for the first output, `terminal.killTimeoutMs` (3 s) the wait for an exit after a kill before the tree
   kill. Fixed in code: the default size 120 x 30, clamps 20 to 500 columns and 5 to 200 rows, a 60 ms trailing debounce of a resize (the inbox conhost repaints
   the whole screen on every resize, so a window drag would fill the replay with repaints), a 5 s liveness probe, working folders of at most 240
   characters.
9. **Ending, and what is left over.**
   - `kill` asks the process to end, waits `killTimeoutMs`, sends the tree kill (`taskkill /T /F`), waits 2 s more, and then declares the session `lost`.
     A lost process stays counted by `liveCount()` until its pid is gone, and keeps its registry entry, so that `stop` still refuses and a later start can
     sweep it. A lost session does not take a slot of `terminal.maxSessions`.
   - `liveCount()` counts starting, live and lost sessions. `beginDrain()` makes `create` reject with `SHUTTING_DOWN`, and a create that is still starting
     is refused as soon as its child has started (the child is killed); the server calls it in the same tick as the decision to stop, never on a
     refusal. `shutdown()` does the same, aborts the wait of a create that is still starting, ends every session as
     `shutdown`, waits at most `killTimeoutMs` plus 3 s, removes the registry file and stops the timers. `emergencyKillSync()` is for `process.on('exit')`:
     it only kills root pids synchronously, because nothing can be spawned there (`pty.kill()` forks a helper).
   - The liveness watchdog runs only while a session or a lost process exists. Two consecutive probes that find a root pid gone, without an exit event,
     end the session through its own kill path. That pid may have been reused by then, so for such a session the tree kill is skipped, a process
     that answers for the pid afterwards is not taken for a lost child (the session is not counted and its registry entry is removed),
     `emergencyKillSync()` does not signal it and `claudePids()` lists nothing.
   - **Orphan sweep.** Each owner process writes one file `<mcsHome>/terminals/<ownerPid>-<ownerStartedAtMs>.json` with the roots it started, so no two
     processes write the same file. `sweepOrphans()` runs once at start. For every other file: a damaged or oversized one is deleted; an owner that is alive
     and whose creation time is within 5 s of the recorded one keeps its file; of the children of a dead owner, one that is alive is ended with the tree
     kill only when its creation time is within [recorded spawn - 10 s, recorded spawn + 2 s] (a reused pid has a later creation time and is left alone).
     The normal case, with no stale file or only dead pids, spawns no process. The result is logged as counts.
   - The evidence for keeping the sweep cheap: a host that is hard-killed (`taskkill /F`) takes the ConPTY root, its grandchild and the console host down
     within 3 s, in the inbox and in the dll mode (probes at 3 s and at 10 s). What can leak is a detached descendant, and, later, any child on a POSIX
     host where children outlive a dead master. The registry and the sweep are defence in depth.
10. **Logging.** Only the closed field list of the logger is used (`pid`, `code`, `count`, `phase`, `durationMs`). The events are `terminal.native`,
    `terminal.started`, `terminal.exited`, `terminal.kill`, `terminal.spawn_failed`, `terminal.sweep`, `terminal.viewer_evicted` and
    `terminal.listener_failed`. A session name, a folder, an argument, an environment value, terminal output, the home folder and the message of a native
    error are never fields. `TerminalError` messages are fixed sentences, and the text of a native error is dropped at the first catch, because it holds
    file paths. A test runs the service with a real logger over canary strings and scans the log file.
11. **Wiring and diagnosis.** `createDefaultTerminalService({ config, logger, clock?, mcsHome?, backend?, ... })` builds the service of a user instance:
    the backend of the host, the real file system and environment, `forceKillTree`, `process.kill`, `pidAlive`, `listDescendantPids` and the registry under
    `resolveMcsHome(env)` (no registry, and no need for a home folder, when the backend is unsupported). `diagnoseTerminal(deps)` gives `check` and
    `doctor` the facts (supported and why not, where the addon came from, `claude` found and its kind, the ConPTY files next to the addon, the Windows
    build). It loads the addon the way the backend does and looks at paths; it starts nothing.

## Evidence (measured on Windows 11 10.0.26200, Node 24.14.1, `@lydell/node-pty` 1.2.0-beta.18, claude 2.1.289; design 01 sections 1.2, 3.8, 5)

- **DA1 and OpenConsole.** With `useConptyDll: true` (OpenConsole 1.25) the first output is `ESC [ 1 t` and `ESC [ c ESC [ ? 1004 h ESC [ ? 9001 h`, a DA1
  query. Until something answers it the child does not run before about 3.1 s (its banner and the keystrokes typed meanwhile arrive together, and a
  resize sent at 1.2 s was already in effect when it started). With a DA1 reply written back, the same program prints after 100 ms. The natural exit event
  comes 60 ms after the last output instead of 1.0 s, and `kill()` takes 1.9 s to report the exit instead of 80 ms. With no viewer attached nobody
  answers, which is why the inbox console host is the default.
- **Resize.** The inbox conhost re-emits the whole screen on every resize (the banner repeated plus blank lines), so a resize to the size the process
  already has is dropped and the rest is debounced.
- **Program resolution.** `spawn('claude')` finds the extensionless `sh` script and the child ends with exit code 2 after 42 ms, silently;
  `spawn('claude.cmd')` works but with MSVCRT quoting, the unsafe form for a batch file. The `.cmd` route works with the real shim of the machine
  (`claude --version` in 1.12 s including the one-second flush) and with a shim in a path with a space.
- **Host crash.** `taskkill /F` of the Node host removes the root, a grandchild and the conhost within 3 s (3 s and 10 s probes, both modes).
- **Pids.** `spawn()` returns with pid 0; the pid is valid by the first data event (8 of 8 runs). A missing program throws synchronously with a message that
  holds its path, a bad folder gives an exit event with code 267 and no output, which is why `started` waits for the first output and why no native
  message is kept.
- The unit tests of this decision: `manager.test.ts` (concurrent creates, every error code, failure paths, kill, `killAll`, `beginDrain`, `shutdown`,
  `liveCount`, the watchdog, `emergencyKillSync`, change events, `claudePids`, the sweep, the log), `default.test.ts`, `diagnose.test.ts` and
  `boundary.test.ts`. The real ConPTY suites come with their own packages.

## Consequences

- One place knows how a terminal child starts, ends and is cleaned up, and the platform-specific part is one file that a test can replace.
- The service answers `lost` instead of hanging when a process cannot be ended, at the price of a counted process that the user cannot see; `stop`
  refuses while it lives, `--force` ends the server (and with it the ConPTY children, measured).
- Names grow for the life of the process: a long run that starts and ends many sessions of one folder reaches `proj-100`. They are never reused.
- A replay buffer of 1 MiB per session is held in the memory of the server for up to `terminal.maxSessions` sessions, 8 MiB by default.
- Exit events arrive about 1 s after the last output in inbox mode (the node-pty flush interval); the UI must not show "running" for a session whose viewer
  already received the end frame.
- The terminal needs Windows 10 1809 or newer, and the arm64 binaries are Microsoft's but are never executed by the suite (no ARM64 machine).

## Alternatives rejected

- Starting the child through `spawnForeground` of `exec.ts`: it has no pseudo console, so no resize, no colours and no line editing of `claude`.
- A bridge process in C# or PowerShell that owns the console: ruled out by the owner (0080).
- Keeping the replay on disk or in the database: terminal output is the one thing the application never persists (0022 keeps the database metadata only).
- Reusing the lowest free session number as MTOP did: a stale tab could attach to another session.
- Filtering the live stream as well as the replay: the real terminal must see the queries of `claude`.
- Ending a session that the watchdog found dead with the tree kill: the pid may belong to another program by then.
- Spawning a process listing at every start to prove the identity of the children: the normal case would pay for a PowerShell run it does not need.
