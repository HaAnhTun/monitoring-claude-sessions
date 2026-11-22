// The names of a failed ingest transaction (CAW-146): what the log line and the PERSIST_FAILED detail say, and that neither
// can carry a value of a row.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { DbError } from '../db/errors.ts';
import { LOG_FIELD_NAMES, createLogger } from '../log/logger.ts';
import { commitFailureLogFields, describeFailure, persistFailedDetail } from './commit-failure.ts';

/** The shape the logger keeps (05 5.3 S-LOG-1): an allow-listed name and a short plain value. */
const SAFE_STRING = /^[\w.:/@-]{0,128}$/;

function expectLoggable(fields: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(fields)) {
    expect(LOG_FIELD_NAMES, name).toContain(name);
    if (typeof value === 'string') expect(value, name).toMatch(SAFE_STRING);
  }
}

const CHECK = new DbError('db_constraint', 'database constraint failed (check) (SQLITE_CONSTRAINT_CHECK)', {
  constraint: 'check',
  sqliteCode: 'SQLITE_CONSTRAINT_CHECK',
  table: 'tool_calls',
  constraintTarget: 'summary IS NULL OR length(summary) <= 160',
});
const TOOL_START = { kind: 'record', events: [{ k: 'activity' }, { k: 'tool.start' }, { k: 'activity' }] };

describe('describeFailure', () => {
  it('reads the code, the constraint, the SQLite name, the table and what SQLite named from a DbError', () => {
    expect(describeFailure(CHECK)).toEqual({
      code: 'db_constraint',
      constraint: 'check',
      sqliteCode: 'SQLITE_CONSTRAINT_CHECK',
      table: 'tool_calls',
      target: 'summary IS NULL OR length(summary) <= 160',
    });
  });

  it('takes the constant message of a check a repository made itself as the target', () => {
    const own = new DbError('db_constraint', 'the transcript file does not exist', { constraint: 'foreignkey' });
    expect(describeFailure(own)).toEqual({
      code: 'db_constraint',
      constraint: 'foreignkey',
      sqliteCode: null,
      table: null,
      target: 'the transcript file does not exist',
    });
  });

  it('never reads the message of another DbError or of an error that is not one', () => {
    expect(
      describeFailure(new DbError('db_busy', 'database is busy (SQLITE_BUSY)', { sqliteCode: 'SQLITE_BUSY' })),
    ).toEqual({ code: 'db_busy', constraint: null, sqliteCode: 'SQLITE_BUSY', table: null, target: null });
    expect(describeFailure(new RangeError('PRIVATE text of a record'))).toEqual({
      code: 'RangeError',
      constraint: null,
      sqliteCode: null,
      table: null,
      target: null,
    });
    const odd = new Error('PRIVATE');
    odd.name = 'a name with PRIVATE words';
    expect(describeFailure(odd).code).toBe('unknown');
    expect(describeFailure('PRIVATE').code).toBe('unknown');
  });
});

describe('commitFailureLogFields', () => {
  it('names the constraint, the table and the one item that failed, in fields the logger keeps', () => {
    const fields = commitFailureLogFields(describeFailure(CHECK), { source: 'transcript', items: [TOOL_START] });
    expect(fields).toEqual({
      code: 'db_constraint',
      status: 'SQLITE_CONSTRAINT_CHECK',
      phase: 'tool_calls/summary_IS_NULL_OR_length_summary_160',
      kind: 'transcript/record/activity:tool.start',
      count: 1,
    });
    expectLoggable(fields);
  });

  it('names only the source and the number of items of a transaction of several items', () => {
    const fields = commitFailureLogFields(describeFailure(CHECK), {
      source: 'spool',
      items: [TOOL_START, { kind: 'envelope', events: [] }],
    });
    expect(fields).toMatchObject({ kind: 'spool', count: 2 });
    expectLoggable(fields);
  });

  it('keeps the code alone for an error without names, and says so for an item without events', () => {
    const fields = commitFailureLogFields(describeFailure(new Error('PRIVATE')), {
      source: 'sweeper',
      items: [{ kind: 'derive', events: [] }],
    });
    expect(fields).toEqual({ code: 'Error', kind: 'sweeper/derive/none', count: 1 });
    expectLoggable(fields);
  });

  it('stays loggable for a long list of events and a long constraint text', () => {
    const many = { kind: 'record', events: Array.from({ length: 40 }, (_, i) => ({ k: `kind.number_${String(i)}` })) };
    const long = new DbError('db_constraint', 'database constraint failed (check) (SQLITE_CONSTRAINT_CHECK)', {
      constraint: 'check',
      sqliteCode: 'SQLITE_CONSTRAINT_CHECK',
      table: 'sessions',
      constraintTarget: `state IN (${"'running',".repeat(30)})`,
    });
    const fields = commitFailureLogFields(describeFailure(long), { source: 'transcript', items: [many] });
    expectLoggable(fields);
    expect(fields['kind']).toMatch(/:more$/);
  });
});

