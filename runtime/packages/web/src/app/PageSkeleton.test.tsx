import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { PageSkeleton } from './PageSkeleton.tsx';

describe('PageSkeleton', () => {
  it('is a busy table-shaped placeholder with one status text in the language of the page', () => {
    const { container } = renderWithIntl(<PageSkeleton />);
    expect(screen.getByRole('status')).toHaveTextContent(msg('common.loadingPage'));
    expect(container.querySelector('.skeleton--table')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.skeleton__row').length).toBeGreaterThan(0);
  });

  it('reads in Vietnamese', () => {
    renderWithIntl(<PageSkeleton />, { locale: 'vi' });
    expect(screen.getByRole('status')).toHaveTextContent(msg('common.loadingPage', undefined, 'vi'));
  });
});
