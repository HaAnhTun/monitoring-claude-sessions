// The contract between the fake claude and the readers of the engine (CAW-58, design 08 section 2.5; project `pty`, Windows
// only). Every terminal test trusts the fake to write what a real client writes: a registry entry named by its pid and a
// transcript below the Claude home. If the fake drifted from what the engine reads, those tests would pass for the wrong reason
// or fail for no reason, so this file feeds the files of a fake that runs on a real pseudo console, inside a real app
// (`startUserInstance`), to the engine's own readers:
//   - the registry reader of the engine (`createRegistryReader`, here in the test process) reads the entry of the fake: session
//     id, status, what it waits for, the pid; an entry is rewritten on `/status` and `/rewrite-id`, removed by a normal exit and
//     left behind by a kill (the stale-pid evidence);
//   - the transcript lies where the engine looks for the project of the folder (`projectFolderName`), and the import of the
//     running app (the transcript tailer) reads it: the session appears with the turns and the token totals the fake wrote, the
//     model, the entry point and the working folder, and the transcript reader serves its records.
// A missing terminal addon FAILS the run under `QA_PTY_REQUIRED=1`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createRegistryReader, pidAlive, projectFolderName, type RegistryEvent } from '@mcs/engine';
import { TERMINAL_CLOSE_CODES, TerminalStateSchema, buildPath, routes, type TerminalSessionInfo } from '@mcs/shared';
import {
  TAG,
  describePtyTests,
  fakeSessionId,
  killAllTracked,
  parseReady,
  registryFile,
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
const IMPORT_WAIT_MS = scaled(60_000);
/** What the fake claude writes as the usage of every turn (design 08 section 2.5). */
const FAKE_INPUT_TOKENS_PER_TURN = 100;
const FAKE_OUTPUT_TOKENS_PER_TURN = 20;
const FAKE_MODEL = 'claude-sonnet-5-5';
// FIXTURE: an invented session id for `/rewrite-id`
const REWRITTEN_ID = 'dddd4444-4444-4444-8444-44444444dddd';

interface Terminal {
  readonly name: string;
  readonly client: RawWsClient;
  readonly ready: FakeReady;
  run(line: string, answer: RegExp): Promise<RegExpExecArray>;
}

async function open(app: UserInstance, folder: string): Promise<Terminal> {
  const { name } = await app.createSession(folder);
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

/** The registry of a Claude home as the engine reads it now: a new reader, so nothing is held back as already seen. */
async function registryOf(app: UserInstance): Promise<{ events: readonly RegistryEvent[]; readFailures: number }> {
  const reader = createRegistryReader({
    claudeHome: app.paths.claudeHome,
    now: () => Date.now(),
    isKnownSession: () => true,
    pidAlive,
  });
  const poll = await reader.poll();
  return { events: poll.events, readFailures: poll.readFailures };
}

async function rowOf(app: UserInstance, name: string): Promise<TerminalSessionInfo | undefined> {
  const state = await app.api(await app.cookie()).get(routes.terminalState.path);
  return TerminalStateSchema.parse(state.json).sessions.find((session) => session.name === name);
}

/** The session of the monitor once it counts `turns` turns. */
function sessionWhen(app: UserInstance, sessionId: string, turns: number) {
  return waitFor(
    async () => {
      const reply = await app.api().get(buildPath(routes.getSession, { sessionId }));
      if (reply.status !== 200) return null;
      const session = routes.getSession.response.parse(reply.json);
      return session.usage.turns === turns ? session : null;
    },
    { what: `the import to count ${String(turns)} turns of the session`, timeoutMs: IMPORT_WAIT_MS, intervalMs: 250 },
  );
}

/** What the monitor said about the sources of the imported session, recorded by the first test for the second. */
let imported:
  { readonly sources: { hooks: boolean; transcript: boolean }; readonly lastTranscriptAt: string | null } | undefined;

describePtyTests('the files of the fake claude and the readers of the engine', () => {
  it(
    'fake-claude-contract: the registry entry and the transcript of the fake are read by the registry reader and the import of the engine, with the session and its token totals',
    async () => {
      // the fake registers itself at its start, as the real client does
      const app = await startUserInstance({ purpose: 'contract-pty', env: { FAKE_CLAUDE_AUTOREGISTER: '1' } });
      const cookie = await app.cookie();
      const folder = app.project('contract');
      const firstId = fakeSessionId();
      const terminal = await open(app, folder);
      const entryFile = registryFile(app.paths.claudeHome, terminal.ready.pid);

      // ---- the registry entry: written at the start, read by the engine's reader ---------------------------------------------
      await waitFor(() => existsSync(entryFile), { what: 'the registry entry of the fake', timeoutMs: OUTPUT_WAIT_MS });
      const atStart = await registryOf(app);
      expect(atStart.readFailures).toBe(0);
      expect(atStart.events).toHaveLength(1);
      expect(atStart.events[0]).toMatchObject({
        k: 'external.registry',
        sessionId: firstId,
        status: 'idle',
        pid: terminal.ready.pid,
        pidAlive: true,
      });
      expect(atStart.events[0]?.waitingFor).toBeUndefined();
      // the app reads the same entry: the terminal links by the pid of its own child before any transcript exists
      const linked = await waitFor(
        async () => {
          const row = await rowOf(app, terminal.name);
          return row?.link.status === 'linked' ? row : null;
        },
        { what: 'the terminal to link by its registry entry', timeoutMs: IMPORT_WAIT_MS, intervalMs: 250 },
      );
      expect(linked.link).toMatchObject({ sessionId: firstId, claudePid: terminal.ready.pid, registryStatus: 'idle' });

      await terminal.run('/status waiting FIXTURE-permission', new RegExp(`^${TAG.status}waiting`, 'm'));
      const waiting = await registryOf(app);
      expect(waiting.readFailures).toBe(0);
      expect(waiting.events[0]).toMatchObject({
        sessionId: firstId,
        status: 'waiting',
        waitingFor: 'FIXTURE-permission',
      });
      await terminal.run('/status busy', new RegExp(`^${TAG.status}busy`, 'm'));
      expect((await registryOf(app)).events[0]).toMatchObject({ status: 'busy' });

      // ---- the transcript: where the engine looks for it, in the shapes the import reads ---------------------------------------
      await terminal.run('/transcript 4', new RegExp(`^${TAG.transcript}${firstId}`, 'm'));
      const projectDir = path.join(app.paths.claudeHome, 'projects', projectFolderName(folder).name);
      const transcript = path.join(projectDir, `${firstId}.jsonl`);
      expect(existsSync(transcript)).toBe(true);
      const records = readFileSync(transcript, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line));
      expect(records).toHaveLength(8);
      const session = await sessionWhen(app, firstId, 4);
      expect(session.usage).toMatchObject({
        input: 4 * FAKE_INPUT_TOKENS_PER_TURN,
        output: 4 * FAKE_OUTPUT_TOKENS_PER_TURN,
        cacheRead: 0,
        cacheCreation: 0,
        turns: 4,
        // every message of the fake carries its usage: nothing is missing, nothing is made up
        missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        synthetic: 0,
      });
      expect(session.usage.total).toBe(4 * (FAKE_INPUT_TOKENS_PER_TURN + FAKE_OUTPUT_TOKENS_PER_TURN));
      expect(session).toMatchObject({
        provider: 'claude-code',
        entrypoint: 'cli',
        lastModel: FAKE_MODEL,
        partial: false,
      });
      expect(session.models).toEqual([FAKE_MODEL]);
      expect(session.cwd?.toLowerCase()).toBe(folder.toLowerCase());
      // what the session says about where it was read from is judged by the next test
      imported = { sources: session.sources, lastTranscriptAt: session.freshness.lastTranscriptAt };
      // the transcript reader of the engine serves the records of the file (a reader route: it needs the cookie)
      const window = await app.api(cookie).get(buildPath(routes.transcriptWindow, { sessionId: firstId }));
      expect(window.status, window.body.slice(0, 200)).toBe(200);
      expect(window.body).toContain('FIXTURE prompt 0');
      expect(window.body).toContain('FIXTURE assistant reply 3');
      // more turns are appended, not rewritten: the import counts each message once
      await terminal.run('/transcript 2', new RegExp(`^${TAG.transcript}${firstId}`, 'm'));
      const grown = await sessionWhen(app, firstId, 6);
      expect(grown.usage).toMatchObject({
        input: 6 * FAKE_INPUT_TOKENS_PER_TURN,
        output: 6 * FAKE_OUTPUT_TOKENS_PER_TURN,
      });

      // ---- a new session id inside the same process: the entry is rewritten and the transcript goes on under the new id ---------
      await terminal.run(`/rewrite-id ${REWRITTEN_ID}`, new RegExp(`^${TAG.rewrote}${REWRITTEN_ID}`, 'm'));
      const rewritten = await registryOf(app);
      expect(rewritten.readFailures).toBe(0);
      expect(rewritten.events).toHaveLength(1);
      expect(rewritten.events[0]).toMatchObject({ sessionId: REWRITTEN_ID, pid: terminal.ready.pid });
      expect(existsSync(path.join(projectDir, `${REWRITTEN_ID}.jsonl`))).toBe(true);
      const continued = await sessionWhen(app, REWRITTEN_ID, 1);
      expect(continued.usage).toMatchObject({ input: FAKE_INPUT_TOKENS_PER_TURN, output: FAKE_OUTPUT_TOKENS_PER_TURN });
      const moved = await waitFor(
        async () => {
          const row = await rowOf(app, terminal.name);
          return row?.link.sessionId === REWRITTEN_ID ? row : null;
        },
        { what: 'the link to follow the new session id', timeoutMs: IMPORT_WAIT_MS, intervalMs: 250 },
      );
      expect(moved.link).toMatchObject({ status: 'linked', claudePid: terminal.ready.pid });
      expect(moved.link.previousSessionIds).toContain(firstId);
      // the first session keeps what it had
      expect((await sessionWhen(app, firstId, 6)).usage.turns).toBe(6);

      // ---- the end of the process: a normal exit removes the entry, a kill leaves it behind -----------------------------------
      terminal.client.sendBinary(Buffer.from('/exit\r'));
      await waitFor(() => terminal.client.closeInfo(), { what: 'the terminal to end', timeoutMs: OUTPUT_WAIT_MS });
      expect(terminal.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.exited);
      expect(existsSync(entryFile)).toBe(false);
      expect((await registryOf(app)).events).toEqual([]);

      const killed = await open(app, folder);
      const killedEntry = registryFile(app.paths.claudeHome, killed.ready.pid);
      await waitFor(() => existsSync(killedEntry), {
        what: 'the registry entry of the second fake',
        timeoutMs: OUTPUT_WAIT_MS,
      });
      await app.killSession(killed.name);
      await waitFor(() => killed.client.closeInfo(), { what: 'the killed terminal to end', timeoutMs: OUTPUT_WAIT_MS });
      expect(killed.client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.killed);
      await waitFor(() => !pidAlive(killed.ready.pid), {
        what: 'the killed process to be gone',
        timeoutMs: OUTPUT_WAIT_MS,
      });
      // the entry of a process that was killed stays, and the reader of the engine reports that its process is gone
      expect(existsSync(killedEntry)).toBe(true);
      const stale = await registryOf(app);
      expect(stale.readFailures).toBe(0);
      expect(stale.events).toHaveLength(1);
      expect(stale.events[0]).toMatchObject({ pid: killed.ready.pid, pidAlive: false });

      await app.stop();
    },
    scaled(360_000),
  );

  // DEFECT (product, the monitor): the import never sets `sessions.last_transcript_at`, so a session that was read from its transcript
  // answers `sources.transcript: false` and `freshness.lastTranscriptAt: null`. Remove `.fails` when the import sets the column.
  it.fails(
    'fake-claude-contract: a session the import read from the transcript of the fake says so (sources.transcript)',
    () => {
      // without the session of the test above there is nothing to judge: this must not count as the expected failure
      if (imported === undefined) return;
      expect(imported.sources).toEqual({ hooks: false, transcript: true });
      expect(imported.lastTranscriptAt).not.toBeNull();
    },
  );
});
