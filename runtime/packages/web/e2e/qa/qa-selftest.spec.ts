// Self-test of the visual QA tool (WP-122): the output folder guard, the view list, `measure` (with a negative probe), the
// language preset, the live instance (port range, data, R-36 invariants, clean stop) and fixture mode (at least eight lifecycle
// states). Run it inside the `run` lock with `MCS_SHOTS_DIR` set to a fresh folder outside the repository.
import { existsSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test as base } from '@playwright/test';

import { routes } from '@mcs/shared';
import { assertPortClosed, httpRequest, makeJunction, makeTempDir } from '@mcs/testkit';

import { enMessages } from '../../src/i18n/messages/en.ts';
import { viMessages } from '../../src/i18n/messages/vi.ts';
import { FIXTURE_STATES, fixtureApi, fixtureStates } from './fixture-api.ts';
import { DEFAULT_VIEWPORTS, readShotsConfig, repositoryRootOf, resolveShotsDir } from './global-setup.ts';
import { countRows, measure, readIndex, scrubPaths, writeIndex, type ShotRecord } from './measure.ts';
import { QA_PORT_RANGE, startQaInstance, type QaInstance } from './qa-instance.ts';
import { buildStyleguideHtml, vietnameseStressLine } from './styleguide.ts';
import {
  PLANNED_ROUTE_PATHS,
  PREFS_STORAGE_KEY,
  VIEWS,
  browserLocaleOf,
  duplicateViewIds,
  presetScript,
  resolveViewUrl,
  type ViewSpec,
} from './views.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = repositoryRootOf(here);

