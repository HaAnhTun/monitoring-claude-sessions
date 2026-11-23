// The Workspace scenarios that the acceptance flow does not reach (design 04 section 12.4: W2, W9, W10, W11, W13, W16, W18,
// W19, W20), on the same fixture: a real instance, the fake claude behind a real pseudo console, the built app in Chrome. Every
// scenario starts from an instance without live sessions and brings its own browser; the fixture holds each of them to zero
// console errors, uncaught errors and CSP violations. Labels and the screen are read through `dom.ts` only.
import { removeRegistryEntry, scaled, writeRegistryEntry } from '@mcs/testkit';

import {
  addressHasFragment,
  clipped,
  expectLive,
  expectOnScreen,
  expectRowCount,
  fittedSize,
  focusPlace,
  focusTerminal,
  openSession,
  pageOverflows,
  pasteAnswer,
  rowsStartingWith,
  signIn,
  terminalInput,
  terminalSize,
  typeLine,
  waitForRow,
  workspace,
} from '../dom.ts';
import { SESSION_ELSEWHERE, SESSION_RESUMABLE, expect, test } from '../fixture.ts';
import {
  endAllSessions,
  liveSessionNames,
  openTerminal,
  proxySockets,
  stubExchange,
  stubOutdated,
} from '../workspace-helpers.ts';

test.use({ appPurpose: 'e2e-workspace' });

const TAB = 0x09;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The session the address of the page selects; '' for none. */
function selectedSession(url: string): string {
  return new URL(url).searchParams.get('session') ?? '';
}

test.beforeEach(async ({ app }) => {
  await endAllSessions(app);
});

