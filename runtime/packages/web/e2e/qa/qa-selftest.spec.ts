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

import { FIXTURE_STATES, fixtureApi, fixtureStates } from './fixture-api.ts';
import { DEFAULT_VIEWPORTS, readShotsConfig, repositoryRootOf, resolveShotsDir } from './global-setup.ts';
import { countRows, measure, readIndex, scrubPaths, writeIndex, type ShotRecord } from './measure.ts';
import { QA_PORT_RANGE, startQaInstance, type QaInstance } from './qa-instance.ts';
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
    expect(duplicateViewIds([...VIEWS, { ...copy, id: 'sessions-error' }])).toEqual([]);
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
