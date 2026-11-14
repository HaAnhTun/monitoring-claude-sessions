# 0082 Native files in the bundle: layout, pins, staging, loading by path, narrow allow-rule

Status: Accepted (CAW, 2026-11-15). Owner: boundaries area (BOUND), packaging design (design 01, sections 2.1 to 2.6) with the lint
rules of designs 02 (section 5.1) and 04 (section 7). Amends 0063 (item 3 `external`, item 6 notices, item 7 cadence, the consequence
"native addons cannot be bundled", item 8 `.gitattributes`), 0064 (the "no native addon" tooling rule) and 0041 (the `ws` entry of the
avoid list is lifted for the terminal code of the server, as 0081 announced). Their Status lines are updated by the documentation
package of the program. Related: 0079, 0080, 0081.

## Context
0080 allows one native addon, `@lydell/node-pty`, for the terminal. A bundle has no `node_modules`, and a native module cannot be
inlined by a bundler, so the files of the addon must travel inside the bundle folder and be loaded by path. The rule that kept native
code out of the bundle (`bundle.test.ts` "bundles no native addon", the global `ws` and addon bans of `eslint.config.js`) must become
an explicit narrow allow-rule, so that this one addon is possible and nothing else slips in with it.

## Decision

1. **Layout.** The bundle gets a folder `native/<target>/` for each pinned target (`win32-x64`, `win32-arm64`). It holds the platform
   package of `@lydell/node-pty` without the `.pdb` files: `package.json` (`"type": "commonjs"`, which makes the `.js` files next to
   the `.mjs` bundle CommonJS), `LICENSE`, `README.md`, the 12 JavaScript files of `lib/` (text, LF) and four binaries in
   `prebuilds/<target>/` (`conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll`, `conpty/OpenConsole.exe`). `lib/` and
   `prebuilds/<target>/` keep the relative positions that node-pty's own loader expects. About 1.65 MB per target.
2. **Pins.** `runtime/scripts/native-pins.json` is the single reviewed source: per target the package name, its sha512 `integrity`
   (equal to the `package-lock.json` entry), the `text` patterns (`package.json`, `LICENSE`, `README.md`, `lib/*.js`, `lib/shared/*.js`,
   `lib/worker/*.js`) and the `binary` files with byte size and sha256 (the table of 0080). A text pattern that matches nothing, a
   pinned binary that is missing or differs, or a file the pins do not name is handled strictly: the first two fail the build, the
   third (a `.pdb`) is ignored. The file is validated on every read (exact keys, safe relative paths, hash formats); it is changed
   only in a reviewed commit (update procedure below).
3. **Staging** (`runtime/scripts/native-stage.mjs`, Node only, no dependency). A target comes from the first source that has it:
   the installed package (`npm ci` installs only the one of the host platform), the cache `node_modules/.cache/mcs-native/`, a folder
   of tarballs named by `$MCS_NATIVE_TARBALLS` (an offline gate; a folder without the tarball is an error, never a reason to use the
   network), or `npm pack <package>@<version>` into a temp folder. Before a byte is used: the pins and the lockfile must agree
   (version and integrity); a tarball must have exactly that sha512; the pure-Node tar reader refuses `..`, absolute, drive-letter,
   backslash and link entries, a file named twice, a damaged header or checksum and an archive that unpacks to more than 64 MiB;
   only the files the pins name are extracted, into a temp folder that replaces the cache only after every file passed; every binary
   must have the pinned size and sha256 and every text file no NUL byte; `package.json` must name the pinned package and version. An
   installed package that fails a pin is an error (run `npm ci`), a damaged cache is discarded and staged again.
4. **`bundle.mjs`.** `external` gains `/^@lydell\/node-pty/` (a stray static import leaves a visible `import` that the bundle test
   rejects instead of silently inlining a library that cannot work inlined) and `bufferutil`, `utf-8-validate` (the native optional
   peers of `ws`, required inside a try/catch that does without them, 0081). `buildBundle({ native })` copies, for each target, the
   text files with LF line ends (the repository has `* text=auto eol=lf`, so a fresh checkout and a fresh build agree) and the binaries
   byte for byte after the pin check; everything is read and checked before the output folder is created, so a failure writes nothing.
   The manifest needs no change: it lists every file below the bundle, native files included. The notices list one entry per
   platform package (name, version and SPDX id from its `package.json`, the staged `LICENSE` text); the licence allow list applies.
   New flags: `--no-native` (stage nothing) and `--native-targets <list>` (only these pinned targets; they exclude each other); they
   apply to `--out`, `--check` and the tracked write alike. **Default:** the native files are part of a build that has the server or
   the CLI entry (the entries that load the addon: `NATIVE_ENTRIES`); a build of the hook entry alone, such as the hook tests, stages
   nothing unless `native` asks for it. This keeps the many test builds of other areas free of network access without editing them.
5. **Loading by path.** The engine never imports the package. The loader (`engine/src/terminal/node-pty-loader.ts`, a later package)
   does `createRequire(import.meta.url)` and requires `native/<platform>-<arch>/lib/index.js` in the bundle layout, and
   `@lydell/node-pty` from `node_modules` in a checkout. A bundle never falls back to `node_modules` (there is none) and a checkout
   never looks at `bundle/native`. That is why the one `@lydell/node-pty` literal in the server and CLI bundles is a `require`, never
   an `import`.
