// `export` (01 6.3, 6.4, T-CLI-13): writes the data of a task as `mcs.export/1` lines (03 11.1) to a new file. Metadata only unless
// `--include-content` is given, and that flag is never implied by another one (`--redaction strict` refuses it). The file is
// written to `<out>.tmp`, re-read and compared with what the reader reported, then renamed; a path that could break the audit
// (`*.jsonl` anywhere inside a workspace, another task's folder) or leak data (the Claude home) is refused before anything is read.
// Option table and rendering only; the operation is `exportToFile`, which reads through the `InstanceReader`.
import path from 'node:path';

import { exportToFile, opsData, opsWorkspace } from '@mcs/engine';
import { EXPORT_REDACTIONS, type ExportResult } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { cell, modeNote } from './sessions-list.ts';

/** The text of `export`: where the file is, what it holds and how it was checked. */
export function exportLines(result: ExportResult): string[] {
  const s = result.summary;
  const counts = Object.entries(s.counts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${cell(name, 24)} ${String(n)}`)
    .join(', ');
  return [
    `exported ${String(s.lines)} lines (${String(s.bytes)} bytes) to ${cell(result.path, 240)}${result.replaced ? ' (replaced the existing file)' : ''}`,
    `sha256 ${s.sha256} (of every byte before the trailer line; the file was re-read and matches)`,
    counts === '' ? 'no records matched the selection' : `records: ${counts}`,
    s.includeContent
      ? 'contains transcript text: treat the file as confidential'
      : 'metadata only: no prompt, reply, thinking or tool result text',
    `(${modeNote(result.mode)})`,
  ];
}

/** What the command calls; a test replaces them. */
export interface ExportOps {
  readonly exportQueryOf: typeof opsData.exportQueryOf;
  readonly openWorkspace: typeof opsWorkspace.openWorkspace;
  readonly exportToFile: typeof exportToFile;
}

export function makeCommand(
  ops: ExportOps = { exportQueryOf: opsData.exportQueryOf, openWorkspace: opsWorkspace.openWorkspace, exportToFile },
): CommandDefinition {
  return {
    name: 'export',
    summary: 'write the data of a task to a new .ndjson file (metadata only unless --include-content)',
    synopsis:
      '--task SLUG --out FILE [--since 7d|ISO-TIME] [--until ISO-TIME] [--session ID]... [--include TYPES] [--redaction standard|strict] [--include-content] [--force]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to export' },
      out: {
        type: 'string',
        valueName: 'FILE',
        required: true,
        description:
          'the file to write; use .ndjson (a .jsonl file inside a task workspace fails the audit); inside the tasks folder only logs/ or data/backups/ of this task',
      },
      format: {
        type: 'string',
        valueName: 'FORMAT',
        choices: ['ndjson'],
        description: 'ndjson: one JSON object per line, mcs.export/1 (the only format)',
      },
      since: {
        type: 'string',
        valueName: 'WHEN',
        description: 'from 1h, 6h, 24h, 7d, 30d, all, or an ISO-8601 time',
      },
      until: { type: 'string', valueName: 'TIME', description: 'up to this ISO-8601 time (needs an ISO-8601 --since)' },
      session: {
        type: 'string',
        valueName: 'ID',
        multiple: true,
        description: 'only this session (full id); repeat for more',
      },
      include: {
        type: 'string',
        valueName: 'TYPES',
        description:
          'comma-separated record types: sessions, agents, workflows, work_items, events, tool_calls, turns, usage, transitions, alerts (default all)',
      },
      redaction: {
        type: 'string',
        valueName: 'LEVEL',
        choices: EXPORT_REDACTIONS,
        description:
          'standard (default) or strict (also drops labels, summaries, paths and branches); strict refuses --include-content',
      },
      'include-content': {
        type: 'boolean',
        description: 'also write the transcript text of the sessions: the file is then confidential',
      },
      force: { type: 'boolean', description: 'replace the file when it exists' },
    },
    async run(ctx) {
      const task = ctx.args.string('task') ?? '';
      const sessions = ctx.args.strings('session');
      const since = ctx.args.string('since');
      const until = ctx.args.string('until');
      const include = ctx.args.string('include');
      const redaction = ctx.args.string('redaction');
      const query = ops.exportQueryOf({
        ...(sessions.length === 0 ? {} : { session: sessions }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        ...(include === undefined ? {} : { include }),
        ...(redaction === undefined ? {} : { redaction }),
        includeContent: ctx.args.flag('include-content'),
      });
      const ws = await ops.openWorkspace(ctx.op, task);
      const written = await ops.exportToFile(ctx.op, ws, query, path.resolve(ctx.args.string('out') ?? ''), {
        force: ctx.args.flag('force'),
      });
      const result: ExportResult = {
        task,
        mode: written.mode,
        path: written.path,
        summary: written.summary,
        replaced: written.replaced,
      };
      return { data: result, text: exportLines(result) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
