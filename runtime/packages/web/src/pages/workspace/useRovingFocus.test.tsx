import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useRovingFocus } from './useRovingFocus.ts';

interface ListProps {
  ids: readonly string[];
  /** A different generation remounts every item: a re-render that replaces the focused element. */
  generation?: number;
  preferred?: string | null;
  disabled?: readonly string[];
}

function List({ ids, generation = 0, preferred = null, disabled = [] }: ListProps) {
  const { containerRef, focusTabStop } = useRovingFocus<HTMLUListElement>({ preferredId: preferred });
  return (
    <>
      <button type="button">before</button>
      <ul ref={containerRef} aria-label="items">
        <li>
          <input aria-label="inside field" />
        </li>
        {ids.map((id) => (
          <li key={`${String(generation)}:${id}`}>
            <button type="button" data-nav-item="" data-nav-id={id} disabled={disabled.includes(id)}>
              {id}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          focusTabStop();
        }}
      >
        go
      </button>
      <button type="button">after</button>
    </>
  );
}

const item = (id: string): HTMLElement => screen.getByRole('button', { name: id });
const tabStops = (): string[] =>
  screen
    .getAllByRole('button')
    .filter((button) => button.dataset['navItem'] !== undefined && button.getAttribute('tabindex') === '0')
    .map((button) => button.dataset['navId'] ?? '');

describe('useRovingFocus', () => {
  it('leaves exactly one item of the list in the tab order, the first by default', () => {
    render(<List ids={['a', 'b', 'c']} />);
    expect(tabStops()).toEqual(['a']);
    expect(item('b')).toHaveAttribute('tabindex', '-1');
    expect(item('c')).toHaveAttribute('tabindex', '-1');
  });

  it('makes the preferred item (the selected row) the tab stop, and follows a change of it', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} preferred="b" />);
    expect(tabStops()).toEqual(['b']);
    rerender(<List ids={['a', 'b', 'c']} preferred="c" />);
    expect(tabStops()).toEqual(['c']);
  });

  it('falls back to the first item when the preferred one is not in the list', () => {
    render(<List ids={['a', 'b']} preferred="gone" />);
    expect(tabStops()).toEqual(['a']);
  });

  it('enters the list on one Tab and leaves it on the next', async () => {
    const user = userEvent.setup();
    render(<List ids={['a', 'b', 'c']} preferred="b" />);
    item('b').focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'go' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(item('b')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('textbox', { name: 'inside field' })).toHaveFocus();
  });

  it('moves with the arrow keys, takes the tab stop along and does not wrap', async () => {
    const user = userEvent.setup();
    render(<List ids={['a', 'b', 'c']} />);
    item('a').focus();
    await user.keyboard('{ArrowDown}');
    expect(item('b')).toHaveFocus();
    expect(tabStops()).toEqual(['b']);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(item('c')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(item('b')).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(item('a')).toHaveFocus();
    expect(tabStops()).toEqual(['a']);
  });

  it('jumps with Home and End', async () => {
    const user = userEvent.setup();
    render(<List ids={['a', 'b', 'c', 'd']} />);
    item('b').focus();
    await user.keyboard('{End}');
    expect(item('d')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(item('a')).toHaveFocus();
  });

  it('skips a disabled item', async () => {
    const user = userEvent.setup();
    render(<List ids={['a', 'b', 'c']} disabled={['b']} />);
    item('a').focus();
    await user.keyboard('{ArrowDown}');
    expect(item('c')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(item('a')).toHaveFocus();
  });

  it('never takes a key that is not meant for an item, nor one with a modifier', async () => {
    const user = userEvent.setup();
    render(<List ids={['a', 'b']} />);
    const field = screen.getByRole('textbox', { name: 'inside field' });
    field.focus();
    await user.keyboard('{ArrowDown}{End}');
    expect(field).toHaveFocus();
    item('a').focus();
    await user.keyboard('{Control>}{End}{/Control}');
    expect(item('a')).toHaveFocus();
    await user.keyboard('x');
    expect(item('a')).toHaveFocus();
  });

  it('puts the focus back on the item with the same id when a re-render replaced it', async () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} generation={0} />);
    item('b').focus();
    const before = item('b');
    rerender(<List ids={['a', 'b', 'c']} generation={1} />);
    await waitFor(() => {
      expect(item('b')).toHaveFocus();
    });
    expect(item('b')).not.toBe(before);
    expect(tabStops()).toEqual(['b']);
  });

  it('puts the focus back when an item moved within the list', async () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} />);
    item('c').focus();
    rerender(<List ids={['c', 'a', 'b']} generation={1} />);
    await waitFor(() => {
      expect(item('c')).toHaveFocus();
    });
  });

  it('leaves a focus alone that the person moved out of the list', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<List ids={['a', 'b']} />);
    item('b').focus();
    await user.click(screen.getByRole('button', { name: 'after' }));
    rerender(<List ids={['a', 'b']} generation={1} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('keeps one tab stop when items arrive later, and gives the new ones none', async () => {
    function Growing() {
      const [ids, setIds] = useState(['a', 'b']);
      return (
        <>
          <List ids={ids} />
          <button
            type="button"
            onClick={() => {
              setIds(['a', 'b', 'z']);
            }}
          >
            grow
          </button>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Growing />);
    item('b').focus();
    await user.keyboard('{ArrowUp}');
    await user.click(screen.getByRole('button', { name: 'grow' }));
    await waitFor(() => {
      expect(item('z')).toHaveAttribute('tabindex', '-1');
    });
    expect(tabStops()).toEqual(['a']);
  });

  it('moves the tab stop to the first item when the tab stop item leaves the list', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} preferred="b" />);
    expect(tabStops()).toEqual(['b']);
    rerender(<List ids={['a', 'c']} preferred="b" />);
    expect(tabStops()).toEqual(['a']);
  });

  it('focuses the tab stop on request', async () => {
    const user = userEvent.setup();
    render(<List ids={['a', 'b']} preferred="b" />);
    await user.click(screen.getByRole('button', { name: 'go' }));
    expect(item('b')).toHaveFocus();
  });
});
