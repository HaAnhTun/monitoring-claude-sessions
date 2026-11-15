# 0090 Terminal link and resume

Status: Accepted (CAW, 2026-11-15). Owner: projects area (prj), work package CAW-30 (design 03, sections 5 and 6). Relies on 0079 (the terminal is active), 0083 (the terminal service),
0088 (all-projects ingestion) and 0089 (the project dimension and the folder model); changes none of them. The wiring (who calls `track`, `forget` and `planResume`) is the user services
of the lifecycle area (CAW-31); the sidebar rows that show the link are the web packages.

## Context

A terminal of this app runs a real `claude`, and the monitor already follows sessions from their transcripts. The sidebar shows one row per terminal with the state and the tokens of its
session, so the app has to know which monitored session a terminal's process is. `claude` offers no way to choose its session id (there is no `--session-id` in 2.1.289), the user
instance runs without hooks (so the hook environment of 0019 does not exist), and on this machine `claude` is an npm `.cmd` shim, so the root process of the terminal is `cmd.exe` and the
`claude.exe` that writes the registry entry is its child. What is available as evidence: the Claude registry (`<claude home>/sessions/<pid>.json`: pid, session id, working folder, start
time, kind, status), the transcript files, and the process table. The same decision has a second half: "resume in terminal" must say whether `claude --resume <id>` may run, where, and
what to do when the session is already open somewhere.

## Decision

1. **The registry is the evidence.** The linker reads `<claude home>/sessions/<pid>.json` through `createRegistrySnapshot` (one read of the folder is shared for a second by the link, the
   resume check and the lifecycle poller). Only `pid`, `sessionId`, `cwd`, `startedAt`, `updatedAt`, `kind`, `entrypoint`, `status` and `waitingFor` are used, the parsing is loose (a status
   this version does not know never hides an entry), a file is read only under the name `<pid>.json` and at most 64 KiB, `.key` files are never opened, and the registry `name` (it can
   carry text of a prompt) and `procStart` (a format nobody has verified) are never read.
2. **The pre-filter** (`link/rules.ts`, pure) says which entries are worth testing for a terminal: the process lives and is not a background session, the id is a session id, no linked
   terminal holds the pid, the entry is new (`startedAt` is at or after the spawn time less `projects.linkStartToleranceMs`; an entry with no start time is not proved old), and its `cwd`
   is the folder of the terminal (the key of the folder helpers, so separators, case, a trailing separator and `/mnt/d` do not matter; when the keys differ, the real paths decide, and only
   when both are known). The resume id exception: a terminal that resumes a session without a fork accepts the entry of that very session whatever its start time says, because the
   registry may carry the start of the original session. After the fast window the folder test is dropped for the tree rung, at most once per slow tick, so that a `cwd` spelled in a way
   neither the key nor the real path reads (a short name, a substituted drive) still links through the tree.
   The real path is asked of the file system only for a folder that `windowsFolderPath` accepts, in the spelling it returns: the `cwd` of an entry is data from a file any process of the person
   may write, and a UNC or device path makes Windows contact another machine (NTLM) and can stall the pass, which waits for the real paths before it decides. A folder that cannot be a local
   folder is not asked about, not remembered, and read as unknown (it never matches by real path).
3. **The confidence ladder.** A candidate is published only after the ladder ran; there is no optimistic link that is taken back.

   | Rung | Test | Basis | Confidence |
   |---|---|---|---|
   | A | the pid of the entry is the root pid of the terminal (`claude.exe` started directly) | `registry-pid` | high |
   | B | the process table says the entry is a descendant of the root (`cmd.exe` to `claude.exe`) | `registry-tree` | high |
   | B- | the table is readable and the entry is a descendant of no pending terminal: a `claude` the person started by hand in the same folder, dropped | none | none |
   | C | the table is unreadable; one terminal and one candidate in the folder | `registry-cwd` (`resume-id` for a resume) | medium |
   | D | the table is unreadable; k terminals and k candidates, paired by order (spawn time against start time) | `registry-order` | low |
   | E | the table is unreadable; the counts differ | status `ambiguous`, reason `ambiguous` | none |

   Rung A skips the folder test (a root pid is ours by construction) but keeps the rest of the pre-filter, because the system may have reused the pid of a process that left a stale file.
   Several descendants of one root (a `claude` that the claude started) give the earliest start, then the lowest pid. C, D and E never use the relaxed pass: a weak rung without the folder
   would link anything. Terminals are compared one folder at a time and an entry given to one terminal is not given to another; the same facts give the same answer in any order.
