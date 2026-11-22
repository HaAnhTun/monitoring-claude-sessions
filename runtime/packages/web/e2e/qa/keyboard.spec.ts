// The keyboard contract (CAW-50; design 05 sections 6 and 7.4): with the real Tab key, at most ten Tab stops come before the main
// content of every page of the route table, the navigation of the sidebar is one of them (the arrow keys move inside it), the focus
// ring is visible on the first fourteen controls the Tab key reaches, menus and popovers give the focus back to their trigger, the
// dialogs keep it inside, a page that replaces its heading keeps the focus on the heading, the single-key shortcuts stay silent
// while a text field or the terminal has the focus, and `prefers-reduced-motion` stops the pulse. Texts come from the catalogue.
// The last tests prove the checks on pages made to fail. Run it inside the `run` lock with `MCS_SHOTS_DIR` set (see `contract.ts`).
import type { Locator, Page } from '@playwright/test';

import { msg } from '../../src/test/msg.ts';
import {
  CONTRACT_THEMES,
  CONTRACT_VIEWPORTS,
  DESKTOP,
  PHONE,
  TWO_FRAMES,
  expect,
  openContext,
  openPage,
  pageOf,
  routePages,
  sizeOf,
  tabStopsBeforeMain,
  test,
} from './contract.ts';
import { FIXTURE_TERMINALS } from './fixture-api.ts';

/** Design 05 section 7.4 (ADR 0073 decision 12). */
const MAX_TAB_STOPS_BEFORE_MAIN = 10;
/** How many controls of a page the focus ring check walks (the shell, then the start of the page). */
const RING_STOPS = 14;

