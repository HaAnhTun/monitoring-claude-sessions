# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local monitor of Claude Code sessions with a terminal for them (the Claude Agent Workspace program, CAW; ADR 0079). The monitoring part is read-only: it reads transcripts in
place, keeps a small metadata database per task and serves a loopback dashboard (`127.0.0.1`). The terminal part is active: it starts, writes to and kills the `claude`
processes the application itself started, behind an access code. It ships as a Claude Code skill (`skills/monitoring-claude-sessions/`) and a plain CLI (`mcs`). Node only,
Node >= 22.22, no Python, no C#, no native addon except the terminal one (`@lydell/node-pty`, ADR 0080). Read `README.md` for the feature list and `docs/architecture.md` for the model.

## Commands

All development is in the npm workspace `runtime/`; run these from there. Details: `docs/development.md`.

```bash
npm ci
npm run build                 # tsc -b, the Vite web build, the build stamp (needed before integration/isolation/resilience tests)
npm run lint                  # eslint, --max-warnings 0
npm run typecheck
npm run format:check          # prettier; `npm run format` writes
npm test                      # unit + web + integration + isolation + resilience
npm run test:unit             # unit + web only, from the TypeScript sources, no build needed
npm run test:tooling          # repository rules: plugin layout, launcher, install script, bundle, local CI, env vars
npm run ci                    # every gate in a fixed order with a result table (--bundle, --full add more)
npm run docker:posix          # the gates in Linux containers (needs Docker)
```

Single test (Vitest projects are `unit`, `web`, `integration`, `isolation`, `resilience`, `slow`, `tooling`):

```bash
npx vitest run --project unit packages/engine/src/lifecycle/some.test.ts
npx vitest run --project integration packages/server/test/some.int.test.ts   # run `npm run build` first
npx vitest run --project tooling tests/tooling/bundle.test.ts -t "bundles no native addon"
```

- Run the monitor from a checkout: `node skills/monitoring-claude-sessions/scripts/mcs.mjs <command> --repo <dir>` runs the committed bundle; `MCS_LAUNCHER_MODE=dev` runs the checkout build (`runtime/packages/cli/dist/main.js`). `npm run dev` runs the server and the Vite dev server.
- On a busy machine the default of about 11 forked Vitest workers makes the process-spawning tests time out. Set `VITEST_MAX_WORKERS=3` when running `npm run ci` or the integration/isolation projects.
- Tests use temp folders and synthetic Claude homes from `packages/testkit`, never the real `~/.claude`. Test ports stay in 18000-18999. No `sleep` in tests (a lint rule).

## Things that must change together

- **The committed bundle.** Users run `skills/monitoring-claude-sessions/bundle/`, not the sources. A change to runtime code ships a rebuilt bundle in the same commit (`npm run bundle`; `npm run bundle:check` fails when it differs from a fresh build). Never edit the bundle by hand.
- **Generated contracts.** `schemas/**` and `docs/api/reference.md` come from the zod contracts in `packages/shared`: run `npm run schemas` after a contract change (`schemas:check` verifies).
- **A new dependency needs an ADR** (`docs/decisions/0041`): exact pins, one shared version, and every import declared in the importing package (`npm run check:deps`). The terminal added `@lydell/node-pty` (engine, the one native addon, ADR 0080) and `ws` (server, terminal code only, ADR 0081).
- **Config keys, API routes, commands, state rules:** the "Where to change what" table in `docs/architecture.md` lists the files; a command taught by `SKILL.md` also goes into `CLI_COMMANDS` of `tests/tooling/plugin-layout.test.ts`.
- Decisions are recorded as ADRs in `docs/decisions/`; design notes are in `docs/design/` (partly historical).

## Architecture (the parts that need several files to see)

