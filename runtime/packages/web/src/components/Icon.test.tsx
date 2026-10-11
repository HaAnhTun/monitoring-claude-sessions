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

  it('is sized in em so it follows the text size', () => {
    const { container } = render(<Icon name="search" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '1.1em');
    expect(svg).toHaveAttribute('height', '1.1em');
  });

  it('adds an extra class without dropping the base one', () => {
    const { container } = render(<Icon name="check" className="spin" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('icon');
    expect(svg).toHaveClass('spin');
  });
});
