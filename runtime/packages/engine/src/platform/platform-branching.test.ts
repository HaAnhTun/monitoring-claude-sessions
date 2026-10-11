// The platform branching rule of 06 section 4 (critic I-34): `process.platform` and `os.platform()` are allowed only in
// packages/engine/src/platform/** and packages/engine/src/security/paths.ts. The test lints strings with the repository
// configuration through ESLint's Node API; no fixture file is ever written under src/. A probe names a path that may or
// may not exist (the logger and security/paths.ts are real modules): ESLint lints the given text as if it were that file
// and never reads or writes the file, which the test checks by comparing the file system before and after.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const runtimeDir = fileURLToPath(new URL('../../../../', import.meta.url));
const PLATFORM_CODE = "export const w = process.platform === 'win32';\n";
const OS_PLATFORM_CODE = "import os from 'node:os';\nexport const w = os.platform();\n";
const STDOUT_CODE = "process.stdout.write('x');\n";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: runtimeDir,
    overrideConfigFile: path.join(runtimeDir, 'eslint.config.js'),
    // Type information is not needed for these rules and the files do not exist on disk.
    overrideConfig: [tseslint.configs.disableTypeChecked] as Linter.Config[],
  });
});

/** Rule messages of `code` linted as if it were the file `relativePath` of the runtime workspace. */
async function lint(relativePath: string, code: string): Promise<string[]> {
  const filePath = path.join(runtimeDir, ...relativePath.split('/'));
  const existedBefore = existsSync(filePath);
  const [result] = await eslint.lintText(code, { filePath });
  expect(existsSync(filePath), `${relativePath}: the probe must not create or remove a file`).toBe(existedBefore);
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-properties' || m.ruleId === 'no-restricted-syntax')
    .map((m) => `${String(m.ruleId)}: ${m.message}`);
}

const PLATFORM_MESSAGE = 'Branch on the platform only in engine/src/platform/**';

/** `path: message` for every platform-branching report of the given files (path relative to the runtime workspace). */
async function platformViolations(files: ReadonlyMap<string, string>): Promise<string[]> {
  const found: string[] = [];
  for (const [file, code] of files) {
    for (const message of await lint(file, code)) {
      if (message.includes(PLATFORM_MESSAGE)) found.push(`${file}: ${message}`);
    }
  }
  return found;
}

/** Every production source file of the engine (tests are exempt by the rule), as workspace-relative POSIX paths. */
function engineSources(dir = 'packages/engine/src'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(runtimeDir, ...dir.split('/')), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...engineSources(relative));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(relative);
  }
  return found.sort();
}

describe('process.platform is confined to engine/src/platform/** and engine/src/security/paths.ts', () => {
  it('is an error in another engine module (exactly one report)', async () => {
    const messages = await lint('packages/engine/src/panels/x.ts', PLATFORM_CODE);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no-restricted-properties');
    expect(messages[0]).toContain('platform');
    expect(messages[0]).toContain('hostPlatform');
  }, 120_000);

  it('is allowed in platform/**, including nested folders', async () => {
    expect(await lint('packages/engine/src/platform/x.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/engine/src/platform/deeper/x.ts', PLATFORM_CODE)).toEqual([]);
  }, 120_000);

  it('is allowed in security/paths.ts only', async () => {
    expect(await lint('packages/engine/src/security/paths.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/engine/src/security/other.ts', PLATFORM_CODE)).toHaveLength(1);
  }, 120_000);

  it('is not restricted in shared, cli, server and in test files', async () => {
    expect(await lint('packages/shared/src/protocol/x.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/shared/src/x.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/cli/src/x.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/server/src/x.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/engine/src/panels/x.test.ts', PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/engine/test/platform/x.int.test.ts', PLATFORM_CODE)).toEqual([]);
  }, 120_000);

  it('is still an error in the logger module, which keeps only the platform entry', async () => {
    const messages = await lint('packages/engine/src/log/logger.ts', PLATFORM_CODE);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no-restricted-properties');
  }, 120_000);
});

describe('the rule on the real engine sources', () => {
  it('reports nothing in the production files that exist (allowed files may branch, no other file does)', async () => {
    const files = new Map(
      engineSources().map((file) => [file, readFileSync(path.join(runtimeDir, ...file.split('/')), 'utf8')] as const),
    );
    expect(files.size).toBeGreaterThan(0);
    expect(await platformViolations(files)).toEqual([]);
  }, 120_000);

  it('still fails on a real violation: the same check reports a branch in any file outside the allow-list', async () => {
    const violations = await platformViolations(
      new Map([
        ['packages/engine/src/panels/x.ts', PLATFORM_CODE],
        ['packages/engine/src/log/logger.ts', PLATFORM_CODE],
        ['packages/engine/src/security/other.ts', OS_PLATFORM_CODE],
        ['packages/engine/src/platform/x.ts', PLATFORM_CODE],
        ['packages/engine/src/security/paths.ts', OS_PLATFORM_CODE],
      ]),
    );
    expect(violations.map((v) => v.slice(0, v.indexOf(':')))).toEqual([
      'packages/engine/src/panels/x.ts',
      'packages/engine/src/log/logger.ts',
      'packages/engine/src/security/other.ts',
    ]);
  }, 120_000);
});

describe('os.platform() follows the same rule', () => {
  it('is an error in another engine module and allowed in the allow-list', async () => {
    const outside = await lint('packages/engine/src/panels/x.ts', OS_PLATFORM_CODE);
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain('no-restricted-syntax');
    expect(await lint('packages/engine/src/platform/x.ts', OS_PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/engine/src/security/paths.ts', OS_PLATFORM_CODE)).toEqual([]);
    expect(await lint('packages/cli/src/x.ts', OS_PLATFORM_CODE)).toEqual([]);
  }, 120_000);
});

describe('the allow-list keeps the other restrictions (flat config replaces rule options per block)', () => {
  it('process.stdout stays an error in platform/** and security/paths.ts, and in every other engine module', async () => {
    for (const file of [
      'packages/engine/src/platform/x.ts',
      'packages/engine/src/security/paths.ts',
      'packages/engine/src/panels/x.ts',
    ]) {
      const messages = await lint(file, STDOUT_CODE);
      expect(messages, file).toHaveLength(1);
      expect(messages[0]).toContain('no-restricted-properties');
    }
  }, 120_000);

  it('the logger module may write to stdout', async () => {
    expect(await lint('packages/engine/src/log/logger.ts', STDOUT_CODE)).toEqual([]);
  }, 120_000);

  it('shell: true stays an error inside platform/**', async () => {
    const messages = await lint('packages/engine/src/platform/x.ts', 'export const o = { shell: true };\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no-restricted-syntax');
  }, 120_000);
});
