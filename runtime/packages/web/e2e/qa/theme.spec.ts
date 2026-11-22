// The theme contract (CAW-50; design 05 sections 3.4, 6 and 7.4): in real Chrome the resolved value of `--bg`, `--ansi-red` and
// the other terminal colours equals the value written in `styles/tokens.css`, in both themes, when the stored choice goes against
// the system, when it follows the system, and after a switch in the user menu; the stored theme and density are on the document
// before the first frame is painted and stay there while the app starts (no flash); the compact density changes the tokens and the
// rows; and with forced colours every state dot still draws a mark. The last tests prove the checks on pages made to fail.
// Run it inside the `run` lock with `MCS_SHOTS_DIR` set (see `contract.ts`).
import type { BrowserContext, Page } from '@playwright/test';

import {
  declarations,
  readRules,
  readTokenSheet,
  readTokensCss,
  resolve,
  stripComments,
  type Rule,
} from '../../src/test/css-tokens.ts';
import { msg } from '../../src/test/msg.ts';
import type { PlainKey } from '../../src/test/page-matrix.ts';
import {
  DESKTOP,
  TWO_FRAMES,
  expect,
  factsOf,
  openContext,
  openPage,
  pageOf,
  test,
  viewPage,
  type ContractPage,
} from './contract.ts';
import { FORCED_COLORS_THEME, FORCED_COLORS_VIEWPORT, type Theme } from './global-setup.ts';
import type { QaInstance } from './qa-instance.ts';
import { PREFS_STORAGE_KEY, VIEWS } from './views.ts';

type Density = 'comfortable' | 'compact';

const other = (theme: Theme): Theme => (theme === 'light' ? 'dark' : 'light');

// ---- what tokens.css says ------------------------------------------------------------------------------------------------------

const SHEET = readTokenSheet();

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/** The colour tokens held against the browser: the page, the text, and the sixteen colours of the terminal. */
const COLOR_TOKENS: readonly string[] = [
  '--bg',
  '--text',
  ...ANSI_NAMES.map((name) => `--ansi-${name}`),
  ...ANSI_NAMES.map((name) => `--ansi-bright-${name}`),
];

/** The value `tokens.css` gives a colour token in a theme (a `var()` of another token followed). */
function tokenOf(theme: Theme, name: string): string {
  return resolve(theme === 'light' ? SHEET.light : SHEET.dark, name);
}

/** The tokens of the compact density, as `tokens.css` writes them, and what the same names are without it. */
function densityTokens(): Record<Density, Map<string, string>> {
  const rules: Rule[] = [];
  readRules(stripComments(readTokensCss()), [], rules);
  const compact = new Map(
    rules
      .filter((rule) => rule.selector.replaceAll('"', "'") === ":root[data-density='compact']")
      .flatMap((rule) => declarations(rule.body)),
  );
  const comfortable = new Map([...compact.keys()].map((name) => [name, resolve(SHEET.plain, name)]));
  return { comfortable, compact };
}

// ---- what the browser resolves -------------------------------------------------------------------------------------------------

interface Resolved {
  name: string;
  /** The computed colour of `var(<name>)`; `unset` when the browser knows no such token. */
  resolved: string;
  /** The computed colour of the value written in `tokens.css`; `invalid` when the browser cannot read it. */
  expected: string;
}

/**
 * Resolves colour tokens in the page: a probe takes `color: var(--name)` and then the literal value of `tokens.css`, and the
 * browser computes both, so every colour syntax compares in one form. The probe is set through the CSSOM, which the CSP allows.
 */
