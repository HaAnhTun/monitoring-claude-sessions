# 0107 Attention semantics, the seen model and fixed-text notifications

Status: Accepted (CAW, 2026-11-23). Owner: the attention block (shared classifier `packages/shared/src/attention.ts`; the web attention
centre builds on it). Amends ADR 0074 (state words: `waiting_input` is shown with two words, decision 8 below). ADR 0073 decision 7 is
unchanged (the strip is additive). ADR 0018 (the lifecycle rules) is unchanged: this ADR reads its rule ids and changes none. The Status
line of ADR 0074 is updated by the documentation package of the program. Related: 0079 (monitoring is read-only), 0108 (`events` and
`wait` use the same classifier).

## Context
The lifecycle answers ten states. One of them, `waiting_input`, covers two situations that ask very different things of a person: an agent
that is blocked on a permission prompt or a question (rules S-6a, S-6b, S-6c) and an agent that finished its turn and waits for the next
prompt (S-8b, S-8c) or for its first one (S-8f). S-6b and S-8b even carry the same `waitReason: user`. A badge, a counter, a notification
or a script that keys on the state or on the wait reason cannot tell "blocked, come now" from "done, come when you like", and a signal that
is wrong half of the time is ignored all of the time.

The application also gained places that must agree on this: the state badge, the tiles, a strip in the workspace, the tab title and
favicon, an optional OS notification, and the commands `events` and `wait`. Each of them computing "needs attention" on its own would drift.

## Decision
1. **Attention keys on the lifecycle rule.** One pure, isomorphic function (`attentionOf`, no clock, no I/O, no zod) maps
   `StateAssessment` (`state`, `rule`, `waitReason`, `turnOutcome`) to a posture (`needs_you`, `failed`, `ready`, `working`, `ended`,
   `unknown`), a reason (`permission`, `question`, `not_linked`, `session_failed`, `turn_failed`, `turn_done`, `session_done`,
   `interrupted`, `first_prompt`) and the rule family (`S-6`, `S-8`, ...). The table `ATTENTION_RULES` lists every rule id: S-6 is
   `needs_you`; S-8b and S-8c are `ready`/`turn_done`; S-8e follows the turn outcome (ok `ready`, error `failed`, interrupted
   `ready`/`interrupted`); S-8f is `ready`/`first_prompt`; S-8a (background work goes on) and S-7, S-9 are `working`; S-3b and S-4a are
   `ended`; S-3a and S-4b are `failed`; S-1 is one rule in the engine and is classified by its state (completed, failed, otherwise
   unknown). The class never follows the state or the wait reason alone.
2. **Unknown stays unknown.** A state `unknown` or `stale` is never promoted, whatever the rule. A rule the table does not know is
   classified by its state, and a `waiting_input` of an unknown rule is `unknown`, never `needs_you`. A drift guard in the engine
   (`lifecycle/attention-rules.test.ts`) reads `derive-session.ts` as text and fails unless its `ruleId` literals and the keys of
   `ATTENTION_RULES` are the same set, so a new rule cannot ship unclassified.
