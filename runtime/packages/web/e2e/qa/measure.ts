// Layout facts of one drawn page (WP-122): what a verifier needs to judge a screenshot with numbers instead of by eye.
// The measuring code runs in the browser as a string (the e2e project has no DOM types) and the answer is checked here.
// Rows are `tbody tr`, `[role="row"]` outside a header, and any element a page marks with `data-row` (a card list at a
// narrow width marks its cards that way). Hidden elements are ignored.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

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
}

/** The elements that count as rows of a page (see the header of this file). */
const ROW_SELECTOR = 'main tbody tr, main [role="row"]:not(thead *), main [data-row]';

const MEASURE_SCRIPT = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const round = (n) => Math.round(n * 10) / 10;
  const main = document.querySelector('main');

  const rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)})).filter(visible);
  let maxRowHeight = 0;
  for (const row of rows) maxRowHeight = Math.max(maxRowHeight, row.getBoundingClientRect().height);
  const firstRowTop = rows.length === 0 ? null : round(rows[0].getBoundingClientRect().top + window.scrollY);

  const tabbable = Array.from(
    document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]'),
  ).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('tabindex') === '-1') return false;
    if (el.tagName === 'INPUT' && el.getAttribute('type') === 'hidden') return false;
    if (el.closest('[inert], [hidden]')) return false;
    return visible(el) || el.matches('a, button, input, select, textarea');
  });
  let tabStopsBeforeMain = 0;
  if (main) {
    for (const el of tabbable) {
      if (main.contains(el)) continue;
      if (el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING && visible(el)) tabStopsBeforeMain += 1;
    }
  }

  let clippedColumns = 0;
  for (const table of document.querySelectorAll('main table')) {
    if (!visible(table)) continue;
    let box = table.parentElement;
    while (box && box !== document.body) {
      const overflowX = getComputedStyle(box).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') break;
      box = box.parentElement;
    }
    const limit = Math.min(window.innerWidth, box && box !== document.body ? box.getBoundingClientRect().right : window.innerWidth);
    for (const cell of table.querySelectorAll('thead th')) {
      if (!visible(cell)) continue;
      const r = cell.getBoundingClientRect();
      const s = getComputedStyle(cell);
      const cutByBox = r.right > limit + 1;
      const textCut = s.overflow !== 'visible' && cell.scrollWidth > cell.clientWidth + 1;
      if (cutByBox || textCut) clippedColumns += 1;
    }
  }

  return {
    pageOverflowX: Math.max(0, doc.scrollWidth - doc.clientWidth),
    maxRowHeight: round(maxRowHeight),
    tabStopsBeforeMain,
    firstRowTop,
    clippedColumns,
  };
})()`;

function numberAt(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`measure: ${key} is not a finite number`);
  return value;
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