test('TC-E2E-W2 the locked state: the paste field, a browser that keeps no cookie, Lock terminals, a locked transcript', async ({
  app,
  watch,
}) => {
  const { instance, origin, world } = app;
  const page = await watch.page();
  const sockets = await proxySockets(page);
  const ui = workspace(page);
  const exchangesSent = (): number =>
    watch.requests().filter((request) => request.pathname === '/api/v3/auth/exchange').length;

  await test.step('without the cookie the pane asks for the access link and the project column is absent', async () => {
    await page.goto(`${origin}/`);
    await expect(ui.locked.title).toBeVisible();
    expect(await ui.paneKind()).toBe('locked');
    await expect(ui.sidebar).toHaveCount(0);
    await expect(ui.locked.submit).toBeDisabled();
  });

  await test.step('a text that is neither a link nor a code sends nothing and says so', async () => {
    await ui.locked.paste('FIXTURE neither a link nor a code');
    await expect(ui.locked.message).toHaveText(ui.locked.formatError);
    expect(exchangesSent()).toBe(0);
  });

  await test.step('a browser that does not keep the cookie is told so', async () => {
    const unstub = await stubExchange(page);
    await ui.locked.paste(await instance.accessUrl());
    await expect(ui.locked.message).toHaveText(ui.locked.cookieError);
    await expect(ui.locked.title).toBeVisible();
    await expect(ui.locked.field).toHaveValue('');
    await unstub();
  });

  const link = await instance.accessUrl();
  await test.step('the right link unlocks', async () => {
    await ui.locked.paste(link);
    await expect(ui.sidebar).toBeVisible();
    await expect(ui.locked.title).toHaveCount(0);
    expect(addressHasFragment(page)).toBe(false);
    expect((await page.context().cookies()).length).toBe(1);
  });

  const session = (await instance.createSession(world.folders.alpha)).name;
  await test.step('"Lock terminals" locks the page again and the server closes the socket as signed out', async () => {
    // known defect, held strictly by the next test: the server cuts the terminal-events stream of the page in mid-answer
    watch.allowCutStream('/api/v3/terminal/events');
    await ui.folder('FIXTURE-alpha').open();
    await ui.session(session).click();
    await expectLive(page, session);
    await ui.menu.open();
    await ui.menu.lock.click();
    await expect(ui.locked.title).toBeVisible();
    await expect(ui.sidebar).toHaveCount(0);
    await expect.poll(() => sockets.serverCloses(), 'the close codes the server sent').toEqual([4003]);
    expect((await page.context().cookies()).length, 'cookies after the lock').toBe(0);
    expect(await liveSessionNames(app), 'the lock ends the browser session, not the process').toEqual([session]);
  });

  await test.step('the link that was used once is refused', async () => {
    watch.allowFailedLoad('/api/v3/auth/exchange', 401);
    await ui.locked.paste(link);
    await expect(ui.locked.message).toHaveText(ui.locked.usedError);
    await expect(ui.locked.title).toBeVisible();
  });

  await test.step('a transcript read of a locked browser says "Access link needed"', async () => {
    watch.allowFailedLoad(/^\/api\/v3\/sessions\/[^/]+\//, 401);
    await page.goto(`${origin}/sessions/${SESSION_RESUMABLE}`);
    await expect(ui.lockedRead.first()).toBeVisible();
    await expect(ui.resumeInTerminal).toHaveCount(0);
  });
});

test('TC-E2E-W2 "Lock terminals" writes no error to the console', async ({ app, watch }) => {
  test.fail(
    true,
    'product defect: on logout the server destroys the terminal-events stream while the page still holds it; Chrome logs net::ERR_INCOMPLETE_CHUNKED_ENCODING',
  );
  const { page } = await openTerminal(app, watch, app.world.folders.alpha);
  const ui = workspace(page);
  await ui.menu.open();
  await ui.menu.lock.click();
  await expect(ui.locked.title).toBeVisible();
  // the stream of a locked page has ended by the time the page can read nothing of the session any more
  await expect
    .poll(() => watch.streams(page).eventSources, 'the streams the locked page still holds')
    .toEqual(['/api/v3/stream']);
  expect(watch.problems(), 'errors the lock wrote to the console').toEqual([]);
});

test('TC-E2E-W9 /exit and /crash end the view with a banner, the last output and a way to start again', async ({
  app,
  watch,
}) => {
  const { instance, world } = app;
  const { page, session } = await openTerminal(app, watch, world.folders.alpha);
  const ui = workspace(page);

  await typeLine(page, 'last words');
  await waitForRow(page, 'ECHO:last words');
  await typeLine(page, '/exit');
  await expect(ui.ended.banner).toBeVisible();
  await expect(ui.ended.exitCode(0)).toBeVisible();
  await expectRowCount(page, 'BYE:0', 1);
  await expectRowCount(page, 'ECHO:last words', 1);
  await expect(ui.session(session), 'the ended session leaves the list').toHaveCount(0);
  await expect(ui.stop).toHaveCount(0);
  await expect(ui.heading).toHaveText(session);
  expect(await liveSessionNames(app)).toEqual([]);

  await ui.ended.startAgain.click();
  await expect(ui.dialogs.newSession.root).toContainText(world.folders.alpha);
  await ui.dialogs.newSession.confirm.click();
  await expect.poll(() => selectedSession(page.url()), 'the new session is selected').not.toBe(session);
  const next = selectedSession(page.url());
  await expectLive(page, next);
  await expect(ui.ended.banner).toHaveCount(0);
  expect(await liveSessionNames(app)).toEqual([next]);

  await focusTerminal(page);
  await typeLine(page, '/crash');
  await expect(ui.ended.banner).toBeVisible();
  await expect(ui.ended.exitCode(3)).toBeVisible();
  await expectRowCount(page, 'CRASH', 1);
  await expect(ui.session(next)).toHaveCount(0);
  expect(instance.fakeLog().exitCodes().slice(-2)).toEqual([0, 3]);
});

test('TC-E2E-W10 a lost connection reconnects to the same screen; a restart of the app ends the view', async ({
  launch,
  watch,
}) => {
  const own = await launch('e2e-w10');
  const page = await watch.page();
  const sockets = await proxySockets(page);
  const ui = workspace(page);
  await signIn(page, await own.instance.accessUrl());
  const session = (await own.instance.createSession(own.world.folders.alpha)).name;
  await openSession(page, own.origin, session);
  await focusTerminal(page);
  await typeLine(page, 'before the drop');
  await waitForRow(page, 'ECHO:before the drop');

  await test.step('the connection drops: "Reconnecting", then live again without a repeated line', async () => {
    sockets.hold();
    await sockets.drop();
    await expect(ui.statusLine).toContainText(ui.status.reconnecting);
    await expect.poll(() => sockets.opened(), 'the page opened a second socket').toBe(2);
    sockets.release();
    await expectLive(page, session);
    await expect(ui.liveRegion).toHaveText(ui.status.reconnected(session));
    await expectRowCount(page, 'ECHO:before the drop', 1);
    expect((await rowsStartingWith(page, 'Claude Code (fake)')).length).toBe(1);
    await focusTerminal(page);
    await typeLine(page, 'after the drop');
    await expectRowCount(page, 'ECHO:after the drop', 1);
    expect(own.instance.fakeLog().count('start'), 'the process was not started again').toBe(1);
  });

  await test.step('the app restarts: the session is gone and the view ends instead of reconnecting forever', async () => {
    watch.allowLostConnection();
    watch.allowFailedLoad(/^\/api\/v3\//, 401);
    await own.instance.restart();
    await expect(ui.locked.title).toBeVisible({ timeout: scaled(10_000) });
    await expect(ui.statusLine).toHaveCount(0);
    expect(await liveSessionNames(own)).toEqual([]);
  });
});

test('TC-E2E-W11 the keyboard: skip links, arrows in the list, t, Tab for the program, the way out, single keys', async ({
  app,
  watch,
}) => {
  const { instance, world } = app;
  const { page, session } = await openTerminal(app, watch, world.folders.alpha);
  const ui = workspace(page);
  const row = `session:${session}`;

  await test.step('Ctrl+Shift+Space leaves the terminal for the row of the session', async () => {
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Control+Shift+Space');
    await expect.poll(async () => (await focusPlace(page)).navId).toBe(row);
  });

  await test.step('arrows, Home and End move through the list', async () => {
    await page.keyboard.press('Home');
    const first = await focusPlace(page);
    expect(first.navId).toMatch(/^folder:/);
    await page.keyboard.press('ArrowDown');
    const second = await focusPlace(page);
    expect(second.navId).not.toBeNull();
    expect(second.navId).not.toBe(first.navId);
    await page.keyboard.press('ArrowUp');
    expect((await focusPlace(page)).navId).toBe(first.navId);
    await page.keyboard.press('End');
    expect((await focusPlace(page)).navId).toBe('other-folder');
  });

  await test.step('outside the terminal "/" goes to the filter and "t" to the terminal', async () => {
    await page.keyboard.press('/');
    await expect(ui.filter).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await ui.session(session).focus();
    await page.keyboard.press('t');
    await expect(terminalInput(page)).toBeFocused();
  });

  await test.step('inside the terminal Tab and the single keys belong to the program', async () => {
    const tabs = (): number =>
      instance
        .fakeLog()
        .stdin()
        .filter((byte) => byte === TAB).length;
    const before = tabs();
    await page.keyboard.press('Tab');
    await waitForRow(page, 'TAB');
    await expect(terminalInput(page), 'Tab keeps the focus in the terminal').toBeFocused();
    await expect.poll(tabs).toBe(before + 1);
    await page.keyboard.press('Enter');

    await typeLine(page, 'f?/');
    await waitForRow(page, 'ECHO:f?/');
    await expect(terminalInput(page)).toBeFocused();
    await expect(ui.dialogs.any, 'no shortcut dialog opened').toHaveCount(0);
    await expect(ui.filter).toHaveValue('');
  });

  await test.step('the skip links lead to the project list and to the terminal', async () => {
    await ui.skip.projects.focus();
    await page.keyboard.press('Enter');
    expect((await focusPlace(page)).id).toBe('project-list');
    await ui.skip.terminal.focus();
    await page.keyboard.press('Enter');
    await expect(terminalInput(page)).toBeFocused();
    expect(selectedSession(page.url()), 'a skip link changes no address').toBe(session);
  });
});

test('TC-E2E-W13 from 1440 to 600 px: at least 80 columns, no sideways scroll, the project list an overlay below 1024 px', async ({
  app,
  watch,
}) => {
  const { instance, world } = app;
  const { page, session: one } = await openTerminal(app, watch, world.folders.alpha, { width: 1440, height: 900 });
  const two = (await instance.createSession(world.folders.beta)).name;
  const ui = workspace(page);
  let shown = one;

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 900, height: 700 },
    { width: 600, height: 800 },
  ]) {
    await test.step(`${String(viewport.width)} x ${String(viewport.height)}`, async () => {
      await page.setViewportSize(viewport);
      const size = await fittedSize(page);
      expect(size.cols, 'columns of the terminal').toBeGreaterThanOrEqual(80);
      expect(await pageOverflows(page), 'the page scrolls sideways').toBe(false);

      if (viewport.width >= 1024) {
        await expect(ui.sidebar).toBeVisible();
        await expect(ui.overlay).toHaveCount(0);
        return;
      }
      await expect(ui.sidebar).toBeHidden();
      const other = shown === one ? two : one;
      await ui.listToggle.click();
      await expect(ui.overlay).toBeVisible();
      await ui.session(other).click();
      await expect(ui.overlay, 'a selection closes the overlay').toHaveCount(0);
      await expectLive(page, other);
      await expect(terminalInput(page), 'the selected terminal has the focus').toBeFocused();
      shown = other;
      expect((await fittedSize(page)).cols).toBeGreaterThanOrEqual(80);

      await ui.listToggle.click();
      await expect(ui.overlay).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(ui.overlay, 'Escape closes the overlay').toHaveCount(0);
      await expect(ui.listToggle).toBeFocused();
      expect(await pageOverflows(page)).toBe(false);
    });
  }
});