const test = base.extend<object, { qa: QaInstance }>({
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

/** Removes a link or junction with Node only: the target must never be followed (plan section 2 rule 8). */
function removeLink(link: string): void {
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
}

// ---- the output folder guard --------------------------------------------------------------------------------------------------

test.describe('the output folder guard', () => {
  test('the repository of the tool is found', () => {
    expect(repo, 'the tool lives in a repository').not.toBeNull();
  });

  test('refuses an absolute folder inside the repository, existing or not', () => {
    const root = repo ?? '';
    expect(() => resolveShotsDir(join(root, 'shots-that-do-not-exist'))).toThrow(/outside the repository/);
    expect(() => resolveShotsDir(join(root, 'runtime', 'packages'))).toThrow(/outside the repository/);
    expect(() => resolveShotsDir(root)).toThrow(/outside the repository/);
  });

  test('refuses a relative folder, which is read against the working folder inside the repository', () => {
    // the tool is run from the runtime folder (the gate says `cd $R`), which is inside the repository
    expect(
      process
        .cwd()
        .toLowerCase()
        .startsWith(resolve(repo ?? '').toLowerCase()),
      'run the self-test from the runtime folder',
    ).toBe(true);
    expect(() => resolveShotsDir('shots')).toThrow(/outside the repository/);
    expect(() => resolveShotsDir(join('..', 'shots'))).toThrow(/outside the repository/);
  });

  test('refuses a folder that is reached through a junction or link into the repository', () => {
    const temp = makeTempDir('qa-guard');
    const link = join(temp.path, 'link');
    try {
      makeJunction(link, join(repo ?? '', 'runtime'));
      expect(() => resolveShotsDir(join(link, 'out'))).toThrow(/outside the repository/);
      expect(() => resolveShotsDir(join(link, 'packages', 'deeper', 'still'))).toThrow(/outside the repository/);
    } finally {
      if (existsSync(link)) removeLink(link);
      temp.remove();
    }
  });

  test('accepts a folder outside the repository, and asks for the variable', () => {
    const temp = makeTempDir('qa-guard');
    try {
      expect(resolveShotsDir(join(temp.path, 'new', 'folder'))).toContain('folder');
      expect(() => resolveShotsDir(undefined)).toThrow(/MCS_SHOTS_DIR is required/);
      expect(() => resolveShotsDir('   ')).toThrow(/MCS_SHOTS_DIR is required/);
    } finally {
      temp.remove();
    }
  });

  test('the folder of this very run is outside the repository', () => {
    const config = readShotsConfig();
    expect(repo === null || !config.dir.toLowerCase().startsWith(resolve(repo).toLowerCase())).toBe(true);
  });
});

test.describe('the environment of the tool', () => {
  // the folder is only resolved, never created
  const dir = (): string => join(tmpdir(), 'mcs-qa-config-never-created', 'out');

  test('has the three review window sizes, both themes and both languages by default', () => {
    const config = readShotsConfig({ MCS_SHOTS_DIR: dir() });
    expect(config.viewports).toEqual(DEFAULT_VIEWPORTS);
    expect(config.viewports.map((v) => v.width)).toEqual([1440, 1024, 600]);
    expect(config.themes).toEqual(['light', 'dark']);
    expect(config.locales).toEqual(['en', 'vi']);
    expect(config.views).toBe('all');
    expect(config.mode).toBeNull();
  });

  test('reads lists, and refuses a window below 500 px, an unknown theme and an unknown mode', () => {
    const base = { MCS_SHOTS_DIR: dir() };
    const config = readShotsConfig({
      ...base,
      MCS_SHOTS_VIEWS: 'sessions, overview',
      MCS_SHOTS_VIEWPORTS: '1024x768',
      MCS_SHOTS_THEMES: 'dark',
      MCS_SHOTS_LOCALES: 'vi',
      MCS_SHOTS_MODE: 'fixture',
    });
    expect(config.views).toEqual(['sessions', 'overview']);
    expect(config.viewports).toEqual([{ width: 1024, height: 768 }]);
    expect(config.themes).toEqual(['dark']);
    expect(config.locales).toEqual(['vi']);
    expect(config.mode).toBe('fixture');
    expect(() => readShotsConfig({ ...base, MCS_SHOTS_VIEWPORTS: '400x800' })).toThrow(/below 500/);
    expect(() => readShotsConfig({ ...base, MCS_SHOTS_VIEWPORTS: 'wide' })).toThrow(/WIDTHxHEIGHT/);
    expect(() => readShotsConfig({ ...base, MCS_SHOTS_THEMES: 'sepia' })).toThrow(/sepia/);
    expect(() => readShotsConfig({ ...base, MCS_SHOTS_MODE: 'both' })).toThrow(/neither live nor fixture/);
  });
});

// ---- the view list ---------------------------------------------------------------------------------------------------------------

/** The route patterns of `ROUTES` in `routes.tsx`, read from the source: the e2e project cannot import a React module. */
function routePaths(): string[] {
  const source = readFileSync(join(here, '..', '..', 'src', 'app', 'routes.tsx'), 'utf8');
  const start = source.indexOf('export const ROUTES');
  const end = source.indexOf('as const satisfies', start);
  if (start < 0 || end < 0) throw new Error('routes.tsx has no ROUTES table the self-test can read');
  return [...source.slice(start, end).matchAll(/path: '([^']+)'/g)].map((m) => m[1] ?? '');
}

const BASE_VIEW_IDS = [
  'overview',
  'sessions',
  'session-detail-transcript',
  'activity',
  'tasks',
  'analytics',
  'settings-health',
  'search',
  'not-found',
];

test.describe('the view list', () => {
  test('has the base views, one per route, and every id is unique over the merged list', () => {
    expect(duplicateViewIds(VIEWS)).toEqual([]);
    for (const id of BASE_VIEW_IDS)
      expect(
        VIEWS.map((v) => v.id),
        id,
      ).toContain(id);
    for (const view of VIEWS) expect(view.id, view.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test('a negative probe: a block that reuses an id is caught', () => {
    const copy: ViewSpec = { id: 'sessions', path: '/sessions', mode: 'fixture', state: 'error', wait: 'main' };
    expect(duplicateViewIds([...VIEWS, copy])).toEqual(['sessions']);
    expect(duplicateViewIds([...VIEWS, { ...copy, id: 'sessions-probe-copy' }])).toEqual([]);
  });

  test('every path is a route of ROUTES, a planned route of ADR 0073, or the catch-all', () => {
    const known = routePaths();
    expect(known.length, 'ROUTES was read').toBeGreaterThanOrEqual(7);
    for (const planned of PLANNED_ROUTE_PATHS)
      expect(known, `${planned} is registered now: drop it from PLANNED_ROUTE_PATHS`).not.toContain(planned);
    for (const view of VIEWS) {
      const ok = view.path === '*' || known.includes(view.path) || PLANNED_ROUTE_PATHS.includes(view.path);
      expect(ok, `${view.id}: ${view.path} matches no route`).toBe(true);
    }
  });

  test('fills the parameters of a path and the query, and refuses a missing value', () => {
    const detail = VIEWS.find((v) => v.id === 'session-detail-transcript');
    if (detail === undefined) throw new Error('no detail view');
    expect(resolveViewUrl(detail, { detailSessionId: 'abc def' })).toBe('/sessions/abc%20def');
    const health = VIEWS.find((v) => v.id === 'settings-health');
    if (health === undefined) throw new Error('no settings view');
    expect(resolveViewUrl(health, { detailSessionId: 'x' })).toBe('/settings?section=health');
    const notFound = VIEWS.find((v) => v.id === 'not-found');
    if (notFound === undefined) throw new Error('no not-found view');
    expect(resolveViewUrl(notFound, { detailSessionId: 'x' })).toBe('/no-such-page');
    expect(resolveViewUrl({ id: 'home', path: '/', mode: 'live', wait: 'main' }, { detailSessionId: 'x' })).toBe('/');
    expect(() =>
      resolveViewUrl(
        { id: 'broken', path: '/sessions/:sessionId', mode: 'live', wait: 'main' },
        { detailSessionId: 'x' },
      ),
    ).toThrow(/no value/);
  });

  test('the index keeps the records of earlier runs and replaces a record of the same file', () => {
    const temp = makeTempDir('qa-index');
    try {
      const record = (file: string, status: ShotRecord['status']): ShotRecord => ({
        file,
        view: 'sessions',
        mode: 'live',
        state: null,
        viewport: '1440x900',
        theme: 'light',
        locale: 'en',
        url: '/sessions',
        status,
        error: null,
        consoleErrors: 0,
        measure: null,
      });
      writeIndex(temp.path, [record('b.png', 'failed'), record('a.png', 'ok')]);
      const merged = writeIndex(temp.path, [record('b.png', 'ok'), record('c.png', 'ok')]);
      expect(merged.files.map((f) => f.file)).toEqual(['a.png', 'b.png', 'c.png']);
      expect(readIndex(temp.path).files.find((f) => f.file === 'b.png')?.status).toBe('ok');
    } finally {
      temp.remove();
    }
  });
});

// ---- measure and the language preset ---------------------------------------------------------------------------------------------

test.describe('measure', () => {
  test('flags a page that is wider than the window (negative probe) and a table with a cut-off column', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 700 });
    await page.setContent(
      `<!doctype html><main><h1>Wide</h1><table style="width:1500px"><thead><tr><th>A</th><th>B</th><th>Cut off</th></tr></thead>
       <tbody><tr><td style="width:500px">one</td><td style="width:500px">two</td><td style="width:500px">three</td></tr></tbody></table></main>`,
    );
    const wide = await measure(page);
    expect(wide.pageOverflowX).toBeGreaterThan(0);
    expect(wide.clippedColumns).toBeGreaterThan(0);
    expect(wide.maxRowHeight).toBeGreaterThan(0);
    expect(wide.firstRowTop).not.toBeNull();
  });

  test('passes a page that fits, and counts the tab stops before the main landmark and the rows', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 700 });
    await page.setContent(
      `<!doctype html><a href="#main">Skip</a><nav><a href="/a">A</a><button>B</button></nav>
       <main id="main"><h1>Fits</h1><table><thead><tr><th>Name</th></tr></thead>
       <tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table><a href="/c">C</a></main>`,
    );
    const fits = await measure(page);
    expect(fits.pageOverflowX).toBe(0);
    expect(fits.clippedColumns).toBe(0);
    expect(fits.tabStopsBeforeMain).toBe(3);
    expect(await countRows(page)).toBe(2);
  });

  test('reports no row and no top for a page without rows', async ({ page }) => {
    await page.setContent('<!doctype html><main><h1>Empty</h1></main>');
    const empty = await measure(page);
    expect(empty.maxRowHeight).toBe(0);
    expect(empty.firstRowTop).toBeNull();
  });

  test('scrubs a folder of the machine from the text, keeping the length', async ({ page }) => {
    await page.setContent('<!doctype html><main><p id="p">cwd: /some/temp/folder/repo done</p></main>');
    await scrubPaths(page, ['/some/temp/folder']);
    const text = await page.locator('#p').innerText();
    expect(text).not.toContain('/some/temp');
    expect(text.length).toBe('cwd: /some/temp/folder/repo done'.length);
  });
});

