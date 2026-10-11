import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button.tsx';

describe('Button', () => {
  it('defaults to type button so it never submits a form', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('calls onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies the variant class', () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('btn', 'btn-primary');
  });

  it('renders an icon before the label', () => {
    render(<Button icon="refresh">Retry</Button>);
    const button = screen.getByRole('button', { name: 'Retry' });
    expect(button.querySelector('svg.icon')).not.toBeNull();
  });

  it('disables itself and says it is busy while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Go
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveClass('is-loading');
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('takes its accessible name from aria-label for an icon-only button', () => {
    render(<Button variant="icon" icon="copy" aria-label="Copy tool input" />);
    expect(screen.getByRole('button', { name: 'Copy tool input' })).toHaveClass('btn-icon');
  });
});
