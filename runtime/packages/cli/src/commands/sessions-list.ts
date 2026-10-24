// `sessions list` (01 6.3, 6.4): the sessions of a task as a table, newest activity first. Option table and rendering only; the
// operation is `ops.data.listSessions`, which reads through the `InstanceReader` (the running instance, else its database).
// The rendering helpers at the top are shared with `sessions show`, `usage` and `errors`: every untrusted string (a label, a path, a
// message from a transcript) is made one line and escaped with `sanitizeForTerminal` before its width is measured, so a label with an
// escape sequence or a bidi control shows as `\u001b` and can never move the table or the terminal.
import { opsData } from '@mcs/engine';
import type { ReaderMode, SessionSummary, SessionsListResult, TokenUsage } from '@mcs/shared';

import { sanitizeForTerminal } from '../io/terminal.ts';
import type { CommandDefinition } from '../main.ts';

// ---- shared rendering helpers --------------------------------------------------------------------------------------------------

/** Cuts `text` to `max` code points (an ellipsis when it was longer). */
export function clip(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** One table cell of untrusted text: one line, at most `max` characters, control characters escaped. */
export function cell(text: string, max: number): string {
  return sanitizeForTerminal(clip(text, max).replace(/[\t\n]+/g, ' '));
}

/** Width in code points: the table pads by it (full-width letters are not measured). */
function widthOf(text: string): number {
  return Array.from(text).length;
}

export type Align = 'left' | 'right';

/**
 * A table as lines: a header row and the rows, columns padded to their widest cell and separated by two spaces. Trailing blanks are
 * cut. Every cell must already be safe (`cell`, or a number).
 */
export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly Align[] = [],
): string[] {
  const widths = headers.map((header, column) =>
    Math.max(widthOf(header), ...rows.map((row) => widthOf(row[column] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((text, column) => {
        const pad = ' '.repeat(Math.max(0, (widths[column] ?? 0) - widthOf(text)));
        return align[column] === 'right' ? pad + text : text + pad;
      })
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map((row) => line(headers.map((_h, column) => row[column] ?? '')))];
}

/** `2026-10-20T12:03:04.123Z` as `2026-10-20T12:03:04Z`. */
export function isoShort(iso: string): string {
  return `${iso.slice(0, 19)}Z`;
}

/** A count in a narrow column: `310`, `18.0k`, `2.45M`, `1.20G`; `-` for a value that was never counted. */
export function compact(n: number | null): string {
  if (n === null) return '-';
  if (n < 1000) return String(n);
  const units: readonly [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const value = n / size;
      return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)}${unit}`;
    }
  }
  return String(n);
}

/** A whole count, or `-` for a value that was never counted. */
export function whole(n: number | null): string {
  return n === null ? '-' : String(n);
}

/** What is not exact about a token count: it is a lower bound, or part of the transcript was not read. */
export function usageNotes(usage: TokenUsage): string[] {
  const notes: string[] = [];
  if (usage.lowerBound) notes.push('lower bound');
  if (usage.completeness !== 'complete') notes.push('partial');
  return notes;
}

export function modeNote(mode: ReaderMode): string {
  return mode === 'api' ? 'read from the running instance' : 'read from the database (the monitor is not running)';
}

// ---- sessions list ------------------------------------------------------------------------------------------------------------

const LABEL_WIDTH = 44;

function tokensCell(session: SessionSummary): string {
  const usage = session.usageInclSubagents;
  const lower = usageNotes(usage).length > 0 ? '>=' : '';
  return `${lower}${compact(usage.input)}/${compact(usage.output)}`;
}

/** The table and the footer of `sessions list`. */
export function sessionsListLines(result: SessionsListResult): string[] {
  if (result.items.length === 0) {
    return [
      `no sessions match in task '${cell(result.task, 60)}'`,
      'hint: --all shows sessions no rule matched and every time, --since 7d widens the window',
    ];
  }
  const rows = result.items.map((session) => [
    session.id.slice(0, 8),
    cell(session.label, LABEL_WIDTH),
    session.state.state,
    session.state.basis,
    isoShort(session.lastActivityAt),
    tokensCell(session),
    String(session.errorCount),
  ]);
  const lines = table(['ID', 'LABEL', 'STATE', 'BASIS', 'LAST ACTIVITY', 'TOKENS (IN/OUT)', 'ERRORS'], rows, [
    'left',
    'left',
    'left',
    'left',
    'left',
    'right',
    'right',
  ]);
  const shown = String(result.items.length);
  const of = result.total === null ? '' : ` of ${result.totalIsLowerBound ? 'more than ' : ''}${String(result.total)}`;
  lines.push('', `${shown}${of} sessions (${modeNote(result.mode)})`);
  if (result.hasMore) {
    lines.push(`more sessions match: raise --limit (at most 200) or narrow with --state and --since`);
  }
  if (result.items.some((session) => usageNotes(session.usageInclSubagents).length > 0)) {
    lines.push('>= marks token counts that are a lower bound (part of a transcript was not read)');
  }
  return lines;
}

export function makeCommand(ops: Pick<typeof opsData, 'listSessions'> = opsData): CommandDefinition {
  return {
    name: 'sessions list',
    summary: 'list the sessions of a task: id, label, state, basis, last activity, tokens and errors',
    synopsis: '--task SLUG [--state STATE[,STATE]] [--since 24h|ISO-TIME] [--limit N] [--all]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read' },
      state: {
        type: 'string',
        valueName: 'STATES',
        description:
          'only these lifecycle states, comma separated (running, working, waiting_input, waiting_tool, waiting_agent, turn_ended, completed, failed, stale, unknown; active = the running ones)',
      },
      since: {
        type: 'string',
        valueName: 'WHEN',
        description:
          'only sessions active since 1h, 6h, 24h, 7d, 30d, all, or an ISO-8601 time (default: the monitor window)',
      },
      limit: {
        type: 'string',
        valueName: 'N',
        integer: [1, 200],
        description: 'at most this many sessions (default 50)',
      },
      all: {
        type: 'boolean',
        description: 'include the sessions that no rule matched, and every time unless --since is given',
      },
    },
    async run(ctx) {
      const state = ctx.args.string('state');
      const since = ctx.args.string('since');
      const limit = ctx.args.int('limit');
      const result = await ops.listSessions(ctx.op, {
        task: ctx.args.string('task') ?? '',
        all: ctx.args.flag('all'),
        ...(state === undefined ? {} : { state }),
        ...(since === undefined ? {} : { since }),
        ...(limit === undefined ? {} : { limit }),
      });
      return { data: result, text: sessionsListLines(result) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