- **Package layering is enforced by ESLint** (`runtime/eslint.config.js`): `shared` is isomorphic (zod only, no Node built-ins); `engine` is the Node domain (no HTTP, UI or CLI); `server` sits on `engine` + `shared` and never touches the SQLite driver or child processes; `cli` writes output only through `io/terminal.ts`; `web` is browser-only, talks to the server over HTTP and imports only `shared`. Change the rule and `docs/design/05-tooling-testing-security.md` together.
- **One process per task** (a task workspace is `<monitored repo>/.claude/monitor/tasks/<slug>/`, not in this repo). The launcher imports `bundle/mcs-cli.mjs`; `start` spawns a detached `mcs-server.mjs` with its own SQLite file (`data/monitor.db`, built-in `node:sqlite` behind the single seam `engine/src/db/driver.ts`), a control channel (named pipe or Unix socket) and a `state.json`. `stop` verifies the process identity before killing; `status` compares the code stamp with the files on disk (`outdated`, fixed by `restart`).
- **Data flow:** transcripts (`<claude home>/projects/**.jsonl`, subagents, workflows, plus job and registry files) are tailed incrementally into one ingest writer transaction (events, tool calls, token usage deduplicated by `message.id`, file links, cursor) → lifecycle facts → one query layer → HTTP `/api/v3/*` plus an SSE stream → the React UI. Hooks are an opt-in second source.
- **The database holds metadata only.** Transcript text is read from the file on request and never copied into the database.
- **State model:** execution state (running, working, waiting_*, turn_ended, completed, failed, stale, unknown) is derived from facts with evidence, basis and confidence; a transcript alone never proves completion (`turn_ended`). Execution state, monitor health and data freshness are three separate things.
- **Monitoring read-only, terminal active (ADR 0079):** the monitoring routes, the MCP server and the skill never write to a transcript and never start, stop or signal a process. Only the terminal service starts, writes to, resizes and kills `claude` processes that the application itself started, and every write route and the terminal WebSocket need the per-start access code. The MCP server and the skill never touch a terminal. Local: loopback bind, `Host`/`Origin` checks (a safeguard, not authentication), monitoring routes are `GET` except a body-less ingest nudge, strict CSP, transcript text rendered as text, no outbound network code.
- **Regex dialect:** `session_rules[].match` and `attempts.*` are JavaScript regexes compiled with the `v` flag (escape `-` inside classes; no `(?i)`); a Python-style pattern is refused with a hint to run `migrate-workspace`.

## Conventions

- English in code, comments, identifiers, commit messages and docs (`README.vi.md` is the Vietnamese README). No personal data (names, emails, home paths, session ids, tokens) in code, tests, fixtures or docs.
- Commit messages: `caw CAW-NN: <summary>` for the CAW program (earlier V4 work used `v4: <summary>` or `v4 WP-nn: <summary>`).
- CI is local only (ADR 0078): there is no GitHub Actions workflow. Before a push run `npm run ci` (with `-- --bundle` when the bundle changed). Run gates on a clean checkout (`git worktree add --detach <dir> HEAD`), not only on the working tree: code that depends on an uncommitted file passes locally and fails there.
- On Windows with Git Bash never redirect to `NUL` (it creates a file named `NUL` that breaks later tools); use `/dev/null`. A large heredoc with quotes can fail: write a file and run it.

## Work-package markers and `.dev/`

- Some shared files contain `// @wp-begin WP-nn` … `// @wp-end WP-nn` blocks. They mark which work package owns the lines and are removed only by the planned cleanup; do not delete them or edit inside another work package's block.
- `.dev/` is git-ignored (`.git/info/exclude`; the Python-free guard skips folders named `.dev`) and holds local working material: `mcs-v4/` (the V4 plan and decisions, the orchestration kit with `wp-gate.mjs` and `mcslock.mjs`, QA reports, backups), `workflows/` (Workflow scripts), `showcase/`, `mcs-archive/`. Nothing there is part of the product.
- **Open work:** WP-123 (responsive/keyboard/language contract suite and the rewrite of `skeleton.spec.ts`) and WP-124 (final UI sweep: strict literal-text audit, retire the deprecated helpers, retune the bundle budget) are not finished; their partial files are in `.dev/mcs-v4/wip-wp123-124/`. M7 (hardening) and M8 (publication, history rewrite) have not started.
