// Workspace resolution (01 3.1, 3.2): slug rules, containment, links, the task mutex. Unit rows T-ISO-01 and T-ISO-02.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { McsError } from '@mcs/shared';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { ConfigWorkspace } from '../config/resolve.ts';
import { canonicalPath } from '../platform/paths.ts';
import { mutexName, tryAcquireMutex } from '../platform/mutex.ts';
import {
  WORKSPACE_DIRS,
  checkSlug,
  resolveWorkspace,
  slugify,
  tasksRootOf,
  withTaskMutex,
  workspacePath,
} from './paths.ts';

const makeTemp = useTempDirs();

/** A tasks root with workspaces `a` and `b`, each holding a marker file. */
function twoWorkspaces(): { root: string; a: string; b: string; base: string } {
  const base = makeTemp('paths').path;
  const root = path.join(base, '.claude', 'monitor', 'tasks');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(path.join(a, 'task.json'), '{}');
  writeFileSync(path.join(b, 'task.json'), '{}');
  return { root, a, b, base };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'RETURNED';
}

describe('slugify and checkSlug', () => {
  it('slugify is the legacy function (re-exported from shared, not a copy)', () => {
    expect(slugify('Nightly build: Steps A/B')).toBe('nightly-build-steps-a-b');
    expect(slugify('')).toBe('task');
  });

  it('checkSlug returns a valid slug and refuses everything else with the legacy message', () => {
    expect(checkSlug('nightly-build')).toBe('nightly-build');
    expect(() => checkSlug('Bad Slug')).toThrow(
      "invalid task slug 'Bad Slug' (use lowercase letters, digits and hyphens, at most 48 characters)",
    );
    expect(() => checkSlug("it's")).toThrow(
      'invalid task slug "it\'s" (use lowercase letters, digits and hyphens, at most 48 characters)',
    );
    expect(codeOf(() => checkSlug(42))).toBe('SLUG_INVALID');
    expect(codeOf(() => checkSlug(null))).toBe('SLUG_INVALID');
  });
});

describe('tasksRootOf and workspacePath', () => {
  it('the tasks root is <repo>/.claude/monitor/tasks as an absolute path', () => {
    const repo = path.resolve('some', 'repo');
    expect(tasksRootOf(repo)).toBe(path.join(repo, '.claude', 'monitor', 'tasks'));
  });

  it('workspacePath joins below the workspace folder', () => {
    const { root } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    expect(workspacePath(ws, 'audit', 'changes.md')).toBe(path.join(ws.dir, 'audit', 'changes.md'));
  });

  it('the workspace tree lists data/exports (registry C39)', () => {
    expect(WORKSPACE_DIRS).toEqual(
      expect.arrayContaining(['audit', 'data', 'data/spool', 'data/backups', 'data/exports', 'logs', 'run']),
    );
  });
});

describe('resolveWorkspace', () => {
  it('returns the handle of an existing workspace', () => {
    const { root, a } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    expect(ws.slug).toBe('a');
    expect(ws.root).toBe(path.resolve(root));
    expect(ws.dir).toBe(a);
    expect(ws.realDir).toBe(canonicalPath(a));
  });

  it('resolves a workspace that does not exist yet (init) without creating anything', () => {
    const base = makeTemp('paths').path;
    const root = path.join(base, 'tasks-not-created');
    const ws = resolveWorkspace(root, 'new-one');
    expect(ws.dir).toBe(path.join(path.resolve(root), 'new-one'));
    expect(ws.realDir).toBe(canonicalPath(path.join(root, 'new-one')));
    expect(readdirSync(base)).toEqual(['FIXTURE.md']);
  });

  it('satisfies the ConfigWorkspace that resolveConfig takes', () => {
    const { root } = twoWorkspaces();
    const asConfig: ConfigWorkspace = resolveWorkspace(root, 'a');
    expect(asConfig.dir).toBe(path.join(path.resolve(root), 'a'));
  });

  it('makes a relative root absolute', () => {
    const ws = resolveWorkspace(path.join('rel', 'tasks'), 'a');
    expect(path.isAbsolute(ws.root)).toBe(true);
    expect(path.isAbsolute(ws.dir)).toBe(true);
  });

  it('T-ISO-01: hostile slugs throw SLUG_INVALID and nothing is created', () => {
    const { root, base } = twoWorkspaces();
    const before = readdirSync(root).sort();
    const hostile = [
      '../b',
      'b/../a',
      'a\\b',
      'C:b',
      '.b',
      'con',
      'com1',
      'lpt9',
      'nul',
      'x'.repeat(49),
      'UPPER',
      '',
      'a b',
      'a/b',
      '-a',
      'a\n',
      'a\0',
    ];
    for (const slug of hostile) {
      expect(
        codeOf(() => resolveWorkspace(root, slug)),
        JSON.stringify(slug),
      ).toBe('SLUG_INVALID');
    }
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readdirSync(path.dirname(root)).sort()).toEqual(['tasks']);
    expect(readdirSync(base).sort()).toEqual(['.claude', 'FIXTURE.md']);
  });

  it('accepts the longest slug (48 characters) and hyphens inside', () => {
    const { root } = twoWorkspaces();
    expect(resolveWorkspace(root, 'x'.repeat(48)).slug).toBe('x'.repeat(48));
    expect(resolveWorkspace(root, 'a-b-1').slug).toBe('a-b-1');
  });

  it('T-ISO-02: a workspace that is a link to a sibling throws WORKSPACE_SYMLINK and the sibling is untouched', () => {
    const { root, b } = twoWorkspaces();
    makeJunction(path.join(root, 'c'), b);
    expect(codeOf(() => resolveWorkspace(root, 'c'))).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(b)).toEqual(['task.json']);
  });

  it('a workspace that is a link to a folder outside the tasks root throws WORKSPACE_ESCAPE', () => {
    const { root, base } = twoWorkspaces();
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    makeJunction(path.join(root, 'out'), outside);
    expect(codeOf(() => resolveWorkspace(root, 'out'))).toBe('WORKSPACE_ESCAPE');
  });

  it('a dangling link is refused as a link', () => {
    const { root, base } = twoWorkspaces();
    const gone = path.join(base, 'gone');
    mkdirSync(gone);
    makeJunction(path.join(root, 'dangling'), gone);
    // The target disappears after the link was made.
    rmSync(gone, { recursive: true });
    expect(codeOf(() => resolveWorkspace(root, 'dangling'))).toBe('WORKSPACE_SYMLINK');
  });

  it('the tasks root itself may be a link (user choice)', () => {
    const { root, base } = twoWorkspaces();
    const alias = path.join(base, 'alias-tasks');
    makeJunction(alias, root);
    const ws = resolveWorkspace(alias, 'a');
    expect(ws.slug).toBe('a');
    expect(ws.realDir).toBe(canonicalPath(path.join(root, 'a')));
  });

  it('T-SEC-04: a link planted as audit/ or data/ inside a workspace is refused', () => {
    const { root, a, base } = twoWorkspaces();
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(elsewhere);
    makeJunction(path.join(a, 'audit'), elsewhere);
    expect(codeOf(() => resolveWorkspace(root, 'a'))).toBe('WORKSPACE_SYMLINK');
  });

  it('T-SEC-04: a link planted as data/ is refused too', () => {
    const { root, b, base } = twoWorkspaces();
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(elsewhere);
    makeJunction(path.join(b, 'data'), elsewhere);
    expect(codeOf(() => resolveWorkspace(root, 'b'))).toBe('WORKSPACE_SYMLINK');
  });
});

