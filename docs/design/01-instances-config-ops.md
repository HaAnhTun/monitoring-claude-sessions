# 01 Instances, configuration and operations (Layer A: skill, CLI, instance lifecycle)

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design. ADRs: `docs/decisions/0001` to `0009`.
Revision 2 (2026-10-11, after the cross-design review in `99-requirements-matrix.md`): fixes I-01 (runtime sections of 02/03), I-05
(one Node floor), I-06 (one process helper, owned by 06), I-15 (server composition root, 4.4a), I-19 (`entriesBetween`), I-20
(`ConfigInspection`), I-27 (complete environment list), I-36 (`Clock`); aligns with I-02 (`.ndjson` spool), I-08 (`explainCompletion`),
I-12 (`db rebuild`), I-21, I-23, I-24, I-25, I-26, I-28 (`platform/fsx.ts`), I-29 (`ingest replay`), I-30, I-31, I-34.
Inputs read: `00-foundations.md` (D1-D15), the owner's brief MEGA-PROMT-V3 sections 2, 4, 12, 13, 15, 17, 18,
`docs/research/current-state-backend.md` (sections A-G), `claude-code-hooks.md` (sections 3, 6, 10), `stack-versions.md`,
`ccam-*-analysis.md` (installer, retention, security), legacy `src/backend/{config,tasks,cli,__init__,proc}.py`, `SKILL.md`,
`docs/{architecture,configuration,troubleshooting,development,changelog}.md`, and the drafts `04-ui.md` and the runtime scaffold
(`runtime/scripts/build-stamp.mjs`, owned by `05-tooling-testing-security.md`). Every measurable claim below is backed by an
experiment in section 9 (E1-E14) or marked UNVERIFIED with a plan.

Reading order for an implementer: section 0 (terms and invariants), then the section of your slice (see "Phase 2+ task slices" at
the end), then section 9 for the evidence behind it.

---

## 0. Scope, terms, invariants

### 0.1 Scope
In scope: the workspace (files, schemas, byte compatibility with the legacy engine), configuration (precedence, merge, validation,
provenance, versions, migration, the Python-regex translator, JSON Schemas), instance identity and isolation guarantees with their
tests, the process lifecycle (start, serve, stop, restart, status, verify, crash recovery, init transaction), the launcher
`scripts/mcs.mjs`, version reporting and upgrade/rollback/downgrade, the complete CLI surface, the audit trail, the security of the
control plane, and the proposed `SKILL.md` (appendix A).

Not in scope (other designs own them; this document only states the contract it needs, listed in "dependsOnOthers"):
DB DDL, migrations content and query functions (data design); hook handler, spool format and hook installer internals (ingestion
design); lifecycle state machine and evidence (lifecycle design); `/api/v3` endpoints, Host/Origin guard, SSE (API design);
React UI (`04-ui.md`); build/test tooling, logger, stamps (`05-tooling-testing-security.md`).

### 0.2 Terms

| Term | Meaning |
|---|---|
| `<skill>` | `<repo>/.claude/skills/monitoring-claude-sessions` (the skill folder; its own git repository) |
| `$MCS` | `node <skill>/scripts/mcs.mjs` (the launcher; stable entry point, D6) |
| `$V` | `python <skill>/template/viewer.py` (legacy engine entry point, unchanged, read-only) |
| repo | the monitored repository root (`--repo`, default `.`) |
| tasks root | `<repo>/.claude/monitor/tasks` (override `--root`) |
| workspace | `<tasks root>/<slug>/`: one monitoring task = one instance (D2, D3) |
| slug / `taskId` | workspace folder name = `task.json.id`; `^[a-z0-9][a-z0-9-]{0,47}$`, not a Windows device name |
| `instanceId` | uuid v4 in `instance.json`; identity of the Node instance and of its DB (`meta`) |
| engine | which implementation serves a workspace: `node` (this runtime) or `legacy` (`$V`) |
| runtime process / server | the one Node process serving one instance (`packages/server/dist/main.js`) |
| control channel | the instance's local IPC endpoint (named pipe on Windows) used as instance lock, identity probe and graceful shutdown (ADR 0005) |
| L keys | the 22 legacy configuration keys of `config/defaults.json` (stored in `config.json`) |
| R keys | Node-only configuration keys (stored in `runtime.json`) |
| PyJson | the Python-compatible JSON reader/writer used for every workspace JSON file (ADR 0003) |

### 0.3 Invariants (each is proven by the tests named in the referenced section)

