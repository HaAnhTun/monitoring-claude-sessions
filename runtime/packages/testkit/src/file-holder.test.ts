import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FILE_HOLDER_SKIP_REASON, holdFileOpen } from './file-holder.ts';
import { useTempDirs } from './temp.ts';

const makeTemp = useTempDirs();
const skip = FILE_HOLDER_SKIP_REASON !== null;

function errnoOf(action: () => void): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

/** A Node child that opens `file` the way Node opens every file (with FILE_SHARE_DELETE) and keeps it open. */
async function nodeHolder(file: string): Promise<() => Promise<void>> {
  const code =
    'const fs = require("node:fs"); fs.openSync(process.argv[1], "r"); process.stdout.write("held\\n"); setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', code, '--', file], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => {
      resolve();
    });
    child.once('error', reject);
  });
  return async () => {
    const gone = new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve();
      }),
    );
    child.kill();
    await gone;
  };
}

describe('holdFileOpen', () => {
  it.skipIf(!skip)(
    `answers null where files cannot be held (${FILE_HOLDER_SKIP_REASON ?? 'not this platform'})`,
    async () => {
      expect(await holdFileOpen(join(makeTemp('holder').path, 'x'), 100)).toBeNull();
    },
  );

  it.skipIf(skip)(
    `makes a rename of the held file fail with EPERM or EBUSY, and lets it pass after stop() (${FILE_HOLDER_SKIP_REASON ?? 'win32'})`,
    async () => {
      const dir = makeTemp('holder').path;
      const file = join(dir, 'held.log');
      writeFileSync(file, 'x');
      const holder = await holdFileOpen(file, 30_000);
      expect(holder).not.toBeNull();
      try {
        expect(['EPERM', 'EBUSY']).toContain(
          errnoOf(() => {
            renameSync(file, join(dir, 'held.log.1'));
          }),
        );
        expect(existsSync(file)).toBe(true);
      } finally {
        await holder?.stop();
      }
      await holder?.stop();
      renameSync(file, join(dir, 'held.log.1'));
      expect(existsSync(join(dir, 'held.log.1'))).toBe(true);
    },
    30_000,
  );

  it.skipIf(skip)(
    `a plain Node holder does not block that rename, which is why the helper exists (${FILE_HOLDER_SKIP_REASON ?? 'win32'})`,
    async () => {
      const dir = makeTemp('holder').path;
      const file = join(dir, 'held.log');
      writeFileSync(file, 'x');
      const stop = await nodeHolder(file);
      try {
        renameSync(file, join(dir, 'held.log.1'));
        expect(existsSync(join(dir, 'held.log.1'))).toBe(true);
      } finally {
        await stop();
      }
    },
    30_000,
  );
});
