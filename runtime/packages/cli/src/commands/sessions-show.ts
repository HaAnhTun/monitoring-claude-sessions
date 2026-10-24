// `sessions show` (01 6.3, 6.4): one session in detail: its state with the basis and the evidence behind it, its tokens, its agents as a
// tree and its newest events. Prompt, reply, thinking and tool text appear only with `--include-text`, each piece clipped to 300
// characters; without the flag no transcript text is read at all. Option table and rendering only; the operation is
// `ops.data.showSession`.
import { opsData } from '@mcs/engine';
import type { AgentNode, SessionDetail, SessionsShowResult } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { cell, compact, isoShort, modeNote, table, usageNotes, whole } from './sessions-list.ts';

const LABEL_WIDTH = 70;
const TEXT_WIDTH = 300;

/** `3725000` as `1h 02m 05s`; the largest two units that matter. */
export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24).padStart(2, '0')}h`;
}

function stateText(state: SessionDetail['state']): string {
  const parts = [state.basis, `${state.confidence} confidence`, `rule ${state.rule}`];
  const why = state.waitReason ?? state.staleKind ?? state.endReason;
  return `${state.state} (${parts.join(', ')})${why === null ? '' : `: ${cell(why, 60)}`}`;
}

function tokensText(session: SessionDetail): string {
  const u = session.usageInclSubagents;
  const notes = usageNotes(u);
  return (
    `in ${whole(u.input)}, out ${whole(u.output)}, cache write ${whole(u.cacheCreation)}, cache read ${whole(u.cacheRead)}` +
    ` (with subagents${notes.length === 0 ? '' : `; ${notes.join(', ')}`})`
  );
}

function costText(session: SessionDetail): string | null {
  const cost = session.cost;
  if (cost === null) return null;
  const unpriced = cost.unpricedModels.length > 0 ? `; no price for ${cost.unpricedModels.length} model(s)` : '';
  return `about ${cost.amount.toFixed(2)} ${cell(cost.currency, 8)} (estimate; ${cost.pricedTokensPct.toFixed(0)}% of the tokens priced${unpriced})`;
}

function agentLine(agent: AgentNode): string {
  const indent = '  '.repeat(Math.min(agent.depth, 8));
  const kind = agent.agentType === null ? agent.kind : `${agent.kind}/${agent.agentType}`;
  return (
    `  ${indent}${cell(agent.id, 24)}  ${cell(kind, 32)}  ${agent.state.state} (${agent.state.basis})` +
    `  ${cell(agent.label, LABEL_WIDTH)}  tokens ${compact(agent.usage.total)}`
  );
}

/** The text of `sessions show` (the commands print it line by line). */
export function sessionsShowLines(result: SessionsShowResult): string[] {
  const s = result.session;
  const lines: string[] = [
    `session   ${s.id}`,
    `label     ${cell(s.label, LABEL_WIDTH)}`,
    `state     ${stateText(s.state)}`,
  ];
  if (s.state.since !== null) lines.push(`since     ${isoShort(s.state.since)}`);
  if (s.state.evidence.length === 0) lines.push('evidence  none recorded');
  else {
    lines.push('evidence');
    for (const item of s.state.evidence) {
      const at = item.at === null ? '' : `, at ${isoShort(item.at)}`;
      lines.push(`  - ${cell(item.text, 160)} (${cell(item.kind, 40)}${at})`);
    }
  }
  const ended = s.endedAt === null ? '' : `   ended ${isoShort(s.endedAt)}`;
  lines.push(
    `started   ${isoShort(s.startedAt)}   last activity ${isoShort(s.lastActivityAt)}${ended}`,
    `duration  ${durationText(s.durationMs)}`,
  );
  if (s.models.length > 0) lines.push(`models    ${s.models.map((m) => cell(m, 60)).join(', ')}`);
  if (s.cwd !== null)
    lines.push(`cwd       ${cell(s.cwd, 120)}${s.gitBranch === null ? '' : `   branch ${cell(s.gitBranch, 60)}`}`);
  lines.push(`tokens    ${tokensText(s)}`);
  const cost = costText(s);
  if (cost !== null) lines.push(`cost      ${cost}`);
  lines.push(
    `tools     ${String(s.toolCallCount)} calls, ${String(s.pendingTools)} pending, ${String(s.errorCount)} errors, ${String(s.warningCount)} warnings`,
  );

  lines.push('', `agents (${String(result.agents.length)}${result.agentsTruncated ? ', more exist' : ''})`);
  for (const agent of result.agents) lines.push(agentLine(agent));

  lines.push(
    '',
    `events (newest ${String(result.events.length)}, oldest first${result.eventsTruncated ? '; older ones exist' : ''})`,
  );
  if (result.events.length === 0) lines.push('  none');
  else {
    const withSummary = result.events.some((event) => event.summary !== null);
    const headers = ['TIME', 'TYPE', 'TOOL', 'STATUS', 'MS', 'AGENT', ...(withSummary ? ['SUMMARY'] : [])];
    const rows = result.events.map((event) => [
      isoShort(event.at),
      cell(event.type, 24),
      cell(event.toolName ?? '', 40),
      event.toolStatus ?? '',
      whole(event.durationMs),
      cell(event.agentId ?? '', 24),
      ...(withSummary ? [cell(event.summary ?? '', TEXT_WIDTH)] : []),
    ]);
    for (const line of table(headers, rows, ['left', 'left', 'left', 'left', 'right', 'left'])) lines.push(`  ${line}`);
  }

  if (result.transcript !== null) {
    const t = result.transcript;
    lines.push(
      '',
      `transcript text of agent ${cell(t.agentId, 24)} (newest ${String(t.entries.length)} of ${String(t.total)} entries, each clipped to ${String(t.clipChars)} characters)`,
    );
    for (const entry of t.entries) {
      const name = entry.name === null ? '' : ` ${cell(entry.name, 40)}`;
      lines.push(
        `  [${String(entry.i)}] ${entry.k}${name}${entry.t === '' ? '' : ` ${cell(entry.t, 30)}`}: ${cell(entry.text, TEXT_WIDTH)}`,
      );
    }
  } else {
    lines.push(
      '',
      'no prompt, reply or tool text is shown; --include-text adds the tool summaries and the newest transcript entries',
    );
  }
  lines.push(`(${modeNote(result.mode)})`);
  return lines;
}

export function makeCommand(ops: Pick<typeof opsData, 'showSession'> = opsData): CommandDefinition {
  return {
    name: 'sessions show',
    summary: 'show one session: state with basis and evidence, tokens, agents and the newest events',
    synopsis: '--task SLUG --session ID [--events N] [--include-text]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read' },
      session: {
        type: 'string',
        valueName: 'ID',
        required: true,
        description:
          'the session id, or its first characters (the id column of `sessions list`) when they name one session',
      },
      events: {
        type: 'string',
        valueName: 'N',
        integer: [1, 100],
        description: 'how many of the newest events to list (default 10)',
      },
      'include-text': {
        type: 'boolean',
        description: 'also read the tool summaries and the newest transcript entries, each clipped to 300 characters',
      },
    },
    async run(ctx) {
      const events = ctx.args.int('events');
      const outcome = await ops.showSession(ctx.op, {
        task: ctx.args.string('task') ?? '',
        session: ctx.args.string('session') ?? '',
        includeText: ctx.args.flag('include-text'),
        ...(events === undefined ? {} : { events }),
      });
      return { data: outcome.result, text: sessionsShowLines(outcome.result), warnings: outcome.warnings };
    },
  };
}

export const command: CommandDefinition = makeCommand();
