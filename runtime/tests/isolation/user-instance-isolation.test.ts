// The user instance beside task instances (06 section 6, isolation cases 1 to 6 and 8; case 7 is in
// `hook-routing-isolation.test.ts`). The app and the tasks share one temp per-user folder and one temp Claude home, as on a
// person's machine, and are real processes of the built CLI and server. What is proved: stopping one kind never touches the
// other, the app writes only into its own folder, `instances list` keeps the two worlds apart, a state file that names the app is
// never a licence to kill it, two per-user folders give two apps, one folder gives one process, and a task cannot be turned into
// a terminal host by editing its identity file.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { controlAddressOf, identifyInstance, pidAlive } from '@mcs/engine';
import { CliEnvelopeSchema } from '@mcs/shared';
import { allocatePort, assertPortClosed, snapshotTree, spawnTracked, waitFor, type UserInstance } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { serverEntryPath, userInstance, writeStateNaming, type IsolatedWorkspace, type UserFixture } from './_setup.ts';

const TEST_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The slugs of the rows of `instances list --json`. */
function listedSlugs(stdout: string): string[] {
  const data = CliEnvelopeSchema.parse(JSON.parse(stdout)).data;
  if (!Array.isArray(data)) throw new Error('instances list answered no rows');
  return data.map((row: unknown) => (isRecord(row) ? String(row['slug']) : ''));
}

async function appHealth(app: UserInstance): Promise<{ status: number; instanceId: unknown }> {
  const reply = await app.api().get('/api/v3/health');
  return { status: reply.status, instanceId: isRecord(reply.json) ? reply.json['instanceId'] : null };
}

/** The app is the process it was: the pid lives, health names it, `state.json` did not change and the control channel answers. */
async function expectAppUntouched(fixture: UserFixture, app: UserInstance, stateBefore: Buffer): Promise<void> {
  expect(pidAlive(app.pid)).toBe(true);
  expect(await appHealth(app)).toEqual({ status: 200, instanceId: fixture.instanceId });
  expect(readFileSync(app.paths.stateFile).equals(stateBefore)).toBe(true);
  const identity = await identifyInstance(controlAddressOf(fixture.instanceId), 5000);
  expect(identity.kind).toBe('reply');
  if (identity.kind === 'reply')
    expect(identity.response).toMatchObject({ instanceId: fixture.instanceId, pid: app.pid });
}

async function expectTaskUntouched(
  task: IsolatedWorkspace,
  running: { readonly pid: number; readonly port: number },
  stateBefore: Buffer | null,
): Promise<void> {
  expect(pidAlive(running.pid)).toBe(true);
  expect(await task.health(running.port)).toEqual({ status: 200, instanceId: task.instanceId });
  expect(task.stateBytes()?.equals(stateBefore ?? Buffer.alloc(0))).toBe(true);
  expect((await task.markerProcesses()).map((p) => p.pid)).toEqual([running.pid]);
}

