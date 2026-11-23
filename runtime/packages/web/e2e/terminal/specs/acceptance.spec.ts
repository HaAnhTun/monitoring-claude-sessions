// The acceptance flow of the terminal in a real browser (design 08 section 3.8, TC-E2E-01 to 13): one serial flow on one real
// instance, from the login link to the forced stop, every phase a named step. It is deliberately thin: the unit, integration and
// workspace specs hold the detail, this one proves that the whole chain works together (the built CLI, the server, the pseudo
// console with the fake claude behind it, the built web app in Chrome under the real page policy).
//
// What the screen shows is read through `dom.ts`; what the screen cannot show is read from the log of the fake claude (which bytes
// the program really received) and from the process table (whether a process is gone).
import { scaled } from '@mcs/testkit';

import {
  addressHasFragment,
  copySelection,
  defaultColour,
  elementsWithin,
  expectLive,
  expectOnScreen,
  expectRowCount,
  fittedSize,
  focusTerminal,
  lastRowIndex,
  openLoginLink,
  openSession,
  pageLook,
  paletteColour,
  pasteAnswer,
  rowsStartingWith,
  selectRows,
  selectWord,
  signIn,
  terminalInput,
  typeLine,
  waitForRow,
  workspace,
  type ScreenSize,
} from '../dom.ts';
import { SESSION_RESUMABLE, expect, test } from '../fixture.ts';

test.use({ appPurpose: 'e2e-acceptance' });

