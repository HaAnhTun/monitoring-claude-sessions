# 0041 Dependency policy: exact pins, ignore-scripts, check-deps gate, avoid list

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling design (05 sections 2.2, 2.5, 3.2, 5.3 S-DEP).

## Context
The runtime processes sensitive transcripts on the user's machine and is installed by the launcher with `npm ci`. With npm workspaces,
hoisting lets a package import something it never declared. better-sqlite3 13.0.3 lockfile installs try `node-gyp rebuild` and fail
without Visual Studio unless scripts are ignored.

## Decision
- Exact versions only (`.npmrc save-exact=true`), versions from `docs/research/stack-versions.md` section 8; one lockfile; `npm ci`
  for every automated install.
- `.npmrc`: `ignore-scripts=true`, `save-exact=true`, `fund=false`, `update-notifier=false`. No `engine-strict`, no `min-release-age`
  in `.npmrc` (npm 10 warns on unknown keys); updates use `npm install <pkg>@<x.y.z> --min-release-age=7` on npm >= 11.10.
- `scripts/check-deps.mjs` (zero-dependency) is a CI gate: exact specs, equal workspace versions, only the jsx-a11y override, every
  import declared in the importing package (tests may use dev and root dev dependencies), registry host check (slice S1).
- Avoid list enforced by ESLint `no-restricted-imports`: axios, node-fetch, lodash, moment, date-fns, uuid, dotenv, commander, yargs,
  ws, socket.io, cors, body-parser, jsdom, rehype-raw, marked, markdown-it, ts-node, tsx, pino (pino is the documented logger fallback; adding it
  needs an ADR that supersedes the in-house logger).
- Any new dependency needs an ADR with purpose, size, maintenance status and the version check evidence.
- `npm audit --audit-level=low` in `npm run ci`.

## Consequences
- No dependency lifecycle script ever runs (including our own root scripts): post-install work is explicit (launcher writes the install stamp).
- Native code is limited to better-sqlite3 prebuilds; unsupported platforms are documented (fallback `node:sqlite`, D7).

## Alternatives rejected
- Caret ranges + lockfile: `npm install` drift and unreviewed upgrades.
- eslint-plugin-import `no-extraneous-dependencies`: an extra plugin for one rule; does not check versions or overrides.
- Enabling scripts and installing a compiler: fails on this machine and widens the supply-chain surface.

## Evidence
- 2026-10-11, npm 11.11.0: `npm ci` in a clean copy with this `.npmrc`: 397 packages in 6.8-7.2 s offline, 15.7 s with an empty cache,
  0 vulnerabilities, lockfile byte-identical; negative probes (undeclared `vitest` in engine src, `^5.3.0` in server, undeclared
  `@mcs/testkit` in web e2e) each failed `check-deps` (design 05 section 9, E2, E3, E20).
- `stack-versions.md` sections 6, 9, 10 (node-gyp failure without `ignore-scripts`; Node security guide recommends ignore-scripts,
  exact pins, `npm ci`, `--min-release-age`).
