# 0046 Untrusted text never reaches a terminal raw (text and JSON output)

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling/security design (05 section 5.3 S-OUT). Implemented in `packages/cli/src/io/terminal.ts`.

## Context
The CLI prints session labels (first prompts), paths, evidence and error text taken from transcripts. Terminal control sequences in that
text can set the clipboard (OSC 52), the window title, hyperlinks, or hide text; bidi controls can spoof displayed commands. Agents read CLI
output, so it must also stay machine-parseable.

## Decision
- One module writes to stdout/stderr in the CLI (lint: `process.stdout`/`process.stderr` banned elsewhere; `no-console`).
- Text mode escapes as `\uXXXX` all C0 controls except TAB and LF, DEL, C1 (U+0080-U+009F), U+2028, U+2029 and bidi controls U+061C,
  U+200E, U+200F, U+202A-U+202E, U+2066-U+2069.
- JSON mode uses `safeJsonStringify`: `JSON.stringify`, then the same escaping for DEL, C1, U+2028/2029 and bidi (JSON.stringify already
  escapes C0); output parses back to the same strings.
- Colours only around trusted text, only when `isTTY` and `NO_COLOR` unset.

## Consequences
- Output with hostile content is visible but inert; tests compare escaped forms.

## Alternatives rejected
- Stripping control characters: hides evidence that content was hostile.
- Relying on `JSON.stringify`: leaves C1, U+2028 and bidi raw.

## Evidence
- 2026-10-11, Node 24.14.1: `JSON.stringify('a\u001bb\u009bc\u202ed\u2028e')` escaped only U+001B; U+009B, U+202E, U+2028 stayed raw
  (`D:/mvp/private/scratch/mcs-v3/security-probe/probe.mjs`, design 05 E12). Scaffold `sanitizeForTerminal` unit test passed for
  ESC/OSC/BEL/CSI input (E14).
