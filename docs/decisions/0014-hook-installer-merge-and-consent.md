# ADR 0014: Hook installer: marker-based merge, atomic write, backups, dry run by default

Status: Proposed (Phase 1 design, 2026-10-11; revised by the second critic pass, registry C23, C48, C49). Design reference: section 3.

## Context

Hook settings merge across levels and reload into running sessions. In `-p`, a settings file that fails validation is
silently ignored, so a broken `settings.json` would drop all of a user's settings. CCAM edits the user's settings at every
server start, non-atomically, with no backup or uninstall, and identifies its entries by a file-name substring. Foundations D8
and C3 require project-local default scope, atomic write + validation + backup, marking, dry run, explicit `--yes`, verify and
uninstall, and no test against real settings.

## Decision

- Scopes: `project-local` (default, `<repoRoot>/.claude/settings.local.json`, warning when not git-ignored), `user`
  (`~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`), `project` refused.
- Ownership marker: a `command` handler whose `args` contain `--mcs-hook` (or whose shell command contains it). Install removes
  every marked handler and appends one group per installed event; uninstall removes marked handlers and only the groups/keys
  that this removal emptied. Indentation, EOL, BOM, trailing newline and key order are preserved.
- Apply: OS mutex `mutexName('settings', path.resolve(settingsPath))` (01 4.2, released by the OS when the holder dies), backup of the original bytes under `$MCS_HOME/backups/settings/` (20 kept), write temp next to the target,
  fsync, re-parse and compare, optimistic concurrency (hash unchanged since read, 3 attempts), rename with retries for Windows
  sharing violations, post-check with restore, manifest `$MCS_HOME/hooks/installs.json`, audit entry in the task.
- Dry run unless `--yes`; agents pass `--yes` only after the user agreed to the shown plan and scope. Never installed implicitly.
  Under `MCS_TEST=1`/Vitest, writing a real settings path is refused.
- Home: the installer is engine code (`engine/src/hooks/installer/`) called by 01's `ops.hooks.{install,uninstall,verify,status}`;
  the CLI modules keep option tables and rendering only (the engine never imports the CLI package).
- `mcs hooks verify` checks settings, paths, handler version, route file, then runs the installed command with a synthetic probe
  payload and confirms arrival in the spool (and in the DB when the server runs), without touching settings or starting Claude Code.

## Consequences

- Install is idempotent and `uninstall(install(x))` equals `x`.
- A failure at any step leaves the original settings file intact.
- A real end-to-end check with Claude Code exists only in the gated E2E suite with a temp `--settings` file.

## Alternatives rejected

- Auto-install at server start (CCAM): silent edits of a user-global file.
- Writing `.claude/settings.json`: committed and shared.
- Substring matching on a script name: also matches unrelated user scripts.

## Evidence

- `docs/research/claude-code-hooks.md` sections 3.5-3.7, 7, 10 (Claude Code 2.1.289 `--help`: in `-p`, settings files that fail
  validation are silently ignored; docs fetched 2026-10-11).
- `docs/research/ccam-source-analysis.md` section 3 (CCAM commit a06db038, read 2026-10-11).
- Windows rename behavior: Node `fs.renameSync` replaces an existing file (MoveFileEx with replace), EPERM/EBUSY when another
  process holds it without share-delete; retry policy is defensive (not measured here; covered by test T-IN-05 fault injection).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 5 (hook installation), 12 (restrict file-system writes, safe handling), 13 Phase 3 "hook installation and verification", foundations C3.

## Open items

OI-5 (live reload into running sessions; affects only the warning text). Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-9 (installer, verifier, uninstaller, status). Slice table: design section 13.
