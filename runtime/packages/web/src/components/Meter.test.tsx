import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { Meter } from './Meter.tsx';

describe('Meter', () => {
  it('is a labelled meter with the ARIA values of 0 to 100 and a text value', () => {
    renderWithIntl(<Meter label="FIXTURE memory" pct={42} valueText="6.7 of 16 GB" />);
    const meter = screen.getByRole('meter', { name: 'FIXTURE memory' });
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).toHaveAttribute('aria-valuetext', '6.7 of 16 GB');
    expect(screen.getByText('6.7 of 16 GB')).toBeInTheDocument();
  });

  it('draws the fill as wide as the value', () => {
    const { container } = renderWithIntl(<Meter label="FIXTURE cpu" pct={30} valueText="30%" />);
    const fill = container.querySelector<HTMLElement>('.meter__fill');
    expect(fill?.style.inlineSize).toBe('30%');
  });

  it('clamps a value outside 0 to 100 and keeps a fraction', () => {
    const { rerender } = renderWithIntl(<Meter label="FIXTURE a" pct={140} valueText="x" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    rerender(<Meter label="FIXTURE a" pct={-5} valueText="x" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    rerender(<Meter label="FIXTURE a" pct={12.5} valueText="x" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '12.5');
  });

  it('shows the High badge only above the threshold', () => {
    const { rerender } = renderWithIntl(<Meter label="FIXTURE a" pct={90} valueText="90%" highAbove={85} />);
    expect(screen.getByText(msg('panels.meter.high'))).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('data-high', 'true');
    rerender(<Meter label="FIXTURE a" pct={85} valueText="85%" highAbove={85} />);
    expect(screen.queryByText(msg('panels.meter.high'))).not.toBeInTheDocument();
    expect(screen.getByRole('meter')).not.toHaveAttribute('data-high');
  });

  it('has no High badge without a threshold', () => {
    renderWithIntl(<Meter label="FIXTURE a" pct={99} valueText="99%" />);
    expect(screen.queryByText(msg('panels.meter.high'))).not.toBeInTheDocument();
  });

  it('says High in Vietnamese', () => {
    renderWithIntl(<Meter label="FIXTURE a" pct={99} valueText="99%" highAbove={80} />, { locale: 'vi' });
    expect(screen.getByText(msg('panels.meter.high', undefined, 'vi'))).toBeInTheDocument();
  });
});
