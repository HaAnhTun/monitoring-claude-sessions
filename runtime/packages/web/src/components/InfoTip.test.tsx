import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { InfoTip } from './InfoTip.tsx';

function setup() {
  const user = userEvent.setup();
  renderWithIntl(
    <div>
      <button type="button">Before</button>
      <InfoTip label={msg('metric.info', { label: 'Output' })}>
        <p>FIXTURE tip text</p>
        <a href="/elsewhere">FIXTURE link in the tip</a>
      </InfoTip>
      <button type="button">After</button>
    </div>,
  );
  return { user, trigger: screen.getByRole('button', { name: msg('metric.info', { label: 'Output' }) }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

/** A window of 1000 px in which a panel on the start side runs past the right edge and a panel on the end side fits. */
function measurePanels(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const panel = this.getAttribute('role') === 'dialog';
    const flipped = this.classList.contains('popover__panel--end');
    const left = panel ? (flipped ? 500 : 900) : 0;
    const width = panel ? 300 : 0;
    return new DOMRect(left, 0, width, 0);
  });
}

describe('InfoTip', () => {
  it('is a button that starts closed and says what it explains', () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('FIXTURE tip text')).toBeNull();
  });

  it('opens with the keyboard (Tab to it, then Enter), not only with the pointer', async () => {
    const { user, trigger } = setup();
    await user.tab();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: msg('metric.info', { label: 'Output' }) })).toBeInTheDocument();
    expect(screen.getByText('FIXTURE tip text')).toBeVisible();
  });

  it('opens with Space too', async () => {
    const { user, trigger } = setup();
    trigger.focus();
    await user.keyboard(' ');
    expect(screen.getByText('FIXTURE tip text')).toBeInTheDocument();
  });

  it('lets the next Tab into the panel, then closes on Escape and gives the focus back', async () => {
    const { user, trigger } = setup();
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.tab();
    expect(screen.getByRole('link', { name: 'FIXTURE link in the tip' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('FIXTURE tip text')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes when the focus moves on past the panel', async () => {
    const { user, trigger } = setup();
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(screen.queryByText('FIXTURE tip text')).toBeNull();
  });

  it('opens towards the other side when the panel would leave the window', async () => {
    measurePanels();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    const { user, trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole('dialog').className).toContain('popover__panel--end');
  });

  it('keeps the first side when the panel fits', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole('dialog').className).not.toContain('popover__panel--end');
  });
});