6. **The narrow allow-rule of the bundle test.** `bundle.test.ts` "bundles no native addon outside the pinned terminal files and
   requires no package at run time except the terminal source-mode fallback" keeps its three checks (no `better-sqlite3`, only
   `node:*` import specifiers, a `require` names only a built-in, an optional peer or generated code text) with exactly one extra
   literal: `@lydell/node-pty`, accepted as a `require` in `mcs-server.mjs` and `mcs-cli.mjs` only (the engine barrel pulls the loader
   into the CLI for `check`). `mcs-hook.mjs` stays `node:*` only. `bundle-native.test.ts` proves the rest: the file set of
   `native/<target>/` equals the pins, no `.pdb`, no CR in a text file, each binary has its sha256, no `.node`, `.dll`, `.exe`, `.so`
   or `.dylib` file exists outside `native/<pinned target>/prebuilds/`, two builds are byte-identical, the manifest and the notices
   list the files and packages, and a tampered binary or a tarball with the wrong integrity makes the build fail before it writes.
   A probe entry that imports `ws` shows `ws` bundled and its optional peers external. Tests that are not about the native folder
   pass `native: false` or `--no-native`, so `npm run test:tooling` needs no network.
7. **Lint rules** (`runtime/eslint.config.js`, probes in `tests/tooling/lint-rules.test.ts`): only `import type` of
   `@lydell/node-pty` anywhere (a value import, `node-pty`, the homebridge fork and `@lydell/node-pty-*` are banned in every package
   and test); `ws` stays on the avoid list everywhere except `packages/server/src/terminal/**` and its tests, where the other
   server rules still hold (no process, no cli, no addon value import); the `WebSocket` global only in `web/src/terminal/ws-client.ts`;
   `EventSource` only in `stream/stream-client.ts` and `terminal/events-client.ts`; `@xterm/*` only in `terminal/xterm-loader.ts`,
   as a static import (`no-restricted-imports`) and as a lazy `import()` (`no-restricted-syntax`, which the import rule does not
   see). Web test files follow the existing test rule set for imports, as for every other web import rule.
8. **`.gitattributes`.** `skills/*/bundle/native/**/*.node`, `*.dll` and `*.exe` are `-text`: Git detects the NUL bytes anyway, this
   makes it explicit. `linguist-generated` already covers the folder.
9. **Cadence.** Unchanged from 0063 item 7: the tracked bundle is lead-owned output, regenerated at barriers, and no feature package
   regenerates it. `npm run bundle` and `npm run bundle:check` now stage the native files, so they need the network (`npm pack` of
   the platform package that is not installed) or `$MCS_NATIVE_TARBALLS` (a folder with the `npm pack` tarballs, named like
   `lydell-node-pty-win32-arm64-1.2.0-beta.18.tgz`); the Docker harness mounts such a folder. The release gate runs the variant with
   `--bundle`.

## Update procedure
A new exact version of the addon is an addendum to 0080 with the evidence table, then in one reviewed commit: the pin in
`packages/engine/package.json`, the lockfile, `native-pins.json` (integrity of both platform packages, bytes and sha256 of the eight
binaries, compared against the matching `node-pty` tarball), the regenerated bundle, and a rerun of the real-ConPTY suite on x64 and, by
hand, on arm64.

## Evidence
- The four win32-x64 binaries of the installed package and the sha512 of the win32-arm64 tarball equal the pins (checked on the day of
  this change); an offline `bundle.mjs --out` with `$MCS_NATIVE_TARBALLS` built both targets (44 files with `--no-web`), `--check
  --against` that folder passed, and the notices list both platform packages. The arm64 binaries are staged and hashed but never
  executed: there is no ARM64 Windows machine, so their equality with Microsoft's published binaries is the evidence.
- `native-stage.test.ts` (tar reader, pins, every refusal, the four sources, determinism), `bundle-native.test.ts`, `bundle.test.ts`,
  `bundle-notices.test.ts` and `lint-rules.test.ts` carry the rules above; a mutation of each guard (hash check, `..` refusal,
  integrity checks, link refusal, LF conversion, each lint rule) makes at least one test fail.

## Consequences
- The bundle grows by about 3.3 MB once the lead regenerates it with the native folder. Git stores each binary once per addon
  version, because their bytes do not change between regenerations.
- `bundle:check` and `npm run bundle` depend on the network or a tarball folder; every other test build avoids both through
  `--no-native` / `native: false`, and hook-only builds through the default.
- `OpenConsole.exe` and `conpty.dll` are Microsoft-signed executables inside the skill folder; the loader does not use them by default
  (0080).
- A new lint rule per boundary means a package that needs one of these globals or packages in another file must change the rule and
  its probe in the same commit, with a documented reason.

## Alternatives rejected
- Inlining the addon with a bundler plugin: native modules resolve their `.node` files relative to their own location.
- Shipping `node_modules` or running `npm ci` on the user's machine: needs npm and the network at install time (0062, 0063).
- Staging without a lockfile or pins check: a tarball or a cache would be trusted by name.
- Staging both targets for every build: it makes the many hook-only test builds of other areas need the network.
- Committing the staged files outside the bundle: a second copy that would drift from the pins.
