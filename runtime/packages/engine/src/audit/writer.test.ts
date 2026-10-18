// The audit writer and the legacy-compatible readers of `lastChange` and `recentAudit` (01 7.1, 7.2). T-AU-02, 04, 05.
// The expectations of the legacy parser were produced by running the legacy `tasks.last_change` and
// `re.split(r'(?m)^(?=## )', text)[-3:]` on the same texts (Python 3.14).
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McsError } from '@mcs/shared';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { resolveWorkspace, withTaskMutex, type WorkspaceRef } from '../workspace/paths.ts';
import {
  AUDIT_ACTIONS,
  appendChange,
  appendDecision,
  changeEntryText,
  decisionEntryText,
  lastChange,
  recentAudit,
  type AuditAction,
  type ChangeEntry,
} from './writer.ts';

const makeTemp = useTempDirs();
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7, 999);
const NEL = String.fromCodePoint(0x85);

/** A workspace folder with `task.json` only; the audit folder does not exist yet. */
function freshWorkspace(slug = 'demo'): WorkspaceRef {
  const root = path.join(makeTemp('audit-writer').path, 'tasks');
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'task.json'), '{}');
  return resolveWorkspace(root, slug);
}

function fixtureWorkspace(): WorkspaceRef {
  const root = path.join(makeTemp('audit-writer').path, 'tasks');
  const dir = path.join(root, 'legacy-demo');
  cpSync(FIXTURE, dir, { recursive: true });
  return resolveWorkspace(root, 'legacy-demo');
}

function changesFile(ws: WorkspaceRef): string {
  return path.join(ws.dir, 'audit', 'changes.md');
}

function decisionsFile(ws: WorkspaceRef): string {
  return path.join(ws.dir, 'audit', 'decisions.md');
}

function sample(over: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    action: 'configure',
    summary: 'window_hours: (default 8) -> 12',
    reason: 'synthetic',
    files: ['config.json'],
    validation: 'schema ok (strict)',
    outcome: 'applied',
    ...over,
  };
}

/** The template of 01 7.1, written independently of the module under test. */
function template(ts: string, e: ChangeEntry): string {
  return [
    `## ${ts} | ${e.action}`,
    `- Summary: ${e.summary}`,
    `- Reason: ${e.reason ?? 'not given'}`,
    `- Files changed: ${e.files.length === 0 ? 'none' : e.files.join(', ')}`,
    `- Validation: ${e.validation}`,
    `- Outcome: ${e.outcome}`,
    `- Unresolved: ${e.unresolved ?? 'none'}`,
    '',
    '',
  ].join('\n');
}

describe('the action catalogue (01 7.2)', () => {
  it('lists exactly the Node-side actions', () => {
    expect([...AUDIT_ACTIONS]).toEqual([
      'init-task',
      'adopt-instance',
      'configure',
      'config-migrate',
      'config-import',
      'upgrade',
      'db-migrate',
      'backup',
      'backup-restore',
      'cleanup',
      'engine-switch',
      'hooks-enable',
      'hooks-disable',
      'hooks-install',
      'hooks-uninstall',
      'instances-repair',
      'db-rebuild',
      'ingest-replay',
      'migrate-workspace',
    ]);
  });
});

