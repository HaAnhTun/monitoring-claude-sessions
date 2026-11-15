# 0095 Browser launch, autostart and the batch files: `open`, `autostart`, `config get|set`, `start.bat`, `stop.bat`, `install-skill.bat`

Status: Accepted (CAW, 2026-11-15). Owner: lifecycle area (lif), work package CAW-34. Builds on 0091 (the user instance and `platform/browser.ts`), 0092 (the scope rule),
0093 (the terminal guard, exit code 3) and 0094 (the access code). Related: 0062 (the self-contained skill folder and its launcher), 0061 (the root installer `install.mjs`).

## Context
The app has to be reachable by a person who does not live in a terminal: a double click starts it and shows it, a second one stops it, a third installs the skill. The engine already
holds the pieces (0091: the browser module, the autostart operations, the guarded stop); what was missing is the part the person touches: three commands, the settings a person changes by
name, and three files at the root of the repository. All of it runs on one Windows user's machine, with the person's own Node and no installer.

## Decision
1. **Three commands that act on the app only.** `open`, `autostart enable|disable|status` and `config get|set` are marked `userOnly` in the command table. They have no `task` option (so `--task`
   is an unknown option) and the kernel refuses `--repo` and `--root`, which would select a task; a quiet fallback to a task would be a guess. Nothing in them is new engine behavior: they
   map options to `opsApp.openUser`, `enableAutostart`/`disableAutostart`/`autostartStatus` and `opsConfig.configure`/`inspect`, and render the result.
2. **Opening the browser.** `open` starts the app when it does not run (`--no-start` makes that an `INSTANCE_NOT_RUNNING`), mints a code over the control channel (0094) and opens the login URL
   as a tab of the default browser (`explorer.exe`, whose exit code 1 is success) or, with `--window` or `app.openAppWindow`, as an Edge or Chrome app window with a profile of its own
   (0091 item 6). The URL must match `LOGIN_URL_RE` before any program sees it. `--print` shows the URL instead of opening it. The URL is in the `--json` data only with `--print`; when
   no browser could be opened it is shown as one line of text (the code was never used) and is in neither the data nor a warning.
3. **Autostart is a shortcut, made by Windows PowerShell 5.1 through `WScript.Shell`, with constant scripts.** The Startup folder holds `Claude Agent Workspace.lnk`, which runs
   `node "<launcher>" start --no-open` minimized: no browser and no login code at sign-in, so the person runs `caw open` or `start.bat` when they want the page. The paths, the arguments and the
   description travel in `CAW_LNK_*` variables of the one child process, never in the script text. `enable` names the launcher of the call and `process.execPath` as the target. Healing
   (`startUser` rewrites a shortcut of this install whose Node or launcher moved) never retargets a shortcut that points at another launcher (a checkout, a worktree, a QA stack): that is a
   `foreign-target`, a warning, and the person decides with `caw autostart enable`. Off Windows `status` and `disable` answer exit 0 and `enable` fails with `UNSUPPORTED_PLATFORM`.
4. **`config get|set` knows seven keys.** `terminal.command`, `terminal.args`, `terminal.maxSessions`, `app.name`, `app.openAppWindow`, `server.port` and `server.portScan`; every other key goes through
   `caw configure --user`. `set` is `opsConfig.configure` for the task `user` with the reason `caw config set`: the value is JSON, or the raw text when it is not JSON (so
   `caw config set terminal.command claude` needs no quotes in `cmd.exe` or PowerShell), the whole result is validated by `RuntimeOverridesSchema` before anything is written, the write is atomic
   and audited, and a running app keeps the old value until `caw restart` (the command says so). `get` shows the effective value and its source (`default`, `skill`, `runtime`, `env`, `cli`) from the
   same projection as `inspect`. Both make the workspace of the app on first use: the usual way out of a failed `app.claude` check is `caw config set terminal.command <path>`, and it must work before the
   first start. A refusal names the keys and never repeats the value.
5. **Three batch files at the repository root, in CRLF.** `.gitattributes` gives `*.bat` and `*.cmd` `text eol=crlf` after the catch-all `* text=auto eol=lf`: a batch file with LF-only endings can
   fail to find a `goto` label. They are ASCII, they contain no parenthesized block (`%ERRORLEVEL%` is expanded when a block is parsed, so the files use labels), and the find-node block is
   identical in all three: `CAW_NODE_PATH`, then `where node.exe`, then `%ProgramFiles%`, `%LOCALAPPDATA%\Programs` and `%ProgramFiles(x86)%`. `start.bat` and `stop.bat` find the launcher with the wildcard
   `skills\*\scripts\caw.mjs`, so renaming the skill folder needs no edit. `CAW_NO_PROMPT` removes every pause and question (scripts and tests).
