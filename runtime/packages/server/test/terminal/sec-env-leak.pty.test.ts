// Where the access code and the environment of the server must not go, on real processes (CAW-58, design 08 section 3.6, ids
// TC-SEC-10 and TC-SEC-30; project `pty`, Windows only): one real app in a hermetic temp root (`startUserInstance`) and the fake
// claude on a real pseudo console.
//   - TC-SEC-10: an access code is a password for the terminals. It is printed by `open --print` and by nothing else: not a file
//     below the temp root (state, configuration, logs, the database), not `status`, not an API answer or an error envelope, not
//     the command line of a process. The same holds for the session cookie it is exchanged for.
//   - TC-SEC-30: the process of a session gets the environment of the server without the names that would make a claude think
//     it runs inside another one (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_SESSION_ID`, in any case), without the colour switches
//     and without `MCS_HOOK_DISABLE`; the provider settings (`ANTHROPIC_*`) stay, the terminal names are set, and neither the
//     environment nor the arguments hold an access code or a cookie.
// No assertion here can print a code or a cookie: every check is a boolean or a list of file names.
// A missing terminal addon FAILS the run under `QA_PTY_REQUIRED=1`.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ERROR_HTTP_STATUS, routes } from '@mcs/shared';
import { LOGIN_URL_RE } from '@mcs/shared/protocol';
import {
  CANARY,
  TAG,
  describePtyTests,
  killAllTracked,
  parseReady,
  scaled,
  scanFilesFor,
  startUserInstance,
  stripAnsi,
  waitFor,
  type UserInstance,
} from '@mcs/testkit';
import { afterEach, expect, it } from 'vitest';

afterEach(killAllTracked);

const OUTPUT_WAIT_MS = scaled(30_000);
// FIXTURE: an invented session id, as a claude would export it to its children
const OUTER_SESSION_ID = 'cccc3333-3333-4333-8333-33333333cccc';
/** A well-formed access code that nobody minted. */
const NEVER_MINTED = Buffer.alloc(32, 7).toString('base64url');

/** The environment of the server of the TC-SEC-30 test: what a terminal opened from inside a claude session would inherit. */
const INHERITED: Readonly<Record<string, string>> = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_FIXTURE_FLAG: '1',
  claude_code_fixture_lower: '1',
  CLAUDE_SESSION_ID: OUTER_SESSION_ID,
  no_color: '1',
  FORCE_COLOR: '3',
  ANTHROPIC_API_KEY: CANARY.envToken,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
};
/** The names the child must not have, whatever their case. */
const DROPPED = [
  /^CLAUDECODE$/i,
  /^CLAUDE_CODE_/i,
  /^CLAUDE_SESSION_ID$/i,
  /^NO_COLOR$/i,
  /^FORCE_COLOR$/i,
  /^MCS_HOOK_DISABLE$/i,
];

function codeOf(loginUrl: string): string {
  return loginUrl.slice(loginUrl.indexOf('#code=') + '#code='.length);
}

/** A secret as the bytes a file could hold it in: UTF-8 and UTF-16. */
function spellings(secrets: readonly string[]): Buffer[] {
  return secrets.flatMap((secret) => [Buffer.from(secret, 'utf8'), Buffer.from(secret, 'utf16le')]);
}

/** The files below the temp root that hold one of the secrets, by name only (a hit never repeats the secret). */
function filesHolding(app: UserInstance, secrets: readonly string[]): string[] {
  const hits = scanFilesFor([app.root], spellings(secrets));
  return [...new Set(hits.map((hit) => path.relative(app.root, hit.file)))];
}

function holdsNone(text: string, secrets: readonly string[]): boolean {
  return secrets.every((secret) => !text.includes(secret));
}

/** A viewer of a new session after the READY line of the fake; `run` types a line and waits for its answer. */
async function open(
  app: UserInstance,
  folder: string,
): Promise<{
  readonly name: string;
  readonly args: readonly string[];
  run(line: string, answer: RegExp): Promise<string>;
}> {
  const { name } = await app.createSession(folder);
  const { client, replay } = await app.ws(name);
  const seen = (): string => stripAnsi(Buffer.concat([replay, client.collected()]));
  const ready = await waitFor(() => parseReady(seen()), {
    what: 'the READY line of the fake claude',
    timeoutMs: OUTPUT_WAIT_MS,
  });
  return {
    name,
    args: ready.args,
    run: async (line, answer) => {
      const from = seen().length;
      client.sendBinary(Buffer.from(`${line}\r`));
      await waitFor(() => answer.test(seen().slice(from)), {
        what: `the answer of ${line.split(' ')[0] ?? 'the line'}`,
        timeoutMs: OUTPUT_WAIT_MS,
      });
      return seen().slice(from);
    },
  };
}

