import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
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

  it('maps the variants to the three levels with unchanged class names', () => {
    render(
      <>
        <Button>Secondary</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="icon" icon="copy" aria-label="Copy" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Secondary' }).className).toBe('btn');
    expect(screen.getByRole('button', { name: 'Primary' }).className).toBe('btn btn-primary');
    expect(screen.getByRole('button', { name: 'Quiet' }).className).toBe('btn btn-quiet');
    expect(screen.getByRole('button', { name: 'Copy' }).className).toBe('btn btn-icon');
  });

  it('hands its element to a ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Go</Button>);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Go' }));
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
