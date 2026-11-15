# 0091 The user instance is a workspace of kind user

Status: Accepted (CAW, 2026-11-14). Owner: lifecycle area (lif), work package CAW-21. Amends 0001 (the workspace files) by one optional key of `instance.json`; relies on 0004
(detached start), 0005 (control channel) and 0006 (process identity) without changing them. Browser launch and autostart (the last section) are part of this decision because they
exist only for the user instance.

## Context
The terminal part of the product (0079) needs one instance per Windows user: it holds every terminal session, survives the closing of a browser tab and is the instance `caw start`
starts and `caw stop` stops. Until now every instance was a monitored task, a workspace below `<repo>/.claude/monitor/tasks/<slug>/` with its database, audit trail, logs, control
channel and upgrade path. A second kind of home ("an app folder") would copy all of that or leave the new instance without `backup`, `upgrade`, `doctor`, `diagnostics`, `db migrate`,
the audit trail and the identity repair. It also has to be clear, from a file the person cannot flip by editing a configuration, which instance may start terminals.

## Decision
1. **The user instance is an ordinary workspace.** Same files (`task.json`, `config.json`, `runtime.json`, `instance.json`, `state.json`, `audit/`, `data/`, `logs/`, `run/`), same
   process model, same control channel and identity rules. Only what the server boots differs by kind (later packages).
2. **Place.** The slug is `user`. The workspace is `<MCS_HOME>/instances/user/`, in the reserved tasks root `<MCS_HOME>/instances/`, which never lists a task of a repository. The
   per-user folder keeps its default name `mcs`; the environment variable that relocates it still does. Nothing moves and nothing migrates. `engine/src/user-instance/paths.ts` is the
   only module that names these folders (`userRootOf`, `userInstanceDirOf`, `userBrowserProfileDirOf`); `isUserRoot` compares canonical places with the case rule of the host, so a
   junction to the root is the root.
3. **Identity: `kind` in `instance.json`.** An optional key after `engine`, written only for `user`; an absent key means `task`, so the file of a task stays byte-identical to what
   0001 wrote. It lives in the identity file and not in `config.json` because it decides whether a process may start terminals: one line of a hand-edited configuration must not
   change it. `initWorkspace` and `adoptWorkspace` take `kind`; `instances repair` already keeps every field of the old file, so a repaired user instance stays one (a test pins it).
   `schema_version` stays 1: an additive optional key, and a runtime that predates it refuses the strict file, which is the right failure for a downgrade.
4. **Creation: `ensureUserInstance`.** It makes the user root (a link there is refused with `WORKSPACE_SYMLINK`) and then reuses or makes the workspace. An existing `user` workspace is
   reused without passing `port` again (`init` would answer `WORKSPACE_EXISTS_CONFIG_DIFFERS` once the person changed it); one without `instance.json` is adopted as a user instance; one
   whose identity says `task` is refused with `WORKSPACE_INVALID`. A new one is made by `initWorkspace` with the title "Claude Agent Workspace", the slug `user`, `port: 7690` seeded
   into `config.json` and `kind: 'user'`, and its README is replaced once by the text of a user instance. The staging-folder transaction and the task mutex of `init` make two concurrent
   callers safe.
5. **Boot refusal (CAW-22).** A `kind: "user"` workspace whose root is not `isUserRoot(root, env)` exits 17 `WORKSPACE_INVALID`, so a hand-edited task cannot become a terminal host.

### Opening the login page
6. `platform/browser.ts` opens the login URL either as a tab of the default browser (the desktop opener, `explorer.exe` on Windows; its exit code 1 counts as success) or as an Edge
   or Chrome app window with a profile of its own (`run/browser-profile`). Edge is looked for before Chrome, in `%ProgramFiles(x86)%`, `%ProgramFiles%`, `%LOCALAPPDATA%` and then on
   `PATH`. A window request without such a browser, or one that does not start, falls back to the tab and says why.
