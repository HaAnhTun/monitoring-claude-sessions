import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ClampedText, MAX_EXPANDED_CHARS, clipText } from './ClampedText.tsx';

const plain = (text: string) => <pre data-testid="body">{text}</pre>;

describe('clipText', () => {
  it('returns the text unchanged when it fits', () => {
    expect(clipText('abc', 5)).toBe('abc');
  });

  it('never splits a surrogate pair', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const text = ['ab', emoji, 'cd'].join('');
    expect(clipText(text, 3)).toBe('ab');
    expect(clipText(text, 4)).toBe(['ab', emoji].join(''));
  });
});

describe('ClampedText', () => {
  it('renders short text without a button', () => {
    render(<ClampedText id="t1" text="short" render={plain} />);
    expect(screen.getByTestId('body')).toHaveTextContent('short');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clamps at 1,500 characters and toggles with aria-expanded and aria-controls', async () => {
    const user = userEvent.setup();
    render(<ClampedText id="t2" text={'a'.repeat(1600)} render={plain} />);
    expect(screen.getByTestId('body').textContent).toHaveLength(1500);
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-controls', 't2-body');
    expect(document.getElementById('t2-body')).not.toBeNull();
    await user.click(more);
    expect(screen.getByTestId('body').textContent).toHaveLength(1600);
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    await user.click(less);
    expect(screen.getByTestId('body').textContent).toHaveLength(1500);
  });

  it('honours a custom clamp', () => {
    render(<ClampedText id="t3" text={'b'.repeat(30)} clampChars={10} render={plain} />);
    expect(screen.getByTestId('body').textContent).toHaveLength(10);
  });

  it('is controlled when expanded is given and reports toggles with its id', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <ClampedText id="t4" text={'c'.repeat(2000)} expanded={false} onToggle={onToggle} render={plain} />,
    );
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(onToggle).toHaveBeenCalledWith('t4', true);
    // the parent has not changed the state, so the text stays clamped
    expect(screen.getByTestId('body').textContent).toHaveLength(1500);
    rerender(<ClampedText id="t4" text={'c'.repeat(2000)} expanded onToggle={onToggle} render={plain} />);
    expect(screen.getByTestId('body').textContent).toHaveLength(2000);
  });

  it('shows at most 200,000 characters when expanded and says how long the text is', () => {
    const total = MAX_EXPANDED_CHARS + 5000;
    render(<ClampedText id="t5" text={'d'.repeat(total)} expanded render={plain} />);
    expect(screen.getByTestId('body').textContent).toHaveLength(MAX_EXPANDED_CHARS);
    expect(screen.getByText(`Text too long to show here (${String(total)} characters). Use Copy.`)).toBeInTheDocument();
  });
});
