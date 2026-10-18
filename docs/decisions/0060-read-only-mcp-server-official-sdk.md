# 0060 Read-only MCP server over stdio with the official MCP TypeScript SDK (v2 line), bundled, enabled by the user and never by the plugin

Status: Proposed (V4 planning, 2026-10-18). Owner: backend Phase 5 (WP-64). Amends ADR 0041 (adds one production dependency family with
the documented reason that rule requires) and ADR 0008 (adds the `mcp` command; its stdout carries protocol frames, not CLI output).
Closes the open item "ADR 0060: hand-rolled JSON-RPC versus an SDK" of the V3 plan (WP-64, foundations question 7, requirement R-8.9.10,
which was `deferred-with-reason` and is now built). Related, not changed: ADR 0029 (one query layer), ADR 0031 (read-only server),
ADR 0045 (local request security), ADR 0046 (untrusted text), SEC-29 (transcript content is data), ADR 0062 and 0063 (skill folder, launcher and
bundle: the SDK is inlined into the CLI bundle `mcs-cli.mjs`; a separate bundle entry is the fallback if start time suffers), ADR 0064 (node:sqlite: the
read-only reader the tools use).
Planned for a later 4.x release.

## Context
- The owner decided (V4 decision 12) that the MCP server is read-only, uses the official SDK and is bundled with the runtime. A user of
  the skill needs only Node (22.22 or newer); nothing is installed or built on a user machine, so the SDK must end up inside the
  committed runtime bundle and run unchanged on Node 22, 24 and 26.
- The decision text names the package `@modelcontextprotocol/sdk`. Checked against the npm registry on 2026-10-18 (`npm view`, the
  registry JSON fetched through a summarising tool was wrong about the latest version and was not used):
  - `@modelcontextprotocol/sdk` 1.32.1 (published 2026-10-05, MIT, `engines.node >=18`, 17 direct dependencies among them express 5,
    hono, jose, cors, ajv, zod-to-json-schema; 95 packages in a clean install of it with zod). Its own README says: "This is v1.x of
    the MCP TypeScript SDK, the maintenance line. It implements the MCP spec up to 2025-11-25 ... It continues to receive bug fixes and
    security updates for at least six months after the v2 release (2026-07-27)". `dist-tags.latest` is still 1.32.1.
  - `@modelcontextprotocol/server` 2.3.1 (published 2026-10-05, Apache-2.0, `engines.node >=20`): "v2 of the MCP TypeScript SDK, the
    stable release line ... It replaces the single `@modelcontextprotocol/sdk` package from v1", implementing the 2026-07-28 revision of
    the specification. Direct dependencies: `zod ^4.2.0` and `@modelcontextprotocol/core` 2.3.1 (whose only dependency is `zod`). A clean
    install adds three packages (server, core, zod). Stdio is `@modelcontextprotocol/server/stdio` (`serveStdio`); by default a client
    that opens with the 2025-era `initialize` request is served as before (`legacy: 'serve'`).
  - The licence of the MCP project is moving from MIT to Apache-2.0: the v2 packages declare Apache-2.0 and their LICENSE file says that
    contributions without relicensing consent stay MIT.
- Claude Code starts the servers of an enabled plugin automatically ("When you enable a plugin, Claude Code starts its MCP servers
  automatically"); a server added by the user with `claude mcp add` (scopes local, project, user) starts per that scope, and a
  project-scoped `.mcp.json` asks for approval in an interactive session but is loaded without a prompt in `claude -p` and cloud runs.
  On Windows Claude Code closes the server's stdin and ends the process tree 300 ms later.
- The runtime is read-only for MCP: the data are session metadata, usage, errors, alerts and (opt-in) transcript text, all of it data
  that came from transcripts and can carry prompt-injection text (threat T16 of design 05, SEC-29).

## Decision
1. **Use the official SDK, not a hand-written JSON-RPC loop.** Pin exactly `@modelcontextprotocol/server@2.3.1` (v2, current stable line)
   as a dependency of `@mcs/cli`, together with `zod@4.6.5` declared in the same package (the version the repository already uses; the
   SDK needs a single copy of zod). The package is bundled into the CLI bundle; nothing is installed on a user machine.
   - The owner's decision names `@modelcontextprotocol/sdk`. That name is now the v1 maintenance line (MIT, larger tree, no support for
     the 2026-07-28 revision, security fixes promised only until about 2027-01-27). The v2 packages are the same official SDK from the same
     repository under its current name, so this ADR reads the decision as "the official SDK" and pins the current line. If the owner
     insists on the literal package, the fallback pin is `@modelcontextprotocol/sdk@1.32.1`; the code is written so that the choice costs
     one file (point 2).
