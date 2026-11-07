# Changelog

## Unreleased

Work after the 4.0.0 tag. The version number is still 4.0.0.

### Added

- **New web UI.** A shell with navigation, a session switcher, a top bar with a Live control, a user menu and a shortcuts dialog;
  design tokens and shared primitives; the pages Overview, Sessions, Session detail (transcript, errors, agents, tokens and events
  tabs), Activity, Tasks, Analytics, Search and Settings with health; state badges with an evidence line and a shared state
  vocabulary; an attention strip and quick filters. English and Vietnamese catalogues (i18n).
- **Panels.** Git, machine (per-OS process and memory samplers), Docker, logs, ledger and chain log, served by
  `GET /api/v3/panels/:key` and shown on the Overview.
- **Attempts and completion evidence.** The attempts table of a chain log is read (`chain_log` and `attempts` in the
  configuration); `GET /api/v3/completion` and `mcs verify-completion` say from observed evidence whether a run finished.
- **Search, analytics, alerts and export.** Transcript search (the Search page and the search routes), usage by model, session,
  day and tool with a cost estimate, alert rules with an evaluator, and `mcs export` (`.ndjson`, metadata only unless
  `--include-content`) with retention through `mcs cleanup`.
- **Hooks installer and ingest CLI.** `hooks install`, `uninstall`, `verify`, `status`, `enable`, `disable` and `ingest replay`
  (opt-in; nothing is installed by default).
- **Read-only MCP server.** `mcs mcp --task <slug>`, with `--print-config` to print the registration command and
  `--include-text` to also offer the tools that read transcript text.
- **Data and maintenance commands.** `sessions list`, `sessions show`, `usage`, `errors`, `backup` (list, restore), `upgrade`,
  `db migrate`, `db rebuild`, `cleanup`, `config migrate`, `diagnostics` (a redacted report safe to share) and
  `migrate-workspace --all`.
- **Benchmarks and isolation tests.** A benchmark harness (`runtime/bench`; results stay on the machine) and an isolation test
  suite for tasks that run side by side.

### Changed

- A session shows why it is in its state (an evidence line), and the lifecycle uses more evidence (hook coverage, due children).
- `analytics.usageTrend` defaults to `true`; the time format of `attempts` is a documented strftime subset; the regex translator
  prints a readable dialect.
- The launcher no longer reads `MCS_LAUNCHER_NO_BOOTSTRAP`; the error codes `BOOTSTRAP_FAILED` and `RUNTIME_IN_USE` are gone.
- The total JavaScript budget of the web bundle is 340 kB gzip (initial JavaScript stays at 200 kB, CSS at 25 kB).
- The committed bundle, the JSON schemas and the API reference were regenerated.

### Removed

- **GitHub Actions workflow and the `ci-status` channel.** CI is local only: `npm run ci`, `npm run ci:full` and the Docker POSIX
  harness (`npm run docker:posix`) are the gates (ADR 0078). `ci-status.mjs`, `ci-lean.mjs`, `npm run ci -- --summary-json` and the
  `MCS_CI_*` environment names went with them. The `ci-status` branch on the remote is no longer written or read.

### Known issues

- Not finished: the contract suite for responsive layout, keyboard and language, the rewrite of the browser smoke test, and the
  strict check that no literal text is left in the web sources.
- With hooks off, the top bar can show the ingestion as down although transcript import works.
- The Docker panel reports an error when the Docker daemon does not run.
- macOS is not verified automatically.

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
- **CI**: a Docker POSIX harness (`npm run docker:posix`) for Linux x64/arm64, glibc and musl (ADR 0065). The GitHub Actions
  workflow and the `ci-status` branch of that ADR were dropped before release (ADR 0078).
- MIT licence, English README and `README.vi.md`.

### Fixed

- External evidence (daemon job files) keeps the time its source recorded instead of the time it was read, and a session
  that was resumed after a finished job is no longer stuck as completed (ADR 0069).
- Token usage and file links are committed in the same transaction as the read cursor, so a crash can no longer lose usage.

### Not yet in 4.0

All of these arrived after the tag; see Unreleased above.

- Hooks installer (live hook events; the hook entry point exists, but nothing installs it).
- Panels (machine, git, ledger, chain log, logs) and the attempts reader (`chain_log` and `attempts` are validated but not read).
- Search, analytics, alerts and export.
- The read-only MCP server.
- The UI redesign and the Vietnamese UI (i18n).
- The diagnostics bundle command.
- `migrate-workspace --all` (convert one task at a time with `--task`).

### Known issues

- macOS is not verified automatically; the POSIX suites ran in Linux containers (see `docs/platform-support.md`).

## Before 4.0

- **3.0.0**: the Node runtime (TypeScript engine, SQLite metadata database, HTTP API v3 with server-sent events, React web UI,
  CLI) as a walking skeleton next to the Python engine.
- **2.0.2 (2026-10-11)**: session list first in the sidebar; a demo project builder and a screenshot tool.
- **2.0.1 (2026-10-11)**: much lower CPU use of the machine panel; helper processes open no console window.
- **2.0.0 (2026-10-11)**: Python engine split into modules; evidence-based states (RUNNING, IDLE, COMPLETED, FAILED, UNKNOWN);
  incremental transcript reader with token deduplication; task workspaces with an audit trail; a new UI.
