// The one table that maps lifecycle states to their display (04 section 6.1, ADR 0074 decision 4): tone class, icon, dot, catalogue
// keys for the label and the one-sentence description, sidebar group and the legacy five-state value. Status is never colour alone:
// every entry has a word. The words themselves live in the catalogue (`state.*`); `label` and `title` are deprecated English
// aliases computed from it for the consumers that are not converted yet (WP-124 removes them).
import type { LegacyState, LifecycleState } from '@mcs/shared';

import type { IconName } from '../components/icons.ts';
import { enMessages } from '../i18n/messages/en.ts';

export const TONES = ['running', 'waiting', 'idle', 'completed', 'failed', 'stale', 'unknown'] as const;
export type Tone = (typeof TONES)[number];
export type ToneClass = `tone-${Tone}`;

/** How the dot of a badge is drawn: a slowly pulsing disc (Working), a plain disc, or a ring (waiting for the user). */
export type StateDot = 'pulse' | 'solid' | 'ring';

export type StateLabelKey = `state.${LifecycleState}.label`;
export type StateDescriptionKey = `state.${LifecycleState}.description`;

export type SidebarGroupId = 'active' | 'needs-input' | 'idle' | 'done' | 'stale';

export type SidebarGroupTitleKey =
  'state.group.active' | 'state.group.needsInput' | 'state.turn_ended.label' | 'state.group.done' | 'state.group.stale';

export interface SidebarGroup {
  id: SidebarGroupId;
  titleKey: SidebarGroupTitleKey;
  /** @deprecated English text computed from the catalogue; use `titleKey` with `useT()`. */
  title: string;
}

const group = (id: SidebarGroupId, titleKey: SidebarGroupTitleKey): SidebarGroup => ({
  id,
  titleKey,
  title: enMessages[titleKey],
});

/** Sidebar group order of 04 6.1 (Active, Needs input, Turn ended, Done, Stale or unknown); a group has the name of its badge. */
export const SIDEBAR_GROUPS: readonly SidebarGroup[] = [
  group('active', 'state.group.active'),
  group('needs-input', 'state.group.needsInput'),
  group('idle', 'state.turn_ended.label'),
  group('done', 'state.group.done'),
  group('stale', 'state.group.stale'),
];

export interface StateDisplay {
  /** The state itself; any string that is not a lifecycle state is shown as 'unknown'. */
  state: LifecycleState;
  tone: Tone;
  toneClass: ToneClass;
  icon: IconName;
  dot: StateDot;
  labelKey: StateLabelKey;
  descriptionKey: StateDescriptionKey;
  /** @deprecated English text computed from the catalogue; use `labelKey` with `useT()`. */
  label: string;
  group: SidebarGroupId;
  legacy: LegacyState;
}

interface Row {
  tone: Tone;
  icon: IconName;
  dot: StateDot;
  group: SidebarGroupId;
  legacy: LegacyState;
}

// The table of 04 6.1. Icon names are the semantic names of components/icons.ts (04 6.4).
const LIFECYCLE: Readonly<Record<LifecycleState, Row>> = {
  working: { tone: 'running', icon: 'running', dot: 'pulse', group: 'active', legacy: 'RUNNING' },
  running: { tone: 'running', icon: 'running', dot: 'solid', group: 'active', legacy: 'RUNNING' },
  waiting_tool: { tone: 'running', icon: 'waiting-tool', dot: 'solid', group: 'active', legacy: 'RUNNING' },
  waiting_agent: { tone: 'running', icon: 'bot', dot: 'solid', group: 'active', legacy: 'RUNNING' },
  waiting_input: { tone: 'waiting', icon: 'waiting-input', dot: 'ring', group: 'needs-input', legacy: 'IDLE' },
  turn_ended: { tone: 'idle', icon: 'idle', dot: 'solid', group: 'idle', legacy: 'IDLE' },
  completed: { tone: 'completed', icon: 'completed', dot: 'solid', group: 'done', legacy: 'COMPLETED' },
  failed: { tone: 'failed', icon: 'failed', dot: 'solid', group: 'done', legacy: 'FAILED' },
  stale: { tone: 'stale', icon: 'clock', dot: 'solid', group: 'stale', legacy: 'UNKNOWN' },
  unknown: { tone: 'unknown', icon: 'unknown', dot: 'solid', group: 'stale', legacy: 'UNKNOWN' },
};

function isLifecycleState(s: string): s is LifecycleState {
  return Object.hasOwn(LIFECYCLE, s);
}

const toneClassOf = (tone: Tone): ToneClass => `tone-${tone}`;

/** Display of a lifecycle state; null, undefined and unknown strings give the 'unknown' display and never throw. */
export function lifecycleDisplay(state: string | null | undefined): StateDisplay {
  const key: LifecycleState = state !== null && state !== undefined && isLifecycleState(state) ? state : 'unknown';
  const row = LIFECYCLE[key];
  const labelKey: StateLabelKey = `state.${key}.label`;
  return {
    state: key,
    ...row,
    toneClass: toneClassOf(row.tone),
    labelKey,
    descriptionKey: `state.${key}.description`,
    label: enMessages[labelKey],
  };
}

export function legacyStateOf(state: string | null | undefined): LegacyState {
  return lifecycleDisplay(state).legacy;
}

export function sidebarGroupOf(state: string | null | undefined): SidebarGroupId {
  return lifecycleDisplay(state).group;
}

export type BoardLabelKey = StateLabelKey | 'state.board.waiting';

export interface BoardDisplay {
  tone: Tone;
  toneClass: ToneClass;
  icon: IconName;
  labelKey: BoardLabelKey;
  /** @deprecated English text computed from the catalogue; use `labelKey` with `useT()`. */
  label: string;
}

// Work item (task board) states: working is the running tone, waiting its own tone (04 6.1 "Task states"). The words are the ones
// of the lifecycle states, plus "Waiting".
const BOARD: Readonly<Record<string, Omit<BoardDisplay, 'toneClass' | 'label'>>> = {
  working: { tone: 'running', icon: 'running', labelKey: 'state.working.label' },
  waiting: { tone: 'waiting', icon: 'waiting-input', labelKey: 'state.board.waiting' },
  completed: { tone: 'completed', icon: 'completed', labelKey: 'state.completed.label' },
  failed: { tone: 'failed', icon: 'failed', labelKey: 'state.failed.label' },
  stale: { tone: 'stale', icon: 'clock', labelKey: 'state.stale.label' },
  unknown: { tone: 'unknown', icon: 'unknown', labelKey: 'state.unknown.label' },
};

const BOARD_UNKNOWN: Omit<BoardDisplay, 'toneClass' | 'label'> = {
  tone: 'unknown',
  icon: 'unknown',
  labelKey: 'state.unknown.label',
};

export function boardDisplay(state: string | null | undefined): BoardDisplay {
  const row =
    state !== null && state !== undefined && Object.hasOwn(BOARD, state)
      ? (BOARD[state] ?? BOARD_UNKNOWN)
      : BOARD_UNKNOWN;
  return { ...row, toneClass: toneClassOf(row.tone), label: enMessages[row.labelKey] };
}
