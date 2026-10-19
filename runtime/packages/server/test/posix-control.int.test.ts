// WP-87: the POSIX control channel of a real server process (ADR 0005, ADR 0065 item 4). A real child answers `identify` on
// the Linux abstract socket and leaves no socket file, `run/control.token` is 0600, and SIGTERM and SIGHUP end it through the
// graceful shutdown (exit 0, state.json and the token removed). The address table runs on every host (host-injected).
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultSkillDir, initWorkspace } from '@mcs/engine';
import { RUNTIME_VERSION } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  hermeticEnv,
  killAllTracked,
  spawnTracked,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { controlAddress, requestControl } from '../src/control-channel.ts';

const makeTemp = useTempDirs();
const REAL_BOOT = fileURLToPath(new URL('../dist/boot.js', import.meta.url));
const STAMP = {
  schemaVersion: 1,
  runtimeVersion: RUNTIME_VERSION,
  buildStamp: 'f'.repeat(64),
  codeStamp: 'abcdef0123',
};
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

afterEach(async () => {
  await killAllTracked();
});

describe('control address per host (runs everywhere)', () => {
  it('is an abstract socket on linux, a pipe on win32 and a socket file in a per-uid folder elsewhere', () => {
    expect(controlAddress(ID, { platform: 'linux', tmpdir: '/tmp', uid: 1000 })).toBe(`\0mcs-${ID}`);
    expect(controlAddress(ID, { platform: 'win32', tmpdir: 'C:\\t', uid: null })).toBe(`\\\\.\\pipe\\mcs-${ID}`);
    for (const platform of ['darwin', 'other'] as const) {
      expect(controlAddress(ID, { platform, tmpdir: '/var/folders/x/T', uid: 501 })).toBe(
        `/var/folders/x/T/mcs-501/${ID}.sock`,
      );
    }
    expect(controlAddress(ID, { platform: 'darwin', tmpdir: '/tmp', uid: null })).toBe(`/tmp/mcs-0/${ID}.sock`);
    expect(() => controlAddress('not-a-uuid', { platform: 'linux', tmpdir: '/tmp', uid: 1 })).toThrow(RangeError);
  });
});

interface Fixture {
  readonly runtimeDir: string;
  readonly ws: string;
  readonly id: string;
  readonly env: Record<string, string>;
  readonly shim: string;
}

async function fixture(): Promise<Fixture> {
  const root = makeTemp('posix-control').path;
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'runtime');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  writeFileSync(path.join(runtimeDir, '.mcs-build.json'), JSON.stringify(STAMP));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const id = randomUUID();
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    description: 'A synthetic task.',
    newId: () => id,
  });
  const dist = path.join(runtimeDir, 'packages', 'server', 'dist');
  mkdirSync(dist, { recursive: true });
  const shim = path.join(dist, 'main.js');
  writeFileSync(
    shim,
    [
      `import { serveMain } from ${JSON.stringify(pathToFileURL(REAL_BOOT).href)};`,
      `process.exit(await serveMain({ argv: process.argv.slice(2), env: process.env, runtimeDir: ${JSON.stringify(runtimeDir)} }));`,
      '',
    ].join('\n'),
  );
  return { runtimeDir, ws: ws.dir, id, env: hermeticEnv(root), shim };
}

async function startReal(f: Fixture): Promise<{ child: ReturnType<typeof spawnTracked>; port: number }> {
  expect(existsSync(REAL_BOOT), 'build the runtime first (npm run build): the child runs dist/boot.js').toBe(true);
  const port = await allocatePort();
  const child = spawnTracked(
    process.execPath,
    [f.shim, 'serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`],
    { env: f.env },
  );
  await waitFor(
    async () => {
      const reply = await requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1000 }).catch(
        () => null,
      );
      return reply?.ok === true && reply.op === 'identify' && reply.phase === 'ready' ? reply : null;
    },
    { timeoutMs: 30_000, what: 'the child server to be ready' },
  );
  return { child, port };
}

const onPosix = process.platform !== 'win32';

describe.runIf(onPosix)('the control channel of a real server on POSIX', () => {
  it('answers identify on its address, leaves no socket file on linux and writes run/control.token with mode 0600', async () => {
    const f = await fixture();
    const { child, port } = await startReal(f);
    const address = controlAddress(f.id);
    const reply = await requestControl(address, { v: 1, op: 'identify' });
    expect(reply).toMatchObject({ ok: true, op: 'identify', instanceId: f.id, pid: child.pid });
    if (process.platform === 'linux') {
      expect(address.startsWith('\0')).toBe(true);
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const folder = path.join(os.tmpdir(), `mcs-${String(uid)}`);
      if (existsSync(folder)) expect(readdirSync(folder).filter((name) => name.includes(f.id))).toEqual([]);
    }
    const token = path.join(f.ws, 'run', 'control.token');
    expect(statSync(token).mode & 0o777).toBe(0o600);
    process.kill(child.pid, 'SIGTERM');
    expect(await child.exited).toBe(0);
    await assertPortClosed(port);
  }, 90_000);

  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    it(`ends gracefully on ${signal}: exit 0, state.json and the token removed, the name released`, async () => {
      const f = await fixture();
      const { child, port } = await startReal(f);
      expect(existsSync(path.join(f.ws, 'state.json'))).toBe(true);
      process.kill(child.pid, signal);
      expect(await child.exited).toBe(0);
      expect(existsSync(path.join(f.ws, 'state.json'))).toBe(false);
      expect(existsSync(path.join(f.ws, 'run', 'control.token'))).toBe(false);
      await expect(
        requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1500 }),
      ).rejects.toThrow();
      await assertPortClosed(port);
    }, 90_000);
  }
});
