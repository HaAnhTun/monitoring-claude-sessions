# Legacy parity goldens

The Python engine in `src/backend` is the oracle of the Node migration (design 06 section 5, ADR 0053). This folder holds the tool that
runs it under a frozen clock and the raw outputs it produced. Nobody edits a golden by hand: they are regenerated, reviewed and committed
by the lead. The legacy code and `tests/fixtures`, `tests/tools` are imported read-only; nothing is patched on disk.

```
tools/capture_golden.py     generator and drift check (Python standard library only, Python >= 3.8)
tools/determinism.py        frozen clock, seeded uuids, datetime shim, mtime pinning, path normalisation, tree manifests
tools/panel_scenarios.py    generator-owned trees: rules matrix, panels (logs, ledger, chain log), registry
tools/vectors.py            L1 vectors: pure legacy functions called with crafted inputs
golden/meta.json            generator_version, legacy_version, legacy_code_stamp, python_version, frozen_now, tz, port_base, scenarios, vectors
golden/trees/<scenario>.manifest.json    [{path, size, sha256, age_s}] sorted by path (hash of the normalised content)
golden/api/<scenario>/<name>.json        [status, body] as the legacy HTTP server answered
golden/cli/task-lifecycle.json           command outputs and workspace files of a scripted CLI session
golden/vectors/<function>.json           [{case, input, output}]
```

Golden JSON is `json.dumps(v, indent=1, sort_keys=True, ensure_ascii=False)` plus one LF, UTF-8, no CR.

## Commands

Run from the skill folder. `-B` keeps `__pycache__` out of the skill tree (the tool also restarts itself with `-B`, and with `TZ` set, when needed).

```
python -B tests/legacy-parity/tools/capture_golden.py --out tests/legacy-parity/golden [--port-base 18850] [--tz UTC] [--trees DIR]
python -B tests/legacy-parity/tools/capture_golden.py --check [--golden tests/legacy-parity/golden] [--port-base 18850] [--tz ZONE] [--trees DIR]
```

From the runtime folder the wrappers are `npm run parity:capture` and `npm run parity:check` (design 05 4.11.4).

