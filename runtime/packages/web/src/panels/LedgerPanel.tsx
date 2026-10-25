import { useMemo } from 'react';

import { RelativeTime } from '../components/RelativeTime.tsx';
import { useT } from '../i18n/context.ts';
import { parseLedger, type LedgerCell } from '../lib/ledger.ts';
import { PanelNote, type PanelBodyProps } from './PanelFrame.tsx';

/** A cell of the table: a PASS-like or FAIL-like word is a state badge (a dot and the word), anything else is text. */
function Cell({ cell }: { cell: LedgerCell }) {
  if (cell.tone === null) return <>{cell.text}</>;
  return (
    <span className={`badge badge--state badge--sm tone-${cell.tone}`} data-ledger-tone={cell.tone}>
      <span className="state-dot state-dot--solid" aria-hidden="true" />
      <span className="badge__word">{cell.text}</span>
    </span>
  );
}

/**
 * The Ledger panel (04-ui.md 4.4.1): the Markdown table the chain keeps, as a table. The cells are the file's own text and are
 * never translated; a PASS-like cell reads as completed and a FAIL-like one as failed, each with its word.
 */
export function LedgerPanel({ data }: PanelBodyProps<'ledger'>) {
  const t = useT();
  const ledger = useMemo(() => parseLedger(data.lines), [data.lines]);
  if (!data.exists) return <PanelNote>{t('panels.ledger.missing')}</PanelNote>;
  if (ledger.header.length === 0 && ledger.rows.length === 0) return <PanelNote>{t('panels.ledger.empty')}</PanelNote>;
  return (
    <div className="panel-ledger">
      <div className="panel-table-wrap">
        <table className="panel-table" aria-label={t('panels.ledger.table')}>
          <thead>
            <tr>
              {ledger.header.map((name, index) => (
                <th key={`${String(index)}:${name}`} scope="col">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ledger.rows.map((cells, rowIndex) => (
              <tr key={rowIndex}>
                {cells.map((cell, index) =>
                  index === 0 ? (
                    <th key={index} scope="row" className="panel-table__name">
                      <Cell cell={cell} />
                    </th>
                  ) : (
                    <td key={index}>
                      <Cell cell={cell} />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.file === null ? null : (
        <p className="panel-meta muted">
          <span className="panel-meta__file mono" title={data.file}>
            {data.file}
          </span>
          {data.modifiedAt === null ? null : <RelativeTime iso={data.modifiedAt} />}
        </p>
      )}
    </div>
  );
}
