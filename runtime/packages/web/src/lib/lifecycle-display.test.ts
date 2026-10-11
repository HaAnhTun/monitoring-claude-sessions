// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARD_STATES, LEGACY_STATES, LIFECYCLE_STATES } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_GROUPS,
  TONES,
  boardDisplay,
  legacyStateOf,
  lifecycleDisplay,
  sidebarGroupOf,
} from './lifecycle-display.ts';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');
const tokensCss = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');

describe('lifecycle display', () => {
  it('maps every lifecycle state to one tone, label, icon, sidebar group and legacy state (table of 04 6.1)', () => {
    const table: Record<string, [string, string, string, string, string]> = {
      working: ['tone-running', 'Working', 'active', 'RUNNING', 'running'],
      running: ['tone-running', 'Running', 'active', 'RUNNING', 'running'],
      waiting_tool: ['tone-running', 'Waiting for tool', 'active', 'RUNNING', 'waiting-tool'],
      waiting_agent: ['tone-running', 'Waiting for subagent', 'active', 'RUNNING', 'bot'],
      waiting_input: ['tone-waiting', 'Waiting for input', 'needs-input', 'IDLE', 'waiting-input'],
      turn_ended: ['tone-idle', 'Turn ended', 'idle', 'IDLE', 'idle'],
      completed: ['tone-completed', 'Completed', 'done', 'COMPLETED', 'completed'],
      failed: ['tone-failed', 'Failed', 'done', 'FAILED', 'failed'],
      stale: ['tone-stale', 'Stale', 'stale', 'UNKNOWN', 'clock'],
      unknown: ['tone-unknown', 'Unknown', 'stale', 'UNKNOWN', 'unknown'],
    };
    expect(Object.keys(table).sort()).toEqual([...LIFECYCLE_STATES].sort());
    for (const state of LIFECYCLE_STATES) {
      const d = lifecycleDisplay(state);
      const [toneClass, label, group, legacy, icon] = table[state] ?? [];
      expect(d.state, state).toBe(state);
      expect(d.toneClass, state).toBe(toneClass);
      expect(d.label, state).toBe(label);
      expect(d.group, state).toBe(group);
      expect(d.legacy, state).toBe(legacy);
      expect(d.icon, state).toBe(icon);
      expect(legacyStateOf(state)).toBe(legacy);
      expect(sidebarGroupOf(state)).toBe(group);
    }
  });

  it('an unknown string is shown as unknown and never throws', () => {
    for (const odd of ['', 'WORKING', 'bogus', '__proto__', 'constructor', 'toString']) {
      const d = lifecycleDisplay(odd);
      expect(d.state).toBe('unknown');
      expect(d.toneClass).toBe('tone-unknown');
      expect(d.label).toBe('Unknown');
      expect(d.group).toBe('stale');
      expect(d.legacy).toBe('UNKNOWN');
    }
    expect(lifecycleDisplay(null).toneClass).toBe('tone-unknown');
    expect(lifecycleDisplay(undefined).toneClass).toBe('tone-unknown');
  });

  it('maps every board state to a tone, label and icon', () => {
    const expected: Record<string, [string, string]> = {
      working: ['tone-running', 'Working'],
      waiting: ['tone-waiting', 'Waiting'],
      completed: ['tone-completed', 'Completed'],
      failed: ['tone-failed', 'Failed'],
      stale: ['tone-stale', 'Stale'],
      unknown: ['tone-unknown', 'Unknown'],
    };
    expect(Object.keys(expected).sort()).toEqual([...BOARD_STATES].sort());
    for (const state of BOARD_STATES) {
      const d = boardDisplay(state);
      expect([d.toneClass, d.label], state).toEqual(expected[state]);
      expect(d.icon.length).toBeGreaterThan(0);
    }
    expect(boardDisplay('nonsense').toneClass).toBe('tone-unknown');
  });

  it('legacy states used by the table are the shared LEGACY_STATES', () => {
    for (const state of LIFECYCLE_STATES) expect(LEGACY_STATES).toContain(lifecycleDisplay(state).legacy);
  });

  it('sidebar groups are ordered Active, Needs input, Idle, Done, Stale or unknown', () => {
    expect(SIDEBAR_GROUPS.map((g) => [g.id, g.title])).toEqual([
      ['active', 'Active'],
      ['needs-input', 'Needs input'],
      ['idle', 'Idle'],
      ['done', 'Done'],
      ['stale', 'Stale or unknown'],
    ]);
    for (const state of LIFECYCLE_STATES) {
      expect(SIDEBAR_GROUPS.map((g) => g.id)).toContain(lifecycleDisplay(state).group);
    }
  });

  it('every tone has a CSS class in tokens.css (the file is read, not assumed)', () => {
    expect(TONES.length).toBeGreaterThanOrEqual(7);
    for (const tone of TONES) {
      const selector = new RegExp(`\\.tone-${tone}(?![A-Za-z0-9_-])`);
      expect(tokensCss, `tone-${tone}`).toMatch(selector);
    }
    for (const state of LIFECYCLE_STATES) {
      const cls = lifecycleDisplay(state).toneClass;
      expect(tokensCss, cls).toContain(`.${cls}`);
    }
  });
});