async function resolveColors(page: Page, tokens: readonly (readonly [string, string])[]): Promise<Resolved[]> {
  const raw: unknown = await page.evaluate(`((pairs) => {
    const SENTINEL = 'rgb(1, 2, 3)';
    const box = document.createElement('span');
    const probe = document.createElement('span');
    box.style.color = SENTINEL;
    box.appendChild(probe);
    document.body.appendChild(box);
    const out = pairs.map(([name, value]) => {
      probe.style.color = '';
      probe.style.color = 'var(' + name + ')';
      const resolved = getComputedStyle(probe).color;
      probe.style.color = '';
      probe.style.color = value;
      const expected = probe.style.color === '' ? 'invalid' : getComputedStyle(probe).color;
      return { name, resolved: resolved === SENTINEL ? 'unset' : resolved, expected };
    });
    box.remove();
    return out;
  })(${JSON.stringify(tokens)})`);
  return raw as Resolved[];
}

/** The colour tokens whose resolved value in the page is not the one `tokens.css` writes for the theme. */
async function tokenProblems(page: Page, theme: Theme, names: readonly string[] = COLOR_TOKENS): Promise<string[]> {
  const resolved = await resolveColors(
    page,
    names.map((name) => [name, tokenOf(theme, name)] as const),
  );
  if (resolved.length !== names.length) return ['the page resolved no tokens'];
  return resolved
    .filter((token) => token.resolved !== token.expected || token.expected === 'invalid')
    .map((token) => `${token.name} resolves to ${token.resolved}, tokens.css says ${token.expected} in ${theme}`);
}

/** A number as every tool writes it: the build shortens `0.75` to `.75`, which is the same value. */
function plainNumber(value: string): string {
  const m = /^(-?[0-9]*[.]?[0-9]+)([a-z%]*)$/.exec(value.trim());
  return m === null ? value.trim() : `${String(Number(m[1]))}${m[2] ?? ''}`;
}

const plainNumbers = (tokens: Iterable<readonly [string, string]>): Record<string, string> =>
  Object.fromEntries([...tokens].map(([name, value]) => [name, plainNumber(value)]));

/** The custom properties of the root element as the browser holds them (the text of the declaration that applies). */
async function rootProperties(page: Page, names: readonly string[]): Promise<Record<string, string>> {
  const raw: unknown = await page.evaluate(`((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  })(${JSON.stringify(names)})`);
  return plainNumbers(Object.entries(raw as Record<string, string>));
}

/** Stores display preferences before the app starts, on every load of the context. */
function storePrefs(prefs: Readonly<Record<string, string>>): string {
  const value = JSON.stringify(JSON.stringify({ locale: 'en', ...prefs }));
  return `try { globalThis.localStorage.setItem('${PREFS_STORAGE_KEY}', ${value}); } catch (error) { void error; }`;
}

