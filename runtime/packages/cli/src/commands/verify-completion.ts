// `verify-completion` (01 6.3, 6.4, T-CLI-08): did this unattended run really finish? One of `--session`, `--label`, `--attempt` names
// the run; the verdict comes from `InstanceReader.explainCompletion` and rests on observed evidence only (a hook's SessionEnd, a
// daemon job state, or an attempt row that ended): a quiet or inferred session is `NOT TERMINAL`. The exit code is 0 exactly when the
// outcome is the one `--expect` asks for (`completed` by default; `terminal` accepts completed or failed). Option table and
// rendering only; the operation is `ops.data.completionReport`.
import { opsData } from '@mcs/engine';
import {
  COMPLETION_EXPECTATIONS,
  type CompletionEvidence,
  type CompletionExpectation,
  type VerifyCompletionResult,
} from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { cell, isoShort } from './sessions-list.ts';

const TARGET_WIDTH = 80;
const EVIDENCE_WIDTH = 200;

/** True when `outcome` is the one that `expect` asks for. */
export function expectationMet(outcome: CompletionEvidence['outcome'], expect: CompletionExpectation): boolean {
  if (expect === 'terminal') return outcome === 'completed' || outcome === 'failed';
  return outcome === expect;
}

/** `session 1a2b3c4d`, or `attempt <part>` for an attempt row no session matched. */
function subjectOf(result: VerifyCompletionResult): string {
  const c = result.completion;
  if (c.sessionId !== null) return `session ${c.sessionId.slice(0, 8)}`;
  return result.target === '' ? 'attempt (no part)' : `attempt ${cell(result.target, TARGET_WIDTH)}`;
}

/** The verdict line and one evidence line per item. */
export function verifyCompletionLines(result: VerifyCompletionResult): string[] {
  const c = result.completion;
  const several = c.candidates > 1 ? ` (${String(c.candidates)} candidates, newest decides)` : '';
  const head =
    c.outcome === 'completed'
      ? `COMPLETED (observed): ${subjectOf(result)}${several}`
      : c.outcome === 'failed'
        ? `FAILED (observed): ${subjectOf(result)}${several}`
        : `NOT TERMINAL: state=${c.state} (${c.basis}, confidence ${c.confidence})${several}`;
  const lines = [head];
  for (const item of c.evidence) {
    lines.push(
      `${cell(item.kind, 60)} ${item.at === null ? '-' : isoShort(item.at)} ${cell(item.text, EVIDENCE_WIDTH)}`,
    );
  }
  if (c.evidence.length === 0) lines.push('no evidence recorded');
  return lines;
}

export function makeCommand(ops: Pick<typeof opsData, 'completionReport'> = opsData): CommandDefinition {
  return {
    name: 'verify-completion',
    summary: 'check from observed evidence whether a run finished (exit 0 only when it matches --expect)',
    synopsis: '--task SLUG (--session ID | --label TEXT | --attempt PART) [--expect completed|failed|terminal]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read' },
      session: { type: 'string', valueName: 'ID', description: 'the full session id' },
      label: {
        type: 'string',
        valueName: 'TEXT',
        description: 'the exact label of the session (the newest session with it decides)',
      },
      attempt: {
        type: 'string',
        valueName: 'PART',
        description: 'the part of an attempt row of the chain log (the newest attempt of that part decides)',
      },
      expect: {
        type: 'string',
        valueName: 'OUTCOME',
        choices: COMPLETION_EXPECTATIONS,
        description: 'completed (default), failed, or terminal (completed or failed)',
      },
    },
    async run(ctx) {
      const session = ctx.args.string('session');
      const label = ctx.args.string('label');
      const attempt = ctx.args.string('attempt');
      const expect = COMPLETION_EXPECTATIONS.find((value) => value === ctx.args.string('expect')) ?? 'completed';
      const report = await ops.completionReport(ctx.op, {
        task: ctx.args.string('task') ?? '',
        ...(session === undefined ? {} : { session }),
        ...(label === undefined ? {} : { label }),
        ...(attempt === undefined ? {} : { attempt }),
      });
      const result: VerifyCompletionResult = {
        task: report.task,
        mode: report.mode,
        expect,
        met: expectationMet(report.completion.outcome, expect),
        target: report.target,
        completion: report.completion,
      };
      return { data: result, text: verifyCompletionLines(result), exitCode: result.met ? 0 : 1 };
    },
  };
}

export const command: CommandDefinition = makeCommand();
