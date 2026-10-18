// Legacy-compatible repo and task workspaces, and tree snapshots (05 4.4, 01 1.1). Everything written is synthetic.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import { InstanceFileSchema, RUNTIME_VERSION, isValidSlug, isoSecondsZ, type InstanceFile } from '@mcs/shared';

import { FIXTURE_EPOCH_MS } from './clock.ts';
import { writeFixtureMarker } from './temp.ts';
import { detUuid } from './transcript.ts';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Makes `root` a monitored repo: `<root>/.claude/monitor/tasks` exists and the folder carries the FIXTURE marker. */
export function buildRepo(root: string): { repo: string; tasksRoot: string } {
  const tasksRoot = join(root, '.claude', 'monitor', 'tasks');
  mkdirSync(tasksRoot, { recursive: true });
  writeFixtureMarker(root);
  return { repo: root, tasksRoot };
}

/**
 * Writes `<repo>/.claude/monitor/tasks/<slug>/` as a pre-4.0 monitor laid it out: `task.json`, `config.json` (with
 * `schema_version: 1` first), `README.md`, and `runtime.json` when `runtime` is given. With `instance` it also writes a
 * complete `instance.json`, validated by `InstanceFileSchema` (defaults of 05 4.4, keys in schema order); a workspace
 * without `instance.json` is a pre-4.0 workspace. Returns the workspace path.
 */
export function buildTaskWorkspace(
  repo: string,
  opts: {
    slug: string;
    config: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    instance?: Partial<InstanceFile>;
  },
): string {
  if (!isValidSlug(opts.slug)) throw new RangeError(`buildTaskWorkspace: '${opts.slug}' is not a valid slug`);
  const ws = join(repo, '.claude', 'monitor', 'tasks', opts.slug);
  const existing = lstatSync(ws, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() === true)
    throw new Error(`buildTaskWorkspace: ${ws} is a link; refusing to write through it`);
  mkdirSync(ws, { recursive: true });
  const created = isoSecondsZ(FIXTURE_EPOCH_MS);
  writeJson(join(ws, 'task.json'), {
    schema_version: 1,
    id: opts.slug,
    name: `FIXTURE ${opts.slug}`,
    description: '',
    created,
    repo: relative(ws, repo).split(sep).join('/'),
    links: [],
  });
  writeJson(join(ws, 'config.json'), { schema_version: 1, ...opts.config });
  writeFileSync(join(ws, 'README.md'), `FIXTURE task workspace ${opts.slug}\n`);
  if (opts.runtime !== undefined) writeJson(join(ws, 'runtime.json'), { schema_version: 1, ...opts.runtime });
  if (opts.instance !== undefined) {
    const merged: Record<string, unknown> = {
      schema_version: 1,
      instanceId: detUuid(`instance:${opts.slug}`, 0),
      slug: opts.slug,
      createdAt: created,
      createdBy: `mcs ${RUNTIME_VERSION}`,
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: 0,
      engine: 'node',
      hooks: { enabled: false },
      upgradedAt: null,
      ...opts.instance,
    };
    const ordered = Object.fromEntries(Object.keys(InstanceFileSchema.shape).map((key) => [key, merged[key]]));
    writeJson(join(ws, 'instance.json'), InstanceFileSchema.parse(ordered));
  }
  return ws;
}

function excluded(rel: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return rel === prefix || rel.startsWith(`${prefix}/`);
    }
    if (pattern.startsWith('*')) return basename(rel).endsWith(pattern.slice(1));
    return rel === pattern;
  });
}

/**
 * sha256 over the relative path and bytes of everything under `dir` (folders and links count too, links are not followed).
 * `exclude` entries: an exact relative path, `<folder>/**` for a whole folder, or `*<suffix>` for file names; paths use `/`.
 */
export function snapshotTree(dir: string, opts: { exclude?: readonly string[] } = {}): string {
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`snapshotTree: ${dir} does not exist or is not a folder`);
  }
  const patterns = opts.exclude ?? [];
  const hash = createHash('sha256');
  const walk = (current: string, prefix: string): void => {
    const names = readdirSync(current).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (excluded(rel, patterns)) continue;
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        hash.update(`l\0${rel}\0${readlinkSync(full)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        walk(full, rel);
      } else {
        const bytes = readFileSync(full);
        hash.update(`f\0${rel}\0${String(bytes.length)}\0`);
        hash.update(bytes);
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}
