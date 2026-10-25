import type { PanelDataMap } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso, makeUsage, sessionId } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { AttemptsPanel } from './AttemptsPanel.tsx';

type Attempts = PanelDataMap['attempts'];
type Row = Attempts['rows'][number];

function row(attemptId: number, over: Partial<Row> = {}): Row {
  return {
    part: `FIXTURE part ${String(attemptId)}`,
    n: attemptId,
    model: 'FIXTURE-model',
    effort: 'high',
    startedAt: iso(-600),
    endedAt: iso(-540),
    exit: 0,
    status: 'PASS',
    state: 'COMPLETED',
    sessionId: null,
    usage: makeUsage({ output: 12_345 }),
    attemptId,
    nRaw: String(attemptId),
    exitRaw: '0',
    endReason: 'ended',
    evidence: 'FIXTURE evidence: the log line matched',
    matchDeltaS: 2,
    ...over,
  };
}

function show(data: Attempts, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(<AttemptsPanel data={data} sources={[]} />, { locale });
}

describe('AttemptsPanel', () => {
  it('lists the attempts newest first in a table', () => {
    show({ sourceState: 'ok', rows: [row(1), row(2), row(3)] });
    const table = screen.getByRole('table', { name: msg('panels.attempts.list') });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('FIXTURE part 3');
    expect(rows[3]).toHaveTextContent('FIXTURE part 1');
  });

  it('shows the model with its effort, the duration and the output tokens', () => {
    show({ sourceState: 'ok', rows: [row(1)] });
    const line = screen.getAllByRole('row')[1]!;
    expect(line).toHaveTextContent('FIXTURE-model high');
    expect(line).toHaveTextContent('1m');
    expect(within(line).getByTitle('12,345')).toHaveTextContent('12K');
  });

  it('draws the result as a state badge with the evidence as its tooltip', () => {
    show({
      sourceState: 'ok',
      rows: [
        row(1, { state: 'FAILED', status: 'FAIL', exit: 1 }),
        row(2, { state: null, endedAt: null, status: null, exit: null, evidence: '' }),
      ],
    });
    const [running, failed] = [screen.getAllByRole('row')[1]!, screen.getAllByRole('row')[2]!];
    expect(within(running).getByText(msg('state.running.label'))).toBeInTheDocument();
    expect(failed.querySelector('[data-state="failed"]')).toHaveAttribute(
      'title',
      'FIXTURE evidence: the log line matched',
    );
  });

  it('derives the result when the monitor sent none', () => {
    show({ sourceState: 'ok', rows: [row(1, { state: null, status: 'PASS' })] });
    expect(screen.getByText(msg('state.completed.label'))).toBeInTheDocument();
  });

  it('links the part to its session when one was matched', () => {
    show({ sourceState: 'ok', rows: [row(1, { sessionId: sessionId(4) }), row(2)] });
    const link = screen.getByRole('link', { name: 'FIXTURE part 1' });
    expect(link).toHaveAttribute('href', `/sessions/${sessionId(4)}`);
    expect(screen.queryByRole('link', { name: 'FIXTURE part 2' })).not.toBeInTheDocument();
  });

  it('shows a dash, not zero, for a duration or tokens that are missing', () => {
    show({ sourceState: 'ok', rows: [row(1, { endedAt: null, usage: null, state: 'RUNNING' })] });
    const line = screen.getAllByRole('row')[1]!;
    expect(within(line).getAllByText(msg('common.notAvailable'))).toHaveLength(2);
  });

  it('draws a part that holds markup as text', () => {
    show({ sourceState: 'ok', rows: [row(1, { part: '<b>FIXTURE</b>' })] });
    expect(screen.getByText('<b>FIXTURE</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('says why there are no rows', () => {
    const cases: [Attempts, Parameters<typeof msg>[0]][] = [
      [{ sourceState: 'ok', rows: [] }, 'panels.attempts.empty'],
      [{ sourceState: 'not_configured', rows: [] }, 'panels.attempts.notConfigured'],
      [{ sourceState: 'missing', rows: [] }, 'panels.attempts.missing'],
      [{ sourceState: 'error', rows: [] }, 'panels.attempts.error'],
    ];
    for (const [data, key] of cases) {
      const { unmount } = show(data);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText(msg(key as 'panels.attempts.empty'))).toBeInTheDocument();
      unmount();
    }
  });

  it('is translated', () => {
    show({ sourceState: 'ok', rows: [row(1)] }, 'vi');
    expect(
      screen.getByRole('columnheader', { name: msg('panels.attempts.took', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByText(msg('state.completed.label', undefined, 'vi'))).toBeInTheDocument();
  });
});