test('TC-E2E-W16 Vietnamese at 1024 px: the column, the pane header, the dialogs and the status line do not clip', async ({
  app,
  watch,
}) => {
  const { instance, origin, world } = app;
  const page = await watch.page({ viewport: { width: 1024, height: 768 }, prefs: { locale: 'vi' } });
  const sockets = await proxySockets(page);
  const ui = workspace(page, 'vi');
  await signIn(page, await instance.accessUrl(), 'vi');
  const session = (await instance.createSession(world.folders.alpha)).name;
  await openSession(page, origin, session, 'vi');

  const column =
    '.workspace-sidebar__heading, .workspace-sidebar .btn, .workspace-folder__live, .workspace-folder__time, ' +
    '.workspace-legend__item, .workspace-sidebar__note';
  const header = '.workspace-header__actions .btn, .workspace-header__name, .workspace-header__facts > *';
  const dialog = 'dialog[open] .dialog__head, dialog[open] .dialog__foot .btn, dialog[open] .dialog__body > p';
  const status = '.terminal-bar, .terminal-status, .terminal-hint';

  /** Nothing of `selector` is cut by its own box; the check must have looked at `atLeast` elements to count. */
  const nothingClipped = async (what: string, selector: string, atLeast: number): Promise<void> => {
    const report = await clipped(page, selector);
    expect(report.looked, `elements looked at in ${what}`).toBeGreaterThanOrEqual(atLeast);
    expect(report.clipped, `clipped in ${what}`).toEqual([]);
  };

  expect(await pageOverflows(page)).toBe(false);
  await nothingClipped('the project column', column, 8);
  await nothingClipped('the pane header', header, 4);
  await nothingClipped('the status bar', status, 3);

  await ui.folder('FIXTURE-alpha').newSession.click();
  await expect(ui.dialogs.newSession.root).toBeVisible();
  await nothingClipped('the new session dialog', dialog, 4);
  await ui.dialogs.newSession.cancel.click();
  await ui.stop.click();
  await expect(ui.dialogs.stop.root).toBeVisible();
  await nothingClipped('the stop dialog', dialog, 4);
  await ui.dialogs.stop.cancel.click();

  // the longest sentence of the status line: the lost connection
  sockets.hold();
  await sockets.drop();
  await expect(ui.statusLine).toContainText(ui.status.reconnecting);
  await nothingClipped('the status bar while reconnecting', status, 3);
  expect(await pageOverflows(page)).toBe(false);
  sockets.release();
  await expectLive(page, session, 'vi');
});

