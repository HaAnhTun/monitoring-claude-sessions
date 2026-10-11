// The best-effort nudge `POST /api/v3/ingest/nudge` (02 2.2 steps 12-13, 2.8). The body names the instance and carries no
// event data; the handler never reads the answer and never retries.
import { request } from 'node:http';

import { NUDGE_TIMEOUT_MS, type HookRouteV1 } from '@mcs/shared/protocol';

import { readBounded } from './routes-reader.ts';

const STATE_FILE_MAX_BYTES = 4096;
const NUDGE_PATH = '/api/v3/ingest/nudge';

export interface NudgeTarget {
  instanceId: string;
  port: number;
}

/**
 * The server to nudge for a route: only a running route (`stoppedAt === null`) whose `state.json` (at most 4 KiB) names
 * this instance, `engine: "node"` and a port in 1..65535. `null` for anything else, including unreadable files.
 */
export function readNudgeTarget(route: HookRouteV1): NudgeTarget | null {
  if (route.stoppedAt !== null) return null;
  try {
    const bytes = readBounded(route.stateFile, STATE_FILE_MAX_BYTES);
    if (bytes === null) return null;
    const state: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
    const port: unknown = Reflect.get(state, 'port');
    if (Reflect.get(state, 'instanceId') !== route.instanceId || Reflect.get(state, 'engine') !== 'node') return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { instanceId: route.instanceId, port };
  } catch {
    return null;
  }
}

/**
 * One POST. Resolves on the first of: response headers, request flushed (`finish`), `error`, `timeoutMs`. Never rejects.
 * The request is not destroyed on a flush: the bytes are already with the operating system, and closing early could cost them.
 */
export function nudge(target: NudgeTarget, timeoutMs: number = NUDGE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ instanceId: target.instanceId });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    try {
      const req = request({
        host: '127.0.0.1',
        port: target.port,
        method: 'POST',
        path: NUDGE_PATH,
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      timer = setTimeout(() => {
        settle();
        req.destroy();
      }, timeoutMs);
      req.on('response', (res) => {
        res.resume();
        settle();
      });
      req.on('finish', settle);
      req.on('error', settle);
      req.end(body);
    } catch {
      settle();
    }
  });
}

/** Every target in parallel; resolves when all have settled (each within `timeoutMs`). */
export async function nudgeAll(targets: readonly NudgeTarget[], timeoutMs: number = NUDGE_TIMEOUT_MS): Promise<void> {
  await Promise.all(targets.map((target) => nudge(target, timeoutMs)));
}