describe('withTaskMutex', () => {
  it('the mutex key is the canonical workspace path (01 4.2)', async () => {
    const { root } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    await withTaskMutex(ws, async () => {
      expect(await tryAcquireMutex(mutexName('task', canonicalPath(ws.dir)))).toBeNull();
    });
    const free = await tryAcquireMutex(mutexName('task', canonicalPath(ws.dir)));
    expect(free).not.toBeNull();
    await free?.release();
  });

  it('returns what the function returns and releases the mutex when it throws', async () => {
    const { root } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    expect(await withTaskMutex(ws, () => Promise.resolve(7))).toBe(7);
    await expect(
      withTaskMutex(ws, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const free = await tryAcquireMutex(mutexName('task', ws.realDir));
    expect(free).not.toBeNull();
    await free?.release();
  });

  it('is reentrant inside one async chain: the caller holds it and the audit writer takes it again', async () => {
    const { root } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    const value = await withTaskMutex(
      ws,
      () =>
        withTaskMutex(ws, () => withTaskMutex(ws, () => Promise.resolve('inner'), { timeoutMs: 500 }), {
          timeoutMs: 500,
        }),
      { timeoutMs: 500 },
    );
    expect(value).toBe('inner');
  });

  it('excludes a second async chain of the same process until the first lets go', async () => {
    const { root } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withTaskMutex(ws, async () => {
      events.push('first in');
      entered();
      await gate;
      events.push('first out');
    });
    await inside;
    const timedOut = await withTaskMutex(ws, () => Promise.resolve('never'), { timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(timedOut).toBeInstanceOf(McsError);
    expect(timedOut).toMatchObject({ details: { reason: 'MUTEX_TIMEOUT' } });
    const second = withTaskMutex(ws, () => {
      events.push('second in');
      return Promise.resolve();
    });
    release();
    await first;
    await second;
    expect(events).toEqual(['first in', 'first out', 'second in']);
  });

  it('work that was started inside the holder and runs after it let go does not count as holding the mutex', async () => {
    const { root } = twoWorkspaces();
    const ws = resolveWorkspace(root, 'a');
    let leaked: Promise<string> = Promise.resolve('unset');
    await withTaskMutex(ws, () => {
      // The continuation inherits the async context of the holder but runs once the holder is done.
      leaked = delay(150).then(() => withTaskMutex(ws, () => Promise.resolve('ran'), { timeoutMs: 80 }));
      return Promise.resolve();
    });
    const otherHolder = withTaskMutex(ws, () => delay(400), { timeoutMs: 500 });
    const error = await leaked.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ details: { reason: 'MUTEX_TIMEOUT' } });
    await otherHolder;
  });

  it('different workspaces never block each other', async () => {
    const { root } = twoWorkspaces();
    const a = resolveWorkspace(root, 'a');
    const b = resolveWorkspace(root, 'b');
    const result = await withTaskMutex(a, () => withTaskMutex(b, () => Promise.resolve('both'), { timeoutMs: 500 }));
    expect(result).toBe('both');
  });
});
