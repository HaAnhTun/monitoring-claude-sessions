// Self-test of the visual QA tool (WP-122): the output folder guard, the view list, `measure` (with a negative probe), the
// language preset, the live instance (port range, data, R-36 invariants, clean stop) and fixture mode (at least eight lifecycle
// states). Run it inside the `run` lock with `MCS_SHOTS_DIR` set to a fresh folder outside the repository.
import { existsSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test as base } from '@playwright/test';

import { TerminalServerMessageSchema, routes } from '@mcs/shared';
import { assertPortClosed, httpRequest, makeJunction, makeTempDir } from '@mcs/testkit';

import { enMessages } from '../../src/i18n/messages/en.ts';
import { viMessages } from '../../src/i18n/messages/vi.ts';
import { accessCode } from '../../src/test/fixtures/index.ts';
import {
  FIXTURE_RECENT_FOLDER,
  FIXTURE_STATES,
  FIXTURE_TERMINALS,
  TERMINAL_FIXTURE_STATES,
  fixtureApi,
  fixtureId,
  fixtureStates,
  type TerminalFixtureState,
} from './fixture-api.ts';
import {
  DEFAULT_VIEWPORTS,
  FORCED_COLORS_VIEWPORT,
  WIDE_VIEWPORTS,
  columnTitle,
  columnsOf,
  inColumn,
  readShotsConfig,
  repositoryRootOf,
  resolveShotsDir,
  shotFileName,
  viewportsOf,
} from './global-setup.ts';
import { countRows, measure, readIndex, scrubPaths, writeIndex, type ShotRecord } from './measure.ts';
import { QA_PORT_RANGE, startQaInstance, type QaInstance } from './qa-instance.ts';
import { buildStyleguideHtml, vietnameseStressLine } from './styleguide.ts';
import { routeTerminalSocket, terminalNameOf } from './terminal-fixture.ts';
import {
  ANSI_FOREGROUND_CODES,
  CURSOR_REPORT_REQUEST,
  SAMPLE_NAMES,
  TERMINAL_GLYPH_CODE_POINTS,
  sampleLines,
  sampleText,
  sgr,
  splitCursorReports,
  vietnameseLetters,
  visibleText,
} from './terminal-sample.ts';
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
  'workspace',
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

// ---- the matrix: the window sizes of a view and the forced-colours column (CAW-49) --------------------------------------------------

/** The views design 05 section 7.1 marks: wide (the workspace, the terminal, the style guide) and forced colours. */
const WIDE_VIEW_IDS = [
  'workspace',
  'workspace-projects',
  'workspace-session',
  'terminal-colors',
  'terminal-vi',
  'styleguide',
  'styleguide-focus',
];
const FORCED_COLORS_VIEW_IDS = ['workspace', 'sessions', 'styleguide'];

/** The views the plan of CAW-49 names, and the notice states of design 04 section 12.4. */
const WORKSPACE_VIEW_IDS = [
  'workspace',
  'workspace-projects',
  'workspace-session',
  'terminal-colors',
  'terminal-vi',
  'terminal-ended',
  'workspace-kill-dialog',
  'workspace-folder-picker-busy',
  'workspace-no-access',
  'workspace-unsupported-os',
  'workspace-claude-missing',
  'workspace-addon-missing',
  'workspace-empty',
  'workspace-loading',
  'workspace-error',
];

