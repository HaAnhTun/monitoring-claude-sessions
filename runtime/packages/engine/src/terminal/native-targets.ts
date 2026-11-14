// Which hosts the terminal addon ships for, and where its files sit in a bundle (design 01 sections 2.1, 2.5, 3.11). Pure data and
// string functions: nothing here reads the file system or the process, so every branch runs on every host.
import path from 'node:path';

import type { HostPlatform } from '../platform/host.ts';
import type { RuntimeLayout } from '../platform/layout.ts';

/**
 * The one native dependency of the terminal (ADR 0080). Only `node-pty-loader.ts` loads it. A change of package (the documented
 * fallback is the Microsoft `node-pty` of the same version) changes this name and the staging source of `native-pins.json`.
 */
export const NODE_PTY_PACKAGE = '@lydell/node-pty';

/** The `<platform>-<arch>` folders of `bundle/native` and the prebuilds of `scripts/native-pins.json`: Windows only (spec Q1). */
export const SHIPPED_TARGETS = ['win32-x64', 'win32-arm64'] as const;

export type NativeTarget = (typeof SHIPPED_TARGETS)[number];

/** ConPTY needs Windows 10 version 1809, build 17763. */
export const MIN_WINDOWS_BUILD = 17_763;

/** The shipped target of a host, or null when no addon ships for it (the terminal then says it is not supported). */
export function targetOf(platform: HostPlatform, arch: string): NativeTarget | null {
  const key = `${platform}-${arch}`;
  return SHIPPED_TARGETS.find((target) => target === key) ?? null;
}

/** The path module of a target: its files live on the host that the target names, whatever runs this code. */
function pathOf(target: NativeTarget): path.PlatformPath {
  return target.startsWith('win32-') ? path.win32 : path.posix;
}

/** `<runtimeDir>/native/<target>`: the platform package of a bundle, minus its `.pdb` files. */
export function nativeDirOf(layout: Pick<RuntimeLayout, 'runtimeDir'>, target: NativeTarget): string {
  return pathOf(target).join(layout.runtimeDir, 'native', target);
}

/** `<runtimeDir>/native/<target>/lib/index.js`: the file the loader requires by path. */
export function nativeEntryOf(layout: Pick<RuntimeLayout, 'runtimeDir'>, target: NativeTarget): string {
  return pathOf(target).join(nativeDirOf(layout, target), 'lib', 'index.js');
}

const RELEASE_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,9})(?!\d)/;

/**
 * Whether a Windows release supports ConPTY. `release` is `os.release()`: `<major>.<minor>.<build>`, for example `10.0.26200`.
 * Anything that does not start that way is refused, so a host that cannot be told is treated as too old.
 */
export function windowsBuildOk(release: string): boolean {
  const match = RELEASE_RE.exec(release);
  if (match === null) return false;
  const major = Number(match[1]);
  const build = Number(match[3]);
  if (major > 10) return true;
  return major === 10 && build >= MIN_WINDOWS_BUILD;
}