4. **The process table is a seam.** `ProcessTreePort.descendants(rootPid)` answers a set or `null` (unavailable); the real answer is `listDescendantPids` of `platform/process.ts` (one
   constant PowerShell query, about 0.3 s, filtered in Node). This area writes no second process lister. The linker asks only when a pre-filtered candidate exists that rung A did not
   decide, once per pending terminal of the folder and decision, remembers the answer for 1.5 s and a failure for 5 s (a machine that cannot list processes is not asked every second), and
   lets calls that overlap share one question; a rejection is `null`. A poll every 250 ms therefore costs at most one query per terminal per 1.5 s, and none once the terminal is linked.
5. **The database is a fallback, never the first choice.** After `projects.linkFastWindowMs` with no candidate, a terminal that is the only one of its folder asks the database for the
   sessions of its project first seen at or after the spawn (less the tolerance) that no terminal owns and that no live registry entry holds: exactly one gives `transcript-time` with low
   confidence and no pid; anything else stays `pending` with the reason `no_registry` (`registry_unreadable` while the registry cannot be read). A project whose key Claude cut (a name over 200
   characters) has no key to ask for. A link made on the database is upgradable: the terminal stays in the ladder, so the registry entry that shows up later replaces the guess (the guess
   goes to the previous ids). The guess exists for a Claude version that stops writing the registry; with the registry working it cannot be wrong for long.
6. **The contract with the terminal host.** `track(probe)` after the terminal service created the terminal (the probe carries the root pid, the folder, `startedAt` taken just before the
   spawn, the resumed id and `fork`); `forget(name)` on the `ended` change; `link(name)` is the `TerminalLink` of the wire (`@mcs/shared`) and `onChange` is called once per change of it,
   never for the state a terminal is tracked in. `sessionOwner(id)` is the terminal that linked the session first (ties by name), or a terminal that resumes that id without a fork and is not
   linked yet (so two resumes cannot race between `create` and the link); `ownedPids()` are the registry pids of linked terminals. `shared` is true for every terminal when another linked
   terminal landed on the same session id (a `/resume` inside the process). A terminal whose entry has no live process shows no status, and a registry that cannot be read leaves linked
   terminals as they are. While the monitor has no row for the linked session (`transcript: none`) the linker asks the importer for it (`hintSession`) at once and once per slow tick. The
   timer polls every `linkPollMs` while a terminal that is not linked is younger than `linkFastWindowMs`, else every `linkSlowPollMs`, and sleeps while nothing is tracked.
7. **`/clear` and `/resume` inside the process.** The registry entry of the same pid gets a new session id; the link follows it, its `since` becomes the time of the change, the old id is
   pushed to `previousSessionIds` (at most eight, the oldest dropped) and an id the process returns to is the current one again. This rests on the observation of the design (the same pid
   rewrites its entry) and on the opt-in probe below.
