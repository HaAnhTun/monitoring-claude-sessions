import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

const tempDir = useTempDirs();
const ENGINE_DIST_DRIVER = fileURLToPath(new URL('../dist/db/driver.js', import.meta.url));

/**
 * Run with a fresh `node`: it loads the built driver, opens a file database, writes and reads one row, then emits one
 * unrelated ExperimentalWarning of its own so the test proves the suppression is scoped to the SQLite one.
 */
const CHILD_SCRIPT = `
const [driverModule, dbPath, mode] = process.argv.slice(2);
const { openSqlite } = await import(driverModule);
const db = openSqlite(dbPath, { readonly: false, fileMustExist: false, timeoutMs: 1000 });
db.exec('CREATE TABLE t (x INTEGER) STRICT');
db.prepare('INSERT INTO t VALUES (?)').run([1]);
const row = db.prepare('SELECT count(*) AS n FROM t').get();
db.close();
if (mode === 'other-warning') process.emitWarning('Probe feature is experimental', 'ExperimentalWarning');
process.stdout.write(JSON.stringify(row));
`;

/** Only what node needs to start: no NODE_OPTIONS, no flags inherited from the test runner. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runChild(mode: 'quiet' | 'other-warning'): { status: number | null; stdout: string; stderr: string } {
  const dir = tempDir('driver-warning').path;
  const script = join(dir, 'child.mjs');
  writeFileSync(script, CHILD_SCRIPT);
  const result = spawnSync(
    process.execPath,
    [script, pathToFileURL(ENGINE_DIST_DRIVER).href, join(dir, 'probe.db'), mode],
    { encoding: 'utf8', env: childEnv(), windowsHide: true, timeout: 30_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('node:sqlite ExperimentalWarning (ADR 0064 decision 2)', () => {
  it('a fresh node process that opens a file database through the built driver prints nothing on stderr', () => {
    expect(existsSync(ENGINE_DIST_DRIVER), 'build the engine first (npm run build)').toBe(true);
    const child = runChild('quiet');
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ n: 1 });
  });

  it('drops only the SQLite warning: another ExperimentalWarning still reaches stderr', () => {
    const child = runChild('other-warning');
    expect(child.status).toBe(0);
    expect(child.stderr).toContain('Probe feature is experimental');
    expect(child.stderr).not.toMatch(/SQLite/);
  });
});