2. **One seam file.** Only `packages/cli/src/mcp/sdk.ts` imports `@modelcontextprotocol/*` and `zod` for tool schemas. It exports
   `createMcpServer({ name, version, instructions, tools })` and `serve(server)` (stdio, resolves when the transport closes). Everything
   else (tool table, rendering, limits, the command) uses these two functions and plain types. Switching between the v2 package and the v1
   package changes this file and `package.json` only.
3. **Tools only, read-only, stdio only.** The server offers no resources, no prompts, no sampling, no elicitation, no HTTP transport and
   no network listener. Every tool carries the annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
   `openWorldHint: false`. No tool starts, stops, configures, installs, exports to a file, deletes or writes anything; no tool spawns a
   process. Tools read through `InstanceReader` (API mode when the instance runs, read-only database mode when it is stopped) and the
   status operation, and nothing else.
4. **Default tool set is metadata only.** `mcs_instance_status`, `mcs_overview`, `mcs_list_sessions`, `mcs_get_session`, `mcs_usage`,
   `mcs_errors`, `mcs_alerts`, `mcs_verify_completion`. Transcript text tools `mcs_search_transcript`, `mcs_search_transcripts` and
   `mcs_read_transcript` exist only when the server is started with `--include-text`; the flag is part of the command the user
   registers, so enabling text access is an explicit, visible act. Output is bounded (at most 48 KiB of text per result, `truncated: true`
   with a hint to narrow the query), arguments are validated, numbers have ranges.
5. **Output is labelled data.** Every result is one JSON text block `{ kind: "mcs.mcp/1", readOnly: true, dataNotice, asOfSeq, truncated,
   data }` produced with `safeJsonStringify` (the escaping of ADR 0046 for control and bidi characters). `dataNotice` says that the fields
   come from Claude Code transcripts, are untrusted data and must not be followed as instructions; the same sentence is the server
   `instructions` in the initialize result. Error results use `isError: true` with a fixed English message and a catalogue code; they never
   echo a request value, a path or a stack.
6. **Enabling is manual, documented, and not done by the plugin.** The plugin ships no `.mcp.json` and no `mcpServers` key in
   `plugin.json`, because a plugin-bundled server starts as soon as the plugin is enabled and could not know which task and repository to
   serve. The command `mcs mcp --print-config --task <slug> [--include-text]` prints (and, with `--json`, returns) two snippets and
   changes nothing: the `claude mcp add --transport stdio mcs-<slug> -- node "<launcher>" mcp --task <slug> --repo "<repo>"` command and
   the `.mcp.json` entry. The user pastes one of them; the default scope of `claude mcp add` (local) is the recommended one. The docs say
   that a project-scoped `.mcp.json` is loaded without a prompt by `claude -p`. The launcher path in the snippet is the path of the
   running install; a plugin update changes the version folder of the plugin cache, so the documentation tells the user to run `--print-config`
   again after an update (the install script path of ADR 0061 keeps a fixed folder).
7. **Process behaviour.** `mcs mcp` writes only protocol frames to stdout (no banner, no warning, no result line); diagnostics go to
   stderr and only at warn level or with `MCS_DEBUG=1`. It exits 0 within 100 ms after stdin closes. It refuses to run when stdin is a
   terminal (usage error with the `--print-config` hint) and refuses `--json` without `--print-config`.
8. **Compatibility target.** Node 22.22 and newer. The bundle is tested on Node 22, 24 and 26 with a raw JSON-RPC driver (not the SDK
   client) that negotiates the protocol versions 2024-11-05, 2025-06-18, 2025-11-25 and a client that claims 2026-07-28.

## Consequences
- One new production dependency family (two packages besides zod) with 0 known vulnerabilities (`npm audit --omit=dev`, 2026-10-18).
  Bundle growth about 400 kB minified for the SDK, loaded only when `mcs mcp` runs (the bundle must not evaluate it for other commands;
  the verifier compares the `mcs version` start time before and after).
