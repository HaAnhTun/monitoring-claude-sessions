// The platform branching rule of 06 section 4 (critic I-34): `process.platform` and `os.platform()` are allowed only in
// packages/engine/src/platform/** and packages/engine/src/security/paths.ts. The test lints strings with the repository
// configuration through ESLint's Node API; no fixture file is ever written under src/.
import { existsSync } from 'node:fs';
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
  const [result] = await eslint.lintText(code, { filePath });
  expect(existsSync(filePath), `${relativePath} must not exist: the test writes no fixture`).toBe(false);
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-properties' || m.ruleId === 'no-restricted-syntax')
    .map((m) => `${String(m.ruleId)}: ${m.message}`);
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
