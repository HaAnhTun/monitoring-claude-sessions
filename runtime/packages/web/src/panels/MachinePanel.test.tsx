import type { PanelDataMap, PanelSourceState } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makePanelData } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { MachinePanel } from './MachinePanel.tsx';

type Machine = PanelDataMap['machine'];

function machine(over: Partial<Machine> = {}): Machine {
  return { ...makePanelData('machine'), ...over };
}

const SOURCES: PanelSourceState[] = [
  { source: 'memory', status: 'ok', sampledAt: null, message: null },
  { source: 'cpu', status: 'ok', sampledAt: null, message: null },
];

function show(data: Machine, sources: PanelSourceState[] = SOURCES, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(<MachinePanel data={data} sources={sources} />, { locale });
}

describe('MachinePanel', () => {
  it('draws memory and CPU as two meters with their values', () => {
    show(machine({ usedPct: 50, totalGb: 16, freeGb: 8, cpuPct: 10 }));
    const [memory, cpu] = screen.getAllByRole('meter');
    expect(memory).toHaveAttribute('aria-valuenow', '50');
    expect(memory).toHaveAccessibleName(msg('panels.machine.ram'));
    expect(memory?.getAttribute('aria-valuetext')).toBe(
      msg('panels.machine.ramValue', { pct: '50%', used: '8', total: '16' }),
    );
    expect(cpu).toHaveAttribute('aria-valuenow', '10');
    expect(cpu).toHaveAccessibleName(msg('panels.machine.cpu'));
  });

  it('marks a meter High past its threshold', () => {
    const { unmount } = show(machine({ usedPct: 91, cpuPct: 95 }));
    expect(screen.getAllByText(msg('panels.meter.high'))).toHaveLength(2);
    unmount();
    show(machine({ usedPct: 40, cpuPct: 20 }));
    expect(screen.queryByText(msg('panels.meter.high'))).not.toBeInTheDocument();
  });

  it('says that memory is not available instead of drawing zero', () => {
    show(machine({ usedPct: null, totalGb: null, freeGb: null }), [
      { source: 'memory', status: 'unsupported', sampledAt: null, message: 'not supported here' },
    ]);
    expect(screen.getAllByRole('meter')).toHaveLength(1);
    expect(screen.getByText(msg('panels.machine.unavailable'))).toBeInTheDocument();
  });

  it('reads the first CPU sample as measuring and an unsupported CPU as unavailable', () => {
    const { unmount } = show(machine({ cpuPct: null }));
    expect(screen.getByText(msg('panels.machine.measuring'))).toBeInTheDocument();
    expect(screen.getAllByRole('meter')).toHaveLength(1);
    unmount();
    show(machine({ cpuPct: null }), [{ source: 'cpu', status: 'unsupported', sampledAt: null, message: null }]);
    expect(screen.queryByText(msg('panels.machine.measuring'))).not.toBeInTheDocument();
    expect(screen.getByText(msg('panels.machine.unavailable'))).toBeInTheDocument();
  });

  it('lists the watched processes in a table, memory missing as a dash', () => {
    show(
      machine({
        procs: [
          { name: 'FIXTURE-node', count: 3, mb: 1234 },
          { name: 'FIXTURE-tool', count: 1, mb: null },
        ],
      }),
    );
    const table = screen.getByRole('table', { name: msg('panels.machine.processes') });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('rowheader')).toHaveTextContent('FIXTURE-node');
    expect(rows[1]).toHaveTextContent('1,234 MB');
    expect(within(rows[2]!).getByText(msg('common.notAvailable'))).toBeInTheDocument();
  });

  it('tells apart no process, a source that is off and a source that cannot be read', () => {
    const states: [Machine['procsStatus'], Parameters<typeof msg>[0]][] = [
      ['ok', 'panels.machine.noProcesses'],
      ['disabled', 'panels.machine.processesOff'],
      ['pending', 'panels.machine.measuring'],
      ['unsupported', 'panels.machine.unavailable'],
      ['unavailable', 'panels.machine.unavailable'],
      ['error', 'panels.machine.unavailable'],
    ];
    for (const [status, key] of states) {
      const { unmount } = show(machine({ procs: [], procsStatus: status, cpuPct: 5 }));
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText(msg(key as 'panels.machine.noProcesses'))).toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the last rows while the source reports an error', () => {
    show(machine({ procs: [{ name: 'FIXTURE-node', count: 1, mb: 10 }], procsStatus: 'error' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('shows the Docker lines as text only when Docker is watched', () => {
    const { unmount } = show(machine({ dockerEnabled: false, docker: [] }));
    expect(screen.queryByText(msg('panels.machine.docker'))).not.toBeInTheDocument();
    unmount();
    show(
      machine({ dockerEnabled: true, dockerStatus: 'ok', docker: ['FIXTURE-db (Up 3 hours)', '<b>FIXTURE</b> (Up)'] }),
    );
    const list = screen.getByRole('list', { name: msg('panels.machine.docker') });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.querySelector('b')).toBeNull();
    expect(list).toHaveTextContent('<b>FIXTURE</b> (Up)');
  });

  it('reads an empty Docker list by the state of its source', () => {
    const { unmount } = show(machine({ dockerEnabled: true, dockerStatus: 'ok', docker: [] }));
    expect(screen.getByText(msg('panels.machine.noContainers'))).toBeInTheDocument();
    unmount();
    show(machine({ dockerEnabled: true, dockerStatus: 'unavailable', docker: [] }));
    expect(screen.getByText(msg('panels.machine.dockerUnavailable'))).toBeInTheDocument();
  });

  it('is translated', () => {
    show(machine({ cpuPct: null, procs: [] }), SOURCES, 'vi');
    expect(screen.getByText(msg('panels.machine.ram', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByText(msg('panels.machine.measuring', undefined, 'vi'))).toBeInTheDocument();
  });
});