describe('user instance isolation (06 section 6)', () => {
  it(
    'case 1: the app and a task run together; stopping the app leaves the task, and stopping the task leaves the app',
    async () => {
      const fixture = await userInstance();
      const a = await fixture.task('a');
      const app = await fixture.start();
      const runningA = await a.start();
      expect(app.pid).not.toBe(runningA.pid);
      expect(app.port).not.toBe(runningA.port);
      const taskState = a.stateBytes();

      const stoppedApp = await fixture.sandbox.runCli(['stop', '--user']);
      expect(stoppedApp.code, stoppedApp.stderr).toBe(0);
      expect(stoppedApp.stdout).toContain(`stopped runtime pid ${String(app.pid)}`);
      expect(pidAlive(app.pid)).toBe(false);
      await assertPortClosed(app.port);
      await expectTaskUntouched(a, runningA, taskState);

      const again = await fixture.start();
      const appState = readFileSync(again.paths.stateFile);
      const stoppedTask = await a.mcs(['stop', '--task', 'a']);
      expect(stoppedTask.code, stoppedTask.stderr).toBe(0);
      expect(stoppedTask.stdout).toContain(`stopped runtime pid ${String(runningA.pid)}`);
      expect(pidAlive(runningA.pid)).toBe(false);
      await assertPortClosed(runningA.port);
      expect(a.readState()).toBeNull();
      await expectAppUntouched(fixture, again, appState);
    },
    TEST_MS,
  );

  it(
    'case 2: the app writes only into its own folder and its route file; the Claude home, the profile and a repository stay as they were',
    async () => {
      const fixture = await userInstance();
      const { sandbox, mcsHome } = fixture;
      const a = await fixture.task('a');
      const tasksRoot = join(a.repo, '.claude', 'monitor', 'tasks');
      const claudeBefore = snapshotTree(sandbox.paths.claudeHome);
      const homeBefore = snapshotTree(sandbox.paths.home);
      const repoBefore = snapshotTree(a.repo);

      const app = await fixture.start();
      // a login, a session of the API and a second login: the things that write when a person uses the app
      const cookie = await app.exchange();
      expect((await app.api(cookie).get('/api/v3/terminal/state')).status).toBe(200);
      expect((await app.runCli(['open', '--user', '--print'])).code).toBe(0);
      const stopped = await app.runCli(['stop', '--user']);
      expect(stopped.code, stopped.stderr).toBe(0);
      await waitFor(() => assertPortClosed(app.port).then(() => true), {
        what: 'the port to close',
        timeoutMs: 30_000,
      });

      // the per-user folder: the reserved root with the one instance, the route file of that instance, and (where a terminal
      // can run) the registry of terminal children of the server; nothing else
      const top = readdirSync(mcsHome).sort();
      expect(top.filter((name) => !['instances', 'routes', 'terminals'].includes(name))).toEqual([]);
      expect(top).toContain('instances');
      expect(readdirSync(join(mcsHome, 'instances'))).toEqual(['user']);
      const routes = top.includes('routes') ? readdirSync(join(mcsHome, 'routes')) : [];
      expect(routes.filter((name) => name !== `${fixture.instanceId}.json`)).toEqual([]);

      expect(snapshotTree(sandbox.paths.claudeHome)).toBe(claudeBefore);
      expect(snapshotTree(sandbox.paths.home)).toBe(homeBefore);
      expect(snapshotTree(a.repo)).toBe(repoBefore);
      expect(readdirSync(tasksRoot)).toEqual(['a']);
    },
    TEST_MS,
  );

  it(
    'case 3: instances list of a repository never shows the app, and instances list --user shows only the app',
    async () => {
      const fixture = await userInstance();
      const a = await fixture.task('a');
      const app = await fixture.start();
      const runningA = await a.start();

      const ofRepo = await a.mcs(['instances', 'list', '--json']);
      expect(ofRepo.code, ofRepo.stderr).toBe(0);
      expect(listedSlugs(ofRepo.stdout)).toEqual(['a']);
      expect(ofRepo.stdout).not.toContain(fixture.instanceId);

      const ofUser = await fixture.sandbox.runCli(['instances', 'list', '--user', '--json']);
      expect(ofUser.code, ofUser.stderr).toBe(0);
      expect(listedSlugs(ofUser.stdout)).toEqual(['user']);
      expect(ofUser.stdout).toContain(String(app.pid));
      expect(ofUser.stdout).not.toContain(a.instanceId);
      expect(ofUser.stdout).not.toContain(String(runningA.port));
    },
    TEST_MS,
  );

  it(
    "case 4: a state.json of a task that names the app's pid and port: stop --task kills nothing",
    async () => {
      const fixture = await userInstance();
      const a = await fixture.task('a');
      const app = await fixture.start();
      const appState = readFileSync(app.paths.stateFile);

      writeStateNaming(a, { pid: app.pid, port: app.port });
      const stopped = await a.mcs(['stop', '--task', 'a']);
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain("not this instance's runtime");
      expect(stopped.stdout).toContain('nothing was killed');
      expect(a.readState()).toBeNull();
      await expectAppUntouched(fixture, app, appState);

      // the same when the file also claims the identity of the app, as a byte copy of the app's own state file would
      writeStateNaming(a, { pid: app.pid, port: app.port, instanceId: fixture.instanceId });
      const copied = await a.mcs(['stop', '--task', 'a']);
      expect(copied.stdout + copied.stderr).toContain('nothing was killed');
      await expectAppUntouched(fixture, app, appState);
      expect((await app.processes()).map((found) => found.pid)).toEqual([app.pid]);
    },
    TEST_MS,
  );

  it(
    'case 5: two per-user folders give two independent apps on two ports',
    async () => {
      const one = await userInstance('iso-user-one');
      const two = await userInstance('iso-user-two');
      expect(one.instanceId).not.toBe(two.instanceId);
      expect(one.sandbox.port).not.toBe(two.sandbox.port);
      const appOne = await one.start();
      const appTwo = await two.start();
      expect(appOne.pid).not.toBe(appTwo.pid);
      expect(await appHealth(appOne)).toEqual({ status: 200, instanceId: one.instanceId });
      expect(await appHealth(appTwo)).toEqual({ status: 200, instanceId: two.instanceId });
      // a login of one is nothing to the other
      const cookieOne = await appOne.exchange();
      expect((await appOne.api(cookieOne).get('/api/v3/auth/session')).json).toEqual({ authenticated: true });
      expect((await appTwo.api(cookieOne).get('/api/v3/auth/session')).json).toEqual({ authenticated: false });

      const stateTwo = readFileSync(appTwo.paths.stateFile);
      await appOne.stop({ keepFiles: true });
      expect(pidAlive(appOne.pid)).toBe(false);
      await expectAppUntouched(two, appTwo, stateTwo);
      await appTwo.stop();
    },
    TEST_MS,
  );

  it(
    'case 6: a second serve of the same user folder exits 12, and two start calls at once end with one process',
    async () => {
      const fixture = await userInstance();
      const { sandbox } = fixture;
      const starts = await Promise.all([
        sandbox.runCli(['start', '--user', '--no-open', '--port', String(sandbox.port)]),
        sandbox.runCli(['start', '--user', '--no-open', '--port', String(sandbox.port)]),
      ]);
      for (const run of starts) expect(run.code, run.stderr).toBe(0);
      const pid = sandbox.statePid();
      expect(pid).not.toBeNull();
      const lines = starts.map((run) => /^(started|already running): \S+ \(pid (\d+)\)$/m.exec(run.stdout));
      expect(lines.map((line) => line?.[2])).toEqual([String(pid), String(pid)]);
      expect((await sandbox.processes()).map((found) => found.pid)).toEqual([pid]);

      const stateBefore = readFileSync(sandbox.paths.stateFile);
      const spare = await allocatePort();
      const hand = spawnTracked(
        process.execPath,
        [
          serverEntryPath(),
          'serve',
          `--mcs-instance=${fixture.instanceId}`,
          `--instance-dir=${sandbox.paths.instanceDir}`,
          `--port=${String(spare)}`,
        ],
        { env: { ...sandbox.env } },
      );
      expect(await hand.exited).toBe(12);
      await assertPortClosed(spare);
      expect(sandbox.statePid()).toBe(pid);
      expect(readFileSync(sandbox.paths.stateFile).equals(stateBefore)).toBe(true);
      expect((await sandbox.processes()).map((found) => found.pid)).toEqual([pid]);
      expect((await sandbox.runCli(['stop', '--user'])).code).toBe(0);
    },
    TEST_MS,
  );

  it(
    'case 8: a task workspace edited to kind user does not boot (exit 17) and the task cannot be started',
    async () => {
      const fixture = await userInstance();
      const a = await fixture.task('a');
      const file = join(a.dir, 'instance.json');
      const instance: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(instance)) throw new Error('instance.json is not an object');
      writeFileSync(file, `${JSON.stringify({ ...instance, kind: 'user' }, null, 2)}\n`);

      const hand = spawnTracked(
        process.execPath,
        [
          serverEntryPath(),
          'serve',
          `--mcs-instance=${a.instanceId}`,
          `--instance-dir=${a.dir}`,
          `--port=${String(a.configuredPort)}`,
        ],
        { env: a.env },
      );
      expect(await hand.exited).toBe(17);
      await assertPortClosed(a.configuredPort);

      const started = await a.mcs(['start', '--task', 'a', '--port', String(a.configuredPort)]);
      expect(started.code).not.toBe(0);
      expect(a.readState()).toBeNull();
      expect(await a.markerProcesses()).toEqual([]);
      // and the real app of this per-user folder was never made a host of that task: it does not run, and its folder is its own
      expect(fixture.sandbox.statePid()).toBeNull();
      expect(readdirSync(join(fixture.mcsHome, 'instances'))).toEqual(['user']);
    },
    TEST_MS,
  );
});