/** Whether the focused element, or what stands for it (its pseudo-elements, the label that wraps it), shows a focus indicator. */
const FOCUS_INDICATOR = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { focused: false, indicator: false, what: '' };
  const clear = (color) => color === 'transparent' || /^rgba\\(.*,\\s*0\\)$/.test(color);
  const drawn = (s) => {
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && !clear(s.outlineColor);
    return outline || (s.boxShadow !== '' && s.boxShadow !== 'none');
  };
  const candidates = [getComputedStyle(el), getComputedStyle(el, '::after'), getComputedStyle(el, '::before')];
  const label = el.closest('label');
  if (label) candidates.push(getComputedStyle(label));
  const named = el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '');
  return { focused: true, indicator: candidates.some(drawn), what: named };
})()`;

interface Indicator {
  focused: boolean;
  indicator: boolean;
  what: string;
}

async function focusIndicator(page: Page): Promise<Indicator> {
  return page.evaluate<Indicator>(FOCUS_INDICATOR);
}

/** The element that has the focus is inside `container`. */
async function focusIsIn(container: Locator): Promise<boolean> {
  return container.evaluate((root) => {
    const dom = globalThis as unknown as { document: { activeElement: unknown } };
    return (root as unknown as { contains(node: unknown): boolean }).contains(dom.document.activeElement);
  });
}

/**
 * Where the focus is relative to a container: `inside`, `document` (nothing in the page has it: a modal dialog with one control hands
 * the next Tab to the browser) or `outside` (an element behind the dialog, which a modal must make unreachable).
 */
async function focusPlace(container: Locator): Promise<'inside' | 'document' | 'outside'> {
  return container.evaluate((root) => {
    const dom = globalThis as unknown as { document: { activeElement: unknown; body: unknown } };
    const active = dom.document.activeElement;
    if ((root as unknown as { contains(node: unknown): boolean }).contains(active)) return 'inside';
    return active === null || active === dom.document.body ? 'document' : 'outside';
  });
}

async function startAtTheTop(page: Page): Promise<void> {
  await page.evaluate('(() => { const el = document.activeElement; if (el && el !== document.body) el.blur(); })()');
}

/** The tag of the focused element and whether it sits in the terminal region. */
async function focusedField(page: Page): Promise<{ tag: string; inTerminal: boolean }> {
  return page.evaluate<{ tag: string; inTerminal: boolean }>(`(() => {
    const el = document.activeElement;
    return { tag: el ? el.tagName : '', inTerminal: !!el && !!el.closest('[data-terminal-region]') };
  })()`);
}

// ---- the Tab order -----------------------------------------------------------------------------------------------------------

for (const viewport of CONTRACT_VIEWPORTS) {
  test(`${sizeOf(viewport)}: at most ${String(MAX_TAB_STOPS_BEFORE_MAIN)} Tab stops before the main content of every page`, async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport, theme: 'light', locale: 'en' });
    const problems: string[] = [];
    try {
      for (const spec of routePages()) {
        const { page } = await openPage(context, qa, spec, 'en');
        try {
          const stops = await tabStopsBeforeMain(page);
          if (stops === null) problems.push(`${spec.id}: the Tab key never reaches the main content`);
          else if (stops > MAX_TAB_STOPS_BEFORE_MAIN) {
            problems.push(
              `${spec.id}: ${String(stops)} Tab stops before main (limit ${String(MAX_TAB_STOPS_BEFORE_MAIN)})`,
            );
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
    expect(problems).toEqual([]);
  });
}

test('the navigation of the sidebar is one Tab stop: the arrow keys, Home and End move inside it and Tab leaves it', async ({
  browser,
  qa,
}) => {
  const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
  try {
    const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
    const nav = page.getByRole('navigation', { name: msg('nav.label') });
    const links = nav.getByRole('link');
    const count = await links.count();
    expect(count).toBeGreaterThan(3);
    await expect(nav.locator('a[tabindex="0"]')).toHaveCount(1);
    const hrefOfFocus = (): Promise<string | null> =>
      page.evaluate<string | null>('document.activeElement ? document.activeElement.getAttribute("href") : null');
    const hrefs: (string | null)[] = [];
    for (let at = 0; at < count; at += 1) hrefs.push(await links.nth(at).getAttribute('href'));

    await startAtTheTop(page);
    let inNav = 0;
    for (let press = 0; press < MAX_TAB_STOPS_BEFORE_MAIN + 2; press += 1) {
      await page.keyboard.press('Tab');
      if (await focusIsIn(nav)) inNav += 1;
      else if (inNav > 0) break;
    }
    expect(inNav, 'the Tab key stops in the navigation once').toBe(1);

    // back into the navigation: its stop is the entry of the current page
    await page.keyboard.press('Shift+Tab');
    expect(await focusIsIn(nav)).toBe(true);
    expect(await hrefOfFocus()).toBe('/sessions');
    const at = hrefs.indexOf('/sessions');
    await page.keyboard.press('ArrowDown');
    expect(await hrefOfFocus()).toBe(hrefs[at + 1]);
    await page.keyboard.press('End');
    expect(await hrefOfFocus()).toBe(hrefs[count - 1]);
    await page.keyboard.press('ArrowDown');
    expect(await hrefOfFocus(), 'ArrowDown wraps from the last entry to the first').toBe(hrefs[0]);
    await page.keyboard.press('ArrowUp');
    expect(await hrefOfFocus(), 'ArrowUp wraps from the first entry to the last').toBe(hrefs[count - 1]);
    await page.keyboard.press('Home');
    expect(await hrefOfFocus()).toBe(hrefs[0]);
    await expect(nav.locator('a[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('Tab');
    expect(await focusIsIn(nav), 'one Tab leaves the navigation').toBe(false);
  } finally {
    await context.close();
  }
});

for (const theme of CONTRACT_THEMES) {
  test(`${theme}: the focus ring is visible on the first ${String(RING_STOPS)} Tab stops of every page`, async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme, locale: 'en' });
    const problems: string[] = [];
    try {
      for (const spec of routePages()) {
        const { page } = await openPage(context, qa, spec, 'en');
        try {
          await startAtTheTop(page);
          let focused = 0;
          for (let stop = 1; stop <= RING_STOPS; stop += 1) {
            await page.keyboard.press('Tab');
            // the ring is never part of a transition: two frames after the key it is drawn, or it is missing
            await page.evaluate(TWO_FRAMES);
            const last = await focusIndicator(page);
            if (last.focused && !last.indicator) {
              problems.push(`${spec.id}: Tab stop ${String(stop)} (${last.what}) shows no focus ring`);
            }
            if (last.focused) focused += 1;
          }
          // a walk that never focused anything would pass without having looked at a single ring
          if (focused < RING_STOPS - 2) {
            problems.push(`${spec.id}: only ${String(focused)} of ${String(RING_STOPS)} Tab presses focused a control`);
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
    expect(problems).toEqual([]);
  });
}

// ---- menus and popovers give the focus back ---------------------------------------------------------------------------------

test.describe('menus and popovers', () => {
  test('the preferences menu opens with the keyboard, takes the focus and gives it back on Escape', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
      const trigger = page.getByRole('button', { name: msg('menu.trigger') });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: msg('menu.trigger') });
      await expect(menu).toBeVisible();
      await expect.poll(() => focusIsIn(menu)).toBe(true);
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => focusIsIn(menu)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('the Live control opens its panel with the keyboard and gives the focus back on Escape', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('overview'), 'en');
      const trigger = page.getByRole('banner').locator('.live-control').getByRole('button').first();
      await trigger.focus();
      await page.keyboard.press('Enter');
      const panel = page.getByRole('dialog', { name: msg('live.popover.label') });
      await expect(panel).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Tab');
      await expect.poll(() => focusIsIn(panel)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('the more-filters popover of the Sessions page gives the focus back on Escape', async ({ browser, qa }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'dark', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
      const trigger = page.getByRole('button', { name: msg('filters.more') });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('an info tip of the Overview opens and closes with the keyboard and keeps the focus on its button', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('overview'), 'en');
      const trigger = page.locator('main [data-metric] .info-tip button').first();
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
    } finally {
      await context.close();
    }
  });
});

// ---- dialogs trap the focus -------------------------------------------------------------------------------------------------

test.describe('dialogs', () => {
  test('the shortcuts dialog takes the focus, keeps it away from the page behind, closes on Escape and gives the focus back', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
      const trigger = page.getByRole('button', { name: msg('menu.trigger') });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: msg('menu.shortcuts') }).press('Enter');
      const dialog = page.getByRole('dialog', { name: msg('shortcuts.title') });
      await expect(dialog).toBeVisible();
      await expect.poll(() => focusPlace(dialog)).toBe('inside');
      for (let press = 0; press < 8; press += 1) {
        await page.keyboard.press('Tab');
        expect(await focusPlace(dialog), `Tab ${String(press + 1)} never lands behind the dialog`).not.toBe('outside');
      }
      for (let press = 0; press < 3; press += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await focusPlace(dialog), `Shift+Tab ${String(press + 1)} never lands behind the dialog`).not.toBe(
          'outside',
        );
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('the navigation sheet of a narrow window traps the focus and gives it back to the Menu button', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: PHONE, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('overview'), 'en');
      const button = page.getByRole('button', { name: msg('shell.menu.open') });
      await button.focus();
      await page.keyboard.press('Enter');
      const sheet = page.getByRole('dialog', { name: msg('shell.menu.title') });
      await expect(sheet).toBeVisible();
      await expect.poll(() => focusIsIn(sheet)).toBe(true);
      for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press('Tab');
        expect(await focusIsIn(sheet), `Tab ${String(press + 1)} stays in the sheet`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(button).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('the stop dialog of the Workspace keeps the focus inside and gives it back to the Stop button', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'dark', locale: 'en' });
    try {
      // the view opens the dialog with a click on "Stop session"
      const { page } = await openPage(context, qa, pageOf('workspace-kill-dialog'), 'en');
      const dialog = page.locator('dialog.dialog--danger[open]');
      await expect(dialog).toBeVisible();
      await expect.poll(() => focusPlace(dialog)).toBe('inside');
      for (let press = 0; press < 6; press += 1) {
        await page.keyboard.press('Tab');
        expect(await focusPlace(dialog), `Tab ${String(press + 1)} never lands behind the dialog`).not.toBe('outside');
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.workspace-header__actions [data-tone="danger"]')).toBeFocused();
    } finally {
      await context.close();
    }
  });
});

// ---- the heading keeps the focus ---------------------------------------------------------------------------------------------

test('the focus follows the heading of the session page from its loading frame to the loaded page', async ({
  browser,
  qa,
}) => {
  const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
  try {
    const id = qa.sessions.subagentError;
    const { page } = await openPage(context, qa, pageOf('sessions'), 'en');
    // the answer about the session is held back until the loading frame has been seen with the focus on its heading
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    await page.route(`**/api/v3/sessions/${id}`, async (route) => {
      asked += 1;
      await held;
      await route.continue();
    });
    await page.locator(`main a[href="/sessions/${id}"]`).first().click();
    const heading = page.locator('main h1');
    await expect(heading).toBeFocused();
    await expect.poll(() => asked).toBeGreaterThan(0);
    await expect(heading).toHaveText(msg('route.sessionDetail.title'));
    // mark the heading of the loading frame: the loaded page must bring a new element, and the focus must be on that one
    await heading.evaluate((element) => {
      (element as unknown as { setAttribute(name: string, value: string): void }).setAttribute(
        'data-contract-probe',
        'loading',
      );
    });
    release();
    await expect(page.locator('main li[data-row-key]').first()).toBeVisible();
    await expect(page.locator('[data-contract-probe]'), 'the loading frame and its heading are gone').toHaveCount(0);
    await expect(heading).toHaveCount(1);
    await expect(heading).not.toHaveText(msg('route.sessionDetail.title'));
    await expect(heading, 'the focus moved to the heading of the loaded page').toBeFocused();
  } finally {
    await context.close();
  }
});

// ---- single-key shortcuts ----------------------------------------------------------------------------------------------------

test.describe('single-key shortcuts', () => {
  test('are ignored while the terminal has the focus: the keys go to the program, and work again once the focus left it', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'dark', locale: 'en' });
    try {
      const name = FIXTURE_TERMINALS.session;
      const { page, fixture } = await openPage(context, qa, pageOf('workspace-session'), 'en');
      const socket = fixture?.terminal?.socket;
      if (socket === undefined) throw new Error('the page has no canned terminal socket');
      const dialogs = page.locator('dialog[open]');

      await page.locator('[data-terminal][data-cols][data-rows]').click();
      await expect.poll(() => focusedField(page)).toEqual({ tag: 'TEXTAREA', inTerminal: true });
      // the keys of the three global shortcuts: follow the transcript, focus the search field, the shortcuts dialog
      for (const key of ['f', '/', '?']) await page.keyboard.press(key);
      await expect.poll(() => (socket.latest(name)?.inputs ?? []).join('')).toBe('f/?');
      await page.evaluate(TWO_FRAMES);
      await expect(dialogs, 'the question mark did not open the shortcuts dialog').toHaveCount(0);
      expect(await focusedField(page), 'the slash did not move the focus').toEqual({
        tag: 'TEXTAREA',
        inTerminal: true,
      });

      // the way out of the terminal, then the same key opens the dialog
      await page.keyboard.press('Control+Shift+Space');
      await expect.poll(async () => (await focusedField(page)).inTerminal).toBe(false);
      await page.keyboard.press('?');
      await expect(page.getByRole('dialog', { name: msg('shortcuts.title') })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialogs).toHaveCount(0);
      expect((socket.latest(name)?.inputs ?? []).join(''), 'nothing more went to the program').toBe('f/?');
    } finally {
      await context.close();
    }
  });

  test('are ignored while a text field has the focus, and the slash moves the focus to the search field', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(context, qa, pageOf('workspace'), 'en');
      const dialogs = page.locator('dialog[open]');
      const filter = page.getByRole('searchbox', { name: msg('workspace.filter.label') });
      await page.locator('main h1').focus();
      await page.keyboard.press('/');
      await expect(filter).toBeFocused();
      for (const key of ['f', '?', '/']) await page.keyboard.press(key);
      await expect(filter).toHaveValue('f?/');
      await expect(filter).toBeFocused();
      await expect(dialogs).toHaveCount(0);

      // outside the field the question mark opens the dialog
      await page.locator('main h1').focus();
      await page.keyboard.press('?');
      await expect(page.getByRole('dialog', { name: msg('shortcuts.title') })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialogs).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

// ---- reduced motion ---------------------------------------------------------------------------------------------------------

const INFINITE_ANIMATIONS = `Array.from(document.querySelectorAll('*')).filter((el) => {
  const s = getComputedStyle(el);
  return s.animationName !== 'none' && s.animationIterationCount === 'infinite';
}).length`;

test.describe('prefers-reduced-motion', () => {
  test('a pulse runs without the preference and stops with it', async ({ browser, qa }) => {
    const spec = pageOf('sessions');
    const motion = await openContext(browser, {
      viewport: DESKTOP,
      theme: 'light',
      locale: 'en',
      reducedMotion: 'no-preference',
    });
    try {
      const { page } = await openPage(motion, qa, spec, 'en');
      // The probe only means something when the page has a pulse to stop: the QA instance has a working session.
      expect(await page.evaluate(INFINITE_ANIMATIONS), 'a pulse runs without the preference').toBeGreaterThan(0);
    } finally {
      await motion.close();
    }
    const still = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en' });
    try {
      const { page } = await openPage(still, qa, spec, 'en');
      expect(await page.evaluate(INFINITE_ANIMATIONS), 'no animation repeats with the preference').toBe(0);
    } finally {
      await still.close();
    }
  });

  test('every page is free of repeating animation with the preference', async ({ browser, qa }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'dark', locale: 'en' });
    const problems: string[] = [];
    try {
      for (const spec of routePages()) {
        const { page } = await openPage(context, qa, spec, 'en');
        try {
          const count = await page.evaluate<number>(INFINITE_ANIMATIONS);
          if (count > 0) problems.push(`${spec.id}: ${String(count)} element(s) still animate in a loop`);
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
  test('a control without a focus ring is reported, and one with a ring is not', async ({ browser }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const page = await context.newPage();
      await page.setContent(
        '<!doctype html><main><button id="bare" style="outline: none">bare</button><button id="ring" style="outline: 2px solid #00f">ring</button><button id="clear" style="outline: 2px solid transparent">clear</button></main>',
      );
      await page.keyboard.press('Tab');
      const bare = await focusIndicator(page);
      expect(bare.focused).toBe(true);
      expect(bare.indicator, 'a button with outline none has no indicator').toBe(false);
      await page.keyboard.press('Tab');
      expect((await focusIndicator(page)).indicator, 'a solid outline is an indicator').toBe(true);
      await page.keyboard.press('Tab');
      expect((await focusIndicator(page)).indicator, 'a transparent outline is none').toBe(false);
    } finally {
      await context.close();
    }
  });

  test('a page with a long run of controls before main is reported, and one that never reaches main too', async ({
    browser,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const page = await context.newPage();
      const links = Array.from({ length: 14 }, (_unused, n) => `<a href="#x${String(n)}">link</a>`).join('');
      await page.setContent(`<!doctype html><nav>${links}</nav><main tabindex="-1"><button>inside</button></main>`);
      expect(await tabStopsBeforeMain(page)).toBe(14);
      await page.setContent(`<!doctype html><nav>${links}</nav><main tabindex="-1">no control</main>`);
      expect(await tabStopsBeforeMain(page, 20)).toBeNull();
      await page.setContent('<!doctype html><a href="#a">skip</a><main tabindex="-1"><button>inside</button></main>');
      expect(await tabStopsBeforeMain(page)).toBe(1);
    } finally {
      await context.close();
    }
  });

  test('a page whose pulse ignores the preference is reported', async ({ browser }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><style>
        @keyframes pulse { from { opacity: 1; } to { opacity: 0.4; } }
        .always { animation: pulse 1s infinite; }
        .polite { animation: pulse 1s infinite; }
        @media (prefers-reduced-motion: reduce) { .polite { animation: none; } }
      </style><main><span class="polite">a</span></main>`);
      expect(await page.evaluate(INFINITE_ANIMATIONS)).toBe(0);
      await page.setContent(`<!doctype html><style>
        @keyframes pulse { from { opacity: 1; } to { opacity: 0.4; } }
        .always { animation: pulse 1s infinite; }
      </style><main><span class="always">a</span></main>`);
      expect(await page.evaluate(INFINITE_ANIMATIONS)).toBe(1);
    } finally {
      await context.close();
    }
  });
});
