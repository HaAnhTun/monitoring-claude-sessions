import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Disclosure } from './Disclosure.tsx';

describe('Disclosure', () => {
  it('is closed by default and the panel is hidden', () => {
    render(
      <Disclosure id="d1" label="Details">
        <p>inside</p>
      </Disclosure>,
    );
    const button = screen.getByRole('button', { name: 'Details' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'd1');
    expect(document.getElementById('d1')).toHaveAttribute('hidden');
  });

  it('opens and closes on click', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure id="d2" label="Details" defaultOpen>
        <p>inside</p>
      </Disclosure>,
    );
    const button = screen.getByRole('button', { name: 'Details' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('inside')).toBeVisible();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('d2')).toHaveAttribute('hidden');
  });

  it('can be controlled', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <Disclosure id="d3" label="Details" open={false} onToggle={onToggle}>
        <p>inside</p>
      </Disclosure>,
    );
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <Disclosure id="d3" label="Details" open onToggle={onToggle}>
        <p>inside</p>
      </Disclosure>,
    );
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
  });
});
