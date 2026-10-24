// `usage` (01 6.3, 6.4): token usage of a task grouped by session, model, day or tool. Option table and rendering only; the operation
// is `ops.data.usageReport`, which reads the analytics routes through the `InstanceReader`. A number that is not exact is marked: `>=`
// and the note `lower bound` where part of a transcript was not read, `partial` where a message was not final. A cost column exists
// only when prices are configured, and its header says `estimate`: the provider does not bill from these numbers.
import { opsData } from '@mcs/engine';
import {
  USAGE_GROUPS,
  type SeriesPoint,
  type TokenUsage,
  type ToolFrequencyReport,
  type UsageReport,
  type UsageResult,
  type UsageRow,
  type UsageSeries,
} from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { cell, modeNote, table, usageNotes, whole, type Align } from './sessions-list.ts';

const NAME_WIDTH = 48;

function countCell(value: number | null, usage: TokenUsage): string {
  return `${usage.lowerBound && value !== null ? '>=' : ''}${whole(value)}`;
}

function windowLine(window: { readonly from: string | null; readonly to: string }): string {
  return `window ${window.from === null ? 'from the beginning' : window.from.slice(0, 19) + 'Z'} to ${window.to.slice(0, 19)}Z`;
}

function rowName(by: 'session' | 'model', row: UsageRow): string {
  return by === 'session' ? `${row.key.slice(0, 8)} ${row.label}` : row.label === '' ? row.key : row.label;
}

/** The table of `usage --by session|model`. */
export function usageReportLines(by: 'session' | 'model', report: UsageReport, mode: UsageResult['mode']): string[] {
  const priced = report.cost !== null;
  const line = (name: string, row: UsageRow): string[] => {
    const u = row.usage;
    const cost = row.cost === null ? '-' : row.cost.amount.toFixed(2);
    return [
      name,
      countCell(u.input, u),
      countCell(u.output, u),
      countCell(u.cacheCreation, u),
      countCell(u.cacheRead, u),
      countCell(u.total, u),
      String(row.sessions),
      ...(priced ? [cost] : []),
      usageNotes(u).join(', '),
    ];
  };
  const headers = [
    by.toUpperCase(),
    'INPUT',
    'OUTPUT',
    'CACHE WRITE',
    'CACHE READ',
    'TOTAL',
    'SESSIONS',
    ...(priced ? [`COST (estimate${report.cost === null ? '' : `, ${cell(report.cost.currency, 8)}`})`] : []),
    'NOTES',
  ];
  const align: Align[] = [
    'left',
    'right',
    'right',
    'right',
    'right',
    'right',
    'right',
    ...(priced ? ['right' as const] : []),
  ];
  const lines = [`usage by ${by} (${windowLine(report.window)})`, ''];
  if (report.rows.length === 0) {
    lines.push('no usage recorded in this window');
  } else {
    const rows = [
      ...report.rows.map((row) => line(cell(rowName(by, row), NAME_WIDTH), row)),
      line('TOTAL', report.totals),
    ];
    lines.push(...table(headers, rows, align));
  }
  if (report.rowsTruncated) lines.push('', 'more rows exist: narrow with --session or --since');
  if (report.cost !== null) {
    lines.push(
      '',
      `cost: ${report.cost.amount.toFixed(2)} ${cell(report.cost.currency, 8)} (estimate; ${report.cost.pricedTokensPct.toFixed(0)}% of the tokens priced). ${cell(report.cost.note, 160)}`,
    );
    if (report.cost.unpricedModels.length > 0) {
      lines.push(`no price for: ${report.cost.unpricedModels.map((m) => cell(m, 60)).join(', ')}`);
    }
  } else {
    lines.push('', 'no prices are configured, so there is no cost column (see `mcs configure`, runtime.json pricing)');
  }
  if (report.reportedCost !== null) {
    const r = report.reportedCost;
    lines.push(
      `reported by Claude Code: ${r.amountUsd.toFixed(2)} USD for ${String(r.sessionsWithReport)} of ${String(r.sessionsInScope)} sessions (${cell(r.label, 120)})`,
    );
  }
  if (report.totals.usage.lowerBound)
    lines.push('>= marks token counts that are a lower bound (part of a transcript was not read)');
  lines.push(`(${modeNote(mode)})`);
  return lines;
}

function dayCell(point: SeriesPoint): string {
  return point.start.slice(0, 10);
}

