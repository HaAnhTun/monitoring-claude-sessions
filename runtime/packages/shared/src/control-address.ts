// The control address of an instance (01 4.3, ADR 0005): the name of the pipe or socket that is at once the instance lock, the
// identity probe and the way to stop the server. The server listens on it, the engine probe and the CLI connect to it, so the
// rule lives here once. Pure: no zod and no Node import; the host (platform, temp folder, user id) is a parameter, and each
// package has a one-line wrapper that supplies the host it runs on.
import { UUID_V4_RE } from './ids.ts';

/** What the address depends on; tests pass other hosts. */
export interface AddressHost {
  readonly platform: 'win32' | 'linux' | 'darwin' | 'other';
  readonly tmpdir: string;
  /** The user id on POSIX, `null` on Windows. */
  readonly uid: number | null;
}

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
const WINDOWS_PIPE_PREFIX = [BACKSLASH, BACKSLASH, '.', BACKSLASH, 'pipe', BACKSLASH, 'mcs-'].join('');

/** `<tmpdir><sep>mcs-<uid><sep><id>.sock` with the separator the temp folder itself uses (no `node:path` here). */
function socketFile(host: AddressHost, instanceId: string): string {
  const sep = host.tmpdir.includes('/') || !host.tmpdir.includes(BACKSLASH) ? '/' : BACKSLASH;
  let base = host.tmpdir;
  while (base.length > 0 && (base.endsWith('/') || base.endsWith(BACKSLASH))) base = base.slice(0, -1);
  return `${base}${sep}mcs-${String(host.uid ?? 0)}${sep}${instanceId}.sock`;
}

/**
 * Windows `\.\pipe\mcs-<instanceId>`; Linux the abstract socket `\0mcs-<instanceId>` (the kernel frees it with the process);
 * other POSIX `<tmpdir>/mcs-<uid>/<instanceId>.sock` (a folder of mode 0700). The id becomes part of a path, so only a version 4
 * uuid is accepted (`RangeError` otherwise).
 */
export function controlAddress(instanceId: string, host: AddressHost): string {
  if (!UUID_V4_RE.test(instanceId)) throw new RangeError('controlAddress: the instance id is not a version 4 uuid');
  switch (host.platform) {
    case 'win32':
      return `${WINDOWS_PIPE_PREFIX}${instanceId}`;
    case 'linux':
      return `${NUL}mcs-${instanceId}`;
    case 'darwin':
    case 'other':
      return socketFile(host, instanceId);
  }
}
