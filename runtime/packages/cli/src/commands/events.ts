// `events` (ADR 0108): the durable change stream of an instance as lines, one per change. With `--json` every line is one
// `caw.event/1` object (NDJSON, `schemas/event.v1.schema.json`); without it a line is text for a person. A line carries ids,
// states and times only, never a label or a folder. The command only reads: it holds one stream of the instance and never
// writes to it. Without a flag it prints the `hello` line (its `headSeq` is a cursor to keep) and ends; `--since SEQ` replays
// the log after SEQ and ends with an `end` line; `--follow` stays. Option table and rendering only; the operation is
// `ops.watch.followEvents`.
import { opsWatch } from '@mcs/engine';
import { CHANGE_KINDS, CLI_NAME, McsError, type ChangeKind, type CliEvent } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { isoShort } from './sessions-list.ts';

/** The kinds a call reports when it does not say: the other kinds arrive per tool call and per event. */
const DEFAULT_KINDS: readonly ChangeKind[] = ['session'];
/** A seq is far below this; the stream route accepts no more digits. */
const MAX_SEQ = 999_999_999_999_999;

/** `--kind session,agent` or `--kind all` as the kinds to report (`null`: every kind). Throws `USAGE` for an unknown word. */
export function kindsOf(text: string | undefined): readonly ChangeKind[] | null {
  if (text === undefined) return DEFAULT_KINDS;
  const words = text
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');
  if (words.includes('all')) return null;
  const kinds = CHANGE_KINDS.filter((kind) => words.includes(kind));
  const unknown = words.find((word) => !kinds.some((kind) => kind === word));
  if (unknown !== undefined || kinds.length === 0) {
    throw new McsError('USAGE', `--kind expects all or a comma-separated list of ${CHANGE_KINDS.join(', ')}`, {
      hint: `usage: ${CLI_NAME} events --kind session,agent (${CLI_NAME} help events)`,
      details: { reason: 'validation_failed', flag: '--kind' },
    });
  }
  return kinds;
}

const short = (id: string | null): string => (id === null ? '-' : id.slice(0, 8));

/** One line of text for a person: `2026-11-15T10:03:22Z #8841 session 3f2a9c1e waiting_input S-6a needs_you(permission)`. */
export function eventTextLine(event: CliEvent): string {
  if (event.type === 'hello') {
    return `${isoShort(event.serverTime)} hello instance ${short(event.instanceId)} epoch ${event.epoch} head #${String(event.headSeq)}`;
  }
  if (event.type === 'reset') return `reset ${event.reason} head #${String(event.headSeq)}`;
  if (event.type === 'end') return `end head #${String(event.headSeq)} changes ${String(event.count)}`;
  const head = `${isoShort(event.at)} #${String(event.seq)} ${event.kind} ${short(event.sessionId)}`;
  if (event.session === null) return `${head} ${event.op}`;
  const { state, rule, attention } = event.session;
  const reason = attention.reason === null ? '' : `(${attention.reason})`;
  return `${head} ${state} ${rule} ${attention.posture}${reason}`;
}

export function makeCommand(ops: Pick<typeof opsWatch, 'followEvents'> = opsWatch): CommandDefinition {
  return {
    name: 'events',
    summary: 'print the changes of an instance as lines (NDJSON caw.event/1 with --json); read-only',
    synopsis: '[--task SLUG] [--follow] [--since SEQ] [--kind session[,agent,...]|all]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read (task scope)' },
      follow: { type: 'boolean', description: 'stay and print every change as it happens (Ctrl+C ends)' },
      since: {
        type: 'string',
        valueName: 'SEQ',
        integer: [0, MAX_SEQ],
        description: 'replay the change log after this seq first (the headSeq of an earlier hello or end line)',
      },
      kind: {
        type: 'string',
        valueName: 'LIST',
        description: `the kinds to print: all, or a comma-separated list of ${CHANGE_KINDS.join(', ')} (default: session)`,
      },
    },
    defaultScope: 'user',
    stream: 'ndjson',
    async run(ctx) {
      const kinds = kindsOf(ctx.args.string('kind'));
      const since = ctx.args.int('since');
      const { emit } = ctx;
      if (emit === undefined) throw new McsError('INTERNAL', 'events needs the line output of the kernel');
      const lines = ops.followEvents(ctx.op, {
        task: ctx.args.string('task') ?? '',
        follow: ctx.args.flag('follow'),
        kinds,
        ...(since === undefined ? {} : { since }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      for await (const event of lines) {
        if (!emit(ctx.json ? JSON.stringify(event) : eventTextLine(event))) break;
      }
      return { data: null, text: [] };
    },
  };
}

export const command: CommandDefinition = makeCommand();
