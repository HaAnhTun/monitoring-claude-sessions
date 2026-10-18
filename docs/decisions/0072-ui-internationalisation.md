# 0072 UI internationalisation: typed in-house message catalogue for English and Vietnamese, Intl formatting with the active locale

Status: Proposed (V4, milestone M6). Owner: UI (`packages/web`). Amends ADR 0036 (new preferences `locale` and `tableColumns` in
`mcs.ui.v3`) and ADR 0041 (no new dependency: the catalogue is in-house). Builds on ADR 0034 (safe rendering) and ADR 0039 (CSP, bundle
budget).
Planned for a later 4.x release.

## Context
The UI is English only and is full of hard-coded text: about 330 literals in 60 source files, plus sentences assembled from pieces
("Showing " + n + " agents"), plus helper modules that return English words (`lib/format.ts`, `lib/lifecycle-display.ts`,
`stream/freshness.ts`, `data/api-errors.ts`). The product goes public with an English user guide and a Vietnamese README; the owner wants
the UI itself in English and Vietnamese with a language switch. Number, date and time formatting is also locale-free today (a fixed
"12k", fixed "ago", `toFixed`), which would be wrong for Vietnamese (decimal comma, "N" for thousand in compact notation).

Adding an i18n library is possible but is a new dependency with a runtime of 10 to 30 kB, an ICU message parser and a build plugin in the
common cases; the avoid list of ADR 0041 and the 200 kB initial budget argue against it for two languages and a few hundred messages.

## Decision
1. **Catalogue.** `packages/web/src/i18n/messages/en.ts` is the source of truth: one flat object `as const`, dotted keys
   (`sessions.table.errors`), values are strings in a small ICU subset: `{name}` interpolation and
   `{count, plural, one {# error} other {# errors}}` (`#` is the number; categories `zero one two few many other` and `=N`; no `select`,
   no nesting, no literal braces). `messages/vi.ts` is typed as `Record<MessageKey, string>` so a missing Vietnamese key is a compile
   error. `MessageKey` is the key union of `en`; the argument type of `t(key, args)` is derived from the placeholders of the English text.
   English is bundled; Vietnamese is a lazily loaded chunk. Key prefixes follow the owning feature (`state.`, `shell.`, `live.`, `lists.`,
   `sessions.`, `detail.`, `tabs.`, `transcript.`, `search.`, `activity.`, `overview.`, `metric.`, `panels.`, `tasks.`, `analytics.`,
   `settings.`, `common.`).
2. **API.** `I18nProvider` (inside `AppProviders`) holds the locale; `useT()` returns `t`; `useI18n()` returns `{ locale, setLocale, t,
   format }`; `useFormat()` returns the locale-bound formatters. A pure `translate(locale, key, args)` serves code outside React (the root
   crash fallback, announcements built in non-React modules). Without a provider the hooks use English, so components stay usable in
   isolation and unconverted tests keep passing.
3. **Locale preference.** New pref `locale: 'auto' | 'en' | 'vi'` in `mcs.ui.v3` (ADR 0036), default `auto`: the first entry of
   `navigator.languages` whose primary subtag is supported, else English. `theme-init.js` also sets `<html lang>` before first paint so
   assistive technology never reads Vietnamese with an English voice. There is no per-instance default locale in this version.
4. **Formatting.** All numbers, percentages, bytes, durations, clock times, dates and relative times go through `i18n/format.ts`, which
   takes the locale as an argument and uses `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat` and `Intl.PluralRules`.
   Clock times use `hourCycle: 'h23'` in both languages. Compact numbers use `notation: 'compact'`. `Intl.DurationFormat` is not used (it
   is missing on the Node 22 floor); durations are composed from unit-formatted parts. A test fails on an `Intl` constructor or a
   `toLocale*String` call with a string-literal locale, and on a bare `toLocale*String()` (which would use the browser default, not the
   chosen language).
5. **Server-originated text stays English and is marked.** The server sends fixed English diagnostics: `Metric.source` and `Metric.rule`,
   `StateAssessment.evidence[].text`, alert titles, panel source messages, `ErrorEnvelope.message`, work-item `boardReason`. The UI never
   machine-translates them. UI-owned wording around them is translated; the server text is rendered inside `ServerText`, which sets
   `lang="en"` when the UI language is not English. Metric labels are looked up by `Metric.key` in the catalogue (`metric.<key>`) and fall
   back to the server `label` for an unknown key. `ApiError.message` stays an English diagnostic for logs; the UI derives its text from
   `ApiError.info` through the catalogue.