/** Picks an entry of a group of the preferences menu (Theme, Density) and closes the menu. */
async function chooseInMenu(page: Page, group: PlainKey, entry: PlainKey): Promise<void> {
  await page.getByRole('button', { name: msg('menu.trigger') }).click();
  const menu = page.getByRole('menu', { name: msg('menu.trigger') });
  await expect(menu).toBeVisible();
  const item = menu
    .getByRole('group', { name: msg(group), exact: true })
    .getByRole('menuitemradio', { name: msg(entry), exact: true });
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

// ---- the tokens in both themes -------------------------------------------------------------------------------------------------

test.describe('the resolved tokens', () => {
  test('tokens.css writes a light and a dark value for every colour token of this contract, and they differ', () => {
    for (const name of COLOR_TOKENS) {
      expect(tokenOf('light', name), name).not.toBe('');
      expect(tokenOf('light', name), name).not.toBe(tokenOf('dark', name));
    }
    expect(COLOR_TOKENS).toContain('--bg');
    expect(COLOR_TOKENS).toContain('--ansi-red');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`a stored ${theme} theme wins over a ${other(theme)} system: every colour token is the ${theme} value of tokens.css`, async ({
      browser,
      qa,
    }) => {
      // `openContext` stores the theme and emulates the same system scheme; here the system says the opposite
      const context = await openContext(browser, {
        viewport: DESKTOP,
        theme: other(theme),
        locale: 'en',
        preset: false,
      });
      try {
        await context.addInitScript(storePrefs({ theme }));
        const { page } = await openPage(context, qa, pageOf('overview'), 'en');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await tokenProblems(page, theme)).toEqual([]);
        // the terminal page resolves the same tokens (its screen is drawn from them)
        const terminal = await openPage(context, qa, pageOf('terminal-colors'), 'en');
        expect(await tokenProblems(terminal.page, theme)).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test(`without a stored theme the page follows a ${theme} system`, async ({ browser, qa }) => {
      const context = await openContext(browser, { viewport: DESKTOP, theme, locale: 'en', preset: false });
      try {
        const { page } = await openPage(context, qa, pageOf('overview'), 'en');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'auto');
        expect(await tokenProblems(page, theme)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('a switch in the user menu changes the tokens at once, survives a reload, and Automatic follows the system again', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
      const root = page.locator('html');
      expect(await tokenProblems(page, 'light')).toEqual([]);

      await chooseInMenu(page, 'menu.theme', 'menu.theme.dark');
      await expect(root).toHaveAttribute('data-theme', 'dark');
      expect(await tokenProblems(page, 'dark')).toEqual([]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main h1').first().waitFor({ state: 'visible' });
      await expect(root).toHaveAttribute('data-theme', 'dark');
      expect(await tokenProblems(page, 'dark')).toEqual([]);

      await chooseInMenu(page, 'menu.theme', 'menu.theme.light');
      await expect(root).toHaveAttribute('data-theme', 'light');
      expect(await tokenProblems(page, 'light')).toEqual([]);

      await page.emulateMedia({ colorScheme: 'dark' });
      expect(await tokenProblems(page, 'light'), 'a stored light theme ignores a dark system').toEqual([]);
      await chooseInMenu(page, 'menu.theme', 'menu.theme.auto');
      await expect(root).toHaveAttribute('data-theme', 'auto');
      expect(await tokenProblems(page, 'dark'), 'Automatic follows the dark system').toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ---- no flash ----------------------------------------------------------------------------------------------------------------

/** What one painted frame of the document showed. */
interface Frame {
  theme: string | null;
  density: string | null;
  background: string;
  /** The app has drawn into its root. */
  started: boolean;
}

/** Records the theme, the density and the page background on every animation frame, from the creation of the document on. */
const FRAME_SAMPLER = `(() => {
  if (globalThis.__contractFrames) return;
  const frames = [];
  globalThis.__contractFrames = frames;
  const sample = () => {
    const root = document.documentElement;
    const body = document.body;
    if (root && body && frames.length < 5000) {
      const app = document.getElementById('root');
      frames.push({
        theme: root.getAttribute('data-theme'),
        density: root.getAttribute('data-density'),
        background: getComputedStyle(body).backgroundColor,
        started: !!app && app.childElementCount > 0,
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`;

const BEFORE_THE_APP = `(globalThis.__contractFrames || []).some((frame) => !frame.started)`;

interface Expected {
  theme: Theme;
  density: Density;
  /** The computed colour of the `--bg` of the theme. */
  background: string;
}

/** Why a run of frames is a flash: a frame with another theme, density or background than the stored choice gives. */
function flashProblems(frames: readonly Frame[], expected: Expected): string[] {
  const problems: string[] = [];
  if (frames.length === 0) return ['no frame was sampled'];
  if (!frames.some((frame) => !frame.started)) problems.push('no frame was sampled before the app started');
  if (!frames.some((frame) => frame.started)) problems.push('no frame was sampled after the app started');
  const first = (wrong: (frame: Frame) => boolean, what: (frame: Frame) => string): void => {
    const at = frames.findIndex(wrong);
    const frame = frames[at];
    if (frame === undefined) return;
    const when = frame.started ? 'after the app started' : 'before the app started';
    problems.push(`frame ${String(at + 1)} of ${String(frames.length)} (${when}) ${what(frame)}`);
  };
  first(
    (frame) => frame.theme !== expected.theme,
    (frame) => `has the theme ${String(frame.theme)}, not ${expected.theme}`,
  );
  first(
    (frame) => frame.density !== expected.density,
    (frame) => `has the density ${String(frame.density)}, not ${expected.density}`,
  );
  first(
    (frame) => frame.background !== expected.background,
    (frame) => `has the background ${frame.background}, not ${expected.background}`,
  );
  return problems;
}

/**
 * Loads the Overview with stored preferences while the scripts of the app are held back, so that frames of the bare document are
 * painted first; then lets the app start and returns every frame up to the drawn page, with the background the theme must give.
 */
async function framesOfALoad(
  context: BrowserContext,
  qa: QaInstance,
  prefs: Readonly<Record<string, string>>,
  theme: Theme,
  breakPage?: (page: Page) => Promise<void>,
): Promise<{ frames: Frame[]; background: string }> {
  await context.addInitScript(storePrefs(prefs));
  await context.addInitScript(FRAME_SAMPLER);
  const page = await context.newPage();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/*.js', async (route) => {
    await held;
    await route.continue();
  });
  await breakPage?.(page);
  try {
    await page.goto(`${qa.baseUrl}/overview`, { waitUntil: 'commit' });
    // evaluated through the debugger: the page's own CSP refuses a string that the page would have to evaluate
    await expect.poll(() => page.evaluate<boolean>(BEFORE_THE_APP), { timeout: 30_000 }).toBe(true);
    await page.evaluate(TWO_FRAMES);
  } finally {
    release();
  }
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(TWO_FRAMES);
  const frames = await page.evaluate<Frame[]>('globalThis.__contractFrames');
  const [bg] = await resolveColors(page, [['--bg', tokenOf(theme, '--bg')]]);
  await page.close();
  return { frames, background: bg?.expected ?? 'invalid' };
}

test.describe('no flash', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`a stored ${theme} theme is on every frame of a load under a ${other(theme)} system`, async ({
      browser,
      qa,
    }) => {
      const context = await openContext(browser, {
        viewport: DESKTOP,
        theme: other(theme),
        locale: 'en',
        preset: false,
      });
      try {
        const { frames, background } = await framesOfALoad(context, qa, { theme }, theme);
        expect(flashProblems(frames, { theme, density: 'comfortable', background })).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('a stored compact density is on every frame of a load', async ({ browser, qa }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const { frames, background } = await framesOfALoad(context, qa, { theme: 'dark', density: 'compact' }, 'dark');
      expect(flashProblems(frames, { theme: 'dark', density: 'compact', background })).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ---- density -----------------------------------------------------------------------------------------------------------------

test.describe('density', () => {
  test('tokens.css has a compact block that changes the row and control heights', () => {
    const tokens = densityTokens();
    expect([...tokens.compact.keys()]).toEqual(expect.arrayContaining(['--row-h', '--ctl-h']));
    for (const [name, value] of tokens.compact) expect(tokens.comfortable.get(name), name).not.toBe(value);
  });

  test('the compact choice of the user menu changes the tokens and the rows, survives a reload and switches back', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const tokens = densityTokens();
      const names = [...tokens.compact.keys()];
      const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
      const root = page.locator('html');
      await expect(root).toHaveAttribute('data-density', 'comfortable');
      expect(await rootProperties(page, names)).toEqual(plainNumbers(tokens.comfortable));
      const comfortableRow = (await factsOf(page)).maxRowHeight;
      expect(comfortableRow).toBeGreaterThan(0);

      await chooseInMenu(page, 'menu.density', 'menu.density.compact');
      await expect(root).toHaveAttribute('data-density', 'compact');
      expect(await rootProperties(page, names)).toEqual(plainNumbers(tokens.compact));
      await page.evaluate(TWO_FRAMES);
      expect((await factsOf(page)).maxRowHeight, 'a compact row is lower').toBeLessThan(comfortableRow);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main tbody tr').first().waitFor({ state: 'visible' });
      await expect(root).toHaveAttribute('data-density', 'compact');
      expect(await rootProperties(page, names)).toEqual(plainNumbers(tokens.compact));

      await chooseInMenu(page, 'menu.density', 'menu.density.comfortable');
      await expect(root).toHaveAttribute('data-density', 'comfortable');
      expect(await rootProperties(page, names)).toEqual(plainNumbers(tokens.comfortable));
      await page.evaluate(TWO_FRAMES);
      expect((await factsOf(page)).maxRowHeight).toBe(comfortableRow);
    } finally {
      await context.close();
    }
  });
});

// ---- forced colours ------------------------------------------------------------------------------------------------------------

interface Dots {
  /** The page matches `forced-colors: active`. */
  forced: boolean;
  canvas: string;
  dots: number;
  /** A dot whose background is the canvas colour, or that draws neither a disc nor a ring. */
  bad: string[];
}

const STATE_DOTS = `(() => {
  const probe = document.createElement('span');
  probe.style.forcedColorAdjust = 'none';
  probe.style.backgroundColor = 'Canvas';
  document.body.appendChild(probe);
  const canvas = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const clear = (color) => color === 'transparent' || /^rgba\\(.*,\\s*0\\)$/.test(color);
  const dots = Array.from(document.querySelectorAll('.state-dot')).filter((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  });
  const bad = [];
  for (const dot of dots) {
    const s = getComputedStyle(dot);
    const ring = s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0 && !clear(s.borderTopColor) && s.borderTopColor !== canvas;
    if (s.backgroundColor === canvas) bad.push(dot.className + ': the background is the canvas colour');
    else if (clear(s.backgroundColor) && !ring) bad.push(dot.className + ': neither a disc nor a ring is drawn');
  }
  return { forced: matchMedia('(forced-colors: active)').matches, canvas, dots: dots.length, bad };
})()`;

/** The pages of the forced-colours column of the matrix: the views marked for it (the style guide, the Sessions, the Workspace). */
function forcedColorsPages(): ContractPage[] {
  return VIEWS.filter((view) => view.forcedColors === true).map((view) => viewPage(view.id));
}

test.describe('forced colours', () => {
  test('the column of the matrix is 1440x900 in the light theme, for the style guide, the Sessions and the Workspace', () => {
    expect(FORCED_COLORS_VIEWPORT).toEqual(DESKTOP);
    expect(FORCED_COLORS_THEME).toBe('light');
    expect(
      forcedColorsPages()
        .map((page) => page.id)
        .sort(),
    ).toEqual(['sessions', 'styleguide', 'workspace']);
  });

  test('every state dot still draws a disc or a ring that is not the canvas colour', async ({ browser, qa }) => {
    const context = await openContext(browser, {
      viewport: FORCED_COLORS_VIEWPORT,
      theme: FORCED_COLORS_THEME,
      locale: 'en',
      forcedColors: true,
    });
    const problems: string[] = [];
    try {
      for (const spec of forcedColorsPages()) {
        const { page } = await openPage(context, qa, spec, 'en');
        try {
          await page.locator('.state-dot').first().waitFor({ state: 'visible', timeout: 20_000 });
          const found = await page.evaluate<Dots>(STATE_DOTS);
          if (!found.forced) problems.push(`${spec.id}: the page does not match forced-colors: active`);
          if (found.dots === 0) problems.push(`${spec.id}: no state dot to judge`);
          for (const bad of found.bad) problems.push(`${spec.id}: ${bad}`);
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
    expect(problems).toEqual([]);
  });
});

// ---- the checks themselves --------------------------------------------------------------------------------------------------

test.describe('negative probes', () => {
  test('a page whose tokens are not the ones of tokens.css is reported, token by token', async ({ browser }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const page = await context.newPage();
      const declared = (theme: Theme, names: readonly string[]): string =>
        names.map((name) => `${name}: ${tokenOf(theme, name)};`).join(' ');
      // the light values, except a `--bg` that some other stylesheet overrides
      await page.setContent(
        `<!doctype html><style>:root { ${declared('light', COLOR_TOKENS)} } :root { --bg: #ffffff; }</style><main>probe</main>`,
      );
      const found = await tokenProblems(page, 'light');
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('--bg resolves to rgb(255, 255, 255)');
      // every token is wrong when the page shows the other theme
      expect(await tokenProblems(page, 'dark')).toHaveLength(COLOR_TOKENS.length);
      // a token the page does not define at all
      await page.setContent(
        `<!doctype html><style>:root { ${declared(
          'light',
          COLOR_TOKENS.filter((name) => name !== '--ansi-red'),
        )} }</style><main>probe</main>`,
      );
      expect(await tokenProblems(page, 'light')).toEqual([expect.stringContaining('--ansi-red resolves to unset')]);
    } finally {
      await context.close();
    }
  });

  test('a load without the pre-paint script flashes, and the frames say so', async ({ browser, qa }) => {
    // the stored theme is dark, the system is light, and the script that applies the stored theme before the first paint is gone
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const { frames, background } = await framesOfALoad(
        context,
        qa,
        { theme: 'dark', density: 'compact' },
        'dark',
        async (page) => {
          await page.route('**/theme-init.js', (route) => route.abort());
        },
      );
      const found = flashProblems(frames, { theme: 'dark', density: 'compact', background }).join('; ');
      expect(found).toContain('(before the app started) has the theme auto, not dark');
      expect(found).toContain('(before the app started) has the density comfortable, not compact');
      expect(found).toContain('(before the app started) has the background');
    } finally {
      await context.close();
    }
  });

  test('frames that change theme, density or background, or that miss a phase of the load, are reported', () => {
    const good: Frame = { theme: 'dark', density: 'compact', background: 'rgb(20, 20, 20)', started: false };
    const expected: Expected = { theme: 'dark', density: 'compact', background: 'rgb(20, 20, 20)' };
    const run = [good, good, { ...good, started: true }];
    expect(flashProblems(run, expected)).toEqual([]);
    expect(flashProblems([], expected)).toEqual(['no frame was sampled']);
    expect(flashProblems([{ ...good, started: true }], expected)).toEqual([
      'no frame was sampled before the app started',
    ]);
    expect(flashProblems([good], expected)).toEqual(['no frame was sampled after the app started']);
    expect(flashProblems([good, { ...good, started: true, theme: 'auto' }], expected)).toEqual([
      'frame 2 of 2 (after the app started) has the theme auto, not dark',
    ]);
    expect(flashProblems([{ ...good, background: 'rgb(245, 242, 234)' }, ...run], expected)).toEqual([
      'frame 1 of 4 (before the app started) has the background rgb(245, 242, 234), not rgb(20, 20, 20)',
    ]);
    expect(flashProblems([...run, { ...good, started: true, density: 'comfortable' }], expected)).toEqual([
      'frame 4 of 4 (after the app started) has the density comfortable, not compact',
    ]);
  });

  test('a state dot that forced colours paint in the canvas colour, and one that draws nothing, is reported', async ({
    browser,
  }) => {
    const context = await openContext(browser, {
      viewport: FORCED_COLORS_VIEWPORT,
      theme: FORCED_COLORS_THEME,
      locale: 'en',
      preset: false,
      forcedColors: true,
    });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><style>
        .state-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
        .plain { background: #c00; }
        .empty { background: transparent; }
        .kept { forced-color-adjust: none; background: CanvasText; }
        .ring { forced-color-adjust: none; background: transparent; border: 2px solid CanvasText; }
      </style><main>
        <span class="state-dot plain"></span><span class="state-dot empty"></span>
        <span class="state-dot kept"></span><span class="state-dot ring"></span>
      </main>`);
      const found = await page.evaluate<Dots>(STATE_DOTS);
      expect(found.forced).toBe(true);
      expect(found.dots).toBe(4);
      expect(found.bad).toEqual([
        'state-dot plain: the background is the canvas colour',
        'state-dot empty: neither a disc nor a ring is drawn',
      ]);
    } finally {
      await context.close();
    }
  });
});
