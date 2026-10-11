// The `state.json` watchdog (01 4.6, T-LC-07). The legacy `stop` deletes the file of a Node runtime (research F.5), so the
// server looks at the file every `process.stateWatchdogMs`: when it is gone, unreadable as a state file, or names a dead
// process it writes its own bytes again; when it names another live process it leaves it alone and raises a flag that
// health reports. It writes only on those conditions, never periodically: a legacy CLI reader does not retry (E5).
import path from 'node:path';

import { StateFileSchema, type StateFile } from '@mcs/shared';

import { SmallFileError, readSmallFile } from '../platform/fsx.ts';
import { pidAlive } from '../platform/process.ts';
import { isMissingFileError, writeWorkspaceFile } from '../workspace/fsio.ts';
import type { RuntimeProcessInfo } from './context.ts';
import type { ErrorRing } from './error-ring.ts';
import type { RuntimeComponent } from './instance-runtime.ts';
import type { Logger } from '../log/logger.ts';

/** A state file larger than this is not a state file (the real one is under 1 KiB). */
const STATE_FILE_MAX_BYTES = 64 * 1024;

/** The part of `InstanceContext` the watchdog reads; the context satisfies it, and tests pass a plain object. */
export interface WatchdogContext {
  readonly instanceDir: string;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly errors: Pick<ErrorRing, 'push'>;
  readonly process: Pick<RuntimeProcessInfo, 'pid'>;
  readonly config: { readonly runtime: { readonly process: { readonly stateWatchdogMs: number } } };
}

export interface StateWatchdogDeps {
  /**
   * The bytes of this runtime's `state.json`: what the server wrote at boot (01 4.4 step 10), or null when the runtime has
   * no state file (an in-process runtime of a test or of the parity harness), in which case the watchdog does nothing.
   */
  readonly stateFileBytes: () => Uint8Array | null;
}

export interface StateWatchdog extends RuntimeComponent {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** True while `state.json` names another live process (`ownership_conflict`, 01 4.6). */
  ownershipConflict(): boolean;
  /** One look at the file now; never rejects. A call while a look is running returns that look. */
  tickNow(): Promise<void>;
}

type RestoreReason = 'absent' | 'unparsable' | 'dead_pid';

function parseState(bytes: Uint8Array): StateFile | null {
  try {
    const parsed = StateFileSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return 'INTERNAL';
}

export function createStateWatchdog(ctx: WatchdogContext, deps: StateWatchdogDeps): StateWatchdog {
  const file = path.join(ctx.instanceDir, 'state.json');
  const intervalMs = ctx.config.runtime.process.stateWatchdogMs;
  let conflict = false;
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  async function restore(ours: Uint8Array, reason: RestoreReason): Promise<void> {
    await writeWorkspaceFile(file, ours);
    conflict = false;
    ctx.logger.warn('state_file_restored', { status: reason });
  }

  async function inspect(): Promise<void> {
    const ours = deps.stateFileBytes();
    if (ours === null) return;
    let current: Buffer;
    try {
      current = await readSmallFile(file, STATE_FILE_MAX_BYTES);
    } catch (error) {
      if (isMissingFileError(error)) {
        await restore(ours, 'absent');
        return;
      }
      if (error instanceof SmallFileError && error.code === 'E_FILE_TOO_LARGE') {
        await restore(ours, 'unparsable');
        return;
      }
      // busy, a folder, no access: not a verdict on the file, so look again at the next tick
      ctx.logger.warn('state_file_unreadable', { code: codeOf(error) });
      return;
    }
    if (Buffer.compare(current, ours) === 0) {
      conflict = false;
      return;
    }
    const state = parseState(current);
    if (state === null) {
      await restore(ours, 'unparsable');
      return;
    }
    if (state.pid === ctx.process.pid) {
      conflict = false; // our own pid under other bytes (a restart of the same process): leave it
      return;
    }
    if (pidAlive(state.pid)) {
      if (!conflict) ctx.logger.warn('ownership_conflict', { pid: state.pid });
      conflict = true;
      return;
    }
    await restore(ours, 'dead_pid');
  }

  function tickNow(): Promise<void> {
    if (running !== null) return running;
    const current = (async (): Promise<void> => {
      try {
        await inspect();
      } catch (error) {
        ctx.logger.warn('state_watchdog_failed', { code: codeOf(error) });
        ctx.errors.push({
          source: 'runtime',
          code: 'STATE_WATCHDOG_FAILED',
          where: 'state-watchdog',
          message: error instanceof Error ? error.message : 'the state file check failed',
        });
      } finally {
        running = null;
      }
    })();
    running = current;
    return current;
  }

  function arm(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tickNow().then(() => {
        if (armed) arm();
      });
    }, intervalMs);
    timer.unref();
  }

  return {
    name: 'state-watchdog',
    ownershipConflict: () => conflict,
    tickNow,
    start: () => {
      if (!armed) {
        armed = true;
        arm();
      }
      return Promise.resolve();
    },
    stop: async () => {
      armed = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (running !== null) await running;
    },
  };
}
