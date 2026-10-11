import { LIFECYCLE_STATES } from '@mcs/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StateBadge } from './StateBadge.tsx';

// Tone mapping of 04-ui.md section 6.1 (one row per LifecycleState).
const EXPECTED = {
  working: { tone: 'running', label: 'Working' },
  running: { tone: 'running', label: 'Running' },
  waiting_tool: { tone: 'running', label: 'Waiting for tool' },
  waiting_agent: { tone: 'running', label: 'Waiting for subagent' },
  waiting_input: { tone: 'waiting', label: 'Waiting for input' },
  turn_ended: { tone: 'idle', label: 'Turn ended' },
  completed: { tone: 'completed', label: 'Completed' },
  failed: { tone: 'failed', label: 'Failed' },
  stale: { tone: 'stale', label: 'Stale' },
  unknown: { tone: 'unknown', label: 'Unknown' },
} as const;

describe('StateBadge', () => {
  it('maps every lifecycle state, so the table above cannot drift from the shared contract', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...LIFECYCLE_STATES].sort());
  });

  it.each(LIFECYCLE_STATES)('renders an icon and a word for %s (never colour-only)', (state) => {
    const expected = EXPECTED[state];
    const { container } = render(<StateBadge state={state} />);
    const badge = container.querySelector('.badge');
    expect(badge).not.toBeNull();
    expect(badge).toHaveClass(`tone-${expected.tone}`);
    expect(badge).toHaveTextContent(expected.label);
    expect(badge?.querySelector('svg.icon')).not.toBeNull();
    expect(badge?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(badge).toHaveAttribute('title', expected.label);
    expect(badge).toHaveAttribute('data-state', state);
  });

  it('shows an unknown string as the unknown state', () => {
    const { container } = render(<StateBadge state="something_new" />);
    const badge = container.querySelector('.badge');
    expect(badge).toHaveClass('tone-unknown');
    expect(badge).toHaveTextContent('Unknown');
    expect(badge?.querySelector('svg.icon')).not.toBeNull();
  });

  it('uses the evidence tip as the title and keeps the visible word', () => {
    render(<StateBadge state="failed" evidenceTip="Session ended with an API error" />);
    const word = screen.getByText('Failed');
    expect(word.closest('.badge')).toHaveAttribute('title', 'Session ended with an API error');
  });

  it('marks the small size', () => {
    const { container } = render(<StateBadge state="running" size="sm" />);
    expect(container.querySelector('.badge')).toHaveClass('badge--sm');
  });
});
