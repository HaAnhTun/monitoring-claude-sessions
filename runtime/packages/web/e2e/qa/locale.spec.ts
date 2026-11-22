// The language contract (CAW-50; design 05 sections 6 and 7.1): the Vietnamese choice made in the user menu sets `<html lang>`,
// changes the texts of every page (the chrome of the page, not the data), survives a reload and a full page load, and keeps the
// layout contract: the matrix of the responsive spec is walked again in Vietnamese (monospace plus stacked marks is the risk), with
// one picture and one record per page in `MCS_SHOTS_DIR`. Texts come from the catalogue. The last tests prove the checks on pages
// made to fail. Run it inside the `run` lock with `MCS_SHOTS_DIR` set (see `contract.ts`).
import type { Page } from '@playwright/test';

import { enMessages } from '../../src/i18n/messages/en.ts';
import { viMessages } from '../../src/i18n/messages/vi.ts';
import { msg } from '../../src/test/msg.ts';
import {
  DESKTOP,
  columnTimeoutMs,
  columnTitle,
  contractColumns,
  contractPages,
  expect,
  headingOf,
  openContext,
  openPage,
  pageOf,
  pagesInColumn,
  routePages,
  test,
  walkColumn,
  type ContractPage,
} from './contract.ts';
import type { Locale } from './global-setup.ts';
import { PREFS_STORAGE_KEY } from './views.ts';

/** The pages the sidebar of the QA instance links to, with the title of each. */
const NAV_PAGES = [
  ['overview', 'route.overview.title', '/overview'],
  ['sessions', 'route.sessions.title', '/sessions'],
  ['activity', 'route.activity.title', '/activity'],
  ['tasks', 'route.tasks.title', '/tasks'],
  ['analytics', 'route.analytics.title', '/analytics'],
  ['search', 'route.search.title', '/search'],
  ['settings-health', 'route.settings.title', '/settings'],
] as const;

/**
 * Catalogue texts of two words or more that read differently in the two languages and have no placeholder: seeing one on a Vietnamese
 * page is a defect. A single word is left out on purpose: tool names, column names of a workspace panel and the like come from the
 * data and may equal a catalogue word ("Task", "Status").
 */
function englishOnlyTexts(): Set<string> {
  const texts = new Set<string>();
  const vi = viMessages as Readonly<Record<string, string>>;
  for (const [key, value] of Object.entries(enMessages)) {
    const other = vi[key];
    if (other === undefined || other === value || value.includes('{') || !value.includes(' ')) continue;
    texts.add(value);
  }
  // A text that both languages spell the same way in another key is not a defect.
  for (const value of Object.values(viMessages)) texts.delete(value);
  return texts;
}

/** Drops the terminal that was selected last from the stored preferences before a page starts; everything else stays. */
const FORGET_LAST_TERMINAL = `try {
  const raw = globalThis.localStorage.getItem('${PREFS_STORAGE_KEY}');
  if (raw !== null) {
    const data = JSON.parse(raw);
    delete data.lastTerminal;
    globalThis.localStorage.setItem('${PREFS_STORAGE_KEY}', JSON.stringify(data));
  }
} catch (error) { void error; }`;

/** The visible text of every leaf element of the page, trimmed, without the hidden parts. */
async function leafTexts(page: Page): Promise<string[]> {
  const raw: unknown = await page.evaluate(`(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.nodeValue || '').trim();
      if (text === '') continue;
      const el = node.parentElement;
      if (!el || el.closest('script, style, [hidden], [inert]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push(text);
    }
    return out;
  })()`);
  return raw as string[];
}

/** The English catalogue texts a Vietnamese page still shows. */
async function englishLeftOn(page: Page, english: ReadonlySet<string>): Promise<string[]> {
  return [...new Set((await leafTexts(page)).filter((text) => english.has(text)))];
}

/**
 * Opens the preferences menu and picks a language. The menu is closed afterwards. A language is listed under its own name, which
 * the browser supplies, so the entry is found by the language of its label and not by a text.
 */
