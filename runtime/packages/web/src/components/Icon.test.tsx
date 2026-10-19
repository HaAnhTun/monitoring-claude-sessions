import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Icon } from './Icon.tsx';

describe('Icon', () => {
  it('renders a decorative svg with the icon class', () => {
    const { container } = render(<Icon name="running" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass('icon');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
  });

  it('is 16 px with a 1.5 stroke (ADR 0071 decision 9)', () => {
    const { container } = render(<Icon name="search" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  it('is 18 px in a menu', () => {
    const { container } = render(<Icon name="settings" size="menu" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '18');
    expect(svg).toHaveAttribute('height', '18');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  it('adds an extra class without dropping the base one', () => {
    const { container } = render(<Icon name="check" className="spin" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('icon');
    expect(svg).toHaveClass('spin');
  });
});
