// The responsive contract (CAW-50; design 05 sections 6 and 7.4): every page of the contract at 600, 1024 and 1440 px, and the
// pages of the Workspace also at 1280 and 1920 px, in both themes, in English (the language spec walks the same matrix in
// Vietnamese). No horizontal page scroll, no text below the contrast minimum, outside the monospace stack, below 11 px or cut off;
// at 1024 px no clipped column and no row above the limit; at 1440x900 the first sessions row and the first transcript row above
// their limits; at 600 px three transcript rows in view; the first project row above 110 px; a terminal of at least 80 columns
// whose top is above 96 px. A violation that the product has today is pinned in `KNOWN_DEFECTS` of `contract.ts` and must show
// exactly as pinned. One test walks one column (window size and theme) over all its pages, so a broken page never hides the others;
// it writes one picture and one record per page to `MCS_SHOTS_DIR`. The last tests prove every rule on a page made to break it.
// Run it inside the `run` lock with `MCS_SHOTS_DIR` set (see `contract.ts`).
import type { Page } from '@playwright/test';

import {
  CONTRACT_RULES,
  CONTRACT_THEMES,
  CONTRACT_VIEWPORTS,
  CONTRACT_WIDE_VIEWPORTS,
  DESKTOP,
  KNOWN_DEFECTS,
  LIMITS,
  LIST_FIRST_ROW_MAX_TOP,
  MAX_ROW_HEIGHT_1024,
  MEASURED,
  PHONE,
  RATCHET_PX,
  SESSIONS_FIRST_ROW_MAX_TOP,
  TABLET,
  TERMINAL_HOST_MAX_TOP,
  TERMINAL_MIN_COLS,
  TRANSCRIPT_FIRST_ROW_MAX_TOP,
  checksOf,
  columnTimeoutMs,
  columnTitle,
  contractColumns,
  contractPages,
  expect,
  expectsTerminal,
  factsOf,
  judge,
  layoutProblems,
  openContext,
  pageOf,
  pagesInColumn,
  pins,
  ratchet,
  sizeOf,
  tableProblems,
  test,
  walkColumn,
  type ContractRule,
  type KnownDefect,
  type PageFacts,
  type Place,
} from './contract.ts';
import type { Viewport } from './global-setup.ts';

for (const column of contractColumns('en')) {
  const pages = pagesInColumn(column);
  test(`${columnTitle(column)}: every page keeps the layout contract`, async ({ browser, qa }) => {
    test.setTimeout(columnTimeoutMs(pages.length));
    const problems = await walkColumn(browser, qa, column);
    expect(problems, `layout problems at ${columnTitle(column)}`).toEqual([]);
  });
}

// ---- the matrix, the limits and the table --------------------------------------------------------------------------------------

