import { describe, expect, it } from 'vitest';

import { SENTINEL, notificationSession, parsedRecords } from '../../../test/fixtures/transcripts.ts';
import { parseTaskNotification } from './task-notification.ts';

const NONE = { taskId: null, toolUseId: null, status: null };

function wrap(inner: string): string {
  return `<task-notification>${inner}</task-notification>`;
}

describe('parseTaskNotification (T-TR-19)', () => {
  it('reads the task id, the tool use id and each of the four statuses from fixture 17', () => {
    const records = parsedRecords(notificationSession()).filter(
      (r) => (r['origin'] as { kind?: string } | undefined)?.kind === 'task-notification',
    );
    const parsed = records.map((r) => parseTaskNotification((r['message'] as { content: unknown }).content));
    expect(parsed.map((p) => p.status)).toEqual(['completed', 'failed', 'killed', 'stopped', null]);
    expect(parsed.map((p) => p.taskId)).toEqual([
      'task_fixture_a',
      'task_fixture_b',
      'task_fixture_c',
      'task_fixture_d',
      'task_fixture_e',
    ]);
    for (const p of parsed) expect(p.toolUseId).toMatch(/^toolu_fixture_/);
  });

  it('gives only the three fields and never the body of <result>, <summary>, <usage> or <output-file>', () => {
    const text = wrap(
      [
        '<task-id>t1</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        '<output-file>FIXTURE/out.txt</output-file>',
        '<status>completed</status>',
        `<result>${SENTINEL.notificationResult}</result>`,
        `<summary>${SENTINEL.notificationSummary}</summary>`,
        '<usage><total_tokens>1</total_tokens></usage>',
      ].join('\n'),
    );
    const parsed = parseTaskNotification(text);
    expect(parsed).toEqual({ taskId: 't1', toolUseId: 'toolu_1', status: 'completed' });
    expect(JSON.stringify(parsed)).not.toContain('SENTINEL');
  });

  it('takes the first occurrence of each tag', () => {
    const text = wrap(
      '<status>failed</status><task-id>first</task-id><status>completed</status><task-id>second</task-id>',
    );
    expect(parseTaskNotification(text)).toEqual({ taskId: 'first', toolUseId: null, status: 'failed' });
  });

  it('uses a first occurrence that fails validation as null and never falls through to a later one', () => {
    const tooLong = wrap(`<task-id>${'a'.repeat(201)}</task-id><task-id>second</task-id>`);
    expect(parseTaskNotification(tooLong).taskId).toBeNull();
    const nested = wrap('<task-id>a<b</task-id><task-id>second</task-id>');
    expect(parseTaskNotification(nested).taskId).toBeNull();
    const badStatus = wrap('<status>weird</status><status>completed</status>');
    expect(parseTaskNotification(badStatus).status).toBeNull();
    const unclosed = wrap('<task-id>one<task-id>two</task-id>');
    expect(parseTaskNotification(unclosed).taskId).toBeNull();
  });

  it('treats a status outside the four known ones as an event-only notification', () => {
    expect(parseTaskNotification(wrap('<task-id>t</task-id><status>running</status>')).status).toBeNull();
    expect(parseTaskNotification(wrap('<task-id>t</task-id><status>COMPLETED</status>')).status).toBeNull();
  });

  it('reads the first text block of a list content', () => {
    const content = [
      { type: 'image', source: 'ignored' },
      { type: 'text', text: wrap('<task-id>t9</task-id><status>killed</status>') },
      { type: 'text', text: wrap('<task-id>t10</task-id>') },
    ];
    expect(parseTaskNotification(content)).toEqual({ taskId: 't9', toolUseId: null, status: 'killed' });
  });

  it('reads only the first 64 KiB', () => {
    const late = `${'x'.repeat(70_000)}${wrap('<task-id>late</task-id><status>completed</status>')}`;
    expect(parseTaskNotification(late)).toEqual(NONE);
    const early = `${wrap('<task-id>early</task-id>')}${'x'.repeat(70_000)}`;
    expect(parseTaskNotification(early).taskId).toBe('early');
  });

  it('ignores a tag value longer than 200 characters or an id with characters an id cannot have', () => {
    expect(parseTaskNotification(wrap(`<task-id>${'a'.repeat(201)}</task-id>`)).taskId).toBeNull();
    expect(parseTaskNotification(wrap('<tool-use-id>has space</tool-use-id>')).toolUseId).toBeNull();
    expect(parseTaskNotification(wrap('<task-id>a b</task-id>')).taskId).toBeNull();
  });

  it('returns nothing for content that is not text', () => {
    expect(parseTaskNotification(undefined)).toEqual(NONE);
    expect(parseTaskNotification(42)).toEqual(NONE);
    expect(parseTaskNotification([])).toEqual(NONE);
    expect(parseTaskNotification([{ type: 'image' }])).toEqual(NONE);
    expect(parseTaskNotification('no tags at all')).toEqual(NONE);
  });
});
