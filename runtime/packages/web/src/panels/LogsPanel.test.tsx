import type { PanelDataMap } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { LogsPanel, WRITING_NOW_S } from './LogsPanel.tsx';

type Logs = PanelDataMap['logs'];
type File = Logs['files'][number];

function file(name: string, over: Partial<File> = {}): File {
  return {
    name,
    ageS: 5,
    sizeBytes: 2048,
    tail: ['FIXTURE line 1', 'FIXTURE line 2'],
    relPath: `logs/${name}`,
    modifiedAt: iso(-5),
    ...over,
  };
}

function show(data: Logs, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(<LogsPanel data={data} sources={[]} />, { locale });
}

describe('LogsPanel', () => {
  it('shows each file with its name, its size and a labelled tail', () => {
    show({ files: [file('FIXTURE-a.log'), file('FIXTURE-b.log', { tail: ['other'] })], matchedFiles: 2 });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('FIXTURE-a.log')).toHaveAttribute('title', 'logs/FIXTURE-a.log');
    expect(screen.getAllByText('2 KB')).toHaveLength(2);
    const tail = screen.getByRole('region', { name: msg('panels.logs.tail', { name: 'FIXTURE-a.log' }) });
    expect(tail).toHaveAttribute('tabindex', '0');
    expect(tail.textContent).toBe('FIXTURE line 1\nFIXTURE line 2');
  });

  it('says writing now below the threshold and idle with the age from it', () => {
    show({
      files: [
        file('FIXTURE-a.log', { ageS: WRITING_NOW_S - 1 }),
        file('FIXTURE-b.log', { ageS: WRITING_NOW_S }),
        file('FIXTURE-c.log', { ageS: 300 }),
      ],
      matchedFiles: 3,
    });
    const [writing, idleEdge, idle] = screen.getAllByRole('listitem');
    expect(writing).toHaveTextContent(msg('panels.logs.writing'));
    expect(within(writing!).getByText(msg('panels.logs.writing')).parentElement).toHaveAttribute(
      'data-writing',
      'true',
    );
    expect(idleEdge).toHaveTextContent(msg('panels.logs.idle', { age: '30s' }));
    expect(idle).toHaveTextContent(msg('panels.logs.idle', { age: '5m' }));
  });

  it('draws a hostile line as text', () => {
    show({
      files: [file('FIXTURE-a.log', { tail: ['<iframe src="javascript:alert(1)"></iframe>'] })],
      matchedFiles: 1,
    });
    const tail = screen.getByRole('region');
    expect(tail.querySelector('iframe')).toBeNull();
    expect(tail).toHaveTextContent('<iframe src="javascript:alert(1)"></iframe>');
  });

  it('says that nothing has been written yet instead of an empty region', () => {
    show({ files: [file('FIXTURE-a.log', { tail: [] })], matchedFiles: 1 });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByText(msg('panels.logs.noLines'))).toBeInTheDocument();
  });

  it('says how many matching files are not shown', () => {
    show({ files: [file('FIXTURE-a.log')], matchedFiles: 7 });
    expect(screen.getByText(msg('panels.logs.more', { shown: '1', total: '7' }))).toBeInTheDocument();
  });

  it('says that there are no log files', () => {
    show({ files: [], matchedFiles: 0 });
    expect(screen.getByText(msg('panels.logs.empty'))).toBeInTheDocument();
  });

  it('is translated', () => {
    show({ files: [file('FIXTURE-a.log', { ageS: 90 })], matchedFiles: 1 }, 'vi');
    expect(
      screen.getByRole('region', { name: msg('panels.logs.tail', { name: 'FIXTURE-a.log' }, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByText(msg('panels.logs.idle', { age: '2 phút' }, 'vi'))).toBeInTheDocument();
  });
});
