# 0092 The CLI scope rule: `--user`, one program under two names, exit code 3, the `mcs` note

Status: Accepted (CAW, 2026-11-15). Owner: lifecycle area (lif), work package CAW-33. Builds on 0008 (the CLI kernel and the `mcs.cli/1` envelope), 0091 (the user instance is a
workspace of kind `user`) and 0093 (the terminal guard); it changes no operation of the engine. Related: 0079 (the stance), 0094 (the access code is minted over the control channel).

## Context
Until now every command of the CLI acted on a monitored task: `--task SLUG` named it, `--repo` and `--root` said where the tasks live, and `mcs start` without a task acted on the task
`default`. The product now has a second world, the app (the user instance of 0091, one per Windows user, which holds the terminal sessions), and the person who types `caw start` means
the app. The CLI has to say which world a call acts on, without a second set of commands, without breaking a script or a skill that already passes `--task`, and without a flag that is
silently ignored.

## Decision
1. **One rule, in one pure function (`cli/src/scope.ts`, `resolveScope`).** `--user` selects the app. `--task`, `--repo` or `--root` select a task. A call that gives none of them uses
   the `defaultScope` of its command, which is `task` unless the command says `user`. `--user` together with any of the three is a usage error (exit 2): "--user cannot be combined with
   --task, --repo or --root". A value counts as given when the option was typed, even an empty one, so `--task ""` fails as the invalid slug it is and never changes the world.
2. **The lifecycle family defaults to the app.** `start`, `stop`, `restart`, `status`, `serve`, `verify`, `doctor` and `check` have `defaultScope: 'user'`. Every other command keeps the
   task world and works on the app with `--user` (`backup --user`, `upgrade --user --yes`, `diagnostics --user`, `instances list --user`). The commands that exist only for the app
   (`open`, `autostart`, `config get`, `config set`) come with the commands package and reject the task selectors.
3. **The kernel does the work, the commands stay small.** `GLOBAL_OPTIONS` gains `user`. `CommandDefinition` gains `defaultScope`; `CommandContext` gains `scope`. For the app the kernel sets
   the `task` option of a command that has one to the slug `user` before it validates, so a `required` `--task` is satisfied and every read of `ctx.args.string('task')` works as it always
   did; the operation context is `userOpContext` (the user root as root and repository), whatever the working directory and whatever `--repo` would have said. A command that has no
   `task` option still gets the user root. A command that does not set `defaultScope` resolves to `task`, so every existing command and every existing test is unchanged.
4. **Options of one scope, options that exclude each other.** `OptionSpec.scope` ties an option to one world: `--force` (stop, restart) and `--window`, `--tab`, `--print` (start, restart)
   belong to the app, and giving one to a task call is a usage error ("--force applies to the app instance, not to a task"), because a silently ignored `--force` is worse than a refusal.
   `OptionSpec.conflictsWith` names options that cannot be combined (`--open` and `--no-open`, `--window` and `--tab`). `--no-open` is the one app option a task accepts and ignores: the
   shortcut of the autostart and scripts pass it to whatever they start. The help page marks an option of one scope ("app instance only", "task only").
5. **Each lifecycle command delegates by scope and nothing else.** With `ctx.scope === 'user'` it calls the `opsApp` operation (`startUser`, `stopUser`, `restartUser`, `statusUser`,
   `serveUser`, `verifyUser`); otherwise it calls the unchanged operation of a task. `status` prints the text lines of design 06 2.3 (or the envelope with `UserStatusReport`) and exits 0
   iff the app runs. `check` is the doctor pipeline limited to `userCheckIds` (the machine-level checks and the `app.` family); `doctor` runs everything and adds the `app.*` checks, which
   `main.ts` registers as one `extraChecks` entry in its own block and which answer nothing outside the app. Before the first start there is no workspace of the app: `doctor` and `check`
   run the checks that need none and end with a note that says so. `serve` offers no login options (a foreground server cannot show a code afterwards; `caw open` in another terminal
   does), and its `--open` is a task option.
6. **One program under two names.** `caw` and `mcs` are the same program. `MainPaths.program` (`'caw'` or `'mcs'`, set by the launcher; absent means `mcs`, which is what `node dist/main.js`
   is) decides only the migration note below. Every usage line, hint and `--version` spells the program through `CLI_NAME` (shared, `product.ts`), whose value is still `mcs` until the
   rename step changes that one constant.
7. **Exit code 3 is "refused because terminals are live".** A stop or restart of the app that would end live terminals (or cannot count them) throws `TERMINALS_LIVE`; the kernel prints the
   message and the hint of the operation (design 06 3.3: the sessions named, "run `caw stop --force` to end them now") and exits 3; `--json` is an error envelope with
   `code: TERMINALS_LIVE` and `details: { live, sessions }`. The codes remain 0 success, 1 failure or problems found, 2 usage, 3 refused, 130 Ctrl+C.
