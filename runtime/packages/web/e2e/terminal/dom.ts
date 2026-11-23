// The one file of the terminal browser tests that reads the screen and spells labels (design 08 section 3.8).
//
// Reading the screen. A test page stores the terminal preference "renderer: dom" (`fixture.ts`), so xterm draws its rows as
// elements: the text of the screen is the text of `.xterm-rows`, one element per row, and the size of the terminal is
// `data-cols` and `data-rows` of the host `[data-terminal]`. Only what is on the screen now can be read: the history that scrolled
// away has no elements. If the default renderer (the graphics card, where a browser has WebGL2) ever has to be read, this is the
// file that changes.
//
// Labels. Every word a person reads comes from the catalogues of the app (`translator`), in the language the caller names: a wording change in a catalogue never touches a spec, and a spec contains no label. A row, a folder or
// a dialog is found by its role and its accessible name where it has one, by the `data-` attribute the app gives it otherwise.
import { createHash } from 'node:crypto';

import { expect, type Locator, type Page } from '@playwright/test';

import { formatMessage } from '../../src/i18n/format-message.ts';
import { enMessages } from '../../src/i18n/messages/en.ts';
import { viMessages } from '../../src/i18n/messages/vi.ts';
import type { Locale, Messages, TFunction } from '../../src/i18n/types.ts';

export type { Locale };

/** `t` of one language: the text a person reads for a message of the catalogue. A missing argument throws. */
function translator(locale: Locale): TFunction {
  const source: Messages = locale === 'vi' ? viMessages : enMessages;
  return (key, ...args) => {
    const text = Object.hasOwn(source, key) ? source[key] : undefined;
    if (text === undefined) throw new Error(`the ${locale} catalogue has no message ${key}`);
    return formatMessage(text, args[0], locale);
  };
}

// ---- the screen of the terminal ----------------------------------------------------------------------------------------------------

const HOST = '[data-terminal][data-cols][data-rows]';
const ROWS = '.xterm-rows > div';
const NO_BREAK_SPACE = new RegExp(String.fromCharCode(160), 'g');

/** The host element of the open terminal. */
export function terminalHost(page: Page): Locator {
  return page.locator(HOST);
}

/** The text area xterm reads the keyboard from: the element that has the focus while a person types into the terminal. */
export function terminalInput(page: Page): Locator {
  return page.locator(`${HOST} textarea`);
}

export interface ScreenSize {
  readonly cols: number;
  readonly rows: number;
}

/** `data-cols` and `data-rows` of the host, as they are now. */
export async function terminalSize(page: Page): Promise<ScreenSize> {
  const host = terminalHost(page);
  return { cols: Number(await host.getAttribute('data-cols')), rows: Number(await host.getAttribute('data-rows')) };
}

/** The rows of the screen as the program wrote them: a blank the program printed at the end of a row is kept. */
async function writtenRows(page: Page): Promise<string[]> {
  const rows = await page.locator(ROWS).allTextContents();
  return rows.map((row) => row.replace(NO_BREAK_SPACE, ' '));
}

/** The rows of the screen, top to bottom, without the blanks at their ends. */
export async function screenRows(page: Page): Promise<string[]> {
  return (await writtenRows(page)).map((row) => row.trimEnd());
}

/**
 * The screen with its rows joined end to end. A line that the terminal wrapped is whole in it (a full row has no blanks at its
 * end), so this is where to look for an answer that may be longer than the terminal is wide.
 */
export async function screenFlat(page: Page): Promise<string> {
  return (await screenRows(page)).join('');
}

/** How many rows of the screen start with `text` (an answer of the fake claude starts at the beginning of a row). */
export async function rowsStartingWith(page: Page, text: string): Promise<string[]> {
  return (await screenRows(page)).filter((row) => row.startsWith(text));
}

/** Waits until a row of the screen starts with `text` and returns the last such row. */
export async function waitForRow(page: Page, text: string): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        found = (await rowsStartingWith(page, text)).at(-1) ?? '';
        return found;
      },
      { message: `a row of the terminal that starts with ${text}` },
    )
    .not.toBe('');
  return found;
}