test.describe('the contract itself', () => {
  test('walks every page at the three sizes, and the wide pages at the two wide sizes, in both themes', () => {
    expect(CONTRACT_VIEWPORTS.map(sizeOf)).toEqual(['1440x900', '1024x768', '600x900']);
    expect(CONTRACT_WIDE_VIEWPORTS.map(sizeOf)).toEqual(['1920x1080', '1280x720']);
    const columns = contractColumns('en');
    expect(columns).toHaveLength((CONTRACT_VIEWPORTS.length + CONTRACT_WIDE_VIEWPORTS.length) * CONTRACT_THEMES.length);
    const all = contractPages();
    for (const column of columns) {
      const wide = CONTRACT_WIDE_VIEWPORTS.some((viewport) => sizeOf(viewport) === sizeOf(column.viewport));
      const expected = wide ? all.filter((page) => page.view.wide === true) : all;
      expect(pagesInColumn(column).map((page) => page.id)).toEqual(expected.map((page) => page.id));
      expect(expected.length, columnTitle(column)).toBeGreaterThan(0);
    }
  });

  test('holds the pages of every route, the open terminals and the states of the Workspace', () => {
    const pages = contractPages();
    const ids = pages.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['workspace', 'overview', 'sessions', 'session-detail-transcript', 'settings-about']) {
      expect(ids).toContain(id);
    }
    // the terminal rules need open terminals, the list rule needs the list, and the notices of the pane are pages too
    expect(pages.filter(expectsTerminal).map((page) => page.id)).toEqual(
      expect.arrayContaining(['workspace-session', 'terminal-colors', 'terminal-vi', 'terminal-ended']),
    );
    expect(ids).toEqual(expect.arrayContaining(['workspace-projects', 'workspace-no-access', 'workspace-error']));
    expect(pages.filter((page) => page.kind === 'view').every((page) => page.route === 'workspace')).toBe(true);
  });

  test('the limits in force are the measured values plus the ratchet, and never above the old limits', () => {
    expect(RATCHET_PX).toBe(24);
    expect(LIMITS.maxRowHeight1024).toBe(Math.min(MAX_ROW_HEIGHT_1024, MEASURED.maxRowHeight1024 + RATCHET_PX));
    expect(LIMITS.sessionsFirstRowTop).toBe(
      Math.min(SESSIONS_FIRST_ROW_MAX_TOP, MEASURED.sessionsFirstRowTop + RATCHET_PX),
    );
    expect(LIMITS.transcriptFirstRowTop).toBe(
      Math.min(TRANSCRIPT_FIRST_ROW_MAX_TOP, MEASURED.transcriptFirstRowTop + RATCHET_PX),
    );
    expect([MAX_ROW_HEIGHT_1024, SESSIONS_FIRST_ROW_MAX_TOP, TRANSCRIPT_FIRST_ROW_MAX_TOP]).toEqual([80, 280, 300]);
    expect([LIST_FIRST_ROW_MAX_TOP, TERMINAL_HOST_MAX_TOP, TERMINAL_MIN_COLS]).toEqual([110, 96, 80]);
    expect(ratchet(10, 80)).toBe(34);
    expect(ratchet(70, 80)).toBe(80);
  });

  test('the known-defect table pins only pages, sizes and rules that the contract measures', () => {
    expect(tableProblems()).toEqual([]);
    for (const defect of KNOWN_DEFECTS) {
      expect(CONTRACT_RULES, defect.id).toContain(defect.rule);
      expect(defect.defect.length, defect.id).toBeGreaterThan(20);
    }
  });
});

// ---- every rule fails on a page made to break it ---------------------------------------------------------------------------------

/** A page in the monospace stack, black on white: nothing of it breaks a rule until a probe adds what does. */
function probeHtml(body: string, style = ''): string {
  return `<!doctype html><html><head><style>
    html { --mono: 'Cascadia Mono', monospace; }
    body { margin: 0; font-family: var(--mono); font-size: 14px; color: #000; background: #fff; }
    h1 { margin: 0; font-size: 20px; }
    ${style}
  </style></head><body><main><h1>Probe</h1>${body}</main></body></html>`;
}

const TERMINAL_OK = `<div data-terminal data-cols="${String(TERMINAL_MIN_COLS)}" data-rows="24" style="height: 300px"></div>`;

function placeOf(id: string, viewport: Viewport): Place {
  return { page: pageOf(id), viewport, theme: 'light', locale: 'en' };
}

const NO_DEFECTS: readonly KnownDefect[] = [];