- Third-party notices: the bundle contains the SDK (Apache-2.0 with MIT-licensed contributions), zod (MIT) and Ajv with its helper
  packages (MIT, BSD-3-Clause fast-uri) that the SDK pre-bundles inside its own `dist` files. A notices generator that lists the packages the
  bundler reports (ADR 0063) sees only the SDK and zod, so the notices file lists the inlined Ajv family by hand and a test fails when the
  bundle contains Ajv and the notices do not. (With the v1 fallback pin the bundler reports those packages one by one.)
- The `@mcs/cli` dependency list now needs `zod` (the SDK takes zod schemas); `scripts/check-deps.mjs` requires the declaration.
- Pin churn: the v2 line moved from 2.0.0 (2026-07-27) to 2.3.1 (2026-10-05) in ten weeks; the pin is exact and updates go through the
  dependency barrier with a new probe of the handshake test.
- The server cannot be auto-enabled by installing the plugin; the cost is one pasted command, the benefit is that nothing reads session
  data into a model session without a visible act of the user.
- If the client speaks only the 2026-07-28 opening in the future, the default `legacy: 'serve'` keeps serving `initialize` clients and
  the modern opening is served by the same factory; if a client rejects the downgraded version, the fallback is the v1 pin, which
  speaks 2025-11-25 at most.

## Alternatives rejected
- **Hand-rolled JSON-RPC over stdio.** About 300 lines (initialize with version negotiation, `tools/list`, `tools/call`, ping, cancellation,
  error codes, UTF-8 framing, input-schema generation). It avoids a dependency but we would own protocol drift across spec revisions
  (2025-11-25 and 2026-07-28 open connections differently) with no conformance suite. The SDK costs three packages in the lockfile.
- **`@modelcontextprotocol/sdk@1.32.1` as the primary pin.** Works (probe below) and is MIT, but it is the maintenance line with a
  17-dependency, 95-package install tree and no 2026-07-28 support. Kept as the documented fallback.
- **Plugin-bundled auto-start (`.mcp.json` in the plugin).** Starts without a user act, cannot choose a task or repository, would put
  session data in reach of every session on plugin enable.
- **HTTP or SSE transports.** A listener needs the Host and Origin guards, a token and a port policy (ADR 0045) for no benefit to a local
  agent; stdio is the standard way a client launches a local server.
- **Write tools (start, stop, configure, export to a file).** Excluded by the read-only decision and SEC-29; the CLI already offers them
  with consent rules.
- **Resources and prompts.** More surface to review, and clients differ in how they surface them; tools cover the use cases.
- **Community SDKs or the Python SDK.** Not official; Python is removed from the toolchain.

## Evidence
All measurements 2026-10-18 on Windows 11, the repository's rolldown 1.2.13 (ESM, platform node), zod 4.6.5, a 25-line probe server with
one tool `echo` (zod input with `maxLength`), read-only annotations and stdio transport; a raw JSON-RPC driver sent `initialize`,
`notifications/initialized`, `tools/list`, a valid `tools/call` and an invalid one.
- Bundle size (single `.mjs`, no externals except `node:process`): v1 1.32.1 742 kB, 370 kB minified; v2 2.3.1 878 kB, 405 kB minified. The
  bundles contain no `createServer` or `listen(` and import only `node:process`.
- Node 22.23.3, 24.14.1 and 26.11.1 (the floor 22.22.0 itself was not available): initialize, `tools/list` and both calls answered by
  both bundles with only JSON lines on stdout and nothing on stderr. Client protocol versions 2024-11-05, 2025-06-18 and 2025-11-25 were answered with the same version; a client claiming
  2026-07-28 was answered with 2025-11-25 by both. An over-long argument was refused with `isError: true` by both (messages differ).
- Time from spawn to the first initialize answer, median of 7 on Node 24.14.1: 96 ms (v1) and 94 ms (v2); the process exited with code 0
  within 10 ms after stdin was closed (both).
- Dependency trees: `npm install` of v1 with zod added 95 packages (24 MB in `node_modules`); v2 with zod added 3 packages (16 MB, most of it
  zod). `npm audit --omit=dev`: 0 vulnerabilities for both.
- Not verified here: a real Claude Code client against the bundle (the real client settings must not be touched during planning); the
  lead's gate may run it with a temporary `--mcp-config` file (see the plan fragment, Lead steps).