test.describe('the matrix', () => {
  const defaults = readShotsConfig({ MCS_SHOTS_DIR: join(tmpdir(), 'mcs-qa-config-never-created', 'out') });
  const size = (viewport: { width: number; height: number }): string =>
    `${String(viewport.width)}x${String(viewport.height)}`;

  test('gives every view its window sizes: three, and the two wide ones for a view marked wide', () => {
    expect(defaults.wideViewports).toEqual(WIDE_VIEWPORTS);
    expect(WIDE_VIEWPORTS.map(size)).toEqual(['1920x1080', '1280x720']);
    for (const view of VIEWS) {
      const sizes = viewportsOf(view, defaults).map(size);
      const expected = WIDE_VIEW_IDS.includes(view.id)
        ? ['1440x900', '1024x768', '600x900', '1920x1080', '1280x720']
        : ['1440x900', '1024x768', '600x900'];
      expect(sizes, view.id).toEqual(expected);
    }
    expect(VIEWS.filter((view) => view.wide === true).map((view) => view.id)).toEqual(
      VIEWS.filter((view) => WIDE_VIEW_IDS.includes(view.id)).map((view) => view.id),
    );
  });

  test('named window sizes are the whole matrix of every view, and one of them is not shot twice', () => {
    const base = { MCS_SHOTS_DIR: join(tmpdir(), 'mcs-qa-config-never-created', 'out') };
    const narrowed = readShotsConfig({ ...base, MCS_SHOTS_VIEWPORTS: '1024x768' });
    expect(narrowed.wideViewports).toEqual([]);
    expect(viewportsOf({ wide: true }, narrowed).map(size)).toEqual(['1024x768']);
    const overlap = { viewports: [{ width: 1280, height: 720 }], wideViewports: WIDE_VIEWPORTS };
    expect(viewportsOf({ wide: true }, overlap).map(size)).toEqual(['1280x720', '1920x1080']);
    expect(viewportsOf({}, overlap).map(size)).toEqual(['1280x720']);
  });

  test('has one forced-colours column, at 1440x900 in the light theme, for the three views of the design', () => {
    expect(VIEWS.filter((view) => view.forcedColors === true).map((view) => view.id)).toEqual(
      VIEWS.filter((view) => FORCED_COLORS_VIEW_IDS.includes(view.id)).map((view) => view.id),
    );
    const columns = columnsOf(VIEWS, defaults);
    // five window sizes in two themes and two languages, and the forced-colours column
    expect(columns.length).toBe(5 * 2 * 2 + 1);
    const forced = columns.filter((column) => column.forcedColors);
    expect(forced).toEqual([{ viewport: FORCED_COLORS_VIEWPORT, theme: 'light', locale: 'en', forcedColors: true }]);
    expect(columns.at(-1)?.forcedColors).toBe(true);
    const titles = columns.map(columnTitle);
    expect(new Set(titles).size, 'every column has its own title').toBe(titles.length);
    expect(titles.at(-1)).toBe('1440x900 light en forced-colors');
    const column = forced[0];
    if (column === undefined) throw new Error('no forced-colours column');
    expect(
      VIEWS.filter((view) => inColumn(view, column, defaults))
        .map((view) => view.id)
        .sort(),
    ).toEqual([...FORCED_COLORS_VIEW_IDS].sort());
    expect(shotFileName('workspace', column)).toBe('workspace__1440x900__light-forced__en.png');
    const plain = columns[0];
    if (plain === undefined) throw new Error('no column');
    expect(shotFileName('workspace', plain)).toBe('workspace__1440x900__light__en.png');
  });

  test('a column holds only the views that are shot in it, and a selection without them has no such column', () => {
    const columns = columnsOf(VIEWS, defaults);
    const wideColumn = columns.find((column) => column.viewport.width === 1920);
    if (wideColumn === undefined) throw new Error('no wide column');
    expect(
      VIEWS.filter((view) => inColumn(view, wideColumn, defaults))
        .map((view) => view.id)
        .sort(),
    ).toEqual([...WIDE_VIEW_IDS].sort());
    const plain = VIEWS.filter((view) => view.wide !== true && view.forcedColors !== true);
    expect(columnsOf(plain, defaults).length).toBe(3 * 2 * 2);
    const base = { MCS_SHOTS_DIR: join(tmpdir(), 'mcs-qa-config-never-created', 'out') };
    const dark = readShotsConfig({ ...base, MCS_SHOTS_THEMES: 'dark' });
    expect(columnsOf(VIEWS, dark).some((column) => column.forcedColors)).toBe(false);
    const small = readShotsConfig({ ...base, MCS_SHOTS_VIEWPORTS: '600x900' });
    expect(columnsOf(VIEWS, small).map(columnTitle)).toEqual([
      '600x900 light en',
      '600x900 light vi',
      '600x900 dark en',
      '600x900 dark vi',
    ]);
    const vietnamese = readShotsConfig({ ...base, MCS_SHOTS_LOCALES: 'vi' });
    expect(columnsOf(VIEWS, vietnamese).at(-1)).toMatchObject({ locale: 'vi', forcedColors: true });
  });

  test('the Overview is at /overview, and the page of / is the Workspace of a user instance', () => {
    for (const view of VIEWS) {
      if (view.id === 'overview' || view.id.startsWith('overview-')) expect(view.path, view.id).toBe('/overview');
      if (view.path === '/') {
        expect(view.mode, `${view.id}: only the fake server has a user instance`).toBe('fixture');
        expect(view.terminal, `${view.id} names its terminal state`).toBeDefined();
      }
      if (view.terminal !== undefined) expect(view.mode, view.id).toBe('fixture');
    }
    const ids = VIEWS.map((view) => view.id);
    for (const id of WORKSPACE_VIEW_IDS) expect(ids, id).toContain(id);
    const states = new Set(VIEWS.flatMap((view) => (view.terminal === undefined ? [] : [view.terminal])));
    expect([...states].sort(), 'every terminal state of the fake server has a view').toEqual(
      [...TERMINAL_FIXTURE_STATES].sort(),
    );
    const session = VIEWS.find((view) => view.id === 'terminal-colors');
    if (session === undefined) throw new Error('no terminal view');
    expect(resolveViewUrl(session, { detailSessionId: 'x' })).toBe(`/?session=${FIXTURE_TERMINALS.colors}`);
  });
});

