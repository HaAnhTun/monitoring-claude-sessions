// What a terminal session leaves behind, on real processes (CAW-58, design 08 section 3.6, ids TC-SEC-40, 41, 43 and 45; project
// `pty`, Windows only). One real app in a hermetic temp root (`startUserInstance`) runs ONE recorded scenario in `beforeAll`: the
// log level is `debug`, the home holds a DA memory with canaries in the files that are never to be opened, a second home holds
// decoys, a session of the fake claude types and prints canaries, writes a transcript and is linked, the terminal routes are
// read, and the app is stopped. The four tests then look at what is left:
//   - TC-SEC-40: the replay of a terminal is memory only. What was typed and printed is in no file below the temp root: not the
//     database, not a log, not the state.
//   - TC-SEC-41: the logs, at debug level, name routes and counts: no session name, no folder, no keystroke, no output, no cookie.
//   - TC-SEC-43: the DA memory is read and never written (every file byte-identical, same times, no new file), the content of
//     the files that must not be opened shows up nowhere, and a second home is not looked at.
//   - TC-SEC-45: the terminal routes answer rows of the wire schema with a link and no transcript text.
// A missing terminal addon FAILS the run under `QA_PTY_REQUIRED=1`.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  FolderListResponseSchema,
  ResumeEligibilitySchema,
  TerminalStateSchema,
  buildPath,
  routes,
  type TerminalState,
} from '@mcs/shared';
import {
  CANARY,
  TAG,
  daMemoryDir,
  describePtyTests,
  fakeSessionId,
  killAllTracked,
  parseReady,
  scaled,
  scanFilesFor,
  startUserInstance,
  stripAnsi,
  waitFor,
  writeDaMemory,
  type UserInstance,
} from '@mcs/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';

const OUTPUT_WAIT_MS = scaled(30_000);
const LINK_WAIT_MS = scaled(60_000);
// FIXTURE: invented words. They differ from the canaries of the DA memory files, which lie below the temp root on purpose.
const TYPED_CANARY = 'ZQ-TYPED-CANARY-7d1f3a9c';
const ECHOED_CANARY = 'ZQ-ECHOED-CANARY-52e8b0c4';
const PROJECT = 'zqpriv';
const DECOY = 'zq-decoy-home';
/** The text of the transcript the fake writes (design 08 section 2.5). */
const TRANSCRIPT_TEXTS = ['FIXTURE prompt', 'FIXTURE assistant reply'];

/** The bytes, the size and the times of every file of a tree: what a reader that only reads leaves unchanged. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else {
        const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
        out[path.relative(root, file)] = `${hash} ${String(stat.size)} ${String(stat.mtimeMs)}`;
      }
    }
  };
  walk(root);
  return out;
}

function spellings(words: readonly string[]): Buffer[] {
  return words.flatMap((word) => [Buffer.from(word, 'utf8'), Buffer.from(word, 'utf16le')]);
}

/** The files below `paths` that hold one of `words`, relative to `root`. */
function filesHolding(root: string, paths: readonly string[], words: readonly string[]): string[] {
  return [...new Set(scanFilesFor(paths, spellings(words)).map((hit) => path.relative(root, hit.file)))];
}

/** What the scenario recorded, for the tests to judge. */
interface Recorded {
  readonly app: UserInstance;
  readonly folder: string;
  readonly sessionName: string;
  readonly cookieValue: string;
  /** What the viewer saw: the proof that the canaries were on the terminal. */
  readonly terminalText: string;
  readonly readyLine: string;
  readonly state: TerminalState;
  /** The bodies of the terminal, folder and resume answers, as text. */
  readonly answers: Readonly<Record<string, string>>;
  readonly memory: {
    readonly dir: string;
    readonly before: Record<string, string>;
    readonly after: Record<string, string>;
  };
  readonly decoys: {
    readonly dir: string;
    readonly before: Record<string, string>;
    readonly after: Record<string, string>;
  };
}

let recorded: Recorded | undefined;

function run(): Recorded {
  if (recorded === undefined)
    throw new Error('the scenario of this file did not complete (see the failure of beforeAll)');
  return recorded;
}

