// The state a chain-log END line proves (06 3.10.5, ADR 0059): COMPLETED, FAILED or UNKNOWN, with the English evidence text
// that the session view shows. The rules are the ones of the pre-4.0 engine and are pinned by the frozen vectors
// `test/fixtures/attempts/external-state.frozen.json`:
//   - a failure word anywhere in the status, or an exit code other than the text `0`, is FAILED (so `PASS_WITH_ERRORS` and
//     `exit 1 with PASS` fail, and so does `00`, which is not the text `0`);
//   - a status that starts with PASS, DONE, OK, COMPLETE(D) or SUCCESS, or a blank status with exit `0`, is COMPLETED;
//   - anything else (a blank status without an exit code, an unknown word) is UNKNOWN.
// Wording change of 4.0: a missing exit code reads `none` in the evidence (the pre-4.0 engine printed the Python word None).
import type { AttemptEnd } from '../../db/repos/attempts.ts';

/** What a run that has not ended says about itself (06 3.10.3 step 6a). */
export const OPEN_EVIDENCE = 'chain log: started, no END yet';

/** What a run says when a later START of the same part closed it without an END (06 3.10.3 step 6a, D20). */
export function supersededEvidence(part: string): string {
  return `chain log: a later START for part ${part} superseded this attempt`;
}

const PASS_RE = /^\s*(?:PASS|DONE|OK|COMPLETE[D]?|SUCCESS)/i;
const FAIL_RE = /FAIL|BLOCK|ERROR|ABORT/i;

const BACKSLASH = String.fromCharCode(92);
/** Code points that are not printable in the text form of a quoted string: controls, formats, separators, private use. */
const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x09, `${BACKSLASH}t`],
  [0x0a, `${BACKSLASH}n`],
  [0x0d, `${BACKSLASH}r`],
]);

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}

/**
 * The status text in quotes, in the form the pre-4.0 evidence used (the text form of a Python string): single quotes unless the
 * text holds a single quote and no double quote, a backslash before the quote character and before a backslash, `\t \n \r`
 * for those three and `\xNN`, `\uNNNN` or `\UNNNNNNNN` for any other code point that cannot be shown.
 */
function quoted(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const short = SHORT_ESCAPES.get(code);
    if (ch === quote || ch === BACKSLASH) {
      out += BACKSLASH + ch;
    } else if (short !== undefined) {
      out += short;
    } else if (code >= 0x20 && code < 0x7f) {
      out += ch;
    } else if (code < 0x80 || NOT_PRINTABLE.test(ch)) {
      if (code <= 0xff) out += `${BACKSLASH}x${hex(code, 2)}`;
      else if (code <= 0xffff) out += `${BACKSLASH}u${hex(code, 4)}`;
      else out += `${BACKSLASH}U${hex(code, 8)}`;
    } else {
      out += ch;
    }
  }
  return `${quote}${out}${quote}`;
}

/**
 * The state of an ended run. `exitRaw` and `statusRaw` are the exact texts of the `exit` and `status` groups of the END
 * pattern, `null` when the pattern has no such group or the group did not take part.
 */
export function externalState(
  exitRaw: string | null,
  statusRaw: string | null,
): { state: AttemptEnd['state']; evidence: string } {
  const status = statusRaw ?? '';
  const trimmed = status.trim();
  const shown = trimmed === '' ? '-' : trimmed;
  const exit = exitRaw ?? 'none';
  const nonzero = !(exitRaw === null || exitRaw === '' || exitRaw === '0');
  if (nonzero || FAIL_RE.test(status)) return { state: 'FAILED', evidence: `chain log: exit=${exit} status=${shown}` };
  if (PASS_RE.test(status) || (trimmed === '' && exitRaw === '0')) {
    return { state: 'COMPLETED', evidence: `chain log: exit=${exit} status=${shown}` };
  }
  return {
    state: 'UNKNOWN',
    evidence: `chain log: the run ended (exit=${exit}) but its status ${quoted(trimmed)} is neither a pass nor a failure`,
  };
}