test.describe('negative probes', () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await page.context().close();
  });

  /** The rules a probe page breaks at a place, with no known defect to excuse any. */
  async function broken(html: string, id: string, viewport: Viewport): Promise<ContractRule[]> {
    await page.setViewportSize(viewport);
    await page.setContent(html);
    const place = placeOf(id, viewport);
    const verdict = judge(checksOf(await factsOf(page), place), place, NO_DEFECTS);
    return verdict.checks.filter((check) => !check.ok).map((check) => check.rule);
  }

  test('a page that fits breaks no rule, at every size and as every kind of page', async () => {
    const table = '<table><thead><tr><th>One</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>';
    const transcript = '<ul><li data-row-key="1">a</li><li data-row-key="2">b</li><li data-row-key="3">c</li></ul>';
    const list = '<div class="workspace-sidebar"><ul><li class="workspace-folder">folder</li></ul></div>';
    for (const viewport of [...CONTRACT_VIEWPORTS, ...CONTRACT_WIDE_VIEWPORTS]) {
      expect(await broken(probeHtml(table), 'sessions', viewport), sizeOf(viewport)).toEqual([]);
      expect(await broken(probeHtml(transcript), 'session-detail-transcript', viewport), sizeOf(viewport)).toEqual([]);
      expect(await broken(probeHtml(list), 'workspace-projects', viewport), sizeOf(viewport)).toEqual([]);
      expect(await broken(probeHtml(TERMINAL_OK), 'workspace-session', viewport), sizeOf(viewport)).toEqual([]);
    }
  });

  test('a page wider than the window is reported', async () => {
    const html = probeHtml('<div style="width: 2400px; height: 20px">wide</div>');
    for (const viewport of CONTRACT_VIEWPORTS) {
      expect(await broken(html, 'overview', viewport), sizeOf(viewport)).toEqual(['pageOverflowX']);
    }
  });

  test('text below the contrast minimum, outside the monospace stack, below 11 px and cut off is reported', async () => {
    expect(await broken(probeHtml('<p style="color: #ccc">pale</p>'), 'overview', DESKTOP)).toEqual([
      'lowContrastTexts',
    ]);
    expect(await broken(probeHtml('<p style="font-family: Arial">sans</p>'), 'overview', DESKTOP)).toEqual([
      'nonMonoText',
    ]);
    expect(await broken(probeHtml('<p style="font-size: 10px">tiny</p>'), 'overview', DESKTOP)).toEqual(['tinyText']);
    expect(
      await broken(
        probeHtml('<p style="height: 10px; line-height: 20px; overflow: hidden">cut</p>'),
        'overview',
        PHONE,
      ),
    ).toEqual(['clippedText']);
  });

  test('a clipped column and a tall row are reported at 1024 px, and only there', async () => {
    const html = probeHtml(`<div style="width: 400px; overflow: hidden">
      <table><thead><tr><th style="min-width: 300px">One</th><th style="min-width: 300px">Two</th></tr></thead>
      <tbody><tr><td style="height: ${String(LIMITS.maxRowHeight1024 + 1)}px">a</td><td>b</td></tr></tbody></table>
    </div>`);
    expect(await broken(html, 'analytics', TABLET)).toEqual(['clippedColumns', 'maxRowHeight']);
    expect(await broken(html, 'analytics', DESKTOP)).toEqual([]);
    const fits = probeHtml(
      `<table><tbody><tr><td style="height: ${String(LIMITS.maxRowHeight1024 - 10)}px">a</td></tr></tbody></table>`,
    );
    expect(await broken(fits, 'analytics', TABLET)).toEqual([]);
  });

  test('a sessions table and a transcript that start too low are reported at 1440x900', async () => {
    const pushed = (px: number, content: string): string =>
      probeHtml(`<div style="height: ${String(px)}px"></div>${content}`);
    const table = '<table><tbody><tr><td>a</td></tr></tbody></table>';
    const transcript = '<ul style="margin: 0"><li data-row-key="1">a</li></ul>';
    expect(await broken(pushed(LIMITS.sessionsFirstRowTop, table), 'sessions', DESKTOP)).toEqual([
      'sessionsFirstRowTop',
    ]);
    expect(
      await broken(pushed(LIMITS.transcriptFirstRowTop, transcript), 'session-detail-transcript', DESKTOP),
    ).toEqual(['transcriptFirstRowTop']);
    // a page without any row has nothing to measure, which is a problem of its own
    expect(await broken(probeHtml(''), 'sessions', DESKTOP)).toEqual(['sessionsFirstRowTop']);
    expect(await broken(probeHtml(''), 'session-detail-transcript', DESKTOP)).toEqual(['transcriptFirstRowTop']);
  });

  test('fewer than three transcript rows in view are reported at 600 px', async () => {
    const tall = probeHtml(
      '<ul style="margin: 0"><li data-row-key="1" style="height: 500px">a</li><li data-row-key="2" style="height: 500px">b</li><li data-row-key="3">c</li></ul>',
    );
    expect(await broken(tall, 'session-detail-transcript', PHONE)).toEqual(['transcriptRowsInView']);
  });

  test('a project list that starts too low, and a missing one on a page that opens it, is reported', async () => {
    const list = (px: number): string =>
      probeHtml(
        `<div style="height: ${String(px)}px"></div><div class="workspace-sidebar"><ul style="margin: 0"><li class="workspace-folder">folder</li></ul></div>`,
      );
    expect(await broken(list(LIST_FIRST_ROW_MAX_TOP), 'workspace', DESKTOP)).toEqual(['listFirstRowTop']);
    expect(await broken(list(LIST_FIRST_ROW_MAX_TOP), 'workspace', PHONE)).toEqual(['listFirstRowTop']);
    expect(await broken(probeHtml(''), 'workspace-projects', DESKTOP)).toEqual(['listFirstRowTop']);
    // a list that was scrolled is judged by where its first row is before the scrolling
    const scrolled = probeHtml(
      `<div class="workspace-sidebar" id="box" style="height: 60px; overflow-y: auto"><ul style="margin: 0; padding: 0">
        <li class="workspace-folder" style="height: 40px">a</li><li class="workspace-folder" style="height: 400px">b</li></ul></div>`,
    );
    await page.setViewportSize(DESKTOP);
    await page.setContent(scrolled);
    await page.evaluate("document.getElementById('box').scrollTop = 200");
    expect((await factsOf(page)).listFirstRowTop).toBeLessThan(LIST_FIRST_ROW_MAX_TOP);
    expect((await factsOf(page)).listFirstRowTop).toBeGreaterThan(0);
  });

  test('a terminal that is too narrow or starts too low, and a missing one, is reported', async () => {
    const narrow = probeHtml(
      `<div data-terminal data-cols="${String(TERMINAL_MIN_COLS - 1)}" data-rows="24" style="height: 300px"></div>`,
    );
    const low = probeHtml(`<div style="height: ${String(TERMINAL_HOST_MAX_TOP)}px"></div>${TERMINAL_OK}`);
    for (const viewport of [PHONE, TABLET, DESKTOP, ...CONTRACT_WIDE_VIEWPORTS]) {
      expect(await broken(narrow, 'workspace-session', viewport), sizeOf(viewport)).toEqual(['terminalCols']);
      expect(await broken(low, 'workspace-session', viewport), sizeOf(viewport)).toEqual(['terminalTop']);
    }
    expect(await broken(probeHtml(''), 'terminal-colors', DESKTOP)).toEqual(['terminalTop', 'terminalCols']);
  });
});

