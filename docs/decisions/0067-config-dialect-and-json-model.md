# 0067 Configuration dialect: JavaScript regexes, a documented time format and a neutral JSON document model

Status: Accepted (V4, milestone M0, 2026-10-18). Owner: V4 area B (Python removal and configuration compatibility).
Amends ADR 0002 (the stored form of a pattern is now JavaScript; the Python translator and its corpus are confined to the migration
path) and ADR 0003 (the file writer stays, the Python-compatible equality, repr and golden requirement go). Related: ADR 0066
(Python removal), ADR 0068 (workspace migration).

## Context
ADR 0002 stored Python-syntax regexes in `config.json` because the Python engine read the same file, and translated them at load into
JavaScript `v`-mode source that was emitted as escapes (every non-alphanumeric character as a braced code point), plus a translator
that is exact or refuses. With Python gone the shared-file reason is gone, and the cost stays: agents must write Python syntax that
JavaScript cannot compile, error messages talk about a language nobody runs, and the loader carries a 1,400-line parser on the hot
path. ADR 0003 made every workspace JSON file a byte-compatible Python `json.dump` product and modelled Python equality, `repr` and
`strptime`. None of the four real configs needs it: they hold plain integers, strings and one Python-style `time_format`.

## Decision
- A pattern in `session_rules[].match`, `attempts.start` and `attempts.end` is a JavaScript regular expression source. It is compiled by
  one module (`engine/src/regex`) with the flags `v` for every pattern, `s` added for session rules (a dot matches a line break, as
  the old `re.S` search did) and `y` added for attempts (the match must start at position 0, as the old `re.match` did; the module
  resets `lastIndex`). There is no per-pattern flags key and no inline-flag support (Node 22 has no `(?i:)` modifiers, so the module refuses a modifier group on every Node version
  to keep one behaviour everywhere); case-insensitive text is written with classes. Match positions are counted in code points and a named group is read with `groupdict()`.
- A pattern that is not valid JavaScript is `CONFIG_INVALID`. When it contains a Python-only construct (`(?P<name>...)`, `(?P=name)`,
  `(?#...)`, an inline flag group such as `(?i)`, `\A`, `\Z`) the message adds: this looks like Python regex syntax; run
  `mcs migrate-workspace --task <slug>` (dry run first). Errors never repeat a pattern text except the validation line that
  names the rule being fixed.
- The Python regex translator stays, moved to `engine/src/migrate/regex`, and is used only by `mcs migrate-workspace`. It keeps the
  exact-or-refuse rule of ADR 0002 and its refusal codes. Its output changes from escape-heavy `v`-mode source to a readable
  dialect text: printable characters stay literal, `^` and `$` are used where they mean the same, `\d`, `\w`, `\s` and `\b` are
  expanded to the Unicode classes Python meant, a global IGNORECASE is expanded to letter classes. Its corpus (the frozen CPython
  results) is the proof: the dialect text, compiled by the runtime module, must give the CPython answer on every case.
- `attempts.time_format` is a documented subset of strftime directives (`%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%`):
  names are English and case-insensitive, whitespace in the format matches one or more whitespace characters, the whole text must
  match, `%S` is 00 to 59 (no leap seconds), a format without a year cannot parse 29 February, `%z` accepts `Z`, `+HH:MM` and
  `+HHMM`, and a format that mixes `%j` with `%m`, `%d`, `%b` or `%B` is refused by validation. Without `%z` the fields are local
  time. The parser lives in `engine/src/platform/time-format.ts`; nothing in it refers to Python.
- Workspace JSON keeps one stable writer: indent 2, UTF-8, non-ASCII text kept, one trailing line feed, atomic replace. The ordered
  document model stays (it keeps key order, the integer/float kind of a number and integers beyond 2^53, so `configure` rewrites a
  user's file without churn) but its names are neutral (`JsonDoc`, `parseJson`, `dumpJson`, `jsonFileText`, `writeJsonFile`,
  `quoteText`, `shortJson`, `formatFloat`, `jsonEquals`) and three Python behaviours go: equality is strict (`true` is not `1`),
  `NaN` and `Infinity` are refused on read and write, and the Python-derived golden suite is retired in favour of a layout table.
  Diagnostic wording that was borrowed from Python (strings quoted with single quotes in messages) is unchanged, so messages and the
  tests that pin them stay stable.

## Consequences
- Existing Python-era workspaces must be converted once (ADR 0068). A V4 runtime refuses their Python-syntax patterns with a precise hint
  instead of translating them silently.
- Agents and users write ordinary JavaScript patterns; the configuration documentation shows the dialect and the `v`-mode class rules
  (inside a class, escape `-`, `(`, `)`, `[`, `]`, `{`, `}`, `/`, `|` and the backslash).
- `$` means end of input and `\d`, `\w`, `\s`, `\b` mean the JavaScript sets in hand-written patterns; the migration expands the Python
  meanings explicitly, so converted patterns keep their behaviour.
- The load path carries a small compile module (a few hundred lines with the match accessors) instead of the 1,400-line translator; the
  translator and the 1.5 MB corpus are weight of the migration path only.
- Residual risk: the corpus was recorded against Unicode 16 tables and verified on Node 24 (V8 13.6); behaviour on Node 22 (V8 12.4)
  and 26 is checked by the CI matrix before release.

## Alternatives rejected
- Keep Python syntax as the stored form (ADR 0002 as written): the reason for it is gone and it keeps the translator on the load path.
- Accept both dialects at load: ambiguous for patterns that are valid in both (`$`, `\d`), silent behaviour drift.
- Add a `flags` key to rules and attempts: more surface for a case that has an exact class-based form; can be added later without a break.
- Compile with the `u` flag: friendlier class syntax, but the exact translations of Python's negated categories inside sets need nested
  classes, which only `v` mode has; keeping `v` keeps the verified emitter.
- Replace the document model by plain `JSON.parse` data: reorders integer-like keys, loses `8.0` and large integers, and touches
  every workspace file on the first rewrite.
- Keep `pyjson`, `pytime` names: they tell agents Python is current.

## Evidence
- ADR 0002 evidence (E7, E8) for the translator exactness; the frozen corpus `regex-golden` (table, V9-shaped, random, class sweep) and
  `regex-rejects` is the regression proof after the emitter change.
- Python coupling fact report (planning notes, not published) section 2 (translator is the production path today; the existing configs need
  none of PyJson) and section 4 (the four real configs).