test('TC-E2E-W18 the update notice names the running terminals and its button copies the forced restart command', async ({
  app,
  watch,
}) => {
  const { instance, origin, world } = app;
  const one = (await instance.createSession(world.folders.alpha)).name;
  await instance.createSession(world.folders.beta);
  const described = (await instance.api().get('/api/v3/instance')).json;
  const commands = isRecord(described) && isRecord(described['commands']) ? described['commands'] : {};
  const restart = typeof commands['restart'] === 'string' ? commands['restart'] : '';
  expect(restart, 'the restart command the instance names').not.toBe('');
  const forced = `${restart} --force`;

  const page = await watch.page();
  await stubOutdated(page);
  const ui = workspace(page);
  await signIn(page, await instance.accessUrl());
  await openSession(page, origin, one);

  const notice = ui.outdated.notice.filter({ hasText: forced });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(ui.outdated.terminals(2));
  await ui.outdated.copy.click();
  await expect(ui.outdated.copy).toHaveText(ui.outdated.copied);
  // read back through the program: it answers with the length and the hash of what the paste delivered
  await focusTerminal(page);
  await page.keyboard.press('Control+V');
  await waitForRow(page, pasteAnswer(forced));
});

test('TC-E2E-W19 two windows on one session: the size follows the window that acts, and both share one event stream', async ({
  app,
  watch,
}) => {
  const { instance, origin, world } = app;
  const { page: a, session } = await openTerminal(app, watch, world.folders.alpha, { width: 1440, height: 900 });
  const uiA = workspace(a);
  const sizeA = await fittedSize(a);
  const monitor = '/api/v3/stream';
  const events = '/api/v3/terminal/events';
  const eventsAsked = (): number =>
    watch.requests().filter((request) => request.kind === 'eventsource' && request.pathname === events).length;
  // the first window holds the one terminal-events stream of the browser before the second window exists
  await expect
    .poll(() => [...watch.streams(a).eventSources].sort(), 'the streams of the first window')
    .toEqual([monitor, events]);
  const askedByFirst = eventsAsked();
  const b = await watch.sibling(a);
  await b.setViewportSize({ width: 1100, height: 700 });
  const uiB = workspace(b);

  await test.step('the window that joins takes the size, the first one mirrors it and says so', async () => {
    await openSession(b, origin, session);
    const sizeB = await fittedSize(b);
    expect(sizeB).not.toEqual(sizeA);
    await expect(uiA.statusLine).toHaveText(uiA.status.sizeOther(sizeB.cols, sizeB.rows));
    await expect.poll(() => terminalSize(a)).toEqual(sizeB);
  });

  await test.step('"Use this window\'s size" in the first window turns it around', async () => {
    await expect(uiA.statusAction).toHaveText(uiA.status.sizeUse);
    await uiA.statusAction.click();
    await expect(uiA.statusLine).toHaveText('');
    await expect.poll(() => fittedSize(a)).toEqual(sizeA);
    await expect(uiB.statusLine).toHaveText(uiB.status.sizeOther(sizeA.cols, sizeA.rows));
    await expect.poll(() => terminalSize(b)).toEqual(sizeA);
  });

  await test.step('a resize of the owning window is mirrored in the other', async () => {
    await a.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await fittedSize(a)).cols, 'the first window takes a new size').not.toBe(sizeA.cols);
    const resized = await fittedSize(a);
    await expect(uiB.statusLine).toHaveText(uiB.status.sizeOther(resized.cols, resized.rows));
    await expect.poll(() => terminalSize(b)).toEqual(resized);
  });

  await test.step('typing in the other window takes the size back', async () => {
    await focusTerminal(b);
    await typeLine(b, 'mine now');
    await waitForRow(b, 'ECHO:mine now');
    await expect(uiB.statusLine).toHaveText('');
    const sizeB = await fittedSize(b);
    await expect(uiA.statusLine).toHaveText(uiA.status.sizeOther(sizeB.cols, sizeB.rows));
    await expect(async () => {
      await typeLine(b, '/size');
      await expect
        .poll(async () => (await rowsStartingWith(b, 'SIZE:')).at(-1), { timeout: 3000 })
        .toBe(`SIZE:${String(sizeB.cols)}x${String(sizeB.rows)}`);
    }, 'the program has the size of the window that typed').toPass();
  });

  await test.step('the two windows share ONE terminal-events stream, and both lists stay current', async () => {
    expect(eventsAsked(), 'the second window asked for no terminal-events stream of its own').toBe(askedByFirst);
    expect([...watch.streams(a).eventSources].sort(), 'the streams of the first window').toEqual([monitor, events]);
    expect(watch.streams(b).eventSources, 'the streams of the second window').toEqual([monitor]);
    const added = (await instance.createSession(world.folders.beta)).name;
    await expect(uiA.session(added)).toBeVisible();
    await expect(uiB.session(added)).toBeVisible();
  });
});

