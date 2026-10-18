# 0074 Trust display of lifecycle state and data freshness: observed versus inferred, evidence line, vocabulary

Status: Proposed (V4, milestone M6). Owner: UI (`packages/web`). Amends ADR 0033 (adds how inferred state and stale data are drawn; the
three signals and the "no opacity dimming" rule stand). Builds on ADR 0018 (lifecycle facts) and ADR 0071 (visual system). Records the
UI answers to review questions Q3, Q4, Q5 and Q8.
Planned for a later 4.x release.

## Context
The engine decides a session's state from facts and can only infer some states. A session that went quiet in the middle of a turn stays
`working` with `basis = inferred` and `confidence = medium` until the stale threshold, so the V3 list shows "Working" in blue next to
"Last activity 15m ago", and the evidence that explains it is in a tooltip or behind "Why this state?". The review found that two of
three "Working" sessions of the demo were only inferred from silence. The UI used internal words ("label from rule", "observed",
"medium confidence"). The sidebar group "Idle" held the badge "Turn ended". The session header said "0 errors" for the main agent
while the table said 1 (the error belonged to a subagent). When the connection dropped, the V3 table looked fresh.

## Decision
1. **Honesty first.** The UI shows what the engine knows and how it knows it. It does not change the engine's thresholds (answer to Q4);
   a different stale threshold would be an engine decision in its own ADR.
2. **Inferred state.** A state with `basis = inferred` is drawn with a dashed ring and a tinted background. For the two states
   "active turn" (`working`, `running`) the word gets a question mark ("Working?"). Observed states are drawn solid. Colour never
   carries the meaning alone: the word is always present.
3. **Evidence line.** Under (list) or next to (header) the badge, one muted 12 px line is shown whenever the state is inferred or a tool is
   open: for an inferred active state the UI composes "inferred, quiet 18m" from `lastActivityAt` and the user's clock, in the active
   language; for any other state the first evidence item of the assessment is shown as server text (`ServerText`, English, clamped to one
   line). `basis` and `confidence` are mapped to plain words ("Observed directly", "Inferred from silence", "Inferred from the
   transcript", "High / medium / low confidence") and appear in the evidence popover, not as raw enum values. The rule id (for example
   `S-7e`) moves to the "Details" section. The full evidence list opens from the line.
4. **Vocabulary (Q3).** The ten lifecycle states keep their meaning and get one label and one one-sentence description each (tooltip,
   evidence popover, shortcuts and help text): Working (a turn is in progress and the engine saw it), Running (the session is active
   but the turn structure is unknown, for example only file writes were seen), Waiting for tool, Waiting for subagent, Waiting for input,
   Turn ended, Completed, Failed, Stale, Unknown. "Turn ended" is kept and is not renamed "Waiting for you" (the engine has a separate
   `waiting_input` state; the rename would claim knowledge the system does not have). Sidebar and filter group names equal the badge
   names (the group "Idle" becomes "Turn ended"). The "Stale or unknown" group keeps its title but Stale and Unknown stay separate badges.
5. **Tokens vocabulary.** One set of words everywhere: **Output**, **Input (new)** (= input plus cache creation, with the sum in the
   tooltip), **Cache read**; the Tokens tab also shows Input and Cache write separately. A missing value is "not available"; it is never
   0. A lower-bound figure carries the "lower bound" tag.
6. **Error counts (Q5).** The session error count includes subagent errors (the engine's behaviour, kept). Wherever the count of one agent
   is shown next to the session count, the UI breaks it down: "0 errors in this agent, 1 in subagents", with a link to the Errors tab,
   which lists every error of the session with its agent. A table cell with no errors is empty, not "none".
7. **Stale and disconnected data.** Unchanged from ADR 0033: no opacity dimming. When the client is not in sync the main region gets
   the dashed stale outline and the pages that list data show the as-of line ("sessions as of 09:21:40, 16 s ago") through
   `StaleDataIndicator`; the review's suggestion to dim the table (N-5) is not adopted. Ingestion is "unknown (last known ...)" while
   the client is not in sync.
8. **Overview figures (Q8).** Token figures and the cost estimate come from the overview metrics of the server. The UI shows a metric only
   when the server returns it, with its server source and rule in an info tip; it never computes a figure the server did not provide.
   The attention strip tiles "Quiet (inferred)" and "With errors" use server metrics when present; otherwise they are computed from the
   loaded rows only when the whole list is loaded, and are hidden otherwise.
9. **Live behaviour.** A row whose state changes updates in place; the list does not reorder while the user reads (new sessions join
   only through the existing "list changed" notice, which stays visible while the page scrolls).

## Consequences
- A "Working?" row is visibly less certain than a "Working" row, which can feel alarming for sessions that are merely thinking; the
  evidence line gives the reason and the age.
- English evidence text appears inside Vietnamese pages (marked with `lang="en"`); only UI-composed phrases are translated.
- The attention strip needs two server counts that do not exist at the V3 head (quiet inferred, with errors); until the server adds them
  the strip degrades as in decision 8.
- Tests can assert the question mark rule, the evidence composition and the breakdown without the engine, from fixtures.

## Alternatives rejected
- Let the engine switch an inferred session to Stale earlier: changes product semantics for every consumer; not a UI decision.
- Dim the table when disconnected: fails WCAG 1.4.3 (ADR 0033) and hides the as-of line's job.
- Show confidence as a numeric score or percentage: the engine's confidence is an ordinal (high, medium, low).
- Count only main-agent errors in the session count: hides failures that matter.
- Translate the evidence sentences in the UI: they come from engine rules; see ADR 0072 decision 5.

## Evidence
- UI/UX review of 2026-10-12, sections 0.1, 0.2 (D4, D7), 2 (R-02, R-03, R-12, R-21) and 0.3 (N-5, N-7) (planning artefact).
- `StateAssessmentSchema` (`basis`, `confidence`, `rule`, `evidence`) and `AgentNodeSchema.errorCount` in `packages/shared/src/api/entities.ts`.
- Lifecycle decision table rules S-7 and S-9 in the ingestion design (state `running` means active with unknown turn structure).
