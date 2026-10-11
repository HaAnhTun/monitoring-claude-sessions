# 0005 Instance control channel: a named pipe (Unix socket on POSIX) as lock, identity probe and graceful shutdown

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` sections 4.2-4.5, 4.9, 8).

## Context
Three needs: (1) exactly one runtime per instance, with a lock that cannot go stale after a crash; (2) a cheap, reliable way to ask
"is this pid my runtime?" (pids are reused); (3) a graceful stop on Windows, where `SIGTERM` via `process.kill` and `taskkill /F`
terminate immediately and plain `taskkill` refuses console-less processes. A shutdown endpoint on HTTP would put a mutating operation on
the surface that browsers can reach (DNS rebinding, CSRF).

## Decision
- Each runtime listens on `\\.\pipe\mcs-<instanceId>` (Windows), the Linux abstract socket `\0mcs-<instanceId>`, or
  `<tmpdir>/mcs-<uid>/<instanceId>.sock` (other POSIX) before touching any data. `EADDRINUSE` = another runtime holds the instance
  (exit 12). The OS frees the name when the process dies.
- Protocol: one JSON line per connection; `identify` (no token, no secret: instanceId, pid, phase, versions, port, url), `shutdown`,
  `backup` and `ingest-replay` (revision 2, critic issue I-29) require `instanceId` + the 256-bit token from `run/control.token`,
  compared with `timingSafeEqual`.
- `stop` = `shutdown` + wait; forced kill only after the command line shows this instance's marker (ADR 0006).
- The same OS-released mutex primitive (`ProcessMutex`, names `mutexName('task' | 'bootstrap' | 'settings', key)`) serializes
  workspace writes, the launcher bootstrap and the hook installer's settings-file update.

## Consequences
- No stale lock files on Windows/Linux; no HTTP mutation for lifecycle; `status` and `stop` need no PowerShell on the normal path.
- macOS uses a socket file/lock file with a documented stale-detection race (UNVERIFIED, CI).
- Other local users cannot send requests (pipe DACL), but can keep pipe instances busy (local denial of service; token still required).

## Alternatives rejected
- PID lock file: stale after crashes; breaking stale locks races; needs command-line checks on every start.
- Authenticated HTTP `POST /shutdown`: reachable by browsers; needs CSRF and token handling in the web surface.
- `taskkill /F` only (legacy): no graceful DB checkpoint, state cleanup or spool offset flush.
- SQLite `locking_mode=EXCLUSIVE` as the lock: blocks every other reader including backups and diagnostics.

## Evidence (2026-10-11, Windows 11, Node v24.14.1)
- `D:/mvp/private/scratch/mcs-v3/instances-ops/e3/run.mjs`: SIGTERM -> gone at once, no handler; `taskkill` without `/F` -> exit 1
  "can only be terminated forcefully"; second listener on the same pipe -> `EADDRINUSE`; `identify` 69 ms; wrong token -> FORBIDDEN;
  `shutdown` 52 ms + exit 10 ms later with handlers run; pipe and port reusable immediately after `taskkill /F`; absent pipe -> `ENOENT`.
- `e3/mutex.mjs` x5: never more than one holder.
- `e3/pipe-acl.mjs`: DACL owner/Administrators/SYSTEM full control, Everyone/Anonymous `Read, Synchronize`.
