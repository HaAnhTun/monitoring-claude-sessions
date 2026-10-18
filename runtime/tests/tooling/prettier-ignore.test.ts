// CR-WP-13-2: the byte-exact legacy audit fixtures end with the blank line of the legacy entry format, so Prettier must
// skip them (reformatting would destroy the byte compatibility the fixtures exist to prove). The ignore stays narrow: the
// rest of the fixture workspace and every source file are still formatted.
import { join } from 'node:path';

import { getFileInfo } from 'prettier';
import { describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const FIXTURES = 'packages/engine/test/fixtures/legacy-workspace';

async function isIgnored(relative: string): Promise<boolean> {
  const info = await getFileInfo(join(RUNTIME, ...relative.split('/')), {
    ignorePath: join(RUNTIME, '.prettierignore'),
  });
  return info.ignored;
}

describe('.prettierignore', () => {
  it('skips the byte-exact legacy audit fixtures', async () => {
    expect(await isIgnored(`${FIXTURES}/audit/changes.md`)).toBe(true);
    expect(await isIgnored(`${FIXTURES}/audit/decisions.md`)).toBe(true);
  });

  it('skips the frozen data of the pre-4.0 engine (ADR 0066)', async () => {
    expect(await isIgnored('packages/engine/test/fixtures/lifecycle/classify-state.frozen.json')).toBe(true);
    expect(await isIgnored('packages/shared/test/fixtures/clip.frozen.json')).toBe(true);
    expect(await isIgnored('packages/engine/test/fixtures/hooks.ts')).toBe(false);
  });

  it('does not skip anything else of the fixture workspace or the sources', async () => {
    expect(await isIgnored(`${FIXTURES}/README.md`)).toBe(false);
    expect(await isIgnored(`${FIXTURES}/config.json`)).toBe(false);
    expect(await isIgnored(`${FIXTURES}/task.json`)).toBe(false);
    expect(await isIgnored('packages/engine/src/index.ts')).toBe(false);
  });

  it('still skips build output and the lockfile', async () => {
    expect(await isIgnored('packages/shared/dist/index.js')).toBe(true);
    expect(await isIgnored('package-lock.json')).toBe(true);
  });
});
