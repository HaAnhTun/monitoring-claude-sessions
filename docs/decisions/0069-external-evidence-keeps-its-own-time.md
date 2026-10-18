# 0069 External evidence keeps the time its source recorded, and a daemon job never outlives later activity

Status: Accepted (V4 planning, 2026-10-18). Owner: area C1 (correctness fixes), work package WP-97. Amends ADR 0018 (the stamp of external facts and decision rule S-4) and design 02 sections 7.3, 7.4 and 7.10. It supersedes nothing: the fact semilattice, the decision tables, the evidence wording and the rule that `completed` needs observed evidence stay in force. The matching edits of design 02 are made in the V4 documentation rewrite.

## Context

- Observation of 2026-10-18: a monitor was started on transcripts that were six days old. Two sessions showed `completed` (rule S-4a, basis observed, confidence high) with the evidence "daemon job done 28s ago" and `since` equal to the moment the monitor started, although both sessions had ended six days before.
- Cause, reproduced on a copy of the reader (a job file six days old, one poll): `createJobsReader` stamps every `external.job` event with `observedAt: now`, the time of the read. The fact register `job` is a last-writer-wins register on that stamp, the view takes `since` from the first evidence item (`since = evidence[0].at`), and the evidence text is rendered as `now - at`. So the age shown is the age of the read, `since` is the time of the read, and both move at every restart. The rule itself (a job that says `done` completes the session) is correct; only the time was wrong.
- Real daemon job files (`<claude home>/jobs/<id>/state.json`, four inspected on 2026-10-18, key names and value formats only) carry `createdAt`, `updatedAt`, `firstTerminalAt` and `lastTerminalAt` as ISO-8601 UTC text with milliseconds. The V3 test fixture wrote epoch milliseconds into `createdAt` and `updatedAt` only, so no test ever saw the real shape, and the V3 unit test pinned the bug (`observedAt` equal to the reader's clock).
- Rule S-4 has no counterpart of the `reopened` rule of S-3 (SessionEnd followed by later activity). With a read-time stamp that gap was invisible because the job always looked newer than any activity; with the true time it becomes visible: a session that a job finished and that was resumed afterwards would stay `completed` for ever.
- A third consequence of a historical stamp: the writer uses the time of an external event as the first-seen time of a session it opens, and `sessions.started_at` is a minimum. A job time older than the first record of the session (clock skew, a copied file) would lower the start of the session.

## Decision

1. An external reader stamps an event with the time its source recorded for the observed state. The read time is used only where the observation is about the moment of reading: process liveness (`external.pid`, `checkedAt`), the registry status of a live process, and the publication tick of the attempts panel. The registry reader and the pid checker keep their read-time stamps.
2. The daemon job reader takes the time of an event from the job file in this order: for a terminal state (`done` and the failure states of S-4b) `lastTerminalAt`, then `firstTerminalAt`, then `updatedAt`, then `createdAt`; for any other state `updatedAt`, then `createdAt`; then the modification time of `state.json`. A time is read as ISO-8601 text or as epoch milliseconds, a value that is neither is skipped, and a time later than the read time is clamped to the read time (clock skew). A file with no usable time and no readable modification time is counted as unreadable (`EXTERNAL_READ_FAILED`) and produces no event: it is never "just now".
3. The reader announces a job again when its state or its time changed, not only its state, so a job that finished a second time re-announces.
4. S-4 is superseded by later activity, with the same shape and the same tolerance as the `reopened` rule of S-3: when the newest of `lastActivity` and `lastHookAt` is later than the stamp of the job fact by more than `lifecycle.reopenToleranceMs`, the job fact is ignored by the decision table (S-4a and S-4b are skipped). The condition reads facts only, so S-4a stays time-invariant for `nextCheckAt`. One exported predicate (`isJobSuperseded`) is the single implementation; `explainCompletion` (design 02 7.13) uses it too.
5. An external event never lowers the first-seen time of a session: the writer opens the session of a job event with the write time, not with the time of the job.

## Consequences

- The evidence line and `since` show the real age ("daemon job done 6d ago"), they do not change at a restart, and a restart re-announces the same stamp, which is idempotent in the semilattice.
- A session that a job finished and that was resumed afterwards leaves `completed` (it falls through to S-5..S-10) as soon as the later activity is ingested, in both delivery orders.
- Property P5 (missing evidence never completes a session) and P9 (Stop is not SessionEnd) are unchanged: the rule still needs a job fact whose state is `done`.
- Tests change: the V3 assertion that pinned the bug is replaced by an assertion on the job file's own time, and the job fixture writes the real shape (ISO text and the terminal fields) with an option for epoch milliseconds.
- The UI evidence line (UI review R-03) can show the job time honestly; no UI change is needed for correctness.
- Cost: the job reader depends on three time field names of a Claude Code daemon file that is not a documented interface. The fallback chain (`updatedAt`, `createdAt`, modification time) keeps the reader working when a name changes; a failure state name that was never observed (S-4b) stays UNVERIFIED as in design 02.

## Alternatives rejected

- Keep the read time and add an "observed late" marker to the evidence: leaves `since`, the age and the restart behaviour wrong, and adds a second notion of time to every consumer.
- Use the modification time of `state.json` only: it moves when anything touches the file (a copy, a backup restore) and is less precise than the field the daemon writes.
- Ignore job files older than some number of days: hides true evidence of a finished session.
- Treat a job `done` as inferred instead of observed: the daemon states the fact itself; the defect was the time, not the trust.
- Decide the supersede rule inside the job reader (drop the event when the transcript is newer): the reader does not know the session facts, and the same condition must hold for a job event that arrives before the later activity (order independence, property P2).

## Evidence

- Probe of 2026-10-18: a copy of `external/jobs.ts` (imports stubbed) read a job file whose terminal time was six days old; the emitted event had `observedAt` equal to the clock of the reader (difference 0 ms). The step from that stamp to `since` and to the evidence age is by code reading (`deriveSession`, `viewOf`, `renderEvidence`), not by a run.
- Shape of four real job files (key names and value formats only, no values): the four time fields are ISO-8601 UTC text with milliseconds; file modification times were six to eight days old.
- Code reading at main 8ca9475: `external/jobs.ts` (`observedAt: now`), `lifecycle/facts.ts` (`job` register stamped by `observedAt`), `lifecycle/rules.ts` (`viewOf`: `since` from the first evidence item), `lifecycle/derive-session.ts` (S-4 without a reopen guard), `ingest/writer.ts` (`atOf` returns `observedAt` for `external.job`), `db/repos/sessions.ts` (`started_at = min(...)`).
