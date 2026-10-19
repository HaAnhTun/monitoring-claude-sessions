// `tools` (`analyticsTools`, 03 8.4, 12.1): how often each tool (or MCP server) was called, how the calls ended, and how long
// the finished ones took. The source is `tool_calls`, a call belonging to the window by `coalesce(started_at, ended_at)`.
//
//  - the status of a call is the derived `ToolStatus` of 03 5.5 (`toolStatusSql`), so the counts equal the tool-call list;
//  - a pending call is never a failure: `failurePct = round(100 * failed / (calls - pending), 1)`, `null` without finished calls;
//  - the median is computed here, in TypeScript, over the durations of the finished calls (no SQL `median()`), from at most
//    100,000 rows; above that the answer says `sampled: true` and the medians of the keys cut off are `null`.
import type { ToolFrequencyReport, ToolFrequencyRow, ToolStatus, ToolsQuery } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { Binder, NotFoundError, agentRowId, resolveWindow, snapshot, toolStatusSql } from '../query/transitions.ts';
import { reportWindow } from './usage.ts';

export interface ToolFrequencyQueries {
  tools(ctx: RepoContext, q: ToolsQuery): ToolFrequencyReport;
}

/** The most duration rows read for the medians (03 8.4). */
export const MEDIAN_ROW_LIMIT = 100_000;
const DEFAULT_RANGE = '7d';

/** The median of ascending durations: the middle one, or the mean of the two middle ones. `null` without values. */
export function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  const high = sorted[middle];
  const low = sorted[middle - 1];
  if (high === undefined) return null;
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}

/** `round(100 * failed / (calls - pending), 1)`, or `null` when no call has finished. */
export function failurePercent(failed: number, calls: number, pending: number): number | null {
  const finished = calls - pending;
  return finished <= 0 ? null : Math.round((1000 * failed) / finished) / 10;
}

interface CountDbRow {
  k: string;
  mcpServer: string | null;
  status: ToolStatus;
  n: number;
  maxDuration: number | null;
}

interface DurationDbRow {
  k: string;
  duration: number;
}

interface Tally {
  mcpServer: string | null;
  counts: Record<ToolStatus, number>;
  maxDuration: number | null;
}

function emptyCounts(): Record<ToolStatus, number> {
  return { pending: 0, succeeded: 0, failed: 0, denied: 0, interrupted: 0, unknown: 0 };
}

export function createToolFrequencyQueries(db: InstanceDb, deps: QueryDeps): ToolFrequencyQueries {
  return {
    tools: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq): ToolFrequencyReport => {
        const window = resolveWindow(deps, q, DEFAULT_RANGE, null);
        const bind = new Binder();
        const where: string[] = [];
        let sessionIds: number[] | null = null;
        if (q.session !== undefined) {
          const lookup = new Binder();
          sessionIds = db.driver
            .prepare<{ id: number }>(`SELECT id FROM sessions WHERE session_uid IN ${lookup.list(q.session)}`)
            .all(lookup.params)
            .map((row) => row.id);
          where.push(sessionIds.length === 0 ? '0' : `t.session_id IN ${bind.list(sessionIds)}`);
        }
        if (q.agent !== undefined) {
          const only = sessionIds?.[0];
          if (only === undefined) throw new NotFoundError('session_not_found');
          const found = agentRowId(db, only, q.agent);
          if (found === undefined) throw new NotFoundError('agent_not_found');
          where.push(`t.agent_id = ${bind.bind(found)}`);
        }
        if (q.project !== undefined) {
          where.push(
            `t.session_id IN (SELECT id FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE project_key IN ${bind.list(q.project)}))`,
          );
        }
        if (q.tool !== undefined) where.push(`t.name IN ${bind.list(q.tool)}`);
        const byServer = q.groupBy === 'mcpServer';
        if (byServer) where.push('t.mcp_server IS NOT NULL');
        const when = 'coalesce(t.started_at, t.ended_at)';
        if (window.fromMs !== null) where.push(`${when} >= ${bind.bind(window.fromMs)}`);
        where.push(`(${when} IS NULL OR ${when} < ${bind.bind(window.toMs)})`);

        const key = byServer ? 't.mcp_server' : 't.name';
        const status = toolStatusSql('t');
        const condition = where.join(' AND ');

        const tallies = new Map<string, Tally>();
        for (const row of db.driver
          .prepare<CountDbRow>(
            `SELECT ${key} AS k, max(t.mcp_server) AS mcpServer, ${status} AS status, count(*) AS n,
                    max(CASE WHEN ${status} <> 'pending' THEN t.duration_ms END) AS maxDuration
               FROM tool_calls t WHERE ${condition} GROUP BY ${key}, ${status}`,
          )
          .all(bind.params)) {
          const tally = tallies.get(row.k) ?? { mcpServer: row.mcpServer, counts: emptyCounts(), maxDuration: null };
          tally.counts[row.status] += row.n;
          if (row.maxDuration !== null) tally.maxDuration = Math.max(tally.maxDuration ?? 0, row.maxDuration);
          tally.mcpServer ??= row.mcpServer;
          tallies.set(row.k, tally);
        }

        // the medians: the durations of the finished calls, ascending per key, from at most `MEDIAN_ROW_LIMIT` rows
        const durations = new Map<string, number[]>();
        const rows = db.driver
          .prepare<DurationDbRow>(
            `SELECT ${key} AS k, t.duration_ms AS duration FROM tool_calls t
              WHERE ${condition} AND ${status} <> 'pending' AND t.duration_ms IS NOT NULL
              ORDER BY ${key}, t.duration_ms LIMIT ${String(MEDIAN_ROW_LIMIT + 1)}`,
          )
          .all(bind.params);
        const sampled = rows.length > MEDIAN_ROW_LIMIT;
        for (const row of sampled ? rows.slice(0, MEDIAN_ROW_LIMIT) : rows) {
          const list = durations.get(row.k);
          if (list === undefined) durations.set(row.k, [row.duration]);
          else list.push(row.duration);
        }

        const items: ToolFrequencyRow[] = [...tallies.entries()].map(([name, tally]) => {
          const c = tally.counts;
          const calls = c.pending + c.succeeded + c.failed + c.denied + c.interrupted + c.unknown;
          return {
            toolName: name,
            mcpServer: tally.mcpServer,
            calls,
            succeeded: c.succeeded,
            failed: c.failed,
            denied: c.denied,
            interrupted: c.interrupted,
            pending: c.pending,
            unknown: c.unknown,
            failurePct: failurePercent(c.failed, calls, c.pending),
            medianDurationMs: medianOf(durations.get(name) ?? []),
            maxDurationMs: tally.maxDuration,
          };
        });
        items.sort((a, b) => b.calls - a.calls || (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));
        return {
          asOfSeq,
          window: reportWindow(window, deps.now()),
          items: items.slice(0, q.limit),
          sampled,
        };
      }),
  };
}
