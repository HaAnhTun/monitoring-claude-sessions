# 0136 Open a session in the native terminal

Status: Accepted (CAW, 2026-11-20). Owner: terminal host (CAW-145, design 09). Extends 0079 (the terminal starts, writes to and kills only the processes the application started): this feature starts
one more kind of process, a window of the person's own terminal running claude, and keeps NO control of it afterwards. Relies on 0084 (route guards), 0090 (resume decision), 0093, 0099.

## Context

The in-app terminal is xterm.js; the owner wants the real Windows Terminal (fonts, keys, selection, settings) for a monitored session, in its folder.

## Decision

1. `POST /api/v3/terminal/open-native` (user instance, session access, CSRF and Origin guards), body `{ sessionId, fork? }` (the resume body, strict: a path, command or arguments field is a 400), answer `{ via, fork }`
   with `via` one of `windows-terminal` and `console`; `capabilities.nativeOpen` (optional, true on Windows when the terminal is available). The errors are the existing codes of the resume route.
2. The engine decides: `planResume` (the same refusals as the in-app resume: a session held by an in-app terminal is refused, one held elsewhere only as a copy), the folder from the plan and never from the request;
   claude from `terminal.command` on the server PATH with the validation of `buildLaunch`; argument arrays only, no shell string.
3. Windows Terminal (`wt.exe`, found with `lstat` because the Store alias cannot be `stat`ed) as `new-tab -d <folder> -- <program> <args>`, else a visible `cmd.exe` console; for a `.cmd` shim the program is the absolute
   `cmd.exe` with `/d /k <shim> <args>` so a failure stays readable. Detached, `unref`, no stdio, no pid kept. A folder with `;` is refused on the Windows Terminal route (it is a command separator there).
4. Environment: the strip of the terminal (`CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_SESSION_ID`, `MCS_HOOK_DISABLE`, minus `terminal.envKeep`) but not `NO_COLOR` and `FORCE_COLOR`, and no `TERM`, `COLORTERM` or `TERM_PROGRAM`
   (the person's terminal sets its own); the person's PATH and the rest are kept; `NoDefaultCurrentDirectoryInExePath=1` like the terminal. `buildNativeEnv` shares one loop with `buildTerminalEnv`.
5. Logs: `terminal.native_open` with the way and the copy flag only, written with the `kind` and `phase` fields of the closed field list of the logger (`kind` is the way, `phase` is `resume` or `fork`; `via` and `fork`
   are not names of that list and would be dropped); a failed start logs a code word. Never an id, a folder or a program path. Rate: one at a time, 1.5 s apart, 12 per rolling minute (`terminal_limit`).
6. No CLI command, no macOS or Linux emulator in this version.

## Evidence

Probe N1 (2026-11-20, Windows 11 10.0.26200, Windows Terminal 1.25.3131.0, `claude` is the npm shim `claude.cmd`, throw-away folder and invented session ids; the real function `createRealNativeTerminal`, one window per route,
closed by the executor):

- Windows Terminal route: capabilities `{ available: true, via: windows-terminal }`. The command line seen by the system was `wt.exe new-tab -d <folder> -- C:\WINDOWS\System32\cmd.exe /d /k <npm>\claude.CMD --resume <id>`;
  `--` is accepted by Windows Terminal 1.25 (the program ran with `--resume` as its first argument), the tab opened in the folder (claude's "Accessing workspace" line named it) and `cmd.exe` stayed under it.
- Console route (the `WindowsApps` folder removed from the PATH and `LOCALAPPDATA` unset): `via: console`; `cmd.exe /d /k <shim> --resume <id>` ran in its own console window with claude under it.
- `wt.exe` is the Store app execution alias: `statSync` fails with `EACCES`, `lstatSync` succeeds with a link, so the lookup is an `lstat` (`realNativeFs.hasEntry`).
- The log line was `terminal.native_open {"kind":"windows-terminal","phase":"resume"}`, nothing else.

## Consequences

Two writers on one transcript remain possible only if the person starts them by hand; a native window the app opened shows later as `live_elsewhere`. The Windows Terminal argv is one constant (`WT_PREFIX`, `WT_SEPARATOR`) if
Windows Terminal changes its parser. The semicolon rule sends no folder with `;` to Windows Terminal: that person uses the in-app terminal for such a folder. A shim path that `cmd.exe` would read (a parenthesis, an
ampersand) is refused with `ARGS_UNSAFE`, as in the in-app terminal.