test('TC-E2E-W20 recent sessions: Resume under the folder, and a copy for a session that is open elsewhere', async ({
  app,
  watch,
}) => {
  const { instance, origin, world } = app;
  const page = await watch.page();
  const ui = workspace(page);
  await signIn(page, await instance.accessUrl());

  await test.step('a monitored session of a folder is listed under it with Resume', async () => {
    const beta = ui.folder('FIXTURE-beta');
    await beta.open();
    await expect(beta.recentRows).toHaveCount(1);
    await expect(beta.recentRows.first()).toContainText(world.labels.resumable);
    await beta.resume(SESSION_RESUMABLE).click();
    await expect(ui.dialogs.resume.root).toContainText(world.folders.beta);
    await expect(ui.dialogs.resume.confirm).toBeEnabled();
    await ui.dialogs.resume.cancel.click();
    await expect(ui.dialogs.any).toHaveCount(0);
  });

  await test.step('a session that another program has open offers "Resume a copy", which forks it', async () => {
    // the registry of Claude says that a live process (this test process, which is no terminal of the app) holds the session
    writeRegistryEntry(instance.paths.claudeHome, {
      pid: process.pid,
      sessionId: SESSION_ELSEWHERE,
      status: 'idle',
      cwd: world.folders.gamma,
      startedAt: Date.now() - 60_000,
    });
    try {
      const api = instance.api(await instance.cookie());
      await expect
        .poll(
          async () => {
            const answer = (await api.get(`/api/v3/sessions/${SESSION_ELSEWHERE}/resume`)).json;
            return isRecord(answer) ? answer['liveElsewhere'] : null;
          },
          { message: 'the server sees the session open elsewhere', timeout: scaled(30_000) },
        )
        .toBe(true);
      const gamma = ui.folder('FIXTURE-gamma');
      await gamma.open();
      await expect(gamma.recentRows.first()).toContainText(world.labels.elsewhere);
      await gamma.resume(SESSION_ELSEWHERE).click();
      await expect(ui.dialogs.resumeCopy.root).toContainText(ui.dialogs.resumeElsewhere);
      await expect(ui.dialogs.resume.confirm, 'a plain resume is not offered').toHaveCount(0);
      await ui.dialogs.resumeCopy.confirm.click();
      await expect.poll(() => selectedSession(page.url())).not.toBe('');
      const copy = selectedSession(page.url());
      await expectLive(page, copy);
      await focusTerminal(page);
      await typeLine(page, '/args');
      await expectOnScreen(page, `ARGS:${JSON.stringify(['--resume', SESSION_ELSEWHERE, '--fork-session'])}`);
      await typeLine(page, '/cwd');
      await expectOnScreen(page, `CWD:${world.folders.gamma}`);
      expect(page.url().startsWith(origin)).toBe(true);
    } finally {
      removeRegistryEntry(instance.paths.claudeHome, process.pid);
    }
  });
});