| Id | Invariant | Section |
|---|---|---|
| INV-01 | Node-only data never enters `config.json`, `task.json` or the legacy audit format | 1, 7 |
| INV-02 | A file the legacy engine reads is byte-identical to what the legacy engine would write for the same operation (modulo timestamps) | 1.9, 7 |
| INV-03 | One runtime process per instance at any time; a second one exits with code 12 before touching data | 4.4 |
| INV-04 | Nothing is killed unless its identity was verified (control channel identity, or command line containing this instance's marker, or legacy `viewer.py` marker) | 4.9 |
| INV-05 | Every write to a workspace stays inside that workspace (realpath containment, no symlinks/junctions below the tasks root) | 3, 8 |
| INV-06 | A config change is validated as a whole before any byte is written; invalid input writes nothing | 2.4, 6.4 |
| INV-07 | A regex is accepted only if its translation to JavaScript is exact for the supported construct set | 2.8 |
| INV-08 | No silent migration: every schema or data migration is an explicit command, backs up first and is audited | 2.7, 5.5 |
| INV-09 | Upgrades never rewrite `config.json`, `task.json` or existing audit bytes (audit is append-only) | 5.5, 7 |
| INV-10 | Success is printed only after the outcome was checked (health answered, process gone, file read back) | 4, 6 |
| INV-11 | Every child process is spawned through one helper (`platform/exec.ts`, design 06 3.6) with `shell:false`, `windowsHide:true`, argv array, timeout | 4.2 |
| INV-12 | The CLI, the server and the UI call the same engine functions; no business rule exists twice | 6.1 |

---

## 1. Workspace layout and file contracts

### 1.1 Tree and ownership
```
<repo>/.claude/monitor/tasks/
  <slug>/
    task.json            legacy identity                       writer: init (either engine)          readers: both
    config.json          L keys, schema_version 1               writer: configure/init (either)       readers: both
    README.md            human note                            writer: init (either)                 readers: humans
    instance.json        Node identity (ADR 0001)              writer: mcs init/adopt/upgrade/repair readers: node
    runtime.json         R keys, own schema_version            writer: mcs configure/config migrate  readers: node   (absent = no overrides)
    state.json           runtime-only (legacy fields + new)    writer: the running engine; CLI deletes stale copies
    run/control.token    shutdown capability, 64 hex chars     writer: node server at boot; deleted at graceful exit
    data/monitor.db (+ -wal, -shm)                             writer: node server only (D10)
    data/spool/          hook write-ahead log, segments hooks-<YYYYMMDD>T<HH>Z.ndjson  writer: hook handler (design 02 2.7; `SPOOL_SEGMENT_EXT = '.ndjson'` in `shared/src/protocol/hook-envelope.ts`, I-02)
    data/backups/<id>/   backups (5.6)                         writer: mcs backup/upgrade/restore
    logs/runtime.log (+ .1 .. .5)                              writer: node server (logger owned by 05; rotation 05 S-LOG-6: `LOG_ROTATE_BYTES` 10 MiB, `LOG_KEEP` 5)
    logs/boot.log (+ .1) stdout/stderr of the detached server   writer: OS redirection at spawn (4.7)
    audit/changes.md     append-only, legacy format            writer: both engines
    audit/decisions.md   append-only, legacy format            writer: both engines
  .init-<slug>-<pid>-<rand8>/   staging folder of an init in progress (4.12); ignored by both engines' task listing
```
Rules:
- The tasks root may itself be a link (user choice); nothing below it may be a symlink or junction (8.2, E5 shows junctions report
  `lstat().isSymbolicLink() === true` on Windows).
- "Runtime-mutable paths" (excluded from isolation snapshots, 3.5): `state.json`, `run/**`, `data/**`, `logs/**`, `*.tmp`.
- The legacy engine ignores every file it does not know (`tasks.py` reads only task/config/state/audit); its `audit` command flags any
  `*.jsonl` and any symlink inside the workspace (`tasks.py:205-211`). Therefore no Node writer creates a `*.jsonl` file inside a
  workspace: spool segments are `*.ndjson` (I-02; critic experiment X1: legacy `audit` exits 1 with a `.jsonl` segment and 0 with
  `.ndjson`), the suggested export path is `logs/export.ndjson` (6.6), and the Node `audit` reports any `*.jsonl` exactly like legacy.

### 1.2 Common read/write rules (module `@mcs/engine/workspace/fsio.ts`, a thin layer over `platform/fsx.ts`)
One file primitive set exists in the engine: `engine/src/platform/fsx.ts` (design 06 4.3, ADR 0058, file owned by 06 slice PP1):
`atomicWriteFile(file, data, { budgetMs = 3000 })` (async: temp `<file>.<pid>.<rand8>.tmp` opened `wx` in the same folder, write, fsync,
rename with retry on `EPERM | EBUSY | EACCES`, backoff `min(50 * 2^k, 250)` ms, `AtomicWriteError` on failure) and
`readSmallFile(file, maxBytes)`. This document adds only the workspace rules on top of it (I-28); it defines no second writer:
```ts
// @mcs/engine/workspace/fsio.ts (owned by slice S6)
export async function writeWorkspaceFile(path: string, data: string | Uint8Array, o?: { budgetMs?: number /* 3000 */ }): Promise<void>;
export async function writePyJsonFile(path: string, value: PyJsonValue, o?: { budgetMs?: number }): Promise<void>; // dumpPyJson(value, {indent: 2}) + LF -> writeWorkspaceFile
export async function readTextUniversal(path: string, maxBytes?: number /* 16 MiB */): Promise<string>;   // UTF-8 (BOM stripped), CRLF and lone CR -> LF
export async function readJsonFile(path: string): Promise<{ text: string; value: PyJsonValue }>;             // throws McsError CONFIG_UNREADABLE
export async function compareAndDelete(path: string, expected: Uint8Array): Promise<'deleted' | 'changed' | 'absent'>;
export function assertNotLink(path: string): void;          // lstat; throws WORKSPACE_SYMLINK when isSymbolicLink()
```
`writeWorkspaceFile(path, data)`:
1. `assertNotLink(path)` when the target exists; `assertNotLink(dirname(path))`.
2. `await fsx.atomicWriteFile(path, data, { budgetMs: o.budgetMs ?? 3000 })` (3000 ms is design 06's budget; it replaces the 2000 ms of
   revision 1; E5 measured a 352 ms recovery after a 1 s holder, design 06 E10 needed 52 retries for a 3 s reader).
3. `AtomicWriteError` -> `McsError('WORKSPACE_INVALID', 'cannot replace <file name>: <E_ATOMIC_WRITE_BUSY | E_ATOMIC_WRITE_IO>')`.

Rules:
- `writePyJsonFile` is the only writer of `task.json`, `config.json`, `runtime.json`, `instance.json`, `state.json` and backup manifests
  (ADR 0003). `JSON.stringify` is never used for a workspace JSON file (E6: 3,340 of 26,016 number lexemes differ from Python; INV-02);
  design 06 4.3 step 5 defers to this function.
- No in-place `fs.writeFile` on a file another process may read (a torn read is worse than a retry). The only non-atomic write is the
  audit append (7.1): one `appendFile` of one buffer.
- Readers (`readTextUniversal`, `readJsonFile`) call `fsx.readSmallFile` and retry `EPERM | EACCES | EBUSY` up to 10 times x 20 ms
  (E5: a Python reader racing a replace saw `PermissionError` on 5,702 of about 18,000 reads; legacy readers do not retry, which is why
  the server writes `state.json` rarely, 4.6). `readTextUniversal` emulates Python's universal newlines (`open(..., encoding='utf-8')`),
  which the legacy audit parser relies on. A file larger than `maxBytes` -> `WORKSPACE_INVALID` (`<name> is larger than <n> bytes`).
- All functions are async; no synchronous file API is used by the CLI or the server for workspace files. The launcher never touches
  workspaces (5.1).

`compareAndDelete(path, expected)`: read bytes; if absent -> `'absent'`; if bytes differ -> `'changed'`; else unlink with the same
retry rule; if unlink finds the file changed in between, the next caller sees `'changed'`. Used for every stale-file removal.

### 1.3 `task.json` (legacy, unchanged; `TASK_SCHEMA = 1`)
Keys and order (PyJson writer, indent 2): `schema_version` (1), `id` (= slug), `name` (string, `name or slug`), `description`
(string, default `""`), `created` (UTC `YYYY-MM-DDTHH:MM:SSZ`), `repo` (path of the repo relative to the workspace folder, `/`
separators), `links` (`[]`). Node behaviour:
- `repo` = `path.relative(workspaceDir, repoAbs).split(path.sep).join('/')`; when the repo is on another drive (Windows) the legacy
  code raises `ValueError` (latent defect F.6); Node stores the absolute repo path with `/` separators instead (documented fix).
- Never rewritten after creation by any Node command.
- Validation when read: object; `id === slug` else `IDENTITY_MISMATCH` ("task.json id 'x' does not match folder 'y'", legacy text);
  `schema_version === 1` checked by `audit` only (legacy parity).

### 1.4 `config.json` (legacy, shared, `schema_version` 1)
Content: only L keys plus keys starting with `_` (comments, ignored). Schema = legacy `SCHEMA` (`config.py:58-81`), ported as
`LegacyConfigFileSchema` (2.4). Node never adds an R key here (INV-01): a `configure --set` of an R key routes to `runtime.json` (6.4).

### 1.5 `instance.json` (Node-owned; ADR 0001)
```ts
// @mcs/shared/files/instance.ts
export const InstanceFileSchema = z.strictObject({
  schema_version: z.literal(1),
  instanceId: z.string().regex(UUID_V4_RE),                 // crypto.randomUUID(); never changes except `instances repair`
  slug: z.string().regex(SLUG_RE),                          // must equal the folder name (copy detection, 3.4)
  createdAt: IsoSecondsZ,                                   // 'YYYY-MM-DDTHH:MM:SSZ'
  createdBy: z.string().regex(/^mcs \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  runtimeVersion: Semver,                                   // runtime that last initialized/upgraded this instance's data
  dbSchemaVersion: z.number().int().min(0),                 // mirror of the DB value after the last upgrade; 0 = no DB yet; the DB is authoritative
  engine: z.enum(['node', 'legacy']),                       // which engine `mcs start` launches (6.5)
  hooks: z.strictObject({ enabled: z.boolean() }),          // whether the hook handler routes to this instance (ingestion design)
  upgradedAt: IsoSecondsZ.nullable(),
});
export type InstanceFile = z.infer<typeof InstanceFileSchema>;
```
Key order on disk = the order above. Defaults at creation: `engine: 'node'`, `hooks.enabled: false`, `dbSchemaVersion: 0`,
`upgradedAt: null`. Writers: `init` (create/adopt), `upgrade`/`db migrate` (`runtimeVersion`, `dbSchemaVersion`, `upgradedAt`),
`instances set-engine`, `hooks enable|disable`, `instances repair`. Every write is audited (7.2).

### 1.6 `runtime.json` (Node-owned R keys; optional file)
Absent file = no instance overrides. Present file must have `schema_version` (missing -> refuse, same wording as the legacy gate,
2.6). Unknown top-level keys are rejected (strict). Sections are composed from per-owner schema modules in
`@mcs/shared/config/runtime/` and merged per sub-key (2.2). Every section schema must parse `{}` to a complete object, which in
Zod 4.6.5 requires `.prefault({})` on the section, not `.default({})` (E12: `.default({})` returns `{}` without inner defaults).

Each section module exports a key table and the two schemas generated from it, so that the merged schema and the overrides schema can
never disagree (E14):
```ts
// @mcs/shared/config/runtime/section.ts
export interface KeySpec<T extends z.ZodType = z.ZodType> { readonly schema: T; readonly default: z.output<T> }
export type SectionKeys = Readonly<Record<string, KeySpec>>;
export function sectionSchema(keys: SectionKeys): z.ZodType;           // z.strictObject({k: spec.schema.default(spec.default)}).prefault({})
export function sectionOverridesSchema(keys: SectionKeys): z.ZodType;  // z.strictObject({k: spec.schema.optional()}).optional(); no defaults injected
// each module, e.g. @mcs/shared/config/runtime/spool.ts:
export const SpoolSectionKeys = { pollMs: { schema: z.number().int().min(50).max(60_000), default: 500 }, /* ... */ } satisfies SectionKeys;
export const SpoolSectionSchema = sectionSchema(SpoolSectionKeys);
```

Sections owned by this document (complete):

| Key | Type | Default | Validation | Used by |
|---|---|---|---|---|
| `server.port` | int or null | `null` (= use `config.json` `port`) | 1..65535 | port selection 4.11 |
| `server.portScan` | int | 19 | 0..99 | ports tried = base..base+portScan (legacy +19) |
| `server.requestTimeoutMs` | int | 30000 | 1000..600000 | HTTP server `requestTimeout` (API design applies it) |
| `server.shutdownGraceMs` | int | 5000 | 100..60000 | graceful shutdown deadline 4.5 |
| `process.startTimeoutMs` | int | 20000 | 1000..300000 | `start` health wait 4.7 (legacy waited 12 s) |
| `process.stopTimeoutMs` | int | 10000 | 1000..300000 | `stop` wait for process exit 4.9 |
| `process.stateWatchdogMs` | int | 15000 | 1000..600000 | server re-checks `state.json` 4.6 |
| `logLevel` | enum | `info` | `error warn info debug` | logger (05, levels of its `logger.ts`); env `MCS_LOG_LEVEL`, CLI `--log-level`. Rotation is not configuration: 05 S-LOG-6 constants `LOG_ROTATE_BYTES` = 10 MiB, `LOG_KEEP` = 5 (I-25) |
| `backup.keep` | int | 5 | 1..100 | automatic pruning of `data/backups` (5.5) |

The `server` section has no `devOrigins` and no `bindHost` key: the Origin allow-list stays exactly the two loopback values (I-31, 05 5.4).

Sections whose schema module this document's slice S1 writes from the owning design's table (I-01). The owning design keeps the
semantics and the defaults; a change of a default there is a change of this table in the same commit (the contract test below fails
otherwise). Ranges are validation bounds chosen here; the owning design may narrow them.

| Key | Type | Default | Validation | Semantics owned by |
|---|---|---|---|---|
| `lifecycle.activeSeconds` | number or null | `null` -> derived from `active_seconds` | > 0, <= 86400 | 02 7.8 |
| `lifecycle.pendingToolGraceSeconds` | number or null | `null` -> derived from `pending_tool_grace_seconds` | > 0, <= 86400 | 02 7.8 |
| `lifecycle.subagentActiveSeconds` | int | 60 | 1..86400 | 02 7.8 |
| `lifecycle.staleAfterSeconds` | int | 1800 | 60..604800 | 02 7.8 |
| `lifecycle.abandonedAfterSeconds` | int | 86400 | 600..2592000 | 02 7.8 |
| `lifecycle.processGoneGraceSeconds` | int | 30 | 0..3600 | 02 7.8 |
| `lifecycle.crossSourceToleranceMs` | int | 2000 | 0..60000 | 02 7.8 |
| `lifecycle.reopenToleranceMs` | int | 2000 | 0..60000 | 02 7.8 |
| `lifecycle.sweepIntervalMs` | int | 5000 | 500..60000 | 02 7.8 |
| `lifecycle.pidCheckIntervalMs` | int | 10000 | 1000..600000 | 02 7.8 |
| `lifecycle.registryPollMs` | int | 5000 | 1000..600000 | 02 7.8 |
| `lifecycle.jobsPollMs` | int | 15000 | 1000..600000 | 02 7.8 |
| `hooks.spoolWhileStoppedHours` | int | 72 | 1..720 | 02 2.6 |
| `ingest.queueMaxItems` | int | 5000 | 100..100000 | 02 4.7 |
| `ingest.queueMaxBytes` | int | 33554432 (32 MiB) | 1 MiB..512 MiB | 02 4.7 |
| `spool.pollMs` | int | 500 | 50..60000 | 02 2.7 |
| `spool.sealGraceMs` | int | 120000 | 5000..3600000 | 02 2.7 |
| `spool.retainHours` | int | 24 | 1..720 | 02 2.7 |
| `import.lookbackHours` | number or null | `null` -> derived from `window_hours` | > 0, <= 8760 | 02 5.1.2 |
| `import.tailWindowBytes` | int or null | `null` -> derived from `limits.event_window_mb` x 1 MiB | 65536..1 GiB | 02 5.5 |
| `import.backfillMaxBytes` | int or null | `null` -> derived from `limits.usage_max_mb` x 1 MiB | 65536..64 GiB | 02 5.5 |
| `import.headMaxBytes` | int | 16777216 (16 MiB) | 64 KiB..256 MiB | 02 5.2, 5.5 |
| `import.maxLineBytes` | int | 67108864 (64 MiB) | 1 MiB..256 MiB | 02 4.8 |
| `import.untrackAfterHours` | int | 48 | 1..8760 | 02 5.1.2 |
| `import.discoveryIntervalMs` | int | 5000 | 500..600000 | 02 5.1.2, 5.4 |
| `import.scanIntervalMs` | int | 1000 | 100..60000 | 02 5.4 |
| `import.sliceMs` | int | 20 | 5..200 | 02 5.4 |
| `import.backfillShare` | number | 0.25 | 0.05..1 | 02 5.4 |
| `health.importLagWarnMs` | int | 30000 | 1000..3600000 | 02 8.2 |
| `health.backlogWarnMs` | int | 10000 | 1000..3600000 | 02 8.2 |
| `analytics.usageTrend` | boolean | `false` | boolean | 03 6.2 (`features.usageTrend`), 04 4.4.6 |

Sections owned elsewhere (this document requires only: the `SectionKeys` pattern above, a default for every key, no secrets, no key
starting with `_`, a top-level name that is not an L key; each exported as `<Name>SectionKeys` / `<Name>SectionSchema` from
`@mcs/shared/config/runtime/<name>.ts`, file owned by the named design's slice):

| Section | Owner | Known keys (from that design) |
|---|---|---|
| `board` | `02-ingestion-lifecycle.md` 7.11 | `items` (declared work items; `04-ui.md` S-8 `tasks[]` is renamed there) |
| `panelOptions` | `06-panels-parity-platform.md` | `attemptsWindowHours` (default 24), `machineProcessIntervalMs` (06 asked for `attempts.windowHours` and `panels.machine.processIntervalMs`, which collide with the L keys `attempts` and `panels`; Open item 6) |
| `retention` | `03-data-api-realtime.md` 3.8 | `eventsDays`, `sessionsDays`, `changesMaxAgeHours`, `changesMaxRows`, `ingestErrorsMaxRows`, `instanceReconciliationsDays`, `resolvedAlertsDays` |
| `alerts`, `pricing` | `03-data-api-realtime.md` 10.1, 8 | `enabled`, `sweepSeconds`, `rules`; `models` (user-configured prices, D15: none shipped) |

Derived defaults: an R key whose built-in default is "the value of an L key" declares it in `R_DERIVED_DEFAULTS`; its Zod default is
`null`, and `resolveConfig` step 6 replaces a `null` that no layer overrode:
```ts
export interface DerivedDefault { readonly from: string /* dotted L path */; readonly map: 'identity' | 'mib-to-bytes' }
export const R_DERIVED_DEFAULTS: Readonly<Record<string, DerivedDefault>> = {
  'lifecycle.activeSeconds': { from: 'active_seconds', map: 'identity' },
  'lifecycle.pendingToolGraceSeconds': { from: 'pending_tool_grace_seconds', map: 'identity' },
  'import.lookbackHours': { from: 'window_hours', map: 'identity' },
  'import.tailWindowBytes': { from: 'limits.event_window_mb', map: 'mib-to-bytes' },     // Math.floor(v * 1048576)
  'import.backfillMaxBytes': { from: 'limits.usage_max_mb', map: 'mib-to-bytes' },
};
```
Derivation algorithm (per entry, in the order above): (1) read the merged L value at `from` (always present: the skill defaults define
every one; legacy defaults `window_hours` 8, `limits.event_window_mb` 8, `limits.usage_max_mb` 512 give 8 h, 8 MiB and 512 MiB, equal to
the 02 defaults); (2) apply `map`; (3) validate the result with the key's schema without its `null` branch; failure ->
`CONFIG_INVALID` `runtime: <R key> derived from <from> (<value>): <zod message>`; (4) provenance of the R key = provenance of `from`.

Composition (`@mcs/shared/config/runtime/index.ts`):
```ts
export const RuntimeFileSchema = z.strictObject({
  schema_version: z.literal(1),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  server: ServerSectionSchema, process: ProcessSectionSchema, backup: BackupSectionSchema,
  lifecycle: LifecycleSectionSchema, hooks: HooksSectionSchema, ingest: IngestSectionSchema, import: ImportSectionSchema,
  spool: SpoolSectionSchema, health: HealthSectionSchema, analytics: AnalyticsSectionSchema,
  board: BoardSectionSchema, panelOptions: PanelOptionsSectionSchema, retention: RetentionSectionSchema,
  alerts: AlertsSectionSchema, pricing: PricingSectionSchema,
});                                                     // every *SectionSchema is sectionSchema(keys): strictObject(...).prefault({})
export const RuntimeOverridesSchema = z.strictObject({
  schema_version: z.literal(1), logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  server: sectionOverridesSchema(ServerSectionKeys), /* ... one entry per section, same order ... */
});
export type RuntimeConfig = Omit<z.output<typeof RuntimeFileSchema>, 'schema_version'>;
export const R_TOP_KEYS = ['logLevel', 'server', 'process', 'backup', 'lifecycle', 'hooks', 'ingest', 'import', 'spool', 'health',
  'analytics', 'board', 'panelOptions', 'retention', 'alerts', 'pricing'] as const;
export const R_MERGED: ReadonlySet<string> = new Set(R_TOP_KEYS.filter((k) => k !== 'logLevel'));   // every object section merges per sub-key
export const R_KEY_CATALOGUE: readonly { key: string; default: unknown; sample: unknown; owner: '01' | '02' | '03' | '06'; ref: string }[];
```
The file on disk holds only overrides (partial sections); `RuntimeOverridesSchema` validates the file itself (unknown keys and wrong
types are reported against the file, `unrecognized_keys`), and `RuntimeFileSchema` validates the merged result (2.3 step 6). E14
(Zod 4.6.5): all 16 new keys of `spool`, `import`, `health`, `analytics` parse through the generated overrides schema, an unknown key or
section is rejected, the overrides output contains no injected defaults, `RuntimeFileSchema.parse({schema_version: 1})` returns every
default, and the generated JSON Schema has `additionalProperties: false` per section.

L and R top-level names are disjoint (checked by a unit test), so `configure` routes a key by its first path segment (6.4).
Foundations D3 lists "port, logLevel" for `runtime.json`: `logLevel` keeps its name; the runtime port is `server.port` because `port` is an
L key (L and R names must stay disjoint). The server-process timeouts live in `process` because `lifecycle` holds the session-state
thresholds of design 02.

Tests that prove 1.6 (`packages/shared/src/config/runtime/*.test.ts`, project `unit`, slice S1):
- `runtime-sections.contract.test.ts`: (1) `RuntimeFileSchema.parse({schema_version: 1})` plus the derived defaults filled from the
  shipped `config/defaults.json` equals the `default` column of `R_KEY_CATALOGUE`; (2) every catalogue key parses through
  `RuntimeOverridesSchema` with its `sample` (every section, so every 02 and 03 key: the 12 `lifecycle`, 1 `hooks`, 2 `ingest`,
  10 `import`, 3 `spool`, 2 `health`, 1 `analytics` keys of the table above plus the keys of `board`, `retention`, `alerts`, `pricing`
  and `panelOptions` registered by their owners); (3) the leaf key set of the parsed default equals the catalogue key set (no undocumented
  key); (4) one misspelled key per section and one unknown section are rejected with `unrecognized_keys`; (5) `R_TOP_KEYS` is disjoint
  from the 22 L keys; (6) the generated `runtime.v1.schema.json` has `additionalProperties: false` on every section.
- `derived-defaults.test.ts`: `event_window_mb` 0.5 -> `tailWindowBytes` 524288; `event_window_mb` 0.01 -> `CONFIG_INVALID` naming both
  keys; an explicit `import.tailWindowBytes` in `runtime.json` wins over the derivation and has provenance `runtime`.

### 1.7 `state.json` (runtime-only; written by whichever engine runs)
Legacy writes exactly `{pid, url, port, started, version, task, config}` (types int, str, int, float, str, str|null, str|null;
verified on the live file, research C.10). The Node server writes those seven keys first, in the same order, then:

| Key | Type | Value |
|---|---|---|
| `pid` | int | `process.pid` |
| `url` | string | `http://127.0.0.1:<port>` (no trailing slash; legacy format) |
| `port` | int | bound port |
| `started` | number | `Date.now() / 1000` (epoch seconds with fraction, like Python `time.time()`) |
| `version` | string | `RUNTIME_VERSION` (legacy readers treat it as informational) |
| `task` | string | slug |
| `config` | null | always null (Node has no flat-config mode) |
| `schema_version` | 1 | marks the Node format |
| `engine` | `"node"` | absence of this key = legacy format |
| `instanceId` | uuid | must equal `instance.json` |
| `runtimeVersion` | semver | same as `version` |
| `codeStamp` | 10 hex | from `runtime/.mcs-build.json` at boot (05) |
| `startedAt` | ISO ms Z | same instant as `started` |
| `nodeVersion` | string | `process.version` |
| `control` | string | control channel address (4.3), informational |
```ts
export const StateFileSchema = z.object({   // non-strict: tolerate unknown keys from future versions and legacy files
  pid: z.number().int().positive(), url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/), port: z.number().int().min(1).max(65535),
  started: z.number().nonnegative(), version: z.string(), task: z.string().nullable(), config: z.string().nullable(),
  schema_version: z.literal(1).optional(), engine: z.literal('node').optional(), instanceId: z.string().regex(UUID_V4_RE).optional(),
  runtimeVersion: Semver.optional(), codeStamp: z.string().regex(/^[0-9a-f]{10}$/).optional(), startedAt: z.string().optional(),
  nodeVersion: z.string().optional(), control: z.string().optional(),
}).superRefine((s, ctx) => { if (s.engine === 'node' && (!s.instanceId || !s.codeStamp || !s.runtimeVersion)) ctx.addIssue({ code: 'custom', message: 'node state needs instanceId, codeStamp, runtimeVersion' }); });
export const stateEngine = (s: StateFile): 'node' | 'legacy' => (s.engine === 'node' ? 'node' : 'legacy');
```
A `state.json` that fails to parse is treated as stale (legacy `read_state_file` returns None on any error) and is never trusted.

### 1.8 Other files
- `run/control.token`: 32 random bytes as 64 lowercase hex chars plus `\n`; created by the server before it reports `phase:"ready"`;
  replaced at every boot; deleted at graceful exit. Never printed, never logged, never copied into backups or diagnostics.
- `logs/boot.log`: the detached server's stdout and stderr (4.7). At each start the CLI renames an existing `boot.log` to `boot.log.1`
  (replacing the old `.1`). Contains only our own messages and stack traces (no payloads: logger allow-list, 05).
- `README.md` (Node `init` text; legacy text differs, both are informational):
  ```
  # Monitoring task: <name>

  <description>

  - `task.json` identity, `config.json` overrides of the shared defaults (shared with the legacy engine), `runtime.json` Node runtime overrides, `instance.json` runtime identity, `audit/` change and decision log, `data/` database and hook spool, `logs/` runtime logs.
  - Inspect: `node <skill>/scripts/mcs.mjs inspect --task <slug>` (legacy engine: `python <skill>/template/viewer.py inspect --task <slug>`)
  - Never copy transcripts here; they are read in place.
  ```
  `<skill>` is written literally (legacy does the same).
- `audit/*.md`: section 7.

### 1.9 PyJson: Python-compatible JSON (ADR 0003)
Why: the legacy engine reads and rewrites `config.json` with `json.load` / `json.dump(indent=2, ensure_ascii=False)` + `\n`, and
writes audit summaries with `json.dumps(value, ensure_ascii=False)` (`_short`). JavaScript differs: integral floats lose `.0`
(Python `24.0` vs JS `24`), exponent thresholds differ (`1e16` vs `10000000000000000`), integer-like object keys are reordered, big
integers lose precision, and `JSON.stringify` has no spaces after `,`/`:` in compact form. E6: on 26,016 golden number lexemes plain
`JSON.stringify(JSON.parse(x))` differed from Python on 3,340; the emulation below differed on 0.

Model and API (`@mcs/engine/pyjson/`):
```ts
export type PyJsonValue =
  | { k: 'null' } | { k: 'bool'; v: boolean } | { k: 'str'; v: string }
  | { k: 'int'; v: bigint } | { k: 'float'; v: number }                 // lexeme without . e E -> int, else float (Python json.loads rule)
  | { k: 'arr'; v: PyJsonValue[] } | { k: 'obj'; v: [string, PyJsonValue][] };   // ordered entries; duplicate key: last value, first position (Python dict)
export function parsePyJson(text: string): PyJsonValue;              // throws PyJsonSyntaxError {message, line, col}
export function dumpPyJson(v: PyJsonValue, o: { indent: 2 } | { compact: true }): string;
export function toPlain(v: PyJsonValue): unknown;                     // int -> number (throws when beyond 2**53-1 in a numeric config key), float -> number
export function fromPlain(x: unknown): PyJsonValue;                   // number: Number.isInteger and no fraction source -> int; used for CLI --set values via parsePyJson of the raw text instead
export function pyEquals(a: PyJsonValue, b: PyJsonValue): boolean;    // Python ==: int/float numeric equality, bool equals 1/0, ordered lists, dicts by key set
export function pyShort(v: PyJsonValue): string;                      // legacy _short: compact dump, > 120 code points -> first 117 + '...'
export function pyRepr(s: string): string;                            // Python repr of a str for messages ('abc', "it's")
```
Parser rules (Python `json.loads` compatible): standard JSON plus the tokens `NaN`, `Infinity`, `-Infinity` (Python accepts them);
such floats parse but Node validation refuses non-finite numbers everywhere (stricter than legacy; documented). Leading BOM is an
error in Python (`json.load` on text opened as utf-8 keeps U+FEFF and fails); Node: same error. Lone surrogate escapes are rejected
(Python would fail to encode them when writing).

Writer rules (`indent: 2`): objects `{` newline, entries `<indent>"key": value` joined by `,\n`, closing `}` at parent indent; empty
object `{}`, empty array `[]`; arrays like objects; strings: escape `"` `\` and U+0000-U+001F (`\b \f \n \r \t` short forms, others
`\u00XX` lowercase hex), everything else raw UTF-8 (`ensure_ascii=False`); `int`: `v.toString()` (BigInt, so `-0` -> `0`); `float`:
`pyFloatRepr`; file = dump + `\n`; LF only. Compact form (`pyShort`, CLI messages): separators `', '` and `': '`, no newlines, and
`ensure_ascii=False`. The validation messages of the legacy `validate()` use `json.dumps(v)` with `ensure_ascii=True` and `[:60]`:
`dumpPyJson(v, {compact: true, asciiOnly: true}).slice(0, 60)` (non-ASCII as `\uXXXX`, astral as surrogate pairs, like Python).

`pyFloatRepr(x)` (verified bit-for-bit, E6):
1. `x === 0` -> `Object.is(x, -0) ? '-0.0' : '0.0'`.
2. `[mant, e] = x.toExponential().split('e')` (shortest round-trip digits); `digits = mant` without sign and dot; `exp = Number(e)`.
3. If `exp < -4 || exp >= 16`: `d0[.rest]e` + sign (`+`/`-`) + two-digit-minimum exponent (`1e-05`, `1.5e+16`).
4. Else fixed notation: `exp >= 0` -> integer part padded with zeros, then `.` + fraction or `.0`; `exp < 0` -> `0.` + `-exp-1` zeros +
   digits.

Golden tests (`tests/legacy-parity/pyjson/`): `gen_pyjson_golden.py` (dev tool, run once, output committed) emits number lexemes
(fixed list + 20,000 random doubles from random bit patterns + 3,000 uniform floats and big integers), string escape cases (all
U+0000-U+00FF, U+2028, astral, quotes), key-order cases (`{"b":1,"2":2,"a":3}`), duplicate keys, and `_short` cases; Node test
`pyjson.golden.test.ts` asserts `dumpPyJson(parsePyJson(lexeme))` equals Python's output for every case, and a property test
asserts `parse(dump(v))` round-trips.

---

## 2. Configuration

### 2.1 Layers and precedence (D4)

| Rank | Layer | Source | Contains | Provenance tag |
|---|---|---|---|---|
| 1 | built-in | Zod defaults in `@mcs/shared/config/runtime/*` | R keys only | `builtin` |
| 2 | skill | `<skill>/config/defaults.json` (L, required, read-only for this migration) and `<skill>/runtime/defaults.json` (R overrides for this skill install; ships as `{"schema_version": 1}`) | L and R | `skill` |
| 3a | instance | `<ws>/config.json` | L keys | `config` |
| 3b | instance | `<ws>/runtime.json` | R keys | `runtime` |
| 3.5 | environment | `MCS_LOG_LEVEL` only (2.10) | `logLevel` | `env` |
| 4 | CLI | `--port N` (effective port), `--log-level L` (`logLevel`) on `start`, `serve`, `restart` | | `cli` |

The legacy key `port` and the R key `server.port` meet in one derived value:
`effectivePort = cli.port ?? runtime.server.port ?? monitor.port` where `cli.port` = `--port` when non-zero (legacy: `--port 0` means
"not given", `cli.py:213`). Its provenance is the source of the value used.

### 2.2 Merge algorithm (`@mcs/engine/config/merge.ts`)
```ts
export const L_MERGED: ReadonlySet<string> = new Set(['panels', 'ui', 'poll', 'limits']);   // legacy MERGED_DICTS
export function mergeLayer(base: PlainObject, over: PlainObject, merged: ReadonlySet<string>): PlainObject;
```
1. `out = structuredClone(base)` (inputs never mutated).
2. For each `[key, value]` of `over` in order: skip keys starting with `_`; if `merged.has(key)` and both `value` and `out[key]` are
   plain objects -> `out[key] = { ...out[key], ...structuredClone(value) }` (one level, per sub-key); else `out[key] = structuredClone(value)`
   (lists, scalars and `null` replace).
3. L chain: `mergeLayer(skillDefaults, configJson, L_MERGED)`; R chain: `mergeLayer(mergeLayer(builtin, skillRuntimeDefaults, R_MERGED), runtimeJson, R_MERGED)`
   then env, then CLI.
The R rule extends the legacy "dict sections merge per sub-key" rule to the runtime sections (`R_MERGED`), see CHALLENGE C-3.

### 2.3 Resolution (`resolveConfig`)
```ts
export interface ResolveInput { workspace: WorkspaceRef | null; env: Readonly<Record<string, string | undefined>>; cli: { port?: number; logLevel?: LogLevel } }
export interface ResolvedConfig {
  monitor: LegacyConfig;          // merged L keys; `repo` absolute; `_source_path` NOT included (legacy artefact)
  runtime: RuntimeConfig;         // merged and defaulted R keys
  effectivePort: number;
  provenance: Record<string, ConfigSource>;
  patterns: CompiledPatterns;     // 2.8
  files: ConfigFileStatus[];      // { name: 'defaults.json'|'runtime/defaults.json'|'config.json'|'runtime.json'; path; schemaVersion: number|null; present: boolean; ok: boolean }
  source: 'task' | 'defaults';
}
export function resolveConfig(i: ResolveInput): Promise<ResolvedConfig>;   // rejects with McsError CONFIG_* / REGEX_UNSUPPORTED (file reads are async, 1.2)
```
Steps:
1. Read `<skill>/config/defaults.json` (PyJson); drop `_` keys; unreadable -> `CONFIG_UNREADABLE` "cannot read shared defaults <path>: <reason>"
   (legacy wording).
2. If `workspace`: read `task.json` (must be an object) and `config.json`; run the schema gate (2.6) on `config.json` with
   `where = <path>`; validate strict (2.4); problems -> `CONFIG_INVALID` "invalid task config <path>: p1; p2".
3. Merge L (2.2). Repo: `repo = merged.repo`; if the workspace's `config.json` has no `repo` key and `task.json.repo` is a non-empty
   string, use it; relative repos resolve against the workspace folder; result absolute (`path.resolve`). Without a workspace,
   base = cwd (legacy).
4. Read `<skill>/runtime/defaults.json` and `<ws>/runtime.json` (if present): schema gate, `RuntimeOverridesSchema` strict
   validation (messages `runtime.json: <dotted path>: <zod message>`).
5. Merge R (2.2), apply env (2.10), apply CLI.
6. Parse the merged R object with `RuntimeFileSchema` (fills defaults, final type check); then fill `R_DERIVED_DEFAULTS` (1.6) that are
   still `null` from the merged L values with the 1.6 derivation algorithm (map, validate, provenance).
7. Compile patterns (2.8): every `session_rules[i].match` with context `session_rule`, `attempts.start/end` with context `attempts`;
   any failure -> `REGEX_UNSUPPORTED` listing every failing pattern as `session_rules[1]: <message>` / `attempts.end: <message>`.
8. Compute provenance (2.5) and `effectivePort`.
Pure function apart from file reads; no network, no process spawn. Called by `check`, `inspect`, `configure` (after a change, in memory),
`start` (before spawning), the server boot (4.4), and `doctor`.

### 2.4 Validation
L keys: `LegacyConfigFileSchema` reproduces `config.py:58-81` exactly, implemented as a table of predicates (not Zod, so the
messages are the legacy strings):

| Key | Predicate (bool excluded from numbers, as `_is_num`/`_is_int`) | Expected text |
|---|---|---|
| `schema_version` | int | `integer` |
| `title` | string with non-whitespace | `non-empty string` |
| `port` | int 1..65535 | `integer 1-65535` |
| `repo` | string | `string path` |
| `transcripts_dir` | string or null | `'auto' or a path` |
| `window_hours`, `active_seconds`, `pending_tool_grace_seconds` | finite number > 0 | `positive number` |
| `include_unmatched`, `docker` | boolean | `boolean` |
| `session_rules` | list of objects with string `match` | `list of {match, label, scope?}` |
| `session_ids`, `live_log_globs`, `watched_processes` | list of strings | `list of session id strings` / `list of strings` |
| `panels` | object of booleans | `object of booleans` |
| `chain_log`, `ledger`, `stop_file` | string or null | `string or null` |
| `attempts` | null or object with string `start` and `end` | `null or {start, end, ...}` |
| `ui` | object; `theme` in auto/light/dark (default auto); `density` in comfortable/compact; other values boolean | `object: theme auto\|light\|dark, density comfortable\|compact, booleans` |
| `poll`, `limits` | object of finite numbers | `object of numbers (milliseconds)` / `object of numbers` |

Messages (golden, from `config.py`): `unknown key <pyRepr(k)>` (strict mode only); `<key>: expected <text>, got <json[:60]>`;
`session_rules: invalid regex <pyRepr(match)> (<translator message>)`; `attempts.<start|end>: invalid regex (<translator message>)`;
`config must be a JSON object`. Problems are reported in key order, then regex problems (legacy order). Python's own `re.error`
texts cannot be reproduced for every case; the translator uses Python's wording for the errors it shares (2.8) and parity tests
compare messages up to the opening parenthesis.
Node-only additions (stricter, documented): non-finite numbers are rejected (`<key>: expected finite number`); a rule `label` that is
present must be a string (`session_rules[i].label: expected string`); integers beyond 2^53-1 in numeric keys are rejected.

R keys: Zod (`RuntimeOverridesSchema` on the file, `RuntimeFileSchema` on the merge); messages `runtime.json: <path>: <message>`.
Cross-file rules: none in v1 (`server.port` and `port` are independent; the derived port is checked at bind).

### 2.5 Provenance
`provenance` maps a dotted key to a `ConfigSource` (`builtin | skill | config | runtime | env | cli`):
1. For each L default key: keys in `L_MERGED` produce one entry per default sub-key (`panels.git`); value `config` if the sub-key is
   present in `config.json`'s object, else `skill`. Other keys: `config` if present in `config.json`, else `skill`.
2. L keys present in `config.json` but not in defaults: `config` (legacy behaviour).
3. For each R leaf (`server.port`, ..., `tasks`): the highest layer that set it (`cli` > `env` > `runtime` > `skill` > `builtin`).
4. `port` (the derived effective port) gets an extra entry `effectivePort` with the source of the value used.
`inspect` output (6.4) keeps the legacy fields `provenance`, `overridden_keys` (source not in `builtin|skill`) and `inherited_keys`;
values change from `default|task` to the six tags above (a deliberate, documented change; `04-ui.md` `ConfigInspection` uses the same
tags).

### 2.6 Schema versions and gates

| File | Supported | Missing | Higher/unknown |
|---|---|---|---|
| `config.json` | `[1]` | refuse: `<path> has no schema_version; refusing to guess (add "schema_version": 1 after checking the keys against docs/configuration.md)` | refuse: `<path> uses schema_version <v> but this skill supports [1]; update the skill or migrate the file explicitly` |
| `runtime.json` | `[1]` | same texts with `runtime.json` | same; `migrate` hint names `mcs config migrate` |
| `instance.json` | `[1]` | refuse `WORKSPACE_INVALID` | refuse `CONFIG_SCHEMA_UNSUPPORTED` |
| `task.json` | `[1]` | checked by `audit` only (legacy) | `audit` problem `task.json schema_version <v> unsupported` |
| `state.json` | legacy (no key) or `1` | legacy format | treated as stale (never trusted) |
| DB | data design `SUPPORTED_DB_SCHEMA` range | new DB | refuse `DB_NEWER_THAN_RUNTIME` (5.8) |

`configure` refuses `--set/--unset schema_version` for both files (`schema_version cannot be changed with configure` / `... removed`,
legacy wording).

### 2.7 `config migrate` (explicit migrations)
Registry (`@mcs/engine/config/migrations.ts`):
```ts
export interface FileMigration { file: 'config.json' | 'runtime.json' | 'instance.json'; from: number; to: number; describe: string; apply(doc: PyJsonValue): PyJsonValue }
export const FILE_MIGRATIONS: readonly FileMigration[] = [];   // empty in v1; adding version 2 of a file = add a step + tests + docs
```
`config.json` migrations must keep the file readable by the legacy engine or bump its `schema_version` (then the legacy engine refuses
it safely, which is the designed behaviour, research F.3).
`mcs config migrate --task S [--dry-run] [--yes]`:
1. Resolve workspace; take the task mutex (4.2).
2. For each file present: read `schema_version`; plan the chain of steps up to the newest supported version; no step needed -> skip.
3. Nothing planned -> print `nothing to migrate: config.json v1, runtime.json v1, instance.json v1 are current` exit 0.
4. `--dry-run` (default when `--yes` is absent): print each step `file: vA -> vB (<describe>)` and the backup that would be made; exit 0.
5. `--yes`: backup (5.5, reason `config-migrate`, `dbCopy: 'none'`, files only); apply steps in memory; validate the results (2.4); write each
   file atomically; read back and validate; audit `config-migrate` (7.2). Any failure before writing -> nothing written; failure
   during writing -> restore written files from the backup and report `CONFIG_INVALID` with the backup id.

`mcs config migrate --from-legacy FILE --name NAME [--slug S] [--description D] [--yes]`: imports a legacy flat config (any file
accepted by `$V --config FILE`) into a new or existing workspace:
1. Read FILE (PyJson); if it has `schema_version` it must be 1.
2. Keep L keys only; unknown keys are listed and dropped (the legacy flat mode ignored them); `repo` relative to FILE's folder is
   rewritten to be relative to the new workspace (same target folder); validate strict + regex translation.
3. Dry run prints the resulting `config.json`; `--yes` runs `init` (4.12) with these keys (existing workspace: refuse unless its
   `config.json` already equals the result, `WORKSPACE_EXISTS_CONFIG_DIFFERS`), audit `config-import`. FILE is never modified.

### 2.8 Python-regex translator (ADR 0002)
Purpose (D5): `config.json` stores Python-syntax regexes (shared with the legacy engine); Node translates them at load to JavaScript
`RegExp` and accepts a pattern only when the translation is exact for the supported constructs (INV-07). Module
`@mcs/shared/pyregex/` (isomorphic, no `node:*`), so the server, the CLI and the UI's config view share it.

API:
```ts
export type PyRegexContext = 'session_rule' | 'attempts';
export type PyRegexErrorCode = 'SYNTAX' | 'UNSUPPORTED_CONSTRUCT' | 'UNSUPPORTED_FLAG' | 'INEXACT_SEMANTICS' | 'JS_COMPILE';
export interface PyRegexError { code: PyRegexErrorCode; message: string; position: number | null }   // position in code points
export interface TranslatedPattern { source: string; jsSource: string; jsFlags: string; groupCount: number; groupNames: readonly string[]; mode: 'search' | 'match' }
export function translatePyRegex(source: string, ctx: PyRegexContext): { ok: true; value: TranslatedPattern } | { ok: false; error: PyRegexError };
export interface PyMatch { start: number; end: number; group(n: number): string | null; groups(): (string | null)[]; groupdict(): Record<string, string | null> }  // offsets in code points
export interface CompiledPyRegex { readonly t: TranslatedPattern; readonly regex: RegExp /* flags v (+i, +y for attempts; set lastIndex = 0 before exec) */; exec(text: string): PyMatch | null }   // search for session_rule, match-at-0 for attempts
export function compilePyRegex(source: string, ctx: PyRegexContext): CompiledPyRegex;                  // throws McsError REGEX_UNSUPPORTED
export function applyLabelTemplate(template: string, m: PyMatch): string;                               // legacy `{n}` / `{0}` substitution
```
Context semantics (legacy `sessions.py`, `panels.py`): `session_rule` = `re.search(pattern, text, re.S)` -> initial flags `{s: true}`,
mode `search`; `attempts` = `re.match(pattern, line)` (no flags, anchored at 0, not full match) -> mode `match`, emitted with the JS
sticky flag `y` and `lastIndex = 0`.

Parser: a recursive-descent port of the subset of CPython `sre_parse` listed below, over code points (lone surrogates -> `SYNTAX`).
Emitter: JavaScript `v`-mode (`unicodeSets`) source. Flags on the `RegExp`: always `v`; `i` when global IGNORECASE; `y` for `attempts`.
The JS `m` and `s` flags are never used: line and dot semantics are emulated so that they follow Python exactly.

Literal emission rule: `[A-Za-z0-9_]` raw; every other code point as `\u{HEX}` (valid inside and outside classes in `v` mode; avoids
v-mode reserved punctuators and "lone quantifier bracket" errors, E7).

Supported constructs:

| Python construct | Emitted JavaScript (`v` flag) | Notes / evidence |
|---|---|---|
| literal char, escaped punctuation `\.` `\[` ... | `x` or `\u{HEX}` | |
| `\a \f \n \r \t \v`, `\xhh`, `\uhhhh`, `\Uhhhhhhhh` | `\u{HEX}` | Python str-pattern escapes |
| `\0`, `\0o`, `\0oo`; `\ooo` (three octal digits, value <= 0o377) | `\u{HEX}` | exact `sre_parse._escape` rule, incl. "octal escape value outside of range" error |
| `.` | `[^\n]`; DOTALL: `[\s\S]` | Python `.` excludes only U+000A (E7); JS `.` also excludes CR, U+2028, U+2029 |
| `^` | `(?<![\s\S])`; MULTILINE: `(?:(?<![\s\S])\|(?<=\n))` | Python lines end only at `\n` |
| `$` | `(?=\n?(?![\s\S]))`; MULTILINE: `(?=\n\|(?![\s\S]))` | Python `$` also matches before a final `\n` (E7) |
| `\A` / `\Z` | `(?<![\s\S])` / `(?![\s\S])` | JS reads `\Z` as literal Z (research F.2) |
| `\d` `\D` | `[\p{Nd}]` / `[^\p{Nd}]`; ASCII flag: `[0-9]` | E7: 0 code points matched by Python and not by JS |
| `\w` `\W` | `[\p{L}\p{N}_]` / complement; ASCII flag: `[A-Za-z0-9_]` | E7: 0 Python-only; 4,657 JS-only, all newly assigned in Unicode 17 (Node ICU) vs 16 (Python 3.14) |
| `\s` `\S` | explicit class of the 29 code points U+0009-U+000D, U+001C-U+0020, U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 / complement; ASCII: `[\t\n\v\f\r ]` | E7: identical to Python; JS `\s` adds U+FEFF and lacks U+001C-U+001F, U+0085 |
| `\b` `\B` | `(?:(?<=W)(?!W)\|(?<!W)(?=W))` / `(?:(?<=W)(?=W)\|(?<!W)(?!W))` with W = the `\w` class above | JS `\b` is ASCII-only |
| `[...]`, `[^...]`, ranges, class escapes `\d\w\s\D\W\S`, `\b` (backspace) inside a class | `[...]` with nested classes (`v` mode) | `]` first in a set is literal (Python) |
| `(...)` | `(...)` | |
| `(?:...)` | `(?:...)` | |
| `(?P<name>...)` | `(?<name>...)` | ASCII identifier names only; duplicates -> `SYNTAX` ("redefinition of group name") |
| `(?P=name)`, `\N` / `\NN` backreference | `\k<name>`, `\N` | refused for open groups ("cannot refer to an open group") |
| `(?=...)` `(?!...)` | same | |
| `(?<=...)` `(?<!...)` | same | body must be fixed width (Python rule "look-behind requires fixed-width pattern"); width computed on the AST |
| `(?#...)` | removed | |
| `* + ? {m} {m,} {,n} {m,n}` and lazy `?` suffix | `{0,n}` for `{,n}`; others same, applied to a `(?:...)` wrapper | `{` not forming a quantifier is a literal `{` (Python) |
| leading global flags `(?aimsu)` at position 0 | `i` -> JS flag `i`; `m`, `s` -> emulation state; `a` -> ASCII classes; `u` -> no-op | |
| scoped flags `(?ims-ims:...)`, `(?a:...)` | `(?i:...)`/`(?-i:...)` modifiers (verified in V8 13.6, E7); `m`/`s`/`a` change emission inside | |

Rejected (fail loudly at `check`, `configure`, `start`; the message names the construct and suggests a rewrite):

| Construct | Code | Reason |
|---|---|---|
| `(?x)` verbose, `(?L)`, `(?u)` scoped with `-`, unknown flag | `UNSUPPORTED_FLAG` | not needed by any known config; verbose parsing is a second grammar |
| global flags not at position 0 (`a(?i)b`) | `SYNTAX` | Python 3.11+ error "global flags not at the start of the expression" |
| possessive `*+ ++ ?+ {m,n}+`, atomic `(?>...)` | `UNSUPPORTED_CONSTRUCT` | no JS equivalent (Python 3.11+ accepts them) |
| conditional `(?(1)a\|b)` | `UNSUPPORTED_CONSTRUCT` | no JS equivalent |
| `\N{NAME}` | `UNSUPPORTED_CONSTRUCT` | needs a Unicode name table |
| `\z` | `UNSUPPORTED_CONSTRUCT` | accepted only by Python 3.14 (E7); legacy floor is 3.8; suggest `\Z` |
| `(?<name>...)` | `SYNTAX` | Python error "unknown extension ?<n" (E7) |
| other ASCII-letter escapes (`\q`, `\e`, ...) | `SYNTAX` | Python error "bad escape" |
| `[[:alpha:]]`, `[[.x.]]`, `[[=x=]]`, `--`, `&&`, `~~`, `\|\|` inside a set | `UNSUPPORTED_CONSTRUCT` | Python FutureWarning "possible nested set / set operation"; meaning will change |
| repeat on an assertion (`(?=a)*`, `^*`, `\b+`) | `SYNTAX` | "nothing to repeat" |
| capturing group inside a repeated group (max > 1) when some iteration can skip it (under `\|` or a `min = 0` quantifier inside the repeat) | `INEXACT_SEMANTICS` | E7: `(?:(a)\|b)+` on `ab` -> Python group 1 `'a'`, JS `undefined` (JS resets captures per iteration) |
| IGNORECASE scope containing a non-ASCII literal or range endpoint | `INEXACT_SEMANTICS` | case folding tables differ; ASCII is exact once `i`/`I` add U+0130 and U+0131 (E7) |
| non-ASCII group name | `UNSUPPORTED_CONSTRUCT` | ASCII names keep JS/Python identical |
| JS `RegExp` constructor throws on the emitted source | `JS_COMPILE` | translator bug; never expected |

Under IGNORECASE, every ASCII literal `i`/`I` and every range covering `i` or `I` also emits `\u{130}\u{131}` (Python matches
U+0130 and U+0131 for `(?i)i`, JS does not, E7). Checked against Python for `(?i)[^i]`, `(?i)[^a-z]`, `(?i)i`, `(?i)[h-j]`, `(?i)k`
(Kelvin sign U+212A) and `(?i)s` (long s U+017F) on `i I U+0130 U+0131 k U+212A s U+017F a`: identical results (E7, `icase.mjs`).

Residual, documented differences (accepted): code points assigned in Unicode 17 but not in the Python build's Unicode version may be
`\w`/`\d` in JS and not in Python (E7: 4,657 + 10 code points, none used by text the monitor matches in practice); a different Python
version on the user's machine has its own Unicode tables (legacy floor 3.8 = Unicode 12.1).

Label template (`applyLabelTemplate`, legacy `sessions.py`): for `i = 1..groupCount` replace every `{i}` with `group(i) ?? ''`
(sequential, so text produced by group 1 containing `{2}` is substituted again, as in Python); then `{0}` with the first 40 code
points of `group(0)`. Offsets and slices are in code points (Python), not UTF-16 units.

Golden tests (`tests/legacy-parity/regex/`, project `parity`):
- `gen_regex_golden.py` (dev tool; Python 3.14 here; records `sys.version` and `unicodedata.unidata_version`) writes
  `regex-golden.json` `{pattern, context, inputs[], expected[]}` with Python results `null | {span:[s,e], groups:[...], groupdict:{...}}`
  (code points) and `regex-rejects.json` `{pattern, pythonError}`.
- Corpus: (a) one case per row of the supported table with edge inputs (`a\n`, `a\r`, U+2028, U+0085, U+FEFF, U+00E9, Arabic-Indic digits,
  astral letters, empty string); (b) the V9 replica: patterns with the same construct inventory as the live V9 task (section 9, E8:
  named groups, `^` at position 0, character classes with ranges, counted quantifiers `{N}`, greedy `+`, lazy `*?`, `.` under DOTALL,
  one plain capturing group; no backslash escapes, no flags, no lookarounds) built from the public `template/examples/chain.config.example.json`
  shapes; (c) 200 random patterns from the supported grammar (fixed seed) x 50 inputs generated from each pattern's AST plus mutations;
  (d) every row of the rejected table (Node must reject; for rows Python accepts, the test asserts the documented code).
- `pyregex.golden.test.ts` asserts equality of span, groups and groupdict for every case; `pyregex.rejects.test.ts` asserts rejection.
- Opt-in local check `MCS_GOLDEN_LIVE_CONFIG=<path to a config.json> npm run test:parity` runs the same differential on a real config
  without committing it (prints counts only), as done for V9 in E8 (31,500 comparisons, 0 differences).

### 2.9 JSON Schemas (`<skill>/schemas/`)

| File | Source | Mode |
|---|---|---|
| `config.v1.schema.json` | `LegacyConfigZodMirror` (a Zod mirror of 2.4 used only for docs/editors; the predicate table stays authoritative; a test checks both accept/refuse the same 60 fixtures) | `io: 'input'` |
| `runtime.v1.schema.json` | `RuntimeOverridesSchema` | `io: 'input'` (defaulted keys optional, E12) |
| `instance.v1.schema.json`, `state.v1.schema.json` | `InstanceFileSchema`, `StateFileSchema` | output |
| `backup-manifest.v1.schema.json`, `cli-envelope.v1.schema.json`, `diagnostics.v1.schema.json` | 5.6, 6.2, 6.4 | output |
| `api/*.schema.json` | API design | (owned there) |

Generator `runtime/scripts/gen-schemas.mjs` (imports the built `@mcs/shared`, calls `z.toJSONSchema(schema, { target: 'draft-2020-12', io })`,
adds `$id` = `https://monitoring-claude-sessions.local/schemas/<file>` and a `description` pointing to the doc, writes
`JSON.stringify(x, null, 2) + '\n'`). `npm run schemas` regenerates; `schemas.drift.test.ts` regenerates in memory and fails on any byte
difference. Each config schema `description` states "Regexes use Python syntax (see docs/configuration.md, translator rules)".

### 2.10 Environment variables (the complete documented list)

Runtime and operator variables (they may change behaviour in production; each is documented in `docs/configuration.md`):

| Variable | Read by | Effect |
|---|---|---|
| `MCS_LOG_LEVEL` | config resolution | `logLevel` (layer 3.5); invalid value -> `CONFIG_INVALID` naming the variable |
| `MCS_HOOK_DISABLE` | hook handler (02 2.2) | `1` = handler exits 0 immediately; the server sets it for every child it spawns and for itself |
| `MCS_HOME` | engine paths | per-user monitor folder for state not tied to one workspace, resolved by `resolveMcsHome(env)` of design 02 (2.6.1: `MCS_HOME` if absolute; else `%LOCALAPPDATA%/mcs` on Windows; else `$XDG_STATE_HOME/mcs` or `~/.local/state/mcs`). Holds the hook route files, handler log, installer records (02) and the POSIX mutex lock files of this design (`locks/mutex/`). Tests point it to a temp folder. It never changes where transcripts are read |
| `CLAUDE_CONFIG_DIR` | transcript discovery (legacy rule) | Claude home (default `<home>/.claude`); also `InstanceContext.claudeHome` (4.4a) |
| `MCS_FS_WATCH` | change hint (06 4.4, `platform/watch-hint.ts`) | `0` = do not use `fs.watch` as a hint; polling (the source of truth) is unchanged. Any other value or unset = hint on |
| `MCS_LAUNCHER_NO_BOOTSTRAP` | launcher | `1` = never run `npm ci`/build; a stale build is an error (CI, tests) |
| `MCS_PYTHON` | legacy delegation (6.5) | Python executable for `$V` (default: probe `python`, `python3`, `py -3`) |
| `MCS_DEBUG` | CLI, launcher | `1` = print stack traces for `INTERNAL` errors |

Test and development variables (I-27). They never change configuration; production code reads the `MCS_TEST_*` hooks only through
`testHook(name)` in `packages/engine/src/runtime/test-hooks.ts`, which returns `undefined` unless `MCS_TEST === '1'`:

| Variable | Read by | Effect |
|---|---|---|
| `MCS_TEST` | `test-hooks.ts`; hooks CLI guard (6.4) and installer guard (02 3.5 step 4) | `1` = test mode: enables the `MCS_TEST_*` hooks below; hook install/uninstall refuse any target outside `os.tmpdir()` (`REAL_SETTINGS_IN_TEST` / `HOOKS_FAILED`). `VITEST` (set by Vitest) has the same guard effect |
| `MCS_TEST_IGNORE_CONTROL` | server control channel (4.3), via `testHook` | `1` = the server ignores `shutdown` requests (T-LC-06) |
| `MCS_TEST_BOOT_HANG` | server boot (4.4), via `testHook` | `1` = boot stops before phase `ready` and waits (T-LC-08) |
| `MCS_TEST_INIT_CRASH` | `ops.workspace.init` (4.12), via `testHook` | `before-rename` = exit 70 between staging and rename (T-LC-10) |
| `MCS_PERF_FACTOR` | 02 T-HK-10, 06/05 performance tests | positive number multiplying time budgets (default 1) |
| `MCS_GOLDEN_LIVE_CONFIG` | regex parity test (2.8) | path of a real `config.json` for the opt-in differential; prints counts only |
| `MCS_GOLDEN_DIR` | parity harness (06 5.2, 5.4) | folder of golden captures instead of `tests/legacy-parity/golden` |
| `MCS_PARITY_LIVE` | parity harness (05 4.11) | `1` = run the Python oracle live (needs Python >= 3.8) |
| `MCS_E2E_CLAUDE` | E2E (02 3.7, 05) | `1` = run the optional real Claude Code E2E with a temp `--settings` file and temp `MCS_HOME` |
| `MCS_E2E_PORT` | Playwright config (05) | E2E server port (default 18900, 05) |
| `MCS_DEV_API` | `packages/web/vite.config.ts` (04 12, 05 3.1 `dev.mjs`) | API origin the dev server proxies to (05 default `http://127.0.0.1:18765`) |
| `MCS_WEB_DEV_PORT` | `vite.config.ts` | Vite dev server port (05 default 18766) |
| `MCS_WEB_PREVIEW_PORT` | `vite.config.ts` | Vite preview port |
| `MCS_BUILD_ID` | `vite.config.ts` | build id injected as `VITE_BUILD_ID` (default `dev`) |

No other `MCS_*` variable is read anywhere, and no variable changes configuration except `MCS_LOG_LEVEL` (D4). Enforcement: the list
above is the constant `DOCUMENTED_ENV_VARS: readonly { name: string; scope: 'runtime' | 'test' | 'dev'; readers: readonly string[] }[]`
in `packages/shared/src/env.ts` (slice S1); `runtime/tooling/env-vars.test.ts` (owned by 05 slice S1, project `unit`) greps
`runtime/packages/*/src/**`, `runtime/scripts/**`, `runtime/tests/**`, `runtime/*.config.*`, `<skill>/scripts/*.mjs` for
`/\bMCS_[A-Z0-9_]+\b/` and fails when a name is not in `DOCUMENTED_ENV_VARS`, when a documented name is never read, or when a
`MCS_TEST_*` name appears in production sources outside `test-hooks.ts`; a docs test checks that `docs/configuration.md` lists every
`runtime`-scope name. Tests must clear `CLAUDE_CONFIG_DIR`/`MCS_*` before setting their own (testkit helper `hermeticEnv()`).

---

## 3. Instance identity and isolation

### 3.1 Identifiers

| Id | Format | Created by | Stored in | Checked where |
|---|---|---|---|---|
| `taskId` (slug) | `^[a-z0-9][a-z0-9-]{0,47}$`, not `con prn aux nul com0-9 lpt0-9` | `init` (from `--slug` or `slugify(--name)`) | folder name, `task.json.id`, `instance.json.slug`, `state.json.task` | every command (3.2) |
| `instanceId` | uuid v4 (`crypto.randomUUID()`) | `init` / adopt / `instances repair` | `instance.json`, DB `meta.instance_id` (data design), `state.json`, server argv `--mcs-instance=`, control channel name, spool envelopes (ingestion design), API/SSE payloads (`04-ui.md` UI-I11), backup manifests | 3.2 |
| `projectId`, `sessionId`, `agentId`, `eventId` | data design | ingestion | DB | API layer (never cross-instance, D11) |
| OS `pid` | int | OS | `state.json`, control `identify` | only together with `instanceId` (never alone, INV-04) |

`slugify(name)` (legacy, golden `'Nightly build: Steps A/B'` -> `nightly-build-steps-a-b`): lowercase, runs of `[^a-z0-9]` -> `-`,
trim `-`, cut to 48, trim `-`, empty -> `task`. Reserved device names: the legacy list (`con nul prn aux`) plus `com0`-`com9`,
`lpt0`-`lpt9` (Windows cannot create those folders; stricter than legacy, documented). Message (legacy):
`invalid task slug <pyRepr(slug)> (use lowercase letters, digits and hyphens, at most 48 characters)`.

### 3.2 Identity checks

| Where | Check | Failure |
|---|---|---|
| `resolveWorkspace(root, slug)` (every command) | slug valid; `realpath(root/slug)` inside `realpath(root)`; workspace and its JSON files not links | `SLUG_INVALID`, `WORKSPACE_ESCAPE`, `WORKSPACE_SYMLINK` |
| reading `instance.json` | `slug === folder name` | `IDENTITY_MISMATCH` "instance.json belongs to '<slug>' but sits in '<folder>' (copied workspace?); run `mcs instances repair --task <folder>`" |
| server boot (4.4 step 2) | argv `--mcs-instance` === `instance.json.instanceId`; `task.json.id` === folder | exit 11 |
| DB open (data design) | DB `meta.instance_id` === `instanceId` (new DB: stamped) | exit 11 (`IDENTITY_MISMATCH`, never auto-fixed) |
| CLI talking to a server | control `identify.instanceId` === `instance.json.instanceId`; HTTP `/api/v3/health.instanceId` equal too | treated as "not our runtime" (4.8) |
| backup restore | `manifest.instanceId` === `instance.json.instanceId` | `BACKUP_INVALID` |
| UI | stream `hello.instanceId` === `/api/v3/instance.instanceId` | UI clears its cache (`04-ui.md` UI-I11) |

### 3.3 Shared versus owned
Shared by all instances on the machine: the built code (`<skill>/runtime/**`, read-only at run time), `<skill>/config/defaults.json`,
`<skill>/runtime/defaults.json`, the Node executable, the user's Claude transcripts (read-only inputs) and, when installed, hook
settings entries (ingestion design). Owned by exactly one instance: everything under its workspace (1.1), its process, its control
channel name, its bound port while it runs. Nothing else is shared: no global DB, no global cache, no cross-instance endpoint (D2, D11).

### 3.4 Copied or renamed workspaces
A user can copy a workspace folder (same `instanceId`, wrong `slug`). Detection: 3.2 row 2. Repair, explicit only:
`mcs instances repair --task <slug> [--yes]`:
1. Refuse if a runtime with either id is running (`INSTANCE_RUNNING`).
2. Plan: new `instanceId`, `slug` := folder name; move `data/` to `data/backups/orphaned-<UTC ts>/` (the DB belongs to the other
   instance; never opened under the new id); remove `state.json` and `run/` contents.
3. Dry run by default; `--yes` applies (atomic `instance.json` write), removes the route file of the old id and writes one for the new
   id (02), audit `instances-repair`.

### 3.5 Isolation test matrix (brief section 4, release-blocking)
Fixtures (`@mcs/testkit`): `tempRoot()` (mkdtemp + `hermeticEnv()` with `MCS_HOME`, `CLAUDE_CONFIG_DIR` in the temp root),
`buildDemo()` (`04-ui.md` 11.5), `makeWorkspace({root, slug, config?, runtime?})` (calls the real `init`), `startInstance(ws, {port})`
(real `$MCS start`, port from `findFreePort(18000, 18499)`, the range design 05 assigns to real-process integration tests), `snapshotWorkspace(dir, {excludeRuntimeMutable})` (sha256 per relative
path), `spawnImpostor(argv)` (a sleeping Node process with chosen argv, to simulate pid reuse), `makeJunction(link, target)`
(`cmd /c mklink /J`, Windows; symlink elsewhere). Vitest projects from the scaffold: `unit`, `integration`, `isolation`, `resilience`,
`parity`. Isolation tests run real processes, one file per guarantee, `workers: 1`.
Traceability (I-23): design 05 4.8 keeps the brief-bullet ids ISO-1..9 and maps them to the rows below: ISO-1 = T-ISO-01..05,
ISO-2 = T-ISO-06..08, ISO-3 = T-ISO-09/10, ISO-4 = T-ISO-11/12, ISO-5 = T-ISO-13..15, ISO-6 = T-ISO-16/17, ISO-7 = T-ISO-18..23,
ISO-8 = T-ISO-24..27, ISO-9 = design 02 T-HK-05. Test file names follow 05 4.3.

| Id | Guarantee (brief 4) | Test | Project | Assertion |
|---|---|---|---|---|
| T-ISO-01 | A cannot read B's private state | `resolveWorkspace` with slugs `../b`, `b/../a`, `a\b`, `C:b`, `.b`, `con`, `com1`, 49 chars, upper case | unit | each throws the documented code; nothing created |
| T-ISO-02 | same | tasks root contains `a` as a junction to `b` | unit (Windows), symlink on POSIX | `WORKSPACE_SYMLINK`; B files unchanged |
| T-ISO-03 | same | A and B running on disjoint demo data; A's `GET /api/v3/sessions/<B session id>`, `/sessions/<B id>/transcript` | isolation | 404; A's `/api/v3/instance.instanceId` != B's |
| T-ISO-04 | same | `mcs inspect --task a`, `mcs sessions list --task a`, `mcs diagnostics --task a` outputs | isolation | contain none of B's marker strings (slug, unique rule text, session ids) |
| T-ISO-05 | same (defence in depth) | copy B's `data/monitor.db` into A, start A | isolation | server exits 11; `start` reports `IDENTITY_MISMATCH`; A's copy untouched |
| T-ISO-06 | A cannot overwrite B's configuration | snapshot B (excluding runtime-mutable paths) around each of: `init a`, `configure --task a` (L and R keys), `decide`, `config migrate --task a --yes`, `upgrade --task a --yes`, `backup --task a`, `cleanup --task a --scope logs --yes`, `instances repair --task a --yes`, `hooks enable --task a`, `db rebuild --task a --yes --confirm a`, `ingest replay --task a --yes` | integration | B snapshot equal; `configure` itself reports `isolation: ok` (6.4) |
| T-ISO-07 | same | `configure --task a --set` with keys `../b`, `a/../../b`, `__proto__.x`, `constructor.prototype.x` | unit | rejected (`unknown key`); prototype unchanged |
| T-ISO-08 | same | A runs 30 s with hook and transcript activity; B stopped | isolation | B full-tree snapshot (including runtime-mutable paths) unchanged |
| T-ISO-09 | A's token statistics exclude B | one Claude home; rules select sessions X for A, Y for B (one session Z matches both rules) | isolation | `GET /api/v3/analytics/usage` of A = expected(X+Z), of B = expected(Y+Z) (demo builder expectations); `mcs usage --task a` equals the API |
| T-ISO-10 | same (DB layer) | synthetic DB holding rows of two `instance_id`s queried through the usage function | unit (data design function) | only own rows |
| T-ISO-11 | A's search excludes B | unique marker text in a transcript only B selects | isolation | A `/api/v3/search/transcript?q=<marker>` = 0 hits, B >= 1 |
| T-ISO-12 | same | A asked for a session id that exists on disk but is outside A's scope | integration | 404 (resolution by A's sessions table, never by path) |
| T-ISO-13 | stopping A does not stop B | start A and B; `mcs stop --task a` | isolation | A pid gone, A port closed; B pid alive, B health 200, B `state.json` bytes unchanged, B `identify` OK |
| T-ISO-14 | same | A's `state.json` rewritten to name B's pid and URL; `mcs stop --task a` | isolation | nothing killed (B identity != A); A stale file removed; message "not this instance's runtime" |
| T-ISO-15 | same | `mcs cleanup --task a --scope stale-state` with B running | integration | B files unchanged |
| T-ISO-16 | restarting A does not corrupt B's DB | A and B running, spool lines appended to both every 50 ms; restart A five times; then stop both | isolation | B `PRAGMA integrity_check` = `ok`; B event count = lines appended; B pid unchanged during the test |
| T-ISO-17 | same | `taskkill /F` (POSIX `SIGKILL`) on A during ingestion, then start A | resilience | A integrity `ok` after restart; B unaffected (same assertions) |
| T-ISO-18 | no conflicting port/runtime state | A and B configured with the same `port`; started concurrently | isolation | distinct ports; each `state.json` names its own pid/port; each health returns its own `instanceId` |
| T-ISO-19 | same | two concurrent `mcs start --task a` | isolation | exactly one process with A's marker (`listRuntimeProcesses`); both exit 0 with the same URL |
| T-ISO-20 | same | `serve` launched by hand while A runs | isolation | exits 12 within 1 s; A unaffected |
| T-ISO-21 | same | copy workspace `a` to `c`; `mcs start --task c` | integration | `IDENTITY_MISMATCH` + repair hint; nothing started |
| T-ISO-22 | same | A's `state.json` names a live impostor (`spawnImpostor`) | integration | `status` not running; `stop` kills nothing; `start` succeeds and overwrites the file |
| T-ISO-23 | same | legacy viewer running for `a` (skip when no Python >= 3.8) | isolation | `mcs start --task a` prints "already running (engine=legacy)", starts nothing |
| T-ISO-24 | upgrades never overwrite user-owned files | checked-in workspace fixture created by an older runtime version; `mcs upgrade --task a --yes` | integration | `config.json`, `task.json`, `README.md` bytes equal; old audit bytes are a prefix of the new ones; backup exists and its sha256 values match the pre-upgrade files |
| T-ISO-25 | same | launcher bootstrap (`npm run build`) with two workspaces present | integration | both workspace snapshots equal |
| T-ISO-26 | same | DB with a schema version above the runtime's | integration | `start` refused `DB_NEWER_THAN_RUNTIME`; workspace snapshot equal |
| T-ISO-27 | same | `config migrate` dry run, then `--yes` with a registered test step | unit + integration | dry run writes nothing; apply writes a backup whose bytes equal the originals before writing |

Cross-engine tests (`parity` project; skipped with a recorded reason when Python >= 3.8 is not available):

| Id | Test | Assertion |
|---|---|---|
| T-XE-01 | Node `configure` then `$V check --task a` | exit 0 |
| T-XE-02 | the same sequence of `configure` operations via `$V` and via `$MCS` on two copies | `config.json` byte-identical; audit entries identical after masking the `## <ts>` line |
| T-XE-03 | `$V start --task a` while the Node runtime of `a` runs | prints `already running: <url> (pid N)` (needs the `/api/health` compatibility endpoint, C-4) |
| T-XE-04 | `$V stop --task a` against the Node runtime | legacy removes `state.json`, kills nothing; within `stateWatchdogMs + 2 s` the Node runtime rewrites it and `mcs status --task a` reports running |
| T-XE-05 | `mcs stop --task a` against a legacy viewer | viewer process gone, `state.json` removed, message `stopped viewer pid N (<url>)` |
| T-XE-06 | `$V audit --task a` and `$V doctor` after Node init + runtime activity | exit 0 (requires C-1) |
| T-XE-07 | `$V configure --task b` while Node runtime `a` writes | documents C-2: either exit 0 or the legacy false positive; the test records which and asserts `b/config.json` content is correct in both cases |

---

## 4. Process lifecycle

### 4.1 Process model
One runtime process per instance (D2). Command line (exact argv; order fixed):
```
<process.execPath> <skill>/runtime/packages/server/dist/main.js serve --mcs-instance=<instanceId> --instance-dir=<abs workspace> [--port=<n>] [--log-level=<level>]
```
Runtime marker (used when the control channel does not answer, ADR 0006): the command line, with `\` replaced by `/` and compared
case-insensitively on Windows, contains `/packages/server/dist/main.js` and the exact token `--mcs-instance=<instanceId>`.
Legacy marker: contains `viewer.py` (legacy rule, `cli.py:288`).

Server exit codes (read by `start` while waiting, 4.7):

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | graceful shutdown |
| 1 | (reserved) | forced termination on Windows (libuv `TerminateProcess(h, 1)`); never used by our code |
| 10 | `CONFIG_INVALID` | config failed validation or regex translation |
| 11 | `IDENTITY_MISMATCH` | argv/instance.json/task.json/DB identity disagree |
| 12 | `INSTANCE_LOCKED` | the control channel name is taken (another runtime of this instance) |
| 13 | `PORT_EXHAUSTED` | no free port in base..base+portScan |
| 14 | `DB_ERROR` | DB open/create/migration of a new DB failed |
| 15 | `DB_NEWER_THAN_RUNTIME` | DB schema above the supported range |
| 16 | `DB_UPGRADE_REQUIRED` | existing DB schema below the runtime's (run `mcs upgrade`) |
| 17 | `WORKSPACE_INVALID` | missing/invalid files, links, unwritable folders |
| 18 | `BUILD_INVALID` | `runtime/.mcs-build.json` missing or `dist` incomplete |
| 70 | `INTERNAL` | uncaught exception during boot |

### 4.2 Platform layer (`@mcs/engine/platform/`)
One process helper exists (I-06). Its authoritative signatures are design 06 3.6 (`exec.ts`) and 06 4.2 (`process.ts`); both files are
owned by 06 slice PP1, which implements the additions this document needs (listed below). This document owns `mutex.ts` and
`markers.ts` (slice S4). Every function below is imported from those modules; 01 code never spawns or kills by other means.
```ts
// exec.ts (06 3.6, owner 06 PP1): ChildSpec / ChildResult are authoritative; execFileText never throws, never rejects
export function execFileText(spec: ChildSpec, signal?: AbortSignal): Promise<ChildResult>;   // { ok, code, stdout, stderr, error, truncated, durationMs }
export function resolveExecutable(name: ExecutableName): Promise<string | null>;
export function childStats(): Record<ChildKind, { spawned: number; failed: number; timedOut: number; totalMs: number }>;
// specified here, implemented in the same file by 06 PP1 (shell:false, windowsHide:true, argv array; no ChildKind, no semaphore: they start our own Node or Python)
export function spawnDetached(file: string, args: readonly string[], o: { cwd: string; env: Record<string, string>; stdoutFd: number; stderrFd: number }): ChildProcess; // detached:true, stdio ['ignore', stdoutFd, stderrFd]
export function spawnForeground(file: string, args: readonly string[], o: { cwd: string; env: Record<string, string> }): ChildProcess;  // stdio:'inherit' (only `serve` and legacy delegation from an interactive CLI)

// process.ts (06 4.2, owner 06 PP1); killPid of 06 is replaced by forceKill + waitForExit
export function pidAlive(pid: number): boolean;                         // never signals a live process; EPERM -> true, ESRCH -> false
export function commandLineOf(pid: number): Promise<string | null>;     // 06 form: powershell.exe -EncodedCommand (kind 'powershell.cmdline'), 20 s timeout, 5 s cache per pid; Linux /proc/<pid>/cmdline; macOS `ps -o command= -p <pid>`
export function forceKill(pid: number): Promise<void>;                  // Windows: process.kill(pid) (= TerminateProcess, same effect as `taskkill /F`, no spawn); POSIX: process.kill(pid, 'SIGKILL'); ESRCH ignored; pid validated /^[1-9][0-9]{0,9}$/
export function waitForExit(pid: number, timeoutMs: number, pollMs?: number /* 100 */): Promise<boolean>;   // true when pidAlive turned false within timeoutMs

// markers.ts (owner 01 S4): command-line markers and the runtime listing; all process.platform branching stays in platform/** (I-34)
export function hasRuntimeMarker(commandLine: string, instanceId: string): boolean;   // 4.1 rule: '/' normalisation, case-insensitive on win32, contains '/packages/server/dist/main.js' and the token '--mcs-instance=<instanceId>'
export function hasLegacyMarker(commandLine: string): boolean;                        // contains 'viewer.py' (legacy cli.py:288)
export function listRuntimeProcesses(runtimeDir: string): Promise<{ pid: number; instanceId: string | null; instanceDir: string | null }[]>;
  // Windows: one execFileText kind 'powershell.cmdline' with a CONSTANT -EncodedCommand script listing `ProcessId<TAB>CommandLine` of every
  // node.exe (Get-CimInstance Win32_Process -Filter "Name='node.exe'"); filtering by <runtimeDir>/packages/server/dist/main.js happens in Node
  // (06 rule 8: no path is ever interpolated into PowerShell text). Linux: scan /proc/*/cmdline. macOS: `ps -axo pid=,command=` (kind 'ps').

// mutex.ts (owner 01 S4): OS-released process mutex (ADR 0005)
export interface ProcessMutex { readonly name: string; release(): Promise<void> }
export function tryAcquireMutex(name: string): Promise<ProcessMutex | null>;          // null when held elsewhere
export function acquireMutex(name: string, o: { timeoutMs: number; onWait?: (waitedMs: number) => void }): Promise<ProcessMutex>; // polls every 25-50 ms (jitter); throws McsError on timeout
export function mutexName(kind: 'task' | 'bootstrap' | 'settings', key: string): string;   // 'mcs-<kind>-' + sha256(key.toLowerCase() on win32).slice(0, 16)
```
Additions this document needs from 06 PP1 (stated as requirements on 06 3.6, not as a second definition): `ChildKind` gains `'node'`
(spawns of `process.execPath`, for example 02 3.7 `hooks verify` and test helpers), `'python'` (the 6.5 version probe), `'icacls'` (the
`doctor` ACL check, 6.4) and `'opener'` (`start --open`, 4.7); `ExecutableName` gains `'python'` (`MCS_PYTHON`, then `python`, `python3`,
`py`, resolved to an absolute `.exe` on PATH), `'icacls'` (`%SystemRoot%/System32/icacls.exe`) and `'opener'` (Windows
`%SystemRoot%/explorer.exe`, macOS `/usr/bin/open`, else `xdg-open` on PATH). Every call site here uses `timeoutMs` and
`maxOutputBytes` explicitly: python probe 5000 ms / 4 KiB, icacls 10000 ms / 64 KiB, `git check-ignore` 5000 ms / 4 KiB, opener
10000 ms / 4 KiB, runtime listing 20000 ms / 1 MiB.

Rules: no other module imports `node:child_process` (INV-11; lint `no-restricted-imports` with an allow-list of `platform/exec.ts`, plus
the launcher which has its own zero-dependency copy, 5.1). `windowsHide: true` on every spawn; `stdio: 'inherit'` only through
`spawnForeground` (an interactive CLI that has a console). The CLI process is short-lived and calls `commandLineOf` at most once per pid
per command, immediately before the kill decision, so the 5 s cache of 06 never serves it an older value; the server never kills.
Rationale and evidence: E1 (a detached server has no console; its `windowsHide:true` children get no console window; a child that
inherited stdio or omitted `windowsHide` from a console-less parent would get a new visible console, per the Win32 `CreateProcess`
rules; that case was deliberately not run, to avoid flashing a window on the owner's desktop). E3: `process.kill(pid)` on Windows
terminates at once without handlers, exactly like `taskkill /F`, so `forceKill` needs no child process.

`ProcessMutex` implementation: Windows: `net.createServer().listen('\\.\pipe\<name>')`; `EADDRINUSE` -> held (E3, E10: five contenders,
never more than one holder; the pipe is released immediately when the holder dies, even by `taskkill /F`). Linux: abstract socket
`'\0' + name` (released by the kernel on death; UNVERIFIED on this Windows machine, test in CI matrix). macOS and others: lock file
`$MCS_HOME/locks/mutex/<name>.lock` created with `wx` holding `{pid, nonce, createdAt}`; stale if `pidAlive(pid)` is false; break
by `rename` to `<name>.stale-<nonce>` then re-check the nonce (documented narrow race; UNVERIFIED). Uses: `task` mutex (key =
`realpath(workspace)`) around every write command (configure, decide, init, migrate, upgrade, db migrate, db rebuild, ingest replay,
backup, restore, cleanup, repair, set-engine, hooks enable/disable); `bootstrap` mutex (key = `realpath(runtimeDir)`) in the launcher
(its zero-dependency copy, 5.1; design 05 3.3.4 and ADR 0047 reference the same name, I-24); `settings` mutex (key = absolute settings
file path) around the hook installer's read-modify-write (02 3.5 step 1, I-29).

### 4.3 Control channel (ADR 0005)
Address: Windows `\\.\pipe\mcs-<instanceId>`; Linux abstract `\0mcs-<instanceId>`; other POSIX `<os.tmpdir()>/mcs-<uid>/<instanceId>.sock`
(folder mode 0700; stale socket file: connect -> `ECONNREFUSED` -> unlink -> listen once more).
The server listens on it first thing at boot (it is the instance lock, INV-03) and keeps it until exit.
Protocol: one request per connection, one UTF-8 JSON object per line (`\n`), request <= 4096 bytes, server reply one line then close;
the server closes connections idle for 2 s; client timeout 2 s.
```ts
// @mcs/shared/protocol/control.ts (zod-free; used by CLI and server)
export type ControlRequest =
  | { v: 1; op: 'identify' }
  | { v: 1; op: 'shutdown'; instanceId: string; token: string; reason: 'stop' | 'restart' | 'upgrade' | 'signal' }
  | { v: 1; op: 'backup'; instanceId: string; token: string; dest: string /* absolute path of <ws>/data/backups/<id>.partial/monitor.db */ }
  | { v: 1; op: 'ingest-replay'; instanceId: string; token: string; fromSegment: string | null /* SPOOL_SEGMENT_RE (02 2.7) or null = all */ };
export type ControlPhase = 'starting' | 'ready' | 'stopping';
export type ControlResponse =
  | { v: 1; ok: true; op: 'identify'; instanceId: string; pid: number; phase: ControlPhase; runtimeVersion: string; codeStamp: string; port: number | null; url: string | null; startedAt: string }
  | { v: 1; ok: true; op: 'shutdown'; phase: 'stopping' }
  | { v: 1; ok: true; op: 'backup'; bytes: number; dbSchemaVersion: number }
  | { v: 1; ok: true; op: 'ingest-replay'; segments: number }
  | { v: 1; ok: false; error: 'BAD_REQUEST' | 'FORBIDDEN' | 'INSTANCE_MISMATCH' | 'NOT_READY' | 'BACKUP_FAILED' };
```
`identify` needs no token and returns no secret. `shutdown`, `backup` and `ingest-replay` require `instanceId` equal to the server's and `token` equal to
`run/control.token` (`crypto.timingSafeEqual` on equal-length buffers; length mismatch -> FORBIDDEN). `backup.dest` must resolve
(realpath of its folder) inside `<ws>/data/backups/`, must not exist, and its folder must end with `.partial`; otherwise
`BAD_REQUEST`. The reply for `backup` is sent when the copy finished (client timeout for this op: 10 minutes). `ingest-replay`
validates `fromSegment` against `SPOOL_SEGMENT_RE` (else `BAD_REQUEST`) and calls `runtime.ingestReplay(fromSegment)` (4.4a), which
resets the selected cursors inside one writer transaction and nudges the drainer; reply after the commit (client timeout 30 s). A shutdown received in phase
`starting` is honoured after boot reaches a safe point (the server aborts boot, closes the DB if open, exits 0). Measured (E3):
`identify` 69 ms round trip, `shutdown` reply 52 ms and the process gone 10 ms later; graceful handlers ran; wrong token -> FORBIDDEN,
process kept running.

### 4.4 Server boot sequence (`packages/server/src/main.ts`, `serve`)
Phase `starting`:
1. Parse argv (`--mcs-instance`, `--instance-dir`, optional `--port`, `--log-level`); bad argv -> stderr message, exit 17.
2. Read `instance.json`, `task.json`; identity (3.2) -> exit 11.
3. Acquire the control channel (listen); `EADDRINUSE` -> exit 12 (nothing else touched: no log file, no DB, no state).
4. Open the logger (`logs/runtime.log`; rotation by the 05 constants `LOG_ROTATE_BYTES` 10 MiB and `LOG_KEEP` 5, 05 S-LOG-6).
5. `resolveConfig` (2.3) with CLI values from argv -> exit 10 on failure (the error is logged and printed to stderr = `boot.log`).
6. Read `runtime/.mcs-build.json` (codeStamp, runtimeVersion) -> exit 18 if missing or its runtimeVersion != `RUNTIME_VERSION`.
7. Open the DB through the data design's `openInstanceDb({path, expectedInstanceId, mode: 'serve', runtimeVersion})` (03 4.5): new DB ->
   create + stamp `instance_id`; existing -> identity (exit 11), version (exit 15 newer, exit 16 older); failures exit 14
   (`DB_OPEN_EXIT_CODES`). Then `ctx = await buildInstanceContext(...)` and `runtime = createInstanceRuntime(ctx)` (4.4a). Eagerly
   import every module the server uses (no lazy `import()` after boot: a later `npm run build` may replace files, E11).
8. Load the web build into memory (`packages/web/dist`, bounded by the 05/UI budget, about 0.3 MB): a rebuild while running cannot
   break the served UI (E11 shows files can be deleted under a running process). Build the HTTP app with the API design's app factory
   (`packages/server/src/app.ts`, 03 slice S4) from `ctx` and `runtime`.
9. Bind HTTP (4.11) -> exit 13.
10. Write `run/control.token` (atomic, `wx` temp), then `state.json` (atomic, 1.7). If `state.json` exists and names a live process
    whose identity is not ours (a legacy viewer started with `$V serve` bypassing checks), do not overwrite; log `ownership_conflict`,
    expose it in health, continue serving (the CLI refuses to start a second engine, so this needs manual action; `doctor` reports it).
11. `await runtime.start()` (4.4a: ingestion, sweeper, maintenance timers, state watchdog, route file with `stoppedAt: null`). Phase :=
    `ready`. Log `runtime ready` with port and pid (no paths beyond the workspace-relative ones).
Any uncaught error during 1-11 -> log, best-effort cleanup (`runtime.stop(now + 1000)` when created, close DB, remove our `state.json` via
compare-and-delete, delete the token), exit 70.

### 4.4a Composition root (`packages/engine/src/runtime/`, slice S8; I-15)
The one object every server-side service receives. The server main builds it once per process; the parity harness (06 5.4), the
in-process integration tests (02, 03) and the benchmark scripts build it with the same function and no HTTP.
```ts
// packages/shared/src/time.ts (slice S1; I-36)
export interface Clock { now(): number }                                  // epoch milliseconds UTC; the only time source of engine code
export const systemClock: Clock;                                          // { now: () => Date.now() }
export function isoSecondsZ(ms: number): string;                         // 'YYYY-MM-DDTHH:MM:SSZ' (audit headers, instance.json, backup ids)
export function isoMsZ(ms: number): string;                              // new Date(ms).toISOString()
// @mcs/testkit FakeClock (05 4.4) implements Clock.

// packages/engine/src/runtime/error-ring.ts
export interface ErrorRing {
  push(e: { source: string; code: string; where: string | null; message: string; sessionId?: string | null }): void;  // message: first line, clipped to 200 chars
  list(limit?: number): ErrorItem[];                                      // 03 6.2 ErrorItem, newest first, capacity 20
}
export function createErrorRing(clock: Clock, capacity?: number /* 20 */): ErrorRing;

// packages/engine/src/runtime/context.ts
export interface ExecApi { execFileText: typeof execFileText; resolveExecutable: typeof resolveExecutable; childStats: typeof childStats }  // 4.2; tests inject fakes
export interface RuntimeProcessInfo {
  readonly pid: number; readonly startedAtMs: number; readonly runtimeVersion: string; readonly bootCodeStamp: string;
  readonly previousRunUnclean: boolean;                                   // 4.13
  phase(): ControlPhase;                                                  // 4.3
  outdated(): { outdated: boolean; reason: 'code_stamp_changed' | 'runtime_version_changed' | null };   // 5.3, disk stamp re-read at most every 10 s
  ownershipConflict(): boolean;                                           // 4.6 watchdog flag
}
export interface InstanceContext {
  readonly instanceId: string; readonly slug: string;
  readonly instanceDir: string;            // realpath of the workspace
  readonly repoDir: string;                // = config.monitor.repo (absolute, 2.3 step 3)
  readonly claudeHome: string;             // CLAUDE_CONFIG_DIR (absolute) or <home>/.claude (2.10)
  readonly mcsHome: string;                // resolveMcsHome(env) (02 2.6.1)
  readonly skillDir: string; readonly runtimeDir: string;
  readonly config: ResolvedConfig;         // 2.3; immutable for the process lifetime (configure reports restart_needed)
  readonly instance: InstanceFile;         // 1.5 as read at boot
  readonly hooksEnabled: boolean;          // instance.hooks.enabled
  readonly clock: Clock;
  readonly db: InstanceDb;                 // 03 4.5, mode 'serve'
  readonly scope: RepoContext;             // { instanceId }; passed first to every repository and query call
  readonly queries: EngineQueries & TranscriptQueries;   // createQueries(db, { config, now: () => clock.now(), process }) (03 12.1)
  readonly errors: ErrorRing;
  readonly exec: ExecApi;
  readonly logger: Logger;                 // 05 engine/src/log/logger.ts (allow-listed fields)
  readonly process: RuntimeProcessInfo;
}
export interface BuildContextInput {
  readonly instanceDir: string; readonly env: Readonly<Record<string, string | undefined>>; readonly cli: { port?: number; logLevel?: LogLevel };
  readonly skillDir: string; readonly runtimeDir: string; readonly build: { runtimeVersion: string; codeStamp: string };
  readonly clock?: Clock; readonly exec?: ExecApi; readonly logger?: Logger; readonly claudeHome?: string; readonly mcsHome?: string;
  readonly dbMode?: 'serve';               // the only mode; read-only CLI access uses the DbReader (6.1), never a context
  readonly processInfo?: Partial<RuntimeProcessInfo>;   // tests: fixed values; server: live getters
}
export function buildInstanceContext(i: BuildContextInput): Promise<InstanceContext>;   // reads instance/task (3.2), resolveConfig (2.3), openInstanceDb (03), createQueries (03); throws McsError with the 4.1 exit mapping

// packages/engine/src/runtime/instance-runtime.ts
export interface RuntimeComponent { readonly name: string; start(): Promise<void> | void; stop(deadlineMs: number): Promise<void> | void }
export interface InstanceRuntime {
  start(): Promise<void>;                                                 // idempotent; second call is a no-op
  stop(deadlineMs: number): Promise<{ completed: boolean; pendingComponent: string | null }>;   // deadlineMs = absolute clock.now() value
  ingestUntilIdle(o: { timeoutMs: number }): Promise<{ idle: boolean; waitedMs: number; stats: IngestStats }>;
  ingestReplay(fromSegment: string | null): Promise<{ segments: number }>;   // control op 4.3; 02 replaySpool
  health(): HealthReport;                                                 // = ctx.queries.health(ctx.scope) (03 6.2)
  readonly panels: PanelService;                                          // 06 createPanelService(ctx); the panels route uses it
}
export function createInstanceRuntime(ctx: InstanceContext): InstanceRuntime;
```
Components and their owners (created by `createInstanceRuntime` in this order; started in this order; stopped in reverse order):

| # | Component | Factory (owner) | Start | Stop |
|---|---|---|---|---|
| 1 | ingest service | `createIngestService(ctx) -> { start, stop, untilIdle, replay, stats }` (02, `engine/src/ingest/service.ts`) | drain the spool from stored cursors, start discovery and the scheduler (02 2.7, 5.4) | finish the current batch, persist cursors (02 4.6) |
| 2 | lifecycle sweeper | `createLifecycleSweeper(ctx) -> { start, stop, tick }` (02 7.8) | timer every `lifecycle.sweepIntervalMs` | clear the timer, await a running tick |
| 3 | maintenance scheduler | `createMaintenanceScheduler(ctx) -> RuntimeComponent` (03 11.4: liveness mark, health refresh, alert sweep, announcements, WAL checkpoint, optimize, bookkeeping retention) | timers of 03 11.4 | clear timers, await a running job |
| 4 | panel service | `createPanelService(ctx)` (06 3.2) | nothing (panels sample on request) | abort in-flight sources (`SourceCache.abort`) |
| 5 | state watchdog | `createStateWatchdog(ctx, { stateFileBytes })` (01, `runtime/state-watchdog.ts`) | timer every `process.stateWatchdogMs` (4.6) | clear the timer |
| 6 | route file | `writeRouteFile` (02 2.6.2) called by `start()` with `stoppedAt: null` after the transcripts folder is resolved | - | the main writes `stoppedAt: now` in 4.5 step 5 |

Algorithms:
- `start()`: for each component in order `await c.start()`; a failure stops the already started ones in reverse order (deadline
  `clock.now() + 2000`) and rethrows (boot exit 70). Then `writeRouteFile`.
- `stop(deadlineMs)`: for each started component in reverse order, `await Promise.race([c.stop(deadlineMs), sleepUntil(deadlineMs)])`;
  the first component that misses the deadline is returned as `pendingComponent` and the remaining ones still get `stop` called without
  waiting. Errors are logged (`component_stop_failed`, component name only) and never thrown. The DB is closed by the caller (4.5 step 4),
  not by the runtime.
- `ingestUntilIdle({timeoutMs})`: loop until `timeoutMs` elapsed: `await ingest.untilIdle(remaining)` (02 defines idle: every spool
  segment cursor at its size, no P0..P3 work queued, the writer queue empty); then `await sweeper.tick()` once (derives that became due);
  then `ingest.untilIdle(0)` must still be true, else loop. Returns `idle: false` on timeout (never throws); `stats` = `ingest.stats()`.
- `health()`: delegates to 03; 03 reads `ctx.process` (pid, uptime, outdated, `previousRunUnclean`, ownership conflict), `ctx.errors`,
  `ctx.exec.childStats()` (`HealthReport.children`, I-21) and `runtime.panels.stats()` (`HealthReport.panels`, I-21) through the deps
  passed to `createQueries`. `deps.process` is optional: the DbReader (stopped instance, 6.1) has none and reports those fields as absent.

Tests that prove 4.4a (slice S8): `instance-runtime.test.ts` (unit, fake components): start order, reverse stop order, a component that
throws in `start` stops the earlier ones, a component that hangs in `stop` is reported as `pendingComponent` and the later ones still
stop; `ingest-until-idle.int.test.ts` (integration, real engine on a testkit workspace and Claude home): returns `idle: true` after
the fixture is fully imported and `idle: false` within `timeoutMs + 200 ms` when a fake producer keeps appending; `context.test.ts`:
`buildInstanceContext` maps identity, config and DB failures to the 4.1 exit names, and `ctx.queries` returns the same `instanceId` as
`ctx.instanceId`.

### 4.5 Graceful shutdown (control `shutdown`, `SIGINT`, `SIGTERM`, `SIGBREAK`, `SIGHUP`)
Deadline `server.shutdownGraceMs` (default 5000) from the first trigger; a second trigger is ignored.
1. Phase := `stopping`; `identify` keeps answering with phase `stopping`.
2. Stop accepting HTTP connections (`server.close()`), end SSE streams (API design decides whether a final `reset` is sent).
3. `await runtime.stop(deadline)` (4.4a: watchdog, panels, maintenance timers, sweeper, then ingestion after its current batch with
   spool offsets persisted).
4. DB: `PRAGMA wal_checkpoint(TRUNCATE)` then close (data design function `closeInstanceDb`).
5. `compareAndDelete(state.json, <bytes we wrote>)`; delete `run/control.token`; rewrite the route file with `stoppedAt: now` (02).
6. Close the control channel; exit 0.
If the deadline passes: log `shutdown deadline exceeded at step N`, exit 0 (the DB is WAL-safe; the next boot recovers).
Windows note (E3): `process.kill(pid, 'SIGTERM')` and `taskkill /F` terminate immediately without running any handler; plain `taskkill`
fails for a console-less process ("can only be terminated forcefully"). Hence the control channel is the graceful path on Windows;
signals cover POSIX and a foreground `serve` (Ctrl+C = SIGINT, Ctrl+Break = SIGBREAK, console close = SIGHUP).

### 4.6 `state.json` lifecycle
- Written once at boot (4.4 step 10) with the retry rule (1.2).
- Watchdog every `process.stateWatchdogMs` (15 s): read the file; if absent, or unparsable, or naming a dead pid, rewrite ours
  (log `state_file_restored`). If it names a live process that is not us, do not touch it (log `ownership_conflict`, health flag).
  This repairs the cross-engine case where the legacy `$V stop` deletes the file of a Node runtime (research F.5, T-XE-04).
  The watchdog writes only on these conditions, never periodically (legacy CLI readers do not retry, E5).
- Removed at graceful shutdown (compare-and-delete). After a crash it stays: the next `start`/`status`/`stop` treats it as stale only
  after verifying the pid (4.8). The next boot overwrites it.

### 4.7 `start` (`ops.lifecycle.start`)
Input: workspace (or the `default` workspace, 6.2), CLI overrides, `--open`, `--timeout-ms`.
1. Launcher has ensured the build is current (5.1).
2. `resolveWorkspace`; no `task.json` -> `TASK_NOT_FOUND` with hint `mcs init --task <slug>` (exception: the `default` workspace is
   created on demand, 6.2); `task.json` present but `instance.json` missing (a legacy workspace) -> adopt it exactly like `init` reuse
   (4.12 step 4: creates `instance.json`, `data/`, `logs/`; never touches legacy files; audit `adopt-instance`) and print
   `added Node runtime files: instance.json`. Adoption is new Node-owned files only, not a configuration migration (INV-08).
3. `instance.json.engine === 'legacy'` -> delegate `start` to `$V` (6.5) and return its exit code.
4. `resolveConfig` -> on failure print the problems, exit 1 (nothing spawned; legacy "validates config before spawning").
5. DB version peek (data design `peekDbSchemaVersion(path)`; read-only, no lock needed): newer -> `DB_NEWER_THAN_RUNTIME`; older ->
   `DB_UPGRADE_REQUIRED` with hint `mcs upgrade --task <slug> --restart` (explicit upgrades, D13).
6. `probeInstance(ws)` (4.8):
   - `running` -> print `already running: <url> (pid N)` exit 0 (legacy text).
   - `starting` (another start in progress) -> wait (step 9 loop on that pid) and report its outcome.
   - `unhealthy` (control answers, HTTP does not within the start timeout) -> exit 1 `START_FAILED` "runtime pid N answers its control
     channel but not HTTP; run `mcs doctor --task <slug>` or `mcs restart --task <slug>`".
   - `legacy-running` -> print `already running (engine=legacy): <url> (pid N)` + hint "to switch engines: mcs stop --task <slug> &&
     mcs start --task <slug>"; exit 0; nothing started (D12).
   - `stale`, `stopped`, `foreign-pid` -> continue (the server overwrites a stale `state.json`).
7. Rotate `logs/boot.log` -> `boot.log.1`; open `boot.log` (`w`) and pass its fd as stdout and stderr.
8. `spawnDetached(process.execPath, [serverMain, 'serve', '--mcs-instance=' + id, '--instance-dir=' + dir, ...overrides], { cwd: dir,
   env: { ...process.env, MCS_HOOK_DISABLE: '1' } })`; keep the `ChildProcess` reference (listen to `exit`); close our copy of the fd.
9. Wait up to `process.startTimeoutMs` (CLI `--timeout-ms` wins), polling every 100 ms:
   - child exited -> map the exit code (4.1); `12` -> re-probe and report like step 6 (a concurrent start won, T-ISO-19); other codes ->
     print `ERROR: runtime exited during start (<NAME>)` + the last 20 lines of `boot.log` (our own messages only) + hint
     `mcs doctor --task <slug>`; exit 1.
   - `identify` answers with our child's pid and phase `ready` -> `GET <url>/api/v3/health` (2 s timeout, Host `127.0.0.1:<port>`) returns
     200 with our `instanceId` -> read back `state.json` and require pid/port to match -> success.
10. Success: `child.unref()`; print `started: <url> (pid N)` (legacy text); `--open` -> open the URL (`execFileText` kind `'opener'`, 4.2:
    `explorer.exe <url>` on Windows, `open` on macOS, `xdg-open` elsewhere; URL validated `^http://127\.0\.0\.1:\d+$`; a failed open
    prints `warning: could not open a browser; open <url>` and keeps exit 0); exit 0.
