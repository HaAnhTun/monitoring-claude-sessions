// `<ws>/state.json` of the Node runtime (01 1.7, 4.4 step 10, 4.6, 4.13): the exact bytes, the atomic write, and the decision
// about a file that is already there when the server boots. The legacy engine writes seven keys and its readers do not retry
// (E5), so the Node server writes those seven first, in the same order, then its own keys; the file is replaced atomically
// and only after the HTTP port is bound, so a reader never sees a port that is not ours.
import {
  commandLineOf,
  fromPlain,
  hasLegacyMarker,
  isMissingFileError,
  pidAlive,
  pyJsonFileText,
  readSmallFile,
  writeWorkspaceFile,
  type PyJsonValue,
} from '@mcs/engine';
import { StateFileSchema, isoMsZ, type StateFile } from '@mcs/shared';

export const STATE_FILE_NAME = 'state.json';

/** A state file larger than this is not a state file (the real one is under 1 KiB). */
const STATE_FILE_MAX_BYTES = 64 * 1024;

/** What the server knows about itself once the port is bound. */
export interface StateFileInput {
  readonly pid: number;
  readonly port: number;
  readonly startedAtMs: number;
  readonly runtimeVersion: string;
  /** From `runtime/.mcs-build.json` at boot. */
  readonly codeStamp: string;
  readonly slug: string;
  readonly instanceId: string;
  readonly nodeVersion: string;
  /** The control channel address (01 4.3), informational. */
  readonly control: string;
}

export interface BuiltStateFile {
  /** Python-compatible JSON (indent 2, one LF): the bytes the watchdog compares against the file. */
  readonly bytes: Uint8Array;
  readonly state: StateFile;
}

/**
 * The content of 01 1.7: `{pid, url, port, started, version, task, config}` in the legacy order and types (`started` is a
 * float, like Python's `time.time()`, even when it is a whole number of seconds), then the Node keys. Refuses a value the
 * shared schema cannot hold (nothing is written then).
 */
export function buildStateFile(input: StateFileInput): BuiltStateFile {
  const plain: Record<string, unknown> = {
    pid: input.pid,
    url: `http://127.0.0.1:${String(input.port)}`,
    port: input.port,
    started: input.startedAtMs / 1000,
    version: input.runtimeVersion,
    task: input.slug,
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId: input.instanceId,
    runtimeVersion: input.runtimeVersion,
    codeStamp: input.codeStamp,
    startedAt: isoMsZ(input.startedAtMs),
    nodeVersion: input.nodeVersion,
    control: input.control,
  };
  const state = StateFileSchema.parse(plain);
  const document: PyJsonValue = {
    k: 'obj',
    v: Object.entries(plain).map(([key, value]): [string, PyJsonValue] => [
      key,
      key === 'started' && typeof value === 'number' ? { k: 'float', v: value } : fromPlain(value),
    ]),
  };
  return { bytes: new TextEncoder().encode(pyJsonFileText(document)), state };
}

/** Replaces `file` atomically with exactly the built bytes (a link as the file or its folder is refused). */
export function writeStateFile(file: string, built: BuiltStateFile): Promise<void> {
  return writeWorkspaceFile(file, built.bytes);
}

// ---- a file that is already there at boot ----------------------------------------------------------------------------------

/**
 * `absent`: no file. `stale`: not ours and not worth keeping (damaged, a dead process, a reused pid, our own pid): the boot
 * overwrites it, and a previous run that left it behind ended without a clean shutdown (01 4.13). `conflict`: a live legacy
 * viewer wrote it (a `$V serve` that bypassed the checks): the boot leaves it alone, says so, and keeps serving.
 */
export type ExistingState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'stale'; readonly reason: 'unparsable' | 'dead_pid' | 'own_pid' | 'foreign_pid' }
  | { readonly kind: 'conflict'; readonly pid: number };

/** The process helpers the decision uses; tests pass fakes. */
export interface ExistingStateDeps {
  readonly selfPid: number;
  pidAlive(pid: number): boolean;
  /** The command line of a process, or null when it cannot be read. */
  commandLineOf(pid: number): Promise<string | null>;
  hasLegacyMarker(commandLine: string): boolean;
}

const REAL_DEPS: ExistingStateDeps = {
  selfPid: process.pid,
  pidAlive,
  commandLineOf,
  hasLegacyMarker,
};

function parseState(bytes: Uint8Array): StateFile | null {
  try {
    const parsed = StateFileSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Looks at `state.json` before this process writes its own. A live process is a conflict only when its command line carries
 * the legacy marker (`viewer.py`, 01 4.1): a pid alone proves nothing (INV-04), and Windows reuses pids quickly, so a stranger
 * that holds the pid of a run that crashed must not block the start. A command line that cannot be read is treated as a
 * stranger for the same reason.
 */
export async function readExistingState(file: string, deps: Partial<ExistingStateDeps> = {}): Promise<ExistingState> {
  const d: ExistingStateDeps = { ...REAL_DEPS, ...deps };
  let bytes: Buffer;
  try {
    bytes = await readSmallFile(file, STATE_FILE_MAX_BYTES);
  } catch (error) {
    if (isMissingFileError(error)) return { kind: 'absent' };
    return { kind: 'stale', reason: 'unparsable' };
  }
  const state = parseState(bytes);
  if (state === null) return { kind: 'stale', reason: 'unparsable' };
  if (state.pid === d.selfPid) return { kind: 'stale', reason: 'own_pid' };
  if (!d.pidAlive(state.pid)) return { kind: 'stale', reason: 'dead_pid' };
  const commandLine = await d.commandLineOf(state.pid);
  if (commandLine !== null && d.hasLegacyMarker(commandLine)) return { kind: 'conflict', pid: state.pid };
  return { kind: 'stale', reason: 'foreign_pid' };
}
