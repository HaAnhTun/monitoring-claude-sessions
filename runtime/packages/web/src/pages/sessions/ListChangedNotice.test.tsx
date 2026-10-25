import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { StreamProvider, useStreamControls, type StreamControls } from '../../stream/StreamProvider.tsx';
import { createFakeEventSources } from '../../test/fake-event-source.ts';
import { makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { ListChangedNotice } from './ListChangedNotice.tsx';

const INSTANCE = makeInstance();
const KEY = qk.sessions(INSTANCE.instanceId, {});

/** Hands the stream controls (and so the pending counts of the reconciler) to the test. */
function Probe({ onControls }: { onControls: (controls: StreamControls | null) => void }) {
  const controls = useStreamControls();
  useEffect(() => {
    onControls(controls);
  }, [controls, onControls]);
  return null;
}

function setup(onRefresh = vi.fn(), locale: 'en' | 'vi' = 'en') {
  const sources = createFakeEventSources();
  let controls: StreamControls | null = null;
  const onControls = (next: StreamControls | null): void => {
    controls = next;
  };
  const wrap = (children: ReactNode): ReactNode => (
    <StreamProvider esFactory={sources.factory} listAtTop={() => true}>
      <Probe onControls={onControls} />
      {children}
    </StreamProvider>
  );
  renderWithIntl(<ListChangedNotice queryKey={KEY} onRefresh={onRefresh} />, { instance: INSTANCE, wrap, locale });
  const pending = (): NonNullable<StreamControls['pending']> => {
    if (controls === null) throw new Error('no stream controls');
    return controls.pending;
  };
  return { onRefresh, pending };
}

describe('ListChangedNotice', () => {
  it('shows nothing when no change is pending, and nothing outside a stream provider', () => {
    setup();
    expect(screen.queryByRole('status')).toBeNull();
    renderWithIntl(<ListChangedNotice queryKey={KEY} onRefresh={() => undefined} />, { instance: INSTANCE });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is a status region named "List changed" that counts the sessions, in the word of the language', () => {
    const { pending } = setup();
    act(() => {
      pending().bump(KEY);
      pending().bump(KEY);
    });
    const notice = screen.getByRole('status', { name: msg('sessions.changed.label') });
    expect(notice).toHaveTextContent(msg('sessions.changed.text', { count: 2 }));
    act(() => {
      pending().reset(KEY);
      pending().bump(KEY);
    });
    expect(notice).toHaveTextContent(msg('sessions.changed.text', { count: 1 }));
  });

  it('says it in Vietnamese', () => {
    const { pending } = setup(vi.fn(), 'vi');
    act(() => {
      pending().bump(KEY);
    });
    const notice = screen.getByRole('status', { name: msg('sessions.changed.label', undefined, 'vi') });
    expect(notice).toHaveTextContent(msg('sessions.changed.text', { count: 1 }, 'vi'));
    expect(
      within(notice).getByRole('button', { name: msg('sessions.changed.refresh', undefined, 'vi') }),
    ).toBeVisible();
  });

  it('carries the class that keeps it in view while the page scrolls', () => {
    const { pending } = setup();
    act(() => {
      pending().bump(KEY);
    });
    expect(screen.getByRole('status', { name: msg('sessions.changed.label') })).toHaveClass('list-changed');
  });

  it('forgets the count, then asks for a refresh, and goes away', async () => {
    const user = userEvent.setup();
    const { pending, onRefresh } = setup();
    act(() => {
      pending().bump(KEY);
    });
    await user.click(screen.getByRole('button', { name: msg('sessions.changed.refresh') }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(pending().get(KEY)).toBe(0);
    expect(screen.queryByRole('status', { name: msg('sessions.changed.label') })).toBeNull();
  });

  it('ignores changes that were counted for another list', () => {
    const { pending } = setup();
    act(() => {
      pending().bump(qk.sessions(INSTANCE.instanceId, { range: '7d' }));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
