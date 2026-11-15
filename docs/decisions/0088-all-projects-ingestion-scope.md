# 0088 All-projects ingestion scope

Status: Accepted (CAW, 2026-11-15). Owner: projects area (prj), work package CAW-27 (design 03, sections 2.1 to 2.4, 2.7 and 5.4). Relies on 0016 (transcript
references, not bodies), 0019 (the Claude registry) and 0022 (a metadata-only database); changes none of them, but widens the reach of two things they describe: the folders
that the importer reads and the sessions whose first prompt becomes a label. Related: 0091 (the user instance is a workspace of kind `user`), 0079 (the stance change of the
program).

## Context

Until now an instance read the transcripts of one repository. The importer held one folder, the one Claude Code names after the repository, and everything else in the Claude home
was invisible to it. The user instance of the product (0091) is not a repository: it shows the sessions of every project of the person, as the terminal panel it replaces showed
every folder, and it hosts the terminals that the person opens in any of them. So it reads every folder below `<claude home>/projects`, and the monitor has to stay cheap while it
does. On a real home the numbers are not small: ten project folders, 2,805 transcript files, 3 GB, and the largest folder has about 110 subagent and workflow files per main session.

Measured on one machine (Windows 11, Node 24, warm cache, a throw-away tree of 40 folders of 250 files): the sequential `lstat` loop of today costs 538 ms for 10,000 files, batches of
32 cost 91 ms, listing the 40 folders costs 1 ms, and the modification time of a folder changes when a file is created in it but not when an existing file is appended to.

## Decision

1. **The switch is a runtime key and the kind of the instance.** `projects.scope` is `auto`, `repo` or `all`. `auto`, the default, means `all` for an instance of kind `user` and `repo`
   for every other, so a per-task instance does not change and the user instance needs no key written for it. `all` and `repo` force the behaviour: the integration tests of this area
   run it on an ordinary task workspace, and `repo` pins a user instance back to one repository. There is no sentinel value in `transcripts_dir`, a key that six other places read.
   `isAllScope(scope, kind)` and `projectsRootOf(claudeHome)` (`projects/scope.ts`) are the only definitions.
2. **Discovery lists every tick, looks into a folder when there is a reason, and sweeps all of them once a minute.** One `readdir` of the projects folder and one `lstat` per project
   folder, every discovery tick (5 s). A folder is looked into (a `readdir` and batched `lstat` of its files, 32 at a time) when it is hot, changed or hinted: hot means it holds a
   tracked file that is still `active`, changed means the modification time of the folder differs from the last look into it, and hinted means a registry entry or the linker pointed at it.
   A full sweep over every folder runs on the first call and then every `projects.fullSweepIntervalMs` (60 s), because an old session that is resumed appends to its file and leaves the
   modification time of its folder alone. A new session file or a new project folder is found within one tick. The folders are visited newest first and the loop yields to the event
   loop between two of them, so the server answers while a cold first sweep runs. Only real folders are entered: a link or junction is counted and never followed, and a name that is not
   `[A-Za-z0-9-]` (at most 255 characters) is ignored without being looked at. Each folder has its own entry budget of 50,000 per pass; a folder that uses it up is counted and said once as
   the code `discovery_truncated`, never with a path.
3. **The registry names a live session that nobody has seen.** A registry entry whose process lives and whose session this instance does not know is a hint: the importer looks for that
   session id at once, whatever the age of its file, first in the folder that the working directory of the entry names, then with one `lstat` per project folder. That is how a
   `claude --resume <old id>` or a session that was idle for a day shows within one registry poll (5 s) although its folder did not change. The hint is given once per 30 s per session.
   The registry is read with a loose schema for this (a status the version does not know never hides an entry), the `name` field and `procStart` are never read, and the strict reader of
   the sessions that are known is unchanged. `IngestService.hintSession(sessionId)` gives the terminal link (a later work package) the same lever. A hint that finds nothing makes its folder
   one to look into at the next tick.
4. **Unmatched sessions are listed.** Most projects have no session rule, so in scope `all` the filter that hides sessions no rule matched is off (`unmatchedVisible`, one helper in place of
   three inline conditions). `matched` stays on the summary as a badge for sessions a rule or a pin tagged.
5. **The reach of the label widens, and this is a privacy consequence.** The label of a session is the first real prompt, at most 70 code points and redacted (0016). In scope `all` that text
   is read from the transcripts of every project of the person and stored in `sessions.label`, and the folded label and title in `search_text`. It stays in the database of the user
   instance, which lives in the user's own workspace and never in a repository, and the exports (0028) still carry no transcript text. No other prompt, answer, tool result or thinking text
   is stored, in either scope; `all-projects.int.test.ts` plants canaries in them across three projects and scans the workspace. Registry working directories are used to find a folder and
   are not logged.
6. **The window is the window.** `window_hours` is unchanged (it feeds `import.lookbackHours`); the instance area may give the user instance a longer default so that yesterday's sessions can
   be resumed. A session older than the window is not tracked unless pinned, known (it has a tracked file or hook events) or hinted. Tracked files, `untrackAfterHours` and the idle rule are
   unchanged. Files that did not grow for five minutes are looked at every `projects.coldStatIntervalMs` (10 s) instead of every second: a 24 hour window over many projects tracks
   thousands of subagent files, and ten thousand `stat` calls a second would cost a tenth of the thread pool for nothing. A cold file that grows is noticed within 10 s, at once when its
   session is live and hinted.
7. **The transcript of a session is readable from any project.** The window, locate and the content search keep their containment rule (a file must lie inside the root, `realpath` checked),
   and in scope `all` the root is the projects folder of the Claude home: the files of the sessions lie in many folders and none is the one folder. A file outside the projects folder is
   still refused.
8. **No hooks, no route file, no per-repository panels.** A route file names at most eight transcript folders and cannot name every project, so an instance in scope `all` writes none and
   runs from the transcripts and the registry. `mcs doctor` says it when `hooks.enabled` is combined with that scope (`hooks.scope`), reads the projects folder for `transcripts.dir` and
   `transcripts.parse` instead of the folder of a repository, and the git, attempts, ledger and chain-log panels read as off for the user instance (`effectivePanels`, CAW-26): its root
   is not a repository.
9. **A session id under two folders is not a copy of itself.** `claude --resume` from another folder can leave the same session id and the same records in a second file. Both files are
   tracked, and `reportCopies` skips a source equal to the session of the file, so no `copied_from` and no reconciliation row names a session as the copy of itself.

## Consequences

- A task instance is untouched: the default key means `repo` for it, and every test of the single-folder importer, service and window passes as it was (the lstat order of a discovery with
  the default concurrency of 1 is the same as before).
- The cost of discovery in scope `all` is bounded by the folder count and the hot folders, not by the history: `all-projects.slow.test.ts` pins a listing, a quiet tick and a full sweep of
  10,000 files against the measured numbers with a wide margin, and a second sweep over an unchanged home creates no work.
- The first sweep over a cold cache of a very large home is slower than the warm figures; the server answers while it runs and the folders are processed newest first.
- Directory modification times are a heuristic (not reliable on FAT or some network shares). The full sweep and the registry hint are the safety net, and the interval is a key.
- A session that is older than the window, idle, and unknown to the registry is not listed until its file changes and a sweep finds it. `/resume` inside `claude` works regardless.
- The database of the user instance holds the first prompt of every session of every project of the person. That is the one place prompt text reaches the database (0016), now with
  the reach of the whole Claude home. A `projects.exclude` list for private folders is a follow-up and is not built.
- The hooks are not supported for the user instance. A person who enables them there gets the doctor warning and no events from them.
