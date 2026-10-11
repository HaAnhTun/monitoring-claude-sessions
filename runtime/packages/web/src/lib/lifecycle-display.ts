// The one table that maps lifecycle states to their display (04 section 6.1): tone class, icon, label, sidebar group and
// the legacy five-state value. Status is never colour alone: every entry has an icon and a word.
import type { LegacyState, LifecycleState } from '@mcs/shared';

import type { IconName } from '../components/icons.ts';

export const TONES = ['running', 'waiting', 'idle', 'completed', 'failed', 'stale', 'unknown'] as const;
export type Tone = (typeof TONES)[number];
export type ToneClass = `tone-${Tone}`;

export type SidebarGroupId = 'active' | 'needs-input' | 'idle' | 'done' | 'stale';

export interface SidebarGroup {
  id: SidebarGroupId;
  title: string;
}

/** Sidebar group order of 04 6.1 (Active, Needs input, Idle, Done, Stale or unknown). */
export const SIDEBAR_GROUPS: readonly SidebarGroup[] = [
  { id: 'active', title: 'Active' },
  { id: 'needs-input', title: 'Needs input' },
  { id: 'idle', title: 'Idle' },
  { id: 'done', title: 'Done' },
  { id: 'stale', title: 'Stale or unknown' },
];

export interface StateDisplay {
  /** The state itself; any string that is not a lifecycle state is shown as 'unknown'. */
  state: LifecycleState;
  tone: Tone;
  toneClass: ToneClass;
  icon: IconName;
  label: string;
  group: SidebarGroupId;
  legacy: LegacyState;
}

interface Row {
  tone: Tone;
  icon: IconName;
  label: string;
  group: SidebarGroupId;
  legacy: LegacyState;
}

// The table of 04 6.1. Icon names are the semantic names of components/icons.ts (04 6.4).
const LIFECYCLE: Readonly<Record<LifecycleState, Row>> = {
  working: { tone: 'running', icon: 'running', label: 'Working', group: 'active', legacy: 'RUNNING' },
  running: { tone: 'running', icon: 'running', label: 'Running', group: 'active', legacy: 'RUNNING' },
  waiting_tool: {
    tone: 'running',
    icon: 'waiting-tool',
    label: 'Waiting for tool',
    group: 'active',
    legacy: 'RUNNING',
  },
  waiting_agent: { tone: 'running', icon: 'bot', label: 'Waiting for subagent', group: 'active', legacy: 'RUNNING' },
  waiting_input: {
    tone: 'waiting',
    icon: 'waiting-input',
    label: 'Waiting for input',
    group: 'needs-input',
    legacy: 'IDLE',
  },
  turn_ended: { tone: 'idle', icon: 'idle', label: 'Turn ended', group: 'idle', legacy: 'IDLE' },
  completed: { tone: 'completed', icon: 'completed', label: 'Completed', group: 'done', legacy: 'COMPLETED' },
  failed: { tone: 'failed', icon: 'failed', label: 'Failed', group: 'done', legacy: 'FAILED' },
  stale: { tone: 'stale', icon: 'clock', label: 'Stale', group: 'stale', legacy: 'UNKNOWN' },
  unknown: { tone: 'unknown', icon: 'unknown', label: 'Unknown', group: 'stale', legacy: 'UNKNOWN' },
};

function isLifecycleState(s: string): s is LifecycleState {
  return Object.hasOwn(LIFECYCLE, s);
}

const toneClassOf = (tone: Tone): ToneClass => `tone-${tone}`;

/** Display of a lifecycle state; null, undefined and unknown strings give the 'unknown' display and never throw. */
export function lifecycleDisplay(state: string | null | undefined): StateDisplay {
  const key: LifecycleState = state !== null && state !== undefined && isLifecycleState(state) ? state : 'unknown';
  const row = LIFECYCLE[key];
  return { state: key, ...row, toneClass: toneClassOf(row.tone) };
}

export function legacyStateOf(state: string | null | undefined): LegacyState {
  return lifecycleDisplay(state).legacy;
}

export function sidebarGroupOf(state: string | null | undefined): SidebarGroupId {
  return lifecycleDisplay(state).group;
}

export interface BoardDisplay {
  tone: Tone;
  toneClass: ToneClass;
  icon: IconName;
  label: string;
}

// Work item (task board) states: working is the running tone, waiting its own tone (04 6.1 "Task states").
const BOARD: Readonly<Record<string, Omit<BoardDisplay, 'toneClass'>>> = {
  working: { tone: 'running', icon: 'running', label: 'Working' },
  waiting: { tone: 'waiting', icon: 'waiting-input', label: 'Waiting' },
  completed: { tone: 'completed', icon: 'completed', label: 'Completed' },
  failed: { tone: 'failed', icon: 'failed', label: 'Failed' },
  stale: { tone: 'stale', icon: 'clock', label: 'Stale' },
  unknown: { tone: 'unknown', icon: 'unknown', label: 'Unknown' },
};

const BOARD_UNKNOWN: Omit<BoardDisplay, 'toneClass'> = { tone: 'unknown', icon: 'unknown', label: 'Unknown' };

export function boardDisplay(state: string | null | undefined): BoardDisplay {
  const row =
    state !== null && state !== undefined && Object.hasOwn(BOARD, state)
      ? (BOARD[state] ?? BOARD_UNKNOWN)
      : BOARD_UNKNOWN;
  return { ...row, toneClass: toneClassOf(row.tone) };
}