async function chooseLanguage(page: Page, from: Locale, to: Locale): Promise<void> {
  await page.getByRole('button', { name: msg('menu.trigger', undefined, from) }).click();
  const menu = page.getByRole('menu', { name: msg('menu.trigger', undefined, from) });
  await expect(menu).toBeVisible();
  const item = menu.getByRole('menuitemradio').filter({ has: page.locator(`span[lang="${to}"]`) });
  await expect(item).toHaveCount(1);
  await item.click();
  await expect(page.locator('html')).toHaveAttribute('lang', to);
  // the menu stays open and is named in the new language now
  const renamed = page.getByRole('menu', { name: msg('menu.trigger', undefined, to) });
  const chosen = renamed.getByRole('menuitemradio').filter({ has: page.locator(`span[lang="${to}"]`) });
  await expect(chosen).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(renamed).toBeHidden();
}

/** What a Vietnamese page must show of the frame, whatever its content; the problems are returned. */
async function vietnameseFrameProblems(page: Page, spec: ContractPage): Promise<string[]> {
  const problems: string[] = [];
  const lang = await page.locator('html').getAttribute('lang');
  if (lang !== 'vi') problems.push(`<html lang> is ${String(lang)}`);
  const heading = headingOf(spec, 'vi');
  if (heading !== null) {
    const shown = (await page.locator('main h1').first().textContent()) ?? '';
    if (shown.trim() !== heading) problems.push(`the heading reads "${shown.trim()}"`);
  }
  const sidebar = page.getByRole('complementary', { name: msg('shell.sidebar.label', undefined, 'vi') });
  if ((await sidebar.getByRole('navigation', { name: msg('nav.label', undefined, 'vi') }).count()) !== 1) {
    problems.push('the navigation has no Vietnamese name');
  }
  if ((await page.getByRole('link', { name: msg('shell.skip.main', undefined, 'vi') }).count()) !== 1) {
    problems.push('the skip link has no Vietnamese name');
  }
  return problems;
}

