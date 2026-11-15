// The pinned native files, read the way the real-terminal suites need them (CAW-56): the pins of `scripts/native-pins.json`, the
// host target, and the places the files of the installed package are. Read-only; nothing here loads or starts anything.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/** `<repo>/runtime`: four levels above `packages/engine/test/terminal`. */
export const RUNTIME_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** `win32-x64` or `win32-arm64` on the machine that runs the suite. */
export const HOST_TARGET = `${process.platform}-${process.arch}`;

const PinsSchema = z.object({
  version: z.string(),
  targets: z.record(
    z.string(),
    z.object({
      package: z.string(),
      integrity: z.string(),
      binary: z.record(z.string(), z.object({ bytes: z.number().int().positive(), sha256: z.string() })),
    }),
  ),
});

export type NativePins = z.infer<typeof PinsSchema>;

export function readPins(): NativePins {
  return PinsSchema.parse(JSON.parse(readFileSync(path.join(RUNTIME_ROOT, 'scripts', 'native-pins.json'), 'utf8')));
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The pin of one binary of the host target (`prebuilds/<host>/conpty/OpenConsole.exe` is `conpty/OpenConsole.exe`). */
export function hostPin(relativeToPrebuild: string): { bytes: number; sha256: string } {
  const pins = readPins();
  const entry = pins.targets[HOST_TARGET];
  const pin = entry?.binary[`prebuilds/${HOST_TARGET}/${relativeToPrebuild}`];
  if (pin === undefined) throw new Error(`the pins have no ${relativeToPrebuild} for ${HOST_TARGET}`);
  return pin;
}

/** Where the installed package of the host keeps `OpenConsole.exe` and `conpty.dll` (a checkout: `node_modules` of the workspace). */
export function installedConptyFile(name: 'OpenConsole.exe' | 'conpty.dll'): string {
  return path.join(
    RUNTIME_ROOT,
    'node_modules',
    '@lydell',
    `node-pty-${HOST_TARGET}`,
    'prebuilds',
    HOST_TARGET,
    'conpty',
    name,
  );
}

/** True when two Windows paths name the same file, without regard to case, separators or `\\?\`. */
export function samePath(a: string, b: string): boolean {
  const plain = (value: string): string => path.resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  return plain(a) === plain(b);
}
