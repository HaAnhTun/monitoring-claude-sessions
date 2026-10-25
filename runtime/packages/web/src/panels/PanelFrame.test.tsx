import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PanelViewStatus } from '../lib/panel-status.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { PanelFrame, type PanelFrameProps } from './PanelFrame.tsx';

afterEach(() => {
  vi.useRealTimers();
});

const NOW = Date.parse('2026-10-25T10:00:00.000Z');
const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

function frame(over: Partial<PanelFrameProps> = {}) {
  const props: PanelFrameProps = {
    panelKey: 'git',
    title: 'FIXTURE panel',
    icon: 'git-branch',
    status: { kind: 'ok', asOf: NOW - 12_000 },
    expanded: true,
    onToggle: () => undefined,
    children: <p>FIXTURE body</p>,
    ...over,
  };
  return <PanelFrame {...props} />;
}

describe('PanelFrame', () => {
  it('is a labelled section whose h2 holds the toggle button', () => {
    renderWithIntl(frame());
    expect(screen.getByRole('region', { name: 'FIXTURE panel' })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 2, name: 'FIXTURE panel' });
    const toggle = within(heading).getByRole('button', { name: 'FIXTURE panel' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(body).not.toBeNull();
    expect(body).toHaveTextContent('FIXTURE body');
    expect(body).toBeVisible();
  });

  it('asks the owner to toggle with the opposite state and hides the body while collapsed', async () => {
    const user = userEvent.setup();
    const calls: boolean[] = [];
    const onToggle = (open: boolean) => calls.push(open);
    const { rerender } = renderWithIntl(frame({ onToggle }));
    await user.click(screen.getByRole('button', { name: 'FIXTURE panel' }));
    expect(calls).toEqual([false]);
    rerender(frame({ onToggle, expanded: false }));
    const toggle = screen.getByRole('button', { name: 'FIXTURE panel' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeVisible();
    await user.click(toggle);
    expect(calls).toEqual([false, true]);
  });

  it('shows the age of the data and says nothing more while it is fine', () => {
    renderWithIntl(frame());
    expect(document.querySelector('.panel__asof time')).not.toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says Loading while nothing has arrived', () => {
    renderWithIntl(frame({ status: { kind: 'loading' } }));
    expect(screen.getByRole('status')).toHaveTextContent(msg('common.loading'));
    expect(document.querySelector('.panel__asof')).toBeNull();
  });

  it('counts the seconds of a stale panel', () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    vi.setSystemTime(NOW);
    renderWithIntl(frame({ status: { kind: 'stale', asOf: NOW - 45_000 } }));
    expect(screen.getByRole('status')).toHaveTextContent(msg('panels.status.stale', { age: '45s' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole('status')).toHaveTextContent(msg('panels.status.stale', { age: '50s' }));
  });

  it('lists one note per source of a partial answer as server text', () => {
    const notes = ['processes: pending, as of 12:00:01', 'docker: unavailable, docker is not installed'];
    renderWithIntl(frame({ status: { kind: 'partial', asOf: NOW, notes } }), { locale: 'vi' });
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent(msg('panels.status.partial', undefined, 'vi'));
    const items = within(line).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(notes);
    for (const item of items) expect(item).toHaveAttribute('lang', 'en');
  });

  it('says Could not load without older data', () => {
    renderWithIntl(frame({ status: { kind: 'error', message: 'No source produced data', lastGoodAt: null } }));
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent(`${msg('panels.status.errorLead')} No source produced data.`);
    expect(line).not.toHaveTextContent(msg('panels.status.keptData', { age: '0s' }));
  });

  it('says Could not refresh and how old the shown data is when there is older data', () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    vi.setSystemTime(NOW);
    const status: PanelViewStatus = { kind: 'error', message: 'Request failed (500).', lastGoodAt: NOW - 12_000 };
    renderWithIntl(frame({ status, errorDetail: 'The monitor failed.' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      `${msg('panels.status.refreshLead')} The monitor failed. ${msg('panels.status.keptData', { age: '12s' })}`,
    );
  });

  it('keeps the body of an errored panel so that the older data stays readable', () => {
    renderWithIntl(frame({ status: { kind: 'error', message: 'x', lastGoodAt: NOW - 1000 } }));
    expect(screen.getByText('FIXTURE body')).toBeVisible();
  });

  it('uses the catalogue in Vietnamese', () => {
    renderWithIntl(frame({ status: { kind: 'error', message: 'No source produced data', lastGoodAt: null } }), {
      locale: 'vi',
    });
    expect(screen.getByRole('status')).toHaveTextContent(msg('panels.status.errorLead', undefined, 'vi'));
  });
});
