# ADR 0050: Windows per-process memory through a one-shot hidden PowerShell, sampled on demand every 20 s

Status: Proposed (Phase 1, 2026-10-11). Design reference: `docs/design/06-panels-parity-platform.md` sections 3.5, 3.7.3.
Closes foundations open question 2 (first part).

## Context
The legacy machine panel reads per-process working sets through Win32 calls via `ctypes` (`panels.py:123-157`, about 16 ms). Node has
no built-in for other processes' memory (`process.memoryUsage` is self only), the brief forbids a new native dependency without strong
reason, and there is no C/C++ compiler on the machine (`stack-versions.md`). The legacy engine costs 3-4% of one core with one tab open
(changelog 2.0.1); the panel must not exceed that.

## Decision
- Process list on Windows: one-shot `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <fixed script>`
  through `execFileText` (ADR 0051). Script: .NET `[System.Diagnostics.Process]::GetProcesses()` printing `name<TAB>pid<TAB>WorkingSet64`
  in UTF-8; fallback script `Get-Process | ForEach-Object {...}` when the session is in Constrained Language Mode. Filtering by
  `watched_processes` happens in Node; no config value enters the script.
- Sampling is demand-driven (only when `/api/v3/panels/machine` is requested), single flight, stale-while-revalidate, at most once per
  `runtime.json` `panelOptions.machineProcessIntervalMs` (default 20000, range 10000-300000; design 01 naming). Memory and CPU totals come from `os.totalmem`,
  `os.freemem`, `os.cpus()` every request older than 1.8 s.
- PowerShell missing or blocked: source `unavailable`, retried after 5 min; the rest of the panel works.

## Consequences
- About 190 ms child CPU + 8 ms Node CPU per sample: about 1% of one core while a client watches the panel, 0 without clients.
- Per-process numbers can be up to 20 s old; the response carries `procsSampledAt`.
- Names come from the configured spelling (case may differ from the legacy `szExeFile`).

## Alternatives rejected
- `tasklist /FO CSV /NH`: 110-190 ms child CPU plus 128-182 ms unexplained Node-side CPU per call, locale-formatted numbers.
- Persistent PowerShell helper: 16 ms per query but 73 MB growing to 142 MB resident after 25 queries.
- `Get-CimInstance Win32_Process`: 281 ms plus WMI service CPU. `pwsh` 7: 391 ms and not always installed. `wmic`: absent.
- Native addon / FFI package: new native dependency, build toolchain, supply-chain surface.

## Evidence
2026-10-11, Windows 11 Pro 10.0.26200, Node 24.14.1, Windows PowerShell 5.1, scripts in `D:/mvp/private/scratch/mcs-v3/panels-parity/`:
`measure-child.ps1` (E1), `spawn-cost2.mjs` (E2), `persistent-ps.mjs` (E3), `proclist-final.mjs` + `measure-enc.ps1` (E4: 187.5 ms median,
250 ms max child CPU; `WorkingSet64` of the measuring process 53.6 MB = its `rss` 53.7 MB), `memcmp.py` (E5), `cpu-node.mjs`/`cpu-py.py` (E6: 13% vs 13%).

## Requirements covered
Brief 8.1 (metrics with defined source and freshness), 12 (resource limits, safe subprocesses), foundations open question 2.

## Open items
None. Constrained Language Mode and AppLocker paths are designed but UNVERIFIED (no such machine); verification plan in design 3.7.3.

## Phase 2+ task slices
PP1 (exec additions), PP7 (machine panel). Slice table: design section 13.
