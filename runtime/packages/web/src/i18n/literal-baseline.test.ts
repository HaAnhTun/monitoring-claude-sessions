// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LITERAL_BASELINE } from './literal-baseline.ts';

// The shape of the ratchet file. That each entry still has a violation, and that no violation is missing, is checked by
// `no-literal-text.test.ts`; this file checks that the blocks are intact so that parallel work packages can edit their own.

const BLOCKS = [
  'WP-65',
  'WP-112',
  'WP-113',
  'WP-114',
  'WP-115',
  'WP-116',
  'WP-117',
  'WP-118',
  'WP-119',
  'WP-120',
  'WP-124',
] as const;

/** The work package that converts a file (the table of the plan); a file that is not named goes to WP-124. */
const OWNERS: Readonly<Record<string, string>> = {
  'app/NotFoundPage.tsx': 'WP-112',
  'app/PageSkeleton.tsx': 'WP-112',
  'app/RouteErrorBoundary.tsx': 'WP-112',
  'components/ErrorState.tsx': 'WP-112',
  'components/ClampedText.tsx': 'WP-112',
  'components/LoadMore.tsx': 'WP-112',
  'components/Skeleton.tsx': 'WP-112',
  'lib/lifecycle-display.ts': 'WP-113',
  'components/StateBadge.tsx': 'WP-113',
  'components/TagBadge.tsx': 'WP-113',
  'app/routes.tsx': 'WP-114',
  'shell/AppShell.tsx': 'WP-114',
  'shell/Sidebar.tsx': 'WP-114',
  'shell/SidebarNav.tsx': 'WP-114',
  'shell/SidebarSessionList.tsx': 'WP-114',
  'shell/SkipLinks.tsx': 'WP-114',
  'shell/InstanceChangedNotice.tsx': 'WP-114',
  'lib/sessions-view.ts': 'WP-114',
  'shell/TopBar.tsx': 'WP-115',
  'shell/ConnectionChip.tsx': 'WP-115',
  'shell/IngestionChip.tsx': 'WP-115',
  'shell/HealthDetails.tsx': 'WP-115',
  'shell/PrefsControls.tsx': 'WP-115',
  'shell/ShortcutsDialog.tsx': 'WP-115',
  'lib/shortcuts.ts': 'WP-115',
  'lib/connection-health.ts': 'WP-115',
  'stream/freshness.ts': 'WP-115',
  'components/StaleDataIndicator.tsx': 'WP-115',
  'components/FilterBar.tsx': 'WP-116',
  'pages/session-detail/SessionDetailPage.tsx': 'WP-118',
  'pages/session-detail/SessionHeader.tsx': 'WP-118',
  'pages/session-detail/SessionTabs.tsx': 'WP-118',
  'pages/session-detail/AuditRefs.tsx': 'WP-118',
  'pages/session-detail/SessionErrors.tsx': 'WP-119',
  'pages/session-detail/SessionTokens.tsx': 'WP-119',
  'pages/session-detail/SessionTimeline.tsx': 'WP-119',
  'pages/session-detail/AgentTree.tsx': 'WP-119',
  'pages/session-detail/TimelineRow.tsx': 'WP-119',
  'components/Markdown.tsx': 'WP-120',
  'data/hooks/usePanel.ts': 'WP-65',
};

function ownerOf(path: string): string {
  if (Object.hasOwn(OWNERS, path)) return OWNERS[path] ?? 'WP-124';
  if (path.startsWith('pages/sessions/')) return 'WP-117';
  if (path.startsWith('transcript/')) return 'WP-120';
  return 'WP-124';
}

const source = readFileSync(resolve(import.meta.dirname, 'literal-baseline.ts'), 'utf8');

/** The entries between the markers of each block, read from the file text. */
function blocks(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const wp of BLOCKS) {
    const begin = source.indexOf(`// @wp-begin ${wp}`);
    const end = source.indexOf(`// @wp-end ${wp}`);
    if (begin === -1 || end < begin) throw new Error(`block ${wp} is missing or broken`);
    const lines = source
      .slice(begin, end)
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    found.set(
      wp,
      lines.map((line) => {
        const match = /^'([^']+)',$/.exec(line);
        if (match === null) throw new Error(`${wp}: not an entry: ${line}`);
        return match[1] ?? '';
      }),
    );
  }
  return found;
}

describe('literal-baseline.ts', () => {
  it('has one pair of markers per work package, in ascending order', () => {
    const markers = [...source.matchAll(/\/\/ @wp-(begin|end) (WP-\d+)/g)].map((m) => `${m[1] ?? ''} ${m[2] ?? ''}`);
    expect(markers).toEqual(BLOCKS.flatMap((wp) => [`begin ${wp}`, `end ${wp}`]));
  });

  it('has entries only between the markers: one quoted path per line', () => {
    expect(() => blocks()).not.toThrow();
    const outside = source.replace(/\/\/ @wp-begin[\s\S]*?\/\/ @wp-end WP-\d+\n/g, '');
    expect(outside.match(/^\s*'.*',$/gm)).toBeNull();
  });

  it('exports every entry of every block and nothing else', () => {
    const all = [...blocks().values()].flat();
    expect([...LITERAL_BASELINE].sort()).toEqual([...all].sort());
  });

  it('lists no file twice', () => {
    expect(new Set(LITERAL_BASELINE).size).toBe(LITERAL_BASELINE.length);
  });

  it('keeps every file in the block of the work package that converts it', () => {
    const misplaced: string[] = [];
    for (const [wp, entries] of blocks()) {
      for (const path of entries)
        if (ownerOf(path) !== wp) misplaced.push(`${path} is in ${wp}, owner ${ownerOf(path)}`);
    }
    expect(misplaced).toEqual([]);
  });

  it('keeps the entries of a block sorted, so that two edits do not conflict', () => {
    for (const [wp, entries] of blocks()) expect(entries, wp).toEqual([...entries].sort());
  });

  it('has no test file, no test helper and no catalogue among the entries', () => {
    for (const path of LITERAL_BASELINE) {
      expect(path).not.toMatch(/\.test\.tsx?$/);
      expect(path.startsWith('test/')).toBe(false);
      expect(path.startsWith('i18n/')).toBe(false);
    }
  });
});
