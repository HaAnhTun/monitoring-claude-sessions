// Ledger table parsing (logic half of legacy modules/panels.js `renderLedger`, 04 section 10). The ledger is a Markdown
// table kept by the chain; the panel shows PASS-like and FAIL-like cells as badges.

export type LedgerTone = 'completed' | 'failed' | null;

export interface LedgerCell {
  text: string;
  tone: LedgerTone;
}

export interface Ledger {
  header: string[];
  rows: LedgerCell[][];
}

const OK_RE = /^(pass(ed)?|ok|done|complete(d)?|success)$/i;
const BAD_RE = /^(fail(ed)?|blocked|error)$/i;
const SEPARATOR_RE = /^[\s|:-]+$/;

function toneOf(text: string): LedgerTone {
  if (OK_RE.test(text)) return 'completed';
  if (BAD_RE.test(text)) return 'failed';
  return null;
}

function cellsOf(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** Blank lines are skipped; the second non-blank line is dropped when it is the table separator; the first is the header. */
export function parseLedger(lines: readonly string[]): Ledger {
  const rows = lines
    .filter((l) => l.trim() !== '')
    .filter((l, i) => !(i === 1 && SEPARATOR_RE.test(l)))
    .map(cellsOf);
  const [header, ...body] = rows;
  return {
    header: header ?? [],
    rows: body.map((cells) => cells.map((text) => ({ text, tone: toneOf(text) }))),
  };
}
