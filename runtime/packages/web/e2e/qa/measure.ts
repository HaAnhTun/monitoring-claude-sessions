// Layout facts of one drawn page (WP-122): what a verifier needs to judge a screenshot with numbers instead of by eye.
// The measuring code (`measure-script.ts`) runs in the browser as a string (the e2e project has no DOM types) and the answer is
// checked here. Rows are `tbody tr`, `[role="row"]` outside a header, and any element a page marks with `data-row` (a card list at
// a narrow width marks its cards that way). Hidden elements are ignored.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { MEASURE_SCRIPT, ROW_SELECTOR } from './measure-script.ts';

/** One line of `index.json`: a picture and the facts measured on the page it shows. */
export interface ShotRecord {
  readonly file: string;
  readonly view: string;
  readonly mode: 'live' | 'fixture';
  readonly state: string | null;
  readonly viewport: string;
  readonly theme: 'light' | 'dark';
  readonly locale: 'en' | 'vi';
  readonly url: string;
  readonly status: 'ok' | 'failed';
  readonly error: string | null;
  /** Console errors and uncaught exceptions of the page. */
  readonly consoleErrors: number;
  readonly measure: Measure | null;
}

const LF = String.fromCharCode(10);

export interface ShotsIndex {
  readonly version: 1;
  readonly files: readonly ShotRecord[];
}

export interface Measure {
  /** Pixels by which the page is wider than the window (0 = no horizontal page scroll). Measured with `scrollWidth` against `clientWidth`. */
  pageOverflowX: number;
  /** Height of the tallest row in pixels (0 when the page shows no row). */
  maxRowHeight: number;
  /** Tab stops (links, buttons, fields) that come before the main landmark in document order. */
  tabStopsBeforeMain: number;
  /** Distance from the top of the page to the first row (null when there is no row). */
  firstRowTop: number | null;
  /** Table columns whose header is cut off by the window or its scroll box, or whose text is clipped. */
  clippedColumns: number;
  /** Visible text nodes below the contrast minimum (4.5:1, 3:1 for large text; design 05 section 7.3). */
  lowContrastTexts: number;
  /** The lowest contrast ratio of any text on the page (null when the page has no text to judge). */
  worstContrast: number | null;
  /** The element and the start of the text that has `worstContrast`, for example `p.muted "Last activity"`. */
  worstContrastNode: string | null;
  /** Text elements whose first font family is not the first family of `--mono`. */
  nonMonoText: number;
  /** Visible text elements with a computed size below 11 px. */
  tinyText: number;
  /** Elements with text cut off at the bottom (a clipped diacritic). */
  clippedText: number;
  /** The terminal host (`[data-terminal][data-cols][data-rows]`); null when the page has none. */
  terminal: TerminalMeasure | null;
}

export interface TerminalMeasure {
  cols: number;
  rows: number;
  /** Distance from the top of the page to the terminal host. */
  top: number;
  /** Height of the terminal host divided by the height of the window. */
  heightRatio: number;
}

function numberAt(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`measure: ${key} is not a finite number`);
  return value;
}

function nullableNumberAt(object: Record<string, unknown>, key: string): number | null {
  return object[key] === null ? null : numberAt(object, key);
}

function nullableStringAt(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`measure: ${key} is neither null nor a string`);
  return value;
}

function terminalAt(object: Record<string, unknown>): TerminalMeasure | null {
  const value = object['terminal'];
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('measure: terminal is neither null nor an object');
  const record = value as Record<string, unknown>;
  return {
    cols: numberAt(record, 'cols'),
    rows: numberAt(record, 'rows'),
    top: numberAt(record, 'top'),
    heightRatio: numberAt(record, 'heightRatio'),
  };
}

/** The number of visible rows (see the header of this file). */
export async function countRows(page: Page): Promise<number> {
  const count: unknown = await page.evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)})).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length`,
  );
  if (typeof count !== 'number') throw new Error('countRows: the page answered no number');
  return count;
}

/** Measures the page as it is drawn now; the page is not changed (no focus, no scroll). */
export async function measure(page: Page): Promise<Measure> {
  const raw: unknown = await page.evaluate(MEASURE_SCRIPT);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('measure: the page answered no object');
  const object = raw as Record<string, unknown>;
  const first = object['firstRowTop'];
  if (first !== null && (typeof first !== 'number' || !Number.isFinite(first))) {
    throw new Error('measure: firstRowTop is neither null nor a number');
  }
  return {
    pageOverflowX: numberAt(object, 'pageOverflowX'),
    maxRowHeight: numberAt(object, 'maxRowHeight'),
    tabStopsBeforeMain: numberAt(object, 'tabStopsBeforeMain'),
    firstRowTop: first,
    clippedColumns: numberAt(object, 'clippedColumns'),
    lowContrastTexts: numberAt(object, 'lowContrastTexts'),
    worstContrast: nullableNumberAt(object, 'worstContrast'),
    worstContrastNode: nullableStringAt(object, 'worstContrastNode'),
    nonMonoText: numberAt(object, 'nonMonoText'),
    tinyText: numberAt(object, 'tinyText'),
    clippedText: numberAt(object, 'clippedText'),
    terminal: terminalAt(object),
  };
}

/**
 * Replaces `needles` (the temp tree of the instance, in both slash forms) in the text of the page with a placeholder of the same
 * length, so that a screenshot never shows a folder of the machine and the layout does not change.
 */
export async function scrubPaths(page: Page, needles: readonly string[]): Promise<void> {
  const list = needles.filter((needle) => needle.length > 3);
  if (list.length === 0) return;
  await page.evaluate(
    `((needles) => {
      const mask = (n) => '<' + 'qa-root' + '-'.repeat(Math.max(0, n - 9)) + '>';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        let text = node.nodeValue || '';
        for (const needle of needles) text = text.split(needle).join(mask(needle.length));
        if (text !== node.nodeValue) node.nodeValue = text;
      }
    })(${JSON.stringify(list)})`,
  );
}

/** Reads `index.json` of a folder; a missing or damaged file is an empty index. */
export function readIndex(dir: string): ShotsIndex {
  const path = join(dir, 'index.json');
  if (!existsSync(path)) return { version: 1, files: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'files' in parsed && Array.isArray(parsed.files)) {
      return { version: 1, files: parsed.files as ShotRecord[] };
    }
  } catch {
    // a damaged index is rebuilt from the records of this run
  }
  return { version: 1, files: [] };
}

/** Adds `records` to `index.json`; a record of an earlier run with the same file name is replaced. Returns the new index. */
export function writeIndex(dir: string, records: readonly ShotRecord[]): ShotsIndex {
  const byFile = new Map(readIndex(dir).files.map((record) => [record.file, record]));
  for (const record of records) byFile.set(record.file, record);
  const files = [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const index: ShotsIndex = { version: 1, files };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2) + LF);
  return index;
}