// ---- a known defect is held exactly --------------------------------------------------------------------------------------------

test.describe('known defects', () => {
  const base: PageFacts = {
    pageOverflowX: 0,
    maxRowHeight: 20,
    tabStopsBeforeMain: 8,
    firstRowTop: 100,
    clippedColumns: 0,
    lowContrastTexts: 0,
    worstContrast: 12,
    worstContrastNode: null,
    nonMonoText: 0,
    tinyText: 0,
    clippedText: 0,
    terminal: { cols: 100, rows: 30, top: 60, heightRatio: 0.8 },
    transcriptFirstTop: 100,
    transcriptRowsInView: 5,
    listFirstRowTop: 80,
  };
  const table: readonly KnownDefect[] = [
    {
      id: 'KD-probe-clip',
      rule: 'clippedText',
      defect: 'a probe: one clipped box on the terminal page',
      pins: pins(['workspace-session'], ['1440x900', '1024x768'], 1),
    },
    {
      id: 'KD-probe-top',
      rule: 'terminalTop',
      defect: 'a probe: the terminal starts at 130 px in English',
      pins: pins(['workspace-session'], ['1440x900'], 130, { locale: 'en' }),
    },
  ];
  const place = placeOf('workspace-session', DESKTOP);
  const problemsOf = (facts: PageFacts, where: Place = place): string[] => layoutProblems(facts, where, table);
  const withTop = (top: number): PageFacts => ({ ...base, clippedText: 1, terminal: { ...base.terminal!, top } });

  test('a pinned violation that shows as pinned is no problem, and is named in the verdict', () => {
    const facts = withTop(130);
    expect(problemsOf(facts)).toEqual([]);
    expect(judge(checksOf(facts, place), place, table).known).toEqual(['KD-probe-clip', 'KD-probe-top']);
    // within the ratchet of a pixel value
    expect(problemsOf(withTop(130 + RATCHET_PX))).toEqual([]);
    expect(problemsOf(withTop(TERMINAL_HOST_MAX_TOP))).toEqual([]);
  });

  test('a count that changed and a pixel value beyond the ratchet are problems', () => {
    expect(problemsOf({ ...withTop(130), clippedText: 2 }).join('; ')).toContain('KD-probe-clip changed');
    expect(problemsOf(withTop(130 + RATCHET_PX + 1)).join('; ')).toContain('KD-probe-top grew');
  });

  test('a pinned violation that no longer shows is a problem: the entry must go with the fix', () => {
    expect(problemsOf({ ...withTop(130), clippedText: 0 }).join('; ')).toContain('KD-probe-clip no longer shows');
    expect(problemsOf(withTop(TERMINAL_HOST_MAX_TOP - 1)).join('; ')).toContain('KD-probe-top no longer shows');
  });

  test('a pin excuses its own page, size and language only', () => {
    const facts = withTop(130);
    // another size of the same page: the clip is pinned at 1024 px too, the top is not
    expect(problemsOf(facts, placeOf('workspace-session', TABLET)).join('; ')).toContain('terminalTop: 130');
    // another language at the pinned size
    expect(problemsOf(facts, { ...place, locale: 'vi' }).join('; ')).toContain('terminalTop: 130');
    // another page
    const other = problemsOf(facts, placeOf('terminal-colors', DESKTOP)).join('; ');
    expect(other).toContain('clippedText: 1');
    expect(other).toContain('terminalTop: 130');
    // and the strict rule of every other measurement still stands at the pinned place
    expect(problemsOf({ ...facts, tinyText: 1 }).join('; ')).toContain('tinyText: 1');
  });

  test('two defects that break a count rule at one place add up, and a pixel value takes one pin only', () => {
    const second: KnownDefect = {
      id: 'KD-probe-clip-2',
      rule: 'clippedText',
      defect: 'a probe: a second clipped box with another cause',
      pins: pins(['workspace-session'], ['1440x900'], 1),
    };
    const both = [...table, second];
    const facts = { ...withTop(130), clippedText: 2 };
    expect(layoutProblems(facts, place, both)).toEqual([]);
    expect(judge(checksOf(facts, place), place, both).known).toEqual([
      'KD-probe-clip',
      'KD-probe-clip-2',
      'KD-probe-top',
    ]);
    // one of the two was fixed: the count no longer is the sum, and the message names both
    expect(layoutProblems(withTop(130), place, both).join('; ')).toContain(
      'known defect KD-probe-clip + KD-probe-clip-2 changed: 1',
    );
    expect(layoutProblems({ ...withTop(130), clippedText: 0 }, place, both).join('; ')).toContain('no longer shows');
    const twoTops: readonly KnownDefect[] = [
      ...table,
      {
        id: 'KD-probe-top-2',
        rule: 'terminalTop',
        defect: 'a probe: a second pin',
        pins: pins(['workspace-session'], ['1440x900'], 140),
      },
    ];
    expect(() => layoutProblems(withTop(130), place, twoTops)).toThrow(/both pin the pixel value terminalTop/);
    expect(tableProblems(twoTops).join('; ')).toContain('both pin the pixel value terminalTop');
  });

  test('a table that pins what the contract never measures is refused', () => {
    const bad: readonly KnownDefect[] = [
      { id: 'KD-a', rule: 'clippedText', defect: 'no such page', pins: pins(['no-such-page'], ['1440x900'], 1) },
      { id: 'KD-b', rule: 'clippedText', defect: 'no such size', pins: pins(['overview'], ['1920x1080'], 1) },
      { id: 'KD-c', rule: 'clippedColumns', defect: 'not at this size', pins: pins(['overview'], ['600x900'], 1) },
      { id: 'KD-d', rule: 'sessionsFirstRowTop', defect: 'not this page', pins: pins(['overview'], ['1440x900'], 300) },
      { id: 'KD-e', rule: 'tinyText', defect: 'twice', pins: pins(['overview', 'overview'], ['1440x900'], 1) },
      { id: 'KD-e', rule: 'tinyText', defect: '', pins: [] },
    ];
    const found = tableProblems(bad).join('; ');
    expect(found).toContain('KD-a: no-such-page at 1440x900: no such contract page');
    expect(found).toContain('KD-b: overview at 1920x1080: the page is not measured at this size');
    expect(found).toContain('KD-c: overview at 600x900: the rule clippedColumns is not applied');
    expect(found).toContain('KD-d: overview at 1440x900: the rule sessionsFirstRowTop is not applied');
    expect(found).toContain('known defect KD-e pins tinyText of overview at 1440x900 light en twice');
    expect(found).toContain('KD-e: the id is used twice');
    expect(found).toContain('KD-e: no description');
    expect(found).toContain('KD-e: no pin');
    expect(tableProblems(table)).toEqual([]);
  });
});
