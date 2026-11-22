// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { enMessages } from './en.ts';

/** The work packages that own a block of the catalogue, in the order of the shared-file register of the plan. */
const BLOCKS = [
  'WP-53',
  'WP-54',
  'WP-65',
  'WP-66',
  'WP-67',
  'WP-112',
  'WP-113',
  'WP-114',
  'WP-115',
  'WP-116',
  'WP-117',
  'WP-118',
  'WP-119',
  'WP-120',
  'WP-121',
  'WP-124',
  'WP-136',
] as const;

const bytes = readFileSync(resolve(import.meta.dirname, 'en.ts'));
const source = bytes.toString('utf8');

describe('messages/en.ts', () => {
  it('is a flat object of non-empty strings', () => {
    for (const [key, value] of Object.entries(enMessages)) {
      expect(typeof value, key).toBe('string');
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it('has the seed entries', () => {
    expect(enMessages['common.close']).toBe('Close');
    expect(enMessages['lang.en']).toBe('English');
    expect(enMessages['common.notAvailable']).toBe('Not available');
  });

  it('is plain ASCII text with at most the usual typographic marks, never a Vietnamese letter', () => {
    // middle dot, en dash, em dash, ellipsis, multiplication sign
    const allowed = new Set([0xb7, 0x2013, 0x2014, 0x2026, 0xd7]);
    const odd: string[] = [];
    for (const char of source) {
      if (char.charCodeAt(0) > 126 && !allowed.has(char.codePointAt(0) ?? 0)) odd.push(char);
    }
    expect(odd).toEqual([]);
  });

  it('starts without a byte order mark and is valid UTF-8', () => {
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
  });

  it('has one empty pair of markers per work package, in the order of the register', () => {
    const markers = [...source.matchAll(/\/\/ @wp-(begin|end) (WP-\d+)/g)].map((m) => `${m[1] ?? ''} ${m[2] ?? ''}`);
    expect(markers).toEqual(BLOCKS.flatMap((wp) => [`begin ${wp}`, `end ${wp}`]));
  });

  it('has only entries between the markers of a work package', () => {
    for (const wp of BLOCKS) {
      const begin = source.indexOf(`// @wp-begin ${wp}`);
      const end = source.indexOf(`// @wp-end ${wp}`);
      expect(begin, wp).toBeGreaterThan(-1);
      expect(end, wp).toBeGreaterThan(begin);
      const inside = source
        .slice(begin, end)
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '');
      // An entry is `'key': 'text',`; Prettier moves a text that does not fit in 120 columns to a line of its own after `'key':`.
      for (const line of inside) {
        expect(line, `${wp}: ${line}`).toMatch(
          /^\s*('[^']+':\s*('[^']*'|"[^"]*"|`[^`]*`|$)|('[^']*'|"[^"]*"|`[^`]*`),)/,
        );
      }
    }
  });
});

describe('the sidebar row of the shortcuts dialog (design 05 section 6)', () => {
  it('names the pages and the session list: the arrow keys, Home and End move through both', () => {
    expect(enMessages['shortcuts.fixed.sidebar']).toBe('Move through the pages and the session list in the sidebar');
  });
});

/** The keys written between the markers of one work package. */
function keysOfBlock(text: string, wp: string): string[] {
  const begin = text.indexOf(`// @wp-begin ${wp}`);
  const end = text.indexOf(`// @wp-end ${wp}`);
  return [...text.slice(begin, end).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] ?? '');
}

describe('the Workspace block (WP-136, design 04 section 9)', () => {
  const keys = keysOfBlock(source, 'WP-136');

  it('holds every key of the section, about 115 plus the locked read of a reader route', () => {
    expect(keys.length).toBeGreaterThanOrEqual(115);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [
      'route.workspace.title',
      'shell.skip.terminal',
      'shell.skip.projects',
      'shell.outdated.body',
      'shell.outdated.terminals',
      'shell.outdated.copy',
      'shell.userMenu.lock',
      'shortcuts.group.terminal',
      'workspace.sidebar.label',
      'workspace.folder.live',
      'workspace.recent.resume',
      'workspace.pane.notFound.title',
      'terminal.region',
      'terminal.status.reconnecting',
      'terminal.ended.exitCode',
      'terminal.unavailable.os.title',
      'terminal.unavailable.addon.title',
      'terminal.unavailable.claude.title',
      'access.locked.title',
      'access.error.cookie',
      'workspace.dialog.resume.fork',
      'workspace.resume.reason.live_elsewhere',
      'error.handling.accessRequired',
      'error.handling.accessLocked',
      'error.handling.folderLimit',
      'detail.resume.action',
      'settings.prefs.screenReader',
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it('puts no key of the block outside its markers and names the product in no key', () => {
    const outside = source.replace(/\/\/ @wp-begin WP-136[\s\S]*?\/\/ @wp-end WP-136/, '');
    for (const key of keys) {
      expect(outside.includes(`'${key}':`), key).toBe(false);
      expect(key, key).not.toMatch(/caw|mcs|workspace-?app|agentworkspace/i);
    }
  });

  it('keeps the plural forms free of nested braces and the product name out of the text', () => {
    for (const key of keys) {
      const text = enMessages[key as keyof typeof enMessages];
      expect(text, key).not.toMatch(/\{[^{}]*\{[^{}]*\{/);
      expect(text, key).not.toMatch(/claude agent workspace|\bcaw\b/i);
    }
  });
});
