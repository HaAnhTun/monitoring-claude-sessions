// The server boot in the bundle layout (ADR 0062 items 2 and 5), in-process: a runtime folder shaped like `<skill>/bundle`
// (the `mcs-server.mjs` marker, `.mcs-build.json`, `web/index.html`, `migrations/`) serves `GET /` from `web/`, creates its
// database from `migrations/`, and a missing stamp is exit 18 with the reinstall hint.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultSkillDir, initWorkspace, layoutOfModule, openSqlite } from '@mcs/engine';
import { RUNTIME_VERSION } from '@mcs/shared';
import { allocatePort, hermeticEnv, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { bootServer, runtimeFoldersOf, type BootResult, type RunningServer } from '../src/boot.ts';

const makeTemp = useTempDirs();
const STAMP = {
  schemaVersion: 1,
  runtimeVersion: RUNTIME_VERSION,
  buildStamp: 'e'.repeat(64),
  codeStamp: '0123abcdef',
};
const INDEX_HTML = '<!doctype html><html><head><title>BUNDLE-WEB-SENTINEL</title></head><body></body></html>';

interface BundleFixture {
  readonly skillDir: string;
  readonly runtimeDir: string;
  readonly ws: string;
  readonly id: string;
  readonly env: Record<string, string>;
}

async function bundleFixture(o: { stamp?: boolean; migrations?: boolean } = {}): Promise<BundleFixture> {
  const root = makeTemp('bundle-layout').path;
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'bundle');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(path.join(skillDir, 'runtime'), { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  writeFileSync(path.join(skillDir, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  mkdirSync(path.join(runtimeDir, 'web'), { recursive: true });
  mkdirSync(path.join(runtimeDir, 'migrations'), { recursive: true });
  writeFileSync(path.join(runtimeDir, 'mcs-server.mjs'), '// marker of the bundle layout\n');
  writeFileSync(path.join(runtimeDir, 'web', 'index.html'), INDEX_HTML);
  if (o.stamp !== false) writeFileSync(path.join(runtimeDir, '.mcs-build.json'), JSON.stringify(STAMP));
  if (o.migrations !== false) {
    const source = layoutOfModule(import.meta.url).migrationsDir;
    for (const name of readdirSync(source))
      copyFileSync(path.join(source, name), path.join(runtimeDir, 'migrations', name));
  }
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
  return { skillDir, runtimeDir, ws: ws.dir, id, env: hermeticEnv(root) };
}

const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.requestShutdown('stop');
    await server.closed;
  }
});

async function boot(f: BundleFixture, port: number): Promise<{ result: BootResult; stderr: string }> {
  const stderr: string[] = [];
  const result = await bootServer({
    argv: ['serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`],
    env: f.env,
    runtimeDir: f.runtimeDir,
    stderr: (text) => stderr.push(text),
  });
  if (result.ok) running.push(result.server);
  return { result, stderr: stderr.join('') };
}

describe('the bundle layout (ADR 0062 items 2 and 5)', () => {
  it('resolves the skill folder, web/ and migrations/ of a bundle folder', async () => {
    const f = await bundleFixture();
    const folders = runtimeFoldersOf(f.runtimeDir);
    expect(folders.mode).toBe('bundle');
    expect(folders.skillDir).toBe(f.skillDir);
    expect(folders.webDir).toBe(path.join(f.runtimeDir, 'web'));
    expect(folders.migrationsDir?.href).toMatch(/\/bundle\/migrations\/$/);
  });

  it('serves GET / from web/ and creates the database from migrations/', async () => {
    const f = await bundleFixture();
    const port = await allocatePort();
    const { result, stderr } = await boot(f, port);
    if (!result.ok) throw new Error(`boot failed with ${String(result.exitCode)}: ${result.message} ${stderr}`);
    const home = await httpRequest(port, '/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('BUNDLE-WEB-SENTINEL');
    const dbFile = path.join(f.ws, 'data', 'monitor.db');
    expect(existsSync(dbFile)).toBe(true);
    const check = openSqlite(dbFile, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
    try {
      const applied = check.prepare<{ n: number }>('SELECT count(*) AS n FROM schema_migrations').get();
      expect(applied?.n).toBeGreaterThanOrEqual(1);
    } finally {
      check.close();
    }
  });

  it('reads the migrations of the bundle folder, not those of the engine sources', async () => {
    const f = await bundleFixture({ migrations: false });
    const { result } = await boot(f, await allocatePort());
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(f.ws, 'state.json'))).toBe(false);
  });

  it('a missing stamp is exit 18 with the reinstall hint', async () => {
    const f = await bundleFixture({ stamp: false });
    const { result, stderr } = await boot(f, await allocatePort());
    if (result.ok) throw new Error('the boot was expected to fail');
    expect(result.exitCode).toBe(18);
    expect(result.message).toContain('bundle/.mcs-build.json');
    expect(result.message).toContain('reinstall the skill');
    expect(stderr).toContain('reinstall the skill');
    expect(existsSync(path.join(f.ws, 'data', 'monitor.db'))).toBe(false);
  });
});
