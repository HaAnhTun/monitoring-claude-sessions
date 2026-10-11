# ADR 0058: Atomic file replace retries on Windows sharing violations; readers read and close

Status: Proposed (Phase 1, 2026-10-11; amended after the critic review, issue I-28). Design reference:
`docs/design/06-panels-parity-platform.md` section 4.3; design 01 sections 1.2 and 1.9 (ADR 0003).

## Context
`state.json`, `config.json`, `task.json` and runtime files are shared with the legacy CLI, editors and antivirus scanners. The runtime
writes them atomically (temp file + rename). On Windows a rename over a file that another process holds open fails.

## Decision
- One module for the whole engine: `engine/src/platform/fsx.ts`. Design 01's `workspace/fsio.ts` is a thin wrapper over it (workspace
  link checks, `McsError` mapping, universal newlines, PyJson); no second atomic-write or retrying-read implementation exists.
- `atomicWriteFile(file, data, { budgetMs: 3000 })` (bytes in, bytes out; never serializes): write `file.<pid>.<rand>.tmp` in the same folder
  with `wx`, `fsync`, close; rename; on `EPERM | EBUSY | EACCES` retry with delays 50, 100, 200, 250, 250 ... ms until the budget;
  then delete the temp file and throw `E_ATOMIC_WRITE_BUSY` (other errors `E_ATOMIC_WRITE_IO`).
- Shared legacy JSON files (`task.json`, `config.json`) are serialized only by design 01's `writePyJsonFile` (PyJson, ADR 0003), which
  writes through `atomicWriteFile`. `JSON.stringify` is never used for them (01 E6: it differs from Python on 3,340 of 26,016 number
  lexemes).
- Runtime readers use `readSmallFile` (open, read, close; `EPERM | EACCES | EBUSY` retried 10 x 20 ms, 01 E5) and never keep shared
  files open.
- `mcs cleanup --scope stale-state` deletes `*.tmp` older than 10 minutes in a workspace (design 01 4.13, 6.4).

## Consequences
- Short reads by other programs no longer fail writes; a holder longer than 3 s produces a clear error code (troubleshooting T13).

## Alternatives rejected
- Write in place: torn files on crash. Rename without retry: random `EPERM` under antivirus or a concurrent legacy CLI.
- Infinite retry: a hung editor would block a CLI command forever.
- Two modules (`fsx.ts` async 3000 ms and `fsio.ts` sync 2000 ms): two retry policies to test and audit (critic I-28).
- `JSON.stringify(v, null, 2)` for shared files: not byte-compatible with Python (INV-02, gate G8).

## Evidence
2026-10-11, Node 24.14.1, Python 3.14.3, NTFS: `winfs.mjs` (E10): rename over a target held by Python -> `EPERM`, retry succeeded after
the reader closed (52 attempts, 3,030 ms); target held by a Node fd -> `EPERM`; Python `os.replace` while Node holds -> `PermissionError` 5.
Design 01 E5 (same date): a Python reader racing replaces saw `PermissionError` on 5,702 of about 18,000 reads; design 01 E6: 3,340 of
26,016 number lexemes differ between `JSON.stringify` and Python `json.dumps`.

## Requirements covered
Brief 12 (reliability), 4 (isolation contract: no partial writes of shared files).

## Open items
None.

## Phase 2+ task slices
PP1. Slice table: design section 13.