/** Waits until exactly `count` rows of the screen start with `text`. */
export async function expectRowCount(page: Page, text: string, count: number): Promise<void> {
  await expect
    .poll(async () => (await rowsStartingWith(page, text)).length, {
      message: `rows of the terminal that start with ${text}`,
    })
    .toBe(count);
}

/** Waits until the joined screen contains `text`. */
export async function expectOnScreen(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => (await screenFlat(page)).includes(text), { message: `the terminal shows ${text}` })
    .toBe(true);
}

/**
 * Whether the grid of the terminal fills its host: not larger than the host, and no room left for another column or row. The app
 * fits a terminal 100 ms after its host changed size, so a size is read only once this holds (a size from before a change of the
 * window fails one of the two bounds).
 */
const FITTED = `(() => {
  const host = document.querySelector('[data-terminal][data-cols][data-rows]');
  const screen = host ? host.querySelector('.xterm-screen') : null;
  if (!host || !screen) return false;
  const cols = Number(host.getAttribute('data-cols'));
  const rows = Number(host.getAttribute('data-rows'));
  const box = screen.getBoundingClientRect();
  if (!(cols > 0) || !(rows > 0) || !(box.width > 0) || !(box.height > 0)) return false;
  const style = getComputedStyle(host);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const spareX = host.clientWidth - box.width;
  const spareY = host.clientHeight - box.height;
  // the grid is inside the host, and what is left over is less than one more cell (plus the padding and the scroll bar)
  return spareX >= -0.5 && spareX < box.width / cols + padX + 16 && spareY >= -0.5 && spareY < box.height / rows + padY + 1;
})()`;

/** Waits until the terminal fits its host and returns its size. */
export async function fittedSize(page: Page): Promise<ScreenSize> {
  await expect.poll(() => page.evaluate(FITTED), { message: 'the terminal fits its host' }).toBe(true);
  return terminalSize(page);
}

/** Gives the keyboard to the terminal, as a click into it does. */
export async function focusTerminal(page: Page): Promise<void> {
  await terminalHost(page).click();
  await expect(terminalInput(page)).toBeFocused();
}

