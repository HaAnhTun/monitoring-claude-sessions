# Changelog

## 2.0.0 (2026-10-11)
Second major version: reliability, task workspaces, new UI.

- **Structure:** single 906-line `viewer.py` split into `src/backend/*` (config, tasks, reader, state, sessions, panels, server, cli) and `src/frontend/*` (ES modules, no build, no CDN). `template/viewer.py` stays the entry point; v1 flags and endpoints still work.
- **Correctness:** states RUNNING/IDLE/COMPLETED/FAILED/UNKNOWN from evidence (a quiet `end_turn` session is IDLE, never "done"); incremental reader with partial-line, truncation/replacement, invalid-line and oversized-record handling; progressive token scan reported as partial until complete; `completeness` per session; health endpoint and server error ring; stale-but-valid cache on recompute failure.
- **Tasks:** per-task workspaces with audit trail, schema versions, validated `configure`, isolation checks, idempotent `start`, stale-pid-safe `stop`, `doctor`.
- **UI:** design tokens, light/dark, density, responsive, health/freshness bar, partial/stale/error/empty states, follow control that respects manual scrolling, search/filter/jump, grouped subagents, keyboard support. Decision record: `ui-decision-record.md`.
- **Fixed on the way:** old viewer held events for every transcript (218 MB measured with 315 files, now about 48 MB); an `os.kill(pid, 0)` style liveness check would have killed processes on Windows (replaced by `OpenProcess`); first-paint layout shift 1.04 -> 0.001.

Measured on this machine (Windows 11, 315 transcripts in the project folder, largest 70 MB; numbers are examples, not guarantees): first `/api/sessions` 3.4 s (progressive scan of all files), later calls 0.25 s uncached and about 2 ms cached; RSS about 48 MB. Lighthouse (mobile, a task workspace with real data): accessibility 100, best practices 100, SEO 100.

Not verified: Linux/macOS (machine panel and pid checks), screen-reader behaviour, Firefox/Safari, contrast ratios beyond Lighthouse's automated check, runs with transcripts from other Claude Code versions than 2.1.289/2.1.296.
