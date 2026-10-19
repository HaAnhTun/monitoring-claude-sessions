import { LIFECYCLE_STATES } from '@mcs/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { lifecycleDisplay } from '../lib/lifecycle-display.ts';
import { makeState } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { StateBadge } from './StateBadge.tsx';

// Tone and dot of 04-ui.md section 6.1 and ADR 0071 decision 3 (one row per LifecycleState).
const EXPECTED = {
  working: { tone: 'running', dot: 'pulse' },
  running: { tone: 'running', dot: 'solid' },
  waiting_tool: { tone: 'running', dot: 'solid' },
  waiting_agent: { tone: 'running', dot: 'solid' },
  waiting_input: { tone: 'waiting', dot: 'ring' },
  turn_ended: { tone: 'idle', dot: 'solid' },
  completed: { tone: 'completed', dot: 'solid' },
  failed: { tone: 'failed', dot: 'solid' },
  stale: { tone: 'stale', dot: 'solid' },
  unknown: { tone: 'unknown', dot: 'solid' },
} as const;

function badgeOf(container: HTMLElement): HTMLElement {
  const badge = container.querySelector<HTMLElement>('.badge');
  if (badge === null) throw new Error('no badge rendered');
  return badge;
}

describe('StateBadge', () => {
  it('maps every lifecycle state, so the table above cannot drift from the shared contract', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...LIFECYCLE_STATES].sort());
  });

  it.each(LIFECYCLE_STATES)('renders a dot of the tone and the word for %s (never colour-only)', (state) => {
    const expected = EXPECTED[state];
    const { container } = renderWithIntl(<StateBadge state={state} />);
    const badge = badgeOf(container);
    expect(badge).toHaveClass('badge--state', `tone-${expected.tone}`);
    expect(badge).toHaveTextContent(msg(`state.${state}.label`));
    const dot = badge.querySelector('.state-dot');
    expect(dot).toHaveClass(`state-dot--${expected.dot}`);
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(badge).toHaveAttribute('title', msg(`state.${state}.description`));
    expect(badge).toHaveAttribute('data-state', state);
    expect(badge).not.toHaveClass('badge--inferred');
    expect(badge.querySelector('svg')).toBeNull();
  });

  it.each(LIFECYCLE_STATES)('says the word of %s in Vietnamese', (state) => {
    const { container } = renderWithIntl(<StateBadge state={state} />, { locale: 'vi' });
    expect(badgeOf(container)).toHaveTextContent(msg(`state.${state}.label`, undefined, 'vi'));
    expect(badgeOf(container)).toHaveAttribute('title', msg(`state.${state}.description`, undefined, 'vi'));
  });

  it('shows an unknown string as the unknown state', () => {
    const { container } = renderWithIntl(<StateBadge state="something_new" />);
    const badge = badgeOf(container);
    expect(badge).toHaveClass('tone-unknown');
    expect(badge).toHaveTextContent(msg('state.unknown.label'));
    expect(badge).toHaveAttribute('data-state', 'unknown');
  });

  it('uses the evidence tip as the title and keeps the visible word', () => {
    renderWithIntl(<StateBadge state="failed" evidenceTip="FIXTURE session ended with an API error" />);
    const word = screen.getByText(msg('state.failed.label'));
    expect(word.closest('.badge')).toHaveAttribute('title', 'FIXTURE session ended with an API error');
  });

  it('marks the small size', () => {
    const { container } = renderWithIntl(<StateBadge state="running" size="sm" />);
    expect(badgeOf(container)).toHaveClass('badge--sm');
  });

  describe('inferred states (ADR 0074 decision 2)', () => {
    it.each(['working', 'running'] as const)('draws %s with a question mark and a dashed ring', (state) => {
      const { container } = renderWithIntl(
        <StateBadge state={state} assessment={makeState(state, { basis: 'inferred', confidence: 'medium' })} />,
      );
      const badge = badgeOf(container);
      expect(badge).toHaveClass('badge--inferred');
      expect(badge).toHaveAttribute('data-basis', 'inferred');
      expect(badge).toHaveTextContent(msg('badge.inferredLabel', { label: msg(`state.${state}.label`) }));
      expect(badge.textContent).toMatch(/\?$/);
    });

    it.each(['working', 'running'] as const)('draws %s as plain when it is observed', (state) => {
      const { container } = renderWithIntl(<StateBadge state={state} assessment={makeState(state)} />);
      const badge = badgeOf(container);
      expect(badge).not.toHaveClass('badge--inferred');
      expect(badge).not.toHaveAttribute('data-basis');
      expect(badge.textContent).not.toContain('?');
    });

    it('draws the dashed ring but no question mark for an inferred state that is not an active turn', () => {
      for (const state of ['stale', 'unknown', 'turn_ended', 'waiting_tool'] as const) {
        const { container } = renderWithIntl(
          <StateBadge state={state} assessment={makeState(state, { basis: 'inferred' })} />,
        );
        const badge = badgeOf(container);
        expect(badge, state).toHaveClass('badge--inferred');
        expect(badge.textContent, state).toBe(msg(`state.${state}.label`));
      }
    });

    it('puts the plain-word basis, the confidence and the quiet time into the title', () => {
      const lastActivityAt = new Date(Date.now() - 18 * 60_000).toISOString();
      const { container } = renderWithIntl(
        <StateBadge
          state="working"
          assessment={makeState('working', { basis: 'inferred', confidence: 'medium' })}
          lastActivityAt={lastActivityAt}
        />,
      );
      expect(badgeOf(container)).toHaveAttribute(
        'title',
        msg('badge.inferredTipQuiet', {
          description: msg('state.working.description'),
          basis: msg('evidence.basis.inferredSilence'),
          confidence: msg('evidence.confidence.medium'),
          age: '18m',
        }),
      );
    });

    it('leaves the quiet time out of the title when the last activity is not given and `since` is null', () => {
      const { container } = renderWithIntl(
        <StateBadge state="working" assessment={makeState('working', { basis: 'inferred', since: null })} />,
      );
      expect(badgeOf(container)).toHaveAttribute(
        'title',
        msg('badge.inferredTip', {
          description: msg('state.working.description'),
          basis: msg('evidence.basis.inferredSilence'),
          confidence: msg('evidence.confidence.high'),
        }),
      );
    });

    it('is the same size of word in the Vietnamese UI and keeps the question mark', () => {
      const { container } = renderWithIntl(
        <StateBadge state="working" assessment={makeState('working', { basis: 'inferred' })} />,
        { locale: 'vi' },
      );
      expect(badgeOf(container)).toHaveTextContent(
        msg('badge.inferredLabel', { label: msg('state.working.label', undefined, 'vi') }, 'vi'),
      );
    });
  });

  it('has no private table: it takes its tone and words from lifecycleDisplay', () => {
    const source = readFileSync(join(import.meta.dirname, 'StateBadge.tsx'), 'utf8');
    expect(source).toContain("from '../lib/lifecycle-display.ts'");
    expect(source).not.toMatch(/Record<LifecycleState/);
    for (const state of LIFECYCLE_STATES) {
      const display = lifecycleDisplay(state);
      const { container } = renderWithIntl(<StateBadge state={state} />);
      expect(badgeOf(container)).toHaveClass(display.toneClass);
      expect(badgeOf(container)).toHaveTextContent(msg(display.labelKey));
    }
  });
});
