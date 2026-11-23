// Hostile output of a program (design 08 section 3.8, TC-SEC-44). The fake claude prints, on `/hostile`: an OSC 52 clipboard
// write, an OSC 0 title, OSC 8 links (one with `javascript:`), a window report request (`CSI 21 t`), a cursor report request, a
// thousand bells, one megabyte without a line break and invalid UTF-8. Nothing of it may reach beyond the terminal: the clipboard
// keeps what the person copied, the title of the tab stays, no dialog or window opens, the page neither navigates nor asks another
// origin, and the terminal still answers afterwards.
//
// The clipboard is never read by the test (the app forbids pages to read it): the word is pasted back into the program, which
// answers with the length and the hash of what it received.
import { scaled } from '@mcs/testkit';

import {
  copySelection,
  expectLive,
  fittedSize,
  focusTerminal,
  lastRowIndex,
  openSession,
  pageLook,
  pasteAnswer,
  screenRows,
  selectWord,
  signIn,
  typeLine,
  waitForRow,
} from '../dom.ts';
import { expect, test } from '../fixture.ts';

test.use({ appPurpose: 'e2e-hostile' });

const KNOWN_WORD = 'KNOWNWORD';

test('TC-SEC-44 hostile output changes neither the clipboard nor the title, opens nothing and leaves the terminal working', async ({
  app,
  watch,
}) => {
  const { instance, origin, world } = app;
  const page = await watch.page();
  await signIn(page, await instance.accessUrl());
  const session = (await instance.createSession(world.folders.alpha)).name;
  await openSession(page, origin, session);
  await focusTerminal(page);

  await test.step('copy a known word: the clipboard holds it (read back through a paste)', async () => {
    await typeLine(page, `keep ${KNOWN_WORD}`);
    await waitForRow(page, `ECHO:keep ${KNOWN_WORD}`);
    await selectWord(page, 'ECHO:keep', KNOWN_WORD);
    await copySelection(page);
    await page.keyboard.press('Control+V');
    await waitForRow(page, pasteAnswer(KNOWN_WORD));
  });

  const before = await pageLook(page);
  const loads = watch.documentLoads(page);
  const address = page.url();
  const asked = watch.requests().length;

  await test.step('the program prints the hostile sequences', async () => {
    await typeLine(page, '/hostile');
    await expect
      .poll(async () => lastRowIndex(page, 'HOSTILE-DONE'), {
        message: 'the end of the hostile output on the screen',
        timeout: scaled(60_000),
      })
      .toBeGreaterThanOrEqual(0);
    expect(instance.fakeLog().commands()).toContain('/hostile');
  });

  await test.step('the clipboard still holds the known word', async () => {
    await page.keyboard.press('Control+V');
    await expect
      .poll(
        async () => {
          const rows = await screenRows(page);
          const done = rows.findLastIndex((row) => row.startsWith('HOSTILE-DONE'));
          return rows.slice(done + 1).filter((row) => row.startsWith('PASTE:'));
        },
        { message: 'the answer to the paste after the hostile output' },
      )
      .toEqual([pasteAnswer(KNOWN_WORD)]);
  });

  await test.step('the tab is the same tab: title, address, document, no window, no request to another origin', async () => {
    const after = await pageLook(page);
    expect(after.title).toBe(before.title);
    expect(after.title).toContain(session);
    expect(page.url()).toBe(address);
    expect(watch.documentLoads(page), 'documents the tab loaded').toBe(loads);
    expect(page.context().pages().length, 'tabs of the browser').toBe(1);
    expect(watch.problems(), 'dialogs, popups, console errors').toEqual([]);
    expect(
      watch
        .requests()
        .slice(asked)
        .filter((request) => request.origin !== origin)
        .map((request) => request.origin),
      'requests to another origin since the hostile output',
    ).toEqual([]);
  });

  await test.step('the terminal still answers', async () => {
    await expectLive(page, session);
    const size = await fittedSize(page);
    await typeLine(page, '/size');
    await waitForRow(page, `SIZE:${String(size.cols)}x${String(size.rows)}`);
    await typeLine(page, 'after hostile');
    await waitForRow(page, 'ECHO:after hostile');
  });
});
