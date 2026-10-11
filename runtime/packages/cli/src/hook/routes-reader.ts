// Reads `$MCS_HOME/routes/*.json` (02 2.6.2, 2.2 step 5). The handler has no zod, so the route shape is checked by hand.
import { closeSync, openSync, readSync, readdirSync } from 'node:fs';

import { ROUTES_MAX_FILES, ROUTE_FILE_MAX_BYTES, type HookRouteV1 } from '@mcs/shared/protocol';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TRANSCRIPT_DIRS = 8;
const MAX_SESSION_IDS = 256;

/** Reported to the caller, which turns them into handler log lines. */
export type RouteProblem = { code: 'ROUTES_UNREADABLE'; detail: string } | { code: 'ROUTE_INVALID'; detail: string };

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const list: unknown[] = value;
  return list.every((item): item is string => typeof item === 'string') ? list : null;
}

function timestampOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The route in `text`, or `null` when it is not a version 1 route file named `<instanceId>.json`. */
export function parseRoute(text: string, fileName: string): HookRouteV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw['v'] !== 1) return null;
  const { instanceId, workspace, spoolDir, stateFile, enabled, match, updatedAt } = raw;
  if (typeof instanceId !== 'string' || !UUID_RE.test(instanceId) || fileName !== `${instanceId}.json`) return null;
  if (typeof workspace !== 'string' || typeof spoolDir !== 'string' || typeof stateFile !== 'string') return null;
  if (workspace === '' || typeof enabled !== 'boolean' || !isRecord(match)) return null;
  const transcriptsDirs = stringList(match['transcriptsDirs'], MAX_TRANSCRIPT_DIRS);
  const sessionIds = stringList(match['sessionIds'], MAX_SESSION_IDS);
  const stoppedAt = timestampOrNull(raw['stoppedAt']);
  const spoolUntil = timestampOrNull(raw['spoolUntil']);
  if (transcriptsDirs === null || sessionIds === null) return null;
  if (stoppedAt === undefined || spoolUntil === undefined) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  return {
    v: 1,
    instanceId,
    workspace,
    spoolDir,
    stateFile,
    enabled,
    match: { transcriptsDirs, sessionIds },
    stoppedAt,
    spoolUntil,
    updatedAt,
  };
}

/** Reads at most `maxBytes + 1` bytes: more than `maxBytes` means the file is too large. */
export function readBounded(path: string, maxBytes: number): Buffer | null {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    return filled > maxBytes ? null : buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

function loadRoute(path: string, name: string): HookRouteV1 | null {
  try {
    const bytes = readBounded(path, ROUTE_FILE_MAX_BYTES);
    return bytes === null ? null : parseRoute(bytes.toString('utf8'), name);
  } catch {
    return null;
  }
}

/**
 * Every valid route file of `<mcsHome>/routes` (at most `ROUTES_MAX_FILES`, in name order, each at most 16 KiB). A missing
 * folder is silence; an unreadable folder or an invalid file is reported through `onProblem` and skipped.
 */
export function readRoutes(mcsHome: string, onProblem: (problem: RouteProblem) => void): HookRouteV1[] {
  const dir = `${mcsHome}/routes`;
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(0, ROUTES_MAX_FILES);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT')
      onProblem({ code: 'ROUTES_UNREADABLE', detail: typeof code === 'string' ? code : 'readdir' });
    return [];
  }
  const routes: HookRouteV1[] = [];
  for (const name of names) {
    const route = loadRoute(`${dir}/${name}`, name);
    if (route === null) onProblem({ code: 'ROUTE_INVALID', detail: name });
    else routes.push(route);
  }
  return routes;
}