6. **No literal user-facing text in components.** `i18n/no-literal-text.test.ts` parses every non-test source file with the TypeScript
   compiler API and fails on: JSX text containing letters; string literals in user-facing attributes (`aria-label`, `title`,
   `placeholder`, `alt`, `label`, `caption`, `tip`, `subject`, `noun`, `description`); string or template literals with two or more
   words passed to `announce`, `showToast` or any `*Label`/`*Text`/`*Message` property; and the Intl rules of decision 4. Technical
   strings (class names, ids, routes, `throw new Error` diagnostics, query keys) are exempt. A ratchet file `i18n/literal-baseline.ts` lists
   the files not converted yet, one block per work package; the test fails when a listed file no longer needs the entry, and the baseline
   must be empty when the last UI work package lands. `lib/` tables hold message keys (`labelKey`), never English labels.
7. **Tests use keys.** `test/msg.ts` exports `msg(key, args?, locale = 'en')` and `test/render.tsx` exports `renderWithIntl`. A test
   asserts what the user sees as `msg('state.working')`, never as a typed literal. A catalogue test checks key parity, placeholder parity
   and plural syntax between `en` and `vi`, no empty or untrimmed values, Unicode NFC for every Vietnamese value, no U+FFFD, and a
   blacklist of common Vietnamese words written without diacritics.
8. **Vietnamese copy.** The tone is neutral and polite, using the plain second-person form, not an informal voice. A glossary comment at the
   top of `messages/vi.ts` fixes one term per concept (session, the ten lifecycle states, the token groups, error, warning, live, stale,
   subagent stays untranslated, language names are shown in their own language). The Vietnamese file is written in UTF-8 with real
   characters, never escape sequences. The release text gate (`check-text`) allows Vietnamese letters in that file only.
9. **Not translated.** Command lines, ids, file paths, tool names, model names, the product name and technical keywords in monospace.

## Consequences
- Every UI work package converts the files it rewrites, so conversion costs no separate migration; the baseline file makes progress
  visible and prevents regressions.
- The catalogue is a shared file with one marked block per work package (entries only); the completeness test, not the compiler, guards
  the Vietnamese side of a block because the compiler error appears outside the block.
- Vietnamese strings are longer than English ones; every visual QA run includes Vietnamese at 1024 px to catch clipping.
- Compact numbers differ by language ("12K" in English, "12 N" in Vietnamese); tooltips carry the exact number.
- A native-speaker review of the Vietnamese copy is left to the owner; the automated gates cover encoding, completeness and diacritics
  only.

## Alternatives rejected
- react-i18next, Lingui or FormatJS: dependency and runtime cost, build plugins, and the avoid-list rule for two languages.
- JSON catalogues fetched at run time: an extra request path, offline and CSP concerns, and no compile-time key check.
- Inline per-component translation tables: no single place to check completeness or terminology.
- Machine translation of server diagnostics: the text is short, technical and changes with engine rules; a wrong translation is worse
  than an English sentence marked as English.
- A hard-coded `'en-US'` or `'vi-VN'` in `Intl` calls: breaks the language switch and tests that run under another default locale.

## Evidence
- Probe of 2026-10-18 (read-only, planning notes, not published): 60 of 112 web source files contain user-facing literals, about
  330 occurrences, concentrated in `lib/lifecycle-display.ts` (22), the session detail header (19) and the sessions table (18).
- Probe of 2026-10-18 on Node 24.14.1 (planning notes, not published): `Intl.NumberFormat` compact gives "12K" and "2.5M" in English and "12 N" and "2,5 Tr" in Vietnamese; `Intl.RelativeTimeFormat` narrow gives "3m ago" in English and a full Vietnamese phrase ("3" plus the words for minutes and ago); `Intl.PluralRules` gives only `other` for Vietnamese. `Intl.DurationFormat` exists on Node 24 but ships from V8 12.9, so it is not assumed on the Node 22 floor (UNVERIFIED here: only Node 24 is installed).
- UI review question Q9 (language) and decision 10 of the V4 owner decisions.
