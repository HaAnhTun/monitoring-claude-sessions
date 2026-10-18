# 0070 Hooks stay opt-in: the installer points settings at a stable copy of the hook script, and the plugin ships no hooks

Status: Proposed (V4 planning, 2026-10-18). Owner: area C2 (completion evidence, panels, hooks), work packages WP-37, WP-106, WP-38. Amends ADR 0010 (decision items 1 and 2: the stub at `<skill>/scripts/mcs-hook.mjs` and its import of `dist/hook.js`) and ADR 0014 (the apply order and the test guard). It supersedes nothing: the handler contract, the envelope, the marker, the consent rules, the backup and the verification of those ADRs stay in force. The matching edits of design 02 (sections 2.1, 3.3, 3.5, 3.7, 3.8) are made in the V4 documentation rewrite.
Planned for a later 4.x release.

## Context

- V3 wrote the path `<skill>/scripts/mcs-hook.mjs` into the settings file of the person. That path was stable because the skill folder lived in one place. V4 installs the skill as a Claude Code plugin first (decision 6). Claude Code copies a marketplace plugin into a per-version folder of its plugin cache; `${CLAUDE_PLUGIN_ROOT}` changes at every update, and the previous version folder is marked orphaned and removed about seven days later (plugin reference, read 2026-10-18). A settings entry that names a path inside the plugin cache therefore works until the update, then fails on every hook event. A failing hook does not stop Claude Code, but it adds a `hook_non_blocking_error` attachment to the person's transcript at every firing (ADR 0010, context).
- Claude Code can also load hooks from a plugin (`hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}`), active whenever the plugin is enabled. That route has no dry run, no per-scope choice, no backup, no uninstall of our kind, and every event of every session on the machine would start a Node process (about 65-72 ms per spawn, ADR 0010 evidence) even when no monitor runs and no route file exists.
- Owner decision 13 of V4: hooks are opt-in only: installed on an explicit command, with a consent prompt, backup, uninstall and status. Development and tests use temp settings only.
- Exec form hooks (`command` plus `args`, no shell) are documented in the hooks reference; `${CLAUDE_PLUGIN_DATA}` (a directory that survives updates) exists only inside Claude Code processes and cannot be resolved by the CLI that the person runs.

## Decision

1. The plugin and the skill folder ship no hooks: no `hooks/hooks.json`, no `hooks` key in `plugin.json`, no hooks in SKILL.md front matter. Hooks enter a settings file only through `mcs hooks install --yes`.
2. The hook handler is one self-contained, zero-dependency `.mjs` file in the bundle (the stub logic is inlined: `MCS_HOOK_DISABLE` check, hard exit after 1200 ms, always exit 0, `--version`). `hooks install --yes` copies it to `$MCS_HOME/hooks/mcs-hook.mjs`, where `$MCS_HOME` is the folder `resolveMcsHome(env)` returns. The copy is written atomically (temporary file in the same folder, rename with the Windows retry of ADR 0058) before the settings file is written. A settings entry names only the absolute Node path of the installing CLI and that copy: `command: <node>`, `args: ["--no-warnings", "<MCS_HOME>/hooks/mcs-hook.mjs", "--mcs-hook", "<Event>", ...]`. No path below the skill folder, the plugin cache or a repository appears in a settings file.
3. Running `hooks install --yes` again after a plugin update refreshes the copy (the sha256 of the bundled file differs) and leaves a settings file that already carries our entries untouched (settings action `noop`, script action `refreshed`). The dry run prints both actions. Nothing refreshes the copy implicitly: not the server start, not `start`, not `init`, not `configure`, not `doctor`, not the plugin update. `hooks status`, `hooks verify` (check V3) and `doctor` report the copy as `current`, `stale` or `missing` and print the command that repairs it.
4. `hooks uninstall --yes` removes our entries (the marker is the argument `--mcs-hook`) and deletes the copy when the install manifest `$MCS_HOME/hooks/installs.json` has no entry left.
5. `hooks verify` runs exactly the installed `Notification` entry (the same `command` and `args` Claude Code will run) with a synthetic probe payload and checks that the probe reaches the spool, so it proves the stable path works.
6. Test safety: when `MCS_TEST` or `VITEST` is set, every settings target and the `MCS_HOME` folder must lie inside `os.tmpdir()`; otherwise the command stops with `HOOKS_FAILED` reason `REAL_SETTINGS_IN_TEST`. The opt-in real-provider test (`MCS_E2E_CLAUDE=1`) runs `claude -p` with `--settings <temp file> --setting-sources local --no-session-persistence`, a temp `MCS_HOME` and a temp working folder, so no real settings file is read or written and no transcript is created.
7. Consent is unchanged from ADR 0014 and gets one addition: install and uninstall are dry runs unless `--yes`; on a terminal (stdin and stdout both TTYs) the dry run ends with a prompt that names the settings file and the scope and applies only when the person types the word `install` (`uninstall`); in a pipe, a CI job or an agent session nothing is ever prompted. An agent passes `--yes` only after showing the dry run and receiving explicit agreement, and only with the user scope when the agreement names it.

