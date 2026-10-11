// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseLedger } from './ledger.ts';

describe('parseLedger', () => {
  it('reads the header, drops the separator row and trims the cells', () => {
    const parsed = parseLedger(['| part | status | note |', '|------|:------:|------|', '| 1 | ok | first |']);
    expect(parsed.header).toEqual(['part', 'status', 'note']);
    expect(parsed.rows).toEqual([
      [
        { text: '1', tone: null },
        { text: 'ok', tone: 'completed' },
        { text: 'first', tone: null },
      ],
    ]);
  });

  it('tones PASS-like words completed and FAIL-like words failed, case-insensitively and exactly', () => {
    const words = ['pass', 'PASSED', 'Ok', 'done', 'complete', 'Completed', 'success'];
    const bad = ['fail', 'FAILED', 'Blocked', 'error'];
    const plain = ['passing', 'okay', 'not ok', 'failure', ''];
    const parsed = parseLedger([
      '| v |',
      '| - |',
      ...words.map((w) => `| ${w} |`),
      ...bad.map((w) => `| ${w} |`),
      ...plain.map((w) => `| ${w} |`),
    ]);
    const tones = parsed.rows.map((r) => r[0]?.tone);
    expect(tones.slice(0, words.length)).toEqual(words.map(() => 'completed'));
    expect(tones.slice(words.length, words.length + bad.length)).toEqual(bad.map(() => 'failed'));
    expect(tones.slice(words.length + bad.length)).toEqual(plain.map(() => null));
  });

  it('keeps a second line that is not a separator and skips blank lines', () => {
    const parsed = parseLedger(['| a | b |', '', '| 1 | 2 |', '   ', '| 3 | 4 |']);
    expect(parsed.header).toEqual(['a', 'b']);
    expect(parsed.rows.map((r) => r.map((c) => c.text))).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    const noSeparator = parseLedger(['| a |', '| x |']);
    expect(noSeparator.rows).toEqual([[{ text: 'x', tone: null }]]);
  });

  it('only the second non-blank line can be a separator', () => {
    const parsed = parseLedger(['| a |', '| x |', '|---|']);
    expect(parsed.rows.map((r) => r[0]?.text)).toEqual(['x', '---']);
  });

  it('an empty ledger has no header and no rows', () => {
    expect(parseLedger([])).toEqual({ header: [], rows: [] });
    expect(parseLedger(['', '  '])).toEqual({ header: [], rows: [] });
  });

  it('a header-only ledger has no rows', () => {
    expect(parseLedger(['| part | status |'])).toEqual({ header: ['part', 'status'], rows: [] });
  });

  it('lines without outer pipes lose their outer text exactly like the legacy slice', () => {
    const parsed = parseLedger(['a | b | c', '1 | 2 | 3']);
    expect(parsed.header).toEqual(['b']);
    expect(parsed.rows).toEqual([[{ text: '2', tone: null }]]);
  });
});
