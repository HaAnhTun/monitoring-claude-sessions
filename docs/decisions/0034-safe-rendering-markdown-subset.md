# 0034 Safe rendering: ported Markdown subset, no Markdown library, lint + audit + hostile tests

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` section 8).

## Context
Transcript text is untrusted (C6). Brief 9: "Safe rendering of transcript Markdown and code. No unsafe rendering of untrusted HTML."
The legacy page renders a minimal Markdown subset (fenced code, inline code, paragraphs) with `textContent` only and guards it with a
source-grep test. `stack-versions.md` tested react-markdown + rehype-sanitize as a safe option.

## Decision
- Port the legacy parser (`parseMarkdown`, `parseInline`) verbatim to `src/lib/markdown.ts` and render its block list with a React
  component. Only `prompt` and `say` text use it; everything else is plain text.
- No links, emphasis, headings, lists, images or HTML; URLs stay text. No syntax highlighter.
- Enforcement: ESLint errors for `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`, non-literal
  `href`/`src`/`srcDoc`, `target="_blank"`, `eval`-family; banned imports of Markdown/sanitizer libraries; a source-audit test over
  `src/`; a component test with hostile inputs; an E2E check that hostile fixture strings render as text.
- Long text: client clamp 1,500 chars (legacy), code blocks over 400 lines show the first 200, expanded text capped at 200,000 chars with
  copy for the rest.

## Consequences
- Zero new dependencies; behaviour and look identical to the legacy page.
- Users do not get clickable links or rich formatting in transcripts (deliberate).
- The bundle itself contains `innerHTML` (inside react-dom), so the audit scans `src/`, not `dist/`.

## Alternatives rejected
- react-markdown 10.1.0 + rehype-sanitize 6.0.0 (safe in the smoke test): adds a sizeable tree (225 lines in `npm ls --all`, 15 MB) and renders links, which the
  monitor does not need; revisit only on owner request (listed under CHALLENGES in 04-ui).
- marked/markdown-it + DOMPurify + `dangerouslySetInnerHTML`: HTML-string pipeline, banned.

## Evidence
- Legacy parser and tests: `src/frontend/modules/markdown.js`, `tests/frontend/markdown-safety.test.mjs` (5 tests, all passing per
  `current-state-frontend.md`, run 2026-10-11).
- `docs/research/stack-versions.md` section 7: react-markdown escapes raw HTML, `npm ls --all` 225 lines, 15 MB.
- Vite build probe 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui/app/dist`): grep finds 5 `innerHTML` occurrences inside the bundled
  react-dom, none in app source.
- ESLint `no-restricted-syntax` selector for `dangerouslySetInnerHTML` proven with a negative probe in the stack smoke test
  (`stack-versions.md` section 6).
