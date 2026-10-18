# 0061 Plugin and marketplace layout, self-contained skill folder, and the two install paths

Status: Accepted (V4, 2026-10-18). Owner: platform area (A). Amends 0049 (only the place of `SKILL.md`: it moves from the
repository root into the skill folder). Supersedes the "repo-root `SKILL.md`" placement of `docs/design/01-instances-config-ops.md`
Appendix A. Related: 0062 (what the skill folder contains), 0063 (the bundle).

## Context
Owner decision 6: the skill is distributed (a) as a Claude Code plugin from a marketplace in this repository and (b) as a plain
folder that a script copies to `~/.claude/skills/` or to a project's `.claude/skills/`. Both must work from one self-contained folder
(no reference outside it). The formats were verified on 2026-10-18 against the current docs (`code.claude.com/docs/en/plugins-reference`,
`plugin-marketplaces`, `plugins/marketplace-reference`, `plugins/loading`, `skills`, `sessions`, `env-vars`) and by probes with Claude
Code 2.1.289 under an isolated `CLAUDE_CONFIG_DIR` (nothing under the real `~/.claude` was touched).

## Decision
1. **Repository layout** (`<repo>` = the skill repository root):
   ```
   <repo>/.claude-plugin/plugin.json          plugin manifest (used by `claude --plugin-dir <repo>` and `claude plugin validate`)
   <repo>/.claude-plugin/marketplace.json     marketplace catalog (one plugin)
   <repo>/skills/monitoring-claude-sessions/  THE SKILL FOLDER (self-contained, see 0062)
   <repo>/install.mjs                         install path (b): copies the skill folder
   <repo>/runtime/                            sources, tests and build scripts (development only, never shipped)
   ```
2. **`plugin.json`** (verified schema: `name` is the only required field; an unrecognised top-level key is stripped and `claude plugin
   validate` warns; component paths must start with `./` and stay inside the plugin root). We write exactly:
   `name` = `session-monitor`, `displayName`, `version` (equal to `runtime/package.json`), `description`, `author` (`{ "name" }`),
   `repository`, `license` = `MIT`, `keywords`. No component keys: the default `skills/` scan finds the skill.
   The plugin name is NOT `monitoring-claude-sessions`: `claude plugin validate` reports `Plugin name "monitoring-claude-sessions" reads
   as one of Anthropic's own` (a whole-word `claude` is a warning; a `claude-` prefix is an error) and `--strict` then fails. The
   skill keeps its name through the folder name and the `name:` frontmatter, so the command is `/session-monitor:monitoring-claude-sessions`.
3. **`marketplace.json`** (verified: required `name`, `owner.name`, `plugins[]`; entry requires `name` and `source`; the marketplace name
   uses letters, digits, `.`, `_`, `-` and avoids the reserved and impersonating names): `name` = `session-monitor`, `description`,
   `owner` = `{ "name" }`, one entry `{ "name": "session-monitor", "source": "./skills/monitoring-claude-sessions", "version", "description" }`.
   The entry name equals the manifest name (the install id is `session-monitor@session-monitor`).
