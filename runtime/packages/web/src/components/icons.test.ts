import { describe, expect, it } from 'vitest';

import { ICONS, ICON_NAMES } from './icons.ts';

// Semantic names of the table in 04-ui.md section 6.4. Every one must resolve to a lucide component.
const REQUIRED = [
  'running',
  'idle',
  'completed',
  'failed',
  'unknown',
  'waiting-input',
  'waiting-tool',
  'search',
  'copy',
  'refresh',
  'chevron-down',
  'chevron-right',
  'arrow-up',
  'arrow-down',
  'alert',
  'sun',
  'moon',
  'theme-auto',
  'density',
  'tool',
  'user',
  'bot',
  'x',
  'check',
  'clock',
  'help',
  'wifi',
  'wifi-off',
  'layers',
  'git-branch',
  'keyboard',
  'link',
  'cpu',
  'loader',
  'overview',
  'sessions',
  'activity',
  'tasks',
  'analytics',
  'settings',
  'pause',
  'play',
  'database',
  'file-text',
  'terminal',
  'info',
  // ADR 0071 decision 9 and WP-110: navigation, menus, panels
  'menu',
  'more',
  'filter',
  'columns',
  'languages',
  'chevron-left',
  'chevron-up',
  'external',
  'panel-left',
  'bell',
  'hard-drive',
  'git-commit',
  'folder',
  'circle',
  'circle-dot',
] as const;

describe('icon registry', () => {
  it.each(REQUIRED)('registers %s', (name) => {
    expect(ICON_NAMES).toContain(name);
    // lucide components are forwardRef objects in React 19 builds, so only require something renderable.
    expect(ICONS[name]).toBeTruthy();
  });

  it('has no unlisted extras (add the name to the design table first)', () => {
    expect([...ICON_NAMES].sort()).toEqual([...REQUIRED].sort());
  });
});