8. **The access code is not part of a result by accident.** `start` and `restart` of the app pass the login URL into the `--json` data only when `--print` was given. When a browser could not
   be opened the URL is one line of text (the code was never used, so showing it is the fallback) and is not in the data; without `--print` the data carries `login: null`.
9. **The `mcs` note.** `mcs start`, `stop`, `status` and the rest used to act on the task `default` when no selector was given; they now act on the app. When the program is `mcs` and the
   scope came from the default (nobody typed a selector), the kernel appends one `warning:` line (and one entry of `warnings` in `--json`): "without --task, --repo or --root this command
   now acts on the Claude Agent Workspace app (before it acted on the task 'default'); pass --task default to keep the old behaviour". It is never shown for `caw`, for a call that chose a
   scope, for `--help` or in front of an error. **The note ships in 4.1.0 and is shown by two releases (4.1 and 4.2); it is removed in 4.3.0** together with `withScopeNote` and its tests
   in `main.test.ts` (the code says so next to the constant). The shipped `SKILL.md` already passes `--task`, so the skill is not affected.

10. **The words of an app call are the kernel's, not each command's.** The operations of the engine know the app as the task `user`, so the commands they suggest carry `--task user`
   (`mcs start --task user`, `mcs restart --task user`, `mcs backup restore --task user --id X`). In the scope of the app such a command is wrong (a call with a task selector is a task call,
   which finds no `task.json` of that name), so after the command ran the kernel words every text of an app call again (`appCommandText` in `scope.ts`): the selector is dropped from a
   command that defaults to the app (`mcs doctor`), and becomes `--user` for one that does not (`mcs upgrade --user --restart`). It does so for the text lines, the warnings and the `data`
   of a result, and for the message, the hint and the `details` of an error, in text and in `--json`, so every lifecycle command is covered at once and a script reads the same hint a person
   does. A task call is never touched. One error gets its own hint: a `TASK_NOT_FOUND` of a task command used with `--user` before the app ever started says "run `caw start` once to create
   the app instance", where the engine would say `mcs init --slug user` (which would make a task named `user`).

## Consequences
- `caw start` and `caw stop` do what a person means, and every existing call that names a task keeps its meaning byte for byte. The only behaviour change is a bare `mcs start`, `mcs stop`,
  `mcs status`, ... without a selector, which the note announces and the removal date bounds.
- A script that wants a task writes `--task` (or `--repo`, which also selects the task world); a script that wants the app writes nothing or `--user`. There is no call whose world depends on
  the working directory.
- The scope logic is testable without a process: the selector matrix is a table test of `resolveScope`, the kernel behaviour is a test of `main` with fake commands, and each command is a
  test with fake operations in both scopes.
- Integration tests that run `mcs status` or `mcs doctor` without a selector would now act on the app; the existing ones pass `--repo`, which keeps them in the task world.

## Alternatives rejected
- **A separate binary or a `caw app ...` prefix for the app:** the person types the short form for the common case, and every lifecycle verb would exist twice.
- **`--user` as the only way to reach the app, with the lifecycle family staying on tasks:** `caw start` is the front door of the product and must not need a flag.
- **Deciding the world from the working directory (inside a repository: a task):** the same command would mean different things in two folders, and a script run from anywhere would change meaning.
- **Silently ignoring an option of the other world:** `caw stop --task a --force` would look as if it had ended terminals. A usage error costs one retyped line.
- **Keeping the old default and warning on `caw` instead:** the new program has no history to protect; only the old name needs a bridge, and a bridge has a date.

## Evidence
- `cli/src/scope.test.ts`: every combination of the four selectors under every default (none, `user`, `task`), the conflicts (usage error, exit 2), an empty value counts as given, the hint.
- `cli/src/main.test.ts`: `--user`, the default scope and the injected task, `--repo` and `--root` keeping a required `--task`, the conflict as text and as an envelope, `--help` winning over a
  conflict, the note (once, for `mcs` only, never when chosen, never for `--help` or an error), options of one scope, options that exclude each other, `CLI_NAME` in the usage line, the hints
  and `--version`, `TERMINALS_LIVE` as exit 3 in both output modes, the `app.*` checks wired next to the checks of the other areas and silent outside the app.
- `cli/src/scope.test.ts` (second half) and `cli/src/main.test.ts` ("the wording of an app call"): the selector dropped or turned into `--user` in a sentence, in backticks and in nested data; the
  text lines, warnings, data and error of an app call as text and as an envelope; `TASK_NOT_FOUND` with the hint to start the app; a task call and a usage error left alone.
- `cli/src/commands/{start,stop,restart,status,serve,verify,doctor,check}.test.ts`: both scopes with fake operations; the task assertions of the earlier suites are kept, the option inventories
  gain the new options. The login URL appears in `--json` data only with `--print`.
