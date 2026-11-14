# 0080 One native addon: @lydell/node-pty for the terminal

Status: Accepted (CAW, 2026-11-14). Owner: foundation area (fnd), terminal design (design 01, section 1). Amends 0041 (consequences: "native code is limited to
better-sqlite3 prebuilds"; adds one exact-pinned dependency), 0063 and 0064 (the "no native dependency" statements), by decision of the repository owner (spec Q1).
Their Status lines are updated by the documentation package of the program. Related: 0079.

## Context
The project rule "no native addon" came from `better-sqlite3`, which tried `node-gyp rebuild` on install and failed without Visual Studio (0041); 0064 then moved
SQLite to the built-in `node:sqlite`. The terminal needs a pseudo console with resize. On Windows that is ConPTY, and there is no pure-JavaScript route to it (a spike
of a C# bridge worked but the owner ruled C# out on 2026-11-14: no C#, no Python, no PowerShell compile). The owner decided to use the node-pty family of prebuilt
packages, pinned exactly, working with `ignore-scripts=true`, with the native files shipped inside the bundle folder.

## Decision
1. **One native addon**: `@lydell/node-pty` **1.2.0-beta.18**, exact pin, declared in `packages/engine/package.json` `dependencies` only. Its use is limited to the
   terminal code of the engine behind a platform-neutral `PtyBackend` seam. No other native production dependency may be added (the bundle test gets a narrow
   allow-rule for exactly these files; that rule is a later package).
2. **Platforms**: the win32-x64 and win32-arm64 prebuilds are shipped and tested. The lockfile holds all six optional platform packages (win32, linux, darwin on x64
   and arm64) with integrity; on any other OS the terminal reports "not supported on this OS". Linux and macOS support later means more prebuilds and tests only.
3. **Installation**: `npm ci --ignore-scripts` and `ignore-scripts=true` stay. The package and its platform packages have no lifecycle script, and the addon loads
   after an install with scripts ignored (checked below).
4. **Fallback**: if the package is withdrawn, switch to `node-pty@1.2.0-beta.18` from Microsoft; the platform files are byte-identical (measured below), so the pinned
   hashes do not change.

## Evidence (measured or read from the registry on 2026-11-14, Windows 11 10.0.26200, Node 24.14.1, npm 11.11.0)

| | `@lydell/node-pty` 1.2.0-beta.18 (chosen) | `@homebridge/node-pty-prebuilt-multiarch` 0.15.0 | `node-pty` 1.2.0-beta.18 (Microsoft) | `node-pty` 1.1.0 (Microsoft) |
|---|---|---|---|---|
| Licence | MIT | MIT | MIT | MIT |
| Unpacked size | main 14.7 KB; win32-x64 package 12.3 MB (10.6 MB is `.pdb`, not shipped) | 6.4 MB, all platforms plus C++ sources | 26.9 MB, 49 files | 64.4 MB, 286 files |
| Lifecycle scripts in the install closure | none (0 over the installed tree) | `install` (prebuild or `node-gyp rebuild`), `postinstall` | `install`, `postinstall`, `prepare` | the same |
| Extra runtime dependency | none | `node-addon-api` | `node-addon-api` | `node-addon-api` |
| Loads with `npm install --ignore-scripts` | yes | yes | yes | yes |
| Binaries equal to Microsoft's beta tarball | 8 of 8 sha256 equal (4 files of each Windows platform), and the 10 JS files of `lib/` equal | own `conpty.node` builds, Microsoft's `conpty.dll` and `OpenConsole.exe` | reference | older binaries |
| stderr after `kill()` | 0 bytes (9 of 9 runs) | 0 bytes (3 of 3) | 0 bytes (3 of 3) | 967 bytes, uncaught `AttachConsole failed` (3 of 3) |
| Provenance | registry signature | registry signature and SLSA provenance | registry signature | registry signature |
| Maintainers, tag | one maintainer, `latest` is the beta | eight, `latest` is 0.15.0 | Microsoft, tag `beta` | Microsoft, `latest` |

`conpty.dll` and `OpenConsole.exe` carry a Microsoft Authenticode signature (file version 1.25.2603.03002, checked with `X509Certificate.CreateFromSignedFile`);
`conpty.node` is unsigned, as every Node addon is. The comparison was made with `sha256sum` over the extracted tarballs, three runs per kill probe.

Registry integrity of the two shipped platform packages (equal to the `package-lock.json` entries written by this change):

- `@lydell/node-pty-win32-x64`: `sha512-wBSMeAwEL04t694ln+QbLnc98YeF3mAwWm/NP8acYDAobPw/WK7KKpk8z07iyxv0gRH2Z2/L/f6vgtnBgxE0Bg==`
- `@lydell/node-pty-win32-arm64`: `sha512-S6h4G3zYGe+pPQxhlNxg+MvJNUIwXFxhnUufx1QT45TgratKMxQfoGPidvnwoLwuXQ3hqQ7SsI93rH8RUoL09g==`

SHA-256 of the pinned native files (the win32-x64 rows were re-verified against the installed package on the day of this change):

| File | Bytes | sha256 |
|---|---|---|
| `win32-x64/conpty.node` | 293376 | `4d2112f9316c9927145e821f20d470369c7ac8ffe63e981fb62a57c303f7f488` |
| `win32-x64/conpty_console_list.node` | 134656 | `e57843ce4fcac607c8c0fabc89c4c475c9aa5b98166fd6e10f4751882223e500` |
| `win32-x64/conpty/conpty.dll` | 110152 | `3319b484b80bb53d1f4d0a9eb0ea60fd0f61da69db7280ca43b84215f19245ff` |
| `win32-x64/conpty/OpenConsole.exe` | 1062472 | `7f68c840226505004215c0b82d4e502c24b5bc3f4b93c4baaaa19bd679c0def8` |
| `win32-arm64/conpty.node` | 282112 | `308bebfe7811c45383ea21a67bb53d332ce6c7d46c41fc74e0417727874ce85d` |
| `win32-arm64/conpty_console_list.node` | 122368 | `ad254f30cd4709ddf256bf4d05ee27a0e2d4381deb44c3c2cc9b29fbeca16383` |
| `win32-arm64/conpty/conpty.dll` | 106528 | `b3a9f975c51d5b9b96d290bf784e990e3f85203b063c21614457353f566266ff` |
| `win32-arm64/conpty/OpenConsole.exe` | 1110560 | `7fa560be0c9b6c81db5d1b855a4a6e0f3ee5a2ea75d36eebb3ae44443b8d4866` |

The win32-arm64 rows come from the design measurement of the same day; the packaging work package pins them in a reviewed file and fails the build on a
difference, so a wrong row cannot survive.

Behaviour measured on the chosen package: load 5 to 10 ms; first output byte 50 to 60 ms after `spawn`; throughput about 16 MB/s; `kill()` reports exit 77 to 91 ms
later and the root and a grandchild are gone within 1.5 s; a hard-killed host takes its ConPTY children down within 3 s. This change also ran `npm ci --ignore-scripts`
in a scratch copy of the manifests and loaded the package with `require('@lydell/node-pty')`.

## Supply chain controls
- No lifecycle script in the closure; `ignore-scripts=true` and `save-exact=true` stay; `npm ci` for every automated install; `scripts/check-deps.mjs` accepts the
  exact prerelease pin and still refuses a range.
- `package-lock.json` holds the package and its six optional platform packages with `resolved` and `integrity`.
- Later packages add per-file sha256 pins for the shipped native files (a changed binary fails a test), the bundle manifest and the third-party notice, and keep the
  module external to the bundle, loaded by path.
- `npm audit` stays in `npm run ci`. The packages of this change add no advisory.

## Update procedure
A new exact version needs an addendum to this ADR with the same evidence table, regenerated pins, a comparison against the matching `node-pty` tarball, and a rerun of
the real-ConPTY test suite on x64 and, by hand, on arm64.

## Consequences
- The beta tag and the single maintainer are distribution risks, not unknown code: the bytes are Microsoft's, and the fallback above exists.
- The committed bundle grows by about 3.3 MB when the native files are added (a later package). `OpenConsole.exe` and `conpty.dll` are shipped while the default uses
  the inbox conhost, because the owner asked for them and OpenConsole stalls the child about 3 s until a terminal answers its DA1 query (measured).
- `kill()` forks a short Node child to list the console processes; in inbox mode the natural exit event arrives about 1 s after the last output.

## Alternatives rejected
- `@homebridge/node-pty-prebuilt-multiarch`: install scripts, an extra dependency, and its own unreviewed `conpty.node` builds.
- `node-pty` 1.1.0: uncaught error noise after `kill()` (967 bytes in 3 of 3 runs), 64 MB, install scripts, no Linux prebuilds.
- `node-pty` 1.2.0-beta.18 from Microsoft: 27 MB, install scripts, `node-addon-api`; kept as the fallback.
- C# bridges, `script`, `winpty`: ruled out by the owner or without resize support.