- Everything is built in one `mcs-golden-*` temp folder that is removed at the end. The only other thing written is the `--out` folder. It
  must be new, empty, an earlier golden folder (one with a `meta.json`) or a partial one that holds only golden entries (what a crashed older run left); only
  `meta.json`, `trees`, `api`, `cli` and `vectors` inside it are replaced, other files stay. Legacy-owned paths, the skill root and its parents are refused
  whatever the spelling: case, 8.3 names, `..`, junctions, extended-length (`\?\`) and UNC administrative-share forms, also when the leaf does not exist yet
  (names are compared after resolving the longest existing ancestor, and file identity is compared as well). An empty `--out` is a usage error (exit 2).
- The write is all or nothing. The new golden is built in a `.golden-staging-*` folder inside `--out`; then each old entry is renamed into it and each new entry
  into place. If a rename fails (on Windows a file held open by an editor, a scanner or Explorer blocks the rename of its folder) everything is renamed back, the tool
  prints `could not write ...: the previous golden is unchanged` and exits 1; rerunning after the lock is gone works. The staging folder is removed at the end.
- The legacy server is in process on `127.0.0.1`, first free port from `--port-base` (18850-18855 allowed; it scans +19, all inside 18850-18874). One server
  serves the whole run and is stopped at the end. Never 8765, 3000, 3100, 8080, 8089.
- `CLAUDE_CONFIG_DIR` is a temp folder (then each scenario's own fake home), so the real Claude home is never read. `--trees` refuses a folder that overlaps it.
- `--check` regenerates and compares file set and bytes with `--golden`. It exits 0 and prints `golden check: N files identical`, or exits 1 and prints one
  line per difference. It exits 2 (and compares nothing) when the Python minor version or the platform differs from `meta.json`: goldens are captured on
  Windows because the legacy builders write text-mode (CRLF) files there. The patch part of `python_version` and `port_base` are ignored in `meta.json`.
- Exit codes: 0 ok, 1 drift or failure, 2 usage error or an environment the goldens cannot be captured in.

### Reading a drift report

```
DIFF vectors/clip.json at /0/output: golden="..." generated="..."     first differing JSON pointer, both values clipped to 120 characters
DIFF vectors/clip.json at /: golden=<unparsable: '...'> generated=[...]   a golden file that is empty or damaged: only the side that is not JSON is marked
DIFF api/demo/sessions-all.json: same JSON value, different bytes      formatting only (a generator change)
MISSING <file>: generated but absent from <golden>                     a new file: capture and commit it
EXTRA <file>: present in <golden> but not generated                    a retired file or a scenario that needs --trees
```

A drift while `src/backend`, `config/defaults.json`, `tests/fixtures/make.py` and `tests/tools/demo.py` are unchanged is a determinism bug of this tool.
`meta.json` carries `legacy_code_stamp` (a hash of the backend code and defaults), which changes first when the legacy code changed.
It is computed by the tool over line-ending-normalised bytes (CRLF read as LF): the same files, order and sha1 as `backend.code_stamp()` (sorted `src/backend/*.py`
as base name plus content, then `config/defaults.json`), but a checkout with another `core.autocrlf` or `eol` setting gives the same stamp. The legacy function hashes the
raw bytes, so on a mixed working tree its value differs from the recorded one; the recorded one is the hash of the committed (LF) files.

Reviewed update (lead): capture, run `--check`, inspect every changed file in `git status`, commit `tests/legacy-parity/golden/**` on its own.

## Determinism controls (design 06 5.2.3)

| Source of variation | Control |
|---|---|
| `time.time` | `FROZEN_NOW = 1790000000` (2026-09-21T14:13:20Z). Reader budgets never expire, so every usage scan completes in one poll |
| `datetime.now` in `make`, `demo`, `tasks` | a `datetime` shim injected as each module's attribute; `demo.NOW` reassigned |
| `uuid.uuid4` | `%08x-0000-4000-8000-%012x` with a counter that restarts at 1 for every scenario (`meta.json` records it) |
| mtimes no builder set | every mtime later than `FROZEN_NOW` is set to `FROZEN_NOW`; ages use `FROZEN_NOW - seconds` |
| temp folder spelling | every spelling (raw, 8.3 short, long, JSON-escaped once and twice, `/`; case-insensitive on Windows) becomes `<TMP>`, longest first |
| absolute paths inside files | tree manifests hash the content after the same replacement |
| pid of the registry fixtures | `"pid": N` becomes `"pid": "<PID>"` before hashing; goldens contain no pid |
| `config_hash` in `inspect` output | `<MACHINE>` |
| local time zone | `TZ` is set before the interpreter starts (the tool restarts itself); `--tz` default UTC |

Time zones: Windows' C runtime ignores IANA names and silently uses the machine zone. The tool therefore maps the zones it supports to fixed-offset POSIX values
(`UTC`, `Asia/Ho_Chi_Minh`, `Asia/Saigon`, `Asia/Bangkok`, `Asia/Tokyo`, `Asia/Kolkata`; see `FIXED_ZONES`), verifies the resulting offset and refuses other names
on Windows (exit 2). The `Asia/Ho_Chi_Minh` variant of design 06 5.2.6 is a throw-away capture; nothing is committed for it.

## Scenarios

| Scenario | Tree | Captured |
|---|---|---|
| `fixture` | `make.build_home` | API set A |
| `demo` | `demo.build` (sessions A-G, chain log, ledger) | API set A |
| `rules` | `panel_scenarios.rules_tree`: one project folder per case R01-R30 | `api/rules/sessions-all.<case>.json` = `[status, [{id, label, matched}]]` (projected: one session per folder) |
| `panels` | logs (CRLF, CR, NEL, U+2028/U+2029, a 72 KB file whose 64 KB tail window starts inside a two-byte character, a 71 KB ASCII file), ledger with mixed lines, chain log (CRLF, duplicate START, END with an unparsable time, END without status, END without START, START with an unparsable time), a STOP file, three matching sessions | `logs`, `overview`, `attempts`, `sessions-all`, and `logs.<file>` for each log file alone (the panel only tails the two newest) |
| `registry` | fixture tree plus `home/sessions/*.json`: busy (alive), idle (alive), waiting (alive), busy (dead pid 999999) and a `4242.key` decoy | `sessions-all`, `sessions` |
| `task-lifecycle` | empty temp repo, nine CLI commands in process | `cli/task-lifecycle.json` = `{commands: [{argv, exit, stdout, stderr}], files: {path: text}}` |
| `<name>` (`--trees`) | each sub-folder of the folder given to `--trees`: `home/` (a fake `CLAUDE_CONFIG_DIR` with `projects/<project>/`) and optionally `repo/`; copied to the temp folder first. First project folder in sorted order is served. Sub-folder names: letters, digits, `-`, `_`; not a name above | API set A, with session ids instead of keys in the file names |

API set A (`api/<scenario>/<name>.json`, each `[status, body]`): `sessions-all` (`/api/sessions?all=1`), `sessions`, `sessions-hours-0.1-all`, `attempts`, `overview`,
`logs`, `config`, `task`; per session key `K` (fixture: `done failing running pending parent`; demo: `A`..`G`): `events.K`, `events-after0-limit5.K`, `events-before5-limit3.K`,
`search-q-step.K`, `search-errors.K`, `search-tool-bash.K` (`kinds=tool&tool=Bash`), `locate-i0.K`, `locate-ts.K` (`ts` = first event time of `events.K`); per agent
`events-agent.K.<agent>`; errors `err-hours-x` (400), `err-unknown-sid` (404), `err-after-x` (400), `err-agent-traversal` (`agent=../x`, 404), `err-host-evil` (`Host: evil.example`, 403 text);
`health` = `{keys, reader}` (pid, times and the code stamp are dropped); `machine-shape` = `{key: number|string|array|object|boolean|null}` (the first poll has no CPU baseline, so `cpu_pct` is `null`).

## Vector files

Each file is a list of `{case, input, output}` with exactly those three keys and unique case names. The input is serialised first and the legacy function runs on the
serialised input, so the stored output is always the legacy result for the stored input (dict key order inside inputs is therefore sorted, and a case whose result
depends on it cannot exist). Inputs that need a float spelling (`1.0`), an integer-like key order or duplicate keys are JSON text (`text`, `value_json`).
When the legacy function raises, the output is `{"raises": "<ExceptionClass>"}` (plus `message` for `ConfigError`); `strptime.json` uses `null` for every failure.

| File | Legacy function | Input | Output |
|---|---|---|---|
| `splitlines.json` | `str.splitlines()` | `{text}` | list of strings |
| `tail.json` | `panels.tail_lines(path, n)` | `{n, segments: [{hex, repeat}]}` (file bytes = concatenation of `bytes.fromhex(hex) * repeat`) or `{n, missing: true}` | list of strings |
| `strptime.json` | `time.mktime(time.strptime(text, format))` under the pinned zone | `{format, text}` | seconds (float) or `null`. Depends on `tz` |
| `pydumps.json` | `json.dumps(json.loads(text), indent=indent)` | `{text, indent}` (`indent` null or an integer) | string |
| `slug.json` | `config.slugify` / `config.check_slug` | `{fn, arg}` | string or `{raises, message?}` |
| `merge_provenance.json` | `config.merge(base, over)` and `config.provenance(base, over, source)` | `{base, over, source}` | `{merged, provenance}`, each possibly `{raises}` |
| `audit_entry.json` | `tasks.audit_change`, `tasks.record_decision`, `tasks.last_change` on a fresh folder | `{initial?: {path: text}, calls: [{fn, now, args}]}` (`now` = frozen epoch of the call) | `{changes.md, decisions.md, last_change}` (file text or null) |
| `json_atomic.json` | `config.write_json_atomic` | `{text}` (JSON text of the data) | base64 of the file bytes |
| `external_state.json` | `state.external_state(row)` | `{row}` | `{state, evidence}` or `null` |
| `classify_state.json` | `state.classify_state(**input)` (all eleven arguments) | the arguments | `[state, evidence, source]` |
| `classify_rules.json` | rules: `sessions.classify({session_rules}, transcript)` and `config.validate(..., strict=False)`; attempts: `panels.attempts_rows` over crafted chain-log lines | rules: `{case, kind: rules, title, rules, lines}` (`lines` = transcript DSL: `{json: record}` or `{raw: text}`, optional `repeat`; file = lines joined by LF plus a final LF); attempts: `{case, kind: attempts, title, attempts, chain_lines}` | rules: `{label, matched, problems}`; attempts: list of rows. The cases are R01-R30 and R30-attempts, R31-R33 of design 06 5.7; `R20` has no rule (the unmatched fallback label is the boilerplate text), `R20-matched` is a rule that matches the boilerplate |
| `events_of.json` | `reader.events_of(record, text_chars)` | `{record, text_chars}` | list of events |
| `clip.json` | `reader.clip(value, n)` | `{value, n}` or `{value_json, n}` | string |

## Observations on the legacy code (facts for the lead, not decisions)

- `tail.json`: `tail_lines(path, n)` reads the last `max(65536, 400 * n)` bytes and decodes with `errors='replace'`, so a window that starts inside a character yields U+FFFD
  as the first character of the first (partial) line. Python's `splitlines()` also splits at VT, FF, FS, GS, RS, NEL, U+2028 and U+2029 (`splitlines.json`).
- `strptime.json`: a `time_format` without a date part (`%H:%M:%S`) gives year 1900 and `time.mktime` raises `OverflowError` on Windows; `attempts_rows` catches only
  `KeyError` and `ValueError`, so such a format would fail the whole `/api/attempts` request.
- `slug.json`: `SLUG_RE` ends with `$`, so `check_slug('abc\n')` accepts a trailing newline.
- `classify_state.json`: the evidence uses `%d` on float ages (truncation toward zero, `-1s` for a transcript written 1.5 s in the future) and `//` for minutes.

Capture environment: Windows 11, Python 3.14.3 (recorded in `meta.json`); Python 3.8 is the floor the source is written for (syntax checked, not run).
