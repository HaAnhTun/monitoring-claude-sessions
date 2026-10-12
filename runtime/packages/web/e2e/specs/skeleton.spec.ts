// LF-2: the walking skeleton in a real browser. The instance (started by global-setup.ts through the LF-5 harness) holds two
// FIXTURE sessions. The spec reads the list page and one detail page and compares what they show with `expected`, a naive
// calculation over the fixture files. It does not use the event stream or any page outside the skeleton (overview, activity,
// settings). Every phase is a named step so a failure names the step.
import { expect, test, type Page } from '@playwright/test';

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
    const meta = header.locator('dl.session-header__meta');
    await expect(meta).toContainText(session.id);
    await expect(meta.locator('.session-header__field', { hasText: 'Provider' })).toContainText(/\S/);
    await expect(meta.locator('.session-header__field', { hasText: 'Started' })).toContainText(/\S/);
    await expect(meta.locator('.session-header__field', { hasText: 'Duration' })).toContainText(/\S/);
  });

  await test.step(name('token summary in the header'), async () => {
    await expect(page.locator('header.session-header .token-summary')).toContainText(tokenLineOf(session));
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
    await page.getByRole('tab', { name: 'Tokens' }).click();
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
