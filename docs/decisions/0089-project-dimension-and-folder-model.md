# 0089 Project dimension and folder model

Status: Accepted (CAW, 2026-11-15). Owner: projects area (prj), work packages CAW-26 to CAW-29 (design 03, sections 2.5, 3, 4 and 7). Relies on 0016 (transcript references, not
bodies), 0022 (a metadata-only database) and 0088 (the all-projects ingestion scope); changes none of them. Related: 0091 (the user instance), 0085 (the access ticket and the
session cookie, which every route below needs).

## Context

The sidebar of the terminal page lists the folders a person works in: the ones the DA memory hook of the reference product logs, the project folders of the Claude home, and folders
the person added by hand. Three sources name the same folder in three spellings, none of them wrote a shared id, and one of them (the DA memory) holds prompts and answers verbatim next
to the few fields the list needs. The database already had a project dimension in its schema and queries, but nothing wrote it. This record fixes the identity of a folder, who writes
the dimension, what of the DA memory leaves the reader, where the added folders live, how the sources merge and in which order, and which routes expose the result and to whom.

## Decision

1. **A folder is its project key.** Claude Code keeps the transcripts of a working directory in a folder below `<claude home>/projects` whose name is the directory with every character
   outside `[A-Za-z0-9]` turned into a dash, cut at 200 characters (then followed by a dash and a hash that nobody else can compute). The lower-cased name is the key: `folderKeyOfPath`
   (`projects/folder-key.ts`, built on `projectFolderName`) gives `{ key, prefix }`, `prefix` being true for a cut name. A path that a person wrote (a DA entry, an added folder) joins the
   Claude folder by this key with no reverse decoding; a cut key joins the unique Claude folder that starts with it and a dash, and stands on its own when none or several do. The key is
   `SessionSummary.projectId`, `projects.project_key` and `Folder.key`. A DA slug is never a key (the hook collapses runs of characters, so two folders can share a slug shape that no
   key has); the `path` field of the DA entry is what is used.
2. **`PROJECT_ID_RE` is `/^[a-z0-9-]{1,255}$/`.** The characters the sanitizer can produce, lower-cased. A POSIX folder name starts with a dash, so the first character is not special. Every
   route that takes a key (`removeFolder`) and every row that carries one is checked with it.
3. **The ingest writer assigns the dimension, once.** On `session.seen` the writer sets `sessions.project_id` from the folder of the main transcript file (`projectOfSeen`) and keeps the
   first working directory the session reported as the root of the project; the first value wins and a hook-sourced and a transcript-sourced `session.seen` agree. A name that is not a
   project name gives no project. `projects/backfill.ts` assigns it to the sessions that existed before the dimension was written. The folder list reads it through one query
   (`projectStats`, indexed by `idx_sessions_project`), never by scanning sessions.
4. **The DA memory is read-only and only a summary leaves the reader.** `<home>/.claude/memory/<slug>/meta.json` is the authority (`index.json` only as a degraded fallback when no
   `meta.json` could be read). The reader never writes, never creates a folder and never opens `brain.md`, `action.md`, `da-memory.py` or a `*.key` file; the `sessions` array, `created`,
   `status` and `last_kind` of a `meta.json` are parsed and dropped. What leaves it: a path (normalized for the host, a UNC or device path or a control character gives none), a time, two
   counts, and a summary that is redacted and clipped to 120 code points. Nothing of it is logged. The folder is `<home>/.claude/memory` even when `CLAUDE_CONFIG_DIR` points elsewhere,
   because that is where the hook writes it (`projects.daMemoryDir` overrides it). `folders.int.test.ts` plants canaries in `brain.md`, `action.md` and the `sessions` array and scans
   every response and the log.
5. **Added folders live in a state file of the workspace.** `<instanceDir>/data/folders.json`, format v1: `{"schema_version":1,"updatedAt":"<iso>","folders":[{"path":"...","addedAt":"<iso>"}]}`.
   Paths only, at most `projects.userFoldersMax` (200), a path at most 1,024 characters, the file at most 256 KiB. A write is atomic (0058) behind a promise chain that serializes changes. A
   missing file is empty; a damaged one is empty, reported as `corrupt` and kept once as `folders.json.bad` before the next write; a newer `schema_version` is `newer_version` and refuses
   writes (`FolderError('state_unwritable')`, an `internal_error` on the wire) so that data of a newer program is never overwritten. An add checks the path (`windowsFolderPath`: absolute,
   no UNC or device path, no reserved name or stream, no control or format character, at most 240 characters) and that it is a directory, is idempotent by key, and refuses over the limit.
   A removal drops only the `user` origin: the row stays while the DA memory or the Claude home still names the folder.
