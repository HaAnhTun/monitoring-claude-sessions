// OS-released process mutex (01 4.2, ADR 0005; verified by E3 and E10). The mutex is a listening socket: a Windows named
// pipe `\\.\pipe\<name>` or a Linux abstract socket `\0<name>`. The kernel frees it when the holder dies, even by
// `taskkill /F`, so there is no stale-lock rule. macOS and unknown platforms use a lock file (UNVERIFIED on a real macOS).
// The launcher `scripts/mcs.mjs` carries a zero-dependency copy of `mutexName` and the primitives (01 5.1); the parity
// test `launcher-parity.test.ts` keeps both in step.
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { McsError } from '@mcs/shared';
import { resolveMcsHome } from '@mcs/shared/protocol';
import { z } from 'zod';

import { hostPlatform, type HostPlatform } from './host.ts';
import { pidAlive } from './process.ts';

export interface ProcessMutex {
  readonly name: string;
  /** Gives the mutex up. Safe to call twice. */
  release(): Promise<void>;
}

/** One way of holding a named mutex; `tryAcquire` answers null while another holder has it. */
export interface MutexBackend {
  tryAcquire(name: string): Promise<ProcessMutex | null>;
}

export interface AcquireOptions {
  timeoutMs: number;
  /** Called after every unsuccessful attempt with the time waited so far. */
  onWait?: (waitedMs: number) => void;
}

/** `acquireMutex` ran out of time. An `McsError` (code `INTERNAL`; callers map it, for example to `HOOKS_FAILED` `LOCKED`). */
export class MutexTimeoutError extends McsError {
  constructor(name: string, waitedMs: number) {
    super('INTERNAL', `could not acquire ${name} within ${String(Math.round(waitedMs))} ms: another process holds it`, {
      details: { reason: 'MUTEX_TIMEOUT', name, waitedMs },
    });
    this.name = 'MutexTimeoutError';
  }
}

/**
 * `mcs-<kind>-` plus the first 16 hex digits of the SHA-256 of the key (UTF-8). On Windows the key is lower-cased first,
 * because paths there compare case-insensitively. `platform` is a parameter so the table can be tested on every host.
 */
export function computeMutexName(kind: 'task' | 'bootstrap' | 'settings', key: string, platform: HostPlatform): string {
  const material = platform === 'win32' ? key.toLowerCase() : key;
  const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
  return `mcs-${kind}-${digest}`;
}

/**
 * The name of the mutex for `kind`: `task` (key = realpath of the workspace), `bootstrap` (key = realpath of the runtime
 * folder) or `settings` (key = `path.resolve(settingsPath)`).
 */
export function mutexName(kind: 'task' | 'bootstrap' | 'settings', key: string): string {
  return computeMutexName(kind, key, hostPlatform);
}

/** The socket address of a mutex name: a named pipe on win32, an abstract socket on linux, none elsewhere. */
export function socketAddress(platform: HostPlatform, name: string): string | null {
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (platform === 'linux') return `\u0000${name}`;
  return null;
}

