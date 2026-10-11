# Changelog

## 2.0.2 (2026-10-11)
- **UI:** the session list is now first in the sidebar on desktop too (it was below the panels, so it needed scrolling); DOM order equals visual order, so tab order is natural on every width.
- **Tools:** `tests/tools/demo.py` builds a made-up demo project (all five states, a workflow with subagents, a huge transcript for the partial view) and `tests/tools/screenshots.mjs` captures the UI from it with headless Chrome (Node only, no packages).

## 2.0.1 (2026-10-11)
- **CPU:** the machine panel spawned `tasklist` on every poll (about 0.7 s of CPU per call, roughly a third of a core with one tab open); replaced by Win32 calls (about 16 ms). Git/overview results are cached 10 s instead of 4 s. Measured afterwards: no client 0.10% of one core (27 MB), one tab about 3-4% (33 MB), three tabs about 4.4%.
- Helper processes no longer open console windows (CREATE_NO_WINDOW).

## 2.0.0 (2026-10-11)
Second major version: reliability, task workspaces, new UI.

- **Structure:** single 906-line `viewer.py` split into `src/backend/*` (config, tasks, reader, state, sessions, panels, server, cli) and `src/frontend/*` (ES modules, no build, no CDN). `template/viewer.py` stays the entry point; v1 flags and endpoints still work.
- **Correctness:** states RUNNING/IDLE/COMPLETED/FAILED/UNKNOWN from evidence (a quiet `end_turn` session is IDLE, never "done"); incremental reader with partial-line, truncation/replacement, invalid-line and oversized-record handling; progressive token scan reported as partial until complete; `completeness` per session; health endpoint and server error ring; stale-but-valid cache on recompute failure.
- **Tasks:** per-task workspaces with audit trail, schema versions, validated `configure`, isolation checks, idempotent `start`, stale-pid-safe `stop`, `doctor`.
- **UI:** design tokens, light/dark, density, responsive, health/freshness bar, partial/stale/error/empty states, follow control that respects manual scrolling, search/filter/jump, grouped subagents, keyboard support. Decision record: `ui-decision-record.md`.
- **Fixed on the way:** old viewer held events for every transcript (218 MB measured with 315 files, now about 48 MB); an `os.kill(pid, 0)` style liveness check would have killed processes on Windows (replaced by `OpenProcess`); first-paint layout shift 1.04 -> 0.001.

Measured on this machine (Windows 11, 315 transcripts in the project folder, largest 70 MB; numbers are examples, not guarantees): first `/api/sessions` 3.4 s (progressive scan of all files), later calls 0.25 s uncached and about 2 ms cached; RSS about 48 MB. Lighthouse (mobile, a task workspace with real data): accessibility 100, best practices 100, SEO 100.

Not verified: Linux/macOS (machine panel and pid checks), screen-reader behaviour, Firefox/Safari, contrast ratios beyond Lighthouse's automated check, runs with transcripts from other Claude Code versions than 2.1.289/2.1.296.