7. The URL must match the login URL pattern of `@mcs/shared` (loopback address `127.0.0.1`, a real port, an optional `#code=` fragment) before any program sees it; anything else is
   `bad-url`. The window is the one child process of the product that is started with a visible window (`spawnDetachedVisible`: `windowsHide: false`, detached, `stdio: 'ignore'`,
   `shell: false`, an absolute `.exe` only); the test that pins "every spawn is hidden" now names this one exception and fails if there is a second. The browser gets the environment of
   the caller without the `MCS_*` and `CAW_*` settings of the product. The test hook `MCS_TEST_OPEN_FILE` (test mode only, read in `runtime/test-hooks.ts`) records the URL in a file
   instead of starting anything.

### Autostart
8. `ops/autostart.ts` makes an optional Startup-folder shortcut (off by default, Windows only) that runs `node "<launcher>" start --no-open` minimized. Windows PowerShell 5.1 makes and
   reads it through `WScript.Shell` with two constant scripts; the path, target, arguments, working folder and description travel in the `CAW_LNK_*` variables of the one child, which are
   registered as child-only entries of `DOCUMENTED_ENV_VARS` and may appear in no other production file. The read script prints base64 of UTF-8, so a profile path outside the OEM code
   page survives the pipe. Removing the shortcut is a file removal.
9. `refreshAutostartIfEnabled` heals the shortcut after an update, but only when the Node differs, the recorded launcher is gone, or it lies in the same install family (the plugin cache
   `plugins/cache/<marketplace>/<plugin>` or the installed skill folder `.claude/skills/<name>`). A launcher outside the install that still exists (a checkout, a worktree, a QA stack), a
   shortcut with arguments of another shape and one that cannot be read are left alone: the outcome is `foreign-target`, one warning without a value is logged and the caller tells the
   person to run `caw autostart enable`.

## Consequences
- Every existing operation that takes `--task` works on the user instance with the global option `--user` (CAW-33) and no new code.
- `instance.json` has one more optional key; code that lists keys uses `InstanceFileSchema`, and the tests that compare a task file with its creation bytes did not change.
- `docs/architecture.md` and the CLI documentation describe the user instance in the documentation packages; this ADR is the record of the decision.
- A failure of the shortcut script is the code `INTERNAL` with the manual instruction as the hint: a dedicated error code would be a change of the shared contract, which this package
  does not make.

## Alternatives rejected
- A separate "app home" outside the instance model: duplicates the process model and loses every `--task` operation.
- `kind` as a `config.json` key: switchable by a one-line edit, and boot reads the identity before the configuration.
- Moving the per-user folder to a new name with a migration: the owner kept the default name `mcs`; a relocation variable already exists.
- A `.lnk` made by a compiled helper or by script text built from the paths: a path with a quote could change what runs; constant scripts with values in the environment cannot.
- Opening the page with `start` through a shell: a shell parses the URL; the desktop opener and a direct `.exe` spawn do not.

## Evidence
- `engine/src/user-instance/ensure.test.ts`: created once; reused after a port change; three concurrent callers make one instance with one audit entry; a link at the root or at the
  workspace is refused; a task named `user` is refused; a legacy `user` workspace is adopted as `user`.
- `engine/src/workspace/{adopt,init,repair}.test.ts`: `kind` written after `engine` for `user` only; a task file with and without an explicit `kind: 'task'` is byte-identical; repair
  keeps the kind.
- `engine/src/platform/browser.test.ts`: the search order, the exact argument list, 20 refused URLs, the fallback with its reason, the hook. `exec.test.ts`: the new spawn and the
  one-exception rule of the "every spawn is hidden" test.
- `engine/src/ops/autostart.test.ts`: the constant scripts, values in the environment only, a profile path with letters outside the OEM code page, the stale-target and foreign-launcher
  notes, the refresh rules. One test runs the real Windows PowerShell on a temporary Startup folder (make, read back, refresh check, remove: about 0.95 s on the development machine).
- `tests/tooling/env-vars.test.ts`: the `CAW_LNK_*` names live in `ops/autostart.ts` alone and are never read from the process environment.
