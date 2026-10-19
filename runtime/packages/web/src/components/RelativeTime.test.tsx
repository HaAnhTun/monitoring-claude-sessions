import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFormatters } from '../i18n/format.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { FIXTURE_NOW_MS, iso } from '../test/fixtures/index.ts';
import { RelativeTime } from './RelativeTime.tsx';

afterEach(() => {
  vi.useRealTimers();
});

describe('RelativeTime', () => {
  it('renders a time element with the ISO value, a title and the relative age', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    renderWithIntl(<RelativeTime iso={iso(-125)} />);
    const age = createFormatters('en').relative(iso(-125), FIXTURE_NOW_MS);
    const time = screen.getByText(age);
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', iso(-125));
    expect(time).toHaveAttribute('title', `${iso(-125)} (${age})`);
  });

  it('re-renders from the shared one-second clock', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    renderWithIntl(<RelativeTime iso={iso(-2)} />);
    const f = createFormatters('en');
    expect(screen.getByText(f.relative(iso(-2), FIXTURE_NOW_MS))).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText(f.relative(iso(-2), FIXTURE_NOW_MS + 4000))).toBeInTheDocument();
    expect(f.relative(iso(-2), FIXTURE_NOW_MS + 4000)).not.toBe(f.relative(iso(-2), FIXTURE_NOW_MS));
  });

  it('reads the age in the language of the page', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    renderWithIntl(<RelativeTime iso={iso(-125)} />, { locale: 'vi' });
    const age = createFormatters('vi').relative(iso(-125), FIXTURE_NOW_MS);
    expect(screen.getByText(age)).toBeInTheDocument();
    expect(age).not.toBe(createFormatters('en').relative(iso(-125), FIXTURE_NOW_MS));
  });

  it('shows the wall clock in clock mode and both in both mode', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    const f = createFormatters('en');
    const { rerender } = renderWithIntl(<RelativeTime iso={iso(-60)} mode="clock" />);
    expect(screen.getByText(f.clock(iso(-60)))).toBeInTheDocument();
    rerender(<RelativeTime iso={iso(-60)} mode="both" />);
    expect(screen.getByText(`${f.clock(iso(-60))} (${f.relative(iso(-60), FIXTURE_NOW_MS)})`)).toBeInTheDocument();
  });

  it('starts the shared one-second clock for a relative time and not for a clock time', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clock = renderWithIntl(<RelativeTime iso={iso(-60)} mode="clock" />);
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 1000);
    clock.unmount();
    renderWithIntl(<RelativeTime iso={iso(-60)} />);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it('shows a dash with an explanation for a missing time', () => {
    renderWithIntl(<RelativeTime iso={null} />);
    const dash = screen.getByText('-');
    expect(dash).toHaveAttribute('title', msg('common.notAvailable'));
    expect(document.querySelector('time')).toBeNull();
  });

  it('falls back to the raw text for a time it cannot read', () => {
    renderWithIntl(<RelativeTime iso="not a time" />);
    expect(screen.getByText('not a time')).toBeInTheDocument();
  });
});