describe('appendChange', () => {
  it('T-AU-04: writes the template byte for byte, with the file header on a new file', async () => {
    const ws = freshWorkspace();
    await appendChange(
      ws,
      {
        action: 'init-task',
        summary: "created task workspace 'demo'",
        reason: 'monitoring requested for this task',
        files: ['task.json', 'config.json', 'README.md', 'instance.json'],
        validation: 'schema ok',
        outcome: 'created',
      },
      NOW,
    );
    expect(readFileSync(changesFile(ws), 'utf8')).toBe(
      '# Changes\n\n' +
        '## 2026-10-11T14:05:07Z | init-task\n' +
        "- Summary: created task workspace 'demo'\n" +
        '- Reason: monitoring requested for this task\n' +
        '- Files changed: task.json, config.json, README.md, instance.json\n' +
        '- Validation: schema ok\n' +
        '- Outcome: created\n' +
        '- Unresolved: none\n' +
        '\n',
    );
  });

  it('T-AU-04: every catalogue action writes exactly the template (injected clock)', async () => {
    const table: readonly (readonly [AuditAction, string, readonly string[], string, string])[] = [
      [
        'init-task',
        "created task workspace 'demo'",
        ['task.json', 'config.json', 'README.md', 'instance.json'],
        'schema ok',
        'created',
      ],
      [
        'adopt-instance',
        "added Node runtime files to workspace 'demo' (instance 1a2b3c4d)",
        ['instance.json'],
        'schema ok',
        'adopted',
      ],
      ['configure', 'port: 8765 -> 8800', ['config.json'], 'schema ok (strict)', 'applied'],
      [
        'config-migrate',
        'config.json schema_version 1 -> 2',
        ['config.json'],
        'schema ok (strict)',
        'migrated; backup 20261011T140507Z-config-migrate',
      ],
      [
        'config-import',
        "imported legacy config 'old.json' (4 keys, 1 dropped)",
        ['config.json'],
        'schema ok (strict)',
        'imported',
      ],
      [
        'upgrade',
        'runtime 3.0.0 -> 3.1.0; db schema 1 -> 2; files: none',
        ['instance.json', 'data/monitor.db'],
        'migrations applied; integrity ok',
        'upgraded; backup 20261011T140507Z-upgrade',
      ],
      [
        'db-migrate',
        'db schema 1 -> 2',
        ['instance.json', 'data/monitor.db'],
        'migrations applied; integrity ok',
        'migrated; backup 20261011T140507Z-db-migrate',
      ],
      [
        'backup',
        'created backup 20261011T140507Z-manual (manual)',
        ['data/backups/20261011T140507Z-manual/'],
        'sha256 recorded for 2 files',
        'created',
      ],
      [
        'backup-restore',
        'restored backup 20261011T140507Z-manual (pre-restore backup 20261011T140600Z-pre-restore)',
        ['data/monitor.db'],
        'manifest ok; sha256 ok; instance id ok',
        'restored',
      ],
      ['cleanup', 'logs: deleted 3 files, 2048 bytes', ['3 files under logs'], 'targets re-listed', 'applied'],
      ['engine-switch', 'engine: node -> legacy', ['instance.json'], 'schema ok', 'applied'],
      ['hooks-enable', 'hooks.enabled: false -> true', ['instance.json'], 'schema ok', 'applied'],
      ['hooks-disable', 'hooks.enabled: true -> false', ['instance.json'], 'schema ok', 'applied'],
      [
        'hooks-install',
        'user settings ~/.claude/settings.json: 2 added, 0 replaced, 0 removed',
        [],
        'settings re-read and verified',
        'applied; settings backup ~/.mcs/backups/x.json',
      ],
      [
        'hooks-uninstall',
        'user settings ~/.claude/settings.json: 0 added, 0 replaced, 2 removed',
        [],
        'settings re-read and verified',
        'applied; settings backup ~/.mcs/backups/y.json',
      ],
      [
        'instances-repair',
        'new instance 5e6f7a8b (was 1a2b3c4d); data moved to data/backups/orphaned-20261011T140507Z/',
        ['instance.json', 'data/'],
        'schema ok',
        'repaired',
      ],
      [
        'db-rebuild',
        'database moved to backup 20261011T140507Z-db-rebuild (4096 bytes); a new database is created at the next start',
        ['data/monitor.db', 'instance.json'],
        'sha256 recorded for 2 files',
        'moved; backup 20261011T140507Z-db-rebuild',
      ],
      ['ingest-replay', 'spool replay of 3 segments from all', [], 'cursors re-read', 'scheduled'],
      [
        'migrate-workspace',
        'translated 2 patterns to the JavaScript dialect (attempts.start, attempts.end); kept 0 patterns as written',
        ['config.json'],
        'patterns compile; configuration resolves',
        'migrated; backup in data/backups/pre-migrate-20261011T140507Z/',
      ],
    ];
    expect(table.map((row) => row[0])).toEqual([...AUDIT_ACTIONS]);
    const ws = freshWorkspace();
    let expected = '# Changes\n\n';
    for (const [action, summary, files, validation, outcome] of table) {
      const entry: ChangeEntry = { action, summary, reason: null, files, validation, outcome };
      await appendChange(ws, entry, NOW);
      expected += template('2026-10-11T14:05:07Z', entry);
    }
    expect(readFileSync(changesFile(ws), 'utf8')).toBe(expected);
  });

  it('appends to an existing file without a second header', async () => {
    const ws = freshWorkspace();
    await appendChange(ws, sample({ summary: 'one' }), NOW);
    await appendChange(ws, sample({ summary: 'two' }), NOW + 5000);
    const text = readFileSync(changesFile(ws), 'utf8');
    expect(text.match(/^# Changes$/gm)).toHaveLength(1);
    expect(text).toBe(
      '# Changes\n\n' +
        template('2026-10-11T14:05:07Z', sample({ summary: 'one' })) +
        template('2026-10-11T14:05:12Z', sample({ summary: 'two' })),
    );
  });

  it('writes "not given", "none" and the optional unresolved text like the legacy defaults', async () => {
    const ws = freshWorkspace();
    await appendChange(ws, sample({ reason: null, files: [] }), NOW);
    await appendChange(ws, sample({ reason: '', files: [''] }), NOW);
    await appendChange(ws, sample({ unresolved: 'restart needed' }), NOW);
    const text = readFileSync(changesFile(ws), 'utf8');
    expect(text.match(/^- Reason: not given$/gm)).toHaveLength(2);
    expect(text.match(/^- Files changed: none$/gm)).toHaveLength(2);
    expect(text).toContain('- Unresolved: restart needed\n');
    expect(text.match(/^- Unresolved: none$/gm)).toHaveLength(2);
  });

  it('creates the audit folder when it is missing and leaves nothing else behind', async () => {
    const ws = freshWorkspace();
    await appendChange(ws, sample(), NOW);
    expect(readdirSync(ws.dir).sort()).toEqual(['audit', 'task.json']);
    expect(readdirSync(path.join(ws.dir, 'audit'))).toEqual(['changes.md']);
  });

  it('T-AU-01 (bytes): reproduces the entries the legacy engine wrote into the fixture workspace', async () => {
    const ws = freshWorkspace('legacy-demo');
    const at = Date.UTC(2026, 9, 11, 16, 38, 28);
    await appendChange(
      ws,
      {
        action: 'init-task',
        summary: "created task workspace 'legacy-demo'",
        reason: 'monitoring requested for this task',
        files: ['task.json', 'config.json', 'README.md'],
        validation: 'schema ok',
        outcome: 'created',
      },
      at,
    );
    await appendChange(
      ws,
      {
        action: 'configure',
        summary: 'window_hours: (default 8) -> 12',
        reason: 'synthetic fixture',
        files: ['config.json'],
        validation: 'schema ok (strict)',
        outcome: 'applied',
      },
      at,
    );
    expect(readFileSync(changesFile(ws))).toEqual(readFileSync(path.join(FIXTURE, 'audit', 'changes.md')));
  });

  it('a timestamp keeps seconds only (milliseconds are dropped, never rounded up)', async () => {
    const ws = freshWorkspace();
    await appendChange(ws, sample(), Date.UTC(2026, 11, 31, 23, 59, 59, 999));
    expect(readFileSync(changesFile(ws), 'utf8')).toContain('## 2026-12-31T23:59:59Z | configure\n');
  });

  it('rejects an action outside the catalogue and a time that is not a number', async () => {
    const ws = freshWorkspace();
    const bad = sample({ action: 'not-an-action' as AuditAction });
    await expect(appendChange(ws, bad, NOW)).rejects.toThrow(RangeError);
    await expect(appendChange(ws, sample(), Number.NaN)).rejects.toThrow(RangeError);
    expect(readdirSync(ws.dir)).toEqual(['task.json']);
  });

  it('T-SEC-04: refuses a link planted as audit/ and writes nothing through it', async () => {
    const ws = freshWorkspace();
    const elsewhere = path.join(makeTemp('audit-writer').path, 'elsewhere');
    mkdirSync(elsewhere);
    makeJunction(path.join(ws.dir, 'audit'), elsewhere);
    const error = await appendChange(ws, sample(), NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'WORKSPACE_SYMLINK' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('concurrent appends of one process stay intact: one header, every entry whole', async () => {
    const ws = freshWorkspace();
    const count = 24;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        appendChange(ws, sample({ summary: `entry ${String(i)}` }), NOW + i * 1000),
      ),
    );
    const text = readFileSync(changesFile(ws), 'utf8');
    expect(text.startsWith('# Changes\n\n## ')).toBe(true);
    expect(text.match(/^# Changes$/gm)).toHaveLength(1);
    const blocks = text.split(/^(?=## )/m).slice(1);
    expect(blocks).toHaveLength(count);
    const summaries = blocks.map((block) => /^- Summary: entry (\d+)$/m.exec(block)?.[1]).sort();
    expect(summaries).toEqual(Array.from({ length: count }, (_, i) => String(i)).sort());
    for (const block of blocks)
      expect(block).toMatch(
        /^## .*\n- Summary: .*\n- Reason: .*\n- Files changed: .*\n- Validation: .*\n- Outcome: .*\n- Unresolved: .*\n\n$/,
      );
  });

  it('works inside a caller that already holds the task mutex (no deadlock)', async () => {
    const ws = freshWorkspace();
    await withTaskMutex(ws, () => appendChange(ws, sample(), NOW), { timeoutMs: 500 });
    expect(readFileSync(changesFile(ws), 'utf8')).toContain('## 2026-10-11T14:05:07Z | configure');
  });
});

describe('appendDecision', () => {
  it('writes the decision template with its own file header', async () => {
    const ws = freshWorkspace();
    await appendDecision(ws, 'Keep the window short', 'Use twelve hours.', 'Forty eight hours.', NOW);
    await appendDecision(ws, 'configuration', 'Raise the port.', null, NOW + 1000);
    await appendDecision(ws, 'third', 'Do it.', '', NOW + 2000);
    expect(readFileSync(decisionsFile(ws), 'utf8')).toBe(
      '# Decisions\n\n' +
        '## 2026-10-11T14:05:07Z | Keep the window short\n- Decision: Use twelve hours.\n- Rejected alternatives: Forty eight hours.\n\n' +
        '## 2026-10-11T14:05:08Z | configuration\n- Decision: Raise the port.\n- Rejected alternatives: none recorded\n\n' +
        '## 2026-10-11T14:05:09Z | third\n- Decision: Do it.\n- Rejected alternatives: none recorded\n\n',
    );
  });

  it('T-AU-01 (bytes): reproduces the entry the legacy engine wrote into the fixture workspace', async () => {
    const ws = freshWorkspace('legacy-demo');
    await appendDecision(
      ws,
      'Keep the window short',
      'Use a twelve hour window for the fixture.',
      'A window of forty eight hours.',
      Date.UTC(2026, 9, 11, 16, 38, 28),
    );
    expect(readFileSync(decisionsFile(ws))).toEqual(readFileSync(path.join(FIXTURE, 'audit', 'decisions.md')));
  });

  it('exposes the pure entry texts the init transaction writes into its staging folder', () => {
    expect(decisionEntryText('t', 'd', null, NOW)).toBe(
      '## 2026-10-11T14:05:07Z | t\n- Decision: d\n- Rejected alternatives: none recorded\n\n',
    );
    expect(changeEntryText(sample(), NOW)).toBe(template('2026-10-11T14:05:07Z', sample()));
  });
});

describe('T-AU-05: newline injection cannot forge an entry', () => {
  const forged = ['## 2026-01-01T00:00:00Z | fake-action', '- Summary: forged'];

  function headerLines(bytes: string): string[] {
    return bytes.split('\n').filter((line) => line.startsWith('## '));
  }

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
    ['LF twice', '\n\n'],
  ])('summary, reason, files, validation, outcome and unresolved with %s', async (_name, eol) => {
    const ws = freshWorkspace();
    const attack = `before${eol}${forged.join(eol)}${eol}after`;
    await appendChange(
      ws,
      {
        action: 'configure',
        summary: attack,
        reason: attack,
        files: [attack, 'b.json'],
        validation: attack,
        outcome: attack,
        unresolved: attack,
      },
      NOW,
    );
    const bytes = readFileSync(changesFile(ws), 'utf8');
    expect(headerLines(bytes)).toEqual(['## 2026-10-11T14:05:07Z | configure']);
    expect(bytes).not.toContain('\r');
    expect(bytes.split('\n')).toHaveLength(template('x', sample()).split('\n').length + 2);
    expect((await lastChange(ws))?.t).toBe('2026-10-11T14:05:07Z');
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('decision title, text and rejected alternatives with %s', async (_name, eol) => {
    const ws = freshWorkspace();
    const attack = `before${eol}${forged.join(eol)}${eol}after`;
    await appendDecision(ws, attack, attack, attack, NOW);
    const bytes = readFileSync(decisionsFile(ws), 'utf8');
    expect(headerLines(bytes)).toHaveLength(1);
    expect(bytes).not.toContain('\r');
  });

  it('replaces each line break character by one space and touches nothing else', async () => {
    const ws = freshWorkspace();
    await appendChange(ws, sample({ summary: 'a\nb\r\nc\rd' }), NOW);
    expect(readFileSync(changesFile(ws), 'utf8')).toContain('- Summary: a b  c d\n');
  });
});

describe('lastChange and recentAudit against the legacy parser (T-AU-02)', () => {
  function block(ts: string, action: string, summary: string): string {
    return `## ${ts} | ${action}\n- Summary: ${summary}\n- Reason: r\n\n`;
  }
  const four =
    '# Changes\n\n' +
    [1, 2, 3, 4].map((i) => block(`2026-01-01T00:00:0${String(i)}Z`, 'configure', `change ${String(i)}`)).join('');

  function withChanges(text: string): WorkspaceRef {
    const ws = freshWorkspace();
    mkdirSync(path.join(ws.dir, 'audit'));
    writeFileSync(changesFile(ws), text);
    return ws;
  }

  const lastThree =
    '## 2026-01-01T00:00:02Z | configure\n- Summary: change 2\n- Reason: r\n\n' +
    '## 2026-01-01T00:00:03Z | configure\n- Summary: change 3\n- Reason: r\n\n' +
    '## 2026-01-01T00:00:04Z | configure\n- Summary: change 4\n- Reason: r\n\n';

  it.each([
    ['LF', (text: string) => text],
    ['CRLF', (text: string) => text.replaceAll('\n', '\r\n')],
    ['lone CR', (text: string) => text.replaceAll('\n', '\r')],
  ])('four entries, %s: the last change and the last three blocks', async (_name, convert) => {
    const ws = withChanges(convert(four));
    expect(await lastChange(ws)).toEqual({ t: '2026-01-01T00:00:04Z', summary: 'change 4' });
    expect(await recentAudit(ws)).toBe(lastThree);
    expect(await recentAudit(ws, 1)).toBe('## 2026-01-01T00:00:04Z | configure\n- Summary: change 4\n- Reason: r\n\n');
  });

  it('the fixture written by the legacy tool: both blocks and the header chunk (fewer than three pieces)', async () => {
    const ws = fixtureWorkspace();
    expect(await lastChange(ws)).toEqual({ t: '2026-10-11T16:38:28Z', summary: 'window_hours: (default 8) -> 12' });
    expect(await recentAudit(ws)).toBe(readFileSync(path.join(FIXTURE, 'audit', 'changes.md'), 'utf8'));
  });

  const cases: readonly {
    name: string;
    text: string;
    last: { t: string; summary: string } | null;
    recent3: string;
    recent1: string;
  }[] = [
    {
      name: 'a last block without a Summary line reports the header line',
      text: '# Changes\n\n## 2026-01-01T00:00:01Z | weird\nno summary here\n',
      last: { t: '2026-01-01T00:00:01Z', summary: '2026-01-01T00:00:01Z | weird' },
      recent3: '# Changes\n\n## 2026-01-01T00:00:01Z | weird\nno summary here\n',
      recent1: '## 2026-01-01T00:00:01Z | weird\nno summary here\n',
    },
    {
      name: 'Python strip: tab, NEL and spaces around the summary go',
      text: `# Changes\n\n## 2026-01-01T00:00:01Z | configure\n- Summary:   spaced \t${NEL}\n- Reason: r\n`,
      last: { t: '2026-01-01T00:00:01Z', summary: 'spaced' },
      recent3: `# Changes\n\n## 2026-01-01T00:00:01Z | configure\n- Summary:   spaced \t${NEL}\n- Reason: r\n`,
      recent1: `## 2026-01-01T00:00:01Z | configure\n- Summary:   spaced \t${NEL}\n- Reason: r\n`,
    },
    {
      name: 'a title with a pipe: the time is the part before the first pipe',
      text: '# Changes\n\n## 2026-01-01T00:00:01Z | a | b\n- Summary: x\n',
      last: { t: '2026-01-01T00:00:01Z', summary: 'x' },
      recent3: '# Changes\n\n## 2026-01-01T00:00:01Z | a | b\n- Summary: x\n',
      recent1: '## 2026-01-01T00:00:01Z | a | b\n- Summary: x\n',
    },
    {
      name: 'only the file header',
      text: '# Changes\n\n',
      last: null,
      recent3: '# Changes\n\n',
      recent1: '# Changes\n\n',
    },
    { name: 'an empty file', text: '', last: null, recent3: '', recent1: '' },
    {
      name: 'a file that starts with a block (empty first piece)',
      text: block('2026-01-01T00:00:01Z', 'a', 'first') + block('2026-01-01T00:00:02Z', 'b', 'second'),
      last: { t: '2026-01-01T00:00:02Z', summary: 'second' },
      recent3: block('2026-01-01T00:00:01Z', 'a', 'first') + block('2026-01-01T00:00:02Z', 'b', 'second'),
      recent1: block('2026-01-01T00:00:02Z', 'b', 'second'),
    },
    {
      name: 'a marker in the middle of a line is not a block',
      text: '# Changes\n\ntext ## not a block\n## 2026-01-01T00:00:01Z | a\n- Summary: ok\n',
      last: { t: '2026-01-01T00:00:01Z', summary: 'ok' },
      recent3: '# Changes\n\ntext ## not a block\n## 2026-01-01T00:00:01Z | a\n- Summary: ok\n',
      recent1: '## 2026-01-01T00:00:01Z | a\n- Summary: ok\n',
    },
    {
      name: 'two hashes without a space are not a marker',
      text: '# Changes\n\n##x\n## 2026-01-01T00:00:01Z | a\n- Summary: ok\n',
      last: { t: '2026-01-01T00:00:01Z', summary: 'ok' },
      recent3: '# Changes\n\n##x\n## 2026-01-01T00:00:01Z | a\n- Summary: ok\n',
      recent1: '## 2026-01-01T00:00:01Z | a\n- Summary: ok\n',
    },
    {
      name: 'the first "- Summary: " anywhere in the block wins (legacy re.search)',
      text: '# Changes\n\n## 2026-01-01T00:00:01Z | a\n- Reason: foo - Summary: from reason\n- Summary: real\n',
      last: { t: '2026-01-01T00:00:01Z', summary: 'from reason' },
      recent3: '# Changes\n\n## 2026-01-01T00:00:01Z | a\n- Reason: foo - Summary: from reason\n- Summary: real\n',
      recent1: '## 2026-01-01T00:00:01Z | a\n- Reason: foo - Summary: from reason\n- Summary: real\n',
    },
    {
      name: 'an empty Summary (no space after the colon) falls back to the header',
      text: '# Changes\n\n## 2026-01-01T00:00:01Z | a\n- Summary:\n- Reason: r\n',
      last: { t: '2026-01-01T00:00:01Z', summary: '2026-01-01T00:00:01Z | a' },
      recent3: '# Changes\n\n## 2026-01-01T00:00:01Z | a\n- Summary:\n- Reason: r\n',
      recent1: '## 2026-01-01T00:00:01Z | a\n- Summary:\n- Reason: r\n',
    },
    {
      name: 'a last line without a final newline',
      text: '# Changes\n\n## 2026-01-01T00:00:01Z | a\n- Summary: tail',
      last: { t: '2026-01-01T00:00:01Z', summary: 'tail' },
      recent3: '# Changes\n\n## 2026-01-01T00:00:01Z | a\n- Summary: tail',
      recent1: '## 2026-01-01T00:00:01Z | a\n- Summary: tail',
    },
    {
      name: 'exactly three blocks: the header chunk drops out',
      text:
        '# Changes\n\n' + [1, 2, 3].map((i) => block(`2026-01-01T00:00:0${String(i)}Z`, 'a', `n${String(i)}`)).join(''),
      last: { t: '2026-01-01T00:00:03Z', summary: 'n3' },
      recent3: [1, 2, 3].map((i) => block(`2026-01-01T00:00:0${String(i)}Z`, 'a', `n${String(i)}`)).join(''),
      recent1: block('2026-01-01T00:00:03Z', 'a', 'n3'),
    },
  ];

  it.each(cases)('$name', async ({ text, last, recent3, recent1 }) => {
    const ws = withChanges(text);
    expect(await lastChange(ws)).toEqual(last);
    expect(await recentAudit(ws)).toBe(recent3);
    expect(await recentAudit(ws, 1)).toBe(recent1);
  });

  it('a missing file gives null and the empty string, like the legacy OSError branch', async () => {
    const ws = freshWorkspace();
    expect(await lastChange(ws)).toBeNull();
    expect(await recentAudit(ws)).toBe('');
  });

  it('strips one BOM (Node reads the file as text with universal newlines)', async () => {
    const ws = withChanges(`${String.fromCodePoint(0xfeff)}# Changes\n\n${block('2026-01-01T00:00:01Z', 'a', 'bom')}`);
    expect(await lastChange(ws)).toEqual({ t: '2026-01-01T00:00:01Z', summary: 'bom' });
    expect(await recentAudit(ws)).toBe(`# Changes\n\n${block('2026-01-01T00:00:01Z', 'a', 'bom')}`);
  });

  it('refuses a block count that is not a positive integer', async () => {
    const ws = withChanges(four);
    await expect(recentAudit(ws, 0)).rejects.toThrow(RangeError);
    await expect(recentAudit(ws, 1.5)).rejects.toThrow(RangeError);
    await expect(recentAudit(ws, -1)).rejects.toThrow(RangeError);
  });
});
