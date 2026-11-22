// The visual QA capture (WP-122): every selected view at every window size, theme and language, written as PNG files below
// `MCS_SHOTS_DIR` together with `index.json` (one record per picture with the layout facts of `measure`). One test shoots one
// column of the matrix (one window size, theme and language) over all selected views; a view that fails is recorded in
// `index.json` and the test fails at the end, so one broken page never hides the others. A view marked `wide` is also shot at
// the two wide window sizes, and a view marked `forcedColors` in the one forced-colours column (CAW-49, design 05 section 7.1).
// The instance of live mode starts once per worker and is stopped, with its port closed and its temp tree removed, when the
// worker ends. Run it inside the `run` lock (plan section 3).
import { join, sep } from 'node:path';

import { expect, test as base, type Browser, type BrowserContext } from '@playwright/test';

import { fixtureApi, type FixtureApi } from './fixture-api.ts';
import { columnTitle, columnsOf, inColumn, readShotsConfig, shotFileName, type ShotColumn } from './global-setup.ts';
import { measure, scrubPaths, writeIndex, type ShotRecord } from './measure.ts';
import { startQaInstance, type QaInstance } from './qa-instance.ts';
import {
  VIEWS,
  browserLocaleOf,
  duplicateViewIds,
  presetScript,
  resolveViewUrl,
  type ViewMode,
  type ViewSpec,
} from './views.ts';
import { FIXTURE_DETAIL_SESSION_ID } from './fixture-api.ts';

const config = readShotsConfig();

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

function selectedViews(): ViewSpec[] {
  const duplicates = duplicateViewIds(VIEWS);
  if (duplicates.length > 0) throw new Error(`duplicate view ids: ${duplicates.join(', ')}`);
  if (config.views === 'all') return [...VIEWS];
  const unknown = config.views.filter((id) => !VIEWS.some((view) => view.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `MCS_SHOTS_VIEWS names unknown views: ${unknown.join(', ')} (known: ${VIEWS.map((v) => v.id).join(', ')})`,
    );
  }
  return VIEWS.filter((view) => config.views.includes(view.id));
}

/** The mode a view runs in: its own, or the forced one when the view can run there (a live view can be answered by the fake server). */
function modeOf(view: ViewSpec): ViewMode | null {
  if (config.mode === null) return view.mode;
  if (config.mode === 'fixture') return 'fixture';
  return view.mode === 'live' ? 'live' : null;
}

const views = selectedViews();
const needsInstance = views.some((view) => modeOf(view) !== null);

const shootable = views.filter((view) => modeOf(view) !== null);
const columns: ShotColumn[] = columnsOf(shootable, config);

/** A record of the index that also says whether the picture was taken with forced colours. */
interface ColumnRecord extends ShotRecord {
  readonly forcedColors: boolean;
}

/** The time one column may take: the default of the configuration, and more for a column with many views. */
const columnTimeoutMs = (count: number): number => Math.max(300_000, 60_000 + count * 6_000);

async function shoot(
  context: BrowserContext,
  qa: QaInstance,
  view: ViewSpec,
  mode: ViewMode,
  column: ShotColumn,
): Promise<ColumnRecord> {
  const { width, height } = column.viewport;
  const file = shotFileName(view.id, column);
  const page = await context.newPage();
  let consoleErrors = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors += 1;
  });
  page.on('pageerror', () => {
    consoleErrors += 1;
  });
  const record = {
    file,
    view: view.id,
    mode,
    state: mode === 'fixture' ? (view.state ?? 'ok') : null,
    viewport: `${String(width)}x${String(height)}`,
    theme: column.theme,
    locale: column.locale,
    forcedColors: column.forcedColors,
  } as const;
  let fixture: FixtureApi | null = null;
  let url = '';
  try {
    const data = { detailSessionId: mode === 'live' ? qa.sessions.subagentError : FIXTURE_DETAIL_SESSION_ID };
    url = resolveViewUrl(view, data);
    if (mode === 'fixture') {
      const state = view.state ?? 'ok';
      fixture = await fixtureApi(page, state === 'disconnected' ? 'ok' : state, view.terminal ?? null);
    }
    await page.goto(`${qa.baseUrl}${url}`, { waitUntil: 'domcontentloaded' });
    await page.locator(view.wait).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(
      'document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
    );
    if (fixture !== null && view.state === 'disconnected') {
      // the server goes away after the first draw: two failed polls later the app knows
      fixture.setState('disconnected');
      for (let failed = 0; failed < 2; failed += 1) {
        await page.waitForEvent('requestfailed', {
          predicate: (request) => request.url().includes('/api/v3/'),
          timeout: 20_000,
        });
      }
    }
    await view.setup?.({ page, mode, locale: column.locale, qa: mode === 'live' ? qa : null, fixture });
    const root = qa.root;
    await scrubPaths(page, [root, root.split(sep).join('/')]);
    const measured = await measure(page);
    await page.screenshot({ path: join(config.dir, file), animations: 'disabled', caret: 'hide' });
    return { ...record, url, status: 'ok', error: null, consoleErrors, measure: measured };
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : String(error);
    return { ...record, url, status: 'failed', error: message, consoleErrors, measure: null };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function openContext(browser: Browser, column: ShotColumn): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: column.viewport,
    colorScheme: column.theme,
    locale: browserLocaleOf(column.locale),
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    forcedColors: column.forcedColors ? 'active' : 'none',
    deviceScaleFactor: 1,
  });
  await context.addInitScript(presetScript(column.theme, column.locale));
  return context;
}

test.describe('shots', () => {
  test.skip(!needsInstance, 'no selected view can run in the selected mode');
  for (const column of columns) {
    const inThisColumn = shootable.filter((view) => inColumn(view, column, config));
    test(columnTitle(column), async ({ browser, qa }) => {
      test.setTimeout(columnTimeoutMs(inThisColumn.length));
      const context = await openContext(browser, column);
      const records: ColumnRecord[] = [];
      try {
        for (const view of inThisColumn) {
          const mode = modeOf(view);
          if (mode === null) continue;
          records.push(await shoot(context, qa, view, mode, column));
        }
      } finally {
        await context.close().catch(() => undefined);
        writeIndex(config.dir, records);
      }
      const failed = records.filter((record) => record.status === 'failed').map((r) => `${r.view}: ${r.error ?? ''}`);
      expect(failed, 'views that could not be shot').toEqual([]);
    });
  }
});
