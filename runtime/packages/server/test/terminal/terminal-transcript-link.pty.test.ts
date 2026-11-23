// The link between a terminal and the monitored session it runs, on real processes (CAW-58, design 08 section 3.5, the L4 list;
// project `pty`, Windows only): one real app in a hermetic temp root (`startUserInstance`), the fake claude on a real pseudo
// console behind the production command resolution. The fake writes what a real client writes (a transcript below the Claude
// home and a registry entry named by its pid, design 08 section 2.5); the app has to find it by itself:
//   - the row of the terminal links to the session of the fake (`link.status`, the session id, the pid of the claude process),
//     the state in the row follows the registry entry, and the token totals of the monitor are what the fake wrote: 100 input and
//     20 output tokens per turn;
//   - two terminals in two project folders are two sessions and two folders of the sidebar (spec Q9);
//   - a resume starts `claude --resume <id>` in the folder of the session and a copy adds `--fork-session`: the arguments are read
//     back from the process itself (`/args`).
// A missing terminal addon FAILS the run under `QA_PTY_REQUIRED=1`.
import {
  ERROR_HTTP_STATUS,
  FolderListResponseSchema,
  ResumeResponseSchema,
  TERMINAL_CLOSE_CODES,
  TerminalStateSchema,
  buildPath,
  routes,
  type TerminalSessionInfo,
} from '@mcs/shared';
import {
  TAG,
  describePtyTests,
  fakeSessionId,
  killAllTracked,
  parseReady,
  scaled,
  startUserInstance,
  stripAnsi,
  waitFor,
  type FakeReady,
  type RawWsClient,
  type UserInstance,
} from '@mcs/testkit';
import { afterEach, expect, it } from 'vitest';

afterEach(killAllTracked);

const OUTPUT_WAIT_MS = scaled(30_000);
/** The link and the import follow the files of the fake: the registry poll, the transcript tail, one ingest pass. */
const LINK_WAIT_MS = scaled(60_000);
/** What the fake claude writes as the usage of every turn (design 08 section 2.5). */
const FAKE_INPUT_TOKENS_PER_TURN = 100;
const FAKE_OUTPUT_TOKENS_PER_TURN = 20;
// FIXTURE: an invented session id for the second terminal (both fakes would start with the same seeded id)
const SECOND_SESSION_ID = 'bbbb2222-2222-4222-8222-22222222bbbb';

/** One terminal of the app with its viewer: what the test types and what it reads. */
interface Terminal {
  readonly name: string;
  readonly client: RawWsClient;
  readonly ready: FakeReady;
  /** Types a line and waits for an answer that matches `answer` in the output that follows. */
  run(line: string, answer: RegExp): Promise<RegExpExecArray>;
}

async function attach(app: UserInstance, name: string): Promise<Terminal> {
  const { client, replay } = await app.ws(name);
  const seen = (): string => stripAnsi(Buffer.concat([replay, client.collected()]));
  const ready = await waitFor(() => parseReady(seen()), {
    what: 'the READY line of the fake claude',
    timeoutMs: OUTPUT_WAIT_MS,
  });
  return {
    name,
    client,
    ready,
    run: async (line, answer) => {
      const from = seen().length;
      client.sendBinary(Buffer.from(`${line}\r`));
      return waitFor(() => answer.exec(seen().slice(from)), {
        what: `the answer of ${line.split(' ')[0] ?? 'the line'}`,
        timeoutMs: OUTPUT_WAIT_MS,
      });
    },
  };
}

async function open(app: UserInstance, folder: string): Promise<Terminal> {
  return attach(app, (await app.createSession(folder)).name);
}

async function rowOf(app: UserInstance, name: string): Promise<TerminalSessionInfo | undefined> {
  const state = await app.api(await app.cookie()).get(routes.terminalState.path);
  return TerminalStateSchema.parse(state.json).sessions.find((session) => session.name === name);
}

/** Waits until the row of a terminal satisfies `ready`, and answers the row. */
function rowWhen(
  app: UserInstance,
  name: string,
  what: string,
  ready: (row: TerminalSessionInfo) => boolean,
): Promise<TerminalSessionInfo> {
  return waitFor(
    async () => {
      const row = await rowOf(app, name);
      return row !== undefined && ready(row) ? row : null;
    },
    { what, timeoutMs: LINK_WAIT_MS, intervalMs: 250 },
  );
}

