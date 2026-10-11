import type { LifecycleState } from '@mcs/shared';

import type { IconName } from './icons.ts';
import { TagBadge, type Tone } from './TagBadge.tsx';

export interface StateBadgeProps {
  /** A LifecycleState of the API; any other string is shown as unknown. */
  state: string;
  evidenceTip?: string;
  size?: 'sm' | 'md';
}

interface StateDisplay {
  tone: Tone;
  icon: IconName;
  label: string;
}

// Tone mapping of 04-ui.md section 6.1. WP-45 owns the shared table in lib/lifecycle-display.ts; until it lands this
// private copy is the only one (change request CR-WP-44-2 asks to switch to it).
const DISPLAY: Record<LifecycleState, StateDisplay> = {
  working: { tone: 'running', icon: 'running', label: 'Working' },
  running: { tone: 'running', icon: 'running', label: 'Running' },
  waiting_tool: { tone: 'running', icon: 'waiting-tool', label: 'Waiting for tool' },
  waiting_agent: { tone: 'running', icon: 'bot', label: 'Waiting for subagent' },
  waiting_input: { tone: 'waiting', icon: 'waiting-input', label: 'Waiting for input' },
  turn_ended: { tone: 'idle', icon: 'idle', label: 'Turn ended' },
  completed: { tone: 'completed', icon: 'completed', label: 'Completed' },
  failed: { tone: 'failed', icon: 'failed', label: 'Failed' },
  stale: { tone: 'stale', icon: 'clock', label: 'Stale' },
  unknown: { tone: 'unknown', icon: 'unknown', label: 'Unknown' },
};

function isLifecycleState(state: string): state is LifecycleState {
  return Object.hasOwn(DISPLAY, state);
}

function displayFor(state: string): { key: LifecycleState; display: StateDisplay } {
  const key: LifecycleState = isLifecycleState(state) ? state : 'unknown';
  return { key, display: DISPLAY[key] };
}

export function StateBadge({ state, evidenceTip, size = 'md' }: StateBadgeProps) {
  const { key, display } = displayFor(state);
  return (
    <TagBadge
      tone={display.tone}
      icon={display.icon}
      tip={evidenceTip ?? display.label}
      state={key}
      extraClass={size === 'sm' ? 'badge--sm' : undefined}
    >
      {display.label}
    </TagBadge>
  );
}