// ---- the canned terminal: the screens and the socket (CAW-49) -----------------------------------------------------------------------

/** The cells a line takes: its characters without the escape sequences, the one wide glyph of the samples counted twice. */
function cellsOf(line: string): number {
  const wide = String.fromCodePoint(0x26a1);
  const text = visibleText(line);
  return Array.from(text).length + text.split(wide).length - 1;
}

test.describe('the terminal sample', () => {
  test('has the 134 Vietnamese letters outside ASCII, each one precomposed (NFC) and one cell wide', () => {
    const letters = vietnameseLetters();
    expect(letters.length).toBe(134);
    expect(new Set(letters).size).toBe(134);
    for (const letter of letters) {
      expect(letter, 'NFC').toBe(letter.normalize('NFC'));
      expect(letter.length, `one code unit: ${letter}`).toBe(1);
      expect(letter.charCodeAt(0), 'not ASCII').toBeGreaterThan(0x7f);
      // no combining mark is left on its own
      expect(letter.charCodeAt(0) < 0x300 || letter.charCodeAt(0) > 0x36f).toBe(true);
    }
    const lower = letters.slice(0, 67);
    expect(letters.slice(67)).toEqual(lower.map((letter) => letter.toUpperCase()));
    // the stroked d, a letter with two marks (circumflex and dot below) and its capital
    for (const code of [0x111, 0x110, 0x1ec7, 0x1ec6, 0x1edd, 0x1eb2]) {
      expect(letters, code.toString(16)).toContain(String.fromCodePoint(code));
    }
  });

  test('the Vietnamese screen draws every letter in each of the 16 colours, and fits the width it is given', () => {
    const letters = vietnameseLetters();
    expect(ANSI_FOREGROUND_CODES).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97]);
    for (const size of [
      { cols: 80, rows: 24 },
      { cols: 80, rows: 40 },
      { cols: 120, rows: 30 },
      { cols: 200, rows: 50 },
    ]) {
      const lines = sampleLines('vietnamese', size);
      const text = lines.join('');
      for (const code of ANSI_FOREGROUND_CODES) expect(text, `colour ${String(code)}`).toContain(sgr(code));
      const drawn = visibleText(text);
      for (const letter of letters) expect(drawn.split(letter).length - 1, letter).toBe(16);
      for (const line of lines)
        expect(cellsOf(line), 'a row is not wider than the terminal').toBeLessThanOrEqual(size.cols);
      // a whole alphabet per row when the window is wide enough, else the lower case and the capitals on a row each
      expect(lines.filter((line) => line.includes(sgr(31))).length).toBe(size.cols >= 134 ? 1 : 2);
    }
  });

  test('the colours screen has the 16 colours, bold, dim and inverse, the glyphs and a box-drawing frame', () => {
    const text = sampleText('colors', { cols: 120, rows: 30 });
    for (const code of ANSI_FOREGROUND_CODES) expect(text, `text colour ${String(code)}`).toContain(sgr(code));
    for (const code of [40, 41, 42, 43, 44, 45, 46, 47]) {
      expect(text, `background ${String(code)}`).toContain(sgr(code, code === 40 || code === 44 ? 97 : 30));
      expect(text, `bright background ${String(code + 60)}`).toContain(sgr(code + 60, 30));
    }
    for (const attribute of [1, 2, 3, 4, 7, 9])
      expect(text, `attribute ${String(attribute)}`).toContain(sgr(attribute));
    expect(text, 'bold red').toContain(sgr(1, 31));
    expect(text, 'dim red').toContain(sgr(2, 31));
    expect(text, 'inverse red').toContain(sgr(7, 31));
    expect(text, 'a 256-colour cell').toContain(sgr(48, 5, 16));
    expect(text, 'a true-colour cell').toContain(`${sgr(48, 2, 255, 60, 0)} `);
    expect(TERMINAL_GLYPH_CODE_POINTS.length).toBe(13);
    for (const code of TERMINAL_GLYPH_CODE_POINTS)
      expect(text, code.toString(16)).toContain(String.fromCodePoint(code));
    // the corners and both lines of the frame, and the rounded corners of the box line
    for (const code of [0x250c, 0x2510, 0x2514, 0x2518, 0x2500, 0x2502, 0x256d, 0x256e, 0x2570, 0x256f]) {
      expect(text, code.toString(16)).toContain(String.fromCodePoint(code));
    }
  });

  test('every screen fits 80 columns and 24 rows, except the Vietnamese one, which needs a row per colour', () => {
    expect([...SAMPLE_NAMES]).toEqual(['colors', 'vietnamese', 'session']);
    for (const name of ['colors', 'session'] as const) {
      for (const cols of [80, 97, 120, 200]) {
        const lines = sampleLines(name, { cols, rows: 24 });
        expect(lines.length, `${name} rows`).toBeLessThanOrEqual(24);
        for (const line of lines) expect(cellsOf(line), `${name} at ${String(cols)}`).toBeLessThan(80);
      }
    }
    expect(sampleLines('vietnamese', { cols: 80, rows: 40 }).length).toBe(33);
    expect(sampleLines('vietnamese', { cols: 80, rows: 32 }).length, 'no title where it has no room').toBe(32);
    expect(sampleLines('vietnamese', { cols: 134, rows: 24 }).length).toBe(17);
  });

  test('tells the answers to the cursor request from typed input', () => {
    const escape = String.fromCharCode(27);
    expect(CURSOR_REPORT_REQUEST).toBe(`${escape}[6n`);
    expect(splitCursorReports(`${escape}[12;1R`)).toEqual({ reports: 1, rest: '' });
    expect(splitCursorReports(`ab${escape}[3;40Rcd${escape}[30;120R`)).toEqual({ reports: 2, rest: 'abcd' });
    // an arrow key and a name that ends in R are input, not reports
    expect(splitCursorReports(`${escape}[A`)).toEqual({ reports: 0, rest: `${escape}[A` });
    expect(splitCursorReports(`${escape}[1;5A then R`)).toEqual({ reports: 0, rest: `${escape}[1;5A then R` });
    expect(splitCursorReports('plain')).toEqual({ reports: 0, rest: 'plain' });
  });
});