6. **`stop.bat` asks only when the app says terminals are live.** `caw stop` exits 3 (`TERMINALS_LIVE`, 0093); `stop.bat` then asks `Stop anyway and end them? [Y/N]` and runs `stop --force` on a yes. With
   `CAW_NO_PROMPT` it exits 3 and the app keeps running. A question that cannot be read (no console) counts as a no.
7. **`install-skill.bat` runs `node install.mjs --force`** (0061: it replaces only an install the script made, and keeps the old folder until the new launcher passed its self-check). It prints "stop the app first (caw
   stop; terminals end)" when `<MCS_HOME or %LOCALAPPDATA%\mcs>\instances\user\state.json` exists: a running app maps its terminal files, so the old folder cannot be deleted. For a plain call and when a
   person is there it offers to write `%LOCALAPPDATA%\Microsoft\WindowsApps\caw.cmd`, one CRLF line `@"<node>" "<installed launcher>" %*`, so `caw` works in any terminal. That folder is on the user's PATH
   already: nothing edits the PATH, the registry or `setx`.
8. **No exe, no C#, no Python, no download.** A test refuses each of them, a program file other than `node.exe`, PowerShell and any address other than the Node download page, in the three files.

## Consequences
- After a restart or a logon the old link is dead (0094): the person runs `start.bat` or `caw open` for a new one.
- `start.bat` shows a console for about a second, because the CLI waits for the health check; a failure pauses unless `CAW_NO_PROMPT` is set.
- The batch files read `MCS_HOME` the way the runtime does and the default `%LOCALAPPDATA%\mcs`; the work package that renames the variables updates `install-skill.bat` with it.
- A caw.cmd written by an earlier install is overwritten on a yes, never read.
- `config get` can create the folder of the app: a read with a side effect, accepted so that a person can look at and change the settings before the first start.

## Alternatives rejected
- **A compiled launcher (an exe) or a script host:** nothing to build or sign, and the spec has no C#. A batch file and the Node the person already has are enough.
- **`caw.cmd` next to `start.bat` in the checkout:** it would stop working when the checkout moves; the installed skill is the product.
- **Editing the PATH from `install-skill.bat`:** a persistent change of the person's environment for a convenience; WindowsApps is already on the PATH.
- **Parenthesized `if` blocks with `%ERRORLEVEL%`:** the value is read when the block is parsed, so `stop.bat` could not tell exit code 3 from 1.
- **A silent task fallback for `open --repo X`:** the person would get a command that did not do what they typed.
- **An autostart that opens the browser:** a login code minted at logon with nobody there, in a page nobody asked for.

## Evidence
- `cli/src/commands/open.test.ts`: the option table and the mapping, the login in the data only with `--print`, the fallback line and its absence from the data and the warnings, the errors passed unchanged.
- `cli/src/commands/autostart.test.ts`: the three commands and their text (06 2.7), the note as a warning, the node and launcher passed to `enable`, the refusal off Windows.
- `cli/src/commands/config-user.test.ts`: the seven keys, the value and source of each, `configure` called for the task `user` with the reason, the JSON-or-text value passed as typed, `restart needed`, a refusal
  before anything is touched, no value in a message.
- `cli/src/main.test.ts`: `userOnly` refuses `--repo` and `--root` and has no `--task`; the six names are registered and found by their words.
- `tests/tooling/bat-files.test.ts`: CRLF, ASCII, the attribute rule, identical blocks, the wildcard resolving a real `caw.mjs`, labels, no block, every pause behind `CAW_NO_PROMPT`, the forbidden words, the documented
  variables; and on Windows each file run in a copy next to a fake launcher: arguments passed on, exit codes, the `Y` and `N` answers of `stop.bat`, the state.json warning and the exact bytes of `caw.cmd`.
- `cli/test/bat-files.int.test.ts` (Windows): `start.bat --no-open` on a real instance and a health answer, `stop.bat`, a second start, nothing to stop, and with two scripted terminals `stop.bat` exits 3 and the
  instance keeps running until `--force`.
