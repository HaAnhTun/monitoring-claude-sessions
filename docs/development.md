# Development

The repository holds tools only: no task workspaces, no transcripts, no project data. Task workspaces
(`<repo>/.claude/monitor/tasks/`) belong to the monitored project. Read [architecture.md](architecture.md) first.

## Setup

Node 22.22 or newer (24 recommended). All development happens in the npm workspace `runtime/`:

```bash
cd runtime
npm ci
npm run build          # tsc -b for every package, the Vite build of the web UI, the build stamp
```

## Tests and checks

| Command (in `runtime/`) | What it runs |
|---|---|
| `npm test` | the unit, web, integration, isolation and resilience projects (integration needs `npm run build` first) |
| `npm run test:unit` | unit and web tests only, from the TypeScript sources (no build needed) |
| `npm run test:tooling` | repository rules: plugin layout, launcher, install script, bundle, CI scripts, environment variables |
| `npm run test:slow` | the slow suites |
| `npm run test:e2e` | Playwright end-to-end tests of the web UI |
| `npm run lint`, `npm run typecheck`, `npm run format:check` | ESLint, TypeScript, Prettier |
| `npm run check:deps` | the dependency policy (ADR 0041) |
| `npm run schemas:check` | the generated JSON Schemas and `docs/api/reference.md` are current (`npm run schemas` regenerates) |
| `npm run ci` | every gate in a fixed order with a result table (`npm run ci:full` adds the slow suites and e2e) |
| `npm run docker:posix` | the gates in throw-away Linux containers (Node 22, 24, 26, Alpine, arm64 emulation); needs Docker |

Tests use temporary folders and synthetic Claude homes from `packages/testkit`, never the real `~/.claude`. Ports in tests stay in
18000-18999.

`npm run dev` runs the server from the TypeScript sources and the Vite dev server with the API proxied to it.

## The bundle

Users run the committed bundle in `skills/monitoring-claude-sessions/bundle/`, so every change to runtime code must ship a
rebuilt bundle in the same commit:

```bash
npm run bundle         # rebuild the bundle (deterministic, rolldown)
npm run bundle:check   # fail when the committed bundle differs from a fresh build
```

`bundle/THIRD-PARTY-NOTICES.txt` is generated with the bundle. A dependency change needs an ADR (ADR 0041).

## Running from a checkout

The launcher `skills/monitoring-claude-sessions/scripts/mcs.mjs` runs the bundle when it exists. `MCS_LAUNCHER_MODE=dev` makes it
run the checkout build (`runtime/packages/cli/dist/main.js`) instead, which needs `npm run build`. A running monitor executes the
code it started with: after a change, `status --task <slug>` shows `outdated: true`; apply it with `restart --task <slug>`.

## CI

`.github/workflows/ci.yml` runs the gates on Windows x64 (Node 24) and Ubuntu x64 (Node 22.22, 24, 26), a lean job on macOS arm64 and the
end-to-end tests; a final job writes a JSON summary to the `ci-status` branch, readable with `git fetch` (ADR 0065).

## Conventions

- English in code, comments, identifiers, commit messages and docs; `README.vi.md` is the Vietnamese README.
- No personal data (names, emails, home paths, session ids, tokens) in code, tests, fixtures or docs.
- New configuration key, state rule, API route or command: see "Where to change what" in [architecture.md](architecture.md).
- Decisions go into an ADR under [decisions/](decisions/).