6. **The merge is pure, and its order is fixed.** `mergeFolders` (`folders/merge.ts`) buckets the sources by key and produces one wire row (`Folder`) per bucket:
   - the path is the most human spelling, DA first, then the folder a person added, then the root the project reported, then the root of the catalog (`pathSource` says which); a root that
     cannot be a folder on the host is skipped, so no row ever shows a UNC path;
   - `origins` lists `da`, `user` and `claude` as they apply, and `fallback` only for the row of an empty list;
   - `lastActivityAt` is the newest of the DA time, the project's last activity and the modification time of the Claude folder, and `activity` (`full` up to two hours, `half` the same
     local day, else `none`) follows it. This deviates from the reference product, which looked at the DA time only, so that a folder worked in today is not shown as quiet because nobody
     logged to the DA memory; `da.activity` keeps the pure DA mark;
   - two groups: folders outside the DA memory first, newest first by the later of their activity and the time they were added (a folder just added is on top), ties by name and key; then
     the DA folders in the order the DA memory gave (newest first). An empty list gets one row for the home directory, so the column is never empty;
   - at most 500 rows; the oldest folders outside the DA memory go first;
   - `exists` is the check of the catalog for its own root and the service's check for a DA or added path, `canStart` is "the path is known and the folder is not known to be missing".
7. **The service answers from caches.** `createFolderService` (`folders/service.ts`) owns the DA reader (a read reused for `projects.daCacheMs`), the catalog (rescanned every
   `projects.catalogIntervalMs`; an overdue scan starts behind the answer), the state file and the existence checks (once per path in a 120 s window, a stale value renewed behind the
   answer; only a path never checked is waited for). `list()` is `FolderListResponse` with the status of the three sources and `asOf`, the clock the page feeds to its relative times.
   `add` answers with the row; `remove` drops the user origin; failures are `FolderError` with a code and, for `folder_invalid`, the reason (`relative`, `unc`, `device`, `stream`,
   `reserved_name`, `format_char`, `control`, `too_long`, `not_directory`), never a path. The per-folder recent sessions are not part of the list: the page asks `listSessions?project=<key>`
   for a folder it opens, so a poll costs no per-folder query.
8. **Three routes, all behind the session cookie.** `listFolders` (`GET /api/v3/folders`), `addFolder` (`POST /api/v3/folders`) and `removeFolder`
   (`POST /api/v3/folders/:key/remove`) are `access: 'session'`, including the two reads: folder paths and DA summaries are private, so the access code is needed for them, and an
   open GET would give them to any local process. They are mounted for the user instance only (the boot code lists the module; a task instance has no access service and a session
   route cannot be mounted without one). `folder_invalid` is 400 with `details[0] = { path: 'path', issue }`, `folder_limit` 409, `folder_not_found` 404. `routes/folders.ts` turns
   the `FolderError` of the engine into those codes; any other failure is an `internal_error` with the fixed sentence.
9. **The panels of one repository are off for the user instance, in the panel route too.** `effectivePanels(panels, kind)` (`projects/scope.ts`) already shaped `InstanceInfo`; the panel
   route now asks it, so `git`, `attempts`, `ledger` and `chainLog` answer 404 `panel_disabled` for the user instance whatever `config.json` says. `machine` and `logs` are not tied to a
   repository and stay as configured.

## Consequences

- Three spellings of a path are one row, with no reverse decoding and no new id in any database. A path whose Claude folder does not exist yet is a row of its own, and joins its
  Claude folder the day the first transcript appears.
- The DA memory costs one directory listing and one small read per folder every `projects.daCacheMs` while the page polls, and nothing else of it is opened. A DA entry with no usable
  path (or only a UNC path) adds no row.
- Two DA entries whose paths differ only in characters the sanitizer turns into dashes (`D:\work\a-b` and `D:\work\a b`) are one row: the newest wins and the counts add up. The
  same holds for two added folders.
- A folder that the catalog cut (more than 2,000 project folders) can still appear through the database and the DA memory; the `truncated` flag of `sources.claudeHome` says so.
- The existence of a project's reported root (a folder the DA memory and the person never named) is not checked, so such a row has `exists: null` and can start; the terminal host
  refuses a missing folder on its own.
- The routes are tested over real HTTP with response validation on: the three codes, the cookie refusal, the privacy canaries and the panel rule are in `folders.int.test.ts`.
