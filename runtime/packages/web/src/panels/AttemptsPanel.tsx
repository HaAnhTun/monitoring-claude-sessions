import type { PanelDataMap } from '@mcs/shared';
import { Link } from 'react-router';

import { StateBadge } from '../components/StateBadge.tsx';
import { useFormat, useT } from '../i18n/context.ts';
import { attemptState } from '../lib/attempts.ts';
import { Dash, PanelNote, type PanelBodyProps } from './PanelFrame.tsx';

type AttemptRow = PanelDataMap['attempts']['rows'][number];

const MS_PER_SECOND = 1000;

/** The lifecycle word a five-state attempt result is drawn with. */
const RESULT_STATE = {
  RUNNING: 'running',
  IDLE: 'turn_ended',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
} as const;

/** The seconds an attempt took; `null` while it is open or when a time is missing. */
function tookSeconds(row: AttemptRow): number | null {
  if (row.startedAt === null || row.endedAt === null) return null;
  const seconds = (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / MS_PER_SECOND;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function AttemptLine({ row }: { row: AttemptRow }) {
  const t = useT();
  const format = useFormat();
  const took = tookSeconds(row);
  const output = row.usage?.output ?? null;
  const detail = [row.model, row.effort].filter((part): part is string => part !== null && part !== '').join(' ');
  return (
    <tr>
      <th scope="row" className="panel-table__name">
        <span className="panel-attempt__part">
          {row.sessionId === null ? (
            <span title={row.part}>{row.part}</span>
          ) : (
            <Link to={`/sessions/${row.sessionId}`} title={t('panels.attempts.open', { part: row.part })}>
              {row.part}
            </Link>
          )}
          {row.n === null ? null : <span className="muted"> #{row.n}</span>}
        </span>
        {detail === '' ? null : (
          <span className="panel-attempt__detail muted" title={detail}>
            {detail}
          </span>
        )}
      </th>
      <td>
        <StateBadge
          state={RESULT_STATE[attemptState(row)]}
          size="sm"
          evidenceTip={row.evidence === '' ? undefined : row.evidence}
        />
      </td>
      <td className="panel-table__num">{took === null ? <Dash /> : format.duration(took)}</td>
      <td className="panel-table__num">
        {output === null ? <Dash /> : <span title={format.number(output)}>{format.compact(output)}</span>}
      </td>
    </tr>
  );
}

/**
 * The Attempts panel (04-ui.md 4.4.1): one row per run of the chain, newest first, with the result as a state badge whose tooltip
 * is the evidence the server gives, how long it took and the tokens it wrote. The part is a link to its session when the monitor
 * matched one.
 */
export function AttemptsPanel({ data }: PanelBodyProps<'attempts'>) {
  const t = useT();
  if (data.sourceState === 'not_configured') return <PanelNote>{t('panels.attempts.notConfigured')}</PanelNote>;
  if (data.sourceState === 'missing') return <PanelNote>{t('panels.attempts.missing')}</PanelNote>;
  if (data.sourceState === 'error') return <PanelNote>{t('panels.attempts.error')}</PanelNote>;
  if (data.rows.length === 0) return <PanelNote>{t('panels.attempts.empty')}</PanelNote>;
  const newestFirst = [...data.rows].reverse();
  return (
    <div className="panel-table-wrap">
      <table className="panel-table" aria-label={t('panels.attempts.list')}>
        <thead>
          <tr>
            <th scope="col">{t('panels.attempts.part')}</th>
            <th scope="col">{t('panels.attempts.result')}</th>
            <th scope="col" className="panel-table__num">
              {t('panels.attempts.took')}
            </th>
            <th scope="col" className="panel-table__num">
              {t('panels.attempts.output')}
            </th>
          </tr>
        </thead>
        <tbody>
          {newestFirst.map((row) => (
            <AttemptLine key={row.attemptId} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