const DESKTOP = { width: 1280, height: 800 };
const SESSION_COOKIE = /^caw_[0-9a-f]{8}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const INTERRUPT = 0x03;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a process with this pid exists (signal 0 asks without sending anything). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The relative luminance of an `rgb(r, g, b)` colour, 0 (black) to 1 (white). */
function luminance(colour: string): number {
  const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

test('TC-E2E-01..13 the terminal from the login link to the forced stop, in one browser flow', async ({
  app,
  watch,
}) => {
  const { instance, world, origin } = app;
  const api = async (): Promise<ReturnType<typeof instance.api>> => instance.api(await instance.cookie());
  const page = await watch.page({ viewport: DESKTOP });
  const ui = workspace(page);
  const first = 'FIXTURE-alpha-1';
  let firstPid = 0;

  /** The sessions the server lists, by name. */
  const liveSessions = async (): Promise<Map<string, ScreenSize>> => {
    const reply = await (await api()).get('/api/v3/terminal/state');
    const sessions = isRecord(reply.json) && Array.isArray(reply.json['sessions']) ? reply.json['sessions'] : [];
    const found = new Map<string, ScreenSize>();
    for (const session of sessions) {
      if (isRecord(session) && typeof session['name'] === 'string') {
        found.set(session['name'], { cols: Number(session['cols']), rows: Number(session['rows']) });
      }
    }
    return found;
  };
  const interruptsReceived = (): number =>
    instance
      .fakeLog()
      .stdin()
      .filter((byte) => byte === INTERRUPT).length;
  const pastesHandled = (): number =>
    instance
      .fakeLog()
      .commands()
      .filter((name) => name === 'paste').length;

  await test.step('TC-E2E-01 the login link signs the browser in, leaves no code behind and works once', async () => {
    const loginUrl = await instance.accessUrl();
    const code = loginUrl.slice(loginUrl.indexOf('#code=') + '#code='.length);
    await signIn(page, loginUrl);
    expect(addressHasFragment(page), 'the address bar still shows a fragment').toBe(false);
    expect(
      watch.requests().some((request) => request.search.includes(code) || request.pathname.includes(code)),
      'the address of a request carries the access code',
    ).toBe(false);

    const cookies = await page.context().cookies();
    expect(
      cookies.map((cookie) => ({
        named: SESSION_COOKIE.test(cookie.name),
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        path: cookie.path,
        isTheCode: cookie.value === code,
        isACredential: CREDENTIAL.test(cookie.value),
      })),
      'the one cookie of the browser',
    ).toEqual([{ named: true, httpOnly: true, sameSite: 'Strict', path: '/', isTheCode: false, isACredential: true }]);

    await page.reload();
    await expect(ui.sidebar, 'a reload stays signed in').toBeVisible();
    const exchanges = watch.requests().filter((request) => request.pathname === '/api/v3/auth/exchange');
    expect(exchanges.length, 'the code was sent once').toBe(1);

    // the same link in a browser that holds no session: the code is spent, the page is locked and says why
    watch.allowFailedLoad('/api/v3/auth/exchange', 401);
    const late = await watch.page({ viewport: DESKTOP });
    const lateUi = workspace(late);
    await openLoginLink(late, loginUrl);
    await expect(lateUi.locked.title).toBeVisible();
    await expect(lateUi.locked.message).toHaveText(lateUi.locked.usedError);
    expect(addressHasFragment(late), 'the address bar of the refused browser still shows a fragment').toBe(false);
    expect((await late.context().cookies()).length, 'the refused browser got a cookie').toBe(0);
    await watch.close(late);
  });

  await test.step('TC-E2E-02 the project column shows the folders with marks and summaries, a hostile summary as text', async () => {
    await expect(ui.noneSelected, 'no session runs yet').toBeVisible();
    const alpha = ui.folder('FIXTURE-alpha');
    await expect(alpha.mark).toHaveAttribute('data-level', 'full');
    await expect(alpha.activityWords('full')).toBeAttached();
    await alpha.open();
    await expect(alpha.summary).toHaveText(world.alphaSummary);
    await expect(alpha.counts(world.alphaCounts.brain, world.alphaCounts.action)).toBeVisible();
    await expect(ui.folder('FIXTURE-beta').head).toBeVisible();
    await expect(ui.folder('FIXTURE-gamma').head).toBeVisible();

    const hostile = ui.folder('FIXTURE-hostile');
    await expect(hostile.mark).toHaveAttribute('data-level', 'none');
    await expect(hostile.activityWords('none')).toBeAttached();
    await hostile.open();
    await expect(hostile.summary).toContainText(world.hostileMarkup);
    expect(await elementsWithin(page, '.workspace-sidebar', ['img', 'script']), 'elements made from the summary').toBe(
      0,
    );
    await expect(ui.folders).toHaveCount(4);
  });

  await test.step('TC-E2E-03 the theme and the language follow the menu', async () => {
    await ui.menu.theme('dark');
    const dark = await pageLook(page);
    expect(dark.theme).toBe('dark');
    expect(dark.background, 'the dark background is the token').toBe(dark.token);
    await ui.menu.theme('light');
    const light = await pageLook(page);
    expect(light.theme).toBe('light');
    expect(light.background, 'the light background is the token').toBe(light.token);
    expect(luminance(dark.background), 'dark is darker than light').toBeLessThan(luminance(light.background) - 0.5);

    await ui.menu.language('vi');
    const vi = workspace(page, 'vi');
    await expect(vi.sidebar).toBeVisible();
    await expect(vi.menu.trigger).toBeVisible();
    expect((await pageLook(page)).lang).toBe('vi');
    await vi.menu.language('en');
    await expect(ui.sidebar).toBeVisible();
    expect((await pageLook(page)).lang).toBe('en');
    await ui.menu.close();
  });

  await test.step('TC-E2E-04 "New session" under a folder starts a session and shows its terminal', async () => {
    const alpha = ui.folder('FIXTURE-alpha');
    await alpha.newSession.click();
    await expect(ui.dialogs.newSession.root).toContainText(world.folders.alpha);
    await ui.dialogs.newSession.confirm.click();
    await expect(ui.startedToast(first)).toBeVisible();
    await expect(page).toHaveURL(`${origin}/?session=${first}`);
    await expect(alpha.session(first)).toHaveAttribute('aria-current', 'true');
    await expect(ui.heading).toHaveText(first);
    await expectLive(page, first);
    const ready = await waitForRow(page, 'READY');
    firstPid = Number(/^READY pid=(\d+) /.exec(ready)?.[1]);
    expect(isAlive(firstPid), 'the process the banner names runs').toBe(true);
    await expect(terminalInput(page), 'the terminal has the focus after the start').toBeFocused();
    expect(instance.fakeLog().count('start')).toBe(1);
  });

  await test.step('TC-E2E-05 typed text reaches the program and its colours are drawn under the page policy', async () => {
    await typeLine(page, 'hello world');
    await waitForRow(page, 'ECHO:hello world');
    await typeLine(page, '/colors');
    await waitForRow(page, 'COLORS-DONE');
    const red = await paletteColour(page, 1);
    expect(red, 'a cell with a palette colour').not.toBeNull();
    expect(red, 'the palette colour is not the plain foreground').not.toBe(await defaultColour(page));
  });

  await test.step('TC-E2E-06 a resize of the window reaches the program', async () => {
    let previous = await fittedSize(page);
    const seenSizes = [previous];
    for (const viewport of [{ width: 900, height: 700 }, { width: 700, height: 700 }, DESKTOP]) {
      await page.setViewportSize(viewport);
      const before = previous;
      await expect
        .poll(async () => {
          const now = await fittedSize(page);
          return now.cols !== before.cols || now.rows !== before.rows;
        }, 'the terminal takes a new size')
        .toBe(true);
      // the page tells the server, the server resizes the pseudo console: the three agree before the program is asked
      await expect
        .poll(async () => {
          const shown = await fittedSize(page);
          const reported = (await liveSessions()).get(first);
          return reported?.cols === shown.cols && reported.rows === shown.rows;
        }, 'the server reports the size the page shows')
        .toBe(true);
      const size = await fittedSize(page);
      expect(size.cols, 'the uis contract: at least 80 columns').toBeGreaterThanOrEqual(80);
      await focusTerminal(page);
      await expect(async () => {
        await typeLine(page, '/size');
        await expect
          .poll(async () => (await rowsStartingWith(page, 'SIZE:')).at(-1), { timeout: 3000 })
          .toBe(`SIZE:${String(size.cols)}x${String(size.rows)}`);
      }, 'the program reports the size of the window').toPass();
      seenSizes.push(size);
      previous = size;
    }
    const distinct = new Set(seenSizes.map((size) => `${String(size.cols)}x${String(size.rows)}`));
    expect(distinct.size, 'the three windows give three sizes').toBe(3);
    expect(seenSizes.at(-1), 'the first window size gives the first terminal size again').toEqual(seenSizes[0]);
  });

  await test.step('TC-E2E-07 Ctrl+C copies a selection instead of interrupting, Ctrl+V pastes lines as one paste', async () => {
    const interrupts = interruptsReceived();
    const pastes = pastesHandled();
    await typeLine(page, 'copy acceptanceword');
    await waitForRow(page, 'ECHO:copy acceptanceword');

    // a word
    await selectWord(page, 'ECHO:copy', 'acceptanceword');
    await copySelection(page);
    await page.keyboard.press('Control+V');
    await waitForRow(page, pasteAnswer('acceptanceword'));

    // three lines, read back as one paste: the program answers with the length and the hash of what it received
    const top = await lastRowIndex(page, 'ECHO:copy acceptanceword');
    const pasted = await selectRows(page, top, top + 2);
    expect(pasted.split('\r').length).toBe(3);
    await copySelection(page);
    await page.keyboard.press('Control+V');
    await expect.poll(pastesHandled, 'each Ctrl+V is one paste for the program').toBe(pastes + 2);
    await expect
      .poll(async () => (await rowsStartingWith(page, 'PASTE:')).at(-1), 'the answer to the paste of three lines')
      .toBe(pasteAnswer(pasted));
    expect(interruptsReceived(), 'a copy never sent the interrupt byte').toBe(interrupts);

    // the control: without a selection the same key is the interrupt of the program
    await page.keyboard.press('Control+C');
    await waitForRow(page, 'INTERRUPT');
    await expect.poll(interruptsReceived).toBe(interrupts + 1);
  });

  await test.step('TC-E2E-08 a reload shows the output once', async () => {
    await typeLine(page, 'reload marker');
    await waitForRow(page, 'ECHO:reload marker');
    await page.reload();
    await expectLive(page, first);
    await expectRowCount(page, 'ECHO:reload marker', 1);
    expect(
      (await rowsStartingWith(page, 'Claude Code (fake)')).length,
      'the banner is not repeated',
    ).toBeLessThanOrEqual(1);
    expect((await rowsStartingWith(page, 'ECHO:hello world')).length).toBeLessThanOrEqual(1);
    await focusTerminal(page);
    await typeLine(page, 'after reload');
    await expectRowCount(page, 'ECHO:after reload', 1);
    expect(instance.fakeLog().count('start'), 'the reload started no process').toBe(1);
  });

  await test.step('TC-E2E-09 a second browser with a fresh link shares the session', async () => {
    const second = await watch.page({ viewport: DESKTOP });
    await signIn(second, await instance.accessUrl());
    await openSession(second, origin, first);
    await expectRowCount(second, 'ECHO:after reload', 1);

    await focusTerminal(second);
    await typeLine(second, 'from the second');
    await waitForRow(second, 'ECHO:from the second');
    await waitForRow(page, 'ECHO:from the second');
    await focusTerminal(page);
    await typeLine(page, 'from the first');
    await waitForRow(page, 'ECHO:from the first');
    await waitForRow(second, 'ECHO:from the first');

    for (const viewer of [page, second]) {
      const streams = watch.streams(viewer);
      expect(streams.eventSources.length, 'event streams of one Workspace page').toBeLessThanOrEqual(2);
      expect(new Set(streams.eventSources).size, 'no stream is open twice').toBe(streams.eventSources.length);
      expect(streams.sockets, 'the one socket of the open terminal').toEqual([
        `/api/v3/terminal/sessions/${first}/socket`,
      ]);
    }
    await watch.close(second);
  });

  await test.step('TC-E2E-10 "Other folder" starts in the picked folder, "Resume in terminal" resumes a monitored session', async () => {
    await ui.otherFolder.click();
    await expect(page).toHaveURL(`${origin}/?session=FIXTURE-picked-1`);
    await expectLive(page, 'FIXTURE-picked-1');
    await focusTerminal(page);
    await typeLine(page, '/cwd');
    await expectOnScreen(page, `CWD:${world.folders.picked}`);

    await page.goto(`${origin}/sessions/${SESSION_RESUMABLE}`);
    await ui.resumeInTerminal.click();
    await expect(ui.dialogs.resume.root).toContainText(world.folders.beta);
    await ui.dialogs.resume.confirm.click();
    await expect(page).toHaveURL(`${origin}/?session=FIXTURE-beta-1`);
    await expectLive(page, 'FIXTURE-beta-1');
    await focusTerminal(page);
    await typeLine(page, '/args');
    await expectOnScreen(page, `ARGS:${JSON.stringify(['--resume', SESSION_RESUMABLE])}`);
    expect([...(await liveSessions()).keys()].sort()).toEqual([
      'FIXTURE-alpha-1',
      'FIXTURE-beta-1',
      'FIXTURE-picked-1',
    ]);
  });

  await test.step('TC-E2E-11 "Stop session" asks first: Cancel keeps the process, the confirmation ends it', async () => {
    const name = 'FIXTURE-beta-1';
    await typeLine(page, '/pid');
    const pid = Number(/^PID:(\d+) /.exec(await waitForRow(page, 'PID:'))?.[1]);
    expect(isAlive(pid)).toBe(true);

    await ui.stop.click();
    await expect(ui.dialogs.stop.root).toContainText(name);
    await ui.dialogs.stop.cancel.click();
    await expect(ui.dialogs.any).toHaveCount(0);
    await focusTerminal(page);
    await typeLine(page, '/pid');
    await expectRowCount(page, `PID:${String(pid)} `, 2);

    await ui.stop.click();
    await ui.dialogs.stop.confirm.click();
    await expect(ui.session(name)).toHaveCount(0);
    await expect
      .poll(() => isAlive(pid), { message: 'the stopped process is gone', timeout: scaled(10_000) })
      .toBe(false);
    await expect
      .poll(async () => [...(await liveSessions()).keys()].sort(), 'the sessions the server still lists')
      .toEqual(['FIXTURE-alpha-1', 'FIXTURE-picked-1']);
  });

  await test.step('TC-E2E-12 `stop` refuses while terminals run and stops nothing; `stop --force` ends the app and its terminals', async () => {
    // a page that outlives its server reports a lost connection, which is no defect of the page: the browser leaves first
    await watch.close(page);
    const serverPid = instance.pid;
    const refused = await instance.runJson(['stop', '--user', '--json']);
    expect(refused.code).toBe(3);
    expect(refused.envelope.error).toMatchObject({
      code: 'TERMINALS_LIVE',
      details: { live: 2, sessions: ['FIXTURE-alpha-1', 'FIXTURE-picked-1'] },
    });
    expect(instance.statePid(), 'the refused stop left the app running').toBe(serverPid);
    expect((await instance.api().get('/api/v3/health')).status).toBe(200);
    expect([...(await liveSessions()).keys()].sort()).toEqual(['FIXTURE-alpha-1', 'FIXTURE-picked-1']);
    expect(isAlive(firstPid), 'the refused stop left the terminal running').toBe(true);

    // exit 0, the port closed, no process of the instance left, its files gone: the harness asserts each of them
    await instance.stop({ force: true });
    expect(isAlive(firstPid), 'the forced stop ended the terminal').toBe(false);
    expect(isAlive(serverPid)).toBe(false);
  });

  await test.step('TC-E2E-13 no console error, no CSP violation beyond the pinned one, every request on the instance origin', () => {
    expect(watch.problems()).toEqual([]);
    const requests = watch.requests();
    expect(requests.length).toBeGreaterThan(50);
    expect(
      requests.filter((request) => request.origin !== origin).map((request) => `${request.origin}${request.pathname}`),
      'requests that left the origin of the instance',
    ).toEqual([]);
    expect(requests.some((request) => request.kind === 'websocket')).toBe(true);
    watch.verify();
  });
});
