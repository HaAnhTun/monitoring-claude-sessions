// Shared parts of the browser contract suite (CAW-50; design 05 sections 6 and 7.1 to 7.4): the responsive, keyboard, language and
// theme specs. It holds the pages they walk, the browser contexts they open, the layout rules as a function that returns problems,
// and the table of known product defects.
//
// The pages are the base view of every route plus the other tabs of the session page and the other sections of Settings (the list
// is `CONTRACT_PAGES` of `src/test/page-matrix.ts`, which a unit test holds against the route table), and after them every view of
// the Workspace (a view of `views.ts` with a terminal side). A page is opened as the capture tool opens its view: on the live QA
// instance, or on the fake API with the canned terminal socket.
//
// The rules of section 7.4 are strict. Where the product breaks one today, the violation is pinned in `KNOWN_DEFECTS` with its
// page, window size, language and measured value: a count must stay exactly as pinned, a pixel value may not pass the pinned value
// plus the ratchet of 24 px, and a pinned violation that no longer shows fails as well (the entry has to be removed with the fix).
// So the suite is green on the product as it is, and red on a new violation, on a known one that grew, and on a stale entry.
//
// Run the specs inside the `run` lock with `MCS_SHOTS_DIR` set to a folder outside the repository (the configuration of the QA
// tool refuses any other). The responsive and the language spec write one picture and one record per page and column there
// (`contract__<page>__<size>__<theme>__<language>.png`, and in `index.json` the measurements with the verdict of every rule).
import { join, sep } from 'node:path';

