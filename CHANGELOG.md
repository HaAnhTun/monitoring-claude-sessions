# Changelog

## 4.0.0 (2026-10-19)

Node only. A user machine needs nothing but Node 22.22 or newer.

### Breaking

- **Python removed.** The Python engine, its viewer and the Python test toolchain are gone; the Node runtime is the only engine
  (ADR 0066). Golden data the tests still need is frozen as committed fixtures.
- **JavaScript regex dialect.** `session_rules[].match`, `attempts.start` and `attempts.end` are JavaScript regular expressions,
  compiled with the `v` flag (ADR 0067). A pattern in the old syntax is refused with a hint to run `migrate-workspace`.
  `attempts.time_format` is a documented strftime subset.

### Added

- **`node:sqlite`** replaces the native better-sqlite3 addon behind the single driver seam (ADR 0064): no native dependency left.
- **Committed bundle.** Server, CLI and hook handler are bundled with rolldown into `skills/monitoring-claude-sessions/bundle/`
  with the prebuilt web UI and third-party notices; `npm run bundle:check` proves the bundle equals a fresh build (ADR 0063).
- **Plugin and install script.** A Claude Code plugin and marketplace in this repository (`/plugin install
  session-monitor@session-monitor`) and `node install.mjs` for clones; both install the same self-contained skill folder (ADR 0061).
- **Bundle-first launcher** `scripts/mcs.mjs`: checks the Node floor, then runs the bundle (or a checkout build); it never runs
  npm or a build (ADR 0062).
- **`doctor`** (Node, runtime integrity, Claude home, workspace, configuration, database, port, with a `fix:` line per problem)
  and **`instances list` / `instances repair`**.
- **`migrate-workspace`**: one-time conversion of a pre-4.0 workspace (regex translation, `instance.json`), a dry run unless
  `--apply`, with a backup first (ADR 0068).
- **Transcript auto-detection** of the Claude Code project folder of a repository (honours `CLAUDE_CONFIG_DIR`).
- **CI**: GitHub Actions on Windows x64, Ubuntu x64 and macOS arm64 (lean), results published to a `ci-status` branch; a Docker
  POSIX harness (`npm run docker:posix`) for Linux x64/arm64, glibc and musl (ADR 0065).
- MIT licence, English README and `README.vi.md`.

### Fixed

- External evidence (daemon job files) keeps the time its source recorded instead of the time it was read, and a session
  that was resumed after a finished job is no longer stuck as completed (ADR 0069).
- Token usage and file links are committed in the same transaction as the read cursor, so a crash can no longer lose usage.

### Not yet in 4.0

- Hooks installer (live hook events; the hook entry point exists, but nothing installs it).
- Panels (machine, git, ledger, chain log, logs) and the attempts reader (`chain_log` and `attempts` are validated but not read).
- Search, analytics, alerts and export.
- The read-only MCP server.
- The UI redesign and the Vietnamese UI (i18n).
- The diagnostics bundle command.

## Before 4.0

- **3.0.0**: the Node runtime (TypeScript engine, SQLite metadata database, HTTP API v3 with server-sent events, React web UI,
  CLI) as a walking skeleton next to the Python engine.
- **2.0.2 (2026-10-11)**: session list first in the sidebar; a demo project builder and a screenshot tool.
- **2.0.1 (2026-10-11)**: much lower CPU use of the machine panel; helper processes open no console window.
- **2.0.0 (2026-10-11)**: Python engine split into modules; evidence-based states (RUNNING, IDLE, COMPLETED, FAILED, UNKNOWN);
  incremental transcript reader with token deduplication; task workspaces with an audit trail; a new UI.