11. Timeout: we hold the child handle, so the process is ours with certainty: `forceKill(child.pid)`, wait 5 s, compare-and-delete a
    `state.json` naming it; print `ERROR: runtime did not become healthy within <s> s; run `mcs doctor --task <slug>`` + boot log tail;
    exit 1. (Legacy left the half-started process running.)
Measured inputs for the budget: a detached Node process reached "pipe + HTTP ready" in 92-98 ms without a framework (E3); warm loads
of zod 45 ms, express 60 ms, better-sqlite3 3 ms (E9), cold first load of zod 378 ms; default 20 s leaves room for a cold disk and
antivirus scans (legacy used 12 s).

### 4.8 `probeInstance(ws)`: liveness classification
```ts
export type ProbeState = 'running' | 'starting' | 'stopping' | 'unhealthy' | 'stopped' | 'stale' | 'foreign-pid' | 'legacy-running' | 'legacy-stale';
export interface ProbeResult { state: ProbeState; engine: 'node' | 'legacy' | null; pid: number | null; url: string | null; port: number | null;
  identity: ControlResponse | null; stateFile: StateFile | null; stateFileBytes: Uint8Array | null; reason: string }
export function probeInstance(ws: WorkspaceRef, o?: { httpTimeoutMs?: number /* 2000 */; controlTimeoutMs?: number /* 2000 */ }): Promise<ProbeResult>;
```
Algorithm (fast path first; no PowerShell unless needed):
1. Read `state.json` (tolerant parse) and `instance.json` (if present).
2. If `instance.json` exists: `identify` over the control channel.
   - answers with our `instanceId`: phase `ready` -> HTTP health (must return 200 + same `instanceId`) -> `running`, else `unhealthy`;
     phase `starting` -> `starting`; phase `stopping` -> `stopping` (`stop` waits for the exit; `start` waits for the exit, then
     re-probes and starts).
   - answers with another `instanceId`: impossible by construction (the name contains the id); `unhealthy` with that reason.
   - connect fails with `ENOENT` (Windows, Linux abstract) or `ECONNREFUSED` (socket file without listener): nobody holds the lock ->
     continue with step 3.
   - connected but no valid reply within `controlTimeoutMs`, or the connection is reset: a runtime holds the lock but is hung ->
     `unhealthy`; `pid` = `state.json.pid` when its `instanceId` matches, else the pid found by `listRuntimeProcesses(runtimeDir)`
     with this `instanceId` (one CIM query), else `null` (then `stop` reports `STOP_FAILED` "hung runtime without a known pid; run
     `mcs doctor`").
3. No state file -> `stopped`.
4. State file engine `node` (no control answer): `pidAlive(pid)` false -> `stale`; true -> `foreign-pid` (pid reused by another
   process; the lock is free so it cannot be our runtime; no command-line query needed).
5. State file engine `legacy`: `pidAlive(pid)` false -> `legacy-stale`; true -> `GET <url>/api/health` (3 s) returning the same `pid`
   -> `legacy-running`; otherwise `legacy-stale` (legacy `instance_alive` rule: stale files are never trusted).
Note: the command line is not needed to classify; it is needed only to kill (4.9).

### 4.9 `stop` (`ops.lifecycle.stop`)
1. `resolveWorkspace`; `probeInstance`.
2. By state:
   - `stopped` -> `nothing to stop (no state file <path>)` exit 0 (legacy text).
   - `stale` / `legacy-stale` / `foreign-pid` -> `compareAndDelete(state.json, probe.stateFileBytes)`; print `pid N is not this
     instance's runtime (already stopped or pid reused); removed the stale state file, nothing was killed` exit 0.
   - `stopping` (Node): skip the request; `waitForExit(pid, process.stopTimeoutMs)` and continue as below from "Exited".
   - `running` / `starting` / `unhealthy` (Node): read `run/control.token`; send `shutdown{reason:'stop'}` (a hung runtime goes
     straight to the forced path); then
     `waitForExit(pid, process.stopTimeoutMs)`.
     - Exited -> verify `state.json` no longer names that pid (compare-and-delete if it does) -> print `stopped runtime pid N (<url>)`
       exit 0.
     - Shutdown rejected, token missing, control silent, or still alive at the deadline -> forced path: `commandLineOf(pid)` must
       contain the runtime marker with this `instanceId` (`hasRuntimeMarker`, 4.1/4.2) -> `forceKill(pid)`; `waitForExit(pid, 5000)`; compare-and-delete
       `state.json` and the token; rewrite the route file with `stoppedAt: now` (02: `mcs stop` may kill without the server's shutdown path);
       print `stopped runtime pid N (<url>) (forced: <reason>)` exit 0. Marker absent -> do not kill; print
       `ERROR: pid N does not carry this instance's runtime marker; nothing was killed` exit 1 (`NOT_OUR_PROCESS`). Still alive after
       the kill -> `ERROR: pid N still alive after stop request` exit 1 (`STOP_FAILED`, legacy text).
   - `legacy-running` -> legacy behaviour: `hasLegacyMarker(commandLineOf(pid))` (`viewer.py`) -> `forceKill`, wait 5 s, remove `state.json`,
     print `stopped viewer pid N (<url>)` exit 0; marker absent -> stale message above.
3. `stop` never touches another workspace's files or processes (INV-04, INV-05).
Cost: the graceful path needs no PowerShell (about 60 ms, E3); the forced path costs one CIM query (0.27-0.54 s, E2).

### 4.10 `restart`, `status`, `verify`, `serve`
- `restart` = `stop` then, only if it succeeded, `start` with the same options (legacy). `--restart` on `upgrade` reuses this.
- `status` (`ops.lifecycle.status`): `probeInstance`; when `running`, `GET /api/v3/health` (+ `/api/v3/overview` for counts; API design).
  Output (JSON by default, legacy keys first, then new keys; exit 0 iff running):
  ```ts
  export interface StatusReport {
    running: boolean; state_file: string;                                    // legacy
    url?: string; pid?: number; uptime_s?: number; code_stamp?: string; outdated?: boolean; task?: { id: string; name: string; description: string } | null;
    config_source?: 'task'; recent_errors?: { at: string; where: string; message: string }[]; reader?: unknown;   // reader = ingestion summary (API design)
    sessions?: { RUNNING: number; IDLE: number; COMPLETED: number; FAILED: number; UNKNOWN: number };               // legacy vocabulary derived per D9
    partial_sessions?: number; newest_session_age_s?: number | null; stale_state_file?: StateFile; hint?: string;
    engine: 'node' | 'legacy' | null; probe: ProbeState; instance_id: string | null; runtime_version?: string;
    outdated_reason?: 'code_stamp_changed' | 'runtime_version_changed' | null; db_schema_version?: number; ingestion?: { status: string; reasons: string[] };
  }
  ```
  `outdated` = running `codeStamp` (from `identify`) != current `runtime/.mcs-build.json` codeStamp. Hint when outdated (adapted legacy
  text): `the runtime code changed since this instance started: run `mcs restart --task <slug>` (or `mcs upgrade --task <slug> --restart`
  when the database needs an upgrade)`. For `legacy-running` the command delegates to `$V status` (6.5); without Python it prints the
  subset derivable from `state.json` + `/api/health`.
- `verify` (`ops.lifecycle.verify`): requires `running`; fetches `/api/v3/health`, `/api/v3/instance`, `/api/v3/sessions?limit=1`,
  `/api/v3/overview` (5 s each) and the compatibility `/api/health`; validates each body with the shared Zod response schemas and
  checks `instanceId` equality; prints `verified <url>: health, instance, sessions (<N>), overview all valid` (N = total from the
  sessions page) exit 0; else `ERROR: <endpoint>: <problem>; ...` exit 1. Legacy engine -> delegate.
- `serve` (foreground): `spawnForeground(process.execPath, [serverMain, 'serve', ...same argv as 4.7])` so the process carries the
  runtime marker; the CLI forwards SIGINT/SIGBREAK/SIGHUP to the child by sending the control `shutdown` (the child also receives the
  console's Ctrl+C itself); exit code = child exit code mapped (0 -> 0, others -> 1 with the 4.1 name printed). `--state-file` (legacy
  flag) is accepted and ignored with `warning: --state-file is ignored by the Node runtime (it always uses <ws>/state.json)`. Before
  spawning, `probeInstance` must not be `running`/`starting`/`legacy-running` (else `INSTANCE_RUNNING`, exit 1).

### 4.11 Port selection and races
- Base = `effectivePort` (2.1); candidates `base .. min(65535, base + server.portScan)` in order; `listen(port, '127.0.0.1')`;
  `EADDRINUSE` or `EACCES` (Windows excluded port ranges) -> next; other errors -> exit 13 with the error code.
- The bind is the reservation: no port file, no pre-check. Two instances with the same base port race at the OS and end on distinct
  ports (E4: same-address binds are exclusive between Node processes and between Node and the legacy Python viewer in both orders).
- Quirk (E4): a foreign process listening on `0.0.0.0:<port>` does not block our `127.0.0.1:<port>` bind; loopback clients then reach
  our server (more specific binding). Documented; no action.
- `state.json` is written only after the bind (4.4), so a reader never sees a port that is not ours.
- Test port ranges (design 05): real-process integration and isolation tests 18000-18499, UI E2E 18500-18599 (`04-ui.md`), Python parity 18850-18874.

### 4.12 `init` transaction, adoption and partial-init cleanup (`ops.workspace.init`)
Inputs: `name`, `slug?`, `description?`, `port?`, `seedConfig?` (path, `--config` on `init` only), `engine?` (default `node`).
1. Validate: slug (3.1) from `--slug` or `slugify(name)`; seed file read (PyJson), keys restricted to L keys (unknown keys -> refuse
   listing them), `schema_version` absent or 1; `port` 1..65535; build the candidate `config.json` = `{"schema_version": 1, "title":
   name or slug}` + seed keys (seed `title` wins) + `port`; validate strict + translate regexes (2.4, 2.8). Nothing is created on failure.
2. Ensure the tasks root exists (`mkdir -p`); take the task mutex for `realpath(root) + '/' + slug`.
3. Cleanup of old staging folders in the root: names `^\.init-[a-z0-9-]+-(\d+)-[0-9a-f]{8}$` whose pid is not alive and mtime older
   than 10 minutes are removed (only these names, only inside the root, never following links).
4. Existing workspace (`<root>/<slug>/task.json` exists): reuse.
   - `task.json.id !== slug` -> `IDENTITY_MISMATCH`.
   - Seed options given: if the existing `config.json` already contains exactly the requested keys/values (pyEquals) -> fine; else
     `WORKSPACE_EXISTS_CONFIG_DIFFERS` exit 1 with hint `use mcs configure --task <slug>` (never silently ignored, never overwritten).
   - `instance.json` missing -> adopt: create `instance.json` (atomic), `data/`, `logs/`, `audit/` if missing; audit `adopt-instance`.
   - Print `reused (nothing overwritten) task '<slug>' at <dir>` (legacy text) + `added Node runtime files: instance.json` when adopted.
5. New workspace: staging folder `<root>/.init-<slug>-<pid>-<rand8>/`; write `task.json`, `config.json`, `README.md`, `instance.json`,
   `audit/changes.md` (entry `init-task`), create `data/` and `logs/`.
6. `fs.renameSync(staging, <root>/<slug>)` with retry on `EPERM`/`EBUSY` up to 2 s (E5: renaming a folder that contains an open file
   fails with EPERM; antivirus scanners open new files). If the target appeared meanwhile (another init won; E5: renaming onto an
   existing folder fails with EPERM on Windows, even when empty) -> remove our staging folder (it is ours: unique name) and go to step 4.
   On POSIX `rename` onto an existing empty folder succeeds: step 6 first checks `!existsSync(target)` (a leftover empty folder has
   no `task.json` and is replaced harmlessly).
7. Read back `task.json`, `config.json`, `instance.json`; validate; print `created task '<slug>' at <dir>` (legacy text) exit 0.
Crash between 5 and 6 leaves only a dot-prefixed staging folder that neither engine lists (legacy `list_tasks` requires the slug
pattern) and that step 3 or `cleanup --scope init-leftovers` removes.

### 4.13 Crash recovery

| Situation | Detection | Recovery |
|---|---|---|
| runtime killed (`taskkill /F`, crash, power loss) | `state.json` present, pid dead or reused, control channel free | `start` proceeds; server overwrites `state.json`; DB WAL recovery is automatic; spool replay from stored offsets (ingestion design); boot logs `previous run ended without a clean shutdown` and health exposes `previousRunUnclean: true` |
| crash during boot | `start` sees the child exit code (4.1) | message + boot log tail; nothing else to clean (token/state are written only at step 10) |
| crash during `init` | dot-prefixed staging folder | removed later (4.12 step 3) |
| crash during an atomic write | stray `*.tmp` beside the target | target untouched; `cleanup --scope stale-state` removes `*.tmp` older than 10 min |
| crash during `upgrade` | backup present, audit has no `upgrade` entry | `mcs upgrade` again (idempotent: migrations record their version); or `backup restore` |
| hung runtime (control silent, pid alive) | `probeInstance` -> `unhealthy` or forced path | `stop` uses the forced path after verifying the command line |

### 4.14 Cross-engine ownership rules (Node runtime vs legacy `viewer.py` on the same workspace)

| Situation | `$MCS` behaviour | `$V` behaviour (unchanged) | Result |
|---|---|---|---|
| Node runtime running; `$MCS start` | `already running: <url> (pid N)` | - | one runtime |
| legacy viewer running; `$MCS start` | `already running (engine=legacy)`; nothing started | - | one viewer |
| Node runtime running; `$V start` | - | `instance_alive`: pid alive and `/api/health` returns the same `pid` -> `already running` (needs C-4) | one runtime |
| Node runtime running; `$V stop` | - | no `viewer.py` in the command line -> deletes `state.json`, kills nothing | Node watchdog restores `state.json` within 15 s (4.6); `$MCS status` works throughout (control channel) |
| legacy viewer running; `$MCS stop` | kills it after the `viewer.py` check (legacy rule) | - | stopped |
| `$V serve` started by hand while Node runs | - | binds the next port, writes `state.json` (no checks in legacy `serve`) | Node watchdog sees a live foreign owner and does not overwrite; health flags `ownership_conflict`; `$MCS doctor` reports it; user stops one |
| `instance.json.engine = legacy` | `start`/`stop`/`status`/`verify`/`restart` delegate to `$V` (6.5) | - | rollback path |
| Node writes `config.json` | PyJson (byte-compatible) | legacy reads it normally | T-XE-01/02 |
| legacy `configure` of task B while Node runtime A runs | - | isolation snapshot hashes A's DB/logs/spool -> may report a false "isolation violated" and is slow on big DBs | CHALLENGE C-2 |
| legacy `audit` / `doctor` on a Node workspace | - | flags `*.jsonl` files; Node writes none (spool `*.ndjson`, I-02) | passes (T-XE-06) |

### 4.15 Windows specifics (summary of evidence)
- Detached spawn: `detached:true` + `windowsHide:true` + stdio ignore or file fds -> process survives the launching shell and CLI
  (E1 variants A, C, A2), has no console (`AttachConsole` fails with ERROR_INVALID_HANDLE, `MainWindowHandle` 0) and its
  `windowsHide:true` grandchildren have no console window (`GetConsoleWindow()` = 0). Non-detached children are killed when the parent
  exits (E1 variant B: libuv's kill-on-close job object).
- libuv puts a Node process into its own job object as soon as it spawns a non-detached child (E1); a CLI in that state can still
  spawn a detached server that outlives it (E1 variant A2), because libuv's job allows silent breakaway.
- No `wmic` on this Windows 11 build; PowerShell 5.1 CIM query 0.27-0.54 s, PowerShell 7 0.32-0.52 s, `tasklist` 0.07-0.11 s but
  image name only (E2). Windows PowerShell 5.1 (`powershell.exe`) is used because it ships with Windows.
- Graceful stop needs the control channel (E3). Same-address TCP binds are exclusive (E4). Replace-by-rename fails while any process
  holds the target open, so writers and readers retry (E5). A loaded native addon cannot be deleted (E11), so `npm ci` refuses to run
  while runtimes of the same install are alive (5.2).

### 4.16 Tests that prove section 4

| Id | Test | Project |
|---|---|---|
| T-LC-01 | `start` -> `status` (running, pid, url) -> `start` again (`already running`) -> `verify` -> `stop` (graceful; `run/control.token` and `state.json` gone; boot log has `runtime ready`) | integration |
| T-LC-02 | `start` with an invalid regex in `config.json`: exit 1, problems printed, no process spawned (`listRuntimeProcesses` empty), no `boot.log` | integration |
| T-LC-03 | boot exit codes: craft each failure (identity, locked, port range fully occupied by test listeners, DB newer, DB older, missing build stamp) and assert the code and the `start` message | integration |
| T-LC-04 | control channel: `identify` without token works; `shutdown` with wrong token -> FORBIDDEN and process alive; with wrong instanceId -> INSTANCE_MISMATCH | integration |
| T-LC-05 | graceful shutdown runs steps 1-6 within `shutdownGraceMs` (log lines in order); DB `-wal` truncated | integration |
| T-LC-06 | forced path: make the server ignore control (test hook env `MCS_TEST_IGNORE_CONTROL=1`, compiled only in test builds) -> `stop` verifies the marker and kills; with an impostor pid lacking the marker -> exit 1, impostor alive | resilience |
| T-LC-07 | `state.json` watchdog: delete the file while running -> restored within `stateWatchdogMs + 1 s`; replace it with a live impostor's data -> not overwritten, health shows `ownership_conflict` | integration |
| T-LC-08 | `start` timeout: server stub that never becomes ready (`MCS_TEST_BOOT_HANG=1`) -> exit 1 after the timeout, child killed, no `state.json` left | resilience |
| T-LC-09 | port: occupy base and base+1 with test listeners -> server binds base+2; occupy the whole range -> exit 13 | integration |
| T-LC-10 | init transaction: kill the CLI between staging and rename (test hook `MCS_TEST_INIT_CRASH=before-rename`) -> no workspace, staging folder present; next `init` removes it (after backdating its mtime) and succeeds | resilience |
| T-LC-11 | concurrent `init` of the same slug from 4 processes -> one `created`, three `reused`, one audit `init-task` entry | resilience |
| T-LC-12 | adoption of a legacy-created workspace (fixture made by `$V init-task`, checked in), once through `init` and once through `start` -> `instance.json` created, legacy files byte-equal, audit `adopt-instance` appended once, no `runtime.json` created | integration |
| T-LC-13 | Windows only: the running server has no console and its children have none (PowerShell probe as in E1, run against the test server) | resilience |
| T-LC-14 | crash recovery: `forceKill` during ingestion, `start` again -> health `previousRunUnclean: true`, integrity ok, no duplicate events after spool replay | resilience |
| T-LC-15 | `serve` foreground: Ctrl+C equivalent (send SIGINT to the child on POSIX; control shutdown on Windows) -> exit 0, files cleaned | integration |
| T-LC-16 | lint/grep: only `platform/exec.ts` imports `node:child_process`; every spawn call passes `windowsHide: true` (AST rule) | unit |

---

## 5. Launcher, versions, upgrade and rollback

### 5.1 Launcher `scripts/mcs.mjs` (ADR 0007)
Plain ESM, zero dependencies, no build step, `#!/usr/bin/env node`. It is the only documented entry point (`$MCS`, D6).
Algorithm:
1. Node floor: `process.versions.node` >= `22.22.0` else `ERROR: Node >= 22.22.0 is required (found <v>); install the Node 24 LTS`
   exit 1 (`NODE_TOO_OLD`). One floor for running and building (I-05): the launcher builds the web package on the user's machine and
   React Router 8.4.0 declares `engines.node >= 22.22.0` (design 05 C-1, evidence `npm view react-router@8.4.0 engines`; the scaffold's root `engines` field is
   `^22.22.0 || ^24.0.0 || >=26.0.0`); there is
   no warning branch. The lead annotates D7 ("Node floor 22.12") accordingly.
2. Paths: `skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')`, `runtimeDir = join(skillDir, 'runtime')`,
   `cliMain = join(runtimeDir, 'packages/cli/dist/main.js')`.
3. `mcs --version` / `mcs version --short`: answered from `runtime/package.json` `version` without building (prints `mcs <version>`).
4. Staleness: `const { staleness } = await import(pathToFileURL(join(runtimeDir, 'scripts/build-stamp.mjs')))` (owned by 05; about
   10 ms, E9). `{install, build}` both false -> step 7.
5. `MCS_LAUNCHER_NO_BOOTSTRAP=1` -> `ERROR: runtime build is stale (<reasons>); run `npm ci && npm run build` in <runtimeDir>` exit 1.
6. Bootstrap:
   a. `acquireMutex(mutexName('bootstrap', realpath(runtimeDir)), {timeoutMs: 15 * 60_000})`, printing
      `mcs: waiting for another bootstrap to finish (<s> s)` to stderr every 10 s. After acquiring, call `staleness()` again (the other
      process may have finished the work) and skip what is no longer needed.
   b. Guard for `npm ci` (only when `install` is needed): `listRuntimeProcesses(runtimeDir)` (4.2); any result -> release the mutex,
      print `ERROR: runtime dependencies must be reinstalled, but runtimes of this skill install are running (they hold native files
      open): <slug> pid N (<instance dir>), ...; stop them with `mcs stop --task <slug> --repo <repo>` and retry` exit 1
      (`RUNTIME_IN_USE`). Evidence E11: a loaded `better_sqlite3.node` cannot be deleted, and `npm ci` deletes `node_modules`; a failed
      `npm ci` would leave a broken install for every instance.
   c. npm resolution: `npm_execpath` when it ends with `npm-cli.js`; else `<dirname(execPath)>/node_modules/npm/bin/npm-cli.js`
      (Windows layout, present here); else `<dirname(execPath)>/../lib/node_modules/npm/bin/npm-cli.js` (POSIX layout); none ->
      `BOOTSTRAP_FAILED` "npm not found next to node". Never spawn `npm.cmd` (E9: `spawn('npm.cmd')` without a shell fails with EINVAL on
      Node 24; a shell is not used).
   d. Run `node <npm-cli.js> ci --no-audit --no-fund` (when `install`), then `node <npm-cli.js> run build` (when `build`; the build
      script writes the build stamp, 05) with `cwd: runtimeDir`, `windowsHide: true`, stdout/stderr appended to
      `runtime/.mcs-bootstrap.log` (git-ignored), env `{...process.env, MCS_HOOK_DISABLE: '1'}`. Progress lines on stderr:
      `mcs: installing runtime dependencies (npm ci) ...` / `... done in 9.7 s`, `mcs: building runtime ...`.
   e. Install success -> `node runtime/scripts/build-stamp.mjs write-install`. Any non-zero exit -> `ERROR: runtime bootstrap failed
      (<step> exited <code>); see runtime/.mcs-bootstrap.log` exit 1 (`BOOTSTRAP_FAILED`).
   f. Verify: `staleness()` is false and `cliMain` exists, else `BOOTSTRAP_FAILED`. Release the mutex. After a build print
      `mcs: runtime <version> built (code <codeStamp>); running instances keep their loaded code until restarted (see mcs status)`.
7. Run the CLI in-process: `const { main } = await import(pathToFileURL(cliMain).href); process.exitCode = await main(process.argv.slice(2),
   { launcherPath, skillDir, runtimeDir })`. In-process import avoids a second Node start (67 ms bare start, research 8.1) and keeps the
   terminal (TTY, Ctrl+C).
8. Unexpected exceptions in the launcher: `ERROR: internal launcher error: <message>` exit 1 (stack with `MCS_DEBUG=1`).
The launcher never reads or writes workspaces (T-ISO-25) and never runs `npm install` (lockfile is authoritative, `.npmrc`
`ignore-scripts=true`, `save-exact=true`, D6).
Zero-dependency copies (I-24): the launcher cannot import `@mcs/engine` before the build exists, so `scripts/mcs.mjs` carries its own
copies of (a) `tryAcquireMutex`/`acquireMutex`/`mutexName` (Windows named pipe, Linux abstract socket, lock-file fallback; same names
and same `mutexName('bootstrap', realpath(runtimeDir))` key, so the launcher and any engine code exclude each other), (b) the runtime
listing of 4.2 (`listRuntimeProcesses`, constant `-EncodedCommand` script) and (c) a minimal `spawn` wrapper with `shell:false`,
`windowsHide:true` (the only spawns: `node <npm-cli.js>` and `node build-stamp.mjs`). A unit test (`launcher-parity.test.ts`, S10)
asserts that the launcher's `mutexName` and marker filter give the same results as `platform/mutex.ts` and `platform/markers.ts` on a
table of inputs.

### 5.2 Stamps and versions

| Identifier | Source of truth | Format | Where reported |
|---|---|---|---|
| `RUNTIME_VERSION` | `runtime/package.json` `version` (`3.0.0` in the scaffold); `@mcs/shared/version.ts` exports the same constant; a unit test asserts equality | semver | `mcs version`, `state.json.version/runtimeVersion`, health, `instance.json.runtimeVersion` |
| build stamp / `codeStamp` | `runtime/.mcs-build.json` written by `npm run build` (05 owns the hash inputs: lockfile, tsconfigs, package manifests, production sources) | `buildStamp` sha256, `codeStamp` = first 10 hex | `state.json.codeStamp`, health, `identify`, `status.code_stamp` |
| install stamp | `runtime/node_modules/.mcs-install.json` (05) | `<platform>-<arch>-node<major>:<sha256>` | launcher only |
| DB schema version | the DB (data design) | integer | `instance.json.dbSchemaVersion` (mirror), health, `status.db_schema_version` |
| file schema versions | each JSON file's `schema_version` | integer | `inspect.files[]` |

The legacy `code_stamp` (sha1 of `src/backend/*.py` + defaults) and the Node `codeStamp` are not comparable (research C.10); `$MCS status`
against a legacy viewer reports the legacy value as `code_stamp` and `outdated` from `$V status`.

`mcs version [--json]`: text `mcs 3.0.0 (code a1b2c3d4e5, node v24.14.1, build current)`; JSON `{ runtimeVersion, codeStamp, buildCurrent,
node, platform, arch, legacyEngine: { python: string | null, version: '2.0.2' | null } }` (legacy version read from
`src/backend/__init__.py` by regex, no Python needed).

### 5.3 Outdated detection
- Server: re-reads `runtime/.mcs-build.json` at most every 10 s when health is requested; `outdated = disk.codeStamp !== bootCodeStamp`,
  `outdated_reason = disk.runtimeVersion !== RUNTIME_VERSION ? 'runtime_version_changed' : 'code_stamp_changed'`; exposed in health
  (`04-ui.md` `HealthReport.runtime.outdated`).
- CLI `status`/`instances list`: `identify.codeStamp` vs disk; same rule.
- Frontend changes are part of the build (unlike legacy, where the UI was served from disk), so any UI change also needs a restart; the
  server serves its in-memory copy until then (4.4 step 8).

### 5.4 Upgrade (`mcs upgrade --task S [--dry-run] [--yes] [--restart]`) and `mcs db migrate`
Preconditions: launcher bootstrap done (current build). Algorithm (`ops.upgrade.run`):
1. Resolve workspace; take the task mutex; read `instance.json` (adopt is not implicit: missing -> `INSTANCE_NOT_INITIALIZED`).
2. Version gates (5.7): `instance.runtimeVersion > RUNTIME_VERSION` -> `DOWNGRADE_REFUSED`; DB newer -> `DB_NEWER_THAN_RUNTIME`.
3. Plan: DB migrations pending (data design `planDbMigrations(path) -> {from, to, steps[]}`), file migrations pending (2.7), version
   stamp change. Nothing pending and versions equal -> `already current: runtime 3.0.0, db schema N` exit 0.
4. `--dry-run` or no `--yes`: print the plan and the backup that would be made; exit 0.
5. Running instance: without `--restart` -> `INSTANCE_RUNNING` "stop it first or pass --restart"; with `--restart` -> `stop` (4.9),
   continue, `start` at the end.
6. Backup (5.5, reason `upgrade`, DB + Node files). Failure -> abort, nothing changed.
7. DB migrations (data design `migrateDb(path, {backupDone: true})`, transactional per step, checksums verified) -> on failure: stop,
   restore the DB from the backup (5.5 restore procedure, steps 4-6), report `DB_ERROR` with the backup id.
8. File migrations (2.7 step 5 without its own backup).
9. `instance.json`: `runtimeVersion = RUNTIME_VERSION`, `dbSchemaVersion = to`, `upgradedAt = now` (atomic).
10. Audit `upgrade` (7.2). `config.json`, `task.json`, `README.md` and existing audit bytes are never written (INV-09, T-ISO-24).
11. `--restart`: `start`; report its result. Exit 0 only when every step succeeded.
`mcs db migrate --task S [--dry-run] [--yes]` = steps 1-7 and 9-10 without file migrations (the deterministic "run database migrations"
command of the brief section 3; the scaffold's `npm run migrate` maps to it).
`start` never migrates an existing DB (exit 16, D13); it creates a new DB at the current schema.

`mcs db rebuild --task S [--yes] [--confirm S]` (recovery for a corrupt or unwanted database; the runbook command of design 06 7.1,
I-12; it replaces any "reimport" command):
1. Resolve workspace; take the task mutex; the instance must be stopped (`probeInstance` not `running|starting|stopping|unhealthy`,
   else `INSTANCE_RUNNING`); `instance.json.engine` must be `node` (else `ENGINE_CONFLICT`).
2. Plan: the DB files present (`data/monitor.db`, `-wal`, `-shm`) with sizes; what is rebuilt (sessions, events, usage from the transcripts
   inside `import.lookbackHours` or pinned, and from the spool segments still retained, `spool.retainHours`) and what is lost (hook-only
   evidence older than the spool retention, reconciliation records, alert history, the change log; SSE clients get `reset`).
3. Without both `--yes` and `--confirm <slug>`: print the plan and `warning: dry run; pass --yes --confirm <slug> to apply`; exit 0.
4. Create `data/backups/<UTC ts>-db-rebuild.partial/`; rename (same volume, retry rule 1.2) the DB files into it; copy `instance.json`,
   `runtime.json`, `config.json`, `task.json`; write the manifest with `dbCopy: 'raw'`, sha256 per file; rename the folder to its final
   name. A raw move needs no SQLite open, so it works for a corrupt file.
5. `instance.json.dbSchemaVersion = 0` (atomic); audit `db-rebuild` (7.2); print `moved the database to data/backups/<id>; the next
   mcs start creates a new database and re-imports (this can take minutes for large transcripts)`. Exit 0.
`start` afterwards creates a new DB (4.4 step 7) and the ingest service imports from scratch. Restoring the old DB is `backup restore --id
<id>` (5.5 handles `dbCopy: 'raw'`).

### 5.5 Backup and restore
Layout `data/backups/<backupId>/` where `backupId = <UTC yyyymmddThhmmssZ>-<reason>` (`reason` in `manual upgrade config-migrate
pre-restore cleanup db-rebuild`), contents:
```
manifest.json      BackupManifest (below)
monitor.db         SQLite online backup (data design `backupDb(src, dest)`; works while the server runs only through the server, see below);
                   for `dbCopy: 'raw'` (db rebuild) the moved original file, plus `monitor.db-wal` / `monitor.db-shm` when they existed
instance.json, runtime.json (if present), config.json, task.json   copies for reference; config.json/task.json are never restored automatically
```
```ts
export const BackupManifestSchema = z.strictObject({
  schema_version: z.literal(1), backupId: z.string(), instanceId: z.string().regex(UUID_V4_RE), slug: z.string(), createdAt: IsoSecondsZ,
  reason: z.enum(['manual', 'upgrade', 'config-migrate', 'pre-restore', 'cleanup', 'db-rebuild']), runtimeVersion: Semver, dbSchemaVersion: z.number().int().min(0),
  dbCopy: z.enum(['online', 'raw', 'none']),             // 'none' = files-only backup (config migrate)
  files: z.array(z.strictObject({ path: z.string(), bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
```
`mcs backup [create] --task S [--label L]`:
1. Take the task mutex; create `data/backups/<backupId>.partial/` (`dbCopy: 'online'`; a workspace without `data/monitor.db` gives
   `dbCopy: 'none'`).
2. Database copy: instance stopped -> the CLI opens the DB read-only and runs the data design's `backupDb(srcPath, destPath)` (SQLite
   online backup); instance running -> the CLI sends the control op `backup` (4.3) and the server, which owns the only writer
   connection (D10), runs the same `backupDb` on its connection into `destPath`. The HTTP API stays read-only and the CLI never opens a
   running instance's DB.
3. Copy `instance.json`, `runtime.json`, `config.json`, `task.json`; sha256 every file; write `manifest.json` last; rename the folder to
   `<backupId>` (a folder without a manifest, or still named `.partial`, is incomplete and ignored by `list`/`restore`).
4. Prune backups beyond `backup.keep`, oldest first, never deleting the newest `upgrade` or the newest `db-rebuild` backup; audit `backup`.
`mcs backup list --task S [--json]`: id, reason, created, sizes, runtime/db versions, manifest valid (sha256 re-check with `--verify`).
`mcs backup restore --task S --id ID [--include-runtime-config] --yes`:
1. Instance must be stopped (`INSTANCE_RUNNING`).
2. Manifest valid, sha256 match, `instanceId` equal (`BACKUP_INVALID`); backup `dbSchemaVersion` <= runtime max (else
   `DB_NEWER_THAN_RUNTIME`; restoring an older schema is allowed and will require `upgrade`).
3. Pre-restore backup (reason `pre-restore`).
4. Remove `data/monitor.db-wal` and `data/monitor.db-shm` (a stale WAL must never be applied to the restored file).
5. Copy the backup DB to `data/monitor.db.restore-<rand>.tmp`, then rename over `data/monitor.db` (retry rule 1.2). For `dbCopy: 'raw'`
   the backup's `monitor.db-wal`, when present, is copied to `data/monitor.db-wal` after the rename (it belongs to that file and holds
   committed pages); `dbCopy: 'none'` -> `BACKUP_INVALID` "backup <id> holds no database".
6. With `--include-runtime-config`: restore `runtime.json` (or delete it when absent in the backup) and the `engine`/`hooks` fields of
   `instance.json`; `config.json`, `task.json`, audit are never restored (user-owned; the copies stay in the backup for manual use).
7. Update `instance.json.dbSchemaVersion`; audit `backup-restore`; print the follow-up (`mcs upgrade --task S` when the restored DB
   is older than the runtime).

### 5.6 Rollback procedure (documented in `docs/operations.md` and `docs/migration.md`)
Three levels, cheapest first:
1. Engine fallback (no data risk): `mcs stop --task S` -> `mcs instances set-engine --task S legacy --yes` -> `mcs start --task S`
   (delegates to `$V start`). The legacy engine reads only `config.json` and transcripts.
2. Runtime version rollback: stop all instances of the install; check out the previous skill commit (user action in the skill's git
   repository); the launcher rebuilds; if the DB schema is newer than the old runtime supports -> `mcs backup list` and
   `mcs backup restore --id <the pre-upgrade backup>` (run by the old runtime: the manifest schema stays at version 1 across runtimes);
   start.
3. Full rollback to the Python-only skill (tag `pre-v3-python`): Node files in workspaces are ignored by the legacy engine; nothing to
   undo in `config.json`/audit.

### 5.7 Downgrade refusal rules

| Condition | Effect |
|---|---|
| DB schema > runtime's max supported | every DB open refuses (`DB_NEWER_THAN_RUNTIME`): `start` (exit 15), read-only CLI, `upgrade`, `backup restore` of such a backup |
| `runtime.json` or `instance.json` `schema_version` > supported | refuse with the schema-gate message (2.6) |
| `instance.json.runtimeVersion` > `RUNTIME_VERSION` but every schema supported | allowed; `status`/`doctor` warn `older runtime than the one that last upgraded this instance (<v>)`; `upgrade` refuses `DOWNGRADE_REFUSED` (it would rewrite `runtimeVersion` downwards) |
| backup made by a newer runtime with a supported DB schema | restore allowed |

### 5.8 Tests that prove section 5

| Id | Test | Project |
|---|---|---|
| T-UP-01 | launcher on a fresh copy without `node_modules`: bootstrap runs `npm ci` + build once; second invocation does no work (time < 300 ms, `staleness` false) | integration (slow, nightly) |
| T-UP-02 | two launchers start a bootstrap at once -> one runs npm, the other waits and then skips (log shows one `npm ci`) | integration (slow) |
| T-UP-03 | `RUNTIME_IN_USE`: lockfile stamp changed while a runtime of the install runs -> launcher refuses, `node_modules` untouched | resilience |
| T-UP-04 | `MCS_LAUNCHER_NO_BOOTSTRAP=1` with a stale build -> exit 1, no npm spawned | unit (launcher test with a fake runtime dir) |
| T-UP-05 | `upgrade` dry run writes nothing; `--yes` creates the backup before the first DB change (inject a failing migration step: DB restored from the backup, audit has no `upgrade` entry, exit 1) | integration |
| T-UP-06 | `start` on a DB older than the runtime -> exit 16, hint; `upgrade --restart` -> migrated and running | integration |
| T-UP-07 | downgrade matrix of 5.7 (fixtures with higher versions) | unit + integration |
| T-UP-08 | `backup` while running, `backup list --verify`, `backup restore` (stopped): data equals the snapshot; stale `-wal` removed before the swap; manifest of another instance -> `BACKUP_INVALID` | integration |
| T-UP-09 | `outdated`: rebuild with a source change while a runtime runs -> health and `status` report `outdated: true`, `code_stamp_changed`; the served UI keeps working during the rebuild (in-memory assets) | integration |
| T-UP-10 | `version` without a build (fresh copy) prints the package version and exits 0 | unit |

---

## 6. CLI surface

### 6.1 Architecture (no duplicated business logic, INV-12; ADR 0008)
```
scripts/mcs.mjs  ->  @mcs/cli main(argv)  ->  parse (node:util parseArgs, per-command option tables)
                                          ->  ops.* (in @mcs/engine; typed input, typed result, throw McsError)
                                          ->  render (text | legacy JSON | --json envelope)
@mcs/server routes  ->  the same ops.* / query functions for read operations (config inspection, instance info, health parts)
```
- `@mcs/engine/ops/<area>.ts` holds every operation listed in 6.3. Each takes an `OpContext` and returns a result type defined in
  `@mcs/shared/cli/results.ts` (so the UI and the JSON Schemas share it).
- Data reads (sessions, usage, errors, completion evidence, export) go through `InstanceReader`:
  ```ts
  export interface InstanceReader {
    readonly mode: 'api' | 'db';
    sessions(q: SessionListQuery): Promise<Page<SessionSummary>>;          // types from the API design / 04-ui.md
    session(id: string): Promise<SessionDetail | null>;
    usage(q: UsageQuery): Promise<UsageReport>;
    errors(q: { sinceMs?: number; limit: number }): Promise<ServerErrorItem[]>;
    explainCompletion(t: CompletionTarget): Promise<CompletionEvidence>;    // 02 7.13: explainCompletion(queries, target) in engine/src/lifecycle/completion.ts (I-08)
    exportTo(q: ExportQuery, out: NodeJS.WritableStream): Promise<ExportSummary>;   // data design
    close(): Promise<void>;
  }
  export function openInstanceReader(ws: WorkspaceRef): Promise<InstanceReader>;  // probe: running -> ApiReader (http://127.0.0.1:<port>/api/v3); else DbReader (read-only DB + the same engine query functions the server uses)
  ```
  Both readers call the same engine query functions (server-side through HTTP, or in-process), so results are identical; a contract
  test runs every reader method against both modes on the same fixture and compares.
- File layout: `packages/cli/src/main.ts` (dispatch), `commands/<name>.ts` (option table + render only), `render/{text,json,legacy}.ts`,
  `io/terminal.ts` (scaffold); `packages/engine/src/ops/{workspace,config,audit,lifecycle,instances,upgrade,backup,cleanup,diagnostics,
  hooks,data,legacy}.ts`.

```ts
export interface OpContext {
  readonly repo: string;                 // absolute (path.resolve(--repo ?? '.'))
  readonly root: string;                 // tasks root
  readonly skillDir: string; readonly runtimeDir: string; readonly launcherPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;                 // 4.4a (I-36): epoch ms; Date values are derived at the call site (new Date(clock.now()))
  readonly log: Logger;                  // 05 logger (CLI logs go to stderr only at debug level)
}
```

### 6.2 Global conventions
- Invocation: `$MCS <command> [subcommand] [options]`. Options use `--name value` or `--name=value`; repeatable options (`--set`,
  `--unset`, `--session`) accumulate. Unknown option or missing required option -> usage error (exit 2) with the command's help.
- Common options: `--repo PATH` (default `.`), `--root PATH`, `--task SLUG`, `--json`, `-h/--help`. `--config FILE` is the legacy flat
  config flag (6.5) except on `init` (seed file, 4.12).
- `--task` omitted: `inspect` lists tasks; `audit` and `doctor` cover all tasks (legacy); `start`, `serve`, `restart` use the workspace
  `default` and create it on demand (init with name `Default monitor`, audited, printed: `created default workspace 'default'`);
  `status`, `stop`, `verify`, `check` use `default` when it exists, otherwise `check` validates the skill defaults only (legacy) and the
  others report `no default instance (use --task)` exit 1. Every other task-scoped command requires `--task` (usage error).
- Exit codes: `0` success; `1` failure (operation failed or a check found problems); `2` usage error; `130` interrupted by Ctrl+C.
  (Legacy promised 0/1/2; specific failures are distinguished by `error.code`, not by exit codes.)
- Output streams: results on stdout; `ERROR: <message>` on stderr (legacy); `hint: ...` and `warning: ...` on stderr; launcher progress
  `mcs: ...` on stderr. All CLI output goes through `packages/cli/src/io/terminal.ts` (design 05, ADR 0046): untrusted text (labels,
  first prompts, paths and errors from transcripts) has C0/C1, DEL, U+2028/U+2029 and bidi controls escaped in text and JSON modes.
- Default output format: commands whose legacy version printed JSON (`inspect`, `configure`, `audit`, `status`, `doctor`) print the same
  JSON shape, pretty-printed with `JSON.stringify(x, null, 2)` (non-ASCII raw, like `ensure_ascii=False`); parity with the legacy output
  is defined on keys and values, not bytes (only workspace files and audit text are byte-compatible, INV-02). Other commands print text.
- `--json`: stdout carries exactly one JSON document, the envelope:
  ```ts
  export interface CliEnvelope<T> { schema: 'mcs.cli/1'; command: string; ok: boolean; exitCode: 0 | 1 | 2; data: T | null; error: CliError | null; warnings: string[] }
  export interface CliError { code: ErrorCode; message: string; hint: string | null; details: Record<string, unknown> | null }
  ```
  For the five legacy-JSON commands, `data` is the legacy object. Schema: `schemas/cli-envelope.v1.schema.json`; per-command `data`
  types live in `@mcs/shared/cli/results.ts`.
- Error codes (`@mcs/shared/errors.ts`): `USAGE` (exit 2) and, all exit 1: `CONFIG_INVALID CONFIG_SCHEMA_MISSING CONFIG_SCHEMA_UNSUPPORTED
  CONFIG_UNREADABLE REGEX_UNSUPPORTED SLUG_INVALID TASK_NOT_FOUND WORKSPACE_ESCAPE WORKSPACE_SYMLINK WORKSPACE_INVALID
  WORKSPACE_EXISTS_CONFIG_DIFFERS INSTANCE_NOT_INITIALIZED IDENTITY_MISMATCH INSTANCE_RUNNING INSTANCE_NOT_RUNNING ENGINE_CONFLICT
  LEGACY_ENGINE_UNAVAILABLE START_FAILED START_TIMEOUT PORT_EXHAUSTED STOP_FAILED NOT_OUR_PROCESS DB_NEWER_THAN_RUNTIME
  DB_UPGRADE_REQUIRED DB_ERROR DOWNGRADE_REFUSED BACKUP_NOT_FOUND BACKUP_INVALID CONFIRMATION_REQUIRED ISOLATION_VIOLATION OUTPUT_EXISTS
  OUTPUT_PATH_FORBIDDEN BOOTSTRAP_FAILED NODE_TOO_OLD RUNTIME_IN_USE HOOKS_FAILED NOT_FOUND API_ERROR INTERNAL`.
- Confirmation: commands that delete data or change settings outside the workspace are dry runs unless `--yes`; data deletion also needs
  `--confirm <slug>` (typed slug). Without them the command prints the plan and exits 0 (a dry run is a successful command), with
  `warning: dry run; pass --yes to apply`.
- Idempotency: every command is safe to repeat; repeated runs either do nothing or report the existing result (table 6.3).
- Locking: every command that writes into a workspace holds the task mutex for the whole read-validate-write-audit sequence (4.2).

### 6.3 Command table

| Command | Key options | Default output | Exit 1 when | Idempotent | Verifies before reporting success | Engine function |
|---|---|---|---|---|---|---|
| `discover` | `--repo` | text (legacy lines + Node lines) | never (report only) | yes | - | `ops.workspace.discover` |
| `init` (alias `init-task`) | `--name` (required unless `--slug`), `--slug`, `--description`, `--port`, `--config FILE` (seed), `--engine node\|legacy` | text | validation, identity, config differs | yes (reuse) | files read back and validated | `ops.workspace.init` |
| `inspect` | `--task` | legacy JSON | config invalid | yes | - | `ops.config.inspect` |
| `configure` | `--task`, `--set KEY=JSON`..., `--unset KEY`..., `--reason`, `--decision`, `--dry-run` | legacy JSON report | rejected or isolation violated | yes (no-op writes nothing) | whole result validated before write; read back; isolation snapshot | `ops.config.configure` |
| `decide` | `--task`, `--title`, `--decision`, `--rejected` | text | workspace invalid | no (appends) | appended bytes read back | `ops.audit.recordDecision` |
| `audit` | `--task` | legacy JSON array | any problem | yes | - | `ops.audit.check` |
| `check` | `--task` | one summary line (legacy format) | config invalid | yes | - | `ops.config.check` |
| `start` | `--task`, `--port`, `--log-level`, `--open`, `--timeout-ms` | `started: <url> (pid N)` / `already running: ...` | 4.7 | yes | control ready + HTTP health with own instanceId + state.json read back | `ops.lifecycle.start` |
| `serve` | `--task`, `--port`, `--log-level`, `--open`, (`--state-file` ignored) | server logs (foreground) | boot failure | n/a | - | `ops.lifecycle.serveForeground` |
| `verify` | `--task` | `verified <url>: ...` | any endpoint invalid | yes | 5 endpoints schema-validated | `ops.lifecycle.verify` |
| `status` | `--task` | legacy JSON + new keys | not running | yes | probe (4.8) | `ops.lifecycle.status` |
| `stop` | `--task`, `--timeout-ms` | legacy-style line | 4.9 | yes | process gone (`waitForExit`) | `ops.lifecycle.stop` |
| `restart` | as `start` | stop line + start line | stop or start failed | yes | as stop + start | `ops.lifecycle.restart` |
| `doctor` | `--task` | legacy JSON array `{check, ok, detail, level?}` | any error-level check false | yes | - | `ops.diagnostics.doctor` |
| `instances list` | `--repo`, `--no-probe` | text table | never | yes | - | `ops.instances.list` |
| `instances set-engine` | `--task`, `node\|legacy`, `--yes` | text | running, invalid | yes | `instance.json` read back | `ops.instances.setEngine` |
| `instances repair` | `--task`, `--yes` | text | running | yes | 3.4 | `ops.instances.repairIdentity` |
| `config migrate` | `--task` or `--from-legacy FILE --name N [--slug]`, `--dry-run`, `--yes` | text | 2.7 | yes | results validated + read back | `ops.config.migrate`, `ops.config.importLegacy` |
| `upgrade` | `--task`, `--dry-run`, `--yes`, `--restart` | text | 5.4 | yes | integrity check after migrations; start verified with `--restart` | `ops.upgrade.run` |
| `db migrate` | `--task`, `--dry-run`, `--yes` | text | 5.4 | yes | integrity check | `ops.upgrade.migrateDb` |
| `db rebuild` | `--task`, `--yes`, `--confirm SLUG` | plan / result text | running, legacy engine, move failed | yes (no DB left = nothing to move, reports it) | DB files absent from `data/`, present in the backup with matching sha256 | `ops.upgrade.rebuildDb` |
| `ingest replay` | `--task`, `--from SEGMENT`, `--yes` | plan / result text | invalid segment name, DB or control failure | yes (dedupe by `event_uid`, 02 2.7) | cursors re-read after the reset | `ops.ingest.replay` |
| `hooks install` | `--scope project-local\|user`, `--settings-file PATH`, `--task`, `--dry-run`, `--yes` | plan / result text | invalid settings, write failed | yes | settings re-read and verified | ingestion design `planHooksInstall` + `applyHooksPlan` via `ops.hooks.install` |
| `hooks verify` | same selectors | report | not installed or broken | yes | handler path exists, node path exists, entries well-formed | `ops.hooks.verify` |
| `hooks uninstall` | same + `--yes` | plan / result text | write failed | yes | entries absent after re-read | `ops.hooks.uninstall` |
| `hooks enable` / `hooks disable` | `--task` | text | invalid | yes | `instance.json` read back | `ops.hooks.setEnabled` |
| `sessions list` | `--task`, `--state`, `--since`, `--limit`, `--all` | text table | reader failed | yes | - | `InstanceReader.sessions` |
| `sessions show` | `--task`, `--session ID`, `--events N`, `--include-text` | text | not found | yes | - | `InstanceReader.session` |
| `errors` | `--task`, `--since`, `--limit` | text lines | reader failed | yes | - | `InstanceReader.errors` |
| `diagnostics` | `--task`, `--out FILE` | path of the written bundle | write failed | yes (new file each time) | bundle re-read and schema-validated | `ops.diagnostics.bundle` |
| `export` | `--task`, `--out FILE`, `--format`, `--since`, `--until`, `--session`..., `--include-content`, `--force` | summary text | path forbidden or exists | yes with `--force` | output re-read: line count = reported | `InstanceReader.exportTo` |
| `backup [create]` / `backup list` / `backup restore` | 5.5 | text | 5.5 | create: no (new id); others yes | manifest sha256 | `ops.backup.*` |
| `cleanup` | `--task` (instance scopes), `--scope`, `--older-than`, `--keep`, `--dry-run`, `--yes`, `--confirm SLUG` | plan / result | 6.4 | yes | targets re-listed after deletion | `ops.cleanup.run` |
| `usage` | `--task`, `--session`, `--by session\|model\|day\|tool`, `--since`, `--until` | text table | reader failed | yes | - | `InstanceReader.usage` |
| `verify-completion` | `--task`, one of `--session ID` / `--label TEXT` / `--attempt PART`, `--expect completed\|failed\|terminal` | text verdict + evidence | expectation not met | yes | - | `InstanceReader.explainCompletion` (02 7.13) |
| `version` | `--short`, `--json` | text | never | yes | - | `ops.version` |
| `help` | `[command]` | text | never | yes | - | parser tables |

### 6.4 Per-command specifications (details beyond the table)
**discover**: legacy lines unchanged (`repo:`, `transcripts:`, `recent sessions (newest first):` with 15 newest `<id>  <age>s ago
<bytes> B  <first prompt 110 chars>`, `log candidate:`, `ledger candidate:`, `tasks: ... [<root>]`) produced by the same discovery
functions the server uses (ingestion design: `detectTranscriptsDir`, `realFirstPrompt`), then Node lines: `runtime: mcs <v> (build current|stale)`,
`legacy engine: python <v> at <exe> | not found`, `hooks: <hooks verify summary or "not installed">`, `instances:` one line per task
`<slug> engine=<e> state=<probe state> <url>`. The first-prompt preview is printed only by `discover` (legacy behaviour, to the
agent operating the skill); it is never logged.

**init**: 4.12. Output examples: `created task 'nightly-build' at <dir>`; `reused (nothing overwritten) task 'nightly-build' at <dir>`.
`--engine legacy` creates `instance.json` with `engine: legacy` (the workspace is then started through `$V`).

**inspect** (legacy JSON keys first): `task`, `dir`, `effective` (L keys, `repo` absolute), `provenance` (2.5), `runtime` (raw
`state.json` or null), `last_change` (`{t, summary}` from the last audit block, legacy parser), `config_hash` (sha1 of
`JSON.stringify(sortKeysDeep(effective))`, first 12 hex; Node value, not comparable with the legacy hash which included an absolute path),
`recent_audit` (last 3 blocks split before `## `, legacy rule, text normalized by universal newlines), `overridden_keys`,
`inherited_keys`; then new keys: `instance` (`instance.json` or null), `runtime_effective` (R keys), `effective_port`, `files`
(`ConfigFileStatus[]`), `engine`, `probe` (cheap: no HTTP). Without `--task`: `tasks: a, b` (legacy line).

`ConfigInspection` (I-20; the body of `GET /api/v3/config`, 03 6.1, and of the UI config view, 04 13): a pure projection of the same
`ResolvedConfig` that `inspect` prints, defined in `@mcs/shared/cli/results.ts`:
```ts
export type ConfigSource = 'builtin' | 'skill' | 'config' | 'runtime' | 'env' | 'cli';
export interface ConfigFileStatus { name: 'defaults.json' | 'runtime/defaults.json' | 'config.json' | 'runtime.json'; path: string; schemaVersion: number | null; present: boolean; ok: boolean }
export interface ConfigInspectionEntry { key: string; value: unknown; source: ConfigSource }
export interface ConfigInspection { entries: ConfigInspectionEntry[]; files: ConfigFileStatus[]; effectivePort: number; engine: 'node' | 'legacy' }
export function toConfigInspection(r: ResolvedConfig, engine: 'node' | 'legacy'): ConfigInspection;   // pure, no I/O
```
Projection: one entry per `provenance` key of 2.5 except `effectivePort` (a field of its own), `value` = the effective value at that
dotted path (`toPlain`, so L values are plain JSON), `source` = the provenance tag; entries sorted by key in code-point order; `files`
= `r.files` unchanged. The server serves `toConfigInspection(ctx.config, 'node')` (the configuration the running process loaded;
`configure` reports `restart_needed`), the CLI `inspect --json` adds it under `data.inspection`. No redaction (loopback API, same user,
D-C6); the diagnostics bundle keeps its own redaction (6.4). 04 13 names the field `provenance` and lists only `path, schemaVersion, ok`
per file: it adopts `source` and the superset above (owned by 04). Test `config-inspection.test.ts` (unit): every provenance key except
`effectivePort` appears once, sorted, values equal `effective`/`runtime_effective`, and the result validates against the shared Zod
response schema used by 03.

**configure**:
1. Parse `--set KEY=VALUE`: split at the first `=`; `KEY` trimmed; value parsed with `parsePyJson`, falling back to the raw string when it
   is not JSON (legacy `parse_value`). Missing `=` -> usage error `--set expects KEY=JSON_VALUE, got <pyRepr(item)>` (exit 2, legacy).
2. Route by the first path segment: L key or unknown -> `config.json`; R top-level key -> `runtime.json` (created with
   `{"schema_version": 1}` when absent). `schema_version` -> refused (legacy texts). Keys are dotted paths only (no file paths, no
   `__proto__`/`constructor`/`prototype` segments: rejected as unknown keys).
3. Apply to PyJson copies with the legacy semantics: before-text `was(k)` = `pyShort(current)` or `(default <pyShort(default)>)`; change
   recorded only if `!pyEquals(current, value)`; `_set_path` creates intermediate objects, refuses a non-object intermediate
   (`cannot set <k>: <part> is not an object`); `--unset` removes and records `<k>: <before> -> (removed, default applies)`.
4. Validate the whole new `config.json` (strict) and new `runtime.json` (overrides schema) and run `resolveConfig` in memory on the
   result (regexes included). Problems -> `rejected, nothing written: p1; p2` exit 1.
5. No change -> `{changed: false, changes: [], unchanged: [...]}` exit 0, nothing written, nothing audited.
6. Isolation snapshot of every other task (Node rule: excludes runtime-mutable paths, 1.1) before writing.
7. `--dry-run` -> print the report with `"dry_run": true`, exit 0.
8. Write the changed file(s) atomically; read back and compare with the intended bytes.
9. When `repo`, `transcripts_dir` or `session_ids` changed, rewrite the route file (02 2.6.2). Audit `configure` (legacy format;
   `Files changed: config.json` and/or `runtime.json`); `--decision` -> `decisions.md` entry titled
   `configuration`.
10. Snapshot again; difference -> `ERROR: isolation violated: another task changed during configure (this is a bug)` exit 1
    (`ISOLATION_VIOLATION`; the write already happened, legacy behaviour).
11. Report (legacy keys): `changed`, `changes`, `unchanged` (sorted keys not changed); new keys: `files`, `isolation: 'ok'`,
    `restart_needed` (true when the instance is running: config is read at start).

**decide**: appends `## <ts> | <title>\n- Decision: <text>\n- Rejected alternatives: <text or "none recorded">\n\n` to
`audit/decisions.md`; prints `recorded decision in <path>` (legacy).

**audit**: per task `{task, ok, problems[]}` with the legacy checks (id match, schema, config resolves, `changes.md` exists, no symlink,
no `*.jsonl` anywhere in the workspace, legacy text `transcript copy found (never copy transcripts): <relative path>`) plus Node checks
when `instance.json` exists: `instance.json` valid and `slug` matches; `runtime.json` valid; every file in `data/spool/` matches
`SPOOL_SEGMENT_RE` (02 2.7, `.ndjson`; I-02) else `unexpected file in data/spool: <name>`; `state.json` engine/instanceId consistent
when present. The Node runtime itself never creates a `*.jsonl` inside a workspace (1.1), so a Node instance passes the legacy audit
(T-XE-06).

**check**: legacy line `title: <t> | repo: <r> | transcripts: <dir> | rules: <n> | window: <h>h | panels: <on,...> | source: task`
(byte-identical for the same config); `--json` adds `effectivePort`, `engine`, `regex: {checked: n, ok: true}`.

**doctor**: checks in order (legacy names kept where they exist): `node >= 22.22` (replaces `python >= 3.8`; the launcher floor 5.1), `runtime build is current`,
`config loads and validates`, `regexes translate exactly`, `transcripts folder found`, `recent transcripts parse` (5 newest files, legacy
threshold `bad == 0 or bad < max(5, total // 100)` using the ingestion reader), `rules match at least one session`, `chain_log exists`,
`ledger exists` (when configured), `instance identity is consistent`, `database integrity` (stopped: read-only `PRAGMA quick_check`;
running: health `db.ok`), `state file is current` / `running runtime answers` + `no recent server errors`, `runtime is not outdated`
(warning), `no ownership conflict`, `hooks installed and verified for this instance` (warning when `hooks.enabled` is false), `spool
backlog below threshold` (warning), `free disk space >= 1 GiB` (warning), `workspace is git-ignored` (warning; `git check-ignore -q`),
`workspace is not writable by other users` (warning, Windows: `icacls` output lists `Everyone`, `Users` or `Authenticated Users` with
`(M)`/`(F)`/`(W)` on the workspace; `icacls` via `execFileText` kind `'icacls'`, 4.2; E13 shows the default ACL of a non-system drive grants `Authenticated Users` modify), and per task
`task <slug> audit` (no `--task`) or `task audit`. Shape `{check, ok, detail, level: 'error' | 'warning'}`; warnings are `ok: true` with
the warning in `detail`; exit 1 iff an error-level check is false.

**instances list**: rows `slug engine state url pid version outdated` where state comes from `probeInstance` (parallel, control timeout
300 ms, HTTP 1 s; `--no-probe` uses `state.json` + `pidAlive` only). JSON: `InstanceRow[]`.

**instances set-engine**: refuses while running; writes `instance.json.engine`; rewrites the route file (02) with `stoppedAt: now` when
 switching to `legacy` (the legacy engine does not read the spool); audit `engine-switch`.

**hooks ***: `install`/`uninstall` are dry runs without `--yes`; they print the target settings file, the entries to add/replace/remove,
the backup path, and this consent text: `Hook settings apply to every Claude Code session that reads this settings file, including
sessions that are already running.` Safety guard (C3): when `process.env.VITEST` or `MCS_TEST` is set, the command refuses any target
outside `os.tmpdir()` (`HOOKS_FAILED`). `--settings-file` selects an explicit file (tests). With `--task`, an audit entry is written to
that task. Implementation of planning/applying/verifying belongs to the ingestion design. `hooks enable|disable --task` writes
`instance.json.hooks.enabled`, rewrites the route file (02 `writeRouteFile`) and audits `hooks-enable|hooks-disable`.

**sessions list / show**: table columns `id(8) label state basis last-activity tokens(in/out) errors`. `show` prints metadata, state with
basis and evidence lines, the agent tree, and the last N events as `time kind tool/name status`; prompt/response text only with
`--include-text` (clipped to 300 chars, never written to logs).

**errors**: `<ISO time> <where>: <message>` newest first; sources: health error ring and the ingestion error records (data design).

**diagnostics**: writes `DiagnosticsBundle` JSON (`schemas/diagnostics.v1.schema.json`) to `--out` (default
`<ws>/logs/diagnostics-<UTC ts>.json`):
`{schema: 'mcs.diagnostics/1', generatedAt, runtime: {version, codeStamp, node, platform, arch, buildCurrent}, instance: {instanceId,
slug, engine, dbSchemaVersion}, config: {files: ConfigFileStatus[], provenance, safeValues}, doctor: DoctorCheck[], status: StatusReport,
health: HealthReport | null (03 6.2 as served, including `runtime.rssBytes/heapUsedBytes/cpuUserMicros/cpuSystemMicros`, `children` and
`panels`, I-21; its `errors[].message` texts pass the same path rewriting), hooks: HooksVerifyReport | null, logTail: LogRecord[] (last 200 records of runtime.log; the logger's
allow-listed fields only), disk: {freeBytes}}`. Redaction: `safeValues` contains only numbers, booleans and enum values of config keys
(no strings: regex patterns appear as `<pattern length=N>`, paths as `<path>`); absolute paths elsewhere are rewritten relative to
`<repo>` or `<home>`; no transcript text, prompts, tokens, environment values, or `run/control.token`.

**export**: `--out` required; refuses an existing file without `--force` (`OUTPUT_EXISTS`); refuses a path inside any workspace other
than `<ws>/logs/` or `<ws>/data/backups/` (`OUTPUT_PATH_FORBIDDEN`), a `*.jsonl` name anywhere inside a workspace
(`OUTPUT_PATH_FORBIDDEN` "a .jsonl file inside a task workspace fails the legacy audit; use .ndjson"), and inside `~/.claude`; parent folder must exist. Default format
and the meaning of `--include-content` (off by default) come from the data design (`mcs.export/1`). Writes to `<out>.tmp` then renames.

**cleanup**: scopes (all dry-run by default):

| Scope | Requires | Deletes |
|---|---|---|
| `stale-state` | `--task` | `state.json` when `probeInstance` is `stale`/`foreign-pid`/`legacy-stale` (compare-and-delete); `run/control.token` when no runtime; `*.tmp` older than 10 min in the workspace |
| `init-leftovers` | `--repo` | dead staging folders in the tasks root (4.12 step 3) |
| `logs` | `--task`, `--yes` | rotated `logs/*.log.N`, `boot.log.1`, `diagnostics-*.json` older than `--older-than` (default 30d) |
| `backups` | `--task`, `--yes` | backups beyond `--keep` (default `backup.keep`), oldest first, never the newest `upgrade` backup |
| `spool` | `--task`, stopped instance, `--yes` | fully drained spool segments older than `--older-than` (ingestion design defines "drained") |
| `data` | `--task`, stopped instance, `--yes`, `--confirm <slug>` | DB rows older than `--older-than` or the `retention` policy (data design `applyRetention(db, policy, {dryRun})`); automatic backup (reason `cleanup`) first |

Every candidate path is `realpath`-contained in the workspace (or the tasks root for `init-leftovers`) and not a link; the plan lists
relative paths, counts and bytes; the result re-lists the targets to confirm deletion; audit `cleanup` (not for dry runs and not for
`stale-state`, which legacy also performs implicitly). Removing a whole workspace is not a CLI operation (legacy rule: manual action with
the user's explicit instruction; documented steps: `mcs stop`, then delete the folder).

**usage**: table of `input`, `output`, `cacheCreation`, `cacheRead` per row (`--by`), with completeness markers (`partial`, `lower bound`
for subagent-derived rows) exactly as the analytics functions report them; cost columns only when `pricing` is configured, labelled
`estimate`.

**verify-completion** (I-08): the flags build the 02 7.13 `CompletionTarget`: `--session ID` -> `{sessionId}`, `--label TEXT` ->
`{label}`, `--attempt PART` -> `{attemptPart}` (exactly one, else usage error); resolution order and ambiguity rules are 02's.
`InstanceReader.explainCompletion(target)` returns 02's `CompletionEvidence {outcome: 'completed' | 'failed' | 'not_terminal', state,
basis, confidence, evidence[], sessionId, ruleId}`; `outcome` is terminal only when `basis === 'observed'` (D9: completion only from
SessionEnd reasons, daemon job state, or external evidence such as the attempts table). Output: `COMPLETED (observed): session <id8>`
/ `FAILED (observed): session <id8>` / `NOT TERMINAL: state=<state> (<basis>, confidence <c>)`, then one evidence line per item
(`<source> <ISO time> <text>`, untrusted text escaped by `io/terminal.ts`). Exit 0 iff the outcome matches `--expect` (default
`completed`; `terminal` accepts completed or failed); a target that resolves to nothing -> `NOT_FOUND` exit 1.

**ingest replay** (I-29; behaviour owned by 02 2.7): `mcs ingest replay --task S [--from SEGMENT] [--yes]`.
1. `--from` must match `SPOOL_SEGMENT_RE` (`hooks-<YYYYMMDD>T<HH>Z.ndjson`) and exist in `data/spool/`, else `USAGE` exit 2 /
   `NOT_FOUND` exit 1. Without `--from` every retained segment is selected.
2. Without `--yes`: print the selected segments with sizes and `warning: dry run; pass --yes to apply`; exit 0.
3. Running instance (`probeInstance` = `running`): control op `ingest-replay` (4.3) with the token; stopped instance: take the task
   mutex, open the DB with `openInstanceDb({mode: 'maintenance'})` and call 02's `replaySpool(db, scope, {fromSegment, nowMs})` (sets
   `offset = 0`, `sealed = 0` for the selected `spool_cursors` rows in one transaction), close. Any other probe state ->
   `INSTANCE_RUNNING` "wait until the runtime is ready or stopped".
4. Print `replay scheduled for <n> segments (duplicates are ignored by event_uid)`; audit `ingest-replay` (7.2). The re-read happens on
   the next drain (running) or at the next start (stopped).

**db rebuild**: 5.4.

### 6.5 Legacy flags and delegation (ADR 0008)
- Legacy flat-config forms `$MCS --config FILE [--port N] [--open]`, `--config FILE --check`, `--config FILE --stop`, `--discover [--repo P]`,
  and any task-scoped command with `--config FILE` (except `init`) are delegated to `$V` with the same arguments, after printing
  `warning: flat configs are served by the legacy engine; migrate with `mcs config migrate --from-legacy FILE --name <name>``.
  `--discover` without `--config` runs the Node `discover` (same output plus Node lines).
- Instances with `instance.json.engine = 'legacy'`: `start`, `stop`, `status`, `verify`, `restart`, `serve`, `check`, `doctor --task`
  delegate to `$V <command> --task <slug> --repo <repo>`. `configure`, `inspect`, `audit`, `decide`, `init` stay in Node (byte-compatible
  files, INV-02).
- Python discovery: `MCS_PYTHON`, then `python`, `python3`, `py -3`; each candidate is accepted only if
  `<exe> -c "import sys; print('%d.%d' % sys.version_info[:2])"` prints a version >= 3.8 within 5 s (rejects the Windows Store alias
  stub). None -> `LEGACY_ENGINE_UNAVAILABLE` exit 1 with hint `mcs instances set-engine --task <slug> node`.
- Delegation runs `spawnForeground(python, [<skill>/template/viewer.py, ...args])` and returns its exit code unchanged.

### 6.6 `instance.commands` for the UI (`04-ui.md` S-9)
The server fills `InstanceInfo.commands` with display strings built by `formatCommand(argv)` (`@mcs/engine/ops/commands.ts`):
`node "<launcher abs path>" <command> --task <slug> --repo "<repo abs path>"` with double quotes only when a value contains a space;
values: `status`, `restart`, `inspect`, `export` (`export --task <slug> --out "<ws>/logs/export.ndjson"`; never `.jsonl` inside a
workspace, 1.1), `backup`, `cleanupDryRun`
(`cleanup --task <slug> --scope logs`). They are shown for copy-paste; the server never executes them.

### 6.7 Tests that prove section 6

| Id | Test | Project |
|---|---|---|
| T-CLI-01 | every command: `--help` exits 0 and lists its options; unknown option -> exit 2 with `USAGE` in `--json` | unit |
| T-CLI-02 | `--json` output of every command validates against `schemas/cli-envelope.v1.schema.json` and its `data` schema | integration |
| T-CLI-03 | legacy text/JSON parity: golden outputs captured from `$V` on the shared fixtures for `init-task`, `inspect` (legacy keys), `configure`, `audit`, `check`, `status` (keys), `stop` messages, `doctor` names | parity |
| T-CLI-04 | `configure` semantics: no-op writes nothing (mtime and bytes unchanged, no audit), invalid change writes nothing, `--unset`, dotted keys into non-objects, `schema_version` refusal, R-key routing creates `runtime.json` | unit + integration |
| T-CLI-05 | `InstanceReader` contract: each method returns equal results in `api` and `db` mode on the same fixture | integration |
| T-CLI-06 | confirmation rules: every destructive command is a dry run without `--yes`; `cleanup --scope data` also needs `--confirm <slug>` | integration |
| T-CLI-07 | delegation: `instance.json.engine = legacy` -> `start` runs `$V start` (Python available) or reports `LEGACY_ENGINE_UNAVAILABLE` | parity |
| T-CLI-08 | `verify-completion`: fixtures for completed (attempts PASS), failed, turn-ended (not terminal), inferred-only -> exit codes per `--expect` | integration |
| T-CLI-09 | `diagnostics` bundle contains none of the fixture's prompt markers, regex texts, absolute home paths, or the control token | integration |
| T-CLI-10 | `hooks install` refuses a real settings path under test env; with `--settings-file <tmp>` dry run writes nothing | unit |
| T-CLI-11 | `ingest replay`: dry run writes nothing; stopped instance -> selected cursors at 0 and next start re-reads without duplicate events; running instance -> control op, `segments` count, event count unchanged after the drain; `--from` with a bad name -> exit 2 | integration |
| T-CLI-12 | `db rebuild`: refused while running and without `--confirm`; applied -> DB files moved with sha256 in the manifest, `dbSchemaVersion` 0, audit `db-rebuild`; next `start` creates a new DB and re-imports the fixture (same session count); `backup restore --id <rebuild backup>` brings the old DB back (`dbCopy: 'raw'` with WAL) | integration |
| T-CLI-13 | `export --out <ws>/logs/x.jsonl` -> `OUTPUT_PATH_FORBIDDEN`; `$V audit` passes on a workspace after `export --out <ws>/logs/x.ndjson` | integration (+ parity for the `$V` part) |

---

## 7. Audit trail

### 7.1 Format (legacy byte-compatible, `tasks.py:44-76`)
Writer `@mcs/engine/audit/writer.ts`:
```ts
export interface ChangeEntry { action: AuditAction; summary: string; reason: string | null; files: readonly string[]; validation: string; outcome: string; unresolved?: string }
export function appendChange(ws: WorkspaceRef, e: ChangeEntry, nowMs: number): Promise<void>;      // nowMs = ctx.clock.now() (I-36)
export function appendDecision(ws: WorkspaceRef, title: string, decision: string, rejected: string | null, nowMs: number): Promise<void>;
export function lastChange(ws: WorkspaceRef): Promise<{ t: string; summary: string } | null>;     // legacy parser semantics
export function recentAudit(ws: WorkspaceRef, blocks?: number /* 3 */): Promise<string>;         // legacy `re.split(r'(?m)^(?=## )')[-3:]`
export interface AuditRef { file: 'changes' | 'decisions'; at: string /* ISO ms Z */; title: string; summary: string }
export function entriesBetween(ws: WorkspaceRef, fromMs: number, toMs: number, limit: number): Promise<AuditRef[]>;   // I-19; 03 SessionDetail.auditRefs
```
Exact bytes of a change entry (LF only, one blank line after):
```
## <UTC YYYY-MM-DDTHH:MM:SSZ> | <action>
- Summary: <summary>
- Reason: <reason or "not given">
- Files changed: <files joined by ", " or "none">
- Validation: <validation>
- Outcome: <outcome>
- Unresolved: <unresolved or "none">

```
Decision entry: `## <ts> | <title>\n- Decision: <decision>\n- Rejected alternatives: <rejected or "none recorded">\n\n`.
`entriesBetween(ws, fromMs, toMs, limit)` (module `@mcs/engine/audit/reader.ts`, used by 03 `getSession` for `SessionDetail.auditRefs`):
1. For `file` in `changes`, `decisions`: `readTextUniversal(<ws>/audit/<file>.md, 4 MiB)` (universal newlines, BOM stripped); absent
   file -> no entries; larger than 4 MiB -> read only the last 4 MiB and drop the first partial block (logged once as `audit_truncated`).
2. Split with the legacy rule `(?m)^(?=## )` (`tasks.py`; JavaScript `/^(?=## )/m` on the LF-normalised text). For each block whose first
   line matches `^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \| (.*)$`: `at` = that timestamp (seconds, UTC) as epoch ms;
   `title` = group 2 trimmed (for `changes`, the action); blocks whose header does not match are skipped (legacy headers always match).
3. `summary`: `changes` -> the text after `- Summary: ` on the first line starting with it; `decisions` -> the text after `- Decision: `;
   absent -> `''`. Clipped to 300 code points with `...`.
4. Keep blocks with `fromMs <= at <= toMs`; merge both files; sort by `at` descending, then `file` (`changes` first); return the first
   `limit` (03 uses 10), `at` rendered with `isoMsZ`.
The texts are workspace audit text written by the operator's commands, never transcript text; they are still treated as untrusted on
output (UI safe rendering, CLI terminal escaping).

A new file starts with `# Changes\n\n` / `# Decisions\n\n`. The entry is written with one `fs.promises.appendFile` call of one buffer (one write; retry rule
1.2), under the task mutex (4.2) so two Node writers never interleave or double the header. Legacy writers do not take the mutex;
a simultaneous legacy and Node append is possible but was already unguarded between two legacy processes (documented).
Text fields are single-line: `\r` and `\n` inside a summary, reason or decision are replaced by a space (the legacy `last_change`
parser reads only the first line of `- Summary:`). Paths under the user's home are written as `~/...`; paths inside the workspace are
relative; no transcript text, prompt, token, environment value or control token is ever written. Regex texts appear only where legacy
already writes them (`configure` summaries of `session_rules`/`attempts` values via `pyShort`).

### 7.2 Action catalogue (Node-side)

| Action | Written by | Summary template | Files changed | Validation | Outcome |
|---|---|---|---|---|---|
| `init-task` | `init` (new) | `created task workspace '<slug>'` (reason `monitoring requested for this task`, legacy text) | `task.json, config.json, README.md, instance.json` | `schema ok` | `created` |
| `adopt-instance` | `init` (reuse without `instance.json`) | `added Node runtime files to workspace '<slug>' (instance <first 8 hex>)` | `instance.json` | `schema ok` | `adopted` |
| `configure` | `configure` | legacy: changes joined by `; `, each `<key>: <before> -> <pyShort(new)>` or `<key>: <before> -> (removed, default applies)` | `config.json` and/or `runtime.json` | `schema ok (strict)` | `applied` |
| `config-migrate` | `config migrate` | `<file> schema_version <a> -> <b>` joined by `; ` | migrated files | `schema ok (strict)` | `migrated; backup <id>` |
| `config-import` | `config migrate --from-legacy` | `imported legacy config '<file name>' (<n> keys, <m> dropped)` | `config.json` (+ created files) | `schema ok (strict)` | `imported` |
| `upgrade` | `upgrade` | `runtime <old> -> <new>; db schema <a> -> <b>; files: <file vA -> vB, ... or none>` | `instance.json, data/monitor.db` (+ migrated files) | `migrations applied; integrity ok` | `upgraded; backup <id>` |
| `db-migrate` | `db migrate` | `db schema <a> -> <b>` | `instance.json, data/monitor.db` | `migrations applied; integrity ok` | `migrated; backup <id>` |
| `backup` | `backup` | `created backup <id> (<reason>)` | `data/backups/<id>/` | `sha256 recorded for <n> files` | `created` |
| `backup-restore` | `backup restore` | `restored backup <id> (pre-restore backup <id2>)` | `data/monitor.db` (+ `runtime.json`, `instance.json`) | `manifest ok; sha256 ok; instance id ok` | `restored` |
| `cleanup` | `cleanup` (not `stale-state`, not dry runs) | `<scope>: deleted <n> files, <bytes> bytes` | `<n> files under <relative folder>` | `targets re-listed` | `applied` |
| `engine-switch` | `instances set-engine` | `engine: <old> -> <new>` | `instance.json` | `schema ok` | `applied` |
| `hooks-enable` / `hooks-disable` | `hooks enable/disable` | `hooks.enabled: <old> -> <new>` | `instance.json` | `schema ok` | `applied` |
| `hooks-install` / `hooks-uninstall` | `hooks install/uninstall --task` | `<scope> settings ~/<path>: <n> added, <m> replaced, <k> removed` | `none` (outside the workspace) | `settings re-read and verified` | `applied; settings backup <path>` |
| `instances-repair` | `instances repair` | `new instance <8 hex> (was <8 hex>); data moved to data/backups/orphaned-<ts>/` | `instance.json, data/` | `schema ok` | `repaired` |
| `db-rebuild` | `db rebuild` | `database moved to backup <id> (<bytes> bytes); a new database is created at the next start` | `data/monitor.db, instance.json` | `sha256 recorded for <n> files` | `moved; backup <id>` |
| `ingest-replay` | `ingest replay` | `spool replay of <n> segments from <first segment or "all">` | `none` (database cursors only) | `cursors re-read` | `scheduled` |
| decision | `decide`, `configure --decision` | legacy decision entry (`configure --decision` uses the title `configuration`) | - | - | - |

`Reason` = `--reason` when given, else `not given` (legacy), except `init-task` (legacy fixed text). Not audited (legacy parity): `start`,
`stop`, `restart`, `serve`, `status`, `verify`, `check`, `inspect`, `audit`, `doctor`, `discover`, read-only data commands, dry runs,
`cleanup --scope stale-state` (they change no persistent configuration; lifecycle events go to `logs/runtime.log`).

### 7.3 Tests

| Id | Test | Project |
|---|---|---|
| T-AU-01 | golden bytes: the same `init` + `configure` + `decide` sequence by `$V` and `$MCS` -> identical files after masking timestamps (T-XE-02) | parity |
| T-AU-02 | `lastChange`/`recentAudit` on legacy-written fixtures (LF and CRLF variants) equal the legacy parser's results | unit |
| T-AU-03 | 8 concurrent `decide` processes -> 8 entries, one header, every entry intact | resilience |
| T-AU-04 | every catalogue action writes exactly the template (unit per action, injected clock) | unit |
| T-AU-05 | newline injection in `--reason` cannot create a fake entry (no line starting with `## ` in the appended bytes except the first) | unit |
| T-AU-06 | `entriesBetween` on legacy-written and Node-written fixtures (LF and CRLF, BOM, both files, one malformed header): window bounds inclusive, merge order, `limit`, summary extraction and clipping, absent files | unit |

---

## 8. Security of the control plane

### 8.1 Threat model
Assets: transcript-derived data in the DB and API (prompts, file contents, possibly secrets), configuration, the ability to stop or
reconfigure monitoring, the user's Claude settings (hooks). Trusted: the user and processes running as the user (they can read the
transcripts directly anyway). Untrusted: web pages in the user's browser (DNS rebinding, CSRF against loopback), other local users,
transcript content (D-C6), any path or id read from config, CLI arguments or hook payloads.
Out of scope (D15): remote access, enterprise auth, encryption at rest.

### 8.2 Controls

| Area | Control | Evidence / test |
|---|---|---|
| Lifecycle operations | not on HTTP; only on the control channel (named pipe / Unix socket), which browsers cannot reach | ADR 0005, E3; T-LC-04 |
| Control channel access | Windows pipe DACL of a Node-created pipe: owner, Administrators, SYSTEM full control; Everyone and Anonymous `Read, Synchronize` only (E3 ACL probe), so other users cannot send a request (a request needs write access); POSIX socket in a 0700 folder or the Linux abstract namespace | E3; T-SEC-01 (POSIX, CI) |
| Shutdown/backup capability | 256-bit random token in `run/control.token`, new per boot, `timingSafeEqual`, `instanceId` must match | T-LC-04 |
| Residual risk | another local user can hold a read-only connection to the pipe and keep pipe instances busy (local denial of service); the token still prevents shutdown | documented |
| HTTP | bind `127.0.0.1` only (no option to change it in v1: `server.bindHost` does not exist); exact Host/Origin, fetch-metadata and CSRF rules, size limits and timeouts (design 05, ADR 0045); the legacy compatibility `GET /api/health` returns no secrets | C-4; ADR 0045 tests |
| Files and ACLs | Node cannot set Windows ACLs; files inherit the folder ACL. E13: on a non-system drive the default ACL grants `Authenticated Users` modify, so any local user can read the workspace (DB included) and the token. `doctor` warns (6.4); `docs/operations.md` gives the opt-in hardening command `icacls "<ws>" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`; not applied automatically (it can lock out tools that run under another account) | E13; T-SEC-02 (doctor warning on a temp folder with a permissive ACL) |
| Path traversal | slug pattern + reserved names; workspace = `realpath` containment in the tasks root; ids from HTTP are never joined into paths (API/ingestion designs); CLI outputs (`--out`) resolved absolute and refused inside other workspaces and inside `~/.claude`; `backup.dest` validated by the server | T-ISO-01/02, T-SEC-03 |
| Links | no symlink/junction below the tasks root may be read or written (`assertNotLink` before every open; `lstat` walk in `audit`); temp files opened with `wx` in the target folder | E5; T-ISO-02, T-SEC-04 |
| Subprocesses | one exec module; argv arrays; `shell:false`; `windowsHide:true`; timeouts; PowerShell text built only from validated integers; no executable name from user input except `MCS_PYTHON` (probed, version-checked) | INV-11; T-LC-16 |
| Recursion | server env and every child: `MCS_HOOK_DISABLE=1`; the runtime never starts `claude` | D8 |
| Hooks installer | consent text, dry run by default, backups, refuses real settings under test env | 6.4; T-CLI-10 |
| Logs, audit, diagnostics | logger allow-list (05); audit rules 7.1; diagnostics redaction 6.4; `discover`'s first-prompt preview is printed to the operator only | T-CLI-09, T-AU-05 |
| Supply chain | `.npmrc` `ignore-scripts=true`, `save-exact=true`, `npm ci` from the lockfile only | D6 |

### 8.3 Tests

| Id | Test | Project |
|---|---|---|
| T-SEC-01 | POSIX: control socket folder mode 0700 and socket not connectable by another uid (CI job with a second user, Linux) | resilience (CI) |
| T-SEC-02 | `doctor` reports `workspace is not writable by other users` as a warning when the ACL grants Authenticated Users modify (temp folder on the same drive) | integration (Windows) |
| T-SEC-03 | `export --out` and `diagnostics --out` into another workspace or `~/.claude` -> `OUTPUT_PATH_FORBIDDEN`; control `backup` with `dest` outside `data/backups` -> `BAD_REQUEST` | integration |
| T-SEC-04 | a junction planted as `audit/` or `data/` (Windows) / symlink (POSIX) -> every writing command refuses with `WORKSPACE_SYMLINK`; nothing written through it | integration |
| T-SEC-05 | token: `run/control.token` absent from backups, diagnostics, logs and CLI output (grep in test artefacts) | integration |

---

## 9. Experiments (evidence log, 2026-10-11, Windows 11 Pro 10.0.26200, Node v24.14.1, Python 3.14.3)
Scratch: `D:/mvp/private/scratch/mcs-v3/instances-ops/` (one folder per experiment). No hooks installed, no settings touched, no
running process of the owner touched (the live monitors' pids were only checked with `process.kill(pid, 0)` and a read-only
`IsProcessInJob` query). Ports used: 18431-18443. Every started process was stopped; a final check found no leftover process or port.

| Id | Question | Command (scripts in the scratch folder) | Result |
|---|---|---|---|
| E1 | Detached spawn on Windows: survival, console, job, grandchild windows | `e1/launch.mjs A|B|C`, `e1/launch-after-helper.mjs` (A2), `e1/probe-proc.ps1`, `e1/injob.ps1` | A (`detached`, `windowsHide`, stdio to file) and C (stdio ignore) kept writing heartbeats after the launching shell call ended; B (`detached:false`) died before its first heartbeat (libuv kill-on-close job). Detached processes: `AttachConsole` fails with error 6 (no console), `MainWindowHandle` 0. Their `windowsHide:true` PowerShell grandchild reported `GetConsoleWindow()` = 0, visible False. A Node process joins a job object only after it spawns a non-detached child (plain detached child: `inJob=False`; after one `spawnSync`: `inJob=True`); a launcher in that state still spawned a detached child that survived it (A2). Not run on purpose: a child without `windowsHide` from a console-less parent (would flash a window on the owner's desktop) |
| E2 | Cost of reading another process's command line | `e2/cmdline-cost.mjs` | `wmic` absent. PowerShell 5.1 `Get-CimInstance` 539/358/308/314/269 ms; `Get-WmiObject` 305-1027 ms; `Get-Process` path only 205-661 ms; PowerShell 7 `Get-Process .CommandLine` 364-406 ms, `Get-CimInstance` 322-524 ms; `tasklist` 74-114 ms (image name only). The marker argument was found by every command-line method |
| E3 | Graceful shutdown and named-pipe lock on Windows | `e3/server.mjs`, `e3/run.mjs`, `e3/pipe-acl.mjs` | `process.kill(pid,'SIGTERM')`: gone at once, no handler, no `exit` event. `taskkill /PID n` without `/F`: exit 1 "can only be terminated forcefully". Second listener on the same pipe: `EADDRINUSE`. `identify` 69 ms; wrong token -> FORBIDDEN, still alive; `shutdown` 52 ms + exit 10 ms later, graceful handlers ran. After `taskkill /F` the same pipe and port were listenable again at once (ready in 92 ms). Connecting to an absent pipe: `ENOENT`. Pipe DACL: owner/Administrators/SYSTEM full control, Everyone and Anonymous `Read, Synchronize` |
| E4 | TCP port exclusivity | `e4/hold.mjs`, `e4/hold.py` | Node+Node same `127.0.0.1:p`: `EADDRINUSE`. Python (legacy server class, `allow_reuse_address=False`) then Node: `EADDRINUSE`. Node then Python: errno 10048. Node on `0.0.0.0:p` does not block Node on `127.0.0.1:p` |
| E5 | Atomic replace and folder rename on Windows; links | `e5/run1/*`, `e5/run2` | rename-over fails `EPERM` while Python or Node holds the target open; with retries every 50 ms it succeeded after 8 tries (352 ms) once a 1 s holder closed. Continuous replace (124 ok, 357 retries, 1 failure after 20x5 ms) vs a polling Python reader: 5,702 `PermissionError` out of ~18,000 reads. Folder rename onto an existing folder: `EPERM` (empty or not); onto an absent name: ok; folder with an open file inside: `EPERM`. Junction (`mklink /J`): `lstat().isSymbolicLink()` true; symlink creation without privilege: `EPERM` |
| E6 | Python JSON number output vs JS | `e6/gen.py`, `e6/check.mjs` | 26,016 lexemes: `pyNumber` emulation 0 mismatches; `JSON.stringify(JSON.parse())` 3,340 mismatches. Python compact separators `, ` / `: ` vs JS none |
| E7 | Python regex classes, syntax acceptance, V8 features | `e7/py_sets.py`, `e7/js_sets.mjs`, `e7/icase.mjs` | Python 3.14.3 (Unicode 16.0.0) vs Node ICU Unicode 17.0: `\w` vs `[\p{L}\p{N}_]` 0 Python-only, 4,657 JS-only (new in 17); `\d` vs `\p{Nd}` 0 / 10; `\s` vs explicit 29-code-point class identical (JS `\s` differs: +U+FEFF, -U+001C..U+001F, -U+0085); `(?i)[a-z]` Python 56 code points, JS `iv` 54 (missing U+0130, U+0131). Python `.` excludes only U+000A; `$` matches before a final newline. Python rejects `(?<n>..)`, variable lookbehind, mid-pattern global flags, `\q`, duplicate group names, `{3,1}`; accepts `\z` (3.14), `{,3}`, possessive, atomic, `\N{..}`, octal, conditionals; `[[:alpha:]]` FutureWarning. V8 13.6 `v` flag: nested classes, `(?i:)`/`(?-i:)` modifiers, variable lookbehind, named groups ok; lone `{` and `\-` outside a class are SyntaxErrors. Capture in repetition: Python `'a'`, JS `undefined`. IGNORECASE with the planned emission (`i` plus U+0130/U+0131): 6 cases incl. negated classes, U+212A and U+017F identical to Python |
| E8 | Translator prototype vs Python on the live V9 patterns, the example config and tricky constructs | `e8/pyre.mjs`, `e8/diff.mjs`, `e8/py_ref.py`, `e8/tricky.mjs`, `struct.mjs`, `struct2.mjs` | 7 patterns x 4,500 inputs = 31,500 comparisons (span + groups): 0 differences. Tricky constructs: 18 patterns x 25 inputs: 450/450 identical; untranslated JS for contrast: 7 patterns do not compile, 21 result differences. V9 construct inventory (structure only): 2 session rules (no scope; one has 1 plain capturing group, 2 classes with ranges, `.`, lazy `*?`, greedy `+`; the other is literal text), `attempts.start` (6 named groups, `^` at 0, 10 classes, counted `{N}` x4, `+` x6) and `attempts.end` (5 named groups, `^` at 0, 8 classes, `{N}` x4, `+` x4); no backslashes, flags, lookarounds or alternation; `time_format` uses `%Y %m %d %H %M %S`; the `(?P<` patterns do not compile in JS unchanged |
| E9 | Launcher concerns | inline `node -e` (see section 5.1) | `spawn('npm.cmd')` without shell: `EINVAL`; `node <dir of node.exe>/node_modules/npm/bin/npm-cli.js --version` -> 11.11.0 (246 ms); `npm_execpath` unset outside npm; `staleness()` of the scaffold's `build-stamp.mjs` 8-13 ms (57 source files); module load warm: zod 44-51 ms, express 57-62 ms, better-sqlite3 3 ms; cold first load zod 378 ms, express 214 ms |
| E10 | Named-pipe mutex under contention | `e3/mutex.mjs` x5 | 10 enter/leave events, maximum concurrent holders 1; waits 316-1,659 ms |
| E11 | Rebuilding while a runtime runs | `e11/run2` | loaded `better_sqlite3` addon: rename ok, unlink `EPERM`, recursive removal of the package `EPERM`; an imported `.mjs` file can be deleted while the importing process runs |
| E12 | Zod 4.6.5 JSON Schema and defaults | inline `node -e` in the stack smoke repo | `z.toJSONSchema` exists; `io: 'input'` makes defaulted keys optional; `.default({})` on an object returns `{}` without inner defaults; `.prefault({})` returns `{port: null, portScan: 19}` |
| E13 | Workspace ACL and git status | `icacls` (principals only), `git check-ignore -v` | tasks folder on `D:` inherits `Authenticated Users:(M)` and `Users:(RX)`; `.claude/` is ignored by the host repo's `.gitignore` |
| E14 | Runtime sections of 02/03 under the generated-schema pattern (I-01) | `e14/sections.mjs` (Zod 4.6.5 from the stack smoke repo) | `RuntimeFileSchema.parse({schema_version:1})` returned every default of `spool`, `import`, `health`, `analytics` (derived keys `null`); 16 of 16 keys accepted by the overrides schema; misspelled key `spool.pollMS` -> `unrecognized_keys`; unknown section rejected; overrides output `{"schema_version":1,"spool":{"pollMs":250}}` (no injected defaults); JSON Schema `additionalProperties: false` per section |

---

## CHALLENGES

**C-1. Spool file extension (`data/spool/*.jsonl`, D3 and D8) breaks the legacy `audit` and `doctor`.** RESOLVED by I-02.
Evidence: `tasks.py:205-211` reports every `*.jsonl` inside a task workspace as `transcript copy found (never copy transcripts)` and makes
`audit` exit 1; legacy `doctor` runs that audit for every task. The critic's experiment X1 (2026-10-11) confirmed it: a
`data/spool/hooks-20261011T14Z.jsonl` made `$V audit` exit 1, the same file named `.ndjson` exit 0.
Resolution: segments are `hooks-<YYYYMMDD>T<HH>Z.ndjson` (`SPOOL_SEGMENT_EXT` in `shared/src/protocol/hook-envelope.ts`, design 02 2.7);
the lead annotates D3/D8. This document also keeps every other Node-created file out of `*.jsonl` (export path, 6.4/6.6).
T-XE-06 stays release-blocking.

**C-2. The legacy `configure` isolation snapshot hashes other tasks' runtime files.**
Evidence: `tasks.py:218-233` hashes every file of every other task except `state.json`, before and after `configure`
(`cli.py:153-156`), and reports `isolation violated ... (this is a bug)` with exit 1 when anything changed, after writing. A running
Node instance changes `data/monitor.db*`, `logs/*` and the spool continuously, so a legacy `configure` of another task can report a false
violation; it also reads whole databases twice (slow for large DBs). The Node `configure` excludes runtime-mutable paths (6.4 step 6), so
the problem is limited to `$V configure`. Alternative considered: store runtime data outside the workspace (rejected: D3, ownership and
cleanup become cross-folder). Mitigation in the main text: document it in `docs/troubleshooting.md` ("a legacy configure may report a false
isolation violation while a Node instance runs; the change was applied; verify with `inspect`") and prefer `$MCS configure` during the
transition; T-XE-07 records the behaviour.

**C-3. Merge rule for `runtime.json` sections (D4).** D4 says "merge per sub-key for panels|ui|poll|limits, replace for everything else".
Read literally, a `runtime.json` containing `{"retention": {"eventsDays": 60}}` would replace the whole skill-level `retention` section and
lose sibling values set in `runtime/defaults.json`. The main text applies the legacy principle (object sections merge per sub-key) to the
runtime sections (`R_MERGED`, 2.2) and keeps "replace" for lists and scalars. This is an interpretation, recorded here so it is not silent.

**C-4. D11 "no legacy endpoints unless Phase 1 shows a concrete need": one is needed.** Evidence: the legacy CLI decides liveness by
`GET <url>/api/health` returning the same `pid` (`cli.py:69-81`); without it, `$V start` against a running Node runtime declares it dead,
deletes `state.json` and starts a second monitor on the next port (research F.5). Proposal: the Node server keeps exactly one legacy
route, `GET /api/health`, returning `{ok: true, version, pid, started, uptime, now, code_stamp, engine: 'node', instanceId, task, config_source:
'task', errors: [], reader: {}}` (enough for `instance_alive` and for `$V status` to fail cleanly on the next endpoint). Owner: API design;
03 6.2 adopts exactly this key list as `LegacyHealth` (I-30, DA-T-API-11 asserts it against the legacy status reader).

**C-5. D6 "runs npm ci + build once" cannot always run.** Evidence E11: Windows refuses to delete a loaded native addon, and `npm ci`
deletes `node_modules`; while any runtime of the same install runs, `npm ci` would fail half-way and break every instance. The launcher
therefore refuses `npm ci` with `RUNTIME_IN_USE` and lists the instances to stop (5.1 step 6b); a build without `npm ci` is still allowed
(E11: JS files are not locked; the server holds its UI assets in memory).

**C-6. `MCS_HOME` (D4 "for tests") was not specified.** `04-ui.md` E2E sets both `MCS_HOME` and `CLAUDE_CONFIG_DIR`, so `MCS_HOME` cannot mean
the Claude home. Resolved with design 02 (2.6.1): a per-user monitor folder resolved by `resolveMcsHome(env)`; `CLAUDE_CONFIG_DIR` stays the
Claude home (legacy rule). Not a deviation, recorded because D4 lists it only as a test variable.

---

## Appendix A. Proposed `SKILL.md` (installed by the lead in Phase 6)

````markdown
---
name: monitoring-claude-sessions
description: Use when the user wants to watch, monitor or get a live view of running Claude Code sessions, unattended `claude -p` runs, subagents or workflows (what each is doing now, token use, which have finished or failed, progress of a long chain) without interrupting them, or asks to set up, change, inspect or stop such a monitor.
---

# Monitoring Claude Code sessions

## Overview
Claude Code writes every session (including `claude -p`, subagents and workflows) to a transcript while it runs, and can also send
lifecycle hooks. This skill creates a monitoring **instance** per task, a local read-only web page backed by a small database, fed by
hooks (when installed) and by the transcripts. It never changes how sessions are launched and never touches a running session.

Entry point: `node .claude/skills/monitoring-claude-sessions/scripts/mcs.mjs <command>` (call it `$MCS`). The first run installs and builds
the runtime (Node >= 22.22; about a minute once). Legacy engine (fallback): `python .claude/skills/monitoring-claude-sessions/template/viewer.py`
(`$V`), same commands.
Docs: `docs/operations.md` (commands, recovery), `docs/configuration.md` (keys, precedence, regex rules), `docs/instance-isolation.md`,
`docs/hooks.md`, `docs/api.md`, `docs/architecture.md`, `docs/migration.md` (legacy engine, rollback), `docs/decisions/`.

## When to use
- "What are my background sessions doing", "tokens per session", "which finished or failed", "progress of the chain".
- A major task the user wants monitored gets its own instance (`init`). A quick look can use `$MCS start` without `--task` (it creates
  and reuses a workspace named `default`).
- Not for: one finished session (read its transcript), money cost unless prices are configured (estimates only), other machines.

## Procedure (each step reports success only after checking; read the output before going on)
1. `$MCS discover --repo .` - transcripts folder, recent sessions with first prompt, log/ledger candidates, existing instances, hook status.
2. `$MCS init --name "<name>" [--description ...]` - creates `.claude/monitor/tasks/<slug>/` or reuses it (never overwrites). No name given:
   derive a short one from the task; do not ask.
3. `$MCS inspect --task <slug>` - read before changing: effective config, where each key comes from, last audit entries.
4. `$MCS configure --task <slug> --set KEY=JSON ... [--unset KEY] --reason "<why>" [--decision "..."]` - validated, audited, touches only this
   task. One `session_rules` entry per kind of session (Python regex syntax; unsupported constructs are refused with a reason);
   `chain_log` + `attempts` only if those files exist.
5. `$MCS audit --task <slug>` then `$MCS check --task <slug>`.
6. `$MCS start --task <slug>` - detached, loopback only, waits until the runtime answers its health check, prints the real URL; already
   running = reports it, never starts a second one. Give the URL to the user.
7. `$MCS verify --task <slug>`, then `$MCS status --task <slug>` (state counts, ingestion health, recent errors). Wrong or no sessions:
   fix the rule regex, `scope`, `window_hours`.
8. Optional live events: `$MCS hooks install --scope project-local` shows a plan; hooks change settings for every session reading that file,
   including running ones: get the user's consent, then rerun with `--yes`, then `$MCS hooks enable --task <slug>` and `$MCS hooks verify`.
9. Questions about results: `$MCS sessions list --task <slug>`, `$MCS usage --task <slug>`, `$MCS errors --task <slug>`,
   `$MCS verify-completion --task <slug> --label "<label>"` (exit 0 only with observed completion evidence).
10. Something off: `$MCS doctor --task <slug>`. Done or asked: `$MCS stop --task <slug>` (stops only a verified runtime of this task).
11. After the skill's code changed: `$MCS status` shows `outdated: true`; run `$MCS restart --task <slug>`, or
    `$MCS upgrade --task <slug> --restart` when start reports that the database needs an upgrade (backup first, audited).

## Answer these from the tools, not from memory
Which task and instance? `inspect`. Which sessions/agents and their state? `sessions list`, the page. Inherited or overridden? `inspect`
provenance. Last change and why? `inspect` recent audit. Healthy? `status`, `doctor`. Data current, stale or partial? `status`
ingestion fields, the page's connection and ingestion indicators. Finished? `verify-completion` (observed evidence only).

## Adapting to the request
| User wants | Change |
|---|---|
| only sessions about X | a `session_rules` entry (`match` = X; `"scope": "any"` if X is not in the first prompt) |
| older sessions | `window_hours` or `session_ids` |
| another repo | `repo`, and `transcripts_dir` if auto-detect fails |
| watch a script's log | `live_log_globs` |
| PASS/FAIL per run | `chain_log` + `attempts` (named groups `time part n model effort exit status`); this and SessionEnd evidence are what make a session COMPLETED/FAILED |
| live events | hooks (procedure step 8, consent first) |
| fewer panels, other look | `panels`, `ui` |
| keep data shorter or export it | `retention` in `runtime.json` via `configure`; `export`, `backup`, `cleanup` (dry run first) |
| go back to the old engine | `$MCS stop`, `$MCS instances set-engine --task <slug> legacy --yes`, `$MCS start` (docs/migration.md) |

## Rules
- Read-only towards Claude Code; bind `127.0.0.1` only. Host validation is a safeguard, not authentication. The database and the page
  hold prompts, file contents, possibly secrets: never expose the port, never copy transcript text into task files, audit entries or
  messages to other people.
- Session state, monitor health and data freshness are different things. A turn that ended is not a finished job; "completed" needs
  observed evidence. Never report a guess as fact; show partial or stale data as such.
- Hooks change user or project settings: consent first, dry run first, never in tests on real settings.
- Never delete a workspace, edit another task, or migrate a config without the user's explicit instruction. Destructive commands are dry
  runs until `--yes`.
- Do not tail a `claude -p` attempt log: it stays empty until the run ends.
- Changing the skill itself: read `docs/architecture.md` and `docs/testing.md`; run the checks; commit in the skill's own git repository;
  then restart the instances that should run the new code.

## Verify the skill (after any change)
From `<skill>/runtime`: `npm run ci` (typecheck, lint, format check, tests, build). Legacy engine: `python -m unittest discover -s tests` in `<skill>`.

## Common mistakes
| Mistake | Fix |
|---|---|
| Wrapping future launches (`stream-json` tee) for visibility | Not needed; it changes the user's run. Use transcripts or hooks. |
| Summing `usage` over every record | Dedupe by `message.id` (the runtime does; trust `usage`). |
| Calling a quiet session finished | Use `verify-completion`; only observed evidence counts. |
| Editing `config.json` or `runtime.json` by hand | Use `configure` so the change is validated and audited. |
| Killing a monitor by pid | Use `stop`; it verifies the process belongs to this task. |
| Installing hooks without asking | They affect every session reading that settings file, including running ones. |
| Using JavaScript regex syntax in rules | Rules use Python syntax (`(?P<name>...)`); the tool refuses what it cannot translate exactly. |
````

---

## Requirements covered

| Brief section | Bullets satisfied here |
|---|---|
| 2 (product identity, layer A) | discovery (`discover`), instance init (4.12), config create/validate (2), runtime version selection (5.2, 5.4), dependency install/verify (launcher 5.1), start/stop/inspect/upgrade/recover (4, 5), health checks and E2E verification (`verify`, `doctor`), task audit records (7), honest status (INV-10) |
| 4 (instances) | isolation contract with ids (3.1), ownership list (1.1, 3.3), separate process + storage per instance with justification (D2, 3.3), config precedence 1-4 + documented env (2.1, 2.10), versioned schemas + migration (2.6, 2.7), every required isolation test (3.5 T-ISO-01..27, release-blocking) |
| 12 (security, process/fs parts) | loopback (8.2), no exposure, path traversal and symlink handling (8.2), safe subprocess handling (INV-11), clear shutdown and restart (4.5, 4.10), monitoring failures do not block (hooks recursion guard, 8.2) |
| 13 (migration strategy) | legacy preserved and delegated (6.5), cross-engine rules (4.14), fallback path and rollback (5.6), upgrade from existing configuration (`config migrate --from-legacy`, adoption 4.12), tests with two instances (3.5) |
| 15 (documentation) | SKILL.md text (appendix A); sources for `docs/operations.md`, `docs/configuration.md`, `docs/instance-isolation.md`, `docs/migration.md`; ADRs 0001-0009 |
| 17 (execution protocol) | inspect before editing (legacy files read-only), never discard old config (INV-08/09), no fake success (INV-10), blockers documented (Open items) |
| 18 (definition of done) | still a skill (appendix A), explicit runtime/template versions (5.2), repeatable deterministic init (4.12), isolation tested (3.5), skill can initialize/inspect/start/stop/diagnose/verify (6.3), recovery procedures (4.13, 5.5, 5.6) |
| 8.9 / 8.10 (CLI, export, settings, retention) | CLI list incl. instances, init, health, sessions, state, errors, diagnostics, config validation, completion evidence (6.3; R-8.9.9 via 02 7.13 `explainCompletion`, I-08); export, backup, retention cleanup with scope + confirmation, version info, diagnostics report (6.4); configuration inspection as `ConfigInspection` for API and UI (6.4, R-8.10.1, I-20); recovery commands `db rebuild`, `ingest replay` (5.4, 6.4) |
| 8.3 (session detail) | project/task audit references: `entriesBetween` (7.1) feeding 03 `SessionDetail.auditRefs` (R-8.3.11, I-19) |
| 8.7 (analytics) | the trend gate `analytics.usageTrend` has a schema home with default `false` (1.6, R-8.7.10, R-13.3.2, I-01) |
| 7 / 11 (architecture, no duplicated logic) | one composition root for the server, the parity harness and in-process tests (4.4a, I-15); one process helper (4.2, I-06); one file-write primitive (1.2, I-28); one clock type (4.4a, I-36); one schema home for every `runtime.json` key (1.6, I-01) |

## Open items
1. POSIX control channel and mutex (Linux abstract socket, macOS lock-file fallback) are UNVERIFIED on this Windows machine. Plan: the
   05 CI matrix runs T-LC-01..16 and T-SEC-01 on Linux and macOS before release.
2. The negative control of E1 (a child spawned without `windowsHide` from a console-less parent shows a window) was deliberately not run.
   Plan: run it once on a CI Windows runner (T-LC-13b) where a window is harmless; the design does not depend on its outcome.
3. Plug-in contracts this document names and other designs implement (each owner adds the named export; this document already
   specifies the call site, so nothing here waits on a decision):
   - 02: `createIngestService(ctx) -> { start, stop, untilIdle, replay, stats }`, `createLifecycleSweeper(ctx) -> { start, stop, tick }`,
     `replaySpool(db, scope, { fromSegment, nowMs })`, `SPOOL_SEGMENT_RE` / `SPOOL_SEGMENT_EXT`, `explainCompletion(queries, target)` with
     `CompletionTarget` / `CompletionEvidence` (02 7.13, I-08), `IngestStats`; 02 3.1 nests its hooks `--json` object as envelope `data`
     and uses the 7.2 `hooks-install` template; 02 3.5 step 1 uses `acquireMutex(mutexName('settings', path))` (I-29).
   - 03: `createQueries(db, { config, now, process? })` accepting `RuntimeProcessInfo` (4.4a) and reading `childStats()` / panel stats for
     `HealthReport.children` / `.panels` (I-21); `createMaintenanceScheduler(ctx)` for the 11.4 timers; `LegacyHealth` adopts the C-4 key
     list (I-30); `server.devOrigins` dropped (I-31); `GET /api/v3/config` serves `toConfigInspection(ctx.config, 'node')`.
   - 06 PP1: `ChildKind` += `'node' | 'python' | 'icacls' | 'opener'`, `ExecutableName` += `'python' | 'icacls' | 'opener'`,
     `spawnDetached`/`spawnForeground` as in 4.2, `forceKill` + `waitForExit` replacing `killPid`; 06 4.3 step 5 defers to
     `writePyJsonFile` (I-28); the 06 7.1/7.2 runbook uses `backup restore --id`, `db rebuild`, `cleanup --scope`, `export
     --include-content`, `backup.keep` and the HealthReport fields of 03 (I-12); the 06 lint rule on `process.platform` allows
     `platform/**` (I-34).
   - 04: `ConfigInspection.entries[].source` (not `provenance`) and the `ConfigFileStatus` superset (6.4).
   - 05: S-LOG-6 rotation constants (I-25), ADR 0047 references the `bootstrap` mutex name (I-24), `tooling/env-vars.test.ts` (I-27),
     npm script `migrate` = `node packages/cli/dist/main.js db migrate` (I-26).
   Verification: the lead's Phase 1 reconciliation greps each named export in the owning design; Phase 2 contract tests
   (`instance-runtime.test.ts`, `runtime-sections.contract.test.ts`, T-CLI-05) fail on any mismatch.
4. Lead annotations of foundations (no behaviour here depends on the outcome): D7 Node floor 22.12 -> 22.22.0 (I-05); D3/D8 spool
   `data/spool/*.jsonl` -> `*.ndjson` (I-02).
5. Cross-design names the lead decides at reconciliation (this document's proposal in brackets):
   - design 06 asked for `runtime.json` keys `attempts.windowHours` and `panels.machine.processIntervalMs`; `attempts` and `panels` are L
     keys, so the shared routing rule (top-level name decides the file) would send them to `config.json` [R section `panelOptions`:
     `attemptsWindowHours`, `machineProcessIntervalMs`];
   - design 06 assumed `compilePythonRegex(pattern, { purpose })` returning `RegExp` and error `E_REGEX_UNSUPPORTED` [`compilePyRegex(source,
     ctx).regex` / `.exec()`, `McsError` code `REGEX_UNSUPPORTED`], `initInstance(repo, slug, options)` [`ops.workspace.init(ctx, InitInput)`],
     "start adds runtime.json" [`runtime.json` is optional and created only by `configure`/`config migrate`];
   - `04-ui.md` S-8 `runtime.json tasks[]` vs design 02 `board.items` [`board.items`].
No other open item: every other behaviour above is specified and has a test.

## Phase 2+ task slices (dependency order; each slice is independently testable; files are under `<skill>/runtime/` unless stated)

Global order (critic slicing notes, 99 section 3): 05 S1 -> 01 S1 -> {01 S2, 01 S3, 02 I-1, 03 S3, 05 S2} -> 03 S1 -> {01 S4 with 06 PP1,
05 S6} -> 01 S5, S6 -> 03 S2 -> 02 I-3, I-5, I-6, I-7 -> 01 S8 -> 03 S4, S5 -> 02 I-4, I-8 -> 01 S9 -> ... -> 01 S11..S15 -> 01 S16.

| # | Slice | Owns (files) | Depends on | Done when |
|---|---|---|---|---|
| S1 | Shared contracts | `packages/shared/src/{ids.ts,errors.ts,version.ts,time.ts,env.ts}`, `files/{instance,state,backup-manifest}.ts`, `config/runtime/{section,index,server,process,logging,backup,lifecycle,hooks,ingest,import,spool,health,analytics}.ts` (schema modules of 1.6, including the 02/03 sections, I-01), `cli/{envelope,results}.ts` (incl. `ConfigInspection`, `toConfigInspection`), `protocol/control.ts` | 05 S1 scaffold | `runtime-sections.contract.test.ts`, `derived-defaults.test.ts`, slug rules, `R_TOP_KEYS` disjoint from L keys, `RUNTIME_VERSION` = package version, `DOCUMENTED_ENV_VARS` complete (05's `env-vars.test.ts`) |
| S2 | PyJson | `packages/engine/src/pyjson/*`, `tests/legacy-parity/pyjson/*` (generator + golden JSON) | S1 | E6 golden 0 mismatches; round-trip property tests |
| S3 | Python-regex translator | `packages/shared/src/pyregex/*`, `tests/legacy-parity/regex/*` | S1 | goldens and rejects (2.8) pass; V9 replica + opt-in live check |
| S4 | Platform: mutex and markers | `packages/engine/src/platform/{mutex,markers}.ts` (exec.ts and process.ts are 06 PP1, delivered in the same step with the 4.2 additions, I-06) | S1, 06 PP1 | mutex contention test (E10 as a test), `mutexName` table test, marker table test (backslashes, case, other instance id), `listRuntimeProcesses` finds a spawned test server and not an impostor, T-LC-16 |
| S5 | Config resolution | `packages/engine/src/config/{defaults,merge,validate-legacy,resolve,provenance,migrations}.ts` | S2, S3 | 2.x unit tests, legacy validation message goldens, C-3 merge tests, derived defaults (1.6) |
| S6 | Workspace + audit | `packages/engine/src/workspace/{fsio,paths,init,adopt,list,repair,snapshot}.ts`, `audit/{writer,reader}.ts` (`entriesBetween`, I-19) | S2, S4, S5, 06 PP1 `fsx.ts` | T-LC-10/11/12, T-AU-01..06, T-ISO-01/02/06/07/21, E5 retry cases as tests through `writeWorkspaceFile` |
| S7 | Ops: config/audit commands | `packages/engine/src/ops/{config,audit}.ts`, `packages/cli/src/commands/{init,inspect,configure,decide,audit,check,discover}.ts`, `packages/cli/src/{main,render/*}.ts` | S5, S6 | T-CLI-01/03/04, `config-inspection.test.ts`, T-XE-01/02 |
| S8 | Server lifecycle shell + composition root (I-15) | `packages/server/src/{main,boot,control-channel,shutdown,state-file}.ts`, `packages/engine/src/runtime/{context,instance-runtime,error-ring,state-watchdog,test-hooks}.ts` (+ the `/api/health` compat route if C-4 is accepted; owner of the route body is 03) | S4, S5, 03 S1 (DB open), 02/03/06 factories as stubs until their slices land | `instance-runtime.test.ts`, `context.test.ts`, `ingest-until-idle.int.test.ts` (with 02's service once I-4 lands; with a fake service before), T-LC-03/04/05/07/14 |
| S9 | Ops: lifecycle | `packages/engine/src/ops/lifecycle.ts`, `probe.ts`, CLI `start stop status restart verify serve` | S7, S8, 06 PP1 (`forceKill`, `commandLineOf`) | T-LC-01/02/06/08/09/13/15, T-ISO-13/14/18/19/20/22 |
| S10 | Launcher | `<skill>/scripts/mcs.mjs` (with its zero-dependency mutex, runtime listing and spawn copies, 5.1) | S9, 05 stamps | T-UP-01..04/10, `launcher-parity.test.ts` |
| S11 | Instances, doctor, diagnostics | `ops/{instances,diagnostics}.ts`, CLI `instances doctor diagnostics errors version` | S9 | T-CLI-09, T-SEC-02, doctor checks |
| S12 | Backup, upgrade, cleanup, db rebuild | `ops/{backup,upgrade,cleanup}.ts` (incl. `rebuildDb`), CLI `backup upgrade db config migrate cleanup` | S9, 03 migrations/backup | T-UP-05..09, T-ISO-24..27, T-CLI-06, T-CLI-12 |
| S13a | Data readers | `ops/data.ts`, `reader/{api-reader,db-reader}.ts`, CLI `sessions usage export` | S9, 03 S5 queries | T-CLI-05 (all methods except `explainCompletion`), T-CLI-13, T-ISO-09..12 |
| S13b | Completion evidence | `reader/*` `explainCompletion` wiring, CLI `verify-completion` | S13a, 02 I-7b (`explainCompletion`, I-08) | T-CLI-08, T-CLI-05 for `explainCompletion` |
| S14 | Hooks and ingest CLI wrappers | `ops/{hooks,ingest}.ts`, CLI `hooks *`, `ingest replay` | S8 (control op), 02 installer and `replaySpool` | T-CLI-10, T-CLI-11, hooks tests owned by 02 |
| S15 | Legacy delegation + cross-engine | `ops/legacy.ts`, `tests/legacy-parity/cross-engine/*` | S9 | T-XE-03..07, T-ISO-23, T-CLI-07 |
| S16 | Schemas + SKILL.md + docs | `runtime/scripts/gen-schemas.mjs`, `<skill>/schemas/*`, appendix A -> `<skill>/SKILL.md` (lead, Phase 6), operations/configuration/instance-isolation/migration doc sections | all | schema drift test, docs reviewed against the commands' `--help`, env docs test (2.10) |

Isolation suite (T-ISO-*) is wired as the scaffold's `isolation` project and is release-blocking (brief section 4).