3. **Terminal rows without a monitor row are classified from their link** (`attentionOfLink`, family `link`): `pending` with reason
   `no_registry` (the server's 30 s rule) is `needs_you`/`not_linked` ("needs a look": the trust-folder dialog case); a linked terminal
   without a transcript follows the registry status (`waiting` needs you, `idle` is ready for the first prompt, `busy` works); everything
   else, including `ambiguous` and `registry_unreadable`, is `unknown` (an infrastructure problem pages nobody). The client never measures
   the 30 s itself. A terminal that vanished is not promoted to anything.
4. **Levels and order.** Levels, highest first: `needs_you`, `failed`, `done`, `working`, `idle`, `unknown` (`levelOf`). `needs_you` is a
   level for as long as the posture holds. `failed` and `done` are levels only until the person has seen them, then the row is `idle`;
   only a finished turn and a finished session are `done` (an interrupted turn and a session that waits for its first prompt are `idle`).
   Inside `needs_you` the longest blocked comes first, inside the other levels the newest; a row without a time is last
   (`compareAttention`).
5. **Events are transitions, and the first snapshot is silent** (`attentionEventOf`). Entering `needs_you` or `failed` is an event;
   staying in the posture is not (S-6b to S-6c, S-8b to S-8c). `done` needs a previous posture that was active (`working` or `needs_you`):
   a session first seen already ready never produces it, an interrupted turn, S-8a and S-8f never do. The first snapshot a client ever
   sees produces nothing; an id that joins later fires only when it is already `needs_you` or `failed`. `since` is never part of the
   transition test (registry stamps drift inside one posture); it is only part of the notifier's de-duplication key.
6. **The seen model and the delayed, re-checked signal are the client's.** What a person has seen is recorded in the browser, with
   bounds, and a signal is raised only after a short delay and a second look at the then-current class, so a posture that flips back at
   once signals nothing. The numbers and the storage format are set by the web packages that build them (design
   `attention-trust` sections 3.3 and 3.4) and are recorded with them.
   The numbers as built (CAW-82, CAW-84): the seen map holds at most 64 session ids with the time of the state that was seen, the oldest
   leave first; a row counts as seen after the person has looked at it for 1 s on a visible, focused page; a signal waits 5 s by default
   (the preference `attentionDelaySeconds`, 0 to 60); the notifier remembers the last 256 `(row, kind, since)` triples it fired, so
   nothing fires twice.
7. **Notifications carry fixed text.** The words of a title change and of an OS notification come from the message catalogues. No
   transcript text, tool input, registry text or evidence text is ever part of a signal. Whether a workspace name may appear is one browser preference (`workspaceTitles`); the scope of all signals is one preference
   (`attentionScope`). There is no sound. The OS notification is off by default until its spike is recorded as passed.
   As built (CAW-84): the title of an OS notification is the application title and its body one catalogue sentence with a count ("A
   Claude session needs you", "3 Claude sessions need you"); every notification has the tag `caw-attention` with `renotify` and
   `silent`, so a newer one replaces the older one without a sound of the system. The tab title gets a count in words in front of the
   page name, never a name.
8. **Two words for `waiting_input`, in one place.** The state badge, the tiles and the workspace strip show `waiting_input` with two
   words: "needs you" for the S-6 family and "ready" for S-8b, S-8c and S-8f. This amends the single word of ADR 0074. The sidebar groups
   of the session switcher, the state filter of the Sessions page and its view model keep the umbrella word "needs input" on purpose: they
   group and filter by the lifecycle state, and `waiting_input` is one value there. The UX audit may revisit it.
9. **No server contract.** The classifier is shared code over fields the API already sends. No route, no stream frame, no database column
   and no config key is added; the server computes no attention.

## Consequences
- The web and the CLI cannot disagree about "needs you": both call the same table, and the acceptance table of the design is its unit test
  (`attention.test.ts`, TC-ATT-01 to 09).
- A new lifecycle rule fails the drift guard until it has a row. The guard is a blunt source scan; it also fails when a `ruleId` in
  `derive-session.ts` stops being a plain string literal, which is intended.
- An unknown rule degrades to "by state", and to `unknown` for `waiting_input`: an older client against a newer server under-reports a
  block instead of inventing one. A missed block is the worse error in general, which is why the drift guard exists.
- `ready` after `working` is `done` even when the turn produced nothing useful: the classifier reports that the turn ended, not that the
  work is good.

## Alternatives rejected
- **Key on `state` plus `waitReason`.** S-6b and S-8b are identical in both; the difference is only in the rule.
- **A new lifecycle state or a new API field `attention`.** A contract change for something that is a pure function of fields already
  sent; every consumer (stream, export, MCP, CLI) would have had to follow.
- **Split S-1 into two table rows (S-1a, S-1b).** The engine has one `S-1` literal; the drift guard compares the id sets exactly.
- **Rename the session filter to the two words now.** It filters by the lifecycle state; see decision 8.
- **A sound.** A third signal on top of title, favicon and strip, off by default and needing a user gesture; cut after review.

## Bundle budget
The attention center is in every build: All JS (gzip) grew from 429.1 kB to 441.4 kB. The limit of the budget check goes from
432 kB (ADR 0135) to 446 kB, the measured value plus one percent. Initial JS is 191.2 kB against its unchanged limit of 200 kB. The sum of all JS and the optional GPU chunk that the owner accepts goes
from 475 kB (ADR 0135, question 1) to 480 kB (owner, 2026-11-23).

## Evidence
- `runtime/packages/shared/src/attention.ts`, `attention.test.ts`; `runtime/packages/engine/src/lifecycle/attention-rules.test.ts`.
- `runtime/packages/engine/src/lifecycle/derive-session.ts` (the 26 `ruleId` literals S-1 to S-10).
- Design `attention-trust`, amendment block A and sections 2, 3 and 10 (working material of the program).
- ADR 0018 (lifecycle rules), ADR 0074 (state words, amended), ADR 0073 decision 7, ADR 0079.
