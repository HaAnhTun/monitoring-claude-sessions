// LF-2: the walking skeleton in a real browser. The instance (started by global-setup.ts through the LF-5 harness) holds two
// FIXTURE sessions. The spec reads the list page and one detail page and compares what they show with `expected`, a naive
// calculation over the fixture files. The first test reads the pages as they are at start-up and uses no page outside the
// skeleton (overview, activity, settings). The second and third (LF-7) keep a page open while the harness changes the running
// instance (a new session, one more turn, then the instance stops): the built app must follow the event stream without a
// reload. Every phase is a named step so a failure names the step.
import { expect, test, type Page } from '@playwright/test';

// eslint-disable-next-line no-restricted-imports -- the LF-7 live helpers are test code of @mcs/server that its exports map does not publish; the spec reuses them by relative path like the global setup
import {
  addFixtureSession,
  appendFixtureTurn,
  haltSkeletonInstance,
} from '../../../server/test/helpers/skeleton-live.ts';
import { readSkeletonEnv, type EnvSession } from '../fixture-env.ts';

const env = readSkeletonEnv();

/** The state badge texts of the UI (lib/lifecycle-display.ts), spelled here on purpose: a changed label must fail the spec. */
const STATE_TEXT: Readonly<Record<EnvSession['state'], string>> = {
  turn_ended: 'Turn ended',
  waiting_tool: 'Waiting for tool',
};