describePtyTests('the access code and the environment of the server', () => {
  it(
    'TC-SEC-10: the access code and the cookie are in no file of the instance, no status, no API answer and no command line; only open --print prints a code',
    async () => {
      const app = await startUserInstance({ purpose: 'leak-pty' });

      // ---- the secrets of this run: an unspent code, a spent one and the cookie it was exchanged for -------------------------
      const unspent = codeOf(await app.accessUrl());
      const loginUrl = await app.accessUrl();
      const spent = codeOf(loginUrl);
      const exchanged = await app.api().post(routes.authExchange.path, { code: spent });
      expect(exchanged.status).toBe(200);
      const cookie = exchanged.headers['set-cookie']?.split(';')[0]?.trim() ?? '';
      const credential = cookie.slice(cookie.indexOf('=') + 1);
      expect(credential.length).toBeGreaterThan(20);
      expect(credential === spent).toBe(false);
      const secrets = [unspent, spent, credential];
      // the answer of the exchange carries the cookie in its header and neither the code nor the credential in its body
      expect(holdsNone(exchanged.body, secrets)).toBe(true);

      // ---- `open --print` is the one place a code is printed, a fresh one each time, and the browser hook wrote nothing -----
      const printed = await app.runCli(['open', '--user', '--print', '--no-start']);
      expect(printed.code).toBe(0);
      const printedUrl = printed.stdout.split(/\s+/).find((word) => LOGIN_URL_RE.test(word) && word.includes('#code='));
      expect(printedUrl !== undefined).toBe(true);
      const fresh = codeOf(printedUrl ?? '');
      expect(secrets.includes(fresh)).toBe(false);
      expect(printed.stderr.includes(fresh)).toBe(false);
      expect(existsSync(app.paths.openFile)).toBe(false);
      secrets.push(fresh);

      // ---- activity that could tempt a log line: a session, requests that carry a code where no code belongs ------------------
      const session = await app.createSession(app.project('leak'));
      const viewer = await app.ws(session.name, { cookie });
      await viewer.client.close();
      const anonymous = app.api();
      const signedIn = app.api(cookie);
      const answers = [
        await anonymous.get(routes.health.path),
        await anonymous.get(routes.instance.path),
        await anonymous.get(routes.authSession.path),
        await signedIn.get(routes.authSession.path),
        await signedIn.get(routes.terminalState.path),
        await signedIn.get(routes.listFolders.path),
        // error envelopes: a spent code, a code nobody minted, a code in the query string, in the path and in a header
        await anonymous.post(routes.authExchange.path, { code: spent }),
        await anonymous.post(routes.authExchange.path, { code: NEVER_MINTED }),
        await anonymous.get(`${routes.health.path}?code=${unspent}`),
        await anonymous.get(`${routes.terminalState.path}?code=${unspent}`),
        await anonymous.get(`${routes.authExchange.path}/${unspent}`),
        await anonymous.get(routes.terminalState.path, { Authorization: `Bearer ${unspent}` }),
        await anonymous.post(routes.terminalCreateSession.path, { path: unspent }),
      ];
      for (const [index, answer] of answers.entries()) {
        expect(holdsNone(answer.body, [...secrets, NEVER_MINTED]), `answer ${String(index)}`).toBe(true);
        expect(holdsNone(JSON.stringify(answer.headers), [...secrets, NEVER_MINTED]), `headers ${String(index)}`).toBe(
          true,
        );
      }
      // a code in a query string or a header is not a credential
      expect(answers[9]?.status).toBe(ERROR_HTTP_STATUS.access_required);
      expect(answers[11]?.status).toBe(ERROR_HTTP_STATUS.access_required);
      expect(answers[6]?.status).toBe(ERROR_HTTP_STATUS.access_code_invalid);
      // the status of the app, as text and as JSON, names no code and no credential
      const statusText = await app.runCli(['status', '--user']);
      const statusJson = await app.runCli(['status', '--user', '--json']);
      for (const run of [statusText, statusJson]) {
        expect(run.code).toBe(0);
        expect(holdsNone(`${run.stdout}${run.stderr}`, secrets)).toBe(true);
      }

      // ---- no process of the root carries a secret on its command line ------------------------------------------------------------
      const processes = await app.processes();
      expect(processes.length).toBeGreaterThanOrEqual(2);
      for (const found of processes) expect(holdsNone(found.commandLine, secrets), found.name).toBe(true);

      // ---- no file below the temp root holds one: while the app runs, and after it stopped and flushed everything ----------------
      expect(filesHolding(app, secrets)).toEqual([]);
      // the scan is not blind: it finds what the instance does store, the port of its state file
      expect(scanFilesFor([app.paths.instanceDir], [String(app.port)]).length).toBeGreaterThan(0);
      // the unspent code is still unspent: none of the requests above redeemed it, and it was valid all along
      expect((await anonymous.post(routes.authExchange.path, { code: unspent })).status).toBe(200);
      await app.stop({ force: true, keepFiles: true });
      expect(filesHolding(app, secrets)).toEqual([]);
      await app.destroy();
    },
    scaled(360_000),
  );

  it(
    'TC-SEC-30: the child gets the environment of the server without the claude markers, the colour switches and MCS_HOOK_DISABLE; neither its environment nor its arguments hold a code',
    async () => {
      const app = await startUserInstance({ purpose: 'env-pty', env: INHERITED });
      // the server really has the names the child must not get
      expect(app.env).toMatchObject({ CLAUDECODE: '1', MCS_HOOK_DISABLE: '1', no_color: '1' });
      const unspent = codeOf(await app.accessUrl());
      const cookie = await app.cookie();
      const credential = cookie.slice(cookie.indexOf('=') + 1);
      const terminal = await open(app, app.project('env'));
      // nothing but the configured arguments reaches the command line (none are configured)
      expect(terminal.args).toEqual([]);

      // ---- the names, as the process itself lists them ---------------------------------------------------------------------------
      const start = app.fakeLog().of('start')[0];
      const names = Array.isArray(start?.['env']) ? start['env'].map(String) : [];
      expect(names.length).toBeGreaterThan(10);
      for (const pattern of DROPPED) {
        expect(
          names.filter((name) => pattern.test(name)),
          String(pattern),
        ).toEqual([]);
      }
      expect(names).toEqual(
        expect.arrayContaining([
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_BASE_URL',
          'CLAUDE_CONFIG_DIR',
          'COLORTERM',
          'TERM',
          'TERM_PROGRAM',
        ]),
      );

      // ---- the values, asked through the terminal ----------------------------------------------------------------------------------
      const env = await terminal.run(
        '/env CLAUDECODE CLAUDE_SESSION_ID CLAUDE_CODE_ENTRYPOINT NO_COLOR FORCE_COLOR COLORTERM TERM',
        new RegExp(`^${TAG.env}TERM=`, 'm'),
      );
      const valueOf = (text: string, name: string): string | undefined =>
        new RegExp(`^${TAG.env}${name}=(.*)$`, 'm').exec(text)?.[1]?.trim();
      for (const name of ['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NO_COLOR', 'FORCE_COLOR']) {
        expect(valueOf(env, name), name).toBe('UNSET');
      }
      expect(valueOf(env, 'COLORTERM')).toBe('truecolor');
      expect(valueOf(env, 'TERM')).toBe('xterm-256color');
      const others = await terminal.run(
        '/env MCS_HOOK_DISABLE CLAUDE_CODE_FIXTURE_FLAG claude_code_fixture_lower ANTHROPIC_API_KEY ANTHROPIC_BASE_URL TERM_PROGRAM',
        new RegExp(`^${TAG.env}TERM_PROGRAM=`, 'm'),
      );
      for (const name of ['MCS_HOOK_DISABLE', 'CLAUDE_CODE_FIXTURE_FLAG', 'claude_code_fixture_lower']) {
        expect(valueOf(others, name), name).toBe('UNSET');
      }
      for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'TERM_PROGRAM']) {
        expect(valueOf(others, name), name).toBe('set');
      }

      // ---- no code and no cookie in the environment or the arguments of the child ---------------------------------------------------
      const scan = async (needle: string): Promise<string | undefined> => {
        const answer = await terminal.run(`/envscan ${needle}`, new RegExp(`^${TAG.envScan}(FOUND|ABSENT)`, 'm'));
        return new RegExp(`^${TAG.envScan}(FOUND|ABSENT)`, 'm').exec(answer)?.[1];
      };
      // the scan sees a value that is there (the provider key the child keeps), so ABSENT below means absent
      expect(await scan(CANARY.envToken)).toBe('FOUND');
      expect(await scan(unspent)).toBe('ABSENT');
      expect(await scan(credential)).toBe('ABSENT');
      // a code that is minted while the process runs does not reach it either
      const later = codeOf(await app.accessUrl());
      expect(await scan(later)).toBe('ABSENT');

      await app.stop({ force: true });
    },
    scaled(360_000),
  );
});