/** Types a line into the terminal that has the focus and sends it with Enter. */
export async function typeLine(page: Page, text: string): Promise<void> {
  await expect(terminalInput(page)).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** The box of the row of the screen at `index`, in page pixels. */
async function rowBox(page: Page, index: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(ROWS).nth(index).boundingBox();
  if (box === null) throw new Error(`row ${String(index)} of the terminal is not on the page`);
  return box;
}

/** The width of one cell of the terminal, in page pixels. */
async function cellWidth(page: Page): Promise<number> {
  const { cols } = await terminalSize(page);
  const box = await page.locator('.xterm-screen').boundingBox();
  if (box === null || !(cols > 0)) throw new Error('the terminal has no screen to measure');
  return box.width / cols;
}

const SELECTION = '.xterm-selection div';

/**
 * Selects `word` with a double click, as a person does (xterm selects the word under the pointer). The word is looked for in the
 * last row of the screen that starts with `rowStart`, and must stand between blanks there.
 */
export async function selectWord(page: Page, rowStart: string, word: string): Promise<void> {
  const rows = await screenRows(page);
  const index = rows.findLastIndex((row) => row.startsWith(rowStart) && row.includes(word));
  if (index < 0) throw new Error('the word to select is not in a row of the terminal that starts as told');
  const column = (rows[index] ?? '').indexOf(word);
  const box = await rowBox(page, index);
  const cell = await cellWidth(page);
  await page.mouse.dblclick(box.x + (column + word.length / 2) * cell, box.y + box.height / 2);
  await expect(page.locator(SELECTION).first(), 'the selection of the terminal').toBeAttached();
}

/**
 * Copies the selection of the terminal with Ctrl+C and waits until the app has cleared the selection, which it does only once the
 * text is on the clipboard (the copy is asynchronous: a paste that follows at once would read the clipboard too early).
 */
export async function copySelection(page: Page): Promise<void> {
  await expect(page.locator(SELECTION).first(), 'a selection to copy').toBeAttached();
  await page.keyboard.press('Control+C');
  await expect(page.locator(SELECTION), 'the selection is cleared after the copy').toHaveCount(0);
}

/**
 * Selects whole rows with a drag from the start of row `first` to the end of row `last` and returns the text a paste of that
 * selection delivers to the program: the rows as the program wrote them (a blank it printed at the end of a row is part of the
 * selection, the empty cells after it are not), joined by a carriage return (a terminal pastes a line break as the Enter key).
 * The row with the cursor must not be among them: the cursor draws one more blank.
 */
export async function selectRows(page: Page, first: number, last: number): Promise<string> {
  const rows = await writtenRows(page);
  const start = await rowBox(page, first);
  const end = await rowBox(page, last);
  const cell = await cellWidth(page);
  const { cols } = await terminalSize(page);
  await page.mouse.move(start.x + cell / 4, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + (cols - 0.25) * cell, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(SELECTION).first(), 'the selection of the terminal').toBeAttached();
  return rows.slice(first, last + 1).join('\r');
}

/** The answer of the fake claude to a paste of `text`: the number of its characters and the first eight hex digits of its SHA-256. */
export function pasteAnswer(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `PASTE:${String(Array.from(text).length)}:${hash}`;
}

/** The index of the last row of the screen that starts with `text`; -1 when there is none. */
export async function lastRowIndex(page: Page, text: string): Promise<number> {
  const rows = await screenRows(page);
  return rows.findLastIndex((row) => row.startsWith(text));
}

// The code that runs inside the page is text: this project is checked without the types of a browser, and a script that is text
// cannot reach anything of the test by accident. A value goes in as JSON.

/** `(<function text>)(<argument as JSON>)`: a page script with one argument. */
function call(body: string, argument: unknown): string {
  return `(${body})(${JSON.stringify(argument)})`;
}

/** The computed colour of the first cell of the screen that carries the class `xterm-fg-<index>`, or `null` when there is none. */
export function paletteColour(page: Page, index: number): Promise<string | null> {
  return page.evaluate<string | null>(
    call(
      `(cls) => {
        const cell = document.querySelector('.xterm-rows span.' + cls);
        return cell === null ? null : getComputedStyle(cell).color;
      }`,
      `xterm-fg-${String(index)}`,
    ),
  );
}

/** The computed colour of a cell of the screen that carries no colour of its own: the foreground of the terminal. */
export function defaultColour(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    const rows = document.querySelector('.xterm-rows');
    return rows === null ? null : getComputedStyle(rows).color;
  })()`);
}

// ---- the page as a whole -----------------------------------------------------------------------------------------------------------

export interface PageLook {
  /** `data-theme` of the document: the theme a person chose, `null` while it follows the system. */
  readonly theme: string | null;
  /** `lang` of the document. */
  readonly lang: string;
  /** The computed background of the body. */
  readonly background: string;
  /** What the colour token of the page background computes to, on an element that uses nothing but the token. */
  readonly token: string;
  readonly title: string;
}

/** The theme, the language and the background of the page. */
export function pageLook(page: Page): Promise<PageLook> {
  return page.evaluate<PageLook>(`(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--bg)';
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      lang: document.documentElement.lang,
      background: getComputedStyle(document.body).backgroundColor,
      token,
      title: document.title,
    };
  })()`);
}

/** Whether the document is wider than the window (a horizontal scroll bar of the page). */
export function pageOverflows(page: Page): Promise<boolean> {
  return page.evaluate<boolean>('document.documentElement.scrollWidth > document.documentElement.clientWidth');
}

export interface ClipReport {
  /** How many visible elements matched: a check that looked at nothing proves nothing. */
  readonly looked: number;
  /** Those whose content is wider than their own box, as short descriptions. */
  readonly clipped: readonly string[];
}

/** Looks at the visible elements matching `selector` for content that is wider than its box. */
export function clipped(page: Page, selector: string): Promise<ClipReport> {
  return page.evaluate<ClipReport>(
    call(
      `(selector) => {
        const visible = [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length > 0);
        return {
          looked: visible.length,
          clipped: visible
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.tagName.toLowerCase() + '.' + String(node.className).split(' ')[0]),
        };
      }`,
      selector,
    ),
  );
}

/** How many elements with one of these tag names the page holds below the elements matching `selector`. */
export function elementsWithin(page: Page, selector: string, tags: readonly string[]): Promise<number> {
  return page.evaluate<number>(
    call(
      `(args) =>
        [...document.querySelectorAll(args.selector)].reduce(
          (count, root) => count + root.querySelectorAll(args.tags.join(',')).length,
          0,
        )`,
      { selector, tags },
    ),
  );
}

/** The element that has the focus: its tag, its `data-nav-id`, its id and whether it is inside the terminal. */
export interface FocusPlace {
  readonly tag: string;
  readonly navId: string | null;
  readonly id: string;
  readonly inTerminal: boolean;
}

export function focusPlace(page: Page): Promise<FocusPlace> {
  return page.evaluate<FocusPlace>(`(() => {
    const el = document.activeElement;
    return {
      tag: el ? el.tagName.toLowerCase() : '',
      navId: el ? el.getAttribute('data-nav-id') : null,
      id: el ? el.id : '',
      inTerminal: !!el && !!el.closest('[data-terminal-region]'),
    };
  })()`);
}

// ---- the Workspace -----------------------------------------------------------------------------------------------------------------

/** One folder of the project column. */
export interface FolderDom {
  readonly root: Locator;
  /** The button that opens and closes the folder. */
  readonly head: Locator;
  /** The mark of the last activity (`data-level` is `full`, `half` or `none`). */
  readonly mark: Locator;
  /** The words a screen reader hears for a level of the mark. */
  activityWords(level: 'full' | 'half' | 'none'): Locator;
  readonly summary: Locator;
  /** "brain N · action M". */
  counts(brain: number, action: number): Locator;
  readonly newSession: Locator;
  /** The row of a live session of this folder. */
  session(name: string): Locator;
  /** The rows of the group "Recent sessions". */
  readonly recentRows: Locator;
  /** The Resume button of the recent session with this id. */
  resume(sessionId: string): Locator;
  /** Opens the folder when it is closed. */
  open(): Promise<void>;
}

/** A dialog of the Workspace: the open `<dialog>` with this title. */
export interface DialogDom {
  readonly root: Locator;
  readonly confirm: Locator;
  readonly cancel: Locator;
  /** The failure the dialog shows. */
  readonly error: Locator;
}

/** The Workspace in one language: every locator a spec needs, found by what a person reads. */
export function workspace(page: Page, locale: Locale = 'en') {
  const t = translator(locale);

  const sidebar = page.getByRole('navigation', { name: t('workspace.sidebar.label') });
  const pane = page.locator('.workspace-pane');
  const openDialog = page.locator('dialog[open]');

  const dialog = (title: string, confirm: string): DialogDom => {
    const root = openDialog.filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    return {
      root,
      confirm: root.getByRole('button', { name: confirm, exact: true }),
      cancel: root.getByRole('button', { name: t('workspace.dialog.cancel'), exact: true }),
      error: root.getByRole('alert'),
    };
  };

  const folder = (name: string): FolderDom => {
    const root = sidebar.locator('li.workspace-folder').filter({
      has: page.locator('.workspace-folder__name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });
    const head = root.locator('button.workspace-folder__head');
    return {
      root,
      head,
      mark: head.locator('.workspace-mark'),
      activityWords: (level) => head.getByText(t(`workspace.folder.activity.${level}`), { exact: true }),
      summary: root.locator('.workspace-folder__summary'),
      counts: (brain, action) => root.getByText(t('workspace.folder.counts', { brain, action }), { exact: true }),
      newSession: root.getByRole('button', { name: t('workspace.newSession'), exact: true }),
      session: (session) => root.locator(`a[data-nav-id="session:${session}"]`),
      recentRows: root.getByRole('list', { name: t('workspace.recent.title') }).getByRole('listitem'),
      resume: (sessionId) => root.locator(`button[data-nav-id="resume:${sessionId}"]`),
      open: async () => {
        if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
        await expect(head).toHaveAttribute('aria-expanded', 'true');
      },
    };
  };

  const menuTrigger = page.getByRole('button', { name: t('menu.trigger'), exact: true });
  const menu = page.getByRole('menu', { name: t('menu.trigger') });
  const openMenu = async (): Promise<void> => {
    if ((await menuTrigger.getAttribute('aria-expanded')) !== 'true') await menuTrigger.click();
    await expect(menu).toBeVisible();
  };
  const closeMenu = async (): Promise<void> => {
    if ((await menuTrigger.getAttribute('aria-expanded')) === 'true') await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  };

  return {
    /** The one heading of the page. */
    heading: page.locator('main h1'),
    sidebar,
    pane,
    /** `data-pane` of the pane: `locked`, `terminal`, `none-selected`, `not-found`, `loading`, `error` or `unavailable`. */
    paneKind: () => pane.getAttribute('data-pane'),
    folder,
    folders: sidebar.locator('li.workspace-folder'),
    /** The row of a live session, in whichever folder it is. */
    session: (name: string) => sidebar.locator(`a[data-nav-id="session:${name}"]`),
    otherFolder: sidebar.getByRole('button', { name: t('workspace.otherFolder'), exact: true }),
    filter: sidebar.getByRole('searchbox', { name: t('workspace.filter.label') }),

    // ---- the pane of an open session
    stop: pane.getByRole('button', { name: t('workspace.pane.stop'), exact: true }),
    listToggle: pane.getByRole('button', { name: t('workspace.pane.toggleList'), exact: true }).first(),
    region: (name: string) => page.getByRole('group', { name: t('terminal.region', { name }), exact: true }),
    statusLine: pane.locator('.terminal-status'),
    statusAction: pane.locator('.terminal-bar').getByRole('button'),
    /** The one live region of the page: what a screen reader was told last. */
    liveRegion: page.locator('#live-region'),
    /** The project column while it is an overlay (below 1024 px): a dialog. */
    overlay: page.getByRole('dialog', { name: t('workspace.sidebar.label'), exact: true }),
    status: {
      /** What every "connection lost" sentence starts with, with and without the countdown. */
      reconnecting: commonStart(
        t('terminal.status.reconnecting', { seconds: 1 }),
        t('terminal.status.reconnectingNow'),
      ),
      reconnected: (name: string) => t('workspace.announce.reconnected', { name }),
      sizeOther: (cols: number, rows: number) => t('workspace.pane.sizeOther', { cols, rows }),
      sizeUse: t('workspace.pane.sizeUse'),
    },
    ended: {
      banner: pane.getByRole('region', { name: t('terminal.ended.title') }),
      exitCode: (code: number) => pane.locator('.workspace-ended').getByText(t('terminal.ended.exitCode', { code })),
      startAgain: pane.getByRole('button', { name: t('terminal.ended.startAgain'), exact: true }),
    },
    noneSelected: pane.getByRole('heading', { name: t('workspace.pane.none.title'), exact: true }),

    // ---- the locked state
    locked: {
      title: pane.getByRole('heading', { name: t('access.locked.title'), exact: true }),
      field: pane.getByLabel(t('access.field.label'), { exact: true }),
      submit: pane.getByRole('button', { name: t('access.field.submit'), exact: true }),
      message: pane.locator('.workspace-locked__message'),
      /** Types a link or a code into the field and sends it. A failure never repeats the text: it may be an access code. */
      paste: async (text: string): Promise<void> => {
        const typed = await pane
          .getByLabel(t('access.field.label'), { exact: true })
          .fill(text)
          .then(
            () => true,
            () => false,
          );
        if (!typed) throw new Error('the access field could not be filled');
        await pane.getByRole('button', { name: t('access.field.submit'), exact: true }).click();
      },
      formatError: t('access.error.format'),
      usedError: t('access.error.invalid', { command: 'caw open' }),
      cookieError: t('access.error.cookie'),
    },

    // ---- dialogs
    dialogs: {
      any: openDialog,
      newSession: dialog(t('workspace.dialog.new.title'), t('workspace.dialog.new.confirm')),
      stop: dialog(t('workspace.dialog.stop.title'), t('workspace.dialog.stop.confirm')),
      resume: dialog(t('workspace.dialog.resume.title'), t('workspace.dialog.resume.confirm')),
      resumeCopy: dialog(t('workspace.dialog.resume.title'), t('workspace.dialog.resume.fork')),
      resumeElsewhere: t('workspace.dialog.resume.elsewhere'),
    },

    // ---- the menu of the top bar
    menu: {
      trigger: menuTrigger,
      open: openMenu,
      close: closeMenu,
      /** Chooses a theme; the menu stays open, as it does for a person. */
      theme: async (value: 'auto' | 'light' | 'dark'): Promise<void> => {
        await openMenu();
        const item = menu.getByRole('menuitemradio', { name: t(`menu.theme.${value}`), exact: true }).first();
        await item.click();
        await expect(item).toHaveAttribute('aria-checked', 'true');
      },
      /** Chooses a language by its own name (the menu names every language in that language). */
      language: async (value: Locale): Promise<void> => {
        await openMenu();
        const item = menu.locator('[role="menuitemradio"]').filter({ has: page.locator(`span[lang="${value}"]`) });
        await item.click();
      },
      lock: menu.getByRole('menuitem', { name: t('shell.userMenu.lock'), exact: true }),
    },

    // ---- the shell
    skip: {
      projects: page.getByRole('link', { name: t('shell.skip.projects'), exact: true }),
      terminal: page.getByRole('link', { name: t('shell.skip.terminal'), exact: true }),
    },
    outdated: {
      notice: page.getByRole('note'),
      terminals: (count: number) => t('shell.outdated.terminals', { count }),
      copy: page.getByRole('button', { name: t('shell.outdated.copy'), exact: true }),
      /** What the copy button shows once the text is on the clipboard. */
      copied: t('common.copied'),
    },
    /** The toast that says a session was started (the live region says the same words, for a screen reader). */
    startedToast: (name: string) =>
      page
        .getByRole('region', { name: t('toast.region'), exact: true })
        .getByText(t('workspace.toast.started', { name }), { exact: true }),

    // ---- the session page of the monitor
    resumeInTerminal: page.getByRole('button', { name: t('detail.resume.action'), exact: true }),
    lockedRead: page.getByText(t('error.handling.accessLocked')),
  };
}

export type WorkspaceDom = ReturnType<typeof workspace>;

// ---- two ways into the app ---------------------------------------------------------------------------------------------------------

/**
 * Opens the app with a login link (`accessUrl()` of the harness) and waits until the project column shows: the browser holds the
 * session. A failure never repeats the link: it carries the access code.
 */
export async function signIn(page: Page, loginUrl: string, locale: Locale = 'en'): Promise<void> {
  await openLoginLink(page, loginUrl);
  await expect(workspace(page, locale).sidebar, 'the project column of a signed-in browser').toBeVisible();
}

/** Loads a login link. A failure never repeats the link: it carries the access code. */
export async function openLoginLink(page: Page, loginUrl: string): Promise<void> {
  const opened = await page.goto(loginUrl).then(
    () => true,
    () => false,
  );
  if (!opened) throw new Error('the page did not load the login link');
}

/** Whether the address bar of the page shows a fragment (a login link carries the access code in one). */
export function addressHasFragment(page: Page): boolean {
  return page.url().includes('#');
}

/** Opens `/?session=<name>` in a signed-in browser and waits until the terminal of the session is live and has drawn its screen. */
export async function openSession(page: Page, origin: string, name: string, locale: Locale = 'en'): Promise<void> {
  await page.goto(`${origin}/?session=${encodeURIComponent(name)}`);
  await expectLive(page, name, locale);
}

/** Waits until the terminal of `name` is on the page, connected (no status sentence) and showing the prompt of the fake claude. */
export async function expectLive(page: Page, name: string, locale: Locale = 'en'): Promise<void> {
  const ui = workspace(page, locale);
  await expect(ui.region(name)).toBeVisible();
  await expect(terminalHost(page)).toBeVisible();
  await expect(ui.statusLine).toHaveText('');
  await expect
    .poll(async () => (await screenRows(page)).some((row) => row.startsWith('>')), {
      message: 'the prompt of the fake claude on the screen',
    })
    .toBe(true);
}

/** The text two sentences start with in common. */
function commonStart(a: string, b: string): string {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return a.slice(0, length).trimEnd();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
