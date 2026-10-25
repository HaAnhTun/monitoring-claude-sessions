import type { PanelDataMap } from '@mcs/shared';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { ChainLogPanel, STICK_TOLERANCE_PX } from './ChainLogPanel.tsx';

type Lines = PanelDataMap['chainLog'];

function lines(text: string[], over: Partial<Lines> = {}): Lines {
  return { lines: text, file: 'FIXTURE-chain.log', exists: true, sizeBytes: 100, modifiedAt: iso(-30), ...over };
}

function ui(data: Lines) {
  return <ChainLogPanel data={data} sources={[]} />;
}

/** jsdom has no layout: give the tail a size and let a test move its scroll position. */
function sizeTail(tail: HTMLElement, scrollHeight: number, clientHeight: number): void {
  let top = 0;
  Object.defineProperty(tail, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(tail, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(tail, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => (top = value),
  });
}

describe('ChainLogPanel', () => {
  it('shows the lines in a labelled, focusable region', () => {
    renderWithIntl(ui(lines(['FIXTURE first', 'FIXTURE second'])));
    const tail = screen.getByRole('region', { name: msg('panels.chainLog.tail') });
    expect(tail).toHaveAttribute('tabindex', '0');
    expect(tail.tagName).toBe('PRE');
    expect(tail.textContent).toBe('FIXTURE first\nFIXTURE second');
  });

  it('renders a hostile line as text', () => {
    renderWithIntl(ui(lines(['<img src=x onerror=alert(1)>', '<script>FIXTURE</script>'])));
    const tail = screen.getByRole('region');
    expect(tail.querySelector('img, script')).toBeNull();
    expect(tail).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('says that the log is empty or not configured', () => {
    renderWithIntl(ui(lines([], { exists: false, file: null, sizeBytes: null, modifiedAt: null })));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByText(msg('panels.chainLog.empty'))).toBeInTheDocument();
  });

  it('sticks to the bottom for a reader who is at the bottom', () => {
    const { rerender } = renderWithIntl(ui(lines(['a'])));
    const tail = screen.getByRole('region');
    sizeTail(tail, 1000, 100);
    rerender(ui(lines(['a', 'b'])));
    expect(tail.scrollTop).toBe(1000);
  });

  it('follows a reader who is within the tolerance of the bottom', () => {
    const { rerender } = renderWithIntl(ui(lines(['a'])));
    const tail = screen.getByRole('region');
    sizeTail(tail, 1000, 100);
    tail.scrollTop = 1000 - 100 - STICK_TOLERANCE_PX;
    fireEvent.scroll(tail);
    rerender(ui(lines(['a', 'b'])));
    expect(tail.scrollTop).toBe(1000);
  });

  it('leaves a reader who scrolled up where they are', () => {
    const { rerender } = renderWithIntl(ui(lines(['a'])));
    const tail = screen.getByRole('region');
    sizeTail(tail, 1000, 100);
    tail.scrollTop = 1000 - 100 - STICK_TOLERANCE_PX - 1;
    fireEvent.scroll(tail);
    rerender(ui(lines(['a', 'b'])));
    expect(tail.scrollTop).toBe(1000 - 100 - STICK_TOLERANCE_PX - 1);
  });

  it('picks the bottom up again when the reader comes back to it', () => {
    const { rerender } = renderWithIntl(ui(lines(['a'])));
    const tail = screen.getByRole('region');
    sizeTail(tail, 1000, 100);
    tail.scrollTop = 200;
    fireEvent.scroll(tail);
    rerender(ui(lines(['a', 'b'])));
    expect(tail.scrollTop).toBe(200);
    tail.scrollTop = 900;
    fireEvent.scroll(tail);
    rerender(ui(lines(['a', 'b', 'c'])));
    expect(tail.scrollTop).toBe(1000);
  });

  it('does not move when the text did not change', () => {
    const { rerender } = renderWithIntl(ui(lines(['a'])));
    const tail = screen.getByRole('region');
    sizeTail(tail, 1000, 100);
    tail.scrollTop = 200;
    fireEvent.scroll(tail);
    rerender(ui(lines(['a'], { modifiedAt: iso(-5) })));
    expect(tail.scrollTop).toBe(200);
  });
});