test.describe('the language switch', () => {
  test('switches to Vietnamese from the menu, follows the navigation, survives a reload and switches back', async ({
    browser,
    qa,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    try {
      const { page } = await openPage(context, qa, pageOf('overview'), 'en');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('main h1').first()).toHaveText(msg('route.overview.title'));

      await chooseLanguage(page, 'en', 'vi');
      await expect(page.locator('main h1').first()).toHaveText(msg('route.overview.title', undefined, 'vi'));

      // Client-side navigation: every entry of the sidebar, named in Vietnamese, leads to a page headed in Vietnamese.
      const nav = page.getByRole('navigation', { name: msg('nav.label', undefined, 'vi') });
      await expect(nav, 'the navigation is named in Vietnamese').toBeVisible();
      for (const [, key, path] of NAV_PAGES.slice(1)) {
        await nav.locator(`a[href="${path}"]`).click();
        await expect(page).toHaveURL(new RegExp(`${path}([?#].*)?$`));
        await expect(page.locator('main h1').first()).toHaveText(msg(key, undefined, 'vi'));
        await expect(nav.locator(`a[href="${path}"] .sidebar-nav__label`)).toHaveText(msg(key, undefined, 'vi'));
        await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
      await expect(page.locator('main h1').first()).toHaveText(msg('route.settings.title', undefined, 'vi'));

      await chooseLanguage(page, 'vi', 'en');
      await expect(page.locator('main h1').first()).toHaveText(msg('route.settings.title'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('main h1').first()).toHaveText(msg('route.settings.title'));
    } finally {
      await context.close();
    }
  });

  test('the choice holds on every page, and no English text of the catalogue is left', async ({ browser, qa }) => {
    test.setTimeout(columnTimeoutMs(contractPages().length));
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'en', preset: false });
    const problems: string[] = [];
    try {
      const home = await openPage(context, qa, pageOf('overview'), 'en');
      await chooseLanguage(home.page, 'en', 'vi');
      await home.page.close();
      // The pages share the stored preferences, and the choice must stay as the menu stored it. One other preference would
      // change what a page shows: the terminal that was selected last is restored by the bare address of the Workspace.
      await context.addInitScript(FORGET_LAST_TERMINAL);
      const english = englishOnlyTexts();
      for (const spec of contractPages()) {
        // A full load of a page in a new tab: the stored choice, not the state of an open page, decides.
        const { page } = await openPage(context, qa, spec, 'vi');
        try {
          for (const problem of await vietnameseFrameProblems(page, spec)) problems.push(`${spec.id}: ${problem}`);
          const left = await englishLeftOn(page, english);
          if (left.length > 0) {
            problems.push(`${spec.id}: English text on a Vietnamese page: ${left.slice(0, 4).join(' | ')}`);
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

  test('a browser that asks for Vietnamese gets it without a choice, and one that asks for English gets English', async ({
    browser,
    qa,
  }) => {
    for (const locale of ['vi', 'en'] as const) {
      const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale, preset: false });
      try {
        const { page } = await openPage(context, qa, pageOf('sessions'), locale);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('main h1').first()).toHaveText(msg('route.sessions.title', undefined, locale));
      } finally {
        await context.close();
      }
    }
  });

  test('the chrome of the pages reads differently in the two languages', async ({ browser, qa }) => {
    const problems: string[] = [];
    const headings = new Map<string, string[]>();
    const pages = routePages().filter((candidate) => NAV_PAGES.some(([id]) => id === candidate.id));
    expect(pages).toHaveLength(NAV_PAGES.length);
    for (const locale of ['en', 'vi'] as const) {
      const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale });
      try {
        for (const spec of pages) {
          const { page } = await openPage(context, qa, spec, locale);
          try {
            const texts = await page.locator('main h1, main h2').allInnerTexts();
            if (texts.length === 0) problems.push(`${spec.id}: no heading in ${locale}`);
            if (locale === 'en') headings.set(spec.id, texts);
            else if (JSON.stringify(headings.get(spec.id)) === JSON.stringify(texts)) {
              problems.push(`${spec.id}: the headings are the same in both languages (${texts.join(' | ')})`);
            }
          } finally {
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
    expect(problems).toEqual([]);
  });
});

for (const column of contractColumns('vi')) {
  const pages = pagesInColumn(column);
  test(`${columnTitle(column)}: every Vietnamese page keeps the layout contract`, async ({ browser, qa }) => {
    test.setTimeout(columnTimeoutMs(pages.length));
    const problems = await walkColumn(browser, qa, column);
    expect(problems, `layout problems at ${columnTitle(column)}`).toEqual([]);
  });
}

// ---- the checks themselves --------------------------------------------------------------------------------------------------

test.describe('negative probes', () => {
  test('the catalogues differ in most texts, so an English text on a Vietnamese page can be told', () => {
    const english = englishOnlyTexts();
    expect(english.size).toBeGreaterThan(200);
    expect(english.has(msg('workspace.pane.none.title'))).toBe(true);
    expect(english.has(msg('workspace.pane.none.title', undefined, 'vi'))).toBe(false);
    // a single word is never judged
    expect([...english].every((text) => text.includes(' '))).toBe(true);
  });

  test('an English catalogue text on a page is reported, and the same page in Vietnamese is not', async ({
    browser,
  }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'vi', preset: false });
    try {
      const page = await context.newPage();
      const english = englishOnlyTexts();
      const html = (locale: Locale): string =>
        `<!doctype html><main><h1>${msg('route.sessions.title', undefined, locale)}</h1>
          <p>${msg('workspace.pane.none.title', undefined, locale)}</p>
          <p hidden>${msg('workspace.pane.none.body')}</p></main>`;
      await page.setContent(html('en'));
      expect(await englishLeftOn(page, english)).toEqual([msg('workspace.pane.none.title')]);
      await page.setContent(html('vi'));
      expect(await englishLeftOn(page, english)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('a page that ignores the stored language is reported', async ({ browser }) => {
    const context = await openContext(browser, { viewport: DESKTOP, theme: 'light', locale: 'vi', preset: false });
    try {
      const page = await context.newPage();
      const spec = pageOf('sessions');
      await page.setContent(
        `<!doctype html><html lang="en"><body><main><h1>${msg('route.sessions.title')}</h1></main></body></html>`,
      );
      const found = (await vietnameseFrameProblems(page, spec)).join('; ');
      expect(found).toContain('<html lang> is en');
      expect(found).toContain('the heading reads');
      expect(found).toContain('the navigation has no Vietnamese name');
      expect(found).toContain('the skip link has no Vietnamese name');
    } finally {
      await context.close();
    }
  });
});