interface SocketTrace {
  frames: (string | number)[];
  closeCode: number | null;
  /** The binary frames, decoded as UTF-8. */
  text: string;
}

/**
 * The page side of one terminal socket, as a script: it opens the socket with the subprotocol, records every frame (a text frame
 * as its text, a binary frame as its byte count) and the close code, and offers `send` for text and for bytes.
 */
const SOCKET_PROBE = `(() => {
  globalThis.__probe = (name) => {
    const trace = { frames: [], closeCode: null, text: '' };
    const ws = new WebSocket('ws://qa.invalid/api/v3/terminal/sessions/' + name + '/socket', ['caw.terminal.v1']);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') trace.frames.push(event.data);
      else {
        trace.frames.push(event.data.byteLength);
        trace.text += new TextDecoder().decode(event.data);
      }
    };
    ws.onclose = (event) => { trace.closeCode = event.code; };
    trace.sendText = (text) => ws.send(text);
    trace.sendBytes = (codes) => ws.send(new Uint8Array(codes));
    return trace;
  };
  globalThis.__sockets = {};
})()`;

test.describe('the canned terminal socket', () => {
  test('reads the session name from the address of a socket and from nothing else', () => {
    expect(terminalNameOf(new URL('ws://127.0.0.1:18500/api/v3/terminal/sessions/app-1/socket'))).toBe('app-1');
    expect(terminalNameOf(new URL('ws://127.0.0.1:18500/api/v3/terminal/sessions/app-1/kill'))).toBeNull();
    expect(terminalNameOf(new URL('ws://127.0.0.1:18500/api/v3/terminal/sessions/a%20b/socket'))).toBeNull();
    expect(terminalNameOf(new URL('ws://127.0.0.1:18500/api/v3/stream'))).toBeNull();
  });

  test('answers a socket with ready, the replay and live, a resize with size and a new screen, and echoes input', async ({
    page,
  }) => {
    await page.route('http://qa.invalid/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }));
    const fixture = await routeTerminalSocket(page);
    fixture.samples.set('demo-1', 'colors');
    await page.goto('http://qa.invalid/');
    await page.evaluate(SOCKET_PROBE);
    await page.evaluate("globalThis.__sockets.a = globalThis.__probe('demo-1')");
    const read = (key: string): Promise<SocketTrace> =>
      page.evaluate<SocketTrace>(`JSON.parse(JSON.stringify(globalThis.__sockets.${key}))`);

    await expect.poll(async () => (await read('a')).frames.includes('{"type":"live"}')).toBe(true);
    const first = await read('a');
    const ready = TerminalServerMessageSchema.parse(JSON.parse(String(first.frames[0])));
    expect(ready).toMatchObject({ type: 'ready', v: 1, cols: 120, rows: 30, viewers: 1 });
    expect(first.frames[1], 'the replay is as long as ready said').toBe(
      ready.type === 'ready' ? ready.replayBytes : -1,
    );
    expect(first.frames[2]).toBe('{"type":"live"}');
    expect(first.text).toContain('FIXTURE terminal colours');
    expect(first.text.endsWith(CURSOR_REPORT_REQUEST), 'the screen ends with the cursor request').toBe(true);
    const connection = fixture.latest('demo-1');
    expect(connection).toMatchObject({ sample: 'colors', draws: 1, reports: 0, drawnFor: { cols: 120, rows: 30 } });

    // the page asks for a size: the answer is the size frame and the screen drawn again for it
    await page.evaluate(`globalThis.__sockets.a.sendText('{"type":"resize","cols":100,"rows":40}')`);
    await expect.poll(async () => (await read('a')).frames.length).toBe(5);
    const resized = await read('a');
    expect(TerminalServerMessageSchema.parse(JSON.parse(String(resized.frames[3])))).toEqual({
      type: 'size',
      cols: 100,
      rows: 40,
    });
    expect(connection?.resizes).toEqual([{ cols: 100, rows: 40 }]);
    expect(connection).toMatchObject({ draws: 2, drawnFor: { cols: 100, rows: 40 } });

    // two cursor reports (one per screen) and typed input in one frame: the reports are counted, the input is echoed
    const typed = [27, 91, 49, 59, 49, 82, 104, 105, 13, 27, 91, 50, 59, 51, 82];
    await page.evaluate(`globalThis.__sockets.a.sendBytes(${JSON.stringify(typed)})`);
    await expect.poll(async () => (await read('a')).frames.length).toBe(6);
    expect((await read('a')).frames[5], 'h, i, carriage return and the line feed of the echo').toBe(4);
    expect(connection).toMatchObject({ reports: 2, inputs: [`hi${String.fromCharCode(13)}`] });

    // the process exits: the exit frame, then close code 4000; a later socket to it is closed the same way
    fixture.end('demo-1', 3);
    await expect.poll(async () => (await read('a')).closeCode).toBe(4000);
    expect((await read('a')).frames.at(-1)).toBe('{"type":"exit","code":3,"signal":null}');
    expect(fixture.latest('demo-1')).toBeNull();
    await page.evaluate("globalThis.__sockets.b = globalThis.__probe('demo-1')");
    await expect.poll(async () => (await read('b')).closeCode).toBe(4000);

    // a stop closes with 4001, and a frame that is no resize closes the socket as a bad message (1008)
    await page.evaluate("globalThis.__sockets.c = globalThis.__probe('demo-2')");
    await expect.poll(async () => (await read('c')).frames.includes('{"type":"live"}')).toBe(true);
    expect(fixture.latest('demo-2')?.sample, 'a name without a screen of its own shows the session').toBe('session');
    fixture.kill('demo-2');
    await expect.poll(async () => (await read('c')).closeCode).toBe(4001);
    await page.evaluate("globalThis.__sockets.d = globalThis.__probe('demo-3')");
    await expect.poll(async () => (await read('d')).frames.includes('{"type":"live"}')).toBe(true);
    await page.evaluate(`globalThis.__sockets.d.sendText('{"type":"resize","cols":"wide"}')`);
    await expect.poll(async () => (await read('d')).closeCode).toBe(1008);
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

// ---- fixture mode, the terminal side (CAW-49) -------------------------------------------------------------------------------------

/** What the terminal pane of the Workspace shows (`data-pane`) for each state of the terminal side. */
const PANE_OF_STATE: Readonly<Record<TerminalFixtureState, string>> = {
  ok: 'none-selected',
  locked: 'locked',
  unsupported_os: 'unavailable',
  addon_missing: 'unavailable',
  claude_not_found: 'unavailable',
  empty: 'none-selected',
  loading: 'loading',
  error: 'error',
};

interface Answer {
  status: number;
  body: unknown;
}

test.describe('fixture mode, the terminal side', () => {
  test('lists the eight states, and a page without one keeps the task instance that has no terminal routes', async ({
    browser,
    qa,
  }) => {
    expect([...TERMINAL_FIXTURE_STATES]).toEqual([
      'ok',
      'locked',
      'unsupported_os',
      'addon_missing',
      'claude_not_found',
      'empty',
      'loading',
      'error',
    ]);
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, timezoneId: 'UTC' });
    try {
      const page = await context.newPage();
      const fixture = await fixtureApi(page, 'ok');
      expect(fixture.terminal).toBeNull();
      await page.goto(`${qa.baseUrl}/sessions`);
      const get = (path: string): Promise<Answer> =>
        page.evaluate<Answer>(
          `fetch('${qa.baseUrl}${path}').then(async (r) => ({ status: r.status, body: await r.json() }))`,
        );
      expect((await get(routes.instance.path)).body).toMatchObject({ kind: 'task', app: null });
      expect((await get(routes.authSession.path)).status).toBe(404);
      expect((await get(routes.terminalState.path)).status).toBe(404);
    } finally {
      await context.close();
    }
  });

  test('answers every route of the Workspace with a body of its contract, and a write with its method and body', async ({
    browser,
    qa,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, timezoneId: 'UTC' });
    try {
      const page = await context.newPage();
      const fixture = await fixtureApi(page, 'ok', 'ok');
      await page.route(`${qa.baseUrl}/blank`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }),
      );
      await page.goto(`${qa.baseUrl}/blank`);
      const call = (method: 'GET' | 'POST', path: string, body?: unknown, header = true): Promise<Answer> =>
        page.evaluate<Answer>(
          `fetch(${JSON.stringify(path)}, {
             method: ${JSON.stringify(method)},
             headers: ${JSON.stringify(method === 'POST' ? { 'Content-Type': 'application/json', ...(header ? { 'X-MCS-Request': '1' } : {}) } : {})},
             ${method === 'POST' ? `body: ${JSON.stringify(JSON.stringify(body ?? {}))},` : ''}
           }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
        );

      const instance = routes.instance.response.parse((await call('GET', routes.instance.path)).body);
      expect(instance.kind).toBe('user');
      expect(instance.app?.name ?? '').not.toBe('');
      expect((await call('GET', routes.authSession.path)).body).toEqual({ authenticated: true });

      const state = routes.terminalState.response.parse((await call('GET', routes.terminalState.path)).body);
      expect(state.capabilities).toMatchObject({ available: true, reason: null, folderPicker: true, nativeOpen: true });
      expect(state.sessions.map((session) => session.name).sort()).toEqual(Object.values(FIXTURE_TERMINALS).sort());
      expect(state.sessions.length).toBeLessThanOrEqual(state.capabilities.maxSessions);
      const folders = routes.listFolders.response.parse((await call('GET', routes.listFolders.path)).body);
      expect(folders.folders.length).toBeGreaterThanOrEqual(6);
      const keys = new Set(folders.folders.map((folder) => folder.key));
      for (const session of state.sessions) expect(keys.has(session.folderKey ?? ''), session.name).toBe(true);
      expect(folders.folders.some((folder) => !folder.canStart && folder.path === null)).toBe(true);
      expect(folders.folders.some((folder) => folder.da === null)).toBe(true);

      // the monitor rows of the linked terminals by id, and the recent sessions of a folder by its project key
      const linked = state.sessions.flatMap((session) =>
        session.link.transcript === 'tracked' && session.link.sessionId !== null ? [session.link.sessionId] : [],
      );
      expect(linked.length).toBe(2);
      const rows = routes.listSessions.response.parse(
        (await call('GET', `${routes.listSessions.path}?session=${linked.join(',')}&range=all`)).body,
      );
      expect(rows.items.map((item) => item.id).sort()).toEqual([...linked].sort());
      const recentKey = folders.folders.find((folder) => folder.name === FIXTURE_RECENT_FOLDER)?.key ?? '';
      const recent = routes.listSessions.response.parse(
        (await call('GET', `${routes.listSessions.path}?project=${recentKey}&limit=6`)).body,
      );
      expect(recent.items.length, 'six rows, so the list offers "All sessions"').toBe(6);
      const all = routes.listSessions.response.parse((await call('GET', routes.listSessions.path)).body);
      expect(all.items.length).toBe(12);

      // the eligibility of a resume: yes, only a copy, refused, and already open in a terminal of the app
      const resume = async (n: number): Promise<unknown> =>
        routes.sessionResume.response.parse((await call('GET', `/api/v3/sessions/${fixtureId(n)}/resume`)).body);
      expect(await resume(3)).toMatchObject({ allowed: true, forkAllowed: true, liveElsewhere: false });
      expect(await resume(7)).toMatchObject({ allowed: false, forkAllowed: true, liveElsewhere: true });
      expect(await resume(8)).toMatchObject({ allowed: false, forkAllowed: false, reason: 'folder_missing' });
      expect(await resume(1)).toMatchObject({ reason: 'live_in_terminal', liveTerminal: FIXTURE_TERMINALS.session });

      // writes: without the request header the fake server refuses as the real one does; with it the handler gets the body
      const unsigned = await call('POST', routes.terminalOpenNative.path, { sessionId: fixtureId(3) }, false);
      expect(unsigned.status).toBe(403);
      const native = await call('POST', routes.terminalOpenNative.path, { sessionId: fixtureId(3), fork: true });
      expect(routes.terminalOpenNative.response.parse(native.body)).toEqual({ via: 'windows-terminal', fork: true });
      const picked = routes.terminalPickFolder.response.parse(
        (await call('POST', routes.terminalPickFolder.path)).body,
      );
      const created = routes.terminalCreateSession.response.parse(
        (await call('POST', routes.terminalCreateSession.path, { path: picked.path })).body,
      );
      expect(created.session.name).toBe('picked-folder-1');
      const resumed = routes.terminalResume.response.parse(
        (await call('POST', routes.terminalResume.path, { sessionId: fixtureId(3) })).body,
      );
      expect(resumed.session.link).toMatchObject({ status: 'linked', sessionId: fixtureId(3), transcript: 'tracked' });
      const after = routes.terminalState.response.parse((await call('GET', routes.terminalState.path)).body);
      expect(after.sessions.map((session) => session.name)).toContain(created.session.name);
      expect(after.sessions.map((session) => session.name)).toContain(resumed.session.name);
      const killed = await call('POST', `/api/v3/terminal/sessions/${created.session.name}/kill`);
      expect(killed.body).toEqual({ name: created.session.name });
      expect((await call('POST', '/api/v3/terminal/sessions/no-such-1/kill')).status).toBe(404);
      expect(fixture.terminal?.socket.ended.has(created.session.name)).toBe(true);

      // a logout locks the terminal routes, a redeemed code opens them again
      expect((await call('POST', routes.authLogout.path)).body).toEqual({ authenticated: false });
      expect((await call('GET', routes.terminalState.path)).status).toBe(401);
      expect((await call('GET', routes.listFolders.path)).status).toBe(401);
      const exchanged = await call('POST', routes.authExchange.path, { code: accessCode() });
      expect(exchanged.body).toEqual({ authenticated: true });
      expect((await call('GET', routes.terminalState.path)).status).toBe(200);
      expect(fixture.fake.violations, 'the fake bodies keep to the contract').toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('shows the pane of each terminal state in the page', async ({ browser, qa }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
    try {
      for (const state of TERMINAL_FIXTURE_STATES) {
        const page = await context.newPage();
        const fixture = await fixtureApi(page, 'ok', state);
        await page.goto(`${qa.baseUrl}/`);
        const pane = page.locator('.workspace-pane');
        await expect(pane, state).toHaveAttribute('data-pane', PANE_OF_STATE[state], { timeout: 30_000 });
        // the project column exists only with the session and where terminals can run
        const column = state === 'ok' || state === 'empty' || state === 'loading' || state === 'error';
        await expect(page.locator('.workspace-sidebar'), state).toHaveCount(column ? 1 : 0);
        expect(fixture.fake.violations, state).toEqual([]);
        await page.close();
      }
    } finally {
      await context.close();
    }
  });

  test('the canned socket answers the terminal of the app: the screen is drawn for the size the page gave it', async ({
    browser,
    qa,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    try {
      // the DOM renderer keeps the text of the rows in the page, so the screen can be read back
      const prefs = JSON.stringify(JSON.stringify({ theme: 'dark', locale: 'en', terminalRenderer: 'dom' }));
      await context.addInitScript(`globalThis.localStorage.setItem('${PREFS_STORAGE_KEY}', ${prefs});`);
      const page = await context.newPage();
      const fixture = await fixtureApi(page, 'ok', 'ok');
      const name = FIXTURE_TERMINALS.colors;
      await page.goto(`${qa.baseUrl}/?session=${name}`);
      const host = page.locator('[data-terminal][data-cols][data-rows]');
      await host.waitFor({ state: 'visible', timeout: 30_000 });
      const socket = fixture.terminal?.socket;
      if (socket === undefined) throw new Error('the fixture has no terminal side');
      const size = await socket.settle(page, name);
      expect(Number(await host.getAttribute('data-cols'))).toBe(size.cols);
      expect(Number(await host.getAttribute('data-rows'))).toBe(size.rows);
      const connection = socket.latest(name);
      expect(connection).toMatchObject({ sample: 'colors', drawnFor: size });
      expect(connection?.reports, 'the terminal answered the cursor request of every screen').toBe(connection?.draws);
      expect(connection?.inputs, 'a cursor report is not typed input').toEqual([]);
      await expect(page.locator('.xterm-rows')).toContainText('FIXTURE terminal colours');
      await expect(page.locator('.xterm-rows')).toContainText('214 tests passed');
      // the measurement of the QA tool reads the same size from the page
      expect((await measure(page)).terminal).toMatchObject({ cols: size.cols, rows: size.rows });

      // the process exits: the pane keeps the screen under the banner, and the session leaves the list of the fake server
      socket.end(name, 0);
      await expect(page.locator('.workspace-ended')).toBeVisible();
      await expect(page.locator('.xterm-rows')).toContainText('FIXTURE terminal colours');
      const state = routes.terminalState.response.parse(
        await page.evaluate(`fetch('${routes.terminalState.path}').then((r) => r.json())`),
      );
      expect(state.sessions.map((session) => session.name)).not.toContain(name);
      expect(fixture.fake.violations).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