4. **The entry points at the skill folder, not at the repository root.** A plugin from a relative-path source is copied to
   `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and only that directory is copied ("files outside the plugin directory
   are not copied"). With `"source": "./"` the whole repository is copied (measured: 15.5 MB tracked today, including `runtime/`
   sources, tests and old trees); with the skill folder only the bundle, `SKILL.md`, scripts and reference docs are copied
   (estimated 5 MB: bundle 3.5 MB, web assets 0.65 MB, notices, reference docs; to be measured by the bundle work package). A directory whose root holds `SKILL.md` and no `skills/` loads as one skill (probe: `claude plugin details
   session-monitor` lists `Skills (1) monitoring-claude-sessions`; dotfiles such as `bundle/.mcs-build.json` are copied). With no
   `plugin.json` inside the folder the marketplace entry is the manifest, so the entry carries `version`.
5. **Versions** come from `plugin.json` / the entry (`version` pins users until it changes). `runtime/package.json`, `plugin.json` and
   the entry `version` are one number, written by `runtime/scripts/set-version.mjs` and compared by a tooling test.
6. **`SKILL.md` format** (verified): YAML frontmatter, every field optional; we set `name` (= folder name) and `description` (the
   trigger text; `description` + `when_to_use` is cut at 1,536 characters); the body stays under 500 lines; reference material lives
   in `reference/*.md` next to it. The skill invokes the CLI as `node "${CLAUDE_SKILL_DIR}/scripts/mcs.mjs" <command>`:
   `${CLAUDE_SKILL_DIR}` is the folder holding `SKILL.md`, so it is right in the plugin cache, in `~/.claude/skills/<name>/` and in a
   checkout. `${CLAUDE_PLUGIN_ROOT}` is never used (it exists for plugin skills only and changes with every version). The skill never
   links to a path with `..`.
7. **Install path (b)**: `node install.mjs [--project <dir>] [--dest <skills dir>] [--force] [--dry-run]` copies the skill folder to
   `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/monitoring-claude-sessions/` (or `<project>/.claude/skills/...`), refuses to replace an
   existing install without `--force`, replaces it through a temp sibling and a rename, and finishes by running the installed
   launcher's `--version`. It needs only Node.
8. **Consequences of the versioned cache path** (`${CLAUDE_PLUGIN_ROOT}` changes at every version and the previous directory is
   removed 14 days after an update): nothing records the skill path as a durable string. Hook commands written into settings use a stable
   path under `MCS_HOME` (owner decision 13, hooks area); a running server keeps the code it loaded and `status` reports `outdated`
   until restart; process-identity markers match the server entry by suffix, not by install folder (0062).
9. **Validation**: `claude plugin validate <repo> --strict`, `claude plugin validate <repo>/.claude-plugin/plugin.json --strict` and
   `claude plugin validate <repo>/skills/monitoring-claude-sessions --strict`, always with `CLAUDE_CONFIG_DIR` pointing to a temp folder,
   are verifier probes (the CLI may be absent on CI runners). `tests/tooling/plugin-layout.test.ts` re-checks the same rules offline.

## Consequences
- A user installs with `/plugin marketplace add <owner>/<repo>` then `/plugin install session-monitor@session-monitor`, or runs `node install.mjs`.
- The skill folder is the unit of shipping; anything the skill needs at run time must be inside it (bundle, web assets, migrations,
  defaults, reference docs, notices).
- New sessions in the development checkout no longer see a root `SKILL.md`; the lead installs the skill from the local path when needed.
- The repository root `config/defaults.json`, `reference/` and the old trees stay until the removal milestone; the skill folder holds
  copies, and a tooling test keeps the copies equal until then.

## Alternatives rejected
- `source: "./"` (plugin root = repository root): ships `runtime/`, tests, docs and old trees to every user's plugin cache and update.
- Plugin name `monitoring-claude-sessions`: fails `claude plugin validate --strict`.
- A `bin/mcs` executable on the plugin `PATH`: no `.cmd`/PATHEXT story on Windows, and it would not exist for install path (b).
- Publishing an npm package: would need `npm` and a registry on the user's machine; owner decision 3 allows only Node.
- `${CLAUDE_PLUGIN_ROOT}` in `SKILL.md`: not defined for a skill copied into `~/.claude/skills/`.

## Evidence
- 2026-10-18, Claude Code 2.1.289, probes (planning notes, not published) with a temp `CLAUDE_CONFIG_DIR`:
  `claude plugin validate ./repo` and `--strict` on the layout above: `Validation passed`; with the name `monitoring-claude-sessions`:
  warning, `--strict` fails; `plugin marketplace add ./repo` + `plugin install session-monitor@session-monitor`: cache
  `plugins/cache/session-monitor/session-monitor/4.0.0/` held the whole repository (including `runtime/`); with entry source
  `./skills/monitoring-claude-sessions` it held `SKILL.md`, `scripts/` and `bundle/` including dotfiles; `plugin details` lists the skill.
- Docs read the same day: plugins-reference (fields table, path rules, standard layout, `${CLAUDE_PLUGIN_ROOT}`), marketplace-reference
  (top-level fields, reserved names, relative-path sources, strict mode), plugins/loading (cache path, versions, 14-day cleanup), skills
  (frontmatter, discovery paths, `${CLAUDE_SKILL_DIR}`, 500-line guidance).
