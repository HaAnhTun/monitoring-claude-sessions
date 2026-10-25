import type { PanelSourceState, SourceStatus } from '@mcs/shared';

import { Meter } from '../components/Meter.tsx';
import { useFormat, useT } from '../i18n/context.ts';
import { Dash, PanelNote, type PanelBodyProps } from './PanelFrame.tsx';

/** Above these percentages a meter says High. */
const RAM_HIGH_PCT = 85;
const CPU_HIGH_PCT = 90;

/** A source that did not fail and is not off: it may still produce a value (`pending` is the first sample). */
const WAITING: readonly SourceStatus[] = ['ok', 'pending'];

function statusOf(sources: readonly PanelSourceState[], source: PanelSourceState['source']): SourceStatus | null {
  return sources.find((entry) => entry.source === source)?.status ?? null;
}

/**
 * The Machine panel (04-ui.md 4.4.1): memory and CPU as two meters, the watched processes as a table and the Docker lines. A part
 * the machine cannot measure says so; it is never drawn as zero.
 */
export function MachinePanel({ data, sources }: PanelBodyProps<'machine'>) {
  const t = useT();
  const format = useFormat();

  const cpuStatus = statusOf(sources, 'cpu');
  const cpuWaiting = cpuStatus === null || WAITING.includes(cpuStatus);

  let ramText = '';
  if (data.usedPct !== null) {
    const pct = format.percent(data.usedPct / 100);
    if (data.totalGb !== null && data.freeGb !== null) {
      const fraction = { maximumFractionDigits: 1 };
      ramText = t('panels.machine.ramValue', {
        pct,
        used: format.number(Math.max(0, data.totalGb - data.freeGb), fraction),
        total: format.number(data.totalGb, fraction),
      });
    } else ramText = pct;
  }

  let processes;
  if (data.procs.length > 0) {
    processes = (
      <div className="panel-table-wrap">
        <table className="panel-table">
          <caption className="sr-only">{t('panels.machine.processes')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('panels.machine.process')}</th>
              <th scope="col" className="panel-table__num">
                {t('panels.machine.count')}
              </th>
              <th scope="col" className="panel-table__num">
                {t('panels.machine.memory')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.procs.map((proc) => (
              <tr key={proc.name}>
                <th scope="row" className="panel-table__name" title={proc.name}>
                  {proc.name}
                </th>
                <td className="panel-table__num">{format.number(proc.count)}</td>
                <td className="panel-table__num">
                  {proc.mb === null ? (
                    <Dash />
                  ) : (
                    t('panels.machine.megabytes', { value: format.number(proc.mb, { maximumFractionDigits: 0 }) })
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (data.procsStatus === 'pending') {
    processes = <PanelNote>{t('panels.machine.measuring')}</PanelNote>;
  } else if (data.procsStatus === 'disabled') {
    processes = <PanelNote>{t('panels.machine.processesOff')}</PanelNote>;
  } else if (data.procsStatus === 'ok') {
    processes = <PanelNote>{t('panels.machine.noProcesses')}</PanelNote>;
  } else {
    processes = <PanelNote>{t('panels.machine.unavailable')}</PanelNote>;
  }

  let docker;
  if (data.docker.length > 0) {
    docker = (
      <ul className="panel-lines" aria-label={t('panels.machine.docker')}>
        {data.docker.map((line, index) => (
          <li key={`${String(index)}:${line}`} className="mono" title={line}>
            {line}
          </li>
        ))}
      </ul>
    );
  } else if (data.dockerStatus === 'pending') {
    docker = <PanelNote>{t('panels.machine.measuring')}</PanelNote>;
  } else if (data.dockerStatus === 'ok') {
    docker = <PanelNote>{t('panels.machine.noContainers')}</PanelNote>;
  } else {
    docker = <PanelNote>{t('panels.machine.dockerUnavailable')}</PanelNote>;
  }

  return (
    <div className="panel-machine">
      <div className="panel-machine__meters">
        {data.usedPct !== null ? (
          <Meter label={t('panels.machine.ram')} pct={data.usedPct} valueText={ramText} highAbove={RAM_HIGH_PCT} />
        ) : (
          <div className="meter meter--unknown">
            <div className="meter__head">
              <span className="meter__label">{t('panels.machine.ram')}</span>
              <span className="meter__value muted">{t('panels.machine.unavailable')}</span>
            </div>
          </div>
        )}
        {data.cpuPct === null ? (
          <div className="meter meter--unknown">
            <div className="meter__head">
              <span className="meter__label">{t('panels.machine.cpu')}</span>
              <span className="meter__value muted">
                {cpuWaiting ? t('panels.machine.measuring') : t('panels.machine.unavailable')}
              </span>
            </div>
          </div>
        ) : (
          <Meter
            label={t('panels.machine.cpu')}
            pct={data.cpuPct}
            valueText={format.percent(data.cpuPct / 100)}
            highAbove={CPU_HIGH_PCT}
          />
        )}
      </div>
      <div className="panel-section">
        <h3 className="panel-section__title">{t('panels.machine.processes')}</h3>
        {processes}
      </div>
      {data.dockerEnabled ? (
        <div className="panel-section">
          <h3 className="panel-section__title">{t('panels.machine.docker')}</h3>
          {docker}
        </div>
      ) : null}
    </div>
  );
}
