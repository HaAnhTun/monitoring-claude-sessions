// Workspace identity and resolution (01 3.1, 3.2): the slug rules, the handle every command works with, the refusal of
// links below the tasks root, and the task mutex that serializes writers (01 4.2).
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import { McsError, SLUG_RULE_TEXT, isValidSlug } from '@mcs/shared';

import { MutexTimeoutError, acquireMutex, mutexName } from '../platform/mutex.ts';
import { canonicalPath } from '../platform/paths.ts';
import { quoteText } from '../json/index.ts';
import { assertNotLink, isLink } from './fsio.ts';

/** The legacy `slugify` is `@mcs/shared`'s; it is re-exported here because registry 2.1 names this module as its home. */
export { slugify } from '@mcs/shared';

/** The JSON files of a workspace (01 1.1); none of them may be a link. */
export const WORKSPACE_JSON_FILES = [
  'task.json',
  'config.json',
  'runtime.json',
  'instance.json',
  'state.json',
] as const;

/**
 * The folders of the workspace tree (01 1.1, registry 9.1, C39), relative with `/`. None of them may be a link:
 * `data/exports/` holds the export snapshots of the server and is runtime-mutable like the rest of `data/`.
 */
export const WORKSPACE_DIRS = ['audit', 'data', 'data/spool', 'data/backups', 'data/exports', 'logs', 'run'] as const;

/** Files below the workspace that the engines read or append to; none of them may be a link. */
const WORKSPACE_GUARDED_FILES = ['audit/changes.md', 'audit/decisions.md', 'run/control.token'] as const;

/** How long a command waits for another command of the same workspace (a CLI waits, a hook never calls this). */
export const TASK_MUTEX_TIMEOUT_MS = 30_000;

/** `<repo>/.claude/monitor/tasks`, absolute (legacy `tasks_root`). */
export function tasksRootOf(repo: string): string {
  return path.join(path.resolve(repo), '.claude', 'monitor', 'tasks');
}

/**
 * The slug of a workspace or `SLUG_INVALID` with the legacy message. Accepts any value because the slug may come straight
 * from a command line or a JSON file.
 */
export function checkSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !isValidSlug(slug)) {
    const shown = typeof slug === 'string' ? quoteText(slug) : String(slug);
    throw new McsError('SLUG_INVALID', `invalid task slug ${shown} (${SLUG_RULE_TEXT})`);
  }
  return slug;
}

/** What `resolveWorkspace` returns: a validated name and place, not a promise that the folder exists. */
export interface WorkspaceRef {
  readonly slug: string;
  /** The tasks root as an absolute path (as given, not resolved through links: the root itself may be a link). */
  readonly root: string;
  /** `<root>/<slug>`: where the files are read and written. */
  readonly dir: string;
  /** `canonicalPath(dir)`: the identity of the workspace, and the key of its task mutex (01 4.2). */
  readonly realDir: string;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Validates `slug`, keeps the workspace inside `root` and refuses links (01 3.2): `SLUG_INVALID`, `WORKSPACE_ESCAPE` (a link
 * that leaves the tasks root), `WORKSPACE_SYMLINK` (any other link at the workspace, at one of its JSON files or folders,
 * or at an audit file). Reads nothing but link status and creates nothing, so it also resolves a workspace that `init`
 * has yet to create. The tasks root itself may be a link.
 */
export function resolveWorkspace(root: string, slug: string): WorkspaceRef {
  const checked = checkSlug(slug);
  const absoluteRoot = path.resolve(root);
  const dir = path.join(absoluteRoot, checked);
  const realRoot = canonicalPath(absoluteRoot);
  const realDir = canonicalPath(dir);

  if (isLink(dir)) {
    const escapes = !isInside(realRoot, realDir);
    throw new McsError(
      escapes ? 'WORKSPACE_ESCAPE' : 'WORKSPACE_SYMLINK',
      escapes
        ? `task folder ${dir} is a link that leaves the tasks root`
        : `task folder ${dir} is a link; a workspace is a real folder inside the tasks root`,
      { details: { slug: checked } },
    );
  }
  if (!isInside(realRoot, realDir)) {
    throw new McsError('WORKSPACE_ESCAPE', `task folder ${dir} is outside the tasks root`, {
      details: { slug: checked },
    });
  }
  for (const relative of [...WORKSPACE_JSON_FILES, ...WORKSPACE_DIRS, ...WORKSPACE_GUARDED_FILES]) {
    assertNotLink(path.join(dir, ...relative.split('/')));
  }
  return { slug: checked, root: absoluteRoot, dir, realDir };
}

/** `<workspace>/<segments...>`. */
export function workspacePath(ws: Pick<WorkspaceRef, 'dir'>, ...segments: string[]): string {
  return path.join(ws.dir, ...segments);
}

/**
 * A task mutex held by the current call chain. The chain of leases is the async context; `open` turns false when the
 * holder lets go, so a timer or promise that was started inside the holder and runs later cannot claim the mutex.
 */
interface Lease {
  readonly name: string;
  readonly parent: Lease | undefined;
  open: boolean;
}

const heldMutexes = new AsyncLocalStorage<Lease>();

function holds(lease: Lease | undefined, name: string): boolean {
  for (let l = lease; l !== undefined; l = l.parent) if (l.open && l.name === name) return true;
  return false;
}

/** `WORKSPACE_BUSY` for a task mutex that stayed held; the details of the timeout (name, waited time) are kept. */
function busyError(timeout: MutexTimeoutError): McsError {
  return new McsError('WORKSPACE_BUSY', 'another mcs command is changing this task', {
    hint: 'wait for the other command to finish, then try again',
    details: { ...timeout.details, reason: 'MUTEX_TIMEOUT' },
    cause: timeout,
  });
}

export interface TaskMutexOptions {
  /** Longest wait for another holder (default `TASK_MUTEX_TIMEOUT_MS`); `WORKSPACE_BUSY` after it. */
  readonly timeoutMs?: number;
}

/**
 * Runs `fn` while holding the task mutex of the workspace (`mutexName('task', realDir)`), the lock every writer of a
 * workspace takes around its whole read-validate-write-audit sequence (01 4.2, 6.2). The mutex is reentrant inside one
 * async call chain while it is held: a command that holds it can call the audit writer, which takes it again without
 * waiting for itself. Another call chain of the same process, or another process, waits; so does work that outlives `fn`.
 * A wait that runs out of time is `WORKSPACE_BUSY` (exit 1, details `{ reason: 'MUTEX_TIMEOUT', name, waitedMs }`), not an
 * internal error: another command is changing the task and the person can simply try again.
 */
export async function withTaskMutex<T>(
  ws: Pick<WorkspaceRef, 'realDir'>,
  fn: () => Promise<T>,
  o: TaskMutexOptions = {},
): Promise<T> {
  const name = mutexName('task', ws.realDir);
  const current = heldMutexes.getStore();
  if (holds(current, name)) return fn();
  const mutex = await acquireMutex(name, { timeoutMs: o.timeoutMs ?? TASK_MUTEX_TIMEOUT_MS }).catch(
    (error: unknown) => {
      if (error instanceof MutexTimeoutError) throw busyError(error);
      throw error;
    },
  );
  const lease: Lease = { name, parent: current, open: true };
  try {
    return await heldMutexes.run(lease, fn);
  } finally {
    lease.open = false;
    await mutex.release();
  }
}