8. **Resume semantics** (`folders/resume.ts`, `FolderService.resumeEligibility` and `planResume`). One decision over `resumeFacts`, the registry and the linker, checked in this order, the first
   failure answers:

   | Order | Check | Answer |
   |---|---|---|
   | 1 | the database has no such session | refusal `session_not_found` (the route answers 404) |
   | 2 | no main transcript, or it is `missing` or `retired` (the plan also asks the file system: `cleanupPeriodDays` may have removed it) | `transcript_gone`, no copy |
   | 3 | the launch folder: the first directory among the root the project reported, the working directory the session reported and the root of the catalog, whose key is the key of the project (not a later `cd`) | `folder_missing` when candidates exist and none is a directory, `folder_unknown` when there is none (a session with no project has none) |
   | 4 | a terminal of this app holds the session | `live_in_terminal` with the name of the terminal, no copy |
   | 5 | a live registry entry holds it and its pid is not in `ownedPids()` (the person's own terminal, an editor) | `live_elsewhere`, a copy is allowed: two writers on one file would interleave |
   | 6 | otherwise | allowed, a copy allowed |

   `claude --resume <id>` reuses the session id and appends to the same file by default; `--fork-session` makes a new id. The plan is `{ sessionId, folderPath, folderKey, args, mode,
   expectsSameId, redirectTo }` with `args` `['--resume', id]` or `['--resume', id, '--fork-session']`; a resume needs `allowed`, a copy needs `forkAllowed`, otherwise `planResume` throws
   `ResumeRefusal` with the code of the check that failed. `redirectTo` is informational: the session that carried this one on, when the database knows it. The folder is looked at when the
   question is asked (never from the caches of the list), a path that is not a valid host path (UNC, device, a reserved name) is never a candidate, and a folder whose state cannot be told is
   not trusted. A session started outside the app is eligible by the same rules: the transcript is what matters, `entrypoint` refuses nothing.
9. **Routes and errors.** `sessionResume` (`GET /api/v3/sessions/:sessionId/resume`, `access: 'session'`) answers the eligibility as a value, every reason is data in the body; the one
   refusal the service throws for it, `session_not_found`, is a 404. A `ResumeRefusal` is recognised by its name (the other routes do the same for the errors of the engine), any other
   failure is an internal error with the fixed sentence. The message of a refusal is its code and nothing else: no id, no path, no terminal name. The terminal host maps every
   `ResumeRefusal` of `planResume` to `resume_unavailable` (409) and puts the reason in a log field, never in the message. Nothing here logs a terminal name, a folder or an error message:
   a line carries a pid and a code at most.

## What the opt-in probe settles

`engine/test/link-real-claude.live.test.ts` runs the real `claude` in a throw-away folder only with `CAW_REAL_CLAUDE=1` (`CAW_REAL_CLAUDE_PROMPT=1` and `CAW_REAL_CLAUDE_TRUST=1` add a billed prompt and the trust answer; all three are registered in `DOCUMENTED_ENV_VARS`), never in CI, and prints one line of structure (key names, kinds of
values, times, the enumerated values; never an id, a folder, a name or a prompt). The lead runs it once; its output is recorded here and the fake `claude` of the testkit is kept consistent
with it (design 03, A3). Until then the answers below are **unverified**, and the link depends on none of them: the rule needs only `pid`, `sessionId` and `cwd`, the start time is compared with a
tolerance, and the fallback on the database exists.

| Question | Why it matters | Observed |
|---|---|---|
| Is `startedAt` the start of the process or of the session, and in which unit? | the "new since spawn" test; the resume id exception exists because it may be the original start | unverified |
| What is `procStart` (type, unit)? | it is ignored until its format is known; it could replace the pid in a pid-reuse check | unverified |
| Does `-n <token>` show as the registry `name`? | an exact link key (`TerminalProbe.nameToken` is reserved for it) and a visible session name that the owner would have to accept | unverified |
| Is the registry pid the root pid or a descendant, and how soon after the spawn does the entry appear? | rung A against rung B, and the length of the fast window | unverified |
| Does `/clear` rewrite the session id of the same pid? | the follow of `/clear` (decision 7) | unverified |
| Does `--resume <id>` keep the id, and what are `startedAt` and the pid relation then? | the resume id exception and `expectsSameId` | unverified |
| Which values does `status` take, and does the entry exist before a trust-folder question is answered? | `registryStatus` of the link; the reason `no_registry` | unverified |

## Consequences

- A terminal gets a link within one poll of its `claude` writing the registry, on the strongest evidence available, and the row says how sure that is (`basis`, `confidence`). A machine that
  cannot list processes still links the common case (one terminal in a folder) with medium confidence and says ambiguous rather than guess when it cannot tell.
- The cost is one registry read per second and, only while a terminal is pending and has a candidate, one PowerShell query per terminal per 1.5 s; linked terminals cost the registry read.
- A `claude` that the person starts by hand in the same folder at the same moment never takes a terminal's link when the table is readable; when it is not, the counts say ambiguous.
- Resume is decided on facts the database already has plus one registry read and a few `stat` calls, and the same function answers the dialog (the eligibility) and the terminal start (the
  plan), so the two cannot disagree except where the file system changed in between, which the plan checks again.
- `sessionsSince` (the fallback) and `hintSession` are injected: the user services wire the first to a query over `first_seen_at` of the sessions of a project and the second to the ingest
  service. The linker itself touches neither the database driver nor a child process.
- Not built: linking by `-n <token>` (PRJ-Q2, waits for the probe and the owner's acceptance) and any link for a terminal of a task instance (the terminal exists only in the user instance).