/** The UI shortens a token count ("999", "12k", "2.5M"); the same rule, written down again for the check. */
function shortCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${String(Math.round(n / 1e3))}k`;
  return String(Math.round(n));
}

/** "out X · new input Y · cache read Z": output, input + cache creation, cache read. */
function tokenLineOf(session: EnvSession): string {
  const u = session.inclSubagents;
  return `out ${shortCount(u.output)} · new input ${shortCount(u.input + u.cacheCreation)} · cache read ${shortCount(u.cacheRead)}`;
}

function sessionById(id: string): EnvSession {
  const found = env.expected.sessions.find((session) => session.id === id);
  if (found === undefined) throw new Error(`the page links to session ${id}, which is not a fixture session`);
  return found;
}

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()} @ ${message.location().url}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  return problems;
}

/** Tool rows (`li.tr--tool`) of the transcript tab, compared with the fixture calls of one agent. */
async function expectToolCalls(page: Page, calls: readonly EnvSession['toolCalls'][number][]): Promise<void> {
  expect(calls.length, 'the fixture has tool calls for this agent').toBeGreaterThan(0);
  const units = page.locator('li.tr--tool');
  await expect(units).toHaveCount(calls.length);
  // The viewer lists the newest entry first, so the rows are matched by tool name (unique per agent in the fixture).
  for (const call of calls) {
    const unit = units.filter({ has: page.locator('.tu-name', { hasText: new RegExp(`^${call.name}$`) }) });
    await expect(unit, `one row for the ${call.name} call`).toHaveCount(1);
    const pill = call.resultText === null ? 'running' : call.isError === true ? 'failed' : 'ok';
    await expect(unit.locator('.tu-summary .badge')).toContainText(pill);
    if (call.resultText !== null) {
      await unit.locator('summary').click();
      await expect(unit.locator('.tu-output')).toHaveText(call.resultText);
    }
  }
}

async function checkDetailPage(page: Page, baseUrl: string, session: EnvSession): Promise<void> {
  const name = (what: string): string => `detail page of '${session.label}': ${what}`;

  await test.step(name('title, state and metadata'), async () => {
    await expect(page.getByRole('heading', { level: 1, name: session.label })).toBeVisible();
    const header = page.locator('header.session-header');
    await expect(header.locator('.session-header__state')).toContainText(STATE_TEXT[session.state]);
    // the whole id is not in the header: it is in the Details section, which is closed until asked for
    await expect(header).not.toContainText(session.id);
    await expect(page.locator('.session-stats')).toContainText('Active span');
    await page.getByRole('button', { name: 'Details' }).click();
    const details = page.locator('dl.session-details');
    await expect(details).toContainText(session.id);
    await expect(details.locator('.session-details__field', { hasText: 'Provider' })).toContainText(/\S/);
    await expect(details.locator('.session-details__field', { hasText: 'Started' })).toContainText(/\S/);
  });

  await test.step(name('token figures in the tiles under the header'), async () => {
    const u = session.inclSubagents;
    const tokens = page.locator('.session-stat--tokens');
    await expect(tokens).toContainText('Output');
    await expect(tokens).toContainText('Input (new)');
    // the exact numbers are in the titles of the figures; Input (new) says its sum
    await expect(tokens.locator(`[title="${u.output.toLocaleString('en-US')}"]`)).toHaveCount(1);
    await expect(tokens.locator(`[title*="= ${(u.input + u.cacheCreation).toLocaleString('en-US')}"]`)).toHaveCount(1);
  });

  await test.step(name('tool calls of the main agent with their results'), async () => {
    await expectToolCalls(
      page,
      session.toolCalls.filter((call) => call.agentId === 'main'),
    );
  });

  const subagentCalls = session.toolCalls.filter((call) => call.agentId !== 'main');
  const subagentId = subagentCalls[0]?.agentId;
  if (subagentId !== undefined) {
    await test.step(name(`tool calls of subagent ${subagentId}`), async () => {
      await page.goto(`${baseUrl}/sessions/${encodeURIComponent(session.id)}?agent=${encodeURIComponent(subagentId)}`);
      await expectToolCalls(page, subagentCalls);
    });
  }

  await test.step(name('exact token figures on the Tokens tab'), async () => {
    await page.getByRole('navigation', { name: 'Session views' }).getByRole('link', { name: 'Tokens' }).click();
    const u = session.inclSubagents;
    const figures = page.locator('.token-summary--grid .token-summary__figure');
    const exact = {
      Input: u.input,
      Output: u.output,
      'Cache creation': u.cacheCreation,
      'Cache read': u.cacheRead,
      Turns: u.turns,
    };
    for (const [label, value] of Object.entries(exact)) {
      const figure = figures.filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
      await expect(figure.locator('dd'), `figure '${label}'`).toHaveAttribute('title', String(value));
    }
  });
}

test('list page and detail page show the fixture sessions', async ({ page }) => {
  const consoleProblems = watchConsole(page);

  await test.step('list page: open /sessions', async () => {
    await page.goto(`${env.baseUrl}/sessions`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  });

  const table = page.getByRole('table', { name: 'Sessions' });
  await test.step('list page: the app connected to the monitor', async () => {
    const waiting = page.getByText('Waiting for the connection to the monitor.');
    await expect(table.or(waiting)).toBeVisible();
    await expect(
      waiting,
      'the page still waits for an API client: the app did not provide the API client to its pages',
    ).toHaveCount(0);
  });

  const rows = table.locator('tbody tr');
  await test.step('list page: both fixture sessions with label, state and tokens', async () => {
    await expect(rows).toHaveCount(env.expected.sessions.length);
    for (const session of env.expected.sessions) {
      const row = rows.filter({ hasText: session.label });
      await expect(row, `row of '${session.label}'`).toHaveCount(1);
      await expect(row).toContainText(STATE_TEXT[session.state]);
      await expect(row).toContainText(tokenLineOf(session));
      await expect(row).toContainText(session.id.slice(0, 8));
    }
  });

  // The first row is clicked as the brief says; the second one too, because the two fixture sessions differ (one has finished
  // tool calls and a subagent, the other an open tool call without a result).
  for (const position of [0, 1]) {
    let session: EnvSession | undefined;
    await test.step(`list page: click session row ${String(position + 1)}`, async () => {
      if (position > 0) {
        await page.goto(`${env.baseUrl}/sessions`);
        await expect(rows).toHaveCount(env.expected.sessions.length);
      }
      await rows.nth(position).getByRole('link').click();
      await expect(page).toHaveURL(/\/sessions\/[^/?]+/);
      session = sessionById(decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? ''));
    });
    if (session === undefined) throw new Error('no session was opened');
    await checkDetailPage(page, env.baseUrl, session);
  }

  await test.step('browser console has no errors', () => {
    expect(consoleProblems).toEqual([]);
  });
});

// The two tests below share one running instance and change it, so they run in this order and never in parallel.
test.describe.configure({ mode: 'serial' });

/** The longest the instance may take to import appended transcript data and push it to the page (no sleeps: polled). */
const LIVE_TIMEOUT_MS = 40_000;

function liveRows(page: Page) {
  return page.getByRole('table', { name: 'Sessions' }).locator('tbody tr');
}

/**
 * The Live control of the top bar (04 5.6, ADR 0033, ADR 0073 decision 5): one control that carries what the client observes of its
 * link (`data-connection`) and what the server says of ingestion (`data-ingestion`) as two separate signals.
 */
function liveControl(page: Page) {
  return page.getByRole('banner').locator('.live-control');
}

/** Rows (their text) of the list page; polled with `expect.poll`. */
async function rowTexts(page: Page): Promise<string[]> {
  return page.getByRole('table', { name: 'Sessions' }).locator('tbody tr').allInnerTexts();
}

test('the open list page follows the event stream: a new session and a new turn appear without a reload', async ({
  page,
}) => {
  const consoleProblems = watchConsole(page);
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  const streamRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v3/stream');

  await test.step('list page: open /sessions with both fixture sessions', async () => {
    await page.goto(`${env.baseUrl}/sessions`);
    await expect(liveRows(page)).toHaveCount(env.expected.sessions.length);
  });

  await test.step('the app opened the event stream on the same origin', async () => {
    const request = await streamRequest;
    expect(new URL(request.url()).origin).toBe(new URL(env.baseUrl).origin);
    const response = await request.response();
    expect(response?.status(), 'status of GET /api/v3/stream').toBe(200);
    expect(response?.headers()['content-type'] ?? '').toContain('text/event-stream');
  });

  await test.step('the shell shows one Live control: the connection live and the ingestion as a separate signal', async () => {
    await expect(liveControl(page), 'the control reads live once the stream is open').toHaveAttribute(
      'data-connection',
      'live',
      { timeout: LIVE_TIMEOUT_MS },
    );
    await expect(liveControl(page)).toContainText('Live');
    await expect(liveControl(page)).toBeVisible();
    await expect(liveControl(page)).toHaveAttribute('data-ingestion', /^(ok|degraded|stalled|down|disabled)$/);
    await expect(page.locator('.live-control')).toHaveCount(1);
  });

  // Everything after this marker happens in the same document: a reload or a navigation would erase it.
  await page.evaluate("globalThis.__mcsLiveMarker = 'same-document'");
  const navigationsBefore = navigations;

  // The turn is appended first. The stream's own `session` upsert of alpha still carries the totals from before the turn
  // (CR-LF-7-1: the rollup commit and the hydration of the frame race), so alpha's total is only checked after the new session
  // below made the open list refetch its first page; the new session itself is the part that proves the stream.
  const before = env.expected.sessions[0];
  if (before === undefined) throw new Error('the fixture has no session');
  let grown: EnvSession | undefined;
  await test.step('one more turn is appended to an existing session', () => {
    const updated = appendFixtureTurn(env.paths);
    grown = {
      id: updated.id,
      label: updated.label,
      state: before.state,
      pendingTools: updated.pendingTools,
      inclSubagents: updated.inclSubagents,
      toolCalls: before.toolCalls,
    };
    expect(tokenLineOf(grown), 'the appended turn changes the token line').not.toBe(tokenLineOf(before));
  });

  await test.step('a new session appears in the list without a reload', async () => {
    const added = addFixtureSession(env.paths);
    await expect
      .poll(async () => (await rowTexts(page)).length, {
        message: 'the list shows the third session',
        timeout: LIVE_TIMEOUT_MS,
      })
      .toBe(env.expected.sessions.length + 1);
    const row = liveRows(page).filter({ hasText: added.label });
    await expect(row, `row of '${added.label}'`).toHaveCount(1);
    await expect(row).toContainText(STATE_TEXT[added.state]);
    await expect(row).toContainText(tokenLineOf({ ...added, toolCalls: [] }));
    await expect(row).toContainText(added.id.slice(0, 8));
    for (const session of env.expected.sessions) {
      await expect(liveRows(page).filter({ hasText: session.label })).toHaveCount(1);
    }
  });

  await test.step('the grown token total of the existing session shows too', async () => {
    if (grown === undefined) throw new Error('the turn was not appended');
    const expectedLine = tokenLineOf(grown);
    await expect
      .poll(async () => (await rowTexts(page)).some((text) => text.includes(expectedLine)), {
        message: `row of '${before.label}' shows '${expectedLine}'`,
        timeout: LIVE_TIMEOUT_MS,
      })
      .toBe(true);
  });

  await test.step('the page was never reloaded', async () => {
    expect(await page.evaluate('globalThis.__mcsLiveMarker')).toBe('same-document');
    expect(navigations).toBe(navigationsBefore);
  });

  await test.step('browser console has no errors', () => {
    expect(consoleProblems).toEqual([]);
  });
});

test('after the instance stops the open page keeps its rows and its connections fail', async ({ page }) => {
  // Three polled windows (live before the stop, the chip leaving live, the failed calls) may each take up to LIVE_TIMEOUT_MS.
  test.setTimeout(3 * LIVE_TIMEOUT_MS);
  const failedCalls: string[] = [];
  page.on('requestfailed', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/v3/')) failedCalls.push(pathname);
  });

  await page.goto(`${env.baseUrl}/sessions`);
  await expect(liveRows(page)).toHaveCount(env.expected.sessions.length + 1);

  await test.step('before the stop the connection is live', async () => {
    await expect(liveControl(page)).toHaveAttribute('data-connection', 'live', { timeout: LIVE_TIMEOUT_MS });
  });

  await test.step('stop the instance while the page is open', async () => {
    await haltSkeletonInstance(env.paths);
  });

  await test.step('the connection leaves live and the ingestion stops claiming health (UI-I4)', async () => {
    // The stream breaks at once and the polls fail after it: the control must read reconnecting (or connection lost) inside the
    // documented window, which is shorter than the test timeout (instance.staleAfterMs plus the first retry).
    await expect(liveControl(page)).toHaveAttribute('data-connection', /^(reconnecting|offline)$/, {
      timeout: LIVE_TIMEOUT_MS,
    });
    await expect(liveControl(page)).toHaveAttribute('data-ingestion', 'unknown');
    await expect(liveControl(page)).not.toContainText('Live');
  });

  await test.step('the stream and the polls fail, and the rows stay (UI-I5)', async () => {
    await expect
      .poll(() => failedCalls.length, { message: 'a request to the stopped instance failed', timeout: LIVE_TIMEOUT_MS })
      .toBeGreaterThan(0);
    await expect(liveRows(page)).toHaveCount(env.expected.sessions.length + 1);
  });
});