describePtyTests('what a terminal session leaves behind', () => {
  beforeAll(async () => {
    let memoryDir = '';
    let decoyDir = '';
    let folder = '';
    let memoryBefore: Record<string, string> = {};
    let decoysBefore: Record<string, string> = {};
    const app = await startUserInstance({
      purpose: 'privacy-pty',
      prepare: async (sandbox) => {
        const set = await sandbox.runCli(['configure', '--user', '--set', 'logLevel="debug"', '--reason', 'FIXTURE']);
        if (set.code !== 0) throw new Error(`the log level could not be set (exit ${String(set.code)})`);
        folder = sandbox.project(PROJECT);
        // the memory of the home the server runs with: one folder is the project of the session, one exists only there
        memoryDir = daMemoryDir(sandbox.paths.home);
        writeDaMemory(memoryDir, {
          nowMs: Date.now(),
          folders: [{ path: folder }, { path: path.join(sandbox.paths.projects, 'FIXTURE-da-only') }],
          canary: true,
          keyDecoys: true,
        });
        // a second home that nothing points at
        decoyDir = daMemoryDir(path.join(sandbox.root, DECOY));
        mkdirSync(path.dirname(decoyDir), { recursive: true });
        writeDaMemory(decoyDir, {
          nowMs: Date.now(),
          folders: [
            { path: path.join(sandbox.paths.projects, `FIXTURE-${DECOY}`), summary: `FIXTURE summary ${DECOY}` },
          ],
          canary: true,
          keyDecoys: true,
        });
        memoryBefore = treeOf(memoryDir);
        decoysBefore = treeOf(decoyDir);
      },
    });
    const cookie = await app.cookie();
    const session = await app.createSession(folder);
    const { client, replay } = await app.ws(session.name);
    const seen = (): string => stripAnsi(Buffer.concat([replay, client.collected()]));
    const ready = await waitFor(() => parseReady(seen()), { what: 'the READY line', timeoutMs: OUTPUT_WAIT_MS });
    const type = async (line: string, answer: RegExp): Promise<void> => {
      client.sendBinary(Buffer.from(`${line}\r`));
      await waitFor(() => answer.test(seen()), { what: 'the answer of a typed line', timeoutMs: OUTPUT_WAIT_MS });
    };
    await type(TYPED_CANARY, new RegExp(`^${TAG.echo}${TYPED_CANARY}`, 'm'));
    await type(`/echo ${ECHOED_CANARY}`, new RegExp(`^${ECHOED_CANARY}`, 'm'));
    await type('/transcript 2', new RegExp(`^${TAG.transcript}`, 'm'));

    const api = app.api(cookie);
    const state = await waitFor(
      async () => {
        const parsed = TerminalStateSchema.parse((await api.get(routes.terminalState.path)).json);
        const row = parsed.sessions.find((entry) => entry.name === session.name);
        return row?.link.status === 'linked' && row.link.transcript === 'tracked' ? parsed : null;
      },
      { what: 'the terminal to link to its session', timeoutMs: LINK_WAIT_MS, intervalMs: 250 },
    );
    // a second viewer gets the replay: the canaries are in the memory of the server, where they belong
    const again = await app.ws(session.name);
    const answers: Record<string, string> = {
      replayHoldsCanaries: String(
        stripAnsi(again.replay).includes(TYPED_CANARY) && stripAnsi(again.replay).includes(ECHOED_CANARY),
      ),
      state: (await api.get(routes.terminalState.path)).body,
      folders: (await api.get(routes.listFolders.path)).body,
      resume: (await api.get(buildPath(routes.sessionResume, { sessionId: fakeSessionId() }))).body,
      session: (await api.get(routes.authSession.path)).body,
      kill: (await api.post(buildPath(routes.terminalKillSession, { name: session.name }))).body,
    };
    const terminalText = seen();
    await app.stop({ force: true, keepFiles: true });
    recorded = {
      app,
      folder,
      sessionName: session.name,
      cookieValue: cookie.slice(cookie.indexOf('=') + 1),
      terminalText,
      readyLine: `READY pid=${String(ready.pid)} cols=`,
      state,
      answers,
      memory: { dir: memoryDir, before: memoryBefore, after: treeOf(memoryDir) },
      decoys: { dir: decoyDir, before: decoysBefore, after: treeOf(decoyDir) },
    };
  }, scaled(360_000));

  afterAll(killAllTracked);

  it('TC-SEC-40: what was typed and printed on the terminal is in no file and no database below the temp root', () => {
    const { app, terminalText, readyLine, answers } = run();
    // the canaries really were on the terminal, and in the replay a later viewer got
    expect(terminalText).toContain(`${TAG.echo}${TYPED_CANARY}`);
    expect(terminalText).toContain(ECHOED_CANARY);
    expect(terminalText).toContain(readyLine);
    expect(answers['replayHoldsCanaries']).toBe('true');
    // typed, printed, and printed only (the READY line of the process): none of it reached the disk
    expect(filesHolding(app.root, [app.root], [TYPED_CANARY, ECHOED_CANARY, readyLine])).toEqual([]);
    // the scan is not blind: the database and the logs are there, and a canary that IS on disk is found
    expect(readdirSync(path.join(app.paths.instanceDir, 'data')).length).toBeGreaterThan(0);
    expect(readdirSync(app.paths.logsDir).length).toBeGreaterThan(0);
    expect(filesHolding(app.root, [daMemoryDir(app.paths.home)], [CANARY.prompt]).length).toBeGreaterThan(0);
  });

  it('TC-SEC-41: the logs at debug level hold no session name, no folder, no keystroke, no output and no cookie', () => {
    const { app, folder, sessionName, cookieValue } = run();
    const logs = [app.paths.logsDir];
    // debug lines were written, and the terminal did log its events: the log is not empty of the thing it must not name
    expect(filesHolding(app.root, logs, ['"debug"']).length).toBeGreaterThan(0);
    expect(filesHolding(app.root, logs, ['terminal']).length).toBeGreaterThan(0);
    const forbidden = [
      sessionName,
      path.basename(folder),
      folder,
      folder.replaceAll('\\', '\\\\'),
      folder.replaceAll('\\', '/'),
      TYPED_CANARY,
      ECHOED_CANARY,
      cookieValue,
      fakeSessionId(),
      ...TRANSCRIPT_TEXTS,
    ];
    expect(filesHolding(app.root, logs, forbidden)).toEqual([]);
  });

  it('TC-SEC-43: the DA memory is byte-identical after the run, what its closed files hold shows up nowhere, and a second home is never read', () => {
    const { app, answers, memory, decoys } = run();
    // the memory was read: its folders are rows of the folder list, with the summary of the hook
    const folders = FolderListResponseSchema.parse(JSON.parse(answers['folders'] ?? 'null')).folders;
    const fromMemory = folders.filter((folder) => folder.da !== null);
    expect(fromMemory).toHaveLength(2);
    expect(answers['folders']).toContain('FIXTURE summary');
    // and never written: the same files, the same bytes, the same times
    expect(Object.keys(memory.before).length).toBeGreaterThan(4);
    expect(memory.after).toEqual(memory.before);
    expect(decoys.after).toEqual(decoys.before);
    // what `brain.md`, `action.md`, `*.key` and the `sessions` array hold is in no answer and in no file outside the two memories
    const closed = [CANARY.prompt, CANARY.toolResult, CANARY.thinking, CANARY.key];
    for (const [name, body] of Object.entries(answers)) {
      for (const canary of closed) expect(body.includes(canary), name).toBe(false);
    }
    const insideAMemory = (file: string): boolean =>
      [memory.dir, decoys.dir].some((dir) => file.startsWith(`${path.relative(app.root, dir)}${path.sep}`));
    const holding = filesHolding(app.root, [app.root], closed);
    expect(holding.some(insideAMemory)).toBe(true);
    expect(holding.filter((file) => !insideAMemory(file))).toEqual([]);
    // the second home: no row, no summary, no trace of its name in what the instance wrote
    expect(answers['folders']).not.toContain(DECOY);
    expect(filesHolding(app.root, [app.paths.mcsHome], [DECOY])).toEqual([]);
  });

  it('TC-SEC-45: the terminal routes answer the row of the wire schema with its link, and never transcript text', () => {
    const { answers, state, sessionName } = run();
    const row = state.sessions.find((session) => session.name === sessionName);
    // the row says which session the terminal runs and in which state its process is: facts, not content
    expect(row?.link).toMatchObject({
      status: 'linked',
      sessionId: fakeSessionId(),
      transcript: 'tracked',
      registryStatus: 'idle',
    });
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ['cols', 'createdAt', 'folderKey', 'link', 'name', 'path', 'rows', 'viewers'].sort(),
    );
    // the strict schemas take every answer: a field that carried text would be an unknown key
    expect(TerminalStateSchema.safeParse(JSON.parse(answers['state'] ?? 'null')).success).toBe(true);
    expect(ResumeEligibilitySchema.safeParse(JSON.parse(answers['resume'] ?? 'null')).success).toBe(true);
    for (const [name, body] of Object.entries(answers)) {
      for (const text of [...TRANSCRIPT_TEXTS, TYPED_CANARY, ECHOED_CANARY])
        expect(body.includes(text), name).toBe(false);
    }
  });
});
