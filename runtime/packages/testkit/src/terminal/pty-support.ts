// Gate helpers of the real-PTY tests (design 08, principle 3 and section 3.2): whether this machine can run them, the suite
// declaration that never skips silently on Windows, and the time scale of a loaded machine.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe } from 'vitest';

import { fakeClaudeScriptPath } from '../fake-claude/install.ts';
import { runtimeRoot } from '../processes.ts';

/** Why the real-PTY suites are skipped off Windows: the decision of the release (Q1). */
export const PTY_SKIP_REASON_OFF_WINDOWS = 'terminals are Windows-only in this release';

const NATIVE_ARCHES: readonly string[] = ['x64', 'arm64'];
const MIN_SCALE = 1;
const MAX_SCALE = 5;

/**
 * `ms` times `QA_TIME_SCALE`, a factor clamped to 1..5 (the gate sets 2 when the machine is busy). A value that is not a finite
 * number counts as 1. The result is rounded up to a whole millisecond.
 */
export function scaled(ms: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number.parseFloat(env['QA_TIME_SCALE'] ?? '');
  const factor = Number.isFinite(parsed) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, parsed)) : MIN_SCALE;
  return Math.ceil(ms * factor);
}

export type PtySupportResult = { ok: true } | { ok: false; reason: string };

/** The seams of `ptySupport`: tests script the platform, the addon probe and the file check. */
export interface PtySupportDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Returns a reason when the terminal addon cannot be loaded, null when it can. */
  probeAddon?: () => string | null;
  fakeClaudeExists?: () => boolean;
}

/**
 * Loads the addon the way a checkout loads it (the package of the runtime's `node_modules`). A failure gives a fixed sentence
 * and the plain error code, never the message: it holds file paths.
 */
function probeAddonOfCheckout(): string | null {
  try {
    const load = createRequire(`${runtimeRoot()}/package.json`);
    const addon: unknown = load('@lydell/node-pty');
    const hasSpawn =
      typeof addon === 'object' && addon !== null && 'spawn' in addon && typeof addon.spawn === 'function';
    return hasSpawn ? null : 'the terminal addon has no spawn function';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null;
    return code !== null && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code)
      ? `the terminal addon does not load (${code})`
      : 'the terminal addon does not load';
  }
}

/**
 * Whether the real-PTY tests can run here: Windows x64 or arm64, the addon loads, the fake claude script is in place. The
 * reason is meant for a test title and for the failure of the gate, so it holds no path.
 */
export function ptySupport(deps: PtySupportDeps = {}): PtySupportResult {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (platform !== 'win32') return { ok: false, reason: PTY_SKIP_REASON_OFF_WINDOWS };
  if (!NATIVE_ARCHES.includes(arch)) return { ok: false, reason: `no terminal addon is built for ${arch}` };
  let failure: string | null;
  try {
    failure = (deps.probeAddon ?? probeAddonOfCheckout)();
  } catch {
    failure = 'the terminal addon probe failed';
  }
  if (failure !== null) return { ok: false, reason: failure };
  const exists = deps.fakeClaudeExists ?? ((): boolean => existsSync(fakeClaudeScriptPath()));
  if (!exists()) return { ok: false, reason: 'the fake claude script is missing from the testkit' };
  return { ok: true };
}

export interface DescribePtyDeps extends PtySupportDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Registers the suite; the default is `describe.skipIf(skip)(title, body)` of Vitest. */
  declare?: (title: string, body: () => void, skip: boolean) => void;
}

/**
 * A suite of real-PTY tests. Off Windows it is skipped and the title says why (`[skipped on linux: ...]`). On Windows it runs;
 * when the addon or the fake claude is unusable it is skipped with the reason in the title, except under `QA_PTY_REQUIRED=1`
 * (set by the pty gate and by every gate), where this THROWS: a skipped real-PTY test on Windows is a failure (principle 3).
 */
export function describePtyTests(title: string, body: () => void, deps: DescribePtyDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const declare =
    deps.declare ??
    ((suite: string, run: () => void, skip: boolean): void => {
      describe.skipIf(skip)(suite, run);
    });
  const support = ptySupport({ ...deps, platform });
  if (support.ok) {
    declare(title, body, false);
    return;
  }
  if (platform === 'win32' && env['QA_PTY_REQUIRED'] === '1') {
    throw new Error(
      `${title}: the real-PTY tests cannot run and QA_PTY_REQUIRED=1 forbids skipping them: ${support.reason}`,
    );
  }
  declare(`${title} [skipped on ${platform}: ${support.reason}]`, body, true);
}