/** The table of `usage --by day`. */
export function usageDayLines(series: UsageSeries, mode: UsageResult['mode']): string[] {
  const lines = [`usage by day (${windowLine(series.window)}, UTC days)`, ''];
  if (series.points.length === 0) {
    lines.push('no usage recorded in this window');
  } else {
    const sum = (pick: (p: SeriesPoint) => number): number => series.points.reduce((total, p) => total + pick(p), 0);
    const rows = [
      ...series.points.map((p) => [
        dayCell(p),
        String(p.input),
        String(p.output),
        String(p.cacheCreation),
        String(p.cacheRead),
        String(p.messages),
        p.completeness === 'complete' ? '' : 'partial',
      ]),
      [
        'TOTAL',
        String(sum((p) => p.input)),
        String(sum((p) => p.output)),
        String(sum((p) => p.cacheCreation)),
        String(sum((p) => p.cacheRead)),
        String(sum((p) => p.messages)),
        '',
      ],
    ];
    lines.push(
      ...table(['DAY', 'INPUT', 'OUTPUT', 'CACHE WRITE', 'CACHE READ', 'MESSAGES', 'NOTES'], rows, [
        'left',
        'right',
        'right',
        'right',
        'right',
        'right',
      ]),
    );
  }
  lines.push('', 'days without usage are left out; partial marks a day with a message that was not final');
  lines.push(`(${modeNote(mode)})`);
  return lines;
}

/** The table of `usage --by tool`. */
export function usageToolLines(report: ToolFrequencyReport, mode: UsageResult['mode']): string[] {
  const lines = [`tool calls (${windowLine(report.window)})`, ''];
  if (report.items.length === 0) {
    lines.push('no tool calls recorded in this window');
  } else {
    const ms = (value: number | null): string => (value === null ? '-' : String(Math.round(value)));
    const rows = report.items.map((item) => [
      cell(item.toolName, 40),
      cell(item.mcpServer ?? '', 40),
      String(item.calls),
      String(item.succeeded),
      String(item.failed),
      String(item.denied),
      String(item.interrupted),
      String(item.pending),
      item.failurePct === null ? '-' : `${item.failurePct.toFixed(1)}%`,
      ms(item.medianDurationMs),
      ms(item.maxDurationMs),
    ]);
    lines.push(
      ...table(
        [
          'TOOL',
          'MCP SERVER',
          'CALLS',
          'OK',
          'FAILED',
          'DENIED',
          'INTERRUPTED',
          'PENDING',
          'FAIL %',
          'MEDIAN MS',
          'MAX MS',
        ],
        rows,
        ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
  }
  if (report.sampled) lines.push('', 'the durations are computed from a sample of the calls');
  lines.push(`(${modeNote(mode)})`);
  return lines;
}

/** The text of `usage`, whatever the grouping. */
export function usageLines(result: UsageResult): string[] {
  if (result.by === 'day') return usageDayLines(result.series, result.mode);
  if (result.by === 'tool') return usageToolLines(result.tools, result.mode);
  return usageReportLines(result.by, result.report, result.mode);
}

export function makeCommand(ops: Pick<typeof opsData, 'usageReport'> = opsData): CommandDefinition {
  return {
    name: 'usage',
    summary: 'token usage of a task by model, session, day or tool (with lower-bound and partial markers)',
    synopsis: '--task SLUG [--by session|model|day|tool] [--session ID]... [--since 7d|ISO-TIME] [--until ISO-TIME]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read' },
      by: {
        type: 'string',
        valueName: 'GROUP',
        choices: USAGE_GROUPS,
        description: 'how to group the rows (default model)',
      },
      session: {
        type: 'string',
        valueName: 'ID',
        multiple: true,
        description: 'only this session (full id); repeat for more',
      },
      since: {
        type: 'string',
        valueName: 'WHEN',
        description: 'from 1h, 6h, 24h, 7d, 30d, all, or an ISO-8601 time',
      },
      until: { type: 'string', valueName: 'TIME', description: 'up to this ISO-8601 time (needs an ISO-8601 --since)' },
    },
    async run(ctx) {
      const by = USAGE_GROUPS.find((group) => group === ctx.args.string('by'));
      const sessions = ctx.args.strings('session');
      const since = ctx.args.string('since');
      const until = ctx.args.string('until');
      const result = await ops.usageReport(ctx.op, {
        task: ctx.args.string('task') ?? '',
        ...(by === undefined ? {} : { by }),
        ...(sessions.length === 0 ? {} : { session: sessions }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      });
      return { data: result, text: usageLines(result) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