const MUTEX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A mutex name becomes a pipe name or a file name: only plain characters, never a separator or a leading dot. */
function assertMutexName(name: string): void {
  if (!MUTEX_NAME_RE.test(name)) throw new RangeError(`not a valid mutex name: ${JSON.stringify(name.slice(0, 40))}`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

/** The mutex as a listening socket: `EADDRINUSE` means somebody else holds it. */
export function createSocketBackend(addressOf: (name: string) => string): MutexBackend {
  return {
    tryAcquire: (name) =>
      new Promise<ProcessMutex | null>((resolve, reject) => {
        assertMutexName(name);
        const server = createServer((socket) => {
          // Nobody talks to a mutex; a probe that connects is dropped.
          socket.destroy();
        });
        const onListenError = (error: Error): void => {
          if (errorCode(error) === 'EADDRINUSE') resolve(null);
          else reject(error);
        };
        server.once('error', onListenError);
        server.listen(addressOf(name), () => {
          server.removeListener('error', onListenError);
          server.on('error', () => undefined);
          // A held mutex must not keep a finished CLI alive: the operating system releases it with the process.
          server.unref();
          let released = false;
          resolve({
            name,
            release: () =>
              new Promise<void>((done) => {
                if (released) {
                  done();
                  return;
                }
                released = true;
                server.close(() => {
                  done();
                });
              }),
          });
        });
      }),
  };
}

const LockFileSchema = z.object({ pid: z.number().int(), nonce: z.string(), createdAt: z.number() });
type LockFile = z.infer<typeof LockFileSchema>;

/** A lock file whose content cannot be read is held for this long (its creator may still be writing it). */
const UNREADABLE_GRACE_MS = 10_000;

export interface LockFileDeps {
  /** Folder of the lock files (`$MCS_HOME/locks/mutex`). */
  dir: string;
  pidAlive(pid: number): boolean;
  /** Pid written into the files (default `process.pid`). */
  pid?: number;
  /** Epoch ms (default `Date.now`). */
  now?: () => number;
}

/**
 * `<dir>/<name>.lock` created with `wx`, holding `{pid, nonce, createdAt}`. A lock whose pid is dead is stale: it is
 * renamed to `<name>.stale-<nonce>`, the nonce of the renamed file is checked again, and the file is removed. There is a
 * narrow race between reading and renaming (documented, UNVERIFIED).
 */
export function createLockFileBackend(deps: LockFileDeps): MutexBackend {
  const ownPid = deps.pid ?? process.pid;
  const now = deps.now ?? Date.now;

  async function readLock(file: string): Promise<LockFile | null> {
    try {
      const parsed = LockFileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function holder(name: string, file: string, nonce: string): ProcessMutex {
    let released = false;
    return {
      name,
      release: async () => {
        if (released) return;
        released = true;
        // Only remove our own file: after a takeover the file belongs to somebody else.
        const current = await readLock(file);
        if (current?.nonce !== nonce) return;
        try {
          await unlink(file);
        } catch {
          // Already gone.
        }
      },
    };
  }

  /** What a lock file that exists means: held, gone in the meantime, or stale (with the nonce read from it). */
  async function judge(file: string): Promise<'held' | 'gone' | { stale: string | null }> {
    const lock = await readLock(file);
    if (lock !== null) return deps.pidAlive(lock.pid) ? 'held' : { stale: lock.nonce };
    try {
      const info = await stat(file);
      return now() - info.mtimeMs < UNREADABLE_GRACE_MS ? 'held' : { stale: null };
    } catch {
      return 'gone';
    }
  }

  return {
    tryAcquire: async (name) => {
      assertMutexName(name);
      await mkdir(deps.dir, { recursive: true });
      const file = path.join(deps.dir, `${name}.lock`);
      for (let round = 0; round < 4; round += 1) {
        const nonce = randomBytes(8).toString('hex');
        try {
          const handle = await open(file, 'wx');
          try {
            await handle.writeFile(JSON.stringify({ pid: ownPid, nonce, createdAt: now() }));
          } finally {
            await handle.close();
          }
          return holder(name, file, nonce);
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        const verdict = await judge(file);
        if (verdict === 'held') return null;
        if (verdict === 'gone') continue;
        const staleFile = path.join(deps.dir, `${name}.stale-${verdict.stale ?? 'unreadable'}`);
        try {
          await rename(file, staleFile);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        const moved = await readLock(staleFile);
        if ((moved?.nonce ?? null) !== verdict.stale) {
          // A fresh lock was created between the read and the rename and we moved it: put it back if the name is free.
          try {
            await link(staleFile, file);
          } catch {
            // Somebody already took the name again; their lock stands.
          }
          await unlink(staleFile).catch(() => undefined);
          return null;
        }
        await unlink(staleFile).catch(() => undefined);
      }
      return null;
    },
  };
}

export interface MutexApiDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** In [0, 1): the jitter of the polling interval. */
  random(): number;
}

export interface MutexApi {
  tryAcquireMutex(name: string): Promise<ProcessMutex | null>;
  acquireMutex(name: string, o: AcquireOptions): Promise<ProcessMutex>;
}

const POLL_MIN_MS = 25;
const POLL_JITTER_MS = 25;

/** `tryAcquireMutex` and `acquireMutex` over one backend. `acquireMutex` polls every 25-50 ms. */
export function createMutexApi(
  backend: MutexBackend,
  deps: MutexApiDeps = { now: () => performance.now(), sleep: (ms) => sleepMs(ms), random: () => Math.random() },
): MutexApi {
  return {
    tryAcquireMutex: (name) => backend.tryAcquire(name),
    acquireMutex: async (name, o) => {
      const started = deps.now();
      for (;;) {
        const mutex = await backend.tryAcquire(name);
        if (mutex !== null) return mutex;
        const waited = deps.now() - started;
        if (waited >= o.timeoutMs) throw new MutexTimeoutError(name, waited);
        try {
          o.onWait?.(waited);
        } catch {
          // A progress printer must not break the wait.
        }
        await deps.sleep(Math.min(POLL_MIN_MS + deps.random() * POLL_JITTER_MS, o.timeoutMs - waited));
      }
    },
  };
}

function defaultBackend(): MutexBackend {
  if (hostPlatform === 'win32' || hostPlatform === 'linux') {
    return createSocketBackend((name) => socketAddress(hostPlatform, name) ?? name);
  }
  return createLockFileBackend({ dir: path.join(resolveMcsHome(process.env), 'locks', 'mutex'), pidAlive });
}

let api: MutexApi | undefined;

function realApi(): MutexApi {
  api ??= createMutexApi(defaultBackend());
  return api;
}

/** Takes the mutex now, or answers null when another process holds it. */
export function tryAcquireMutex(name: string): Promise<ProcessMutex | null> {
  return realApi().tryAcquireMutex(name);
}

/** Waits up to `timeoutMs` for the mutex (polling every 25-50 ms); a `MutexTimeoutError` when it stays taken. */
export function acquireMutex(name: string, o: AcquireOptions): Promise<ProcessMutex> {
  return realApi().acquireMutex(name, o);
}
