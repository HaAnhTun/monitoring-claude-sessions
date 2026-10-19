import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { Skeleton } from './Skeleton.tsx';

describe('Skeleton', () => {
  it('marks the container busy and gives screen readers one status text', () => {
    const { container } = renderWithIntl(<Skeleton rows={3} variant="table" label={msg('common.loadingPage')} />);
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(msg('common.loadingPage'));
    expect(status).toHaveClass('sr-only');
  });

  it.each(['table', 'list', 'tiles', 'text', 'header'] as const)(
    'renders the requested number of rows for %s',
    (variant) => {
      const { container } = renderWithIntl(<Skeleton rows={4} variant={variant} label="Loading" />);
      expect(container.firstElementChild).toHaveClass(`skeleton--${variant}`);
      expect(container.querySelectorAll('.skeleton__row')).toHaveLength(4);
    },
  );

  it('shapes a table row like the table: one cell per column, 5 by default', () => {
    const { container, rerender } = renderWithIntl(<Skeleton rows={3} variant="table" label="Loading" />);
    const rows = container.querySelectorAll('.skeleton__row');
    for (const row of rows) expect(row.querySelectorAll('.skeleton__cell')).toHaveLength(5);
    rerender(<Skeleton rows={3} variant="table" columns={7} label="Loading" />);
    for (const row of container.querySelectorAll('.skeleton__row')) {
      expect(row.querySelectorAll('.skeleton__cell')).toHaveLength(7);
    }
  });

  it('draws a header bar over the rows of a table, with as many cells as columns', () => {
    const { container } = renderWithIntl(<Skeleton rows={2} variant="table" columns={4} label="Loading" />);
    expect(container.querySelectorAll('.skeleton__head .skeleton__cell')).toHaveLength(4);
  });

  it('gives a header skeleton a title bar above its meta rows', () => {
    const { container } = renderWithIntl(<Skeleton rows={2} variant="header" label="Loading" />);
    expect(container.querySelectorAll('.skeleton__title')).toHaveLength(1);
    expect(container.querySelectorAll('.skeleton__row')).toHaveLength(2);
  });

  it('keeps a table to at least one column and ignores columns for the other variants', () => {
    const { container } = renderWithIntl(<Skeleton rows={1} variant="table" columns={0} label="Loading" />);
    expect(container.querySelectorAll('.skeleton__row .skeleton__cell')).toHaveLength(1);
    const list = renderWithIntl(<Skeleton rows={2} variant="list" columns={9} label="Loading" />);
    expect(list.container.querySelectorAll('.skeleton__cell')).toHaveLength(0);
  });

  it('hides the placeholder rows from assistive technology', () => {
    const { container } = renderWithIntl(<Skeleton rows={2} variant="list" label="Loading" />);
    for (const row of container.querySelectorAll('.skeleton__row')) {
      expect(row).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('renders no rows for zero', () => {
    const { container } = renderWithIntl(<Skeleton rows={0} variant="text" label="Loading" />);
    expect(container.querySelectorAll('.skeleton__row')).toHaveLength(0);
  });
});
