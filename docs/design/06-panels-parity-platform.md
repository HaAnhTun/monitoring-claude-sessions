# 06 - Panels, platform specifics and legacy parity

Status: Phase 1 design, implementation-grade. Author: panels/platform/parity designer, 2026-10-11.
Revision 3 (2026-10-11): second critic issues N-01, N-05, N-06, N-10, I-05, I-06, I-12, I-18 and contract-registry rows C06, C11-C15,
C28, C36, C40-C44, C47, C57 applied (`98-contract-registry.md` arbitrates names).
Revision 4 (2026-10-11, reconciliation of the phase 1b residuals): N-03 (normative `panelOptions` key table in 3.5, module written by 01
S1), I-36 (engine time source is 01's `Clock` `{ now() }` from `shared/src/time.ts`: 3.2, 3.5, 3.10.7, 4.9, 5.4), C18 (02's engine
evidence type is `LifecycleEvidence`, 3.10.7), C26/N-09 (benchmark poll keys, 8.3), C39 (`data/exports/`, 7.1 item 1), N-11/C23
(`hooks status`, 7.1 item 11), N-12 (`T-LC-16` is 01's spawn rule, PP1), G5 budget list B1-B7 (5.9, as ADR 0056 and PP10).
Owner of this file and of ADRs 0050-0059. Inputs: `00-foundations.md` (D1-D15, open questions 2 and 6), the owner's brief
(sections 8.1, 12, 13 Phase 6, 14), `docs/research/current-state-backend.md`, `current-state-frontend.md`, `transcript-survey.md`,
`claude-code-hooks.md`, `stack-versions.md`, the legacy code (`src/backend/panels.py`, `proc.py`, `state.py`, `sessions.py`,
`reader.py`, `server.py`, `cli.py`) and `docs/design/04-ui.md` (panel types and testkit proposal, reconciled in 3.3 and 6.1).

Reading guide for implementers (each slice in section 13 names the sections it needs):

| You implement | Read |
|---|---|
| child-process helper, platform utilities | 2, 4, 3.6 |
| machine / git / logs / ledger / chain panels | 3.1-3.9 |
| attempts ingestion and matching | 3.10, 5.7, 5.8 |
| golden capture, parity harness | 5 |
| `@mcs/testkit` (fixtures, demo CLI) | 6 |
| operations docs | 7 |
| benchmarks | 8 |

Terms: **legacy** = the Python engine (`template/viewer.py` + `src/backend`), the oracle. **Node** = the new runtime. **UNVERIFIED** =
not measured on a real system yet, with the plan to verify. All times are epoch milliseconds UTC inside the runtime (D10) unless a
field name ends in `S` (seconds).

---

## 1. Decisions in one table

| # | Decision | Section | ADR |
|---|---|---|---|
| P1 | Windows per-process memory: one-shot hidden `powershell.exe -EncodedCommand` with a fixed script (.NET `Process.GetProcesses()`, fallback `Get-Process` for Constrained Language Mode), demand-driven, refreshed at most every 20 s, stale-while-revalidate. No native dependency, no persistent helper, no `tasklist`. | 3.7 | 0050 |
| P2 | Every child process goes through `engine/src/platform/exec.ts` (security rules: design 05 S-PROC: no shell, `.exe` only, env allow-list, timeout, output cap). The signature `execFileText(spec: ChildSpec, signal?) -> ChildResult` of 3.6 is the single authoritative one (critic I-06; 01 4.2 imports it); this design adds the kind tag, a 2-slot semaphore, executable resolution and spawn statistics. `spawnDetached`/`spawnForeground` keep 01's signatures in the same file. | 3.6 | 0051 |
| P3 | Transcript change detection: stat polling is the source of truth; recursive `fs.watch` is only a wake-up hint. | 4.4 | 0052 |
| P4 | Legacy oracle: a deterministic golden capture (frozen clock, seeded uuids, `TZ=UTC`, temp fixtures, in-process legacy server on a port in 18850-18874) writes raw legacy responses as committed goldens under `tests/legacy-parity/golden/`, with a `--check` drift mode; it is the single golden-capture procedure (critic I-09: 05 4.11.4 and ADR 0044 adopt it) and the engine behind 05's `npm run parity:capture` wrapper (CH-2, resolved). | 5.2 | 0053 |
| P5 | `@mcs/testkit` reproduces the legacy fixture trees byte for byte (`pyDumps`), verified against the golden manifest, so parity tests run without Python. | 5.3, 6 | 0054 |
| P6 | Latent legacy defects: an explicit fix/reproduce table; parity tests assert the deliberate differences instead of hiding them. | 5.8 | 0055 |
| P7 | Cutover gates before SKILL.md may name the Node engine primary; Python stays the documented fallback for one minor release after cutover. | 5.9 | 0056 |
| P8 | Git panel: `--no-optional-locks`, one `status --porcelain=v2 --branch` per refresh, `log` only when HEAD moves. | 3.8 | 0057 |
| P9 | One file-I/O module `engine/src/platform/fsx.ts` for the whole engine (critic I-28): atomic replace retries `EPERM/EBUSY/EACCES` for up to 3 s; readers read-and-close with 01's retry rule. Shared legacy JSON files are serialized only by 01's `writePyJsonFile` (PyJson, ADR 0003), which writes through `fsx.atomicWriteFile`. | 4.3 | 0058 |
| P10 | Panel data is sampled live and never persisted, except attempts runs (persisted lifecycle evidence with incremental chain-log offsets). | 3.2, 3.10 | 0059 |

---

## 2. Evidence (experiments run on this machine, 2026-10-11)

Machine: Windows 11 Pro 10.0.26200, 12 logical CPUs, 15.5 GiB RAM, Node v24.14.1, Python 3.14.3, Windows PowerShell 5.1 and
PowerShell 7 present, `wmic` absent. Scripts in `D:/mvp/private/scratch/mcs-v3/panels-parity/`. Windows CPU accounting has a
15.6 ms granularity; single numbers are medians of 6-10 runs on a machine that was busy with other agents (treat as +-30%).

| Id | Question | Script | Result |
|---|---|---|---|
| E1 | Child CPU of process-list commands (`ProcessStartInfo`, `CreateNoWindow`, `TotalProcessorTime` after exit) | `measure-child.ps1` | `tasklist /FO CSV /NH` 109-188 ms CPU, 241-517 ms wall, 23-26 KB output; `tasklist /FI "IMAGENAME eq node.exe"` 47 ms; `powershell` 5.1 `Get-Process -Name ...` 203 ms CPU, 156 ms wall; `powershell` `Get-CimInstance Win32_Process` 281 ms (plus WMI service CPU not counted); `pwsh` 7 `Get-Process` 391 ms. |
| E2 | Node-side CPU of spawning (`process.cpuUsage` around N calls) | `spawn-cost2.mjs` | `tasklist`: 128-182 ms **Node-side** CPU per call (unexplained, reproducible 3 times); `ping -n 2`: 5 ms; one-shot PowerShell: 13 ms; `git --version`: 13 ms. |
| E3 | Persistent PowerShell helper (stdin protocol) | `persistent-ps.mjs` | start 177 ms wall / 250 ms CPU; then 16 ms CPU and 15 ms wall per query; **working set 73 MB growing to 142 MB after 25 queries** (PowerShell 5.1); 82-99 MB for pwsh 7. |
| E4 | Final production command (P1) | `proclist-final.mjs`, `measure-enc.ps1` | 344 rows, 7.7 KB UTF-8; child CPU median 187.5 ms (max 250); Node-side 7.7 ms; wall 157 ms; the row of the measuring Node process (53.6 MB) equals its `process.memoryUsage().rss` (53.7 MB), so `WorkingSet64` is the same metric as the legacy `WorkingSetSize`. |
| E5 | `os.totalmem/os.freemem` vs `GlobalMemoryStatusEx` | `memcmp.py` | total identical (16,636,239,872); free within the 13.8 MB drift between two Win32 samples taken around the Node call. |
| E6 | CPU% from `os.cpus()` deltas vs `GetSystemTimes` deltas over the same 2 s | `cpu-node.mjs`, `cpu-py.py` | 13% and 13%. `os.cpus()` costs 0.16 ms per call; `freemem+totalmem` 0.002 ms. |
| E7 | `fs.watch` on append (synthetic) | `fswatch-append.mjs` | open-append-close writer (`appendFileSync`): 20/20 events on the file watcher, 20 on the directory watcher, recursive watcher sees the nested path; **writer keeping one handle open: 0/20 events until close** (1 event after close); `fs.statSync().size` correct 20/20 while that handle stays open. |
| E8 | `fs.watch` on live Claude Code transcripts (metadata only, hashed names) | `fswatch-live.mjs` | 4 growing files over 25 s: stat size changes 5/4/10/4, recursive watch events 6/4/12/5 (Claude Code 2.1.x writes are visible to the watcher). |
| E9 | Console windows from children of a detached, hidden Node server | `hidden-console.mjs` (detection validated: minimized visible `ping` has `MainWindowHandle` 52366242, hidden one 0) | server `detached:true` or `false` with `windowsHide:true`: children `ping` with `windowsHide` true/false, piped or ignored stdio: **no window in all 8 cases**. |
| E10 | Windows rename-over semantics | `winfs.mjs` | rename over a target that a Python reader holds open: `EPERM`; retry loop every 50 ms succeeded after the reader closed (52 attempts, 3,030 ms); target held by a Node fd: `EPERM`; Python `os.replace` while Node holds the target: `PermissionError` winerror 5. |
| E11 | Long paths, reserved names, case | `winfs.mjs` | 308-char path: mkdir, write, append, stat, readdir all work; `con`, `nul`, `aux`, `prn`, `com1`, `lpt1`, `con.json`, `nul.txt` **inside a directory** were created as regular files on build 26200 (older Windows maps them to devices); `existsSync('d--MVP')` true for `D--mvp`; `realpathSync.native` returns on-disk case `D--mvp`, `realpathSync` returns the input case; `mkdir` of a case variant: `EEXIST`. |
| E12 | Golden capture dry run (legacy read-only, temp fixtures, in-process server on port 18750, before the 05 port ranges were known; production uses 18850-18874) | `capture_golden_dry.py` | two runs byte-identical after the fixes listed in 5.2.4; fixture tree: 5 sessions (2 RUNNING, 3 IDLE; agents `aaa111`, `bbb222` COMPLETED); demo: 7 sessions (A COMPLETED external, B FAILED external, C and F RUNNING, D and E IDLE, G UNKNOWN; E `events: partial`); attempts A COMPLETED, B FAILED, C RUNNING, F RUNNING; error bodies 400/400/404 captured; goldens 184 KB. The skill working tree stayed clean (`git status --short` empty before and after; `PYTHONDONTWRITEBYTECODE=1`). |
| E13 | `TZ` pinning for local-time parsing | shell one-liners | Python 3.14 on Windows honours `TZ=UTC`/`UTC0`: `mktime(strptime('2026-01-01 00:00:00'))` = 1767225600 (unset: 1767200400, zone Asia/Saigon); Node `TZ=UTC` gives the same. |
| E14 | First full scan of a 70 MB synthetic transcript (62,735 lines, one 1.3 MB line) | `bigscan.mjs`, `legacy_bigscan.py` | Node chunked read (4 MiB) + split at LF + `JSON.parse` + per-id max dedupe: 223-228 ms wall, 235-328 ms CPU, longest event-loop block per chunk 17-20 ms, transient RSS +67-84 MB; legacy reader full usage scan 394 ms; both totals identical (in 47,052, out 1,628,895, cr 1,030,187,855, cc 14,115,600, 15,684 ids). No database writes included. |
| E15 | Baseline memory of a Node server with the pinned deps | `rss-base.cjs` (deps from `stack-smoke`) | bare Node 50 MB; Express 5 + better-sqlite3 (WAL, 20k rows) + zod loaded and listening on 18751: 80 MB; after 200 requests 88 MB; idle CPU over 5 s: 0.00%. Legacy: 27 MB idle, 33 MB one tab (`docs/changelog.md` 2.0.1, not re-measured). |
| E16 | Git command cost in `D:/mvp` (1,184 tracked files), real binary `mingw64/bin/git.exe` | `measure-git.ps1` | `branch --show-current` 15.6 ms CPU / 136 ms wall; `log -3` 15.6 / 129; `status --short` 46.9 / 159; `status --porcelain=v1 -uno` 31.2 / 112. (Through the `cmd/git.exe` shim the child CPU of the real git is not attributed.) |
| E17 | Glob semantics | `globt/` one-liners | Python `glob('**/*.log')` is non-recursive (`**` = `*`), Node `fs.globSync` is recursive; both skip dotfiles. |
| E18 | Window-free start of a detached server | E9 | covered: open question 2 (detached start without console windows) is closed by E9 plus the `execFileText` rule. |
| E19 | `docker ps --format` cost (Docker Desktop running, 4 containers) | `measure-docker.ps1` | exit 0, 31 ms child CPU, 153 ms wall. |
| E20 | Python `re` vs V8 `/\s/u` whitespace over the BMP | `pyws.json` + one-liner | Python-only `\x1c-\x1f`, `\x85`; JS-only `\ufeff`. |
| E21 | Line endings of legacy demo files on Windows | dry-run tree inspection | `chain.log` 378 B, `status.md` 226 B, `demo.config.json` 1,123 B are CRLF (text-mode writes); JSONL files LF. |
| E23 | Children under design 05's env allow-list (`PATH, SystemRoot, TEMP, TMP, HOME, USERPROFILE, LANG`) | `envtest.mjs` | docker, `powershell.exe` (.NET `GetProcesses`) and git exit 0 with output, same as with Windows extras (`windir, ComSpec, PATHEXT, ProgramData, ProgramFiles, LOCALAPPDATA, APPDATA, PSModulePath`). |
| E22 | 8.3 short names | one-liner | `os.tmpdir()` returned the 8.3 short form of the user folder; `fs.realpathSync.native` returned the long name, `fs.realpathSync` kept the short form. |
| E24 | ESLint flat-config override for the platform rule (section 4) | `eslint-platform/run.mjs` (ESLint 10.12.0 from `stack-smoke`, `lintText` with `filePath`) | engine `panels/x`: `process.platform` and `process.stdout` both reported; `platform/x` and `security/paths` (block re-declaring `['error', ...NO_STDIO]`): only `process.stdout`; `shared/src/protocol/x`: nothing. A later block replaces the rule options, so the allow-list keeps the stdio restriction. |

What was NOT measured: Linux and macOS (no machine); a GPO-enforced Constrained Language Mode PowerShell (fallback designed in 3.7.3,
UNVERIFIED); PowerShell blocked by AppLocker (designed as `unavailable`, UNVERIFIED); system-wide CPU attributable to one call (my
attempt `syswide.mjs` was dominated by other agents' load: results -955..806 ms, discarded).

### 2.1 Experiment scripts (scratch, not shipped)

`D:/mvp/private/scratch/mcs-v3/panels-parity/`: `measure-child.ps1`, `spawn-cost.mjs`, `spawn-cost2.mjs`, `persistent-ps.mjs`,
`proclist-final.mjs`, `measure-enc.ps1`, `memcmp.py`, `cpu-node.mjs`, `cpu-py.py`, `fswatch-append.mjs`, `fswatch-live.mjs`,
`hidden-console.mjs`, `winfs.mjs`, `capture_golden_dry.py` (+ `golden-dry/run1`, `run2`), `bigscan.mjs`, `legacy_bigscan.py`,
`rss-base.cjs`, `measure-git.ps1`, `measure-docker.ps1`, `envtest.mjs`, `pyws.json`, `syswide.mjs` (discarded result),
`tasklist-node.mjs`, `eslint-platform/run.mjs` (E24). The 70 MB synthetic file `big-70mb.jsonl` is invented data.

---
## 3. Panels

### 3.1 Inventory: legacy to Node

| Legacy endpoint (`server.py`) | Legacy TTL | Node endpoint | Node source TTL | Persisted? | Behaviour change |
|---|---|---|---|---|---|
| `/api/machine` `{free_gb,total_gb,used_pct,cpu_pct,procs[{name,count,mb}],docker[],now}` | 1.8 s (docker 10 s module global) | `GET /api/v3/panels/machine` | memory+cpu 1.8 s; processes 20 s SWR; docker 15 s SWR | no | process list sampled at most every 20 s (was 1.8 s, Win32 in-process); `docker` failure is a status, not the fake row `(docker unavailable)` |
| `/api/overview` `{ledger[],chain[],branch,commits[],dirty,stop,now}` | 10 s (whole object) | `GET /api/v3/panels/git`, `/panels/ledger`, `/panels/chainLog` | git status 15 s SWR, git log on HEAD change or 120 s, stop file 2 s, ledger 5 s, chain log 5 s | no | split per panel (04-ui `PanelKey`); `--no-optional-locks` (5.8 D17); commits structured |
| `/api/logs` `[{name,age,size,tail[]}]` | 2 s | `GET /api/v3/panels/logs` | 2 s | no | vanished files skipped instead of failing the poll (D25); `**` recursive (E17, D26) |
| `/api/attempts` `[{part,n,model,effort,start,end,exit,status,sid,usage_total,state}]` | 4 s | `GET /api/v3/panels/attempts` | DB read 2 s; chain log ingested incrementally | **yes** (03 tables `attempt_sources`, `attempt_runs`) | full chain-log history instead of a 4,000-line tail; superseded START closed (D20) |
| external state map fed to `/api/sessions` (`server.py:57-60`) | 4 s | design 02 logical event `external.attempt` (3.10.7) | on ingest/match | yes (02 lifecycle facts) | same precedence rule |

The legacy UI shows a panel only if `config.panels[key]` is truthy; the attempts table and external states ignore `panels.attempts`
(`server.py:58,214`). Node keeps that split: `panels.*` gates the panel endpoint; `attempts` + `chain_log` config gates ingestion and
lifecycle evidence.

### 3.2 Modules and file ownership

```
runtime/packages/shared/src/api/panels.ts            PanelKey, PanelResponse, *Panel types, zod schemas incl. PanelResponseSchema (03 keeps every
                                                     API contract under shared/src/api/*.ts; 03's route `panel` uses PanelResponseSchema; critic I-35)
runtime/packages/engine/src/platform/exec.ts         execFileText(ChildSpec) (authoritative, 3.6), resolveExecutable, childStats, semaphore;
                                                     spawnDetached, spawnForeground (01 4.2 signatures); security rules 05 S-PROC
runtime/packages/engine/src/platform/host.ts         hostPlatform, pathsCaseInsensitive (4: the only re-export of process.platform for other modules)
runtime/packages/engine/src/platform/paths.ts        canonicalPath, samePath, toPosixRel (4.1; containment = 05 security/paths.ts)
runtime/packages/engine/src/platform/watch-hint.ts   createWatchHint (4.4)
runtime/packages/engine/src/platform/fsx.ts          atomicWriteFile, readSmallFile, tailLines, pySplitlines, clipCodePoints (3.9, 4.3); the one
                                                     file-I/O module of the engine (01's workspace/fsio.ts wraps it, critic I-28)
runtime/packages/engine/src/platform/glob.ts         globFiles (3.9.4)
runtime/packages/engine/src/platform/process.ts      pidAlive, commandLineOf, forceKill, waitForExit (4.2; 01 4.2 imports them; listRuntimeProcesses
                                                     is 01's, in platform/markers.ts, 01 S4, registry C13)
runtime/packages/engine/src/platform/pytime.ts       pyStrptime, toEpochMs (3.10.4)
runtime/packages/engine/src/panels/source-cache.ts   SourceCache (3.5)
runtime/packages/engine/src/panels/machine.ts        MachineSampler: memory, cpu, processes, docker (3.7)
runtime/packages/engine/src/panels/proc-win32.ts     PROC_SCRIPT_NET, PROC_SCRIPT_CLM, parseProcLines (3.7.3)
runtime/packages/engine/src/panels/proc-posix.ts     parsePsOutput (3.7.4)
runtime/packages/engine/src/panels/git.ts            GitSampler (3.8)
runtime/packages/engine/src/panels/files.ts          ledger, chainLog, logs, stopFile (3.9)
runtime/packages/engine/src/panels/attempts/{parse,state,ingest,match,evidence,repo}.ts   (3.10)
runtime/packages/engine/src/panels/service.ts        PanelService.get(key) -> PanelResponse (3.4)
runtime/packages/server/src/routes/panels.ts         GET /api/v3/panels/:key (3.4)
```
`engine` may import `shared`; `server` imports `engine` and `shared`. Nothing under `panels/` touches another instance: every function
takes the instance context `InstanceContext` of design 01 4.4a / slice S8, declared in `packages/engine/src/runtime/context.ts`
(`createInstanceRuntime` is in `packages/engine/src/runtime/instance-runtime.ts`; critic I-15, registry C15). Fields this design reads:
`instanceId`, `repoDir`, `config`, `clock`, `db`, `errors`, `exec`, `claudeHome`, `mcsHome`, `logger`, `queries` (03 `createQueries`,
session `TokenUsage` for attempts rows). `ctx.clock` is 01's `Clock` (`{ now(): number }`, epoch ms, `packages/shared/src/time.ts`,
critic I-36); every time read in this design is `ctx.clock.now()`. `createPanelService(ctx, { writer })` (3.4) is component 4 of 01's
`createInstanceRuntime(ctx)`, which passes `writer: ingest.writer` (02 4.10: the one `IngestWriter`, shared with this design's attempts
tick). That component's `start()` calls `panels.tickAttempts()` once, then re-arms an unref'd 2000 ms `setTimeout` chain calling it
through one serializer (a firing while a tick runs is skipped; a rejection is logged and pushed to `ctx.errors`, never thrown); its
`stop(deadlineMs)` clears the timer, awaits a running tick (raced against the deadline), then calls `panels.close()` (01 4.4a component
4; critic N-01, registry C57). Nothing in design 02's scheduler drives attempts.

### 3.3 Contracts (`@mcs/shared` `api/panels.ts`)

The `data` types are a strict superset of the types in `04-ui.md` section 13 (same names, same fields; additions marked `+`), so the UI
components port unchanged and can opt into the additions.

```ts
import type { IsoTime } from './time.js';                       // ISO-8601 UTC with Z (D10), 03 shared/src/api/time.ts
import type { TokenUsage } from './entities.js';                // 03 5.5
export type PanelKey = 'git' | 'machine' | 'attempts' | 'ledger' | 'chainLog' | 'logs';
export const PANEL_KEYS: readonly PanelKey[] = ['git', 'machine', 'attempts', 'ledger', 'chainLog', 'logs'];
/** config.json `panels` sub-key for each PanelKey (legacy names). */
export const PANEL_CONFIG_KEY = { git: 'git', machine: 'machine', attempts: 'attempts', ledger: 'ledger', chainLog: 'chain_log', logs: 'logs' } as const;

export type PanelSource =
  | 'memory' | 'cpu' | 'processes' | 'docker'
  | 'git.status' | 'git.log' | 'stopFile'
  | 'ledger' | 'chainLog' | 'logs' | 'attempts';
export type SourceStatus = 'ok' | 'pending' | 'disabled' | 'unavailable' | 'unsupported' | 'error';
export interface PanelSourceState {
  source: PanelSource;
  status: SourceStatus;
  sampledAt: IsoTime | null;        // time of the value being served (may be older than generatedAt: stale-while-revalidate)
  message: string | null;           // English, <= 200 chars, never contains transcript text, prompts or tokens
}
export type PanelStatus = 'ok' | 'partial' | 'error';
//   ok: every enabled source ok; partial: at least one source pending/unavailable/unsupported/error but data present;
//   error: no source produced data (data null). A panel disabled in config is not a response: 404 panel_disabled (3.4, design 03).
export interface PanelResponse<K extends PanelKey = PanelKey> {
  key: K;
  status: PanelStatus;
  generatedAt: IsoTime;
  sources: PanelSourceState[];
  data: PanelDataMap[K] | null;
}
export interface PanelDataMap { git: GitPanel; machine: MachinePanel; attempts: AttemptsPanel; ledger: LinesPanel; chainLog: LinesPanel; logs: LogsPanel }

export interface MachinePanel {
  sampledAt: IsoTime;                                   // memory/cpu sample time
  freeGb: number | null;                                // round(free / 2^30, 2)
  totalGb: number | null;                               // round(total / 2^30, 1)
  usedPct: number | null;                               // round(100 * (total - free) / total)
  cpuPct: number | null;                                // null on the first sample of the process (legacy contract)
  procs: { name: string; count: number; mb: number | null }[];   // sorted mb desc, then name asc
  docker: string[];                                     // "<name> (<status>)" lines; [] when disabled/unavailable/error
  platform: 'win32' | 'linux' | 'darwin' | 'other';     // +
  procsSampledAt: IsoTime | null;                       // +
  procsStatus: SourceStatus;                            // +
  dockerEnabled: boolean;                               // +
  dockerSampledAt: IsoTime | null;                      // +
  dockerStatus: SourceStatus;                           // +
}
export interface GitPanel {
  branch: string | null;                                // null when detached, not a repo, or git missing
  dirty: number | null;                                 // entries in `status --porcelain=v2` (tracked changes + untracked), null if unknown
  stopFile: boolean;                                    // config.stop_file exists (false when not configured)
  commits: { hash: string; subject: string; at: IsoTime | null }[];   // newest first, at most 3
  headOid: string | null;                               // +
  detached: boolean;                                    // +
  repoState: 'ok' | 'not_a_repository' | 'git_missing' | 'error';   // +
}
export interface LinesPanel {
  lines: string[];                                      // ledger: last 30 lines starting with '|'; chainLog: last 10 lines
  file: string | null;                                  // + the configured path as written in config (relative or absolute)
  exists: boolean;                                      // +
  sizeBytes: number | null;                             // +
  modifiedAt: IsoTime | null;                           // +
}
export interface LogsPanel {
  files: { name: string; ageS: number; sizeBytes: number; tail: string[];
           relPath: string;                             // + forward slashes, relative to repo when inside it, else absolute
           modifiedAt: IsoTime }[];                     // +
  matchedFiles: number;                                 // + before the top-4 cut
}
export type AttemptState = 'COMPLETED' | 'FAILED' | 'RUNNING' | 'UNKNOWN';
export interface AttemptsPanel {
  rows: {
    part: string; n: number | null; model: string | null; effort: string | null;
    startedAt: IsoTime | null; endedAt: IsoTime | null; exit: number | null; status: string | null;
    state: AttemptState | null; sessionId: string | null; usage: TokenUsage | null;    // TokenUsage: 03 5.5 (api/entities.ts)
    attemptId: number;                                  // +
    nRaw: string | null; exitRaw: string | null;        // + exact regex group text (legacy semantics use the raw text)
    endReason: 'open' | 'ended' | 'superseded';         // +
    evidence: string;                                   // + English evidence text (3.10.5)
    matchDeltaS: number | null;                         // + session first record time minus startedAt, seconds
  }[];                                                  // start order, last `limit` rows (default 30)
  sourceState: 'ok' | 'not_configured' | 'missing' | 'error';   // +
}
```
Zod schemas: `PanelResponseSchema = z.discriminatedUnion('key', [...])`, one per key, named `GitPanelSchema`, `MachinePanelSchema`,
`AttemptsPanelSchema`, `LinesPanelSchema`, `LogsPanelSchema`, all exported from `packages/shared/src/api/panels.ts`. 03's route
registry (`packages/shared/src/api/routes.ts`) declares route `panel` with `response: PanelResponseSchema` (the generated JSON Schema
and API reference follow from it, 03 section 13). The server does not validate its own output at runtime; contract tests do.

### 3.4 Endpoint `GET /api/v3/panels/:key`

- Route `panel` of design 03 (route table, 6.x): path param `key` in `PANEL_KEYS`, validated by 03's route adapter (an unknown key is
  03's path-validation error). Query: `attempts` only accepts `limit` (integer 1..200, default 30); other keys accept none (03 validation).
- `config.panels[PANEL_CONFIG_KEY[key]] !== true` -> `404 { "error": { "code": "panel_disabled", ... } }` (03 error table). Otherwise
  `200 PanelResponse<key>`.
- Source failures never produce 5xx; they set `sources[i].status` and `status: 'partial' | 'error'`. A thrown programming error is a
  `500 internal_error` and goes to the error ring with `where: 'panel.<key>'`.
- Headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` (API design's middleware). No ETag.
- Cost model: one request triggers at most one refresh per stale source (single flight); N tabs polling cost the same as one (legacy
  guarantee, `server.py:30-50`). No panel timers: with no client nothing is sampled (legacy idle 0.1% of a core). The only periodic
  work is the 2 s attempts tick (3.10), which stats the chain log and reads only appended bytes.
- Panels are not pushed over SSE; the UI polls them (`04-ui.md` `usePanel`). Attempts changes that affect lifecycle reach the UI through
  the lifecycle's own `session` stream changes.

`PanelService` (`engine/src/panels/service.ts`):
```ts
export interface PanelService {
  get<K extends PanelKey>(key: K, opts?: { limit?: number }): Promise<PanelResponse<K>>;
  /** Called every 2 s by the timer of 01 4.4a component 4 (first call at component start); runs attempts ingestion, matching and
   *  evidence publication when configured (3.10). A call while a tick runs returns that tick's promise (never two ticks at once). */
  tickAttempts(): Promise<AttemptsTickResult>;
  stats(): PanelStats;          // exposed as HealthReport.panels (03 6.2, critic I-21)
  close(): void;                // aborts in-flight children; drops events not yet accepted by the writer (3.10.7 step 5)
}
export interface AttemptsTickResult {
  state: 'ok' | 'not_configured' | 'missing' | 'error';   // = AttemptsPanel.sourceState
  linesRead: number; rowsChanged: number; eventsSubmitted: number;
}
export interface PanelSourceStats { refreshes: number; failures: number; lastDurationMs: number | null; lastStatus: SourceStatus | null }
export type PanelStats = Partial<Record<PanelSource, PanelSourceStats>>;   // only sources that were read at least once; in shared/src/api/panels.ts
export function createPanelService(ctx: InstanceContext, deps: { writer: IngestWriter }): PanelService;   // IngestWriter: 02 4.6
```
`PanelStats` and `PanelSourceStats` live in `shared/src/api/panels.ts` so that 03's `HealthReport` can reference them without importing
the engine.

### 3.5 `SourceCache` (single flight, stale-while-revalidate, last good value)

```ts
export interface SourceSpec<T> {
  source: PanelSource;
  ttlMs: number;          // a value younger than this is served without refresh
  firstWaitMs: number;    // with no value yet, wait this long for the first load before answering `pending`
  timeoutMs: number;      // passed to the loader (child timeout or fs budget)
  retryAfterUnavailableMs: number;   // after an `unavailable` result, do not retry before this
  load(signal: AbortSignal): Promise<SourceResult<T>>;
}
export type SourceResult<T> = { status: 'ok'; value: T } | { status: 'unavailable' | 'unsupported' | 'error'; message: string };
export interface CacheRead<T> { value: T | null; sampledAt: number | null; status: SourceStatus; message: string | null }
export class SourceCache<T> { constructor(spec: SourceSpec<T>, clock: Clock, errors: ErrorRing); read(): Promise<CacheRead<T>>; abort(): void }
// Clock: 01 4.4a, packages/shared/src/time.ts ({ now(): number }, critic I-36)
```
`read()` algorithm (entry fields: `value, sampledAt, lastStatus, lastMessage, inflight, nextTryAt`):
1. `now = clock.now()`. If `value !== null` and `now - sampledAt < ttlMs`: return `{value, sampledAt, status: lastStatus === 'ok' ? 'ok' : lastStatus, message: lastMessage}`.
2. If `inflight === null` and `now >= nextTryAt`: `inflight = load(signal)` wrapped so it never rejects (a rejection becomes `{status:'error', message: <Error.message clipped 200>}`).
   On settle: `ok` -> `value = v; sampledAt = clock.now(); lastStatus = 'ok'; lastMessage = null`; otherwise `lastStatus = result.status;
   lastMessage = result.message`; if `unavailable|unsupported` -> `nextTryAt = clock.now() + retryAfterUnavailableMs`; if `error` ->
   `nextTryAt = clock.now() + min(ttlMs * 2^failures, 300000)` with `failures++` (reset to 0 on ok). Errors go to the ring once per
   distinct `(source, message)` per 60 s with `where: 'panel.<source>'`. `inflight = null`.
3. If `value !== null`: return it immediately (stale while revalidating) with `status: lastStatus`, `message: lastMessage`.
4. Else wait `Promise.race([inflight, sleep(firstWaitMs)])`; if settled with a value return it; else `{value:null, sampledAt:null,
   status: inflight ? 'pending' : lastStatus, message: lastMessage}`.

Normative key table of the `runtime.json` section `panelOptions` (this design owns the keys and bounds; design 01 slice S1 writes the
module `packages/shared/src/config/runtime/panelOptions.ts` from this table and registers both keys in `R_KEY_CATALOGUE` with owner 06;
critic N-03; the section name is design 01's and avoids the legacy L keys `panels` and `attempts`):

| Key | Type and bounds | Default | Used by |
|---|---|---|---|
| `panelOptions.machineProcessIntervalMs` | integer 10000..300000 | 20000 | processes source TTL (`processIntervalMs` below, 3.7.3) |
| `panelOptions.attemptsWindowHours` | integer 1..8760 | 24 | attempts matching window and `runsToMatch` cut-off (3.10.3 step 7, 3.10.6; D6) |

Source table (all values are code constants in `panels/constants.ts`; only `processIntervalMs` is configurable, through
`panelOptions.machineProcessIntervalMs` above):

| Source | ttlMs | firstWaitMs | timeoutMs | retryAfterUnavailableMs | Cost per refresh (E-ref) |
|---|---|---|---|---|---|
| memory | 1800 | sync | - | - | 0.002 ms (E6) |
| cpu | 1800 | sync | - | - | 0.16 ms (E6) |
| processes (win32) | `processIntervalMs` (20000) | 3000 | 10000 | 300000 | ~190 ms child + 8 ms Node CPU, 157 ms wall (E4) |
| processes (posix) | `processIntervalMs` | 3000 | 10000 | 300000 | UNVERIFIED (`ps` is small; measure in Linux CI, 8.4) |
| docker | 15000 | 3000 | 8000 | 300000 (ENOENT) | 31 ms child CPU, 153 ms wall with 4 containers (E19) |
| git.status | 15000 | 3000 | 10000 | 300000 (git missing / not a repo) | 47 ms child CPU, 159 ms wall (E16) |
| git.log | until `headOid` changes, max 120000 | 3000 | 10000 | same | 16 ms child CPU (E16) |
| stopFile | 2000 | sync-ish (fs.stat) | 1000 | - | < 1 ms |
| ledger, chainLog | 5000 | 1000 | 1000 | - | one read of <= max(64 KiB, n*400) bytes |
| logs | 2000 | 1000 | 2000 | - | glob walk (<= 500 matches) + 2 tails |
| attempts (read) | 2000 | 1000 | 2000 | - | one indexed query |

CPU budget check for the worst realistic case (one tab on the Overview page, every panel on, Windows): processes 198/20000 = 0.99%,
docker 44/15000 = 0.29% (31 child + 13 Node), git 60/15000 = 0.40%, memory/cpu/files < 0.05% -> **about 1.7% of one core**, under
the legacy whole-process 3-4% with one tab (changelog 2.0.1). A second tab adds nothing (single flight). Proof: benchmark B3 (8.3).

### 3.6 Child-process policy (`platform/exec.ts`, ADR 0051)

Design 05 (S-PROC rules 1-5) owns the security rules of this module: no shell, `.exe` only, env allow-list, untrusted strings never
become arguments or PowerShell text, timeout and a 1 MiB default output cap. This section owns the **signature** (critic I-06: the
`ChildSpec`/`ChildResult` form below is the only `execFileText`; design 01 4.2's `execFileText(file, args, ExecOptions) -> ExecResult`
is replaced by it and 01's call sites pass a `ChildSpec`) and rules 6-10. Where the two disagree, 05 wins on security rules and this
section on the fields. Slice PP1 owns `exec.ts` and `process.ts`; 01 slice S4 owns `platform/mutex.ts` and `platform/markers.ts`
(registry C13). There is no `ExecutableName` type: `resolveExecutable` takes the inline union below, and 01 passes the Python path it
probes (6.5) directly as `ChildSpec.file` (registry C11).

Mapping for 01's former `ExecResult` fields: `timedOut` = `error === 'TIMEOUT'`; `signal` is not exposed (Windows has none; on POSIX a
signal exit is `code: null` with `error: 'NONZERO_EXIT'`); `maxStdoutBytes` = `maxOutputBytes`; `env` = `extraEnv` on top of the rule-4
allow-list (callers cannot remove allow-list entries).

```ts
// ChildKind and ChildKindStats are declared in shared/src/api/panels.ts (HealthReport.children references them) and re-exported here.
export type ChildKind =
  | 'powershell.processes' | 'powershell.cmdline' | 'git' | 'docker' | 'ps' | 'taskkill'
  | 'node'                           // short-lived process.execPath children run by the CLI (01, critic I-06); the long-lived server
                                     // child uses spawnDetached/spawnForeground below, the launcher its own copy (ADR 0007)
  | 'python'                         // legacy delegation $V (01 6.5), resolved by 01's MCS_PYTHON probe, passed as an absolute path
  | 'icacls'                         // 01 doctor ACL check (Windows only)
  | 'opener';                        // 01 4.7 `start --open`: hands the instance URL to the desktop's browser opener
export interface ChildKindStats { spawned: number; failed: number; timedOut: number; totalMs: number }
export interface ChildSpec {
  kind: ChildKind;
  file: string;                      // absolute path from resolveExecutable(); never a bare name, never .cmd/.bat
  args: readonly string[];           // each element passed verbatim; no shell parsing anywhere
  cwd?: string;                      // absolute, must exist
  timeoutMs: number;                 // hard kill after this
  maxOutputBytes: number;            // stdout+stderr cap; exceeded -> kill, result.truncated = true
  encoding: 'utf8' | 'latin1';
  extraEnv?: Readonly<Record<string, string>>;
  stdin?: string;                    // kind 'node' only (02 3.7 `hooks verify` V6 probe payload, registry C60): written once to the child's
                                     // stdin, then closed; at most 4096 bytes UTF-8, larger -> `SPAWN_FAILED` and nothing is spawned; never logged
}
export type ChildErrorCode = 'ENOENT' | 'EACCES' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'NONZERO_EXIT' | 'SPAWN_FAILED' | 'QUEUE_FULL' | 'ABORTED';
export interface ChildResult {
  ok: boolean;                       // exit code 0 and no error
  code: number | null; stdout: string; stderr: string;
  error: ChildErrorCode | null; truncated: boolean; durationMs: number;
}
export function execFileText(spec: ChildSpec, signal?: AbortSignal): Promise<ChildResult>;   // the only one (I-06); never throws, never rejects
export function resolveExecutable(name: 'git' | 'docker' | 'powershell' | 'ps' | 'taskkill' | 'icacls' | 'node' | 'opener'): Promise<string | null>;  // 'node' -> process.execPath
export function childStats(): Record<ChildKind, ChildKindStats>;   // every kind present (zeros); served as HealthReport.children (03 6.2, I-21)
// 01 4.2 signatures, kept verbatim in this file (they do not go through the semaphore: long-lived children, not counted in childStats):
export function spawnDetached(file: string, args: readonly string[], o: { cwd: string; env: Record<string, string>; stdoutFd: number; stderrFd: number }): ChildProcess;  // detached:true, windowsHide:true
export function spawnForeground(file: string, args: readonly string[], o: { cwd: string; env: Record<string, string> }): ChildProcess;   // stdio:'inherit', windowsHide:true
```
Rules (each has a test in 3.11):
1. Implementation uses `spawn(file, args, { shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'], cwd, env })`;
   stdin is `'pipe'` instead of `'ignore'` only when `spec.stdin` is defined (kind `node` only, any other kind with `stdin` is refused with
   `SPAWN_FAILED`): the string is written once and the stream ended, and an `EPIPE` from a child that exits early is ignored.
   `windowsHide: true` is unconditional (E9 showed no window even without it, but libuv's behaviour is version dependent; the flag is free).
2. `file` must be absolute and end in `.exe` or `.com` on Windows (a `.cmd`/`.bat` needs `cmd.exe` = a shell: refused with `SPAWN_FAILED`).
3. `resolveExecutable`: Windows `powershell` -> `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (fixed, existence-checked;
   pwsh 7 is not used: 2x CPU in E1); `taskkill` -> `%SystemRoot%\System32\taskkill.exe`; `icacls` -> `%SystemRoot%\System32\icacls.exe`;
   `node` -> `process.execPath` (never a PATH lookup); `opener` -> Windows `%SystemRoot%\explorer.exe`, macOS `/usr/bin/open`
   (fixed, existence-checked), other POSIX the first `PATH` entry with an executable `xdg-open` (`explorer.exe` may exit 1 after a
   successful hand-over, UNVERIFIED: 01 4.7 treats the opener's exit code as advisory); `python` is not resolved here (01 6.5 probes `MCS_PYTHON`, `python`, `python3`,
   `py -3` and passes the absolute result); `git`, `docker` -> first `PATH` entry
   containing `<name>.exe` (PATH split on `;`, entries trimmed of quotes, relative entries ignored). POSIX: first `PATH` entry with an
   executable `<name>` (`fs.access X_OK`). Results cached 10 min; `null` cached 5 min.
4. Environment: design 05 S-PROC 3 allow-list (`PATH`, `SystemRoot`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `LANG`) plus
   `MCS_HOOK_DISABLE=1` (D8 recursion guard); kind `git` adds `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`; kind `docker` passes
   `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` through when set (remote contexts; requested addition to 05, CH-4); POSIX adds
   `LC_ALL=C`; then `extraEnv`. E23: docker, PowerShell and git all work under the bare allow-list on this machine.
5. Timeout: `setTimeout(timeoutMs)` -> `child.kill()` (Windows: TerminateProcess of the direct child; none of the commands used here
   spawns grandchildren except the git shim, which is never used because `resolveExecutable('git')` prefers `...\Git\mingw64\bin\git.exe`
   when `PATH` points at `...\Git\cmd\git.exe`: replace `\cmd\git.exe` with `\mingw64\bin\git.exe` if that file exists).
6. Output cap: count bytes on both pipes; above `maxOutputBytes` kill, `truncated: true`, `error: 'OUTPUT_LIMIT'`.
7. Concurrency: a per-process semaphore of 2 running children, FIFO queue of 8; a 9th waiting request returns `QUEUE_FULL` immediately.
8. No argument or stdin is built from transcript or hook data (the one `stdin` user is 02 3.7 V6, a synthetic probe payload with a random
   id, under 1 KiB). For kind `node` the `file` is `process.execPath`, except for `hooks verify` V4/V6 (02 3.7), which spawn the absolute
   path of the installed hook entry's `command` after 02's checks V1-V3 (settings parse, entries complete, path exists): the point of
   those checks is to run exactly what Claude Code will run. The only dynamic values: a validated integer pid (`/^[1-9][0-9]{0,9}$/`) for
   `powershell.cmdline`/`taskkill`, the configured repo directory as `cwd`, for kinds `node`/`python`/`icacls` the paths and
   validated CLI values that design 01 passes (script paths inside the skill, workspace paths, slugs matching the slug rule), and for
   `opener` the URL `http://127.0.0.1:<port>/` built from the validated integer port of the instance. Config
   strings are never interpolated into a PowerShell script (scripts are constants passed with `-EncodedCommand`; filtering happens in
   Node).
9. Logging: one debug log line per spawn with `kind`, `durationMs`, `code`, `error` (no args, no output). stderr text is reduced to its
   first line, clipped to 200 chars, before it reaches any message.
10. Only `engine/src/platform/exec.ts` imports `node:child_process` (05 ESLint config A.9 and `security/subprocess.test.ts`); the
    detached server start uses `spawnDetached` in the same file with `windowsHide: true` (4.7). The launcher `scripts/mcs.mjs` keeps
    its own copy (01 4.2, ADR 0007: it runs before the build exists). Test code is allowed its own spawns per 05 (`processes.ts`).

### 3.7 Machine panel (`panels/machine.ts`)

#### 3.7.1 Memory and CPU (all platforms)
```ts
const GiB = 1073741824;
function memorySample(): { freeGb: number; totalGb: number; usedPct: number } {
  const total = os.totalmem(), free = os.freemem();
  return { freeGb: round(free / GiB, 2), totalGb: round(total / GiB, 1), usedPct: total > 0 ? Math.round(100 * (total - free) / total) : 0 };
}
class CpuSampler {                       // legacy contract: first call null, then delta since the previous call
  private prev: { busy: number; total: number } | null = null;
  sample(): number | null {
    const cur = os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, total: 0 });
    const p = this.prev; this.prev = cur;
    if (!p) return null;
    const dt = cur.total - p.total;
    return dt > 0 ? Math.round(100 * (cur.busy - p.busy) / dt) : null;
  }
}
```
`round(x, d)` = `Math.round(x * 10^d) / 10^d` (legacy Python `round` is banker's rounding on exact halves; the difference only
appears on exact binary halves and is accepted, parity tolerance in 5.4). Windows evidence: E5, E6. Linux: libuv reads `MemAvailable`
(UNVERIFIED; verify in CI with a comparison against `/proc/meminfo`, test `machine-linux.test.ts`). macOS: `os.freemem()` reports free
pages only and understates available memory (UNVERIFIED; documented as a known limitation, no workaround shipped).

#### 3.7.2 Watched-process matching
`watched = config.watched_processes` (legacy key, list of strings). Matching is case-insensitive:
```ts
function matchWatched(processName: string, watched: readonly string[]): string | null {
  const n = processName.toLowerCase();
  for (const w of watched) {                 // config order: the first entry that matches wins and becomes the display name
    const lw = w.toLowerCase();
    if (lw === n || lw === n + '.exe' || (lw.endsWith('.exe') && lw.slice(0, -4) === n)) return w;
  }
  return null;
}
```
Aggregation per display name: `count += 1; mb += Math.floor(workingSetBytes / 1048576)` (legacy floors per process, then sums).
Output sorted by `mb` desc, then `name` asc. Display name differs from legacy only in letter case when the config spelling differs from
the system image name (legacy shows `szExeFile`); parity compares names case-insensitively (5.4).

#### 3.7.3 Windows process list (ADR 0050)
`PROC_SCRIPT_NET` (constant; base64 of its UTF-16LE text passed as `-EncodedCommand`):
```powershell
$ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { [Console]::Out.Write($p.ProcessName + "`t" + $p.Id + "`t" + $p.WorkingSet64 + "`n") }
```
`PROC_SCRIPT_CLM` (fallback for Constrained Language Mode, where .NET static calls and `[Console]` are blocked; output in the OEM code
page, decoded as `latin1`, names are ASCII in practice):
```powershell
Get-Process | ForEach-Object { $_.ProcessName + "`t" + $_.Id + "`t" + $_.WorkingSet64 }
```
Invocation: `execFileText({ kind: 'powershell.processes', file: <powershell.exe>, args: ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', B64], timeoutMs: 10000, maxOutputBytes: 2097152, encoding })`.
Algorithm:
1. If `mode === 'net'`: run `PROC_SCRIPT_NET` (utf8). If `ok` and at least one parsed row: done.
2. If the result is not ok or has zero rows, and stderr contains `core types` or `language mode` (case-insensitive): set
   `mode = 'clm'` for the life of the process and run `PROC_SCRIPT_CLM` (latin1).
3. `ENOENT`/`EACCES` (PowerShell missing or blocked by AppLocker/SRP) -> `{status: 'unavailable', message: 'PowerShell is not available; per-process memory is disabled'}`
   (retried after 5 min). Timeout -> `error`. Zero rows after both modes -> `error` `'process list was empty'`.
4. `parseProcLines(text)`: split on `\n`, strip a trailing `\r`, split on tab into exactly 3 fields, `pid` and `ws` must match `/^\d+$/`,
   else the line is ignored (counted in `stats().procsBadLines`).
Rejected alternatives with numbers: `tasklist` (E1+E2: about 110-190 ms child plus 130-180 ms unexplained Node-side CPU per call,
locale-formatted `Mem Usage`); persistent PowerShell (E3: 16 ms per query but 73-142 MB resident, growing); `Get-CimInstance`
(E1: 281 ms plus WMI service CPU); pwsh 7 (E1: 391 ms, not always installed); a native addon or FFI package (new native dependency,
no compiler on the machine per `stack-versions.md`, brief forbids it without strong reason); `wmic` (absent on this build).

#### 3.7.4 Linux and macOS process list (UNVERIFIED)
`execFileText({ kind: 'ps', file: <ps>, args: ['-A', '-o', 'comm=,rss='], timeoutMs: 10000, maxOutputBytes: 2097152, encoding: 'utf8' })`.
`parsePsOutput`: per line, trim; `rss` = last whitespace-separated token (`/^\d+$/`, KiB); `comm` = the rest trimmed; name =
`path.posix.basename(comm)`; `workingSetBytes = rss * 1024`. Linux truncates `comm` to 15 characters (documented). Deliberate change vs
legacy POSIX code: a watched `node.exe` also matches `node` (3.7.2), so the Windows-centric defaults work on Linux. Verification plan:
Linux CI job (`ubuntu-latest`) runs `machine-posix.test.ts` against a spawned `node` child and asserts it is listed with `count >= 1`.

#### 3.7.5 Docker
Enabled when `config.docker === true`. `execFileText({ kind: 'docker', file: <docker>, args: ['ps', '--format', '{{.Names}} ({{.Status}})'], timeoutMs: 8000, maxOutputBytes: 262144, encoding: 'utf8' })`.
- exit 0 -> lines of stdout, trimmed, non-empty, at most 50 (sorted as returned).
- `resolveExecutable('docker') === null` -> `unavailable` `'docker not found on PATH'` (retry after 5 min).
- non-zero exit (daemon down) -> `error` with the first stderr line clipped to 200 chars. Legacy returned `[]` here (it did not check
  the exit code) and `['(docker unavailable)']` only for a missing binary/timeout; the legacy projection maps `unavailable|error` to
  `['(docker unavailable)']` only for `unavailable`, `[]` for `error` (5.4, D23).

#### 3.7.6 Assembly
`machine` data = memory+cpu (computed synchronously per request when older than 1.8 s, cached otherwise), `procs` from the processes
SourceCache, `docker` from its SourceCache. `status` = `ok` when every enabled source is `ok`, else `partial`.

### 3.8 Git panel (`panels/git.ts`, ADR 0057)

Enabled by `config.panels.git`. Repo = `config.repo` resolved absolute (design 01 2.3). Commands (args arrays, `cwd = repo`):
```
STATUS: git --no-optional-locks -c core.fsmonitor=false -c color.ui=never status --porcelain=v2 --branch
LOG:    git --no-optional-locks -c color.ui=never log -3 --no-color --format=%h%x1f%aI%x1f%s
```
`--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0`) stops the opportunistic index refresh write: the legacy engine ran a plain
`git status` every 10 s in the monitored repo, which can take `.git/index.lock` while the owner commits (D17). `core.fsmonitor=false`
prevents the monitor from starting an fsmonitor daemon on the owner's behalf.
Parse STATUS (`parseStatusV2(stdout)`):
1. For each line (split on `\n`, strip trailing `\r`): `# branch.oid X` -> `headOid = X === '(initial)' ? null : X`;
   `# branch.head X` -> `detached = X === '(detached)'; branch = detached ? null : X`; other `# ` lines ignored;
   every other non-empty line -> `dirty += 1` (entries `1`, `2`, `u`, `?`; the same set and count as `status --short`).
2. Exit 128 with stderr containing `not a git repository` -> `repoState: 'not_a_repository'`, `branch: null, dirty: null, commits: []`,
   source status `unavailable`. `resolveExecutable('git') === null` -> `git_missing`, `unavailable`. Other non-zero (for example
   `dubious ownership`) -> `error` with the first stderr line.
LOG refresh: when `headOid` differs from the oid of the cached log, or the cached log is older than 120 s, or no log yet; skipped (commits
`[]`) when `headOid === null`. Parse each line by `\x1f` into `hash`, `aI`, `subject`; `at = new Date(aI).toISOString()` or `null` if invalid.
Stop file: `config.stop_file` set -> `fs.promises.stat(rel(repo, stop_file))` succeeds -> `true`; any error -> `false` (legacy
`os.path.exists`). Computed even if `panels.git` is false? No: like legacy, it lives in the git/overview panel and is only shown there;
the panel endpoint answers `404 panel_disabled` and computes nothing.

### 3.9 Ledger, chain log, live logs (`panels/files.ts`)

#### 3.9.1 `tailLines(path, n)` (Python-compatible, `platform/fsx.ts`)
1. `fh = await open(path, 'r')`; `size = (await fh.stat()).size`; `want = Math.max(65536, n * 400)`; `start = Math.max(0, size - want)`.
2. Read `size - start` bytes from `start` in one call; `close` in `finally` (read and close: never keep a handle, 4.3).
3. Decode with `new TextDecoder('utf-8', { fatal: false })` (U+FFFD for invalid sequences, like Python `errors='replace'`).
4. `pySplitlines(text).slice(-n)`. Any `ENOENT|EACCES|EISDIR|EPERM` -> `[]` and the source reports `unavailable` with `'<file> not found'` etc.
`pySplitlines(s)`: split on `\r\n`, `\n`, `\r`, `\x0b`, `\x0c`, `\x1c`, `\x1d`, `\x1e`, `\x85`, `\u2028`, `\u2029` (Python
`str.splitlines`); a trailing terminator does not create an empty last element; `''` -> `[]`. Regex form:
`/\r\n|[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/`.

#### 3.9.2 Ledger and chain log
- Ledger (`panels.ledger` and `config.ledger`): `lines = tailLines(rel(ledger), 30).filter(l => l.startsWith('|'))`.
- Chain log (`panels.chain_log` and `config.chain_log`): `lines = tailLines(rel(chain_log), 10)`.
- `rel(repo, p)` = `path.isAbsolute(p) ? p : path.resolve(repo, p)`. `file`, `exists`, `sizeBytes`, `modifiedAt` from one `stat`.
  Not configured -> `data: { lines: [], file: null, exists: false, sizeBytes: null, modifiedAt: null }`, source state `disabled` (the panel itself is enabled; only that file is not configured).

#### 3.9.3 Live logs
1. `matches = unique(canonicalPath)` over `config.live_log_globs` of `globFiles(pattern, repo)`.
2. `stat` each; a file that vanished between glob and stat is skipped (legacy crashed the poll here, D25).
3. Sort by `mtimeMs` desc, then `relPath` asc; keep 4. For the first 2: `tail = (await tailLines(p, 16)).map(l => clipCodePoints(l, 220))`
   (`[...l].slice(0, 220).join('')`: code points like Python slicing, no marker); the others `tail: []`.
4. `ageS = Math.trunc((now - mtimeMs) / 1000)` (legacy `int()` truncation), `sizeBytes`, `name = path.basename(p)`.

#### 3.9.4 `globFiles(pattern, base, opts = { maxMatches: 500, maxDepth: 8 })`
- Pattern absolute (drive letter, UNC, or leading `/`) or relative to `base`; separators `/` and `\` both accepted.
- Segment syntax: `*` any run without separator, `?` one char, `[abc]`, `[a-z]`, `[!abc]`; `**` as a whole segment = zero or more
  directories (**deliberate deviation**: Python's non-recursive `**` behaves like `*`, E17; documented in configuration docs).
- Case-insensitive on `win32` and `darwin`, sensitive elsewhere. Entries whose name starts with `.` match only a segment that starts
  with `.` (Python and Node both skip dotfiles, E17). Symbolic links to directories are not descended (`lstat`).
- Stops after `maxMatches` files (source message `'more than 500 files match live_log_globs; showing the newest of the first 500'`).
  Recursion stops at `maxDepth` directories below the first wildcard segment. Own implementation (about 80 lines): `fs.glob` is
  experimental on part of the supported Node range (floor 22.22.0, 01 5.1 / ADR 0007, critic I-05) and its `**` semantics would bind us to a Node version.

### 3.10 Attempts (ingestion, matching, state; ADR 0059)

#### 3.10.1 Configuration (legacy keys, unchanged)
`config.chain_log: string | null`; `config.attempts: null | { start: string; end: string; label_prefix?: string /* '' */; time_format?: string /* '%Y-%m-%d %H:%M:%S' */ }`.
Both must be set, else attempts are `not_configured` (no rows, no lifecycle evidence). `start`/`end` are Python-syntax regexes compiled
by the translator of design 01: `compilePyRegex(pattern, 'attempts')` -> `CompiledPyRegex` (no `s` flag, mode `match`: anchored at
position 0, not at the end, sticky `y`; legacy `re.match` without flags); a pattern that cannot be translated exactly is a config error
`REGEX_UNSUPPORTED` (01). `matchSticky(rx, line)` = `rx.exec(line)` (01 resets `lastIndex`) and the groups used below are
`m.groupdict()` (values `string | null`, like Python's `groupdict()`).
`time_format` is validated at config load by `pyStrptimeValidate(format)` (3.10.4): an unknown directive is a validation problem
reported as `McsError('CONFIG_INVALID', ...)` with the message
`"attempts.time_format: unsupported directive %X (supported: %Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%)"` (no own error
code; 01 2.4 lists it under the Node-only additions; critic N-06, registry C42).

#### 3.10.2 Persistence (design 03's tables and repositories; critic I-07, N-10, registry C40)
The DDL, indexes and statements are design 03's and are not copied here: tables `attempt_sources` and `attempt_runs` in
`0001_initial.sql` (03 3.5: STRICT, no `instance_id`, soft references without foreign keys), indexes `idx_attempt_runs_session`,
`idx_attempt_runs_open`, `idx_attempt_runs_start` (03 3.5), repository `AttemptsRepo` (`packages/engine/src/db/repos/attempts.ts`,
03 3.6: `getSource`, `saveSource`, `resetSource`, `openRun`, `insertRun`, `endRun`, `supersedeRun`, `setMatch`, `runsToMatch`,
`latestRuns`, `evidenceRun`) and match candidates from `SessionsRepo.attemptCandidates` (03 3.6). The algorithms below use 03's column
names. Three rules follow from 03's shapes:
- `attempt_runs.session_id` holds the `sessions.id` **row id** (`AttemptRunRow.sessionRowId`), not the provider session id. Design 02's
  events and the panel need the provider id (`sessions.session_uid`): rows matched in the current tick take it from the
  `AttemptCandidate.sessionId` they were matched with; every other row id (an earlier match, the ids returned by `resetSource`) is
  mapped through `SessionsRepo` (by-id lookup of `session_uid`, 03 3.6) before an event or a panel row is built. A row id whose
  session no longer exists (data retention detaches runs, 03 3.8) yields no event and `sessionId: null` in the panel.
- Change publication: `AttemptsRepo` reserves one `attempt/upsert` change per transaction and stamps every changed row's `updated_seq`
  with its seq (03 9.1); the UI invalidates the attempts panel on it (03 9.2) and otherwise polls (3.4). The lifecycle effect travels
  separately, through design 02's events (3.10.7).
- `panels/attempts/repo.ts` is a thin adapter over `AttemptsRepo` and `SessionsRepo`; it holds no SQL (only `engine/src/db/**` does, 03 4.5).

#### 3.10.3 Ingestion (`attempts/ingest.ts`, called by `PanelService.tickAttempts`)
1. Not configured -> return `{state: 'not_configured'}`. `p = canonicalPath(rel(repo, chain_log))`; `stat` fails -> `missing` (rows kept).
2. `AttemptsRepo.getSource(pathKey(p))` (`pathKey` = the `samePath` key, 4.1). `cfgHash = sha256(JSON.stringify([start, end, label_prefix ?? '', time_format ?? default]))`.
3. No row: the transaction of step 7 creates it with `saveSource({generation: 1, read_offset: 0, ...})`. `cfgHash` differs: the
   transaction of step 7 starts with `resetSource(sourceId, cfgHash)` (03 3.6: deletes the source's runs, generation 1, offset 0, and
   returns the session row ids that had an ended matched run); those ids, mapped to provider ids (3.10.2), are the `cleared` set of
   3.10.7 step 2, whose `external.attempt_cleared` events are submitted after COMMIT ahead of any new evidence (design 02 4.3, critic
   I-18). The read of step 5 then starts at offset 0.
4. Identity: design 02's tailer primitive `checkIdentity(path, stored, storedSize, read_offset)` (ADR 0015: inode + head hash of up to
   256 bytes, reset when the file shrinks below the cursor or the head changes). On reset: `generation += 1`, `read_offset = 0` (old rows
   stay as history of the previous file).
5. Read with 02's `readLines(path, read_offset, min(size, read_offset + 8 MiB), deadline = now + 20 ms per slice, { chunkBytes: 1048576,
   maxLineBytes: 1048576, acceptValidUnterminatedTail: false })`: complete LF-terminated lines with their byte offsets; then each line is
   decoded (UTF-8, replacement) and further split with `pySplitlines` (piece offsets = line offset + byte length of the preceding pieces
   and separators).
6. For each line in order (`applyLine`):
   a. `m = matchSticky(startRe, line)`. If `m`: `t = parseTime(m.groupdict().time, fmt)`; if `t === null` -> skip the line entirely (legacy
      `continue` without trying the END regex). `part = m.groupdict().part ?? ''`. If an open row with the same `(source, generation, part)`
      exists: set it `end_reason='superseded', state='UNKNOWN', evidence='chain log: a later START for part <part> superseded this attempt'`
      (D20 deliberate fix). Insert the new row: `end_reason='open', state='RUNNING', evidence='chain log: started, no END yet'`,
      `n_raw = m.groupdict().n ?? null` (legacy `''` when absent is projected in 5.4), `model = m.groupdict().model || null`, `effort = m.groupdict().effort || null`.
      Continue with the next line.
   b. Else `m = matchSticky(endRe, line)`; if `m` and `part = m.groupdict().part` is a string and an open row for that part exists:
      `ended_at = parseTime(m.groupdict().time, fmt) ?? started_at`; `exit_raw = m.groupdict().exit ?? null`; `status_raw = m.groupdict().status ?? null`;
      `end_reason = 'ended'`; `{state, evidence} = externalState(exit_raw, status_raw)` (3.10.5).
   c. Else ignore the line.
7. Transaction: every write of steps 3-6, the source row (`saveSource`: `read_offset`, identity, generation) and matching (3.10.6, for
   rows changed in this tick plus `runsToMatch(now - attemptsWindowHours * 3600000, 500)`; `attemptsWindowHours` default 24,
   `runtime.json panelOptions.attemptsWindowHours`, key table in 3.5) run inside ONE `withWriteTx(db, ctx, fn)` per tick (03 4.5; `fn` is
   synchronous; the chain-log read of step 5 happens before it, asynchronously). `AttemptsRepo` reserves the `attempt/upsert` change
   and stamps `updated_seq`/`updated_at` on every changed row (3.10.2). The transaction also computes the evidence set of 3.10.7 step 3
   (reads only). No design 02 event is written inside it: after COMMIT the tick submits the events through the shared `IngestWriter`,
   which runs its own transaction (02 4.6; 3.10.7). A throw rolls back rows and offset together; the next tick re-reads the same bytes.

#### 3.10.4 `pyStrptime(text, format)` (`platform/pytime.ts`)
Port of CPython `_strptime` for the supported directives; returns `{ year, month, day, hour, minute, second, ms, utcOffsetMin | null } | null`.
- Format compiled once to a regex: literal characters escaped and matched case-insensitively; any run of whitespace in the format
  matches `\s+`; directives: `%Y` `(\d{4})`, `%m` `(1[0-2]|0[1-9]|[1-9])`, `%d` `(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])`,
  `%H` `(2[0-3]|[0-1]\d|\d)`, `%I` `(1[0-2]|0[1-9]|[1-9])`, `%M` `([0-5]\d|\d)`, `%S` `(6[0-1]|[0-5]\d|\d)`, `%f` `(\d{1,6})`,
  `%y` `(\d\d)` (69-99 -> 19xx, 00-68 -> 20xx), `%b`/`%B` English month abbreviations/names, `%a`/`%A` English day names (ignored),
  `%p` `AM|PM` (with `%I`), `%j` day of year `(36[0-6]|3[0-5]\d|[12]\d\d|0[1-9]\d|00[1-9]|[1-9]\d|0[1-9]|[1-9])`, `%z` `Z|[+-]\d\d:?\d\d`,
  `%Z` `UTC|GMT` only, `%%` literal. The whole input must match (`^...$`): Python raises `unconverted data remains` otherwise.
- Range validation like CPython: day must exist in that month and year (Feb 29 only in leap years), `%S` 60/61 accepted and clamped to 59
  (CPython accepts leap seconds then `mktime` normalizes; Node clamps; documented difference of 1-2 s on leap-second inputs).
- Defaults for missing fields: year 1900, month 1, day 1, time 0 (CPython).
`toEpochMs(f)`: `utcOffsetMin !== null` -> `Date.UTC(...) - utcOffsetMin * 60000` (**deliberate fix**: legacy `time.mktime` ignored
`%z`, D21); else `new Date(year, month - 1, day, hour, minute, second, ms).getTime()` (host local zone, like `time.mktime` with
`tm_isdst = -1`; inside a DST fall-back hour JS picks the earlier instant, CPython/MSVCRT behaviour is implementation-defined:
accepted difference, tested only in `TZ=UTC`).

#### 3.10.5 `externalState(exitRaw, statusRaw)` (exact port of `state.py:41-54`)
```ts
const PASS_RE = /^\s*(PASS|DONE|OK|COMPLETE[D]?|SUCCESS)/i;          // Python re.match + re.I
const FAIL_RE = /(FAIL|BLOCK|ERROR|ABORT)/i;                         // Python re.search + re.I
export function externalState(exitRaw: string | null, statusRaw: string | null): { state: AttemptState; evidence: string } {
  const status = statusRaw ?? '';
  const nonzero = !(exitRaw === null || exitRaw === '' || exitRaw === '0');   // '00' counts as non-zero, like legacy
  const shown = status.trim() || '-';
  if (nonzero || FAIL_RE.test(status)) return { state: 'FAILED', evidence: `chain log: exit=${pyStr(exitRaw)} status=${shown}` };
  if (PASS_RE.test(status) || (status.trim() === '' && exitRaw === '0')) return { state: 'COMPLETED', evidence: `chain log: exit=${pyStr(exitRaw)} status=${shown}` };
  return { state: 'UNKNOWN', evidence: `chain log: the run ended (exit=${pyStr(exitRaw)}) but its status ${pyRepr(status.trim())} is neither a pass nor a failure` };
}
// pyStr(null) = 'None', pyStr(s) = s; pyRepr(s) = Python repr of a str: single quotes unless the text contains ' and no ", escapes \\ \n \r \t and non-printables as \xNN/\uNNNN
```
Open rows: `state = 'RUNNING'`, `evidence = 'chain log: started, no END yet'`. Whitespace classes differ (measured over the BMP with Python 3.14 `re` and V8 `/\s/u`): Python-only `\x1c-\x1f`, `\x85`; JS-only `\ufeff`. The translator of design 01 owns `\s` inside user regexes; for the two constant regexes above the difference only matters for a status text starting with one of those characters: accepted, documented by the vector `'\x1cPASS'` in `golden/vectors/external_state.json`.

#### 3.10.6 Matching rows to sessions (`attempts/match.ts`)
Inputs: rows to (re)match; candidate sessions from `SessionsRepo.attemptCandidates(ctx, labels, activeSinceMs)` (03 3.6, inside the
tick's transaction; `labels` = the distinct `label_prefix + row.part` of the rows to match, `activeSinceMs = now - attemptsWindowHours *
3600000`), each an `AttemptCandidate { sessionRowId, sessionId, label, matched, firstRecordAtMs, lastActivityAtMs }`: `matched` = rule
matched or pinned, `firstRecordAtMs` = timestamp of the **first record in file order that has a string `timestamp`** (the legacy
`usage.first`, `reader.py:265-267`; NOT the minimum timestamp; `null` when absent), `lastActivityAtMs` = transcript mtime (legacy `age`).
03's query only prefilters (one hour of slack); the exact rules are these:
```
candidates = sessions where label === (label_prefix + row.part)
                         and firstRecordAtMs !== null and firstRecordAtMs > 0
                         and (matched || config.include_unmatched)
                         and now - lastActivityAtMs <= attemptsWindowHours * 3600000      // legacy lists with hours=24
for each candidate: d = (firstRecordAtMs - row.started_at) / 1000
accept when -15 <= d <= 600; choose the smallest d; ties -> larger lastActivityAtMs, then smaller sessionId
-> AttemptsRepo.setMatch(row.id, candidate.sessionRowId, round(d * 1000))
```
Once matched, a row keeps its `session_id` (it is not unmatched when the session leaves the 24 h window; legacy re-derived on each poll
and lost the match after 24 h, D22). A session may match several rows (legacy). Rows are re-matched when they change or are unmatched
and within the window.

#### 3.10.7 Lifecycle evidence and the legacy precedence rule
For each session with at least one matched row in `end_reason='ended'`: the evidence row = the one with the greatest `started_at`
(ties: greatest `id`; `AttemptsRepo.evidenceRun`) - the legacy `external_map` overwrote by row order, so the latest START wins. After the
attempts transaction of 3.10.3 step 7 has committed (persist before publish), the tick submits design 02's logical events (4.3) through
the shared writer (`deps.writer`, 02 4.6 / 4.10) as one batch:
`writer.submit({ source: 'external', items: [{ kind: 'external', events, rows: [] }], bytes: 0 })` (`bytes` = input bytes, none here).
The writer merges them in its own transaction and publishes the `session/upsert` changes after its own COMMIT (02 4.6). Events:
`{ k: 'external.attempt', sessionId, state: 'COMPLETED' | 'FAILED' | 'UNKNOWN', evidence, rowKey: 'attempt:' + row.id, endedAt: row.ended_at, observedAt: publishAt }`
(`sessionId` = the provider id of `row.session_id`, 3.10.2; `endedAt` is the evidence time shown, 02 `LifecycleEvidence.at`, critic I-18, registry C18,
registry C41; 02 merges the event LWW into the `attempt` fact; rule S-1 maps it to `completed`/`failed`/`unknown`). When a session loses
its evidence (config rebuild, 3.10.3 step 3), the batch carries `{ k: 'external.attempt_cleared', sessionId, observedAt: publishAt }`
(design 02 4.3 per critic I-18: 02 7.3 merges it into the `attempt` LWW fact with value `null` at `observedAt`; rule S-1 treats `null`
as no evidence; 02's transition-table row "cleared after rebuild -> re-derived without S-1").

`observedAt` is the time the monitor observed the evidence (as for 02's registry and pid observations), not the chain-log END time:
02's LWW joins by stamp (`Stamp.at` first, 02 7.2), so an END-time stamp would (a) let a cleared fact (stamped `now`) beat re-published
evidence whose END is older, and (b) let an earlier START with a later END beat the latest START, breaking the legacy rule above. S-1
does not read the stamp time (02 7.4), so nothing else depends on it. Algorithm (`attempts/evidence.ts`):
1. `publishAt = max(ctx.clock.now(), lastPublishAt + 1)`, taken once per tick after COMMIT; `lastPublishAt` is kept by the panel service and
   initialised at service start to `max(ctx.clock.now(), source.updatedAt)` where `source` = `AttemptsRepo.getSource` of the configured chain
   log (written in every tick's transaction with `tx.now`, so it bounds the previous ticks' stamps), so a restart or a small backward
   wall-clock step cannot produce an older stamp.
2. `touched` = session row ids of rows inserted, changed or (re)matched in this tick, plus the `cleared` ids returned by `resetSource`
   (3.10.3 step 3).
3. Inside the transaction (reads only), for each `s` in `touched`: `row = evidenceRun(s)` (rule above, current rows only). `row`
   exists -> an `external.attempt` for it; else, if `s` came from a rebuild -> an `external.attempt_cleared`; else nothing. Row ids are
   mapped to provider ids (3.10.2) there too; after COMMIT the events get `observedAt = publishAt` and are sorted by provider id
   (deterministic), clears first. Consequence: a session that is cleared and re-evidenced in
   the same tick gets only the new evidence; one re-evidenced in a later tick gets a strictly later stamp than its clear.
4. A session whose evidence row did not change is not re-published (no churn on idle ticks).
5. `submit` returns `false` (queue full): the batch is kept in the service and re-submitted, before any later batch, from
   `writer.onDrain` or the next tick (stamps stay as computed, so order is kept). A throw inside the attempts transaction submits nothing.
   Accepted residual risk: a process crash after the attempts COMMIT and before the writer's COMMIT loses that tick's events (rows and
   offset are committed, so they are not re-derived); the window is one writer tick plus queue time and opens only on ticks that
   publish; recovery is the next change of that session's evidence row or `mcs db rebuild` (7.1 item 6).
Open or superseded rows publish nothing (legacy: no external evidence while open). `UNKNOWN` (ended, ambiguous status) is published:
legacy `external_state` returned `{state: 'UNKNOWN'}` and the session showed UNKNOWN with source `external`.

#### 3.10.8 Panel read
`AttemptsRepo.latestRuns(limit)` (newest `limit` rows in start order, index `idx_attempt_runs_start`, 03 3.6) -> map to `AttemptsPanel.rows`
(`sessionId` = provider id of `session_id`, 3.10.2):
`n = /^\d+$/.test(n_raw) ? Number(n_raw) : null`, `exit = /^-?\d+$/.test(exit_raw) ? Number(exit_raw) : null`, `usage` = the session's
aggregate `TokenUsage` (03 5.5, `usageInclSubagents`) or null. Rows from older generations are included (history).

### 3.11 Tests that prove the panel guarantees

Placement (05 4.1, registry C47): unit tests sit next to their module (`engine/src/panels/*.test.ts`, `engine/src/panels/attempts/*.test.ts`,
`engine/src/platform/*.test.ts`); only `*.int.test.ts` files live under `engine/test/{panels,platform}/`.

| Guarantee | Test file | Cases |
|---|---|---|
| single flight, N callers -> 1 load | `source-cache.test.ts` | 20 concurrent `read()` -> loader called once; second read inside ttl -> no call |
| stale-while-revalidate + last good value | `source-cache.test.ts` | loader fails after a success -> old value with status `error`; next ttl retries with backoff `ttl*2^n` capped 300 s; `unavailable` waits `retryAfterUnavailableMs` |
| no work without requests | `source-cache.test.ts` | fake clock advanced 1 h without reads -> 0 loader calls |
| first wait | `source-cache.test.ts` | loader resolves after 50 ms with firstWait 3000 -> value; after 4000 -> `pending` |
| child policy | `exec.test.ts` (extends 05's: kinds, stats, semaphore, resolution) | spawns `process.execPath -e` scripts: timeout kills (`TIMEOUT`), 3 MB output -> `OUTPUT_LIMIT`, exit 3 -> `NONZERO_EXIT`, missing file -> `ENOENT`, `.cmd` refused, env has `MCS_HOOK_DISABLE=1` and no `GIT_DIR`, 11 concurrent -> 2 running + 8 queued + 1 `QUEUE_FULL`; `stdin` reaches a `process.execPath -e` child that echoes it, a 4097-byte `stdin` -> `SPAWN_FAILED` with no spawn, `stdin` with kind `git` refused; the shim-to-mingw64 git swap |
| process list parsing | `proc-win32.test.ts` | NET output with CRLF, CLM output, garbage lines ignored, pid/ws non-numeric ignored, CLM switch on `core types` stderr, ENOENT -> unavailable |
| watched matching | `machine.test.ts` | `Code.exe` vs `code`, `vmmemWSL` vs `vmmemWSL`, `com.docker.backend.exe` vs `com.docker.backend`, first config entry wins, floor-per-process sum, sort |
| cpu contract | `machine.test.ts` | first sample null; mocked `os.cpus` deltas -> rounded percent; zero delta -> null |
| Windows integration | `machine-win32.int.test.ts` (runs on win32 only) | the test process itself appears under `node.exe` with `count >= 1` and `mb` within 20% of `process.memoryUsage().rss / 2^20` |
| posix parsing | `proc-posix.test.ts` | `ps` text with paths, spaces in names, 15-char truncation |
| docker states | `docker.test.ts` (fake runner) | exit 0 lines; exit 1 -> error with first stderr line; ENOENT -> unavailable, cached 5 min; disabled -> no call |
| git parsing + lock-free | `git.test.ts` | porcelain v2 samples (initial, detached, renamed, untracked, unmerged); exit 128 not a repo; temp repo integration (`git init` in temp dir, commit 2 files, modify 1, add 1 untracked) -> `dirty 2`, 2 commits, `branch`; asserts no `index.lock` was created (fs watcher on `.git` during the call) and argv contains `--no-optional-locks` |
| log refresh only on HEAD move | `git.test.ts` | fake runner counts LOG calls: same oid within 120 s -> 1 call; new oid -> 2 |
| tail + splitlines parity | `fsx.test.ts` + golden vectors `golden/vectors/splitlines.json`, `tail.json` (5.2) | Python outputs for `\r\n`, `\x0b`, `\x85`, `\u2028`, trailing newline, invalid UTF-8 at the cut, file < 64 KiB, n*400 > 64 KiB |
| logs panel | `files.test.ts` | 6 files -> newest 4, tails only for 2, 220 code points (emoji), vanished file skipped, `**` recursion, dotfile excluded, 501 files -> capped message |
| strptime | `pytime.test.ts` + `golden/vectors/strptime.json` | every directive, unconverted data, Feb 29, `%y` pivot, `%z` fix, unsupported directive error |
| externalState | `attempts-state.test.ts` + `golden/vectors/external_state.json` | the legacy table incl. `PASS_WITH_ERRORS`, `exit=1 PASS`, `00`, blank+0, blank+None |
| attempts tick driver | `service.test.ts` | `tickAttempts` called while a tick runs returns the same promise (one ingestion); `close()` drops an unaccepted batch |
| attempts ingestion | `attempts-ingest.test.ts` | demo chain log -> rows A..F; append END for C -> C COMPLETED in the next tick only (offset); START with bad time skipped; duplicate START -> superseded; CRLF lines; truncation -> generation 2 and old rows kept; config change -> rebuild + retract call |
| matching | `attempts-match.test.ts` | window -15/600 boundaries inclusive; smallest delta wins; tie rules; unmatched session excluded unless include_unmatched; first-record vs min timestamp difference |
| precedence to lifecycle | `attempts-evidence.test.ts` | events carry `endedAt` = `ended_at` and the provider session id mapped from the row id; a writer stub sees `submit` only after the attempts COMMIT and none when the transaction throws; `submit` returning `false` -> the same batch re-submitted first on drain; two ended rows for one session -> the later START published, also when the earlier START has the later END; open row publishes nothing; config change -> `external.attempt_cleared` for sessions without new evidence, only `external.attempt` for sessions re-evidenced in the same tick, and a later tick's evidence carries a stamp greater than the clear; `publishAt` strictly increasing across a simulated restart and a 5 s backward clock step |

---
## 4. Windows and platform catalogue

Every item: the behaviour, the decision, the evidence, the test. Utilities live in `runtime/packages/engine/src/platform/*` (3.2).

Platform branching rule (critic I-34), an addition to design 05's ESLint flat config (05 owns `eslint.config.js`; this is the entry to add):
- Scope: `packages/engine/src/**/*.ts` only. Inside it `process.platform` (and `os.platform()`) is forbidden except in the allow-list
  `packages/engine/src/platform/**` and `packages/engine/src/security/paths.ts`. Other engine modules that need a platform-dependent
  value import it from `platform/host.ts`:
  ```ts
  export const hostPlatform: 'win32' | 'linux' | 'darwin' | 'other';   // from process.platform, evaluated once
  export const pathsCaseInsensitive: boolean;                           // hostPlatform === 'win32' || hostPlatform === 'darwin'
  ```
  (01's `mutexName` lives in `platform/mutex.ts`, inside the allow-list; 01's runtime-marker compare uses `samePath`/`pathsCaseInsensitive`.)
- Exempt (rule not applied): `packages/shared/**` (02's `routeKey` in `shared/src/protocol/sanitize.ts` runs in the hook handler,
  which imports only `node:*` and `@mcs/shared/protocol`), `packages/cli/**`, `packages/server/**` (neither branches today; they call
  engine helpers), `scripts/**` (05's `build-stamp.mjs`, the launcher), every test file (`**/*.test.ts`, `**/test/**`).
- ESLint form: `const PLATFORM_ENTRY = { object: 'process', property: 'platform', message: 'Branch on the platform only in
  engine/src/platform/** (import hostPlatform from platform/host.ts).' }`; in the engine block the rule entry is
  `'no-restricted-properties': ['error', ...NO_STDIO, PLATFORM_ENTRY]` plus
  `'no-restricted-syntax'` for `CallExpression[callee.object.name='os'][callee.property.name='platform']`; the allow-list block for
  `platform/**` and `security/paths.ts` re-declares `'no-restricted-properties': ['error', ...NO_STDIO]` (flat config replaces a rule's
  options per matching block, so the allow-list must not switch the stdio restriction off; verified E24). 05's `engine/src/log/logger.ts` block,
  which sets the rule `off` for stdio, becomes `['error', PLATFORM_ENTRY]` so the logger stays covered.
- Test: `engine/src/platform/platform-branching.test.ts` (slice PP1) runs ESLint's Node API with the repository config and
  `lintText("export const w = process.platform === 'win32';", { filePath })` for `filePath` = `packages/engine/src/panels/x.ts` (one
  error), `packages/engine/src/platform/x.ts`, `packages/engine/src/security/paths.ts`, `packages/shared/src/protocol/x.ts`
  (no error); no fixture file is written under `src/`.

### 4.1 Paths (`platform/paths.ts`)

```ts
export function canonicalPath(p: string): string;                // absolute, symlinks/junctions resolved, on-disk case, long names
export function samePath(a: string, b: string): boolean;         // canonical, case-insensitive on win32 and darwin
export function toPosixRel(p: string, base: string): string;     // 'logs/a.log' when under base, else canonical absolute with '/'
```
`canonicalPath` algorithm:
1. `abs = path.resolve(p)` (accepts `/` and `\`, relative to `process.cwd()` only when the caller passed a relative path on purpose;
   config paths are resolved against the task dir / repo by the config loader first).
2. Walk up from `abs` to the longest existing prefix `e`; `real = fs.realpathSync.native(e)`; append the non-existing remainder unchanged.
   `realpathSync.native` returns the on-disk case (E11: `d--mvp` -> `D--mvp`) and expands 8.3 short names (E22; E12 met both spellings of the temp dir).
3. If the result starts with `\\?\UNC\` -> `\\` + rest; with `\\?\` -> strip the prefix.
4. Windows: upper-case the drive letter (`c:` -> `C:`).
Where identity matters (instance ownership, transcript file keys, attempts source path) only canonical paths are compared, with
`samePath`. Containment checks (traversal, symlink and junction escape) are design 05's `resolveContained`/`isContained`/`walkNoLinks`
(S-FS); project folder naming is design 02's `sanitizeProjectName` and `detectTranscriptsDir` (5.1).

| Concern | Rule | Evidence / test |
|---|---|---|
| Drive-letter case | upper-cased by `canonicalPath`; hook payloads give `C:\...` while Git Bash gives `/c/...`: the runtime never receives MSYS paths (Node APIs and Claude Code use Windows form); a config value starting with `/<letter>/` on win32 is a validation problem reported as `McsError('CONFIG_INVALID', ...)` with the message "use C:/... instead of /c/..." (01 2.4 Node-only additions; critic N-06, registry C42) | `paths.test.ts` |
| Long paths (> 260) | supported by Node fs (E11, 308 chars); nothing to do; the legacy engine is not involved | `paths.int.test.ts` creates a 300-char tree |
| UNC repos (`\\server\share\repo`) | allowed; `fs.watch` hints disabled for UNC roots (SMB change notifications are unreliable, UNVERIFIED), polling only; 02's `sanitizeProjectName` applies the same sanitizing (UNVERIFIED: no UNC sample in the survey) | `paths.test.ts` (string level) |
| Forward slashes in config | accepted (`path.resolve` normalizes); API returns `toPosixRel` values | `paths.test.ts` |
| Case-insensitive project folders | requirement on 02's `detectTranscriptsDir`: compare folder names case-insensitively on win32/darwin, exactly on Linux; more than one candidate (case-sensitive file systems) -> exact case first, then newest mtime | survey 1 (`D--mvp` vs `d--work-frontend`); 02 discovery tests |
| Path traversal | owned by 05 S-FS (ids by regex, `resolveContained`, junction-aware walks) | 05 `security/paths.test.ts` |

### 4.2 Process liveness, command line, termination (`platform/process.ts`)

Owned by slice PP1 (critic I-06); design 01 4.2 imports these functions and keeps `platform/mutex.ts` and `platform/markers.ts` (01
slice S4; `listRuntimeProcesses`, `hasRuntimeMarker`, `hasLegacyMarker` live there, registry C13). The former `killPid` of this design
is dropped in favour of `forceKill` + `waitForExit`.
```ts
export function pidAlive(pid: number): boolean;                         // never signals a live process
export function commandLineOf(pid: number): Promise<string | null>;     // null = unknown (process gone, access denied, lookup failed)
export function forceKill(pid: number): Promise<void>;                  // 01 4.2 semantics; never throws for an already-dead pid
export function waitForExit(pid: number, timeoutMs: number, pollMs?: number /* 100 */): Promise<boolean>;   // true = exited
```
- `pidAlive`: `Number.isSafeInteger(pid) && pid > 0` else false; `process.kill(pid, 0)` returns -> true; `EPERM` -> true; `ESRCH` or other ->
  false. libuv's signal 0 on Windows is a health check (`OpenProcess` + exit code `STILL_ACTIVE`), verified in the backend research; same
  edge as legacy: a process that exited with code 259 reads as alive.
- `commandLineOf` on win32 (the `-EncodedCommand` form is authoritative; 01's `-Command` string form is replaced):
  `execFileText({kind:'powershell.cmdline', file: <powershell.exe>, args: ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', b64utf16le(script)], timeoutMs: 20000, maxOutputBytes: 65536, encoding: 'utf8'})` with
  `script = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine"`
  where `pid` passed `/^[1-9][0-9]{0,9}$/` (else `null` without spawning). Timeout 20 s (legacy `cli.py:58-66`), cost about 300 ms (E1
  CIM row). Result cached 5 s per pid (`Map<pid, {at, value}>`, at most 64 entries, oldest evicted); `null` results are not cached.
  Output: stdout with one trailing `\r\n` removed; empty -> `null`.
  Linux: read `/proc/<pid>/cmdline`, NUL -> space, trailing space trimmed. macOS: `ps -o command= -p <pid>` via `execFileText` (kind `ps`, UNVERIFIED).
- `forceKill`: Windows: `execFileText({kind:'taskkill', file: resolveExecutable('taskkill'), args: ['/PID', String(pid), '/F'], timeoutMs: 10000, maxOutputBytes: 65536, encoding: 'utf8'})`
  (01 E3: plain `process.kill` and `taskkill /F` both terminate immediately; `taskkill` keeps 01's tested path); exit code 128 (not
  found) counts as success. This is the one mechanism: 01 4.2 and ADR 0006 adopt it (critic I-06, registry C12). POSIX: `process.kill(pid, 'SIGKILL')`, `ESRCH` ignored. The pid is validated like `commandLineOf`.
- `waitForExit`: polls `pidAlive` every `pollMs` until false (-> `true`) or `timeoutMs` (-> `false`).
- `listRuntimeProcesses` is design 01's (`platform/markers.ts`, 01 S4, launcher-copy parity; registry C13). It spawns only through
  `execFileText` with a constant `-EncodedCommand` script; filtering and parsing happen in Node (rule 8 of 3.6).
- The marker check before a kill (Node runtime marker or legacy `viewer.py`, D12) is design 01's (4.9); it calls `commandLineOf` and
  compares with `samePath`/`pathsCaseInsensitive` (4).

### 4.3 File locking and atomic replace (`platform/fsx.ts`, ADR 0058)

Facts (E10, and design 01 E5): on Windows, renaming over a target that ANY process holds open fails with `EPERM`, even when the holder is
Node (libuv opens with `FILE_SHARE_DELETE`, but replace-on-rename still fails while the target is open); Python's `os.replace` fails the
same way (`PermissionError` 5) while Node holds the file; a Python reader racing a replace saw `PermissionError` on 5,702 of about
18,000 reads (01 E5). Readers of shared files: the legacy Python CLI (`state.json`, `config.json`, `task.json`), the Node CLI,
editors, antivirus.

**One module (critic I-28).** `engine/src/platform/fsx.ts` is the only implementation of atomic replace and short read-and-close reads in
the engine. Design 01's `workspace/fsio.ts` (1.2) becomes a thin wrapper: its `writeWorkspaceFile`, `writePyJsonFile`, `readTextUniversal`,
`readJsonFile`, `compareAndDelete` keep their names and error codes, call `fsx`, and add only the workspace rules (`assertNotLink`,
`McsError` mapping, universal newlines, PyJson). Panels, attempts and the server use `fsx` directly for non-workspace files. The API is
asynchronous; the budget is 3000 ms (E10: a 3 s holder needed 52 retries); 01 1.2's wrapper functions are async as well
(`writeWorkspaceFile(path, data, {budgetMs})`, registry C14).
```ts
export interface AtomicWriteOptions { budgetMs?: number /* 3000 */; mode?: number /* 0o644, ignored on win32 */ }
export async function atomicWriteFile(file: string, data: string | Uint8Array, opts?: AtomicWriteOptions): Promise<void>;
export async function readSmallFile(file: string, maxBytes: number): Promise<Buffer>;   // open, read, close
export async function unlinkWithRetry(file: string, budgetMs?: number /* 3000 */): Promise<'deleted' | 'absent'>;
export class AtomicWriteError extends Error { code: 'E_ATOMIC_WRITE_BUSY' | 'E_ATOMIC_WRITE_IO'; path: string; cause?: unknown }
export class SmallFileError extends Error { code: 'E_FILE_TOO_LARGE' | 'E_FILE_BUSY'; path: string }
```
`atomicWriteFile` (bytes in, bytes out: it never serializes or re-encodes; a `string` is written as UTF-8 without BOM):
1. `tmp = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'` (same directory, so the rename is not cross-volume;
   `*.tmp` is git-ignored and excluded from isolation snapshots, 01 1.1).
2. `fh = open(tmp, 'wx', mode)` (O_EXCL: never follows or reuses an existing file); write all; `fh.sync()`; close.
3. Loop: `rename(tmp, file)`; on `EPERM | EBUSY | EACCES` wait `min(50 * 2^k, 250)` ms (k = attempt index from 0) and retry while elapsed
   < `budgetMs`.
4. On final failure: `unlink(tmp)` (ignore errors) and throw `AtomicWriteError('E_ATOMIC_WRITE_BUSY')`; any other error ->
   `unlink(tmp)` and `E_ATOMIC_WRITE_IO` with `cause`.

`readSmallFile`: `open(file, 'r')`, `stat`, size > `maxBytes` -> close, `SmallFileError('E_FILE_TOO_LARGE')`; read all, close in
`finally`. `EPERM | EACCES | EBUSY` on open or read: retry 10 x 20 ms (01 1.2 rule, E5 evidence), then `SmallFileError('E_FILE_BUSY')`.
`ENOENT` is rethrown unchanged (callers distinguish "absent").

**Shared legacy JSON files** (`task.json`, `config.json`, and any JSON the legacy engine also reads): written only through design 01's
`writePyJsonFile(path, value)` (PyJson serializer `dumpPyJson(v, {indent: 2}) + '\n'`, ADR 0003; byte-compatible with Python
`json.dump(indent=2, ensure_ascii=False)`, INV-02, gate G8), which calls `fsx.atomicWriteFile`. `JSON.stringify` is never used for these
files (01 1.9 E6: it differs from Python on 3,340 of 26,016 number lexemes). Node-owned JSON files (`instance.json`, `runtime.json`,
`state.json`, backups' `manifest.json`) follow 01's per-file rules (01 1.5-1.7, 5.5), also through `writePyJsonFile` or `atomicWriteFile`.

Rules for readers in the runtime: read and close immediately (`readSmallFile`); never keep `state.json`/`config.json` open; transcripts
are read through short-lived handles per scan slice (Node handles carry `FILE_SHARE_DELETE` and never block Claude Code's writes or
deletes). A stray `*.tmp` is removed by `mcs cleanup --task X --scope stale-state` when older than 10 minutes (01 4.13, 6.4).

### 4.4 Change detection: polling is truth, `fs.watch` is a hint (ADR 0052)

Facts: E7 (open-handle writer: 0 of 20 appends produce events; stat sizes always correct), E8 (current Claude Code writes do produce
events). Design 02's `ImportScheduler` (ADR 0015) already polls: `statTick` every 1000 ms over tracked files, discovery every
5000 ms "and on hints". This design supplies the hint source and the rule that it is never required for correctness:

```ts
// engine/src/platform/watch-hint.ts
export interface WatchHint { close(): void; readonly active: boolean; readonly failures: number }
export function createWatchHint(root: string, onHint: (absPath: string) => void, o?: { debounceMs?: number /* 100 */ }): WatchHint;
```

| Rule | Value | Reason |
|---|---|---|
| Source of truth | 02's stat polling (1000 ms) and discovery (5000 ms) | E7: a writer that keeps its handle open produces no events |
| Hint | one `fs.watch(root, { recursive: true, persistent: false })`; per path debounced 100 ms; `onHint(path)` -> 02 marks the file for the next slice and runs discovery for unknown paths | E8: lower latency for current Claude Code |
| Failure | on `error` close, `failures += 1`, health `ingest.watchHint = 'off'`, retry after 60 s | never affects correctness |
| Disabled | UNC/network roots, `MCS_FS_WATCH=0`, Linux `ENOSPC` (inotify limit) | `MCS_FS_WATCH` is read only by `createWatchHint` (`0` = no watcher, any other value or unset = watcher on); it changes latency, never results, and is listed in design 01 2.10's test and development variables table (critic I-27) |
Tests: `watch-hint.test.ts` (debounce, error -> retry, disabled for UNC strings) and, in 02's scheduler suite, "append through an open
handle is imported by polling within 1.5 s with no watch event" (S30 steps 21-25).

### 4.5 Line endings and BOM

| Input | Rule |
|---|---|
| Transcripts, spool | split on byte `0x0A`; a trailing `\r` is tolerated (`JSON.parse` treats it as whitespace); line 1 starting with U+FEFF: BOM stripped (legacy counted that line as invalid, D27 deliberate fix) |
| Chain log, ledger, live logs | `pySplitlines` (3.9.1): CRLF, CR and the Python extra separators |
| Git/docker/PowerShell output | split on `\n`, strip one trailing `\r` |
| Files written by the runtime | LF only, trailing newline |

### 4.6 Console and child output encoding

- Node writes to a Windows console with `WriteConsoleW` (Unicode regardless of code page); piped output is UTF-8. Windows PowerShell 5.1
  decodes piped native output with the OEM code page: troubleshooting entry T14 (7.2) documents `[Console]::OutputEncoding = [Text.Encoding]::UTF8`.
- Child decoding: PowerShell NET script sets UTF-8 explicitly (3.7.3); CLM fallback decoded as `latin1` (process names are ASCII);
  git: `log` subjects are UTF-8 (git default `i18n.logOutputEncoding`), status lines are only counted; docker UTF-8.
- Nothing in the runtime logs child stdout; only the first stderr line, clipped, in panel messages.

### 4.7 Hidden processes and detached start (closes open question 2, part 2)

- E9: a detached (`DETACHED_PROCESS`) or non-detached Node server started with `windowsHide: true` spawns console children without any
  visible window, with or without `windowsHide` on the child, piped or ignored stdio (Node 24.14.1). Method validated with a positive
  control (a visible minimized console has a non-zero `MainWindowHandle`).
- Rule for design 01's `start` (4.7): the server is started with `spawnDetached(process.execPath, [serverEntry, ...args], { cwd, env,
  stdoutFd, stderrFd })` (3.6; `detached: true`, `windowsHide: true`, stdout/stderr to `logs/boot.log`, then `unref()`), and every
  short-lived child through `execFileText` (3.6 rule 1). Unlike the legacy `Popen`, `DETACHED_PROCESS` is fine for Node because libuv adds
  `CREATE_NO_WINDOW` to hidden children.
- Regression test (win32 only) `hidden-console.int.test.ts`: port of `hidden-console.mjs`, launches a detached stand-in that calls
  `execFileText` for PowerShell, git (when present) and `process.execPath -e "setTimeout(()=>{},3000)"`, then asserts
  `MainWindowHandle == 0` for every child pid, with the positive control in the same test (skips the assertion and fails the test if the
  positive control does not show a window, so the detector itself is proven each run).

### 4.8 Reserved names, slugs, case collisions

- Slug rule (legacy, research C.7): `^[a-z0-9][a-z0-9-]{0,47}$`, reserved `con nul prn aux`. Node **creation** (`init`) additionally
  rejects `com1`-`com9` and `lpt1`-`lpt9` (Windows 10 device names; E11 shows Windows 11 build 26200 creates such names inside a
  directory as regular files, but other tools and older builds do not). Node **reading** accepts every slug the legacy rule accepts, so
  a legacy-created task opens. Lower-case only: no two slugs can collide by case.
- Workspace directories under `tasks/` that fail the legacy rule (for example created by hand as `Nightly`) are ignored by listings and
  reported by `doctor` as `foreign directory in tasks root`.
- Files the runtime creates: ASCII names, no `:` (invalid on Windows). Time-stamped names use `YYYYMMDDTHHMMSSZ` (UTC, no colons):
  backup folders `data/backups/<YYYYMMDDTHHMMSSZ>-<reason>/` (01 5.5), diagnostics `logs/diagnostics-<YYYYMMDDTHHMMSSZ>.json` (01 6.4),
  spool segments `data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson` (02, critic I-02). Export files are named by the user (`--out`, 01 6.4).
- Transcript ids: session ids are lower-case UUIDs, agent ids `[0-9A-Za-z_-]{3,64}`; on win32 two agent files differing only in case
  cannot coexist; the importer keys files by canonical path, so no double import.

### 4.9 Time and time zones

- Stored time: epoch ms UTC (D10). Transcript timestamps are ISO `Z` (survey 2.5). Chain-log times are local (3.10.4).
- Every engine module of this design reads time from 01's `Clock` (`ctx.clock.now()`, `packages/shared/src/time.ts`, critic I-36);
  tests pass 05's testkit `FakeClock`, which implements it; durations and budgets use `performance.now()`.
- Tests: Vitest `test.env.TZ = 'UTC'` in `runtime/vitest.config.ts` and a setup assertion `new Date(0).getTimezoneOffset() === 0`; the
  attempts and parity suites run a second time in CI with `TZ=Asia/Ho_Chi_Minh` (a non-UTC zone, the owner's) where the golden generator
  output is regenerated in the same zone (5.2.6). E13 proves both Python on Windows and Node honour `TZ=UTC`.

### 4.10 Platform support matrix

| Capability | win32 | linux | darwin |
|---|---|---|---|
| memory, cpu | verified E5, E6 | `os.*` UNVERIFIED (CI plan 3.7.1) | `freemem` understates (UNVERIFIED, documented) |
| per-process memory | verified E4 | `ps -A -o comm=,rss=` UNVERIFIED (CI) | same, UNVERIFIED (no CI runner planned; documented) |
| docker | verified (`measure-docker.ps1`) | same CLI, UNVERIFIED | same, UNVERIFIED |
| git panel | verified E16 | same commands, CI `git.test.ts` integration | UNVERIFIED |
| pid liveness | verified (research) | `kill 0` standard | standard |
| command line | CIM via PowerShell (E1 cost) | `/proc` | `ps -o command=` UNVERIFIED |
| hidden children | verified E9 | n/a | n/a |
| fs.watch hint | verified E7, E8 | recursive inotify, UNVERIFIED (CI scheduler test) | FSEvents, UNVERIFIED |
| atomic replace retry | verified E10 | rename is atomic over open files (POSIX); retry loop harmless | same |
Linux CI: `ubuntu-latest` runs unit + integration suites (not E2E). macOS: no runner; documented as best effort.

### 4.11 Tests that prove the platform guarantees

| Guarantee | Test (unit tests in `runtime/packages/engine/src/platform/`, `*.int.test.ts` in `runtime/packages/engine/test/platform/`; registry C47) |
|---|---|
| canonical identity | `paths.test.ts`: drive case, `/` vs `\`, 8.3 short temp path equals long path (E22), junction resolved, non-existing tail kept, UNC prefix strip (string), MSYS path rejected |
| atomic replace | `fsx.int.test.ts` (win32): a child Python/Node process holds the target open 600 ms -> write succeeds after retry with final content; held 4 s -> `E_ATOMIC_WRITE_BUSY` and no `.tmp` left |
| bytes in, bytes out; reader retry | `fsx.test.ts`: `atomicWriteFile` writes the given bytes unchanged (BOM-free UTF-8 for strings); `readSmallFile` retries a simulated `EBUSY` (injected `fs` stub) 10 x 20 ms, then `E_FILE_BUSY`; size cap -> `E_FILE_TOO_LARGE`; the shared-JSON byte format is proven by 01's `pyjson.golden.test.ts` and by the `json_atomic.json` vector run against 01's `writePyJsonFile` (5.2.4) |
| pid helpers | `process.test.ts`: own pid alive, 999999 not alive, `commandLineOf(own pid)` contains `node`, a second call within 5 s spawns nothing (spawn counter from `childStats`), invalid pid rejected without spawning; a `process.execPath -e "setInterval(()=>{},1000)"` child: `forceKill` then `waitForExit(pid, 5000)` -> `true`; `forceKill` of a dead pid resolves (Windows: `taskkill` exit 128 counted as success) (`listRuntimeProcesses` is tested by 01 S4) |
| platform branching confined | `platform-branching.test.ts` (section 4 rule) |
| no console windows | `hidden-console.int.test.ts` (4.7) |
| time zone pinned | `setup.ts` assertion |

---
## 5. Legacy parity and regression (closes open question 6)

### 5.1 Principles

1. The legacy engine is the oracle for every behaviour that the legacy API or files promise (research B, C). Goldens are produced by
   running it; nobody edits a golden by hand. Legacy files stay read-only (C1): the capture imports them from a temp-fixture context.
2. Parity is checked on three layers:
   - **L1 vectors**: pure legacy functions called with crafted inputs (`classify_state`, `external_state`, `clip`, `events_of`,
     `sessions.classify`, `slugify`/`check_slug`, `merge`/`provenance`, `str.splitlines`, `tail_lines`, `strptime`+`mktime`, audit entry
     format, `write_json_atomic`). Exact equality.
   - **L2 scenarios**: legacy fixture trees (`make.build_home`, `demo.build`, plus generator-owned panel and rule scenarios) served by the
     legacy HTTP server; Node serves the same tree; a projection maps Node API v3 to legacy shapes; a field matrix says what must be equal.
   - **L3 shadow**: both engines on real transcripts, read-only, reporting counts, ids and numeric deltas only.
3. Every deliberate difference is a row in the defect table (5.8) with a test that asserts the NEW behaviour; parity tests never "skip"
   a field silently: each field is EXACT, MAPPED, SET, CI (case-insensitive), TOL, DIFF(Dn) or IGNORED(reason).

### 5.2 Golden capture procedure (ADR 0053)

Relationship with design 05 section 4.11.4 (critic I-09, resolved): this section is the single golden-capture procedure; 05 4.11.4 and
ADR 0044 adopt it, keeping 05's live mode (`MCS_PARITY_LIVE=1`) and test-time projections and dropping the 10 s age-bucket rule (the
frozen clock makes ages exact; E12: two captures byte-identical). Ownership:
- slice PP2 (this design) owns `tests/legacy-parity/tools/**` (the Python generator) and `tests/legacy-parity/golden/**` (generated,
  committed by the lead) plus `tests/legacy-parity/README.md`;
- 05 slice S8 owns `runtime/tests/parity/{projections,normalize,run-python}.ts` and `runtime/scripts/parity-capture.mjs`, the wrapper
  behind `npm run parity:capture` that runs `python -B tests/legacy-parity/tools/capture_golden.py` with the arguments of 5.2.2 (and
  `--check` for `npm run parity:check`) and forwards its exit code.
The capture serves (a) the legacy trees built by `make.py`/`demo.py` and the generator's own panel/rule trees and (b) any testkit-built
tree passed with `--trees <dir>` (built at the frozen `now` by `node runtime/packages/testkit/dist/cli.js scenario`), under a frozen
clock, and stores raw legacy responses; projections run at test time, so a projection change needs no recapture.

#### 5.2.1 Files (new; nothing in the existing `tests/` changes)
```
tests/legacy-parity/
  README.md                         what the goldens are, how to regenerate, how to read a drift report
  tools/capture_golden.py           generator + --check (Python stdlib only, imports legacy code read-only)
  tools/determinism.py              frozen clock, seeded uuids, datetime shim, freeze_untouched()
  tools/vectors.py                  L1 vector definitions and their capture
  tools/panel_scenarios.py          generator-owned scenarios (logs/ledger/chain files, rule variants)
  golden/meta.json                  generator_version, legacy_version, legacy_code_stamp, python_version, frozen_now, tz, port_base, scenarios
  golden/trees/<scenario>.manifest.json      [{path, size, sha256, age_s}] sorted by path
  golden/api/<scenario>/<name>.json          [status, body] pairs (see 5.2.3)
  golden/cli/task-lifecycle.json             workspace files after a scripted command sequence + command outputs
  golden/vectors/<function>.json             [{case, input, output}] lists
```
Golden JSON is written with `json.dump(v, f, indent=1, sort_keys=True, ensure_ascii=False)` + `\n`, UTF-8, LF. Size from the dry run:
184 KB for the two legacy scenarios (E12); expected total with vectors and panel scenarios under 600 KB.

#### 5.2.2 Command line
```
python tests/legacy-parity/tools/capture_golden.py --out tests/legacy-parity/golden [--port-base 18850] [--tz UTC] [--trees <dir>]
python tests/legacy-parity/tools/capture_golden.py --check [--golden tests/legacy-parity/golden]
```
- Requires Python >= 3.8 (the legacy floor); goldens are captured with the Python version recorded in `meta.json` (3.14.3 today) and
  `--check` refuses to run with a different minor version (message names both). Captured on Windows because the trees contain
  text-mode CRLF files (5.3, E21).
- The tool re-executes itself with `-B` when `sys.dont_write_bytecode` is false (no `__pycache__` in the skill tree, C1).
- Sets `TZ` before importing anything (`os.environ['TZ'] = tz`; `time.tzset()` where it exists) (E13).
- Creates one `tempfile.mkdtemp(prefix='mcs-golden-')`, removes it in `finally` (the dry run leaked 4 dirs; fixed).
- Binds the legacy server to `127.0.0.1:<port-base>` (default 18850, legacy `bind` scans +19, inside 05's parity range 18850-18874), never 8765/3000/3100/8080/8089; stops it with
  `shutdown(); server_close()` in `finally`.
- `--check`: regenerates into a temp dir and compares file sets and bytes with `--golden`; on difference prints, per file, the first
  differing JSON pointer and both values clipped to 120 chars, then exits 1. Exit 0 prints `golden check: N files identical`.

#### 5.2.3 Determinism (verified by the dry run, E12)
| Source of variation | Control |
|---|---|
| wall clock in legacy (`time.time`) | `time.time = lambda: float(FROZEN_NOW)`, `FROZEN_NOW = 1790000000` (2026-09-21T14:13:20Z; no DST transition in any zone within +-2 days). Reader budgets never expire under a frozen clock, so every usage scan completes in one poll (deterministic `complete: true`) |
| `datetime.now` in `make.iso`, `demo.NOW`, `tasks.now_iso` | `FrozenDT` subclass injected as the modules' `datetime` attribute; `demo.NOW` reassigned after import |
| `uuid.uuid4` | `det_uuid(n) = UUID('%08x-0000-4000-8000-%012x' % (n, n))`, `n` = 1, 2, ... in draw order (valid lower-case session ids for `SID_RE`) |
| file mtimes not set by the builders (`running` session, workflow json, chain log, ledger, configs) | `freeze_untouched(root)`: every file with `mtime > FROZEN_NOW` is set to `FROZEN_NOW` |
| temp dir spelling | replace every form (short 8.3 and long name, raw, JSON-escaped once and twice, `/` form) with `<TMP>`, longest first |
| absolute paths inside generated files (`demo.config.json`) | manifest hashes the content after the same `<TMP>` replacement |
| machine values | `config_hash` -> `<MACHINE>`, `pid` -> `<PID>`, `url`/`port` -> `<URL>`/`<PORT>`, `code_stamp` -> `<STAMP>` (the real stamp goes to `meta.json`) |
| local time zone (chain log, `%H:%M` dates) | `TZ` pinned (default `UTC`) |
| registry (`~/.claude/sessions`) | `CLAUDE_CONFIG_DIR` = the scenario's temp home; registry scenarios write `<pid>.json` with `pid = os.getpid()` (alive) or `999999` (dead); goldens never contain the pid |

#### 5.2.4 Scenarios and captured outputs
| Scenario | Tree | Legacy config (flat, lenient) | Captured |
|---|---|---|---|
| `fixture` | `make.build_home(tmp/fixture-home)` | `{title:'fixture', repo: tmp, transcripts_dir: <tdir>, docker:false, panels:{machine:false, git:false}}` | API set A |
| `demo` | `demo.build(tmp/demo)` | the generated `demo.config.json` | API set A |
| `rules` | `panel_scenarios.rules_tree()`: one transcript per matrix case of 5.7 (first user records crafted per case) | per case a flat config with that case's `session_rules` | `/api/sessions?all=1` per case: `[{id, label, matched}]` |
| `panels` | `panel_scenarios.panels_tree()`: `logs/` with 6 files (CRLF, CR, `\x85`, `\u2028`, invalid UTF-8 at the cut, a 70 KB file), ledger with mixed lines, chain log with CRLF, a duplicate START, an END with unparsable time, an END without status group, a STOP file | panels logs/ledger/chain_log/attempts on, git off | `/api/logs`, `/api/overview`, `/api/attempts` |
| `registry` | fixture tree + `sessions/<pid>.json` files: busy (alive), idle (alive), waiting (alive), busy (dead pid) | fixture config | `/api/sessions?all=1` |
| `task-lifecycle` | empty temp repo | task workspace via CLI | `golden/cli/task-lifecycle.json` (below) |

API set A (each as `[status, body]`): `/api/sessions?all=1`, `/api/sessions`, `/api/sessions?hours=0.1&all=1`, `/api/attempts`,
`/api/overview`, `/api/logs`, `/api/config`, `/api/task`; per session id: `/api/events`, `/api/events?after=0&limit=5`,
`/api/events?before=5&limit=3`, `/api/search?q=step`, `/api/search?errors=1`, `/api/search?kinds=tool&tool=Bash`, `/api/locate?i=0`,
`/api/locate?ts=<first event t>`; per agent: `/api/events?sid=..&agent=..`; error cases: `hours=x` (400), unknown sid (404),
`after=x` (400), agent `../x` (404), `Host: evil.example` (403 text); `/api/health` reduced to its key set plus `reader`. `/api/machine`
is captured as a **shape** only (`{key: typeof}`) because values are machine-specific.

`task-lifecycle` script (frozen clock): `init-task --name "Nightly build: Steps A/B"`, `configure --set window_hours=12 --set panels.git=false --reason golden`,
`configure --unset window_hours --reason golden`, `configure --set session_rules=[{"match":"STEP=([A-Z])","label":"step {1}"}]`,
`decide --title "Use attempts" --decision "chain log" --rejected "none"`, `inspect`, `audit`, a refused `configure --set schema_version=2`,
a refused `configure --set nope=1`. Captured: stdout/stderr/exit code per command (normalized) and every file of the workspace
(`task.json`, `config.json`, `README.md`, `audit/changes.md`, `audit/decisions.md`) as text.

L1 vectors (`golden/vectors/`): `classify_state.json` (grid over every branch of research C.1 including boundary seconds),
`external_state.json`, `clip.json` (ASCII, emoji, combining marks, non-string values), `events_of.json` (every record shape of survey 8
items 1-18 reduced to legacy-visible fields), `classify_rules.json` (5.7), `slug.json`, `merge_provenance.json`, `splitlines.json`,
`tail.json`, `strptime.json` (each directive; failures as `null`), `audit_entry.json`, `json_atomic.json` (bytes as base64 of
legacy `write_json_atomic`; the Node side is design 01's `writePyJsonFile`, never `JSON.stringify`, 4.3).

#### 5.2.5 When the drift check runs
- CI job `legacy-parity-drift` (Windows runner, Python 3.14) on every change under `tests/legacy-parity/**`, `runtime/packages/testkit/**`,
  `runtime/tests/parity/**`; also nightly. A drift with unchanged legacy code is a generator determinism bug.
- Before cutover (G1) and whenever `src/backend`, `config/defaults.json`, `tests/fixtures/make.py`, `tests/tools/demo.py` change
  (they are frozen during the migration; a change means C1 was broken).

#### 5.2.6 Time-zone variant
The attempts and chain-log parity tests run a second time in CI with `TZ=Asia/Ho_Chi_Minh`: the job regenerates the `panels` and `demo`
scenario goldens into a temp dir with `--tz Asia/Ho_Chi_Minh` and points the Node suite at it (`MCS_GOLDEN_DIR`, a test variable listed
in design 01 2.10's test and development table, critic I-27). Nothing is committed for this variant.

### 5.3 Byte-identical legacy trees from TypeScript (ADR 0054)

`@mcs/testkit/legacy` exports `buildLegacyFixtureHome(out, ctx)`, `buildLegacyDemo(out, ctx)`, `buildPanelsTree(out, ctx)`,
`buildRulesTree(out, ctx)`, `buildRegistryHome(out, ctx)` with `ctx = { nowMs: 1790000000000, uuids: detUuidSequence(1), newline: 'crlf' | 'lf' }`.
Requirements, each needed for byte identity:
1. `pyDumps(value, { indent?: number })`: Python `json.dumps` defaults: separators `', '` and `': '` (with `indent`: `','` + newline and
   `': '`), `ensure_ascii=True` (every non-ASCII code unit as `\uXXXX`, astral characters as surrogate pairs, lower-case hex), integers
   as is, `True/False/None` as `true/false/null`, key order = insertion order (the TS builders insert keys in the Python dict order).
2. `pyIso(nowMs, offsetS)`: `YYYY-MM-DDTHH:MM:SS.mmmZ` where milliseconds are the **truncated** microseconds (`strftime('%f')[:-3]`).
3. uuid draw order identical to the Python builders (documented per builder in `legacy/ORDER.md`, for example `make.user()` and
   `make.assistant()` draw one uuid each, `result()` one, `build_home` draws the five session ids first).
4. Newlines: `write_jsonl` uses `newline='\n'` (LF everywhere); demo's `chain.log`, `status.md`, `demo.config.json` (indent 2) and the
   `.meta.json`/`wf-*.json` files are written in text mode, which is **CRLF on Windows** (verified in the dry-run tree: `chain.log` 378 B
   CRLF, `status.md` 226 B CRLF, `demo.config.json` 1,123 B CRLF). `ctx.newline` reproduces this; goldens are captured on Windows, so
   Linux CI builds with `newline: 'crlf'` for those files too.
5. mtimes: `fs.utimesSync(p, t, t)` with `t = (nowMs/1000 - ageS)` exactly as `make.age`, then `freezeUntouched`.
Test `runtime/tests/parity/legacy-trees.parity.test.ts`: for each scenario, the manifest of the TS-built tree equals `golden/trees/<scenario>.manifest.json`
(path, size, sha256, age_s). If this ever cannot be achieved for a file, that file is listed with its reason in `legacy/ORDER.md` and the
golden generator writes the file content into `golden/trees/<scenario>/<path>` (made-up data only), which the TS builder copies verbatim.

### 5.4 Comparison harness (`runtime/tests/parity/`, design 05 section 4.3)

Location and file names follow design 05 (module resolution through the runtime workspace; D1 artefacts stay in
`tests/legacy-parity/`). Goldens are read from `../../tests/legacy-parity/golden` relative to `runtime/` (or `MCS_GOLDEN_DIR`). This
section specifies what the `*.parity.test.ts` files must compare. 05 slice S8 owns `runtime/tests/parity/{projections,normalize,run-python}.ts`
(generic projections and normalisation, critic I-09); the legacy-shape projections below live in `runtime/tests/parity/legacy-shapes.ts`
(slice PP8), which imports 05's helpers.

Per L2 scenario:
1. Build the tree with `@mcs/testkit/legacy` into a temp dir; assert the manifest (5.3).
2. Create a Node instance in a temp workspace with the scenario's legacy config as `config.json` (schema_version 1 added), hooks
   disabled: build design 01's `InstanceContext` (01 4.4a / slice S8, `packages/engine/src/runtime/context.ts`, critic I-15, registry
   C15) with `claudeHome` = the tree's home, `mcsHome` = a temp folder, `clock = new FakeClock(FROZEN_NOW * 1000)` (05 testkit, a `Clock`, I-36), and
   `rt = createInstanceRuntime(ctx)` (`packages/engine/src/runtime/instance-runtime.ts`).
3. `await rt.start()`; `const r = await rt.ingestUntilIdle({ timeoutMs: 30000 })`; assert `r.idle === true` (01 4.4a maps 02's
   `IngestIdleTimeoutError` to `{ idle: false, stats }`; on `false` the test fails listing `r.stats`, registry C06); start the HTTP server for `ctx` on a port in `127.0.0.1:18875-18899` (05 4.5); after the comparisons `await rt.stop(5000)`.
4. Fetch v3 data, apply `legacy-shapes.ts` (built on 05's `projections.ts`; test-only code), compare field by field with the matrix below,
   report every mismatch with a JSON pointer.

Field matrix (`/api/sessions`):
| Legacy field | Rule | Node source / note |
|---|---|---|
| list membership for `hours`, `all` | SET, EXACT | session list filtered with the same window semantics (`mtime` age, pinned ids, unmatched rule) |
| list order | age asc; ties compared as SET | legacy tie order is glob order |
| `id`, `label`, `matched` | EXACT | label rules 5.7 |
| `age`, `size` | EXACT | transcript mtime (`trunc((now - mtimeMs)/1000)`), file size |
| `first_epoch` | TOL 1e-6 | `firstRecordAtMs / 1000` (D29) |
| `done` | MAPPED, EXACT | projection recomputes the v1 rule from age, last stop reason, agent ages |
| `state` | MAPPED, EXACT | `toLegacy()` of design 02 7.9 |
| `state_source` | MAPPED, EXACT | evidence source `attempts` -> `external`, registry -> `registry`, else `transcript` |
| `state_evidence` | EXACT for sessions without hook evidence, else IGNORED | design 02 7.9 rule 1 ports `classify_state` with byte-identical strings; with hooks the new evidence applies |
| `pending_tools` | EXACT | |
| `completeness.events`, `events_skipped_bytes`, `events_dropped` | DIFF(D28) | Node holds full history: `full`, 0 |
| `completeness.usage`, `usage_scanned_pct`, `invalid_lines` | EXACT | |
| `usage.in/out/cr/cc/turns` | EXACT under T1 (5.5) | own transcript |
| `usage.models` | SET | |
| `usage.first`, `usage.last`, `usage.stop`, `usage.complete`, `usage.scanned_pct` | EXACT | first record ts (file order), max ts (string compare), last stop reason |
| `usage_total.in/out/cr/cc/turns/complete` | EXACT under T1 | session aggregate incl. agents |
| `agents[]` membership | SET by `agent` | |
| `agents[].label/model/age/size/usage/done/state/state_source/pending_tools` | EXACT | as above |
| `agents[].workflow` | EXACT except DIFF(D1) scenario | |

`/api/events`: content fields `t, k, text, id, name, summary, err` EXACT; `input` compared after `JSON.parse` of both when neither is
truncated (Python `json.dumps` spacing differs from JS), else only the presence of the truncation marker; `summary` DIFF(D10) when the
key value is not a string. Index alignment: for full files `i` EXACT and `total/from/base/next` EXACT; for legacy-partial files (demo E)
the legacy list must equal the **last** `len(legacy)` Node events and `nodeI = legacyI + (nodeTotal - legacyTotal)`.
`/api/search`: matches `k, t, name, snippet` EXACT and `i` aligned as above; `count`, `truncated` EXACT for full files; for partial
files Node `count >= legacy count` (DIFF D28). `/api/locate`: aligned `i`, EXACT `t`.
`/api/attempts` (projection of `AttemptsPanel`): `part`, `n` (`nRaw ?? ''`), `model`/`effort` (`?? ''`), `start`/`end` (ms/1000),
`exit` (`exitRaw`), `status` (`statusRaw`), `sid`, `usage_total` (absent when unmatched), `state`: EXACT, last 30 rows in start order,
except rows marked DIFF(D20) in the `panels` scenario.
`/api/overview`: `ledger`, `chain` EXACT; `branch` (`null` -> `''`), `dirty` (`null` -> 0), `commits` (projection
`hash + ' ' + HH:MM(local of at) + ' ' + subject`) EXACT where git is enabled (no committed scenario enables git: git output is
machine-specific; covered by `git.test.ts`); `stop` EXACT when `panels.git` is true, IGNORED otherwise (only visible in the legacy UI
through the git panel).
`/api/logs`: `name`, `age`, `size`, `tail` EXACT, except DIFF(D25/D26) cases of the `panels` scenario.
`/api/machine`: shape only; `used_pct` TOL 1 when compared live (Win32 `dwMemoryLoad` vs computed); `procs[].name` CI.
`/api/config`: `panels`, `poll`, `ui`, `window_hours` (`windowHours`) MAPPED EXACT from `/api/v3/instance`; the rest IGNORED.
`/api/health`: IGNORED (new health model) except `reader.invalid_lines` vs ingestion stats EXACT.
`task-lifecycle`: workspace files written by the Node CLI for the same command sequence are **byte-identical** (task.json, config.json,
README.md, audit entries) - the files are shared with the legacy engine (research F.3). Command stdout is IGNORED (Node CLI text is its
own); exit codes EXACT; refusal messages MAPPED (same reason, new wording allowed). `inspect` provenance MAPPED: legacy `default` ==
Node `builtin|skill`, legacy `task` == Node `config`.

### 5.5 Token aggregate comparison (exact rules, no percentages)

Reference calculator `referenceUsage(files, { scope: 'per-file' | 'global', pyIntSemantics: boolean, iterationsFallback: boolean })` in
`runtime/tests/parity/reference-usage.ts`: an independent implementation (shares no code with `@mcs/engine`): reads each JSONL line, keeps
assistant records with an object `message`, key = `message.id || uuid || 'line' + byteOffset`, per key and field keeps the max of
integer values (`pyIntSemantics: true` also counts booleans as 0/1 like Python `isinstance(v, int)`), `iterationsFallback: true` uses
`usage.iterations[0]` when the four top-level numbers are all 0 and `iterations[0]` exists (survey 3.3). `per-file` scopes keys to a
file; `global` dedupes keys across all files.

| Rule | When | Assertion |
|---|---|---|
| T1 | every scenario except S29 (booleans) | design 02's `legacyFileUsage(fileId)` == legacy `usage` and `legacyUsageTotal(sessionId)` == legacy `usage_total` (in, out, cr, cc, turns, complete, plus `models/first/last/stop/scanned_pct` for `usage`), exactly; this includes resumed copies and zeroed records because 02 keeps the legacy per-file columns |
| T2 | resume copies (scenario S13); new totals = 02 `aggregateSession`/`aggregateInstance` | Node instance total == `referenceUsage(all, {scope:'global', iterationsFallback:true})`; legacy instance sum == `referenceUsage(all, {scope:'per-file'})`; and legacy - Node == sum over duplicated keys of `(fileCount(key) - 1) * maxFields(key)` exactly; per-session Node values follow the data-model attribution rule (the first file in import order owns a duplicated key) and are compared to `referenceUsage` computed with the same rule |
| T3 | zeroed top-level usage (S08) | Node == legacy + sum over affected keys of `iterations[0]` fields |
| T4 | boolean usage values (S29) | legacy == `referenceUsage(..., {pyIntSemantics:true})`, Node == `referenceUsage(..., {pyIntSemantics:false})` |
| T5 | partial scans | compare only when both report complete; Node must not report `complete: true` while any file of the session is unscanned (`usage-complete.test.ts`) |
| T6 | turns | Node `turns` == number of distinct keys (same key rule) |
| T7 | live shadow (5.6) | per stable session: legacy - Node == explained delta from T2+T3+T4 computed on the same files; any unexplained non-zero delta fails |

### 5.6 Session detection comparison

Offline: L2 scenarios (`fixture`, `demo`, `rules`, `registry`) through the matrix above, with `hours` and `all` variants.

Live shadow `cd runtime && npm run parity:shadow -- --task <slug> [--repo <path>] [--hours N] [--port-base 18850] [--keep]` (script
`runtime/scripts/parity-shadow.mjs` importing the built `packages/engine/dist` and `packages/testkit/dist`; run by the owner
or the lead; agents may run it only on the owner's instruction because it reads real transcripts):
1. Resolve the task's effective legacy config by reading `<repo>/.claude/monitor/tasks/<slug>/config.json` + `task.json` (read-only)
   and write a temp flat config with absolute `repo` and resolved `transcripts_dir`.
2. Start legacy: `python -B template/viewer.py serve --config <tmp>/legacy.json --port <port-base> --state-file <tmp>/legacy.state.json`
   (hidden, via `execFileText`-style spawn in the tool; never `--task`, so the task's own `state.json` and a running monitor are untouched).
3. Start Node: a temp instance dir (`<tmp>/node/`) with a copy of the config, hooks disabled, on `<port-base>+1`.
4. Wait until legacy `/api/sessions?all=1` reports `usage.complete` for every listed session (poll 2 s, max 300 s) and Node's
   `HealthReport.ingestion.transcripts.pendingBytes` is 0.
5. Take snapshots S1, S2 of both, 10 s apart. Stable sessions = same `size` and `age` delta of 10 s in both snapshots, `age > active_seconds + 60`.
6. Compare: id sets for (`all=0`, `all=1`) at S2; `matched`; agent id sets; legacy 5-state for stable sessions; tokens by T7 using the
   reference calculator on the same files; labels compared by SHA-256 only.
7. Print JSON `{legacyVersion, runtimeVersion, sessions: {legacy, node, stable}, diffs: [{sessionId, field, legacy, node, explained}], unexplained: n}`
   with numbers and ids only; exit 0 iff `unexplained == 0`. Stop both servers, delete `<tmp>` unless `--keep`.

### 5.7 `session_rules` and regex parity matrix

Python outcomes are captured by `vectors.py` through `sessions.classify(cfg, path)` on generated one-session transcripts (so the boilerplate
filter, the 401-line limit and `scope` are exercised end to end). Node outcome: the instance's session classifier with the translator of
design 01. "REJECT" = Node refuses the pattern at config validation (design 01 rule: accept only exact translations); the matrix then
asserts the Node error code `REGEX_UNSUPPORTED` (01 `compilePyRegex`) and records the Python result for information.

| Id | Case | Python result (captured) | Node expectation |
|---|---|---|---|
| R01 | `STEP=([A-Z]):` label `step {1}` | match, `step B` | EXACT |
| R02 | named group `(?P<s>[A-Z])`, label `{1}` | match via group 1 | EXACT (`(?<s>..)`) |
| R03 | label `{0}` with a match longer than 40 code points incl. emoji | first 40 code points | EXACT (code points) |
| R04 | `(a)|(b)` label `{1}-{2}` on `b` | `-b` | EXACT (`undefined` -> `''`) |
| R05 | group 1 text contains `{2}`, label `{1}{2}` | sequential replacement artefact | EXACT (same sequential loop) |
| R06 | `start.*end` across a newline | match (DOTALL) | EXACT (`s` flag for session rules) |
| R07 | `^STEP` where STEP is on line 2 | no match (no MULTILINE) | EXACT |
| R08 | `done$` on `done\n` | match | EXACT (translator) |
| R09 | `\Afoo` and `bar\Z` | anchors | EXACT (translator) |
| R10 | `\w+` on `\u00e9` (e acute) | match | EXACT (translator Unicode classes) |
| R11 | `\d` on Arabic-Indic digit | match | EXACT (translator) |
| R12 | leading `(?i)step` on `STEP=1` | match | EXACT (flag hoist) |
| R13 | `(?x)` verbose pattern | match | REJECT |
| R14 | lookbehind `(?<=STEP=)[A-Z]` | match | EXACT |
| R15 | possessive `a++` | match (3.11+) | REJECT |
| R16 | backreference `(?P<x>a)(?P=x)` | match | EXACT (`\k<x>`) |
| R17 | `scope: any`, match in the 3rd user text | match | EXACT |
| R18 | `scope: any`, one record with 3 text blocks at count 24 -> 27 texts, match only in the 26th | match (limit overshoot, D12) | EXACT |
| R19 | first text `<system-reminder>...` then the real prompt | label from the real prompt | EXACT |
| R20 | every text is boilerplate | `first_user_text` fallback (the boilerplate text) | EXACT |
| R21 | two matching rules | first wins | EXACT |
| R22 | rule without `label`, with `name` | `name` used | EXACT (undocumented fallback kept) |
| R23 | unmatched, multi-line prompt of 100 code points | stripped, newlines -> spaces, 70 code points | EXACT |
| R24 | no user text | `(no prompt)` | EXACT |
| R25 | pattern that is invalid in Python, legacy flat config | rule skipped at runtime | flat config: N/A in Node (served by the legacy engine, 01 6.5; D3); `config migrate --from-legacy` (01 2.7) refuses the untranslatable regex (`REGEX_UNSUPPORTED`) and reports dropped keys; task config: validation error in both engines. The test asserts these three outcomes |
| R26 | `tool_result` block containing the pattern | not a text candidate | EXACT |
| R27 | prompt only on line 402 | not seen | EXACT |
| R28 | invalid JSON lines before the prompt | consume line numbers | EXACT |
| R29 | `[[:alpha:]]` | literal set (FutureWarning) | EXACT (literal set; translator warns) |
| R30 | example patterns of `template/examples/chain.config.example.json` on sample lines | match/groups | EXACT |
| R31 | attempts `start` with trailing text after the pattern | match (anchored at 0 only) | EXACT (sticky) |
| R32 | attempts `end` without a `status` group | `status` None -> state by exit | EXACT |
| R33 | `(?i)step` vs `STEP` in attempts | match | EXACT |

### 5.8 Latent legacy defects: decision table (ADR 0055)

Ids map to design 05 section 4.11.5: PD1 = D1, PD2 = D2, PD3 = D3, PD4 = D4, PD5 = D5, PD6 = D6 + D7 + D20 + D22 (this is the
attempts design that PD6 defers to: D20 and D22 change behaviour, ADR 0055), PD7 = D18. 05's table should point here for the details.

| Id | Legacy behaviour (evidence) | Decision | Node behaviour | Parity treatment / test |
|---|---|---|---|---|
| D1 | `'workflows' in p` tests the whole path: an agent under a project path containing `workflows` is tagged as a workflow member (`sessions.py:138`) | FIX | workflow = the directory directly under `<sid>/subagents/workflows/` | scenario S28 `wf-path-trap`: DIFF; `agents.test.ts` |
| D2 | `init_task` `relpath` raises `ValueError` across drives, uncaught (`tasks.py:86`) | FIX | store the absolute repo path and note `repo stored absolute (different drive)` in the audit summary | `tasks.test.ts` with a mocked `path.relative` failure (no second drive needed) |
| D3 | legacy flat configs: validation problems computed, never raised (`config.py:187,196`) | N/A in Node | flat configs are served by the legacy engine (01 6.5 delegates every flat-config form to `$V`); `config migrate --from-legacy` (01 2.7) validates strictly: reports dropped keys, refuses untranslatable regexes; no `configWarnings` field anywhere (critic N-05, registry C43) | R25 |
| D4 | `usage_total` lacks `scanned_pct`, `models` | FIX | aggregate carries `models` (union), `scannedPct` (min), `complete` (AND) | projection drops extras |
| D5 | `config_hash` includes `_source_path` (machine-specific) | FIX | hash of the effective config without source paths, canonical JSON | IGNORED in parity |
| D6 | attempts consider sessions of the last 24 h only | REPRODUCE (default) | `runtime.json panelOptions.attemptsWindowHours`, default 24 | `attempts-match.test.ts` |
| D7 | a session can match several rows | REPRODUCE | same; latest START wins for lifecycle evidence | `attempts-evidence.test.ts` |
| D8 | dead state (`last_type`), unused imports | N/A | | |
| D9 | docs drift (`docs/api.md` example, `state.json` fields) | N/A | Phase 6 docs replace them | |
| D10 | tool `summary` of a non-string key uses Python `repr` (`['a', 'b']`) | FIX | `JSON.stringify` (`["a","b"]`) | `events_of.json` vector marked DIFF |
| D11 | `clip` counts code points | REPRODUCE | code-point clip with the same marker | `clip.json` vectors |
| D12 | `user_texts` may exceed 25 texts (extends whole records) | REPRODUCE | same | R18 |
| D13 | usage booleans count as integers (`isinstance(True, int)`) | FIX | booleans ignored | T4 |
| D14 | registry `waiting` status ignored (only busy/idle) | FIX (lifecycle design) | evidence "waiting for input" | `registry` scenario: DIFF on the waiting session |
| D15 | Python regex dialect | REPRODUCE via translator (D5 foundations) | exact translation or reject | 5.7 |
| D16 | attempts read only the last `max(64 KiB, 4000*400)` bytes of the chain log | FIX | incremental full history (3.10.3) | `panels` scenario keeps the log small, so EXACT |
| D17 | `git status` without `--no-optional-locks` every 10 s can hold `index.lock` during the owner's commit | FIX | 3.8 | `git.test.ts` |
| D18 | Host check rejects a bare `::1` (strip artefact) | API design (recommend FIX) | | |
| D19 | `--port 0` falls back to the config port | CLI design (recommend REPRODUCE, documented) | | |
| D20 | a second START for the same part leaves the first row open forever (RUNNING) | FIX | first row `superseded`, state UNKNOWN | `panels` scenario DIFF on that row |
| D21 | `%z` ignored by `mktime` | FIX | offset honoured | `strptime.json` vector marked DIFF |
| D22 | an attempt loses its session match once the session is older than 24 h | FIX | match kept once made | `attempts-match.test.ts` |
| D23 | docker: missing binary -> fake row `(docker unavailable)`, daemon down -> `[]` | FIX | `dockerStatus` + message | projection maps `unavailable` -> `['(docker unavailable)']`, `error` -> `[]` |
| D24 | `exit` raw text: `00` is non-zero | REPRODUCE | same | `external_state.json` |
| D25 | a log file vanishing between glob and `getmtime` fails the whole `/api/logs` poll | FIX | skip the file | `files.test.ts`; not reproducible in goldens (race) |
| D26 | `**` in `live_log_globs` is not recursive | FIX (deliberate deviation) | recursive | `panels` scenario: DIFF only for the `**` pattern case |
| D27 | a UTF-8 BOM on line 1 makes it invalid | FIX | BOM stripped | S24 DIFF on `invalid_lines` |
| D28 | events only from the last `event_window_mb` (8 MB) window; search and pending tools limited to it | FIX | full history in the DB | alignment rule 5.4 |
| D29 | `first_epoch` = first record with a timestamp in file order (not the minimum) | REPRODUCE (for attempts matching) | `firstRecordAtMs` | S27 (out-of-order timestamps) EXACT |
| D30 | resumed copies double-count tokens (per-file dedupe) | FIX (foundations D8) | global dedupe | T2 |
| D31 | zeroed top-level usage ignored | FIX (foundations D8) | `iterations[0]` fallback | T3 |
| D32 | `doctor` checks `python >= 3.8` | N/A | Node floor check | |
| D33 | `pending` and `last_stop` tracked by the events cursor only (window) | FIX | full history | equal on all committed scenarios (no tool pending across the window) |
| D34 | `/api/attempts` candidate sessions are the matched ones (`list_sessions(.., 24, False)`) | REPRODUCE | `matched || include_unmatched` | `attempts-match.test.ts` |
| D35 | evidence strings use `%d`/`//` truncation | N/A | evidence text not compared (5.4) | |

### 5.9 Cutover criteria (ADR 0056)

The SKILL.md procedure may name the Node engine primary (and the Python engine the fallback) only when every gate holds, each with a
recorded run (command, date, result) in the Phase 6 migration report:

| Gate | Requirement | Evidence |
|---|---|---|
| G1 | L1 + L2 parity suites pass on Windows (and the Linux-applicable part on Linux CI) with zero unexplained differences; `capture_golden.py --check` clean | CI logs |
| G2 | `npm run parity:shadow` (5.6) on the owner's active task(s): 3 runs at least 1 h apart, one while a chain step runs, one after a step ended PASS or FAIL: `unexplained == 0` | 3 JSON reports |
| G3 | lifecycle transition-table and property tests pass (lifecycle design) | CI |
| G4 | E2E brief-14 scenario list passes on Windows with Chrome; skipped steps listed with reason | Playwright report |
| G5 | performance budgets B1-B7 (section 8) met on this machine | benchmark JSON |
| G6 | two simultaneous instances: isolation tests pass; hook installer tests ran only against temp `--settings` files | CI |
| G7 | rollback rehearsal on a copy of a real task workspace: Node start/stop, then legacy `start` works on the same workspace with unchanged `config.json`/`task.json`/audit (byte compare) in under 2 minutes | rehearsal log |
| G8 | upgrade-from-existing: every task under the repo's tasks root opens in Node (`inspect`, `start`, `stop`) with `config.json`, `task.json`, `audit/*` byte-identical before/after | script output |
| G9 | operations, troubleshooting, migration docs and the new SKILL.md procedure written and reviewed | files |
| G10 | explicit owner approval in a user message; agents never flip the primary engine on their own | message |

After cutover: SKILL.md lists `$MCS` commands first and keeps a "Fallback: legacy Python engine" section with the unchanged
`template/viewer.py` commands; the legacy code stays unchanged for at least one minor runtime release and 30 days without a rollback;
removing it is a separate ADR. Rollback at any time = 7.1 "Rollback".

### 5.10 Tests that prove the parity guarantees

| Guarantee | Test |
|---|---|
| goldens reproducible | `capture_golden.py --check` (CI `legacy-parity-drift`) |
| TS trees equal legacy trees | `runtime/tests/parity/legacy-trees.parity.test.ts` |
| L1 vectors | `runtime/tests/parity/vectors.parity.test.ts`: every file in `golden/vectors/` against the Node function named in the file header |
| L2 scenarios | `runtime/tests/parity/{sessions,events,search,attempts,panels,config-regex,workspace-files}.parity.test.ts`, field matrix 5.4 |
| token rules | `runtime/tests/parity/tokens.parity.test.ts` (T1-T6 on S08, S13, S29 and the legacy trees) |
| deliberate differences | each DIFF row asserts the new value explicitly (no blanket skips): `runtime/tests/parity/diffs.parity.test.ts` |
| shadow tool safety | `runtime/tests/parity/shadow.test.ts` on a testkit tree: output contains no label text (assert the labels' substrings are absent), ports in range, temp removed |

---
## 6. Fixture and demo builders: additions to `@mcs/testkit`

### 6.1 Ownership and rules

`runtime/packages/testkit` is specified in three places; this section only adds to the other two and never redefines them:
- **Design 05 section 4.4** owns the core modules (`temp.ts`, `ports.ts`, `wait.ts`, `clock.ts`, `processes.ts`, `http.ts`,
  `transcript.ts` with `TranscriptBuilder`, `claude-home.ts` with `buildClaudeHome`, `hooks.ts` with `hookPayload`/`runHookHandler`,
  `workspace.ts`, `demo.ts` host, `canary.ts`; `clock.ts` holds only `FakeClock`, the `Clock` interface is 01's `shared/src/time.ts`, I-36) and the rules (every user-like string starts with `FIXTURE`, `FIXTURE.md` marker in temp
  roots, no real paths, deterministic ids, never reads the real `~/.claude`).
- **Design 04 section 11.5** owns the demo letter list (A-H) and `buildDemo`'s result contract.
- **This design** owns: `legacy/` (byte-identical legacy trees, 5.3), `pyjson.ts`, `io.ts`, `expect.ts`, `big.ts`, `scenarios/` (the
  catalogue below) and `cli.ts` (demo/scenario command line). The envelope type is `HookEnvelopeV1` from `@mcs/shared/protocol`
  (design 02 section 2.3.1); testkit never declares its own envelope type.

Testkit depends only on `@mcs/shared` (types) and `node:*`; never on `@mcs/engine` (engine tests depend on testkit; no cycle).

### 6.2 Additions (TypeScript signatures)

```ts
// pyjson.ts - Python json.dumps compatible serializer (5.3 rule 1) and timestamp format (rule 2)
export function pyDumps(value: unknown, opts?: { indent?: number }): string;
export function pyIso(nowMs: number, offsetS: number): string;          // 'YYYY-MM-DDTHH:MM:SS.mmmZ', microseconds truncated
export function detUuidSequence(start?: number): () => string;          // '%08x-0000-4000-8000-%012x' of a counter

// io.ts
export async function setAge(path: string, nowMs: number, ageS: number): Promise<void>;          // utimes(t, t), t = nowMs/1000 - ageS
export async function freezeUntouched(root: string, nowMs: number): Promise<void>;              // mtime > now -> now
export async function appendWithOpenHandle(path: string, lines: string[], o: { holdMs: number; gapMs: number }): Promise<{ fd: number; writes: number }>;  // E7 writer: one fd for all lines
export async function treeManifest(root: string, nowMs: number, o?: { placeholder?: { text: string; as: string } }): Promise<ManifestRow[]>;
export interface ManifestRow { path: string; size: number; sha256: string; age_s: number }       // same fields as the Python generator

// expect.ts - independent expectations, computed from builder inputs, never by parsing files
export interface UsageTotals { input: number; output: number; cacheRead: number; cacheCreation: number; turns: number }
import type { LegacyState } from '@mcs/shared';                       // 03 5.5 (registry C36); not redeclared here
export type LifecycleState = import('@mcs/shared').LifecycleState;     // design 02 section 7.1 (ten values)
export interface SessionExpectation {
  usageOwn: UsageTotals; usageTotal: UsageTotals;                      // new rules (global dedupe, iterations fallback, ints only)
  usageLegacyOwn?: UsageTotals; usageLegacyTotal?: UsageTotals;        // legacy rules, only where they differ (S08, S13, S29)
  legacyState: LegacyState | null; lifecycle: LifecycleState;
  pendingTools: number; toolCalls: number; toolErrors: number; invalidLines: number;
  label?: string; matched?: boolean;
}
export interface ScenarioExpectation { sessions: Record<string, SessionExpectation>; instanceUsage: UsageTotals }

// big.ts
export async function buildBigTranscript(path: string, o: { targetBytes: number; sessionId: string; seed: number; hugeLineBytes?: number /* 1315795 */ }):
  Promise<{ bytes: number; lines: number; expected: UsageTotals }>;      // streams; 70 MB = 62,735 lines (E14)

// scenarios/index.ts
export type ScenarioId = 'L-FIX' | 'L-DEMO' | 'L-PANELS' | 'L-RULES' | 'L-REGISTRY'
  | 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S06b' | 'S07' | 'S08' | 'S09' | 'S10' | 'S11' | 'S12' | 'S13' | 'S14' | 'S15' | 'S16'
  | 'S17' | 'S18' | 'S19' | 'S20' | 'S21' | 'S22' | 'S23' | 'S24' | 'S25' | 'S26' | 'S27' | 'S28' | 'S29' | 'S30' | 'S31' | 'S32' | 'S33' | 'S34';
export interface ScenarioSession { key: string; sessionId: string; transcriptPath: string; agents: { agentId: string; transcriptPath: string; workflow: string | null }[] }
export interface ScenarioResult {
  id: ScenarioId; claudeHome: string; projectDir: string; repo: string | null;
  sessions: ScenarioSession[]; expected: ScenarioExpectation;
  hookPayloads: Array<{ event: string; payload: Record<string, unknown> }>;   // raw stdin payloads (05 hookPayload), delivery order
  configJson: Record<string, unknown>;                                         // legacy-compatible config.json content, schema_version 1
  grow?: (step: number) => Promise<boolean>;                                   // S30 only
}
export function buildScenario(id: ScenarioId, root: string, o: { nowMs: number; seed?: number }): Promise<ScenarioResult>;
export function listScenarios(): { id: ScenarioId; title: string }[];
```
`TranscriptBuilder` options this catalogue needs and design 05's builder must accept (requested additions, same file):
`assistant({ outputPerRecord?: number[] /* survey 3.2 streaming growth */, zeroTopLevel?: boolean /* 3.3 */, booleanUsageField?: 'input_tokens' | 'output_tokens' /* D13 */, final?: boolean /* iterations on the last record */ })`,
`taskNotification({ taskId, toolUseId, status? })` (survey 8.17), `turnEnd({ ... })` already exists, `registry` entries through
`buildClaudeHome({ registry })` already exist.

Hook envelopes for spool tests are produced by the real handler: `runHookHandler(payload, { mcsHome })` (05) on each
`hookPayloads` item in a temp `MCS_HOME`, then the spool lines are read back; disorder/duplication cases (S32) are made by permuting or
repeating those real lines (`event_uid` kept), and malformed lines are appended as raw text. No hand-built envelope can drift from the
handler this way.

### 6.3 Scenario catalogue (`buildScenario`)

Timing convention: thresholds in each scenario config sit far from the ages used (`active_seconds` 120, grace 900, ages 20 s / 600 s /
2,000 s), at least 60 s from any boundary (05 4.11.3 stability margin), so expectations cannot flip within a run.

| Id | Title | Content (survey 8 item) | legacyState | lifecycle (02 7.1) | Used by |
|---|---|---|---|---|---|
| L-FIX | legacy `make.build_home` | byte-identical (5.3) | per golden | - | parity |
| L-DEMO | legacy `demo.build` A-G | byte-identical | per golden | - | parity |
| L-PANELS | generator panels scenario | byte-identical | - | - | parity (panels) |
| L-RULES | rule matrix trees | byte-identical | - | - | parity (5.7) |
| L-REGISTRY | registry entries | byte-identical, pids from the test process | per golden | - | parity |
| S01 | working | prompt, 3 tool rounds, last tool result 10 s ago | RUNNING | working | lifecycle, UI |
| S02 | waiting for input | `end_turn` + `turn_duration` 300 s ago + registry `waiting`, `waitingFor: 'permission prompt'`, alive pid (legacy ignores `waiting`, D14, and applies rule 8) | IDLE | waiting_input | lifecycle |
| S03 | waiting for tool | `tool_use` without result, 300 s ago (> active, < grace) | RUNNING | waiting_tool | lifecycle |
| S04 | waiting for child agent | `Agent` tool_use with `run_in_background`, result `async_launched`, `turn_duration.pendingBackgroundAgentCount: 1`, subagent file written 10 s ago | RUNNING | waiting_agent | lifecycle (8.17) |
| S05 | turn ended | `end_turn` text + `turn_duration` (no pending counts), quiet 600 s | IDLE | turn_ended | lifecycle (8.12) |
| S06 | completed (hooks) | S05 + trailing `cost-state` + payloads `Stop`, `SessionEnd{reason:'other'}` | IDLE | completed | lifecycle |
| S06b | completed (attempts) | S05 + chain log START/END `exit=0 status=PASS` matched by label | COMPLETED | completed | lifecycle, attempts |
| S07 | failed | attempts row `exit=1 status=FAIL` + payload `StopFailure{error:'server_error'}` | FAILED | failed | lifecycle |
| S08 | zeroed top-level usage | 2 ids with zeros on top level and `iterations[0]` populated (8.4) | IDLE | turn_ended | tokens T3 |
| S09 | stale | `tool_use` without result 2,000 s ago (> grace 900) | UNKNOWN | unknown (tool open beyond grace) | lifecycle |
| S10 | no records | 216-byte file of bookkeeping records only | UNKNOWN | unknown | lifecycle |
| S11 | workflow running | `Workflow` tool_use + result with `runId`; `subagents/workflows/<runId>/` with `journal.jsonl` (launched, 3 started, 1 result) and 3 agent files (2 written 10 s ago); no `workflows/<runId>.json` | RUNNING | waiting_agent | agents tree (8.19) |
| S12 | workflow completed | 4 agents ending with `StructuredOutput` + `toolEndsTurn` (8.20), `workflows/<runId>.json`, journal complete incl. one `failed` | IDLE | turn_ended | agents tree |
| S13 | resumed session copy | two session files sharing 40 uuids and 12 message ids, different `sessionId`; the old one ends with `continued-in` (8.21) | per file | per file | tokens T2, dedupe |
| S14 | huge transcript | `buildBigTranscript` 70 MB with one 1.3 MB line (survey 5) | IDLE | turn_ended | B4, importer slices |
| S15 | compaction | `compact_boundary` with full `compactMetadata`, `isCompactSummary` user, attachment variant, next assistant `cache_read_input_tokens: 0` (8.13) | IDLE | turn_ended | importer, tokens |
| S16 | API error | synthetic 529 record (8.5) as the last conversational record, quiet 600 s; its `stop_reason` is `stop_sequence` | IDLE (legacy rule 8) | turn_ended with `api_error` evidence (an API error alone is not a failure, 02 7.1 `failed` needs SessionEnd) | lifecycle, alerts |
| S17 | interrupted turn | `[Request interrupted by user]` with `interruptedMessageId`, the "for tool use" variant, `isAbortedMidStream` (8.6, 8.10), quiet 600 s | - (Node-only) | turn_ended (`turnOutcome: interrupted`) | lifecycle |
| S18 | pending tool at EOF + mid-file orphan | 8.9, last write 20 s ago | RUNNING | working | pending detection |
| S19 | parallel tools | one `message.id`, two tool_use records, two results (8.8), quiet 600 s | IDLE | turn_ended | pairing, tokens (one turn) |
| S20 | streaming snapshots | subagent id with 3 records, output 8, 8, 412; an unfinalized id (8.1, 8.3) | - | - | tokens (subagent lower-bound flag) |
| S21 | bookkeeping + cost-state | 8.14, 8.15 (incl. `[1m]` model key, empty `modelUsage`) after an `end_turn`, quiet 600 s | IDLE | turn_ended (foundations D9: a trailing `cost-state` is an inference, not SessionEnd) | importer: no activity from bookkeeping |
| S22 | attachments + notifications | 8.16, 8.17 (four statuses + event-only), quiet 600 s | IDLE | turn_ended | importer, agent outcome |
| S23 | denial | 8.11, quiet 600 s | IDLE | turn_ended | errors view |
| S24 | defensive encodings | partial last line, 1.3 MB line, invalid JSON line, CRLF lines, BOM on line 1 (8.23) | IDLE | turn_ended | importer; D27 |
| S25 | registry | `busy`, `idle`, `waiting`, `kind: bg`, dead pid, and a `<pid>.key` decoy (8.24; 05 `keyDecoys`) | per entry | per entry | registry reader; the decoy is never opened |
| S26 | project mapping | cwds with `.` and spaces, drive-letter case variants, a session whose cwd moves into a subfolder (8.25) | - | - | discovery (02 5.1) |
| S27 | order | a record earlier in time than its predecessor; `parentUuid: null` mid-file (8.22), quiet 600 s | IDLE | turn_ended | `first_ts_in_order` (D29), last activity = max |
| S28 | `workflows` path trap | project cwd containing `workflows`; a plain subagent under it | - | - | D1 |
| S29 | legacy quirks | boolean usage field, non-string `command` input, emoji at the 160 and 6,000 clip boundaries, quiet 600 s | IDLE | turn_ended | D10, D11, D13 |
| S30 | growing and replaced | `grow(step)`: one round per step for 20 steps (open-append-close), 5 steps through `appendWithOpenHandle`, then a truncation, then a replacement | RUNNING, then IDLE | working | incremental import, 4.4 polling rule |
| S31 | hooks only | payloads `SessionStart`, `UserPromptSubmit`, `PreToolUse` for a session whose transcript does not exist yet | - | working | hook ingestion, reconciliation |
| S32 | hooks + transcript, disordered | S01 transcript + its real spool lines with 2 swapped, 1 duplicated (same `event_uid`), 2 malformed lines | RUNNING | working | idempotency, ordering |
| S33 | two instances | two repos, two project folders, two workspaces, overlapping rule labels | per instance | per instance | isolation (05 4.8) |
| S34 | hostile strings | `<script>`, `javascript:` links, bidi overrides, 10k-character words, Markdown tables in text and tool input (04 H) | IDLE | turn_ended | UI safety |

### 6.4 Demo command line (`runtime/packages/testkit/dist/cli.js`, npm script `testkit`)

```
node runtime/packages/testkit/dist/cli.js list
node runtime/packages/testkit/dist/cli.js demo --out <dir> [--now <ISO|epochMs>] [--letters A,B,C] [--with-hooks] [--with-workspace] [--port 18900-18999] [--force]
node runtime/packages/testkit/dist/cli.js scenario --id <id> --out <dir> [--now ...] [--force]
node runtime/packages/testkit/dist/cli.js big --out <file.jsonl> [--mb 70] [--seed 1] [--huge-line-kb 1285]
```
- `demo` calls `buildDemo` (04 contract). Arguments via `node:util` `parseArgs`. Exit 0 success, 1 failure, 2 usage.
- Guards (exit 1, nothing written): `--out` resolves (canonical, 4.1) under the real Claude home (`CLAUDE_CONFIG_DIR` or `~/.claude`), under
  the skill folder outside `runtime/**/test*`, or equals the user's home; `--out` exists and is not empty without `--force`;
  `--port` outside 18900-18999 (05 4.5 "manual experiments").
- Writes the 05 `FIXTURE.md` marker at the root.
- `--with-workspace`: writes a legacy-format task workspace `demo` (05 `buildTaskWorkspace`) under `<out>/repo/.claude/monitor/tasks/demo/`.
- `--with-hooks`: writes `<out>/hooks/<letter>.json` raw payload lists; never installs hooks anywhere (C3).
- Prints one JSON object `{ out, claudeHome, repo, workspace, sessions: [{ letter, sessionId }], env: { CLAUDE_CONFIG_DIR }, next: [string] }`;
  `next` contains for example `CLAUDE_CONFIG_DIR=<home> node .claude/skills/monitoring-claude-sessions/scripts/mcs.mjs start --repo <out>/repo --task demo --port 18920`.

### 6.5 Tests that prove the additions

| Guarantee | Test (`runtime/packages/testkit/src/`) |
|---|---|
| determinism | `scenarios.test.ts`: every scenario built twice into two temp dirs -> identical `treeManifest` |
| byte identity with legacy | `runtime/tests/parity/legacy-trees.parity.test.ts` (5.3) |
| record shapes | `shapes.test.ts`: required keys per record type (survey 2.2, list in `shapes.json`); one content block per assistant record; `message.id` repeats per block |
| expectations are right | `expectations.test.ts`: a small independent reader inside the test (no builder code) recomputes usage per file and per instance and equals `expected` |
| real envelopes | `hooks-scenarios.test.ts`: S31/S32 spool lines come from `runHookHandler`; every `session_id`/`tool_use_id` exists in the transcripts |
| pyDumps | `pyjson.test.ts` against `golden/vectors/pydumps.json` (Python outputs: nested dicts, non-ASCII, astral, indent 2) |
| guards | `cli.test.ts`: refuses a fake Claude home target (`CLAUDE_CONFIG_DIR` set in the test env), non-empty dir, bad port; writes `FIXTURE.md` |
| open-handle writer | `io.test.ts`: `appendWithOpenHandle` returns `{ fd, writes }`; every write used that one fd (instrumented `fs.write` spy) and the final size equals the sum of line lengths |
| big file | `big.test.ts` with 2 MB: size, line count, one huge line, expected usage |

---

## 7. Operations runbook content (for Phase 6 `docs/operations.md` and `docs/troubleshooting.md`)

Every command below is design 01's command surface (01 6.3 table, 6.4 details); each step cites the 01 section that defines it, and
health fields are 03 6.2's `HealthReport` (critic I-12). Nothing here defines a command or a flag: if 01 or 03 change, this text follows
(slice PP11 re-runs every command against a demo instance). Shell setup used below:
```bash
# Git Bash
MCS="node .claude/skills/monitoring-claude-sessions/scripts/mcs.mjs"
```
```powershell
# Windows PowerShell 5.1 / PowerShell 7
function mcs { node .claude/skills/monitoring-claude-sessions/scripts/mcs.mjs @args }
```

### 7.1 `docs/operations.md` outline with concrete commands

1. **What runs where** (01 1.1). One instance = one task workspace `<repo>/.claude/monitor/tasks/<slug>/` = one Node process + one
   SQLite DB (D2, D3). Files: `task.json`, `config.json`, `README.md`, `audit/changes.md`, `audit/decisions.md` (shared with the legacy
   engine, byte-compatible); `instance.json`, `runtime.json`, `state.json`, `run/control.token`, `data/monitor.db` (+ `-wal`, `-shm`),
   `data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson` (hook write-ahead log, 02 2.7; `.ndjson` so that the legacy `audit` does not flag it,
   critic I-02), `data/exports/` (temporary `.tmp-<random>.db` files of the export route, 03 11.1; removed by `cleanup --scope
   stale-state` after 10 min, 01 1.1, registry C39), `data/backups/<backupId>/` (01 5.5), `logs/runtime.log` (+ `.1`..`.5`), `logs/boot.log` (+ `.1`).
2. **Prerequisites** (01 5.1; 01 6.4 `doctor`). `node --version` (>= 22.22.0, 24 recommended; an older Node makes `$MCS` print
   `ERROR: Node >= 22.22.0 is required (found <v>); install the Node 24 LTS` and exit 1, `NODE_TOO_OLD`, 01 5.1); the first `$MCS` command bootstraps the
   runtime (`npm ci` + build, stamped; D6); `$MCS doctor` prints each check as `{check, ok, detail, level}`. Windows PowerShell 5.1 is
   used for per-process memory and command-line checks only; `git` and `docker` are optional.
3. **Create or adopt an instance** (01 6.4 `discover`; 01 4.12 `init`; 01 6.4 `configure`, `inspect`, `check`).
   ```bash
   $MCS discover                                   # transcripts folder, recent sessions, tasks, instances (read-only)
   $MCS init --name "Nightly build"                # slug from the name (or --slug nightly-build); legacy-compatible files + instance.json
   $MCS configure --task nightly-build --set 'session_rules=[{"match":"STEP=([A-Z0-9]+)","label":"step {1}"}]' --reason "label steps"
   $MCS inspect --task nightly-build               # effective config with provenance
   $MCS check --task nightly-build                 # one-line summary (legacy format)
   ```
   An existing legacy task is adopted by `init` with the same slug (01 4.12 step 4: adds `instance.json`, `data/`, `logs/`; never
   rewrites `config.json`, `task.json` or `audit/*`; gate G8).
4. **Start, stop, restart, status, verify** (01 4.7, 4.9, 4.10; 01 6.4 `instances list`).
   ```bash
   $MCS start --task nightly-build [--port P] [--open]   # idempotent: "started: <url> (pid N)" or "already running: <url> (pid N)"
   $MCS status --task nightly-build                # legacy JSON + new keys (StatusReport, 01 4.10); exit 0 iff running
   $MCS verify --task nightly-build                # health, instance, sessions, overview, /api/health schema-validated; exit 0 iff all valid
   $MCS restart --task nightly-build
   $MCS stop --task nightly-build                  # graceful control-channel shutdown; forced kill only after the runtime-marker check
   $MCS instances list                             # every task of the repo: engine, state, url, pid, version, outdated
   ```
   `already running (engine=legacy)`: a Python viewer serves this task (01 4.14); see item 10.
5. **Health** (03 6.2 `HealthReport`, `GET /api/v3/health`; `$MCS status` shows a summary). Fields to read: `status`
   (`ok | degraded | error`); `runtime` (`version`, `codeStamp`, `outdated`, `pid`, `uptimeMs`, `eventLoopDelayP99Ms`, plus the resource
   fields requested by critic I-21: `rssBytes`, `heapUsedBytes`, `cpuUserMicros`, `cpuSystemMicros`); `db` (`ok`, `sizeBytes`, `walBytes`,
   `freeDiskBytes`, `schemaVersion`, `lastError`); `ingestion` (`status`, `reasons`, `hooks.lastReceivedAt`, `hooks.spoolPendingBytes`,
   `hooks.spoolLagMs`, `transcripts.filesTracked`, `transcripts.importLagMs`, `transcripts.pendingBytes`, `transcripts.invalidLines`);
   `alerts`; `errors`; and (I-21) `children` (spawn counts per `ChildKind`, 3.6) and `panels` (`PanelStats`, 3.4). A panel with
   `status: partial` is a panel-source condition, not an instance problem. Snapshot for a bug report:
   `$MCS diagnostics --task X [--out FILE]` (01 6.4: `mcs.diagnostics/1` bundle whose `health` member is this `HealthReport`; redacted,
   no transcript text).
6. **Recovery** (01 4.13, 5.4, 5.5, 6.4; 03 4.4).

   | Situation | Commands |
   |---|---|
   | process died, `state.json` left behind | `$MCS status --task X` (probe `stale`) -> `$MCS start --task X` (01 4.13: start proceeds, the server overwrites `state.json`, nothing is killed) |
   | stray `*.tmp`, orphan token | `$MCS cleanup --task X --scope stale-state` (plan) -> same with `--yes` (01 6.4) |
   | port range busy | `start` scans `server.portScan` ports above the base (01 4.11); or `--port <p>`; find the holder with `netstat -ano` |
   | `SQLITE_BUSY` in the log | wait; never delete `-wal`/`-shm` by hand while the server runs; `$MCS doctor --task X` (`database integrity`) |
   | DB older than the runtime (start exit 16) | `$MCS upgrade --task X --dry-run` -> `$MCS upgrade --task X --yes --restart` (01 5.4), or `$MCS db migrate --task X --yes` |
   | migration failed | `$MCS backup list --task X --verify` -> `$MCS backup restore --task X --id <the upgrade backup> --yes` (01 5.5); or fix the cause (disk, permissions) and rerun `$MCS db migrate --task X --yes` (03 4.4) |
   | DB corrupt (`db.ok: false`; doctor `database integrity` fails) | `$MCS stop --task X` -> `$MCS backup list --task X --verify` -> `$MCS backup restore --task X --id <newest valid> --yes` (01 5.5) |
   | DB corrupt, no usable backup | `$MCS stop --task X` -> `$MCS db rebuild --task X --yes --confirm X` -> `$MCS start --task X` (01 5.4: the DB files move into a backup with sha256 in its manifest, audit `db-rebuild`; the next start creates a new DB and re-imports the transcripts and spool segments still on disk; history no longer on disk is lost). There is no `reimport` command (critic I-12) |
   | hook delivery failing | `$MCS hooks verify --task X` (01 6.3); events wait in `data/spool/*.ndjson` and the running server drains them; health `ingestion.hooks.spoolPendingBytes` shows the backlog |
   | transcripts folder missing | `$MCS discover`; `$MCS configure --task X --set 'transcripts_dir="<path>"' --reason "<why>"` |

7. **Export and backup** (01 6.4 `export`; 01 5.5 `backup`).
   ```bash
   $MCS backup --task X [--label L]                # data/backups/<YYYYMMDDTHHMMSSZ>-manual/ + manifest.json; prunes beyond backup.keep (default 5)
   $MCS backup list --task X [--verify]            # id, reason, created, sizes, versions; --verify re-checks sha256
   $MCS backup restore --task X --id <backupId> --yes   # stopped instance only; makes a pre-restore backup first
   $MCS export --task X --out <file> [--since ...] [--until ...] [--session ID]... [--force]   # mcs.export/1, metadata only
   $MCS export --task X --out <file> --include-content                                       # adds content as defined by 03 11.1
   ```
   `export` refuses an existing file without `--force` and any path inside another workspace or `~/.claude` (01 6.4).
8. **Cleanup and retention** (01 6.4 `cleanup` scopes; 03 11.3 `applyRetention`). Every scope is a dry run without `--yes`.
   ```bash
   $MCS cleanup --task X --scope stale-state [--yes]                 # stale state.json, orphan token, *.tmp older than 10 min
   $MCS cleanup --repo . --scope init-leftovers [--yes]              # dead .init-* staging folders
   $MCS cleanup --task X --scope logs [--older-than 30d] --yes       # rotated logs, boot.log.1, diagnostics-*.json
   $MCS cleanup --task X --scope backups [--keep 5] --yes            # never the newest upgrade backup
   $MCS cleanup --task X --scope spool [--older-than 7d] --yes       # stopped instance; fully drained segments only
   $MCS cleanup --task X --scope data --yes --confirm X              # stopped instance; automatic backup first; retention policy
   ```
   Never touches transcripts, other workspaces, `config.json`, `task.json`, `audit/`.
9. **Upgrade** (01 5.3, 5.4). `$MCS status --task X` shows `outdated: true` -> `$MCS restart --task X` (code changed, same DB schema) or
   `$MCS upgrade --task X --yes --restart` (backup, DB migrations, audit record). A DB newer than the runtime is refused
   (`DB_NEWER_THAN_RUNTIME`, D13): use the newer runtime or restore the pre-upgrade backup.
10. **Rollback** (01 5.6, three levels).
    ```bash
    # level 1: engine fallback for one task (no data risk)
    $MCS stop --task X
    $MCS instances set-engine --task X legacy --yes
    $MCS start --task X                             # delegates to the legacy viewer (01 6.5)
    # back to Node
    $MCS stop --task X && $MCS instances set-engine --task X node --yes && $MCS start --task X
    ```
    The legacy engine can also be run directly: `python .claude/skills/monitoring-claude-sessions/template/viewer.py start --task X`.
    Level 2 (runtime version rollback): stop all instances, check out the previous skill commit, then
    `$MCS backup restore --task X --id <pre-upgrade backup> --yes` when the DB schema is newer than the old runtime supports. Level 3:
    the Python-only skill (tag `pre-v3-python`); Node files in workspaces are ignored by the legacy engine.
11. **Hooks** (01 6.3, 6.4 `hooks *`; details in `docs/hooks.md`). `$MCS hooks install --scope project-local --task X` (dry run: plan
    and consent text) -> same with `--yes`; `$MCS hooks verify --task X`; `$MCS hooks status --task X` (installed scopes, last envelope per instance; 01 6.3, critic N-11);
    `$MCS hooks uninstall --scope project-local --yes`;
    `$MCS hooks enable --task X` / `$MCS hooks disable --task X`. Hooks are optional; transcripts alone keep the monitor correct (D8).
12. **Logs** (01 1.1, 1.6, 1.8; 05 S-LOG). `logs/runtime.log`, rotated to `runtime.log.1`..`.5` at 10 MiB (constants
    `LOG_ROTATE_BYTES`, `LOG_KEEP` of 05's logger, S-LOG-6 per critic I-25); `logs/boot.log` (+ `.1`) holds the detached server's
    stdout and stderr. Level: `runtime.json` `logLevel` (`$MCS configure --task X --set 'logLevel="debug"' --reason "<why>"`), env
    `MCS_LOG_LEVEL`, or `$MCS start --task X --log-level debug`. Logs never contain prompts, search queries, tool output or tokens.
    Recent server errors: `$MCS errors --task X [--since <ISO>]`.
13. **Everyday reads** (01 6.3). `$MCS sessions list --task X [--state S]`, `$MCS sessions show --task X --session ID`,
    `$MCS usage --task X --by model`, `$MCS verify-completion --task X --session ID [--expect completed|failed|terminal]`, `$MCS version`.
14. **Reference.** Ports (default 8765 + `server.portScan`; tests 18000-18999, 05 4.5), process markers (01 4.1), file list (item 1),
    budgets (section 8), Windows notes (section 4).

### 7.2 `docs/troubleshooting.md` table (symptom -> checks -> cause -> fix)

| Id | Symptom | Checks | Cause | Fix |
|---|---|---|---|---|
| T1 | `start` did not become healthy (01 4.7) | `$MCS doctor --task X`; tail `logs/boot.log` and `logs/runtime.log` | invalid config (exit 10), port range busy (13), DB newer (15) or older (16) than the runtime, bootstrap failed | fix the reported item; `$MCS start --task X --port <free>`; exit 16 -> `$MCS upgrade --task X --yes --restart` |
| T2 | `already running (engine=legacy)` (01 4.14) | `$MCS status --task X` (delegates) or `python .../viewer.py status --task X` | a legacy viewer serves the task | use it, or stop it and start Node (7.1 item 10) |
| T3 | `stop` says the pid is not this instance's runtime (01 4.9) | - | stale `state.json`, pid reused | nothing was killed; the stale file was removed. `NOT_OUR_PROCESS` (exit 1): a live process without the runtime marker; stop it by hand only after checking what it is |
| T4 | UI shows STALE or "connection lost" | `$MCS status --task X`; health `runtime.eventLoopDelayP99Ms` (03 6.2) | server down or event loop blocked | `$MCS restart --task X`; attach `$MCS diagnostics --task X` to the report |
| T5 | empty session list | `$MCS doctor --task X` (`transcripts folder found`, `rules match at least one session`) | wrong repo, rule mismatch, window too short | adjust `session_rules`, `window_hours`, show unmatched |
| T6 | finished job shows "turn ended" | session evidence list | transcripts cannot prove completion | configure `chain_log` + `attempts`, or install hooks (SessionEnd) |
| T7 | tokens marked "lower bound" | `completeness` fields | scan in progress, or subagent records without a final usage (survey 3.2) | wait; for subagents it is permanent and labelled |
| T8 | machine panel: per-process memory unavailable | `powershell -NoProfile -Command "Get-Process \| Select-Object -First 1"` | PowerShell missing, blocked (AppLocker) or restricted | nothing required; the rest of the panel works |
| T9 | CPU shows no value on first load | - | the first CPU sample has no previous sample (legacy contract) | next poll shows it |
| T10 | docker list shows an error | `docker ps` | Docker daemon not running | start Docker Desktop or `$MCS configure --task X --set docker=false --reason "<why>"` |
| T11 | git panel "not a git repository" | `$MCS inspect --task X` (`effective.repo`) | wrong `repo` | `$MCS configure --task X --set 'repo="<path>"' --reason "<why>"` |
| T12 | `index.lock` errors while committing | - | not caused by the monitor (`--no-optional-locks`, 3.8) | check other tools; report if the monitor is suspected |
| T13 | `E_ATOMIC_WRITE_BUSY` in the log, or CLI `WORKSPACE_INVALID: cannot replace <name>: EPERM` (01 1.2 wrapper of 4.3) | which program holds `state.json`/`config.json` | an editor or antivirus held the file > 3 s | close it; rerun the command |
| T14 | garbled non-ASCII in piped CLI output (Windows PowerShell 5.1) | - | PowerShell decodes native output with the OEM code page | `[Console]::OutputEncoding = [Text.Encoding]::UTF8`, or `--json` to a file |
| T15 | console windows flash | `node --version`; run `hidden-console.int.test.ts` | regression in a child spawn | report with the Node version; every spawn must go through `execFileText` |
| T16 | attempts table empty | `$MCS doctor --task X` (`chain_log exists`, `regexes translate exactly`); `GET /api/v3/panels/attempts` -> `data.sourceState` and `sources[0].message` | chain log missing (`missing`), `chain_log`/`attempts` not configured (`not_configured`), START regex or `time_format` never matches | fix the regex (Python syntax, translated) or the format with `$MCS configure` |
| T17 | an attempt stays RUNNING | the chain log's END line for that part; `rows[].evidence` in the attempts panel | END line not matched by `attempts.end`, or its `part` group differs from the START's | fix the END regex; superseded STARTs show UNKNOWN by design (D20) |
| T18 | 403 through a proxy or tunnel | - | loopback-only, Host/Origin checks | open `http://127.0.0.1:<port>` locally |
| T19 | DB file keeps growing | health `db.sizeBytes`, `db.walBytes`; `$MCS cleanup --task X --scope data` (plan only) | retention too long | `$MCS configure --task X --set 'retention.<key>=<value>' --reason "<why>"` (keys: 03 3.8); `$MCS stop --task X`; `$MCS cleanup --task X --scope data --yes --confirm X`; `$MCS start --task X` |
| T20 | monitor CPU higher than expected | health `children` and `panels` (03 6.2, I-21) | many open Overview tabs are free, but per-process sampling every 20 s costs about 1% | `$MCS configure --task X --set panelOptions.machineProcessIntervalMs=60000 --reason "<why>"` (runtime.json); or `--set panels.machine=false` |
| T21 | `node` too old | `$MCS` prints `ERROR: Node >= 22.22.0 is required (found <v>); install the Node 24 LTS` (exit 1, 01 5.1) | Node < 22.22.0 | install Node 24 LTS |
| T22 | bootstrap `npm ci` fails with node-gyp | `runtime/.npmrc` | `ignore-scripts=true` missing (stack-versions finding 4) | restore `.npmrc`; rerun `$MCS doctor` |
| T23 | legacy `viewer.py audit` flags a file in the workspace | the file name | a `*.jsonl` file outside the Node layout (Node spool segments are `.ndjson`, critic I-02) | move the file out of the workspace; `$MCS audit --task X` explains Node-specific problems |

---
## 8. Performance and resource budgets

### 8.1 Budgets (this machine class: Windows 11, 12 logical CPUs; Node 24)

| Id | Budget | Pass condition | Baseline evidence |
|---|---|---|---|
| B1 | RSS per instance | idle (no client, 10 sessions in window): p95 of 5 s samples over 10 min <= 110 MB; 300 transcripts known + one tab: <= 160 MB | E15: 80-88 MB with Express + better-sqlite3 + zod loaded; legacy 27-48 MB |
| B2 | CPU, no client | Node self CPU <= 0.3% of one core averaged over 10 min with no transcript change; <= 1.0% with one session being written; 0 child spawns without clients | E15 idle 0.00%; legacy 0.1% |
| B3 | CPU, one tab | Overview page polling with every panel on, one active session: Node self + children <= 3.0% of one core over 10 min; a second tab adds <= 0.5 points | 3.5 estimate 1.7% for panels; legacy 3-4% |
| B4 | first import of a 70 MB transcript | tokens complete and events persisted <= 8 s wall; event-loop delay p99 <= 50 ms during import; RSS peak <= idle + 200 MB | E14: parse + dedupe alone 0.23 s, 20 ms per 4 MiB slice |
| B5 | API latency | idle: p95 <= 50 ms for `/sessions` (100 sessions), a 250-event transcript page, cached `/panels/*`; during B4: p95 <= 250 ms | - |
| B6 | start to healthy | `$MCS start` -> healthy <= 3 s with an existing DB and nothing to import | legacy waits up to 12 s |
| B7 | per-process sampling | <= 250 ms child CPU per Windows sample; <= 3 PowerShell spawns per minute with one tab (default 20 s) | E4: 187 ms median, 250 max |

### 8.2 What the runtime must expose for measurement (`HealthReport`, design 03 6.2; critic I-21)
Everything below is read from `GET /api/v3/health` (`HealthReport`, 03 6.2); design 01's `DiagnosticsBundle` (`mcs.diagnostics/1`,
01 6.4) carries the same object as its `health` member, so `mcs diagnostics` captures it offline. There is no separate
`DiagnosticsReport` type. Fields the benchmarks need (03 6.2 owns the type; the additions were requested by critic I-21):
```ts
// additions to HealthReport (03 6.2)
runtime: { /* existing */ eventLoopDelayP99Ms: number;            // monitorEventLoopDelay, reset every minute (existing)
           rssBytes: number; heapUsedBytes: number;               // process.memoryUsage().rss / .heapUsed at request time
           cpuUserMicros: number; cpuSystemMicros: number };      // process.cpuUsage() since process start (cumulative)
children: Record<ChildKind, ChildKindStats>;                      // childStats() of 3.6 (cumulative since start; every kind present)
panels: PanelStats;                                               // PanelService.stats() of 3.4
```
`ChildKind`, `ChildKindStats`, `PanelStats` are exported by `shared/src/api/panels.ts` (3.3) so that 03's schema can import them.
Child CPU is not visible to Node on Windows, so benchmarks multiply spawn counts by a per-kind calibration measured on the same
machine (B-cal). Benchmarks compute rates from two samples (`delta(cpuUserMicros + cpuSystemMicros) / delta(wall)`).

### 8.3 Benchmark scripts (`runtime/bench/`, plain ESM scripts run with `node`, importing built `dist/` outputs; results gitignored; ports 18900-18949)

| Script | What it does | Output |
|---|---|---|
| `calibrate-children.ps1` (Windows) | port of `measure-child.ps1`/`measure-enc.ps1`/`measure-git.ps1`/`measure-docker.ps1`: 6 runs per `ChildKind` command with `ProcessStartInfo` + `TotalProcessorTime` | `results/calibration-<date>.json` `{kind: {cpuMsMedian, cpuMsMax, wallMsMedian}}` |
| `bench-first-import.mjs --mb 70 --runs 3 --port 18900` | builds `buildBigTranscript` into a temp Claude home, starts an instance (child process, hooks off), polls `/api/v3/health` every 100 ms until `ingestion.transcripts.pendingBytes === 0` and the session's usage reports complete; samples event-loop delay and RSS | B4 JSON: wall, p99 delay, RSS peak, per run + median |
| `bench-idle.mjs --minutes 10 --clients 0\|1\|2 --port 18901` | starts an instance on a testkit demo (`buildDemo`), runs N headless pollers that replay the UI intervals from `/api/v3/instance.poll` (03 6.2, registry C26: `machineMs` 2 s, `logsMs` 3 s, `overviewMs` 5 s for git/ledger/chainLog, `attemptsMs` 6 s, `sessionsMs` 6 s, `healthMs` 5 s, with the default config); samples `/health` every 5 s | B1, B2, B3 JSON: `nodeCpuPct`, `childCpuPct` (spawn counts x calibration), `rss p95` |
| `bench-api.mjs --port 18902` | 200 sequential + 200 at concurrency 4 per endpoint, idle and during a concurrent `bench-first-import` | B5 percentiles p50/p95/p99 |
| `bench-start.mjs` | 5 x `start`/`stop` on an existing workspace | B6 |
Each script prints one JSON document and exits 1 when a budget fails; `npm run bench` runs them in sequence (about 25 min). Benchmarks run
at phase boundaries (Phase 5 end, Phase 6 gate G5), never in the unit CI.

---

## 9. CHALLENGES

**CH-1 (D2 cost made explicit, no change requested).** One process per instance costs about 80-88 MB RSS per instance before any data
(E15), against 27-33 MB for the legacy engine. Three instances = about 250 MB. I keep D2 (isolation benefits stand) and set B1 to
110 MB idle; alternatives (several instances in one process; `--max-old-space-size` tuning) were not measured and are not proposed.

**CH-2 (design 05 section 4.11.3-4.11.4, golden capture engine) - resolved by critic I-09.** 05 captured goldens from testkit fixtures
built at the real `now`, stored normalised projections, and bucketed ages to 10 s because "the Python engine has no injectable clock".
Evidence E12: the legacy engine runs deterministically in-process when `time.time`, `uuid.uuid4` and `datetime.now` are replaced from
outside the legacy files (two full captures byte-identical, no legacy file touched, `git status` clean). Resolution: 5.2 is the single
procedure; 05 4.11.4 and ADR 0044 adopt it, keep 05's live mode and projections, and drop the bucket rule; ownership split in 5.2 and
section 13. Fallback kept on record: 05's real-now capture with buckets, if the frozen clock ever stops being sufficient (for example a
future legacy change reading `time.monotonic`).

**CH-3 (04-ui panel types, compatible extension).** 04-ui returned bare panel objects from `GET /panels/:key`; this design wraps them in
`PanelResponse` (status, per-source states) because a panel can be partially fresh (process list 20 s old while memory is fresh) and the
legacy stale/error lines need per-source information. The `data` member is exactly the 04-ui type plus additive fields. Critic I-10
makes 04 import these types from `@mcs/shared` (`api/panels.ts`) and read `PanelResponse.data` in `usePanel`.

**CH-4 (design 05 S-PROC 3, environment allow-list).** The allow-list works for docker, PowerShell and git on this machine (E23), but a
user with a remote Docker context (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`) would see the local daemon or an error. Requested:
pass these three through for the `docker` kind only.

---

## 10. Depends on other designs (shapes used here)

- Design 01: `compilePyRegex(source, 'session_rule' | 'attempts'): CompiledPyRegex` (throws `McsError` `REGEX_UNSUPPORTED`),
  `PyMatch.groupdict()`, `applyLabelTemplate`; `runtime.json` `panelOptions.attemptsWindowHours` and `panelOptions.machineProcessIntervalMs`;
  `writeWorkspaceFile`, `writePyJsonFile` and PyJson (1.2, 1.9, ADR 0003); `Clock` in `packages/shared/src/time.ts` (4.4a, I-36); the
  `panelOptions` schema module written by S1 from 3.5's key table (1.6, N-03); `InstanceContext` in `packages/engine/src/runtime/context.ts`
  and `createInstanceRuntime(ctx) -> { start, stop(deadlineMs), ingestUntilIdle({timeoutMs}) -> {idle, waitedMs, stats}, health() }` in
  `packages/engine/src/runtime/instance-runtime.ts` (4.4a / S8, critic I-15, registry C06/C15), whose component 4 calls
  `createPanelService(ctx, { writer: ingest.writer })` and drives `tickAttempts()` with a 2 s timer (critic N-01, registry C57); CLI
  commands and flags of 6.3/6.4 used in section 7, incl. `db rebuild` (5.4); backup layout and `backup.keep` (5.5); the stop marker check
  that calls `commandLineOf` (4.9) and `listRuntimeProcesses` in `platform/markers.ts` (4.2, S4); `spawnDetached`/`spawnForeground`
  signatures (4.2); error code `CONFIG_INVALID` and the 2.4 Node-only validation additions (critic N-06); Node floor 22.22.0 (5.1).
- Design 02: `HookEnvelopeV1` (2.3.1), logical events `external.attempt` (with `endedAt`) and `external.attempt_cleared` (4.3, I-18),
  `IngestWriter`/`IngestBatch` (4.6) and the shared `IngestService.writer` (4.10), `checkIdentity`/`readLines` (5.3, ADR 0015), `ImportScheduler` hints input (5.4), `sanitizeProjectName` and
  `detectTranscriptsDir` (5.1), `transcript_file.first_ts_in_order` (4.1), `legacyFileUsage`/`legacyUsageTotal` (6.5),
  `aggregateSession`/`aggregateInstance` (6.3), `LifecycleState` (7.1), `Stamp`/LWW join (7.2), S-1 (7.4), legacy mapping (7.9), spool
  segment name `hooks-<YYYYMMDD>T<HH>Z.ndjson` (2.7, I-02).
- Design 03: tables `attempt_sources`/`attempt_runs` and indexes `idx_attempt_runs_*` (3.5, I-07); `AttemptsRepo` and
  `SessionsRepo.attemptCandidates` plus a by-id `session_uid` lookup (3.6); `withWriteTx(db, ctx, fn)` (4.5); change kind `attempt/upsert`
  (9.1); `HealthReport` (6.2) with the I-21
  additions; route `panel` with `response: PanelResponseSchema` in `shared/src/api/routes.ts`; `IsoTime` (`api/time.ts`), `TokenUsage`
  (`api/entities.ts`); uniform error envelope and `panel_disabled` (404); `/api/v3/instance.poll`; recovery guidance (4.4); export
  `mcs.export/1` (11.1); `applyRetention` (3.8, 11.3).
- Design 04: `buildDemo` contract and letter list (11.5); consumes `@mcs/shared` `api/panels.ts` (I-10).
- Design 05: S-PROC security rules for `exec.ts`, S-FS (`engine/src/security/paths.ts`), S-LOG (incl. S-LOG-6 rotation), ESLint flat
  config (owner of `eslint.config.js`), testkit core modules (4.4) incl. `hookPayload`/`runHookHandler`, parity layout
  `runtime/tests/parity/` and its `projections.ts`/`normalize.ts`/`run-python.ts` (S8), port ranges (4.5), `TZ=UTC` rule (4.6), CI scripts.

## 11. Requirements covered

- Brief 8.1 (overview dashboard): panel data with a defined source, TTL and aggregation rule per field (3.3-3.10); no fabricated or
  unlabelled precision (`sampledAt`, per-source status, `cpuPct: null` first sample, lower-bound token flags).
- Brief 7 / requirement R-7.E.13 (attempts as a persisted entity): attempts runs persisted in 03's `attempt_sources`/`attempt_runs`
  (3.10.2, critic I-07), ingested incrementally by a 2 s tick (3.10.3), published as lifecycle evidence after commit with
  deterministic precedence (3.10.7).
- Brief 8.8 (diagnostics): panel source errors and stats in `HealthReport.panels`, child statistics in `HealthReport.children`
  (8.2, critic I-21); troubleshooting table 7.2.
- Brief 8.9 (CLI diagnostics) and 8.10 (health, export, backup, retention, cleanup, version info, diagnostics): runbook 7.1 items 4-13,
  every command taken from design 01 6.3/6.4 (critic I-12).
- Brief 12 (security/reliability): safe subprocess handling (3.6 with 05 S-PROC, one authoritative `execFileText`), no command execution
  from the web, symlink-aware identity (4.1, containment by 05 S-FS), timeouts and output caps, one atomic-write module with Windows
  retry (4.3), platform branching confined and lint-enforced (section 4), malformed input tolerance (tails, spool lines, JSONL),
  loopback notes, no secrets in logs or panel messages.
- Brief 13 Phase 6: compare session detection (5.6), compare token aggregates (5.5), lifecycle transitions through parity and scenarios
  (5.4, 6.3), large and changing transcripts (S14, S30, B4), two instances (S33, G6), restart and recovery (7.1 item 6, G7), clean
  installation and upgrade from existing configuration (G8, 7.1 items 3 and 9), documentation (7), verified migration report (5.9).
- Brief 14: unit tests (panels, platform, attempts, token rules), integration tests (panels against real git/PowerShell/docker, CLI
  diagnostics shapes), E2E fixtures and demo (6.3, 6.4); skipped tests recorded (5.9 G4).
- Brief 15: OPERATIONS and troubleshooting content (7); testing commands (5.2.2, 6.4, 8.3).
- Brief 17-18: fallback path kept until regression checks pass (5.9); token regression coverage (5.5); existing functionality preserved or
  deliberately replaced with a record (5.8); shared legacy files stay byte-compatible through 01's PyJson writer (4.3, INV-02, G8).
- Foundations open question 2 (Windows per-process memory without a native dependency; detached start without console windows): closed by
  3.7.3 / ADR 0050 and 4.7 / E9. Open question 6 (golden capture procedure; latent defects): closed by 5.2-5.8, ADRs 0053-0055, single
  procedure agreed with design 05 (critic I-09).
- Foundations D2, D3, D6, D7, D8 (recursion guard env in children), D9 (COMPLETED/FAILED only from evidence), D10 (epoch ms), D12
  (pid and command-line helpers), D13 (upgrade refusal in the runbook) respected.

## 12. Open items (explicit)

Items owned by other designs that this document already follows (it uses the shapes named in the critic's fixes; when the owning design
lands the change, nothing here changes):

| Id | Item | Owner | Resolution path |
|---|---|---|---|
| OI-1 | 04 `usePanel` reads `PanelResponse.data` and maps `status`/`sources`; 04 section 13 imports panel types from `@mcs/shared` `api/panels.ts` (CH-3) | 04 (critic I-10) | contract test `panels.contract.test.ts` |
| OI-2 | `attempt_sources` / `attempt_runs` in `0001_initial.sql`, `AttemptsRepo`, `SessionsRepo.attemptCandidates` (3.10.2 now points at 03 3.5/3.6, critic N-10) and a `SessionsRepo` by-id `session_uid` lookup used to map row ids to provider ids | 03 (critic I-07, N-10) | 03 S1/S2; PP5 depends on it |
| OI-3 | logical event `external.attempt_cleared { sessionId, observedAt }`, LWW clear of `attempt`, S-1 treats `null` as no evidence, transition-table row; `external.attempt` carries `endedAt` and `observedAt` = publication stamp (3.10.7) | 02 (critic I-18) | 02 4.3, 7.3, 7.4 (done in 02 4.3) |
| OI-5 | docker env pass-through in 05 S-PROC (CH-4) | 05 | add the three variables for kind `docker` |
| OI-6 | `HealthReport.runtime.{rssBytes, heapUsedBytes, cpuUserMicros, cpuSystemMicros}`, `HealthReport.children`, `HealthReport.panels` (8.2); `DiagnosticsBundle.health` carries the `HealthReport` | 03 6.2 and 01 6.4 (critic I-21) | 03 adds the fields importing `ChildKind`, `ChildKindStats`, `PanelStats` from `shared/src/api/panels.ts` |
| OI-8 | `workspace/fsio.ts` becomes a thin async wrapper over `platform/fsx.ts`; `writePyJsonFile` writes through `fsx.atomicWriteFile` | 01 1.2 (critic I-28) | 01 S4 |
| OI-9 | 01 4.2 imports `execFileText(ChildSpec)` and `process.ts` from this design and keeps `mutex.ts` and `markers.ts` (`listRuntimeProcesses`); 01 4.2 and ADR 0006 adopt `taskkill.exe /PID <pid> /F` for `forceKill` and drop `ExecutableName` (kind and resolution of `opener` are here, 3.6) | 01 (critic I-06, registry C11-C13) | 01 S4 = `mutex.ts` + `markers.ts` + `fsio.ts` |
| OI-10 | `PLATFORM_ENTRY` added to the engine and logger blocks of `runtime/eslint.config.js` (section 4) | 05 S1 (critic I-34) | lint config change; PP1's `platform-branching.test.ts` proves it |
| OI-11 | `MCS_FS_WATCH`, `MCS_GOLDEN_DIR`, `MCS_PARITY_LIVE` listed in 01 2.10's test and development table | 01 (critic I-27) | env-var grep test (05 S1) |
| OI-12 | logger rotation constants `LOG_ROTATE_BYTES = 10 MiB`, `LOG_KEEP = 5` (S-LOG-6) cited by 7.1 item 12 | 05 (critic I-25) | 05 S6 |
| OI-13 | spool segment extension `.ndjson` (`SPOOL_SEGMENT_EXT`) cited by 7.1 item 1 and T23 | 02 (critic I-02) | 02 I-1 |
| OI-14 | 01 4.4a component 4: `createPanelService(ctx, { writer: ingest.writer })`, `start()` arms the 2 s `tickAttempts` timer (first call at start), `stop()` clears it then `close()` (3.2) | 01 (critic N-01, registry C57) | 01 S8 |
| OI-15 | 03 3.6 (attempts paragraph) and its I/O table row drop "inside the same transaction": the events are submitted through the writer after the attempts COMMIT (3.10.7) | 03 (critic N-01) | 03 S2 |
| OI-16 | 01 2.4 Node-only additions list `attempts.time_format` (`pyStrptimeValidate`, 3.10.1) and MSYS `/<letter>/` paths on win32 (4.1) as `CONFIG_INVALID` messages | 01 (critic N-06, registry C42) | 01 S1/S2 |
| OI-17 | Node floor 22.22.0 in 05 3.2 (repository scripts); 05 4.11.5 PD3 = N/A in Node like D3 (5.8) | 05 (critic I-05, N-05, registry C28, C43) | 05 S1 |

Former OI-4 (capture engine choice) is closed by critic I-09 (CH-2). Former OI-7 (`mcs db rebuild`) is closed: 01 5.4 defines it and
7.1 item 6 uses it (critic I-12, registry C44). The `panelOptions` bounds are now stated in 3.5 (critic N-03) and equal the values
01 1.6 already transcribes (`attemptsWindowHours` 1..8760, `machineProcessIntervalMs` 10000..300000), so 01's "until 06 states one"
note is settled without a change of value. No open item is owned by this design.

## 13. Phase 2+ task slices (dependency order; each independently testable)

Order follows the critic's slice check (99 section 3): PP0 with 03 S3; PP1 merged into the 01 S4 slot and before 01 S9 and PP7; PP5 and
PP7 after 03 S1 and 01 S8; parity slices after the ingestion and API slices; PP11 last, with 01 S16 and 05 S10.

| Slice | Phase | Depends on | Files owned | Done when |
|---|---|---|---|---|
| PP0 panel contracts | 2 | 05 S1 scaffold; 03 S3 `api/time.ts`, `api/entities.ts` (same change allowed) | `shared/src/api/panels.ts` (types, zod schemas incl. `PanelResponseSchema`, `ChildKind`, `ChildKindStats`, `PanelStats`), `shared/src/api/panels.test.ts` | schema round trip for one sample per `PanelKey`; `PanelResponseSchema` rejects a mismatched `key`/`data`; 03 S3's route `panel` compiles against it |
| PP1 platform layer | 2 | 05 S1; PP0 (`ChildKind`) | `engine/src/platform/{exec,process,fsx,host,paths,glob,pytime,watch-hint}.ts`, their unit tests next to them (incl. `platform-branching.test.ts`) and `engine/test/platform/*.int.test.ts`; 01 S4 keeps `platform/mutex.ts`, `platform/markers.ts` and `workspace/fsio.ts` (I-06, I-28, registry C13) | 3.11 exec/glob/pytime rows and 4.11 pass on Windows; Linux CI unit run green; 01's T-LC-16 (only `exec.ts` imports `node:child_process`, `windowsHide: true` on every spawn) passes against PP1's `exec.ts` and 01's `fsio.ts` wrapper tests (atomic retry) pass against `fsx` |
| PP2 golden generator | 2-3 | none (Python only) | `tests/legacy-parity/README.md`, `tests/legacy-parity/tools/**`, `tests/legacy-parity/golden/**` (generated, committed by the lead) (I-09) | two captures -> `--check` clean; skill tree clean (`git status`), no `__pycache__`; temp dirs removed |
| PP3 testkit additions | 2-3 | 05 testkit core (S2/S3) | `testkit/src/{pyjson,io,expect,big}.ts`, `testkit/src/legacy/*`, `testkit/legacy/ORDER.md`, `shapes.json`, tests 6.5 | 6.5 rows pass |
| PP4 parity skeleton | 3 | PP1, PP2, PP3, 01 S1/S2/S4/S5/S6, 05 S8 (parity layout) | `runtime/tests/parity/{reference-usage.ts,vectors.ts,legacy-trees.parity.test.ts,vectors.parity.test.ts}` | manifests equal for all L-* trees; `vectors.parity.test.ts` passes exactly these vector files: `splitlines.json`, `tail.json`, `strptime.json` (PP1), `pydumps.json` (PP3), `slug.json`, `merge_provenance.json`, `audit_entry.json`, `json_atomic.json` (01). Later vector files are added by the slice that ports the function, each as its own `runtime/tests/parity/vectors/<name>.parity.test.ts` using `vectors.ts` `runVectorFile(file, fn)`: `external_state` (PP5), `classify_state` (02 I-7), `classify_rules` (02 I-8, with 01 S3 translator), `events_of`, `clip` (03 S7) |
| PP5 attempts | 3 | PP1, 03 S1/S2 (tables of 03 3.5, `AttemptsRepo`, `SessionsRepo`, I-07, N-10), 02 I-3 (tailer), 02 I-8 (writer) with `external.attempt_cleared` (I-18), 01 S3 (`compilePyRegex`) | `engine/src/panels/attempts/{parse,state,ingest,match,evidence,repo}.ts`, `engine/src/panels/attempts/attempts-*.test.ts`, `runtime/tests/parity/vectors/external_state.parity.test.ts` | 3.11 attempts rows (incl. the stamp-ordering cases); L-PANELS attempts parity EXACT except D20 rows |
| PP6 scenario catalogue + CLI | 3-4 | PP3, 05 S3 (`hookPayload`, `runHookHandler`), 02 I-2 (handler) | `testkit/src/scenarios/*`, `testkit/src/cli.ts` | every scenario deterministic; expectations test passes; CLI guards |
| PP7 panels | 4-5 | PP0, PP1, PP5, 01 S8 (`InstanceContext`, `createInstanceRuntime` with component 4's writer and 2 s timer, OI-14), 03 S4 (route adapter) | `engine/src/panels/{source-cache,machine,proc-win32,proc-posix,git,files,service,constants}.ts`, `server/src/routes/panels.ts`, `engine/src/panels/*.test.ts`, `engine/test/panels/*.int.test.ts` | 3.11 rows pass; Windows integration tests pass; `HealthReport.panels` and `.children` filled (after 03 adds the fields, OI-6); B7 measured |
| PP8 parity harness | 3-6 (grows) | PP4, 01 S8 (`createInstanceRuntime`), 02 I-8, 03 S5, 05 S8 | `runtime/tests/parity/legacy-shapes.ts` and `runtime/tests/parity/{sessions,events,search,attempts,tokens,config-regex,workspace-files,panels,diffs}.parity.test.ts` | L2 matrix green for every committed scenario; T1-T6 green |
| PP9 shadow tool | 6 | PP8, 01 S9 | `runtime/scripts/parity-shadow.mjs`, `runtime/tests/parity/shadow.test.ts` | `unexplained == 0` on a testkit tree; no label text in output; ports 18850-18899; temp removed |
| PP10 benchmarks | 5-6 | PP6, PP7, 01 S9, 03 S4 (health with I-21 fields) | `runtime/bench/**` | scripts produce JSON; B1-B7 evaluated and reported |
| PP11 troubleshooting doc + runbook check | 6 | 01 S9-S14 (CLI final), 01 S16 (`docs/operations.md` owner), 03 S4 | `docs/troubleshooting.md` (section 7.2); section 7.1 is the content source for 01 S16's `docs/operations.md` (01 owns that file) | every command in 7.1 and 7.2 executed once against a testkit demo instance (ports 18900-18999), outputs pasted into the migration report; any command missing from 01 6.3 fails the check |