// ---- the text measurements (CAW-35): contrast, monospace, tiny and clipped text, the terminal --------------------------------------

/** A page with its own `--mono` stack: the measurements compare the font of every text with the first family of that variable. */
const probePage = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    html { --mono: 'Courier New', monospace; }
    body { margin: 0; background: #ffffff; color: #111111; font: 16px/1.5 var(--mono); }
    button, input { font: inherit; }
  </style></head><body><main>${body}</main></body></html>`;

test.describe('the text measurements', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
  });

  test('a clean page reports zeros, a high worst contrast and no terminal', async ({ page }) => {
    await page.setContent(probePage('<h1>Clean</h1><p>Plain readable text on white.</p><button disabled>Off</button>'));
    const clean = await measure(page);
    expect(clean.lowContrastTexts).toBe(0);
    expect(clean.nonMonoText).toBe(0);
    expect(clean.tinyText).toBe(0);
    expect(clean.clippedText).toBe(0);
    expect(clean.worstContrast, 'the worst ratio of dark text on white').toBeGreaterThan(15);
    expect(clean.terminal).toBeNull();
  });

  test('flags #ccc on #fff, names the node, and the ratio is the WCAG one', async ({ page }) => {
    await page.setContent(probePage('<p id="faint" style="color:#cccccc">Faint words</p><p>Fine</p>'));
    const found = await measure(page);
    expect(found.lowContrastTexts).toBe(1);
    expect(found.worstContrast ?? 0).toBeGreaterThan(1.5);
    expect(found.worstContrast ?? 99).toBeLessThan(1.7);
    expect(found.worstContrastNode ?? '').toContain('p#faint');
  });

  test('composites a translucent layer and walks up to the nearest opaque background', async ({ page }) => {
    await page.setContent(
      probePage(
        '<div style="background:#202020"><p id="light" style="color:#e0e0e0">Light on dark</p></div>' +
          '<div style="background:#202020"><div style="background:rgba(255,255,255,0.04)"><p id="mid" style="color:#777777">Gray on dark</p></div></div>',
      ),
    );
    const found = await measure(page);
    // #e0e0e0 on #202020 passes; #777777 on about #292929 is about 3.2, below 4.5
    expect(found.lowContrastTexts).toBe(1);
    expect(found.worstContrastNode ?? '').toContain('p#mid');
  });

  test('holds large text to 3:1 and skips disabled controls, the screen-reader class, svg and the terminal', async ({
    page,
  }) => {
    await page.setContent(
      probePage(
        '<p style="color:#8a8a8a;font-size:24px">Large gray text</p>' +
          '<button disabled style="color:#cccccc">Disabled</button>' +
          '<span aria-disabled="true" style="color:#cccccc">Also off</span>' +
          '<span class="sr-only" style="color:#cccccc">Hidden for sight</span>' +
          '<svg width="200" height="40"><text x="0" y="20" fill="#cccccc" style="font-family:Arial">Chart</text></svg>' +
          '<div class="xterm" style="color:#cccccc;font-family:Arial">Terminal text</div>',
      ),
    );
    const found = await measure(page);
    expect(found.lowContrastTexts).toBe(0);
    expect(found.nonMonoText).toBe(0);
    await page.setContent(probePage('<p style="color:#8a8a8a;font-size:16px">Small gray text</p>'));
    expect((await measure(page)).lowContrastTexts).toBe(1);
  });

  test('does not judge text that is not on the screen: clipped away by its box or fully transparent', async ({
    page,
  }) => {
    await page.setContent(
      probePage(
        '<div style="width:20px;overflow:hidden;white-space:nowrap"><span style="margin-left:40px;color:#cccccc">Pushed out of its rail</span></div>' +
          '<p style="opacity:0;color:#cccccc">Invisible</p>',
      ),
    );
    const found = await measure(page);
    expect(found.lowContrastTexts).toBe(0);
    expect(found.worstContrast, 'only the visible text is judged').toBeNull();
  });

  test('flags text that is not in the monospace stack', async ({ page }) => {
    await page.setContent(probePage('<p>Fine</p><p id="sans" style="font-family: Arial, sans-serif">Arial text</p>'));
    const found = await measure(page);
    expect(found.nonMonoText).toBe(1);
    expect(found.lowContrastTexts).toBe(0);
  });

  test('flags 10 px text and not 11 px text', async ({ page }) => {
    await page.setContent(
      probePage('<p style="font-size:10px">Tiny</p><p style="font-size:11px">Small but allowed</p>'),
    );
    expect((await measure(page)).tinyText).toBe(1);
  });

  test('flags a line that is cut off at the bottom, and not an ellipsis or a line clamp', async ({ page }) => {
    await page.setContent(
      probePage(
        '<div id="cut" style="height:10px;overflow:hidden;line-height:24px">Diacritics need room</div>' +
          '<div style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">One long line cut by its width</div>' +
          '<div style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:90px">' +
          'A clamped paragraph that wraps over several lines on purpose and is cut after two lines of it</div>',
      ),
    );
    expect((await measure(page)).clippedText).toBe(1);
  });

  test('reads the terminal size, top and height ratio, and null without a size', async ({ page }) => {
    await page.setContent(
      probePage('<h1>Terminal</h1><div data-terminal data-cols="97" data-rows="31" style="height:300px">x</div>'),
    );
    const found = await measure(page);
    expect(found.terminal?.cols).toBe(97);
    expect(found.terminal?.rows).toBe(31);
    expect(found.terminal?.top ?? 0).toBeGreaterThan(20);
    expect(found.terminal?.heightRatio ?? 0).toBeCloseTo(0.5, 1);
    await page.setContent(probePage('<div data-terminal>no size yet</div>'));
    expect((await measure(page)).terminal, 'a host without cols and rows is no terminal').toBeNull();
  });

  test('keeps the five older measurements next to the new ones', async ({ page }) => {
    await page.setContent(
      probePage('<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>one</td></tr></tbody></table>'),
    );
    const found = await measure(page);
    expect(found.pageOverflowX).toBe(0);
    expect(found.clippedColumns).toBe(0);
    expect(found.maxRowHeight).toBeGreaterThan(0);
    expect(found.firstRowTop).not.toBeNull();
  });
});

// ---- the style guide (CAW-35) ---------------------------------------------------------------------------------------------------

test.describe('the style guide', () => {
  test('builds one page per language from the catalogues, without a style attribute or a script', () => {
    const en = buildStyleguideHtml('en');
    const vi = buildStyleguideHtml('vi');
    for (const html of [en, vi]) {
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/<script|<style|\son[a-z]+\s*=/i);
      expect(html.length).toBeGreaterThan(3000);
    }
    expect(en).toContain(enMessages['state.waiting_input.label']);
    expect(vi).toContain(viMessages['state.waiting_input.label']);
    expect(vi).not.toContain(enMessages['state.waiting_input.label']);
  });

  test('has every primitive of the design: buttons, states, popover, menu, dialog, badges, rows, cards, toast, kbd', () => {
    const html = buildStyleguideHtml('en');
    for (const needle of [
      'class="btn btn-primary"',
      'class="btn btn-quiet"',
      'class="btn btn-icon"',
      'aria-pressed="true"',
      'disabled',
      'class="input"',
      'class="chip',
      'class="card',
      'class="popover',
      'class="menu',
      'class="dialog',
      'class="kbd',
      'class="toast',
      'aria-current="true"',
      'class="evidence-line"',
      'badge--inferred',
      'tr--prompt',
      'tr--say',
      'tr--think',
      'tr--tool',
      'tr--result',
      'state--empty',
      'state--error',
      'stale-indicator',
      'badge--tag',
    ])
      expect(html, needle).toContain(needle);
    for (const state of ['working', 'waiting_input', 'turn_ended', 'completed', 'failed', 'stale', 'unknown'])
      expect(html, state).toContain(`data-state="${state}"`);
    expect(html.match(/data-basis="inferred"/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  test('the Vietnamese stress line is built from base letters and combining marks in NFC, in both pages', () => {
    const line = vietnameseStressLine();
    expect(line).toBe(line.normalize('NFC'));
    // stacked marks (circumflex plus dot below, horn plus grave, breve plus dot below), the stroked d and a capital are in it
    for (const code of [0x1ec7, 0x1eeb, 0x1eb7, 0x1ea5, 0x1ec3, 0x111, 0x1ee2])
      expect(line, code.toString(16)).toContain(String.fromCodePoint(code));
    expect(line).not.toMatch(/[̀-ͯ]/);
    for (const locale of ['en', 'vi'] as const) expect(buildStyleguideHtml(locale)).toContain(line);
  });

  test('is drawn without a clipped or tiny line, and names one focus target', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.setContent(probePage(buildStyleguideHtml('vi')));
    const found = await measure(page);
    expect(found.clippedText).toBe(0);
    expect(found.tinyText).toBe(0);
    expect(await page.locator('[data-qa-focus-target]').count()).toBe(1);
  });

  test('is registered as two views of one marked block, in live mode, with unique ids', () => {
    for (const id of ['styleguide', 'styleguide-focus']) {
      const view = VIEWS.find((candidate) => candidate.id === id);
      expect(view?.mode, id).toBe('live');
      expect(view?.setup, id).toBeDefined();
    }
    expect(duplicateViewIds(VIEWS)).toEqual([]);
  });
});

test.describe('the language preset', () => {
  test('writes the Vietnamese locale into the preferences key before the page loads', async ({ browser }) => {
    const context = await browser.newContext({ locale: browserLocaleOf('vi') });
    try {
      await context.addInitScript(presetScript('dark', 'vi'));
      const page = await context.newPage();
      await page.route('http://qa.invalid/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }),
      );
      await page.goto('http://qa.invalid/');
      const stored = await page.evaluate(`globalThis.localStorage.getItem('${PREFS_STORAGE_KEY}')`);
      expect(typeof stored).toBe('string');
      expect(JSON.parse(String(stored))).toEqual({ theme: 'dark', locale: 'vi' });
      expect(await page.evaluate('navigator.language')).toBe('vi-VN');
    } finally {
      await context.close();
    }
  });
});

// ---- the live instance ---------------------------------------------------------------------------------------------------------

interface Item {
  id: string;
  label: string;
  errorCount: number;
  lastActivityAt: string;
  state: { state: string; basis: string; rule: string };
}

async function sessionsOf(qa: QaInstance): Promise<Item[]> {
  const reply = await qa.getJson(`${routes.listSessions.path}?limit=100`);
  expect(reply.status).toBe(200);
  const page = routes.listSessions.response.parse(reply.body);
  return page.items;
}

test.describe('the live instance', () => {
  test('starts on a port of 18500-18599 and, after stop, the port is closed and the temp tree is gone', async () => {
    const qa = await startQaInstance();
    const { port, root } = qa;
    let stopped = false;
    try {
      expect(port).toBeGreaterThanOrEqual(QA_PORT_RANGE[0]);
      expect(port).toBeLessThanOrEqual(QA_PORT_RANGE[1]);
      expect(existsSync(root)).toBe(true);
      expect((await httpRequest(port, routes.health.path)).status).toBe(200);
      await qa.stop();
      stopped = true;
      await assertPortClosed(port);
      expect(existsSync(root), 'the temp tree is removed').toBe(false);
    } finally {
      if (!stopped) await qa.stop();
    }
  });

  test('holds at least eight sessions in the states the screens need, with the named shapes', async ({ qa }) => {
    const items = await sessionsOf(qa);
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items.length).toBe(qa.sessionCount);
    const find = (id: string): Item => {
      const found = items.find((item) => item.id === id);
      if (found === undefined) throw new Error(`session ${id} is not in the list`);
      return found;
    };
    expect(find(qa.sessions.fresh).state).toMatchObject({ state: 'working', basis: 'observed' });
    expect(find(qa.sessions.quiet).state).toMatchObject({ state: 'working', basis: 'inferred' });
    expect(find(qa.sessions.waiting).state.state).toBe('waiting_tool');
    expect(find(qa.sessions.silent).state.state).toBe('stale');
    expect(items.some((item) => item.state.state === 'turn_ended')).toBe(true);
    expect(find(qa.sessions.longLabel).label.length).toBeGreaterThan(100);
    expect(find(qa.sessions.subagentError).errorCount).toBeGreaterThan(0);
  });

  test('has configured prices (an estimated cost) and the trend chart switched on', async ({ qa }) => {
    const overview = routes.overview.response.parse((await qa.getJson(routes.overview.path)).body);
    const cost = overview.metrics.find((metric) => metric.key === 'cost.estimate');
    expect(cost?.value, 'the cost estimate metric').toBeGreaterThan(0);
    const instance = routes.instance.response.parse((await qa.getJson(routes.instance.path)).body);
    expect(instance.features.usageTrend).toBe(true);
    expect(instance.features.costEstimates).toBe(true);
  });

  test('uses only FIXTURE text and no folder of the machine in what it shows', async ({ qa }) => {
    const items = await sessionsOf(qa);
    const own = items.filter((item) => item.id.startsWith('9a9a9a9a'));
    expect(own.length).toBe(6);
    const detail = routes.getSession.response.parse((await qa.getJson(`/api/v3/sessions/${qa.sessions.fresh}`)).body);
    expect(detail.cwd ?? '').toContain('FIXTURE');
    expect(JSON.stringify(items)).not.toMatch(/@[a-z0-9-]+[.][a-z]{2,}/i);
  });

  // R-36: the review found an error recorded after the "Last activity" of its session (N-4) and a session header that said
  // "0 errors" while the table said 1 (N-1).
  test('R-36: no event is later than the last activity of its session', async ({ qa }) => {
    const late: string[] = [];
    for (const item of await sessionsOf(qa)) {
      const limit = Date.parse(item.lastActivityAt);
      let cursor: string | null = null;
      for (let page = 0; page < 40; page += 1) {
        const query = new URLSearchParams({ session: item.id, limit: '200' });
        if (cursor !== null) query.set('cursor', cursor);
        const reply = await qa.getJson(`${routes.listEvents.path}?${query.toString()}`);
        expect(reply.status).toBe(200);
        const body = routes.listEvents.response.parse(reply.body);
        for (const event of body.items) {
          if (Date.parse(event.at) > limit)
            late.push(
              `${item.label}: ${event.type} of ${event.agentId ?? 'main'} at ${event.at} after ${item.lastActivityAt}`,
            );
        }
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
    }
    expect(late, 'events later than the last activity of their session').toEqual([]);
  });

  test('R-36: the error of a subagent is counted in the error count of its session', async ({ qa }) => {
    const detail = routes.getSession.response.parse(
      (await qa.getJson(`/api/v3/sessions/${qa.sessions.subagentError}`)).body,
    );
    const agents = routes.sessionAgents.response.parse(
      (await qa.getJson(`/api/v3/sessions/${qa.sessions.subagentError}/agents`)).body,
    );
    const main = agents.items.find((agent) => agent.kind === 'main');
    expect(
      agents.items.some((agent) => agent.kind === 'subagent'),
      'the session has a subagent',
    ).toBe(true);
    expect(main?.errorCount ?? 0, 'the main agent has no error of its own').toBe(0);
    expect(detail.errorCount, 'the session count includes the error of its subagent').toBeGreaterThanOrEqual(1);
    const errors = routes.listEvents.response.parse(
      (await qa.getJson(`${routes.listEvents.path}?session=${qa.sessions.subagentError}&severity=error&limit=50`)).body,
    );
    expect(errors.items.some((event) => event.agentId !== null && event.agentId !== 'main')).toBe(true);
    expect(errors.items.length).toBe(detail.errorCount);
  });
});

// ---- fixture mode ----------------------------------------------------------------------------------------------------------------

test.describe('fixture mode', () => {
  test('lists at least eight lifecycle states in the data', () => {
    expect(fixtureStates().length).toBeGreaterThanOrEqual(8);
    expect([...FIXTURE_STATES]).toEqual(['ok', 'loading', 'error', 'empty', 'disconnected']);
  });

  test('renders at least eight lifecycle states in the page, and aborts the stream so the page polls', async ({
    browser,
    qa,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    try {
      const page = await context.newPage();
      const fixture = await fixtureApi(page, 'ok');
      await page.goto(`${qa.baseUrl}/sessions`);
      await page.locator('main [data-state]').first().waitFor({ state: 'visible', timeout: 30_000 });
      const states = await page.evaluate(
        "[...new Set(Array.from(document.querySelectorAll('main [data-state]')).map((el) => el.getAttribute('data-state')))]",
      );
      expect((states as string[]).length, `states drawn: ${JSON.stringify(states)}`).toBeGreaterThanOrEqual(8);
      expect(await countRows(page)).toBeGreaterThanOrEqual(8);
      expect(fixture.requests.some((request) => request.startsWith(routes.listSessions.path))).toBe(true);
      expect(fixture.fake.violations, 'the fake bodies keep to the contract').toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('answers an error with a 500, an empty list with no sessions, and a request that never finishes', async ({
    browser,
    qa,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, timezoneId: 'UTC' });
    try {
      const page = await context.newPage();
      const failing = await fixtureApi(page, 'error');
      const answer = await page.evaluate(
        `fetch('${qa.baseUrl}${routes.listSessions.path}').then(async (r) => ({ status: r.status, body: await r.text() }))`,
      );
      expect((answer as { status: number }).status).toBe(500);
      failing.setState('empty');
      const empty = await page.evaluate(`fetch('${qa.baseUrl}${routes.listSessions.path}').then((r) => r.json())`);
      expect((empty as { items: unknown[] }).items).toEqual([]);
      failing.setState('loading');
      const slow = await page.evaluate(
        `Promise.race([fetch('${qa.baseUrl}${routes.listSessions.path}').then(() => 'answered'), new Promise((r) => globalThis.setTimeout(() => r('pending'), 800))])`,
      );
      expect(slow).toBe('pending');
    } finally {
      await context.close();
    }
  });
});