## Consequences

- A plugin update never breaks installed hooks: the old copy keeps working until the person refreshes it. Envelope version 1 stays accepted by every server of the same major version, and `hooks status` shows the copy's handler version next to the runtime version.
- Machines that did not opt in pay nothing: no hook spawn, no file in `MCS_HOME`.
- A deleted `MCS_HOME` or a changed Node path (a version manager) breaks installed hooks the same way a deleted script would. `hooks verify`, `hooks status` and `doctor` detect it (V3: `command` and the script exist), `hooks install --yes` repairs it, `hooks uninstall --yes` removes the entries.
- The hook handler is a single file, so a partial build cannot leave a half-working stub; a corrupted copy is prevented by the atomic write.
- The V3 stub's `HANDLER_UNAVAILABLE` branch has no V4 equivalent: when the copy itself is missing nothing can log. This is accepted; the detection above replaces it.
- Exec-form hooks need a Claude Code release that supports `args`. The dry run prints this requirement and `hooks verify` documents the version used in the lab (2.1.289). An older release is not detected by the CLI; the opt-in real-provider test is the guard against the actual product.

## Alternatives rejected

- Hooks shipped by the plugin (`hooks/hooks.json`): active without consent, no scope choice, no dry run, no backup, one Node spawn per event in every session on the machine.
- A settings entry that points into the plugin cache: breaks after the next plugin update, within about seven days at the latest.
- `${CLAUDE_PLUGIN_DATA}` as the home of the copy: survives updates but exists only inside Claude Code processes; the CLI cannot resolve it reliably.
- A symlink or junction from `MCS_HOME` to the skill folder: needs privileges on some systems and dies with the cache cleanup; the copy is simpler and testable.
- Automatic refresh of the copy at server start or at plugin update: a silent change of code that runs in every Claude Code session of the person.
- Shell-form command (`node "path" ...`): Git Bash start-up on Windows, quoting, profile output (ADR 0010).
- `command: node` resolved through `PATH`: works in exec form but depends on the `PATH` of the hook environment, which can differ from the installing shell. Revisit if version managers cause breakage in practice.

## Evidence

- Plugin caching and `${CLAUDE_PLUGIN_ROOT}` behaviour, `${CLAUDE_PLUGIN_DATA}`, exec form and plugin `hooks/hooks.json`: Claude Code documentation read through the docs library on 2026-10-18 (plugins reference "Plugin caching and file resolution" and "Environment variables"; hooks reference "Exec form and shell form" and "Hook locations").
- Handler cost per event: ADR 0010 evidence E1 (median 65-72 ms per run on Windows 11, Node 24.14.1).
- The installed event names: `INSTALLED_HOOK_EVENTS` (21) compared with the hooks reference of 2026-10-18; WP-37's verifier repeats the comparison.
- Local Claude Code 2.1.289 `claude --help`: `--settings`, `--setting-sources` and `--no-session-persistence` exist.

## Open items

- The lowest Claude Code release that accepts `args` in a command hook (the changelog states the feature; its release number was not found). WP-37 records it when known.
- Whether an unknown event name in a settings file drops one entry or the whole file in an older Claude Code release (not tested; the real-provider run covers the current release).
