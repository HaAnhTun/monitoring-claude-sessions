// Four synthetic pre-4.0 workspaces for `migrate-workspace` (ADR 0068), shaped like the configurations of real tasks but
// holding invented data only: A and B were created by the Python skill (no `instance.json`), C was adopted by a Node run,
// D is a chain task whose attempts patterns use Python named groups (the first two `v9` cases of the frozen corpus).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildTaskWorkspace } from '@mcs/testkit';

export type ShapeName = 'A' | 'B' | 'C' | 'D';

/** `attempts.start` of shape D: the first `v9` case of `regex-golden.frozen.json`. */
export const D_START =
  '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) BEGIN try (?P<n>[0-9]+) model (?P<model>[a-z]+) effort (?P<effort>[a-z]+)';
/** `attempts.end` of shape D: the second `v9` case of the corpus. */
export const D_END =
  '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+) state=(?P<status>[A-Z ]+)';
/** A pattern of shape C that is valid JavaScript (and Python). */
export const C_JS_RULE = 'run-job[.]md.*?PART=([A-Z0-9]+)';
/** A pattern of shape C in Python-only syntax. */
export const C_PY_RULE = 'step (?P<step>[0-9]+) of FIXTURE';

export const SHAPE_CONFIGS: Readonly<Record<ShapeName, Record<string, unknown>>> = {
  A: {
    title: 'FIXTURE shape A',
    port: 18770,
    transcripts_dir: 'auto',
    panels: { machine: true, git: true },
  },
  B: {
    title: 'FIXTURE shape B',
    port: 18771,
    window_hours: 30,
    panels: { logs: false },
    session_rules: [{ match: 'You are the (Planner|Reviewer) agent', label: 'FIXTURE {1}' }],
  },
  C: {
    title: 'FIXTURE shape C',
    port: 18772,
    transcripts_dir: 'fixture-transcripts',
    session_rules: [
      { match: C_JS_RULE, label: 'part {1}' },
      { match: C_PY_RULE, label: 'step {step}' },
    ],
  },
  D: {
    title: 'FIXTURE shape D',
    port: 18773,
    panels: { machine: true, git: true, logs: true, ledger: true, chain_log: true, attempts: true },
    live_log_globs: ['logs/fixture-*.log'],
    chain_log: 'logs/fixture-chain.log',
    ledger: 'logs/fixture-ledger.md',
    stop_file: 'logs/fixture.stop',
    attempts: { start: D_START, end: D_END, time_format: '%Y-%m-%d %H:%M:%S', label_prefix: 'FIXTURE' },
  },
};

/** What the Python skill wrote to `audit/changes.md` at init time (synthetic). */
export function initAuditText(slug: string): string {
  return [
    '# Changes',
    '',
    '## 2026-01-02T03:04:05Z | init-task',
    `- Summary: created FIXTURE task ${slug}`,
    '- Reason: not given',
    '- Files changed: task.json, config.json, README.md',
    '- Validation: schema ok',
    '- Outcome: created',
    '- Unresolved: none',
    '',
    '',
  ].join('\n');
}

/**
 * Builds shape `name` as task `slug` under `<repo>/.claude/monitor/tasks/` with the `audit/changes.md` of the Python skill;
 * C also gets an `instance.json`. Returns the workspace.
 */
export function buildShape(repo: string, name: ShapeName, slug = `shape-${name.toLowerCase()}`): string {
  const ws = buildTaskWorkspace(repo, {
    slug,
    config: SHAPE_CONFIGS[name],
    ...(name === 'C' ? { instance: {} } : {}),
  });
  mkdirSync(join(ws, 'audit'), { recursive: true });
  writeFileSync(join(ws, 'audit', 'changes.md'), initAuditText(slug));
  return ws;
}