interface MonitorUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly turns: number;
}

/** The usage of a monitored session as the monitor reports it; `null` while it does not know the session. */
async function usageOf(app: UserInstance, sessionId: string): Promise<MonitorUsage | null> {
  const reply = await app.api().get(buildPath(routes.getSession, { sessionId }));
  if (reply.status !== 200) return null;
  return routes.getSession.response.parse(reply.json).usage;
}

function usageWhen(app: UserInstance, sessionId: string, turns: number): Promise<MonitorUsage> {
  return waitFor(
    async () => {
      const usage = await usageOf(app, sessionId);
      return usage !== null && usage.turns === turns ? usage : null;
    },
    { what: `the monitor to count ${String(turns)} turns of the session`, timeoutMs: LINK_WAIT_MS, intervalMs: 250 },
  );
}

function expectFakeTotals(usage: MonitorUsage, turns: number): void {
  expect(usage).toMatchObject({
    input: turns * FAKE_INPUT_TOKENS_PER_TURN,
    output: turns * FAKE_OUTPUT_TOKENS_PER_TURN,
    turns,
  });
}

describePtyTests('a terminal and the monitored session it runs', () => {
  it(
    'terminal-transcript-link: the row links to the session of the fake, its state and tokens are what the fake wrote, two folders both appear, and a resume passes its arguments',
    async () => {
      const app = await startUserInstance({ purpose: 'link-pty' });
      const cookie = await app.cookie();
      const alpha = app.project('alpha');
      const beta = app.project('beta');
      const firstId = fakeSessionId();

      // ---- one terminal, one session: the link, the state, the tokens --------------------------------------------------------
      const first = await open(app, alpha);
      // a process that has written nothing is not a session yet
      expect((await rowOf(app, first.name))?.link).toMatchObject({ status: 'pending', sessionId: null });
      const wrote = await first.run('/transcript 3', new RegExp(`^${TAG.transcript}(\\S+)`, 'm'));
      expect(wrote[1]).toBe(firstId);

      const linked = await rowWhen(
        app,
        first.name,
        'the terminal to link to the session of the fake',
        (row) => row.link.status === 'linked' && row.link.transcript === 'tracked',
      );
      expect(linked.link).toMatchObject({
        status: 'linked',
        sessionId: firstId,
        claudePid: first.ready.pid,
        registryStatus: 'idle',
        waitingFor: null,
        reason: null,
        shared: false,
      });
      expect(linked.path.toLowerCase()).toBe(alpha.toLowerCase());
      expectFakeTotals(await usageWhen(app, firstId, 3), 3);

      // the state of the row is the state the process reports, as it changes
      await first.run('/status busy', new RegExp(`^${TAG.status}busy`, 'm'));
      await rowWhen(app, first.name, 'the row to say busy', (row) => row.link.registryStatus === 'busy');
      await first.run('/status waiting FIXTURE-permission', new RegExp(`^${TAG.status}waiting`, 'm'));
      const waiting = await rowWhen(
        app,
        first.name,
        'the row to say waiting',
        (row) => row.link.registryStatus === 'waiting',
      );
      expect(waiting.link.waitingFor).toBe('FIXTURE-permission');
      expect(waiting.link.sessionId).toBe(firstId);
      // two more turns: the totals follow the file, and nothing is counted twice
      await first.run('/transcript 2', new RegExp(`^${TAG.transcript}`, 'm'));
      expectFakeTotals(await usageWhen(app, firstId, 5), 5);

      // ---- a second terminal in a second folder: two sessions, two folders (Q9) -----------------------------------------------
      const second = await open(app, beta);
      await second.run(`/rewrite-id ${SECOND_SESSION_ID}`, new RegExp(`^${TAG.rewrote}${SECOND_SESSION_ID}`, 'm'));
      await second.run('/transcript 1', new RegExp(`^${TAG.transcript}${SECOND_SESSION_ID}`, 'm'));
      const secondRow = await rowWhen(
        app,
        second.name,
        'the second terminal to link to its own session',
        (row) => row.link.status === 'linked' && row.link.transcript === 'tracked',
      );
      expect(secondRow.link).toMatchObject({
        sessionId: SECOND_SESSION_ID,
        claudePid: second.ready.pid,
        shared: false,
      });
      expectFakeTotals(await usageWhen(app, SECOND_SESSION_ID, 1), 1);
      // the first is still the first
      const firstRow = await rowOf(app, first.name);
      expect(firstRow?.link).toMatchObject({ status: 'linked', sessionId: firstId, claudePid: first.ready.pid });
      expectFakeTotals(await usageWhen(app, firstId, 5), 5);

      // both project folders are rows of the sidebar, each with its Claude sessions, and each terminal names its folder
      const folders = await waitFor(
        async () => {
          const reply = await app.api(cookie).get(routes.listFolders.path);
          const list = FolderListResponseSchema.parse(reply.json).folders;
          const mine = [alpha, beta].map((folder) =>
            list.find((row) => row.path?.toLowerCase() === folder.toLowerCase() && row.claude !== null),
          );
          return mine.every((row) => row !== undefined) ? mine : null;
        },
        { what: 'both project folders in the folder list', timeoutMs: LINK_WAIT_MS, intervalMs: 250 },
      );
      expect(folders[0]?.key).not.toBe(folders[1]?.key);
      expect(firstRow?.folderKey).toBe(folders[0]?.key);
      expect(secondRow.folderKey).toBe(folders[1]?.key);

      // ---- resume: the process is started with `--resume <id>` in the folder of the session -------------------------------------
      const resume = (body: unknown): ReturnType<ReturnType<UserInstance['api']>['post']> =>
        app.api(cookie).post(routes.terminalResume.path, body);
      // while a terminal of the app holds the session it cannot be resumed
      expect((await resume({ sessionId: firstId })).status).toBe(ERROR_HTTP_STATUS.resume_unavailable);
      for (const terminal of [first, second]) {
        terminal.client.sendBinary(Buffer.from('/exit\r'));
        await waitFor(() => terminal.client.closeInfo(), { what: 'the terminal to end', timeoutMs: OUTPUT_WAIT_MS });
        expect(terminal.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.exited);
      }
      const resumed = await waitFor(
        async () => {
          const reply = await resume({ sessionId: firstId });
          return reply.status === 200 ? reply : null;
        },
        { what: 'the session to be resumable after its terminal ended', timeoutMs: LINK_WAIT_MS, intervalMs: 250 },
      );
      const resumedRow = ResumeResponseSchema.parse(resumed.json).session;
      expect(resumedRow.path.toLowerCase()).toBe(alpha.toLowerCase());
      const again = await attach(app, resumedRow.name);
      expect(again.ready.args).toEqual(['--resume', firstId]);
      const args = await again.run('/args', new RegExp(`^${TAG.args}(.*)$`, 'm'));
      expect(JSON.parse(args[1] ?? 'null')).toEqual(['--resume', firstId]);
      const cwd = await again.run('/cwd', new RegExp(`^${TAG.cwd}(.*)$`, 'm'));
      expect((cwd[1] ?? '').trim().toLowerCase()).toBe(alpha.toLowerCase());
      // the resumed process continues the same session: one more turn is turn six of the same id
      await again.run('/transcript 1', new RegExp(`^${TAG.transcript}${firstId}`, 'm'));
      expectFakeTotals(await usageWhen(app, firstId, 6), 6);
      const relinked = await rowWhen(
        app,
        again.name,
        'the resumed terminal to link',
        (row) => row.link.status === 'linked',
      );
      expect(relinked.link).toMatchObject({ sessionId: firstId, claudePid: again.ready.pid });

      // a copy of the other session: `--fork-session` after the id, in the folder of that session
      const forked = await waitFor(
        async () => {
          const reply = await resume({ sessionId: SECOND_SESSION_ID, fork: true });
          return reply.status === 200 ? reply : null;
        },
        { what: 'a copy of the second session to start', timeoutMs: LINK_WAIT_MS, intervalMs: 250 },
      );
      const forkedRow = ResumeResponseSchema.parse(forked.json).session;
      expect(forkedRow.path.toLowerCase()).toBe(beta.toLowerCase());
      const copy = await attach(app, forkedRow.name);
      expect(copy.ready.args).toEqual(['--resume', SECOND_SESSION_ID, '--fork-session']);

      // the fake was started four times, each time through the command resolution of the server; the stop ends what is left
      expect(app.fakeLog().count('start')).toBe(4);
      await app.stop({ force: true });
    },
    scaled(360_000),
  );
});
