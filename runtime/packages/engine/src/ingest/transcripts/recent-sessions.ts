// The newest sessions of a transcripts folder for `discover` (01 6.4, legacy `recent_sessions`): id, age, size and the first
// real prompt of each main transcript. The prompt is returned whole: only the caller clips it, and it is never logged (a
// failure is logged by its errno code only). Like the rest of discovery, only regular files are read: a link is skipped.
import path from 'node:path';

import { SID_RE } from '@mcs/shared/protocol';

import { CLASSIFY_LINE_LIMIT, realFirstPrompt, type HeadRecord } from './classify.ts';
import { nodeDiscoveryFs, type DiscoveryFs, type EntryStat } from './discovery.ts';

/** One line of the `discover` session list (structurally the `DiscoveredSession` of `ops/workspace.ts`). */
export interface RecentSession {
  readonly id: string;
  readonly ageSeconds: number;
  readonly bytes: number;
  /** The first real user prompt ('' when there is none); clipped by the caller, never logged. */
  readonly firstPrompt: string;
}

/** The part of a logger this module uses: an event name and fields that never hold a prompt or a path. */
export interface RecentSessionsLog {
  debug(event: string, fields: Readonly<Record<string, string | number>>): void;
}

/** Bytes of the head that are read for the first prompt. */
const HEAD_BYTES = 2 * 1024 * 1024;

function headOf(bytes: Buffer): HeadRecord[] {
  const head: HeadRecord[] = [];
  const lines = bytes.toString('utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (lineNo > CLASSIFY_LINE_LIMIT) break;
    try {
      const record: unknown = JSON.parse(line);
      head.push({ lineNo, record });
    } catch {
      // an invalid line holds its place and nothing else
    }
  }
  return head;
}

/**
 * The `limit` newest main transcripts `<sid>.jsonl` of `dir`, newest first, with their age at `nowMs`. A folder that cannot
 * be listed gives an empty list; a file that cannot be read gives an empty prompt.
 */
export async function recentSessionsOf(
  dir: string,
  limit: number,
  nowMs: number,
  fs: DiscoveryFs = nodeDiscoveryFs,
  log?: RecentSessionsLog,
): Promise<RecentSession[]> {
  let names: readonly string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    log?.debug('discover.sessions_unlisted', { count: 0 });
    return [];
  }
  const mains: { id: string; file: string; stat: EntryStat }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!SID_RE.test(id)) continue;
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    if (stat?.kind === 'file') mains.push({ id, file, stat });
  }
  mains.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.id.localeCompare(b.id));
  const out: RecentSession[] = [];
  for (const main of mains.slice(0, Math.max(0, limit))) {
    const bytes = await fs.readHead(main.file, HEAD_BYTES);
    if (bytes === null) log?.debug('discover.session_unreadable', { bytes: main.stat.size });
    out.push({
      id: main.id,
      ageSeconds: Math.max(0, (nowMs - main.stat.mtimeMs) / 1000),
      bytes: main.stat.size,
      firstPrompt: bytes === null ? '' : realFirstPrompt(headOf(bytes)),
    });
  }
  return out;
}