import { expect, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { PlainKey } from '../../src/test/page-matrix.ts';
import { CONTRACT_PAGES, type ContractPageSpec } from '../../src/test/page-matrix.ts';
import { msg } from '../../src/test/msg.ts';
import { FIXTURE_DETAIL_SESSION_ID, fixtureApi, type FixtureApi } from './fixture-api.ts';
import {
  DEFAULT_VIEWPORTS,
  LOCALES,
  THEMES,
  WIDE_VIEWPORTS,
  columnTitle,
  columnsOf,
  inColumn,
  resolveShotsDir,
  shotFileName,
  type Locale,
  type ShotColumn,
  type Theme,
  type Viewport,
} from './global-setup.ts';
import { measure, scrubPaths, writeIndex, type Measure, type ShotRecord } from './measure.ts';
import { startQaInstance, type QaInstance } from './qa-instance.ts';
import { VIEWS, browserLocaleOf, presetScript, resolveViewUrl, type ViewSpec } from './views.ts';

// ---- the matrix (design 05 section 7.1) ------------------------------------------------------------------------------------------

/** The window sizes every page is held to. Headless Chrome has no window below 500 px. */
export const CONTRACT_VIEWPORTS: readonly Viewport[] = DEFAULT_VIEWPORTS;
/** The two extra sizes of the pages marked `wide` (the Workspace and its terminals). */
export const CONTRACT_WIDE_VIEWPORTS: readonly Viewport[] = WIDE_VIEWPORTS;
export const CONTRACT_THEMES: readonly Theme[] = THEMES;
export const CONTRACT_LOCALES: readonly Locale[] = LOCALES;

export const DESKTOP: Viewport = { width: 1440, height: 900 };
export const TABLET: Viewport = { width: 1024, height: 768 };
export const PHONE: Viewport = { width: 600, height: 900 };

const MATRIX = { viewports: CONTRACT_VIEWPORTS, wideViewports: CONTRACT_WIDE_VIEWPORTS } as const;

/** `1440x900`: how a window size is written in a record and in the known-defect table. */
export function sizeOf(viewport: Viewport): string {
  return `${String(viewport.width)}x${String(viewport.height)}`;
}

// ---- the pages ---------------------------------------------------------------------------------------------------------------------

/** One page of the contract: what it covers and how it is opened. */
export interface ContractPage {
  readonly id: string;
  /** The page of the route table it shows; `null` for a view that no route claims (the style guide). */
  readonly route: ContractPageSpec['route'] | null;
  /** `route`: a page of `CONTRACT_PAGES`; `view`: another view of the QA tool, opened as the capture tool opens it. */
  readonly kind: 'route' | 'view';
  /** The view of the QA tool that opens it (for a tab or a section: the base view with another query). */
  readonly view: ViewSpec;
  /** The key of the `h1` text, or `null` when the heading comes from the data or the state of the page. */
  readonly titleKey: PlainKey | null;
  /** A selector that holds once the content is drawn; `null` when the view says it all (`view.wait` and `view.setup`). */
  readonly content: string | null;
}

function viewOf(id: string): ViewSpec {
  const view = VIEWS.find((candidate) => candidate.id === id);
  if (view === undefined) throw new Error(`the QA tool has no view '${id}'`);
  return view;
}

/** The pages of the route table: the base views, the other tabs of the session page and the other sections of Settings. */
export function routePages(): ContractPage[] {
  return CONTRACT_PAGES.map((spec): ContractPage => {
    const base = viewOf(spec.view);
    const view: ViewSpec = spec.query === undefined ? base : { ...base, id: spec.id, query: spec.query };
    return { id: spec.id, route: spec.route, kind: 'route', view, titleKey: spec.heading, content: spec.content };
  });
}

/**
 * A view of the QA tool as a page: the route page of that id when there is one, else the view as it is (a view with a terminal
 * side is a state of the Workspace).
 */
export function viewPage(id: string): ContractPage {
  const route = routePages().find((candidate) => candidate.id === id);
  if (route !== undefined) return route;
  const view = viewOf(id);
  return {
    id,
    route: view.terminal === undefined ? null : 'workspace',
    kind: 'view',
    view,
    titleKey: null,
    content: null,
  };
}

/** Every other view of the Workspace: the views of `views.ts` that have a terminal side and are no route page. */
export function workspaceViewPages(): ContractPage[] {
  const taken = new Set(CONTRACT_PAGES.map((spec) => spec.id));
  return VIEWS.filter((view) => view.terminal !== undefined && !taken.has(view.id)).map((view) => viewPage(view.id));
}

/** Every page of the contract, the route pages first. */
export function contractPages(): ContractPage[] {
  return [...routePages(), ...workspaceViewPages()];
}

export function pageOf(id: string): ContractPage {
  const found = contractPages().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no contract page '${id}'`);
  return found;
}

/** The `h1` a page shows in a language, or `null` when it is named after its data or its state. */
export function headingOf(page: ContractPage, locale: Locale): string | null {
  return page.titleKey === null ? null : msg(page.titleKey, undefined, locale);
}

/** Whether the view of a page waits for an open terminal: the terminal rules hold there, and a missing terminal is a problem. */
export function expectsTerminal(page: ContractPage): boolean {
  return page.view.wait.includes('[data-terminal]');
}

/** The pages whose view opens the project list at every width: a missing list is a problem there. */
const LIST_PAGES: ReadonlySet<string> = new Set([
  'workspace-projects',
  'workspace-projects-end',
  'workspace-resume-dialog',
]);

/**
 * The columns of the contract in one language: every window size (the wide ones for the pages marked `wide`) in both themes. The
 * forced-colours column of the capture tool is not one of them: the theme spec holds its one rule.
 */
export function contractColumns(locale: Locale, pages: readonly ContractPage[] = contractPages()): ShotColumn[] {
  const views = pages.map((page) => page.view);
  return columnsOf(views, { ...MATRIX, themes: CONTRACT_THEMES, locales: [locale] }).filter(
    (column) => !column.forcedColors,
  );
}

/** The pages that are held to a column: every page at the three sizes, the pages marked `wide` also at the wide ones. */
export function pagesInColumn(column: ShotColumn, pages: readonly ContractPage[] = contractPages()): ContractPage[] {
  return pages.filter((page) => inColumn(page.view, column, MATRIX));
}

/** The window sizes a page is held to. */
export function viewportsOfPage(page: ContractPage): Viewport[] {
  return [...CONTRACT_VIEWPORTS, ...(page.view.wide === true ? CONTRACT_WIDE_VIEWPORTS : [])];
}

export { columnTitle };

// ---- the instance and the browser contexts ---------------------------------------------------------------------------------------

export const test = base.extend<object, { qa: QaInstance }>({
  qa: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function needs from its first parameter, which must be an object pattern
    async ({}, use) => {
      const qa = await startQaInstance();
      try {
        await use(qa);
      } finally {
        await qa.stop();
      }
    },
    { scope: 'worker', timeout: 240_000 },
  ],
});
export { expect };

export interface ContextOptions {
  readonly viewport: Viewport;
  readonly theme: Theme;
  readonly locale: Locale;
  /** Store the theme and the language before the app starts (every navigation); `false` leaves the choice to the page, as a user does. */
  readonly preset?: boolean;
  /** Default `reduce`: the pulse of a live dot would make a measurement depend on the moment it is taken. */
  readonly reducedMotion?: 'reduce' | 'no-preference';
  /** The browser emulates `forced-colors: active`. */
  readonly forcedColors?: boolean;
}

export async function openContext(browser: Browser, options: ContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport,
    colorScheme: options.theme,
    locale: browserLocaleOf(options.locale),
    timezoneId: 'UTC',
    reducedMotion: options.reducedMotion ?? 'reduce',
    forcedColors: options.forcedColors === true ? 'active' : 'none',
    deviceScaleFactor: 1,
  });
  if (options.preset !== false) await context.addInitScript(presetScript(options.theme, options.locale));
  return context;
}

/** The context of one column of the matrix. */
export function openColumn(browser: Browser, column: ShotColumn): Promise<BrowserContext> {
  return openContext(browser, {
    viewport: column.viewport,
    theme: column.theme,
    locale: column.locale,
    forcedColors: column.forcedColors,
  });
}

/** Two animation frames of the page: what was changed is laid out and painted. No fixed wait. */
export const TWO_FRAMES = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))';

const FONTS_THEN_FRAMES = `document.fonts.ready.then(() => ${TWO_FRAMES})`;

const SETTLE_TIMEOUT_MS = 30_000;

/** An open page of the contract. */
export interface OpenedPage {
  readonly page: Page;
  /** The fake API behind it; `null` on the live instance. */
  readonly fixture: FixtureApi | null;
  /** Path and query of the page. */
  readonly url: string;
  /** Console errors and uncaught exceptions so far. */
  consoleErrors(): number;
}

/**
 * Opens a page of the contract and waits until it is drawn and settled: what its view waits for, its content, no skeleton and no
 * busy region (a route page), the fonts, and what the view sets up (an opened list, a drawn terminal, a dialog).
 */
export async function openPage(
  context: BrowserContext,
  qa: QaInstance,
  spec: ContractPage,
  locale: Locale,
): Promise<OpenedPage> {
  const page = await context.newPage();
  let errors = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') errors += 1;
  });
  page.on('pageerror', () => {
    errors += 1;
  });
  const { view } = spec;
  const live = view.mode === 'live';
  const url = resolveViewUrl(view, { detailSessionId: live ? qa.sessions.subagentError : FIXTURE_DETAIL_SESSION_ID });
  const state = view.state ?? 'ok';
  if (state === 'disconnected')
    throw new Error(`contract page ${spec.id}: a disconnected view is no page of the contract`);
  const fixture = live ? null : await fixtureApi(page, state, view.terminal ?? null);
  await page.goto(`${qa.baseUrl}${url}`, { waitUntil: 'domcontentloaded' });
  await page.locator(view.wait).first().waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS });
  if (spec.kind === 'route') {
    await page.locator('main h1').first().waitFor({ state: 'attached', timeout: SETTLE_TIMEOUT_MS });
    if (spec.content !== null) {
      await page.locator(spec.content).first().waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT_MS });
    }
    await expect(page.locator('main .skeleton, main [aria-busy="true"]')).toHaveCount(0, {
      timeout: SETTLE_TIMEOUT_MS,
    });
  }
  await page.evaluate(FONTS_THEN_FRAMES);
  await view.setup?.({ page, mode: view.mode, locale, qa: live ? qa : null, fixture });
  await page.evaluate(TWO_FRAMES);
  if (expectsTerminal(spec)) await terminalFitted(page, spec, fixture);
  return { page, fixture, url, consoleErrors: () => errors };
}

/**
 * Whether the terminal has as many rows as its host has room for. The app fits a terminal 100 ms after its host changed its size
 * (a header that wrapped when the state of the session arrived, the banner of an ended session), so a page is measured only once
 * this holds. Both readings of "room" count: the whole height of the host, and the height without its padding.
 */
const TERMINAL_FITTED = `(() => {
  const host = document.querySelector('[data-terminal][data-rows]');
  const screen = host ? host.querySelector('.xterm-screen') : null;
  if (!host || !screen) return true;
  const rows = Number(host.getAttribute('data-rows'));
  const height = screen.getBoundingClientRect().height;
  if (!(rows > 0) || !(height > 0)) return false;
  const cell = height / rows;
  const style = getComputedStyle(host);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return rows === Math.floor(host.clientHeight / cell) || rows === Math.floor((host.clientHeight - padding) / cell);
})()`;

/** How long a terminal may take to fit its host again. One that never does is measured as it is: its cut rows are a finding. */
const TERMINAL_FIT_TIMEOUT_MS = 5_000;

/**
 * Waits until the terminal of a page fits its host, and until the canned program has drawn its screen for that size. Paced by
 * the state of the page, with no fixed wait.
 */
async function terminalFitted(page: Page, spec: ContractPage, fixture: FixtureApi | null): Promise<void> {
  await expect
    .poll(() => page.evaluate(TERMINAL_FITTED), { timeout: TERMINAL_FIT_TIMEOUT_MS })
    .toBe(true)
    .catch(() => undefined);
  const socket = fixture?.terminal?.socket;
  const name = new URLSearchParams(spec.view.query ?? '').get('session');
  // a session that ended has no socket any more: its last screen stays as it is
  if (socket !== undefined && name !== null && socket.latest(name) !== null) await socket.settle(page, name);
  await page.evaluate(TWO_FRAMES);
}

// ---- the limits (design 05 sections 6 and 7.4) -------------------------------------------------------------------------------------

/** The slack of the ratchet: a limit is the value of the first measured run plus this. */
export const RATCHET_PX = 24;

/** The old limits of ADR 0073 decision 12. They stay as upper bounds of the measured limits below. */
export const MAX_ROW_HEIGHT_1024 = 80;
export const SESSIONS_FIRST_ROW_MAX_TOP = 280;
export const TRANSCRIPT_FIRST_ROW_MAX_TOP = 300;
/** Transcript rows that are in view without scrolling at 600 px. */
export const TRANSCRIPT_ROWS_AT_600 = 3;

/** The limits of the Workspace (design 05 section 7.4). */
export const LIST_FIRST_ROW_MAX_TOP = 110;
export const TERMINAL_HOST_MAX_TOP = 96;
export const TERMINAL_MIN_COLS = 80;

/**
 * What the first measured run of this suite saw (CAW-50, for ADR 0101): the worst value over every page of the contract and both
 * themes, the same in both languages unless said.
 *   - tallest row at 1024 px: 75 (the configuration table of Settings); 75 + 24 is above the old limit, so 80 stays
 *   - top of the first sessions row at 1440x900: 250; the limit becomes 274
 *   - top of the first transcript row at 1440x900: 283.5 in English; 283.5 + 24 is above the old limit, so 300 stays. In
 *     Vietnamese it is 309.5, which breaks the old limit: pinned below (`KD-vi-transcript-top`)
 * Measured in the same run and held to the design values, with no ratchet: four transcript rows in view at 600 px (three are
 * asked for); the narrowest terminal has 83 columns at 600 px (96 at 1024, 127 at 1280, 150 at 1440, 218 at 1920; 80 are asked
 * for); the first project row is at 114 px, and at 153 px in the overlay below 1024 px (limit 110, pinned below); the top of the
 * terminal is between 129 and 317 px (limit 96, pinned below). At most 7 Tab stops come before the main content (limit 10).
 */
export const MEASURED = {
  maxRowHeight1024: 75,
  sessionsFirstRowTop: 250,
  transcriptFirstRowTop: 283.5,
} as const;

/** A measured limit: the measured value plus the ratchet, and never above the old limit. */
export function ratchet(measured: number, oldLimit: number): number {
  return Math.min(oldLimit, measured + RATCHET_PX);
}

/** The limits in force: the ratchet of the three old limits. */
export const LIMITS = {
  maxRowHeight1024: ratchet(MEASURED.maxRowHeight1024, MAX_ROW_HEIGHT_1024),
  sessionsFirstRowTop: ratchet(MEASURED.sessionsFirstRowTop, SESSIONS_FIRST_ROW_MAX_TOP),
  transcriptFirstRowTop: ratchet(MEASURED.transcriptFirstRowTop, TRANSCRIPT_FIRST_ROW_MAX_TOP),
} as const;

// ---- the facts of a page -----------------------------------------------------------------------------------------------------------

/** What the rules read of a drawn page: `measure` and three facts of the transcript and of the project list. */
export interface PageFacts extends Measure {
  /** Top of the first transcript row in page coordinates; null without a transcript. */
  transcriptFirstTop: number | null;
  /** Transcript rows that start inside the window (24 px above its lower edge at the latest). */
  transcriptRowsInView: number;
  /** Top of the first folder of the project list as it is when the list is not scrolled; null when no list is shown. */
  listFirstRowTop: number | null;
}

const EXTRA_FACTS_SCRIPT = `(() => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const round = (n) => Math.round(n * 10) / 10;
  const rows = Array.from(document.querySelectorAll('main li[data-row-key]')).filter(shown);
  const folders = Array.from(document.querySelectorAll('.workspace-sidebar .workspace-folder')).filter(shown);
  // the list scrolls inside its own box: the place of the first folder is where it is before any scrolling
  let scrolled = window.scrollY;
  for (let node = folders[0] ? folders[0].parentElement : null; node; node = node.parentElement) scrolled += node.scrollTop;
  return {
    transcriptFirstTop: rows[0] ? round(rows[0].getBoundingClientRect().top + window.scrollY) : null,
    transcriptRowsInView: rows.filter((el) => el.getBoundingClientRect().top < window.innerHeight - 24).length,
    listFirstRowTop: folders[0] ? round(folders[0].getBoundingClientRect().top + scrolled) : null,
  };
})()`;

/** Measures the page as it is drawn now; the page is not changed. */
export async function factsOf(page: Page): Promise<PageFacts> {
  const measured = await measure(page);
  const raw: unknown = await page.evaluate(EXTRA_FACTS_SCRIPT);
  if (typeof raw !== 'object' || raw === null) throw new Error('factsOf: the page answered no object');
  const extra = raw as Record<string, unknown>;
  const nullable = (key: string): number | null => {
    const value = extra[key];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`factsOf: ${key} is no number`);
    return value;
  };
  return {
    ...measured,
    transcriptFirstTop: nullable('transcriptFirstTop'),
    transcriptRowsInView: nullable('transcriptRowsInView') ?? 0,
    listFirstRowTop: nullable('listFirstRowTop'),
  };
}

// ---- the rules (design 05 section 7.4) ---------------------------------------------------------------------------------------------

export const CONTRACT_RULES = [
  'pageOverflowX',
  'lowContrastTexts',
  'nonMonoText',
  'tinyText',
  'clippedText',
  'clippedColumns',
  'maxRowHeight',
  'sessionsFirstRowTop',
  'transcriptFirstRowTop',
  'transcriptRowsInView',
  'listFirstRowTop',
  'terminalTop',
  'terminalCols',
] as const;
export type ContractRule = (typeof CONTRACT_RULES)[number];

/** A rule whose value is a length in pixels: a pinned violation of it is a ratchet bound, of any other rule an exact count. */
const PIXEL_RULES: ReadonlySet<ContractRule> = new Set([
  'pageOverflowX',
  'maxRowHeight',
  'sessionsFirstRowTop',
  'transcriptFirstRowTop',
  'listFirstRowTop',
  'terminalTop',
]);

/** One rule applied to one page: the value, what the rule asks, and whether it holds. */
export interface Check {
  readonly rule: ContractRule;
  /** `null`: the page does not show what the rule measures although it must (no row, no list, no terminal). */
  readonly value: number | null;
  /** The rule in words, for the message and the record: `0`, `at most 80 px`, `below 96 px`, `at least 80`. */
  readonly wanted: string;
  readonly ok: boolean;
  /** What the value is, for the message. */
  readonly what: string;
}

/** Where a page was measured. */
export interface Place {
  readonly page: ContractPage;
  readonly viewport: Viewport;
  readonly theme: Theme;
  readonly locale: Locale;
}

/** Every rule that applies to a page at a place, each with its value. */
export function checksOf(facts: PageFacts, place: Place): Check[] {
  const { page, viewport } = place;
  const checks: Check[] = [];
  const zero = (rule: ContractRule, value: number, what: string): void => {
    checks.push({ rule, value, wanted: '0', ok: value === 0, what });
  };
  const below = (rule: ContractRule, value: number | null, limit: number, what: string): void => {
    checks.push({ rule, value, wanted: `below ${String(limit)} px`, ok: value !== null && value < limit, what });
  };

  zero('pageOverflowX', facts.pageOverflowX, 'px of horizontal page scroll');
  zero('lowContrastTexts', facts.lowContrastTexts, 'text(s) below the contrast minimum');
  zero('nonMonoText', facts.nonMonoText, 'text element(s) outside the monospace stack');
  zero('tinyText', facts.tinyText, 'text element(s) below 11 px');
  zero('clippedText', facts.clippedText, 'element(s) with text cut off at the bottom');

  if (viewport.width === TABLET.width) {
    zero('clippedColumns', facts.clippedColumns, 'clipped table column(s)');
    checks.push({
      rule: 'maxRowHeight',
      value: facts.maxRowHeight,
      wanted: `at most ${String(LIMITS.maxRowHeight1024)} px`,
      ok: facts.maxRowHeight <= LIMITS.maxRowHeight1024,
      what: 'px, the tallest row',
    });
  }
  const desktop = viewport.width === DESKTOP.width && viewport.height === DESKTOP.height;
  if (desktop && page.id === 'sessions') {
    below(
      'sessionsFirstRowTop',
      facts.firstRowTop,
      LIMITS.sessionsFirstRowTop,
      'px, the top of the first sessions row',
    );
  }
  if (page.id === 'session-detail-transcript') {
    if (desktop) {
      below(
        'transcriptFirstRowTop',
        facts.transcriptFirstTop,
        LIMITS.transcriptFirstRowTop,
        'px, the top of the first transcript row',
      );
    }
    if (viewport.width === PHONE.width) {
      checks.push({
        rule: 'transcriptRowsInView',
        value: facts.transcriptRowsInView,
        wanted: `at least ${String(TRANSCRIPT_ROWS_AT_600)}`,
        ok: facts.transcriptRowsInView >= TRANSCRIPT_ROWS_AT_600,
        what: 'transcript row(s) in view',
      });
    }
  }
  if (facts.listFirstRowTop !== null || LIST_PAGES.has(page.id)) {
    below('listFirstRowTop', facts.listFirstRowTop, LIST_FIRST_ROW_MAX_TOP, 'px, the top of the first project row');
  }
  if (facts.terminal !== null || expectsTerminal(page)) {
    const terminal = facts.terminal;
    below('terminalTop', terminal === null ? null : terminal.top, TERMINAL_HOST_MAX_TOP, 'px, the top of the terminal');
    checks.push({
      rule: 'terminalCols',
      value: terminal === null ? null : terminal.cols,
      wanted: `at least ${String(TERMINAL_MIN_COLS)}`,
      ok: terminal !== null && terminal.cols >= TERMINAL_MIN_COLS,
      what: 'terminal column(s)',
    });
  }
  return checks;
}

// ---- known product defects ---------------------------------------------------------------------------------------------------------

/** Where a known defect shows and what was measured there. */
export interface DefectPin {
  readonly page: string;
  /** `1440x900`. */
  readonly viewport: string;
  /** Both languages when left out. */
  readonly locale?: Locale;
  /** Both themes when left out. */
  readonly theme?: Theme;
  /** A count: the exact value. A pixel value: the measured one, and the bound is this plus the ratchet. */
  readonly measured: number;
}

/** A violation of a rule that the product has today. The entry goes when the defect is fixed: a pin that no longer shows fails. */
export interface KnownDefect {
  readonly id: string;
  readonly rule: ContractRule;
  /** One line: what is wrong in the product. */
  readonly defect: string;
  readonly pins: readonly DefectPin[];
}

type PinOptions = Pick<DefectPin, 'locale' | 'theme'>;

/** The same measured value on several pages and window sizes. */
export function pins(
  pages: readonly string[],
  viewports: readonly string[],
  measured: number,
  options: PinOptions = {},
): DefectPin[] {
  return pages.flatMap((page) => viewports.map((viewport): DefectPin => ({ page, viewport, measured, ...options })));
}

/** The views of the Workspace that show the project column from 1024 px on (a state without folders shows no row). */
const WITH_PROJECT_COLUMN = [
  'workspace',
  'workspace-projects',
  'workspace-projects-end',
  'workspace-session',
  'terminal-colors',
  'terminal-vi',
  'terminal-ended',
  'workspace-kill-dialog',
  'workspace-resume-dialog',
  'workspace-folder-picker-busy',
  'workspace-not-found',
] as const;
/** The same, of the views that are also held to the wide sizes. */
const WIDE_WITH_PROJECT_COLUMN = [
  'workspace',
  'workspace-projects',
  'workspace-session',
  'terminal-colors',
  'terminal-vi',
] as const;
/** The views that open the project list where it is an overlay. */
const WITH_PROJECT_OVERLAY = ['workspace-projects', 'workspace-projects-end', 'workspace-resume-dialog'] as const;

const COLUMN_SIZES = ['1440x900', '1024x768'] as const;
const WIDE_SIZES = ['1920x1080', '1280x720'] as const;
const OVERLAY_SIZES = ['600x900'] as const;

/**
 * The product defects the contract meets today (found by the screenshots of CAW-49 and by the first run of this suite). Each one
 * is a package of its own to fix; none is hidden here: the strict rule still stands for every page and size that is not pinned,
 * and a pin holds its violation to the measured value.
 */
export const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    id: 'KD-main-bleed-clip',
    rule: 'clippedText',
    defect:
      'main.main--bleed hides its vertical overflow while its content is taller than its box (1265 px in 860 px at 1440x900) on every Workspace view that shows the project list',
    pins: [
      ...pins(WITH_PROJECT_COLUMN, COLUMN_SIZES, 1),
      ...pins(WIDE_WITH_PROJECT_COLUMN, WIDE_SIZES, 1),
      ...pins(WITH_PROJECT_OVERLAY, OVERLAY_SIZES, 1),
    ],
  },
  {
    id: 'KD-terminal-host-padding',
    rule: 'clippedText',
    defect:
      'the terminal host has 6 px of top padding that the fit does not subtract: where the height of the host leaves less than 6 px over a whole number of rows, the last row is cut by up to 5 px',
    pins: [
      ...pins(['workspace-session', 'workspace-kill-dialog'], OVERLAY_SIZES, 1),
      ...pins(['terminal-ended'], ['1024x768'], 1, { locale: 'vi' }),
    ],
  },
  {
    id: 'KD-list-first-row',
    rule: 'listFirstRowTop',
    defect:
      'the first project row starts at 114 px (top bar 40, heading 36, filter 30, gap 8), 4 px beyond the limit of 110; in the overlay below 1024 px the Menu bar of the shell adds 39 px',
    pins: [
      ...pins(WITH_PROJECT_COLUMN, COLUMN_SIZES, 114),
      ...pins(WIDE_WITH_PROJECT_COLUMN, WIDE_SIZES, 114),
      ...pins(WITH_PROJECT_OVERLAY, OVERLAY_SIZES, 153),
    ],
  },
  {
    id: 'KD-terminal-top',
    rule: 'terminalTop',
    defect:
      'the terminal starts far below 96 px: the session header wraps to two or three rows (61 to 119 px), the status line adds 28 px, the banner of an ended session 57 to 95 px, and below 1024 px the Menu bar 39 px',
    pins: [
      ...pins(['terminal-colors', 'terminal-vi'], ['1440x900', '1280x720', '1920x1080'], 129),
      ...pins(['workspace-session'], ['1920x1080'], 129),
      ...pins(['workspace-session'], ['1440x900', '1280x720'], 163),
      ...pins(['workspace-kill-dialog'], ['1440x900'], 163),
      ...pins(['terminal-ended'], ['1440x900'], 186),
      ...pins(['terminal-colors', 'terminal-vi'], ['1024x768'], 163),
      ...pins(['workspace-session', 'workspace-kill-dialog'], ['1024x768'], 187),
      ...pins(['terminal-ended'], ['1024x768'], 254, { locale: 'en' }),
      ...pins(['terminal-ended'], ['1024x768'], 278, { locale: 'vi' }),
      ...pins(['terminal-colors', 'terminal-vi'], OVERLAY_SIZES, 202),
      ...pins(['workspace-session', 'workspace-kill-dialog'], OVERLAY_SIZES, 226),
      ...pins(['terminal-ended'], OVERLAY_SIZES, 317),
    ],
  },
  {
    id: 'KD-vi-transcript-top',
    rule: 'transcriptFirstRowTop',
    defect:
      'in Vietnamese the token tile of the session header wraps to a third line at 1440 px, so the first transcript row starts at 309.5 px, beyond the old limit of 300',
    pins: pins(['session-detail-transcript'], ['1440x900'], 309.5, { locale: 'vi' }),
  },
];

function pinApplies(pin: DefectPin, place: Place): boolean {
  if (pin.page !== place.page.id || pin.viewport !== sizeOf(place.viewport)) return false;
  if (pin.locale !== undefined && pin.locale !== place.locale) return false;
  return pin.theme === undefined || pin.theme === place.theme;
}

/** A pin with the entry it belongs to. */
export interface FoundPin {
  readonly defect: KnownDefect;
  readonly pin: DefectPin;
}

/**
 * The pins of a rule at a place. Two defects may break a count rule at the same place (two clipped boxes with two causes): their
 * pins add up. An error when one entry claims a place twice, or when a pixel value is pinned by more than one pin.
 */
export function pinsFor(rule: ContractRule, place: Place, table: readonly KnownDefect[] = KNOWN_DEFECTS): FoundPin[] {
  const found = table
    .filter((defect) => defect.rule === rule)
    .flatMap((defect) => defect.pins.filter((pin) => pinApplies(pin, place)).map((pin): FoundPin => ({ defect, pin })));
  const ids = found.map((entry) => entry.defect.id);
  const where = `${place.page.id} at ${sizeOf(place.viewport)} ${place.theme} ${place.locale}`;
  const twice = ids.find((id, at) => ids.indexOf(id) !== at);
  if (twice !== undefined) throw new Error(`known defect ${twice} pins ${rule} of ${where} twice`);
  if (found.length > 1 && PIXEL_RULES.has(rule)) {
    throw new Error(`known defects ${ids.join(' and ')} both pin the pixel value ${rule} of ${where}`);
  }
  return found;
}

/** The verdict on one page at one place. */
export interface Verdict {
  readonly checks: readonly Check[];
  /** Violations: of a strict rule, of a pin (the defect grew or changed), and pins that no longer show. */
  readonly problems: string[];
  /** The ids of the known defects that showed as pinned. */
  readonly known: string[];
}

/** Holds the checks of a page against the rules and the known-defect table. */
export function judge(checks: readonly Check[], place: Place, table: readonly KnownDefect[] = KNOWN_DEFECTS): Verdict {
  const problems: string[] = [];
  const known: string[] = [];
  for (const check of checks) {
    const found = pinsFor(check.rule, place, table);
    const value = check.value === null ? 'nothing to measure' : `${String(check.value)} ${check.what}`;
    if (found.length === 0) {
      if (!check.ok) problems.push(`${check.rule}: ${value} (rule: ${check.wanted})`);
      continue;
    }
    const ids = found.map((entry) => entry.defect.id);
    const names = `known defect ${ids.join(' + ')}`;
    // counts of several defects add up; a pixel value has one pin
    const pinned = found.reduce((sum, entry) => sum + entry.pin.measured, 0);
    if (check.ok) {
      problems.push(`${check.rule}: ${names} no longer shows here (${value}): remove its pin from KNOWN_DEFECTS`);
    } else if (check.value === null) {
      problems.push(`${check.rule}: ${value}, where ${names} pins ${String(pinned)}`);
    } else if (PIXEL_RULES.has(check.rule)) {
      const bound = pinned + RATCHET_PX;
      if (check.value > bound) {
        problems.push(`${check.rule}: ${names} grew: ${value}, pinned at ${String(pinned)} (bound ${String(bound)})`);
      } else known.push(...ids);
    } else if (check.value !== pinned) {
      problems.push(`${check.rule}: ${names} changed: ${value}, pinned at ${String(pinned)}`);
    } else known.push(...ids);
  }
  return { checks, problems, known };
}

/** The problems of a measured page (the rules and the known-defect table), for a spec that needs no record. */
export function layoutProblems(
  facts: PageFacts,
  place: Place,
  table: readonly KnownDefect[] = KNOWN_DEFECTS,
): string[] {
  return judge(checksOf(facts, place), place, table).problems;
}

/** What is wrong with the known-defect table itself: a pin of a page, a size or a rule that the contract never measures. */
export function tableProblems(table: readonly KnownDefect[] = KNOWN_DEFECTS): string[] {
  const problems: string[] = [];
  const pages = contractPages();
  const ids = table.map((defect) => defect.id);
  for (const id of new Set(ids.filter((id, at) => ids.indexOf(id) !== at)))
    problems.push(`${id}: the id is used twice`);
  for (const defect of table) {
    if (defect.defect.trim() === '') problems.push(`${defect.id}: no description`);
    if (defect.pins.length === 0) problems.push(`${defect.id}: no pin`);
    for (const pin of defect.pins) {
      const where = `${defect.id}: ${pin.page} at ${pin.viewport}`;
      const page = pages.find((candidate) => candidate.id === pin.page);
      if (page === undefined) {
        problems.push(`${where}: no such contract page`);
        continue;
      }
      const viewport = viewportsOfPage(page).find((candidate) => sizeOf(candidate) === pin.viewport);
      if (viewport === undefined) {
        problems.push(`${where}: the page is not measured at this size`);
        continue;
      }
      const facts: PageFacts = {
        pageOverflowX: 0,
        maxRowHeight: 0,
        tabStopsBeforeMain: 0,
        firstRowTop: 0,
        clippedColumns: 0,
        lowContrastTexts: 0,
        worstContrast: null,
        worstContrastNode: null,
        nonMonoText: 0,
        tinyText: 0,
        clippedText: 0,
        terminal: { cols: TERMINAL_MIN_COLS, rows: 24, top: 0, heightRatio: 0.5 },
        transcriptFirstTop: 0,
        transcriptRowsInView: TRANSCRIPT_ROWS_AT_600,
        listFirstRowTop: 0,
      };
      // a pin without a language or a theme stands for both: every place it covers is looked at
      for (const locale of pin.locale === undefined ? CONTRACT_LOCALES : [pin.locale]) {
        for (const theme of pin.theme === undefined ? CONTRACT_THEMES : [pin.theme]) {
          const place: Place = { page, viewport, theme, locale };
          if (!checksOf(facts, place).some((check) => check.rule === defect.rule)) {
            problems.push(`${where}: the rule ${defect.rule} is not applied to this page at this size`);
          }
          try {
            pinsFor(defect.rule, place, table);
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
  }
  return [...new Set(problems)];
}

// ---- one column: every page measured, shot and recorded ---------------------------------------------------------------------------

/** A record of `index.json` with the verdict of the contract on the page it shows. */
export interface ContractRecord extends ShotRecord {
  readonly forcedColors: boolean;
  readonly contract: {
    readonly route: string | null;
    readonly checks: readonly Check[];
    readonly known: readonly string[];
    readonly problems: readonly string[];
    /** The three facts the rules read besides `measure`. */
    readonly facts: Pick<PageFacts, 'transcriptFirstTop' | 'transcriptRowsInView' | 'listFirstRowTop'> | null;
    /** The limits in force and what they were measured from (the ratchet). */
    readonly limits: typeof LIMITS;
    readonly measured: typeof MEASURED;
    readonly ratchetPx: number;
  };
}

/** The file of the picture of a contract page: the name of a shot with `contract__` before it. */
export function contractFileName(pageId: string, column: ShotColumn): string {
  return `contract__${shotFileName(pageId, column)}`;
}

/** The folder of the pictures and of `index.json`: `MCS_SHOTS_DIR`, outside the repository. */
export function shotsDir(): string {
  return resolveShotsDir(process.env['MCS_SHOTS_DIR']);
}

/** The time one column may take: every page is opened, measured and shot once. */
export const columnTimeoutMs = (count: number): number => Math.max(300_000, 60_000 + count * 8_000);

/**
 * Opens every page of a column, measures it, holds it to the rules, shoots it and writes the records to `index.json`. A page that
 * cannot be opened is a problem of that page; the others are still measured. Returns the problems, each with the id of its page.
 */
export async function walkColumn(browser: Browser, qa: QaInstance, column: ShotColumn): Promise<string[]> {
  const dir = shotsDir();
  const context = await openColumn(browser, column);
  const records: ContractRecord[] = [];
  const problems: string[] = [];
  try {
    for (const spec of pagesInColumn(column)) {
      const place: Place = { page: spec, viewport: column.viewport, theme: column.theme, locale: column.locale };
      const file = contractFileName(spec.id, column);
      const head = {
        file,
        view: spec.id,
        mode: spec.view.mode,
        state: spec.view.mode === 'fixture' ? (spec.view.state ?? 'ok') : null,
        viewport: sizeOf(column.viewport),
        theme: column.theme,
        locale: column.locale,
        forcedColors: column.forcedColors,
      } as const;
      const limits = { limits: LIMITS, measured: MEASURED, ratchetPx: RATCHET_PX } as const;
      let opened: OpenedPage | null = null;
      try {
        opened = await openPage(context, qa, spec, column.locale);
        const { page } = opened;
        await scrubPaths(page, [qa.root, qa.root.split(sep).join('/')]);
        const facts = await factsOf(page);
        const verdict = judge(checksOf(facts, place), place);
        await page.screenshot({ path: join(dir, file), animations: 'disabled', caret: 'hide' });
        for (const problem of verdict.problems) problems.push(`${spec.id}: ${problem}`);
        const { transcriptFirstTop, transcriptRowsInView, listFirstRowTop, ...measured } = facts;
        records.push({
          ...head,
          url: opened.url,
          status: 'ok',
          error: null,
          consoleErrors: opened.consoleErrors(),
          measure: measured,
          contract: {
            route: spec.route,
            checks: verdict.checks,
            known: verdict.known,
            problems: verdict.problems,
            facts: { transcriptFirstTop, transcriptRowsInView, listFirstRowTop },
            ...limits,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : String(error);
        problems.push(`${spec.id}: the page could not be opened and measured: ${message}`);
        records.push({
          ...head,
          url: opened?.url ?? '',
          status: 'failed',
          error: message,
          consoleErrors: opened?.consoleErrors() ?? 0,
          measure: null,
          contract: { route: spec.route, checks: [], known: [], problems: [message], facts: null, ...limits },
        });
      } finally {
        await opened?.page.close().catch(() => undefined);
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    writeIndex(dir, records);
  }
  return problems;
}

// ---- the keyboard ------------------------------------------------------------------------------------------------------------------

/** The Tab stops (links, buttons, fields) that the real Tab key passes before focus enters `main`; `null` when it never does. */
export async function tabStopsBeforeMain(page: Page, limit = 40): Promise<number | null> {
  await page.evaluate(
    '(() => { const el = document.activeElement; if (el && el !== document.body) el.blur(); window.scrollTo(0, 0); })()',
  );
  for (let stops = 1; stops <= limit; stops += 1) {
    await page.keyboard.press('Tab');
    const inside: unknown = await page.evaluate(
      "(() => { const el = document.activeElement; const main = document.querySelector('main'); return !!el && !!main && main.contains(el) && el !== main; })()",
    );
    if (inside === true) return stops - 1;
  }
  return null;
}