describe('the line the real logger writes', () => {
  const tempDir = useTempDirs();

  async function written(fields: Record<string, string | number>): Promise<{ line: unknown; dropped: number }> {
    const file = path.join(tempDir('commit-failure').path, 'runtime.log');
    const logger = createLogger({ file, level: 'debug', rotate: false, clock: new FakeClock(1_800_000_000_000) });
    logger.warn('ingest_commit_failed', fields);
    await logger.close();
    const line: unknown = JSON.parse(readFileSync(file, 'utf8').trim());
    return { line, dropped: logger.stats.droppedFields };
  }

  it('keeps every field of a constraint failure: none is dropped by the allow-list', async () => {
    const fields = commitFailureLogFields(describeFailure(CHECK), { source: 'transcript', items: [TOOL_START] });
    const { line, dropped } = await written(fields);
    expect(dropped).toBe(0);
    expect(line).toMatchObject({ level: 'warn', event: 'ingest_commit_failed', ...fields });
  });

  it('keeps every field whatever characters the names of the schema or of the item hold', async () => {
    const odd = new DbError('db_constraint', 'database constraint failed (check) (SQLITE_CONSTRAINT_CHECK)', {
      constraint: 'check',
      sqliteCode: 'SQLITE_CONSTRAINT_CHECK',
      table: 'sessions',
      constraintTarget: `kind IN ('main','sub agent') AND "quoted" <> x'00' -- ${'long '.repeat(40)}`,
    });
    const item = { kind: 'a kind\nwith a line break', events: [{ k: 'tab\tand "quote"' }, { k: 'é\u{1F600}' }] };
    const fields = commitFailureLogFields(describeFailure(odd), { source: 'spool', items: [item] });
    expectLoggable(fields);
    const { dropped } = await written(fields);
    expect(dropped).toBe(0);
  });
});

describe('persistFailedDetail', () => {
  it('says the constraint, the table, what SQLite named and the item', () => {
    expect(persistFailedDetail(describeFailure(CHECK), 'transcript', TOOL_START)).toBe(
      'item could not be stored (db_constraint check; tool_calls; summary IS NULL OR length(summary) <= 160; transcript record: activity, tool.start)',
    );
  });

  it('says the code and the item for an error without names', () => {
    expect(
      persistFailedDetail(describeFailure(new RangeError('PRIVATE')), 'external', { kind: 'external', events: [] }),
    ).toBe('item could not be stored (RangeError; external external)');
    expect(persistFailedDetail(describeFailure(undefined), 'spool', undefined)).toBe(
      'item could not be stored (unknown; spool)',
    );
  });

  it('never exceeds the 200 code points of the column', () => {
    const long = new DbError('db_constraint', 'database constraint failed (check) (SQLITE_CONSTRAINT_CHECK)', {
      constraint: 'check',
      sqliteCode: 'SQLITE_CONSTRAINT_CHECK',
      table: 'sessions',
      constraintTarget: 'x'.repeat(120),
    });
    const many = { kind: 'record', events: Array.from({ length: 40 }, (_, i) => ({ k: `kind.number_${String(i)}` })) };
    const detail = persistFailedDetail(describeFailure(long), 'transcript', many);
    expect(Array.from(detail).length).toBeLessThanOrEqual(200);
    expect(detail).toContain(`; ${'x'.repeat(80)}; transcript record`);
  });
});
