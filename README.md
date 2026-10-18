# Session monitor for Claude Code

[Tiếng Việt](README.vi.md)

A local, read-only monitor of Claude Code sessions with a web page. Claude Code writes every session (interactive sessions,
`claude -p` runs, subagents, workflows) to a transcript file while it runs. The monitor reads those files in place, keeps a small
metadata database per task and serves a dashboard on `127.0.0.1`: which sessions run, what they are doing, token use, and which
have finished when an external record (a finished daemon job) says so. It never starts, stops or changes a session.

It ships as a Claude Code skill (`monitoring-claude-sessions`), so an agent can set it up for you, and as a plain command line.

## Requirements

- Node.js 22.22 or newer (tested on 22, 24 and 26). Nothing else: no compiler, no Python, no `npm install`, no build.
- Windows, macOS or Linux (glibc), x64 or arm64. Alpine (musl) is best effort. Verified results per platform:
  [docs/platform-support.md](docs/platform-support.md).

## Install

### A. Claude Code plugin (recommended)

In Claude Code:

```text
/plugin marketplace add <repo-url>
/plugin install session-monitor@session-monitor
```

The plugin contains the skill only (no hooks, no MCP server).

### B. Clone and run the install script

```bash
git clone <repo-url> session-monitor
cd session-monitor
node install.mjs                  # into <CLAUDE_CONFIG_DIR or ~/.claude>/skills/monitoring-claude-sessions
node install.mjs --project <dir>  # or into <dir>/.claude/skills/monitoring-claude-sessions
```

`--dry-run` prints what it would do, `--force` replaces an install made by the script, `--uninstall` removes it,
`--dest <dir>` picks another skills folder. `node install.mjs --help` lists the options.

## Quick start

Ask Claude Code to "monitor my running sessions", or use the launcher yourself. With install path B the launcher is
`~/.claude/skills/monitoring-claude-sessions/scripts/mcs.mjs` (a plugin install keeps the skill in Claude Code's plugin
cache; there the agent runs the launcher for you). Run the commands from the repository whose sessions you want to watch, or
pass `--repo PATH`.

```bash
MCS="node $HOME/.claude/skills/monitoring-claude-sessions/scripts/mcs.mjs"
$MCS init --name "Nightly build"                 # creates .claude/monitor/tasks/nightly-build/ (or reuses it)
$MCS configure --task nightly-build --reason "only the build sessions" \
  --set 'session_rules=[{"match":"STEP=([A-Z0-9]+)","label":"build step {1}"}]'
$MCS start --task nightly-build                  # prints the URL, for example http://127.0.0.1:8765
$MCS verify --task nightly-build                 # the running monitor answers with valid data
$MCS status --task nightly-build                 # URL, pid, uptime, sessions by state
$MCS stop --task nightly-build
```

`$MCS help` lists every command and `$MCS help <command>` its options. Other useful commands: `discover` (transcripts folder and
recent sessions), `inspect` (effective configuration), `check` (validate the configuration), `restart`, `instances list`.
Configuration keys and the regular expression syntax: [docs/configuration.md](docs/configuration.md).

## Upgrading from a workspace made before 4.0

Version 4.0 reads JavaScript regular expressions only. A task workspace created by an older version (Python regex syntax such as
`(?P<name>...)`, no `instance.json`) is converted once:

```bash
$MCS stop --task <slug>
$MCS migrate-workspace --task <slug>            # dry run: shows what would change, writes nothing
$MCS migrate-workspace --task <slug> --apply    # backs up to data/backups/ first, then converts
```

## Doctor

`$MCS doctor [--task <slug>]` checks Node, the runtime, the Claude home and, with a task, the workspace, configuration,
database and port, and prints a `fix:` line for each problem. See [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

The sources are an npm workspace in `runtime/` (TypeScript: `shared`, `engine`, `server`, `cli`, `web`, `testkit`). Users run the
committed bundle in `skills/monitoring-claude-sessions/bundle/`; developers build from the sources.

```bash
cd runtime
npm ci
npm run build          # TypeScript and the web UI
npm test               # unit, web, integration, isolation and resilience tests
npm run bundle         # rebuild the committed bundle
npm run bundle:check   # prove the committed bundle equals a fresh build
npm run docker:posix   # run the gates in throw-away Linux containers (needs Docker)
```

More: [docs/development.md](docs/development.md) and [docs/architecture.md](docs/architecture.md).

## Privacy and security

- The server binds `127.0.0.1` only and checks the `Host` and `Origin` headers. That is a safeguard against other web pages,
  **not authentication**: anyone who can reach the port can read the page.
- Transcripts hold your prompts, file contents and possibly secrets. Never expose, forward or tunnel the port.
- The monitor is read-only: it never writes to transcripts or Claude Code settings. Its database holds metadata only;
  transcript text is read from the file when the page asks for it.
- No network access other than the loopback server; the page loads nothing from the internet.

## License

[MIT](LICENSE). Bundled third-party code: `skills/monitoring-claude-sessions/bundle/THIRD-PARTY-NOTICES.txt`.
