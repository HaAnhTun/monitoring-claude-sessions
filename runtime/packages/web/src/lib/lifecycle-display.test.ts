// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARD_STATES, LEGACY_STATES, LIFECYCLE_STATES } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';

import {
  SIDEBAR_GROUPS,
  TONES,
  boardDisplay,
  legacyStateOf,
  lifecycleDisplay,
  sidebarGroupOf,
} from './lifecycle-display.ts';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');
const badgesCss = readFileSync(join(stylesDir, 'badges.css'), 'utf8');
const tokensCss = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');

// The English aliases stay until WP-124 removes them; the test reads them through a structural type.
const deprecatedLabel = (d: { label: string }): string => d.label;
const deprecatedTitle = (g: { title: string }): string => g.title;

describe('lifecycle display', () => {
  it('maps every lifecycle state to one tone, label key, icon, dot, sidebar group and legacy state (table of 04 6.1)', () => {
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
      expect(deprecatedLabel(d), state).toBe(label);
      expect(d.labelKey, state).toBe(`state.${state}.label`);
      expect(d.descriptionKey, state).toBe(`state.${state}.description`);
      expect(enMessages[d.labelKey], state).toBe(label);
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
      expect(deprecatedLabel(d)).toBe('Unknown');
      expect(d.labelKey).toBe('state.unknown.label');
      expect(d.group).toBe('stale');
      expect(d.legacy).toBe('UNKNOWN');
    }
    expect(lifecycleDisplay(null).toneClass).toBe('tone-unknown');
    expect(lifecycleDisplay(undefined).toneClass).toBe('tone-unknown');
  });

  it('maps every board state to a tone, label key and icon', () => {
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
      expect([d.toneClass, deprecatedLabel(d)], state).toEqual(expected[state]);
      expect(d.icon.length).toBeGreaterThan(0);
      expect(enMessages[d.labelKey], state).toBe(expected[state]?.[1]);
    }
    expect(boardDisplay('nonsense').toneClass).toBe('tone-unknown');
  });

  it('gives every state a label and a one-sentence description in both catalogues', () => {
    for (const state of LIFECYCLE_STATES) {
      const d = lifecycleDisplay(state);
      for (const [name, catalogue] of [
        ['en', enMessages],
        ['vi', viMessages],
      ] as const) {
        const label = catalogue[d.labelKey];
        const description = catalogue[d.descriptionKey];
        expect(label.length, `${name} label of ${state}`).toBeGreaterThan(0);
        expect(description.length, `${name} description of ${state}`).toBeGreaterThan(label.length);
        expect(description.trim().endsWith('.'), `${name} description of ${state} is a sentence`).toBe(true);
        expect(description.match(/[.!?]\s/g) ?? [], `${name} description of ${state} is one sentence`).toEqual([]);
      }
    }
  });

  it('draws the dot per state: Working pulses, waiting for input is a ring, the rest are plain', () => {
    expect(lifecycleDisplay('working').dot).toBe('pulse');
    expect(lifecycleDisplay('waiting_input').dot).toBe('ring');
    for (const state of LIFECYCLE_STATES) {
      if (state !== 'working' && state !== 'waiting_input') expect(lifecycleDisplay(state).dot, state).toBe('solid');
    }
  });

  it('keeps Turn ended as a name (it is not renamed "Waiting for you")', () => {
    expect(enMessages['state.turn_ended.label']).toBe('Turn ended');
    for (const state of LIFECYCLE_STATES)
      expect(enMessages[lifecycleDisplay(state).labelKey], state).not.toMatch(/Waiting for you/i);
  });

  it('legacy states used by the table are the shared LEGACY_STATES', () => {
    for (const state of LIFECYCLE_STATES) expect(LEGACY_STATES).toContain(lifecycleDisplay(state).legacy);
  });

  it('sidebar groups are ordered Active, Needs input, Turn ended, Done, Stale or unknown, and the idle group has the badge name', () => {
    expect(SIDEBAR_GROUPS.map((g) => [g.id, deprecatedTitle(g)])).toEqual([
      ['active', 'Active'],
      ['needs-input', 'Needs input'],
      ['idle', 'Turn ended'],
      ['done', 'Done'],
      ['stale', 'Stale or unknown'],
    ]);
    for (const g of SIDEBAR_GROUPS) {
      expect(enMessages[g.titleKey], g.id).toBe(deprecatedTitle(g));
      expect(viMessages[g.titleKey].length, g.id).toBeGreaterThan(0);
    }
    const idle = SIDEBAR_GROUPS.find((g) => g.id === 'idle');
    expect(idle?.titleKey).toBe(lifecycleDisplay('turn_ended').labelKey);
    for (const state of LIFECYCLE_STATES) {
      expect(SIDEBAR_GROUPS.map((g) => g.id)).toContain(lifecycleDisplay(state).group);
    }
  });

  it('every tone has a CSS class in badges.css and none is left in tokens.css (the files are read, not assumed)', () => {
    expect(TONES.length).toBeGreaterThanOrEqual(7);
    for (const tone of TONES) {
      const selector = new RegExp(`\\.tone-${tone}(?![A-Za-z0-9_-])`);
      expect(badgesCss, `tone-${tone}`).toMatch(selector);
      expect(tokensCss, `tone-${tone} moved`).not.toMatch(selector);
    }
    for (const state of LIFECYCLE_STATES) {
      const cls = lifecycleDisplay(state).toneClass;
      expect(badgesCss, cls).toContain(`.${cls}`);
    }
  });
});
