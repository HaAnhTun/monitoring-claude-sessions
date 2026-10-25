import type { PanelDataMap } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { LedgerPanel } from './LedgerPanel.tsx';

type Lines = PanelDataMap['ledger'];

function lines(over: Partial<Lines> = {}): Lines {
  return {
    lines: [
      '| part | result | note |',
      '| --- | --- | --- |',
      '| FIXTURE A | PASS | fine |',
      '| FIXTURE B | FAILED | broke |',
    ],
    file: 'FIXTURE-ledger.md',
    exists: true,
    sizeBytes: 128,
    modifiedAt: iso(-90),
    ...over,
  };
}

function show(data: Lines, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(<LedgerPanel data={data} sources={[]} />, { locale });
}

describe('LedgerPanel', () => {
  it('draws the Markdown table without its separator line', () => {
    show(lines());
    const table = screen.getByRole('table', { name: msg('panels.ledger.table') });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['part', 'result', 'note']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('rowheader')).toHaveTextContent('FIXTURE A');
    expect(rows[1]).toHaveTextContent('fine');
  });

  it('reads a PASS-like cell as completed and a FAIL-like cell as failed, each with its word', () => {
    show(lines());
    const pass = screen.getByText('PASS').closest('[data-ledger-tone]');
    const fail = screen.getByText('FAILED').closest('[data-ledger-tone]');
    expect(pass).toHaveAttribute('data-ledger-tone', 'completed');
    expect(pass).toHaveClass('tone-completed');
    expect(fail).toHaveAttribute('data-ledger-tone', 'failed');
    expect(fail).toHaveClass('tone-failed');
    expect(screen.getByText('fine').closest('[data-ledger-tone]')).toBeNull();
  });

  it('draws a cell that holds markup as text', () => {
    show(lines({ lines: ['| part |', '| --- |', '| <script>FIXTURE</script> |'] }));
    expect(screen.getByText('<script>FIXTURE</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('names the file and when it changed', () => {
    show(lines());
    expect(screen.getByText('FIXTURE-ledger.md')).toHaveAttribute('title', 'FIXTURE-ledger.md');
    expect(document.querySelector('.panel-meta time')).not.toBeNull();
  });

  it('says that the ledger is empty', () => {
    show(lines({ lines: [] }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(msg('panels.ledger.empty'))).toBeInTheDocument();
  });

  it('says that no file is configured or found', () => {
    show(lines({ lines: [], exists: false, file: null, sizeBytes: null, modifiedAt: null }));
    expect(screen.getByText(msg('panels.ledger.missing'))).toBeInTheDocument();
  });

  it('is translated', () => {
    show(lines(), 'vi');
    expect(screen.getByRole('table', { name: msg('panels.ledger.table', undefined, 'vi') })).toBeInTheDocument();
  });
});
