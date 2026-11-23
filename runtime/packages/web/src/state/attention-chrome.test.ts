import { describe, expect, it } from 'vitest';

import {
  applyFavicon,
  chromeOf,
  createAttentionChromeStore,
  FAVICON_ATTENTION,
  FAVICON_PLAIN,
  NO_ATTENTION_CHROME,
} from './attention-chrome.ts';

const ON = { title: true, favicon: true };

describe('the attention chrome', () => {
  it.each([
    ['nothing settled', [0, 0, 0], ON, null, false],
    ['needs you wins', [2, 1, 3], ON, { kind: 'needs_you', count: 2 }, true],
    ['then failed', [0, 1, 3], ON, { kind: 'failed', count: 1 }, true],
    ['done has a title and no dot', [0, 0, 3], ON, { kind: 'done', count: 3 }, false],
    ['the title preference is off', [2, 0, 0], { title: false, favicon: true }, null, true],
    ['the icon preference is off', [2, 0, 0], { title: true, favicon: false }, { kind: 'needs_you', count: 2 }, false],
  ] as const)('chromeOf: %s', (_title, [needsYou, failed, done], prefs, title, icon) => {
    expect(chromeOf({ needsYou, failed, done }, prefs)).toEqual({ title, icon });
  });

  it('the store keeps its snapshot until the chrome really changes', () => {
    const store = createAttentionChromeStore();
    let changes = 0;
    const stop = store.subscribe(() => {
      changes += 1;
    });
    expect(store.getSnapshot()).toBe(NO_ATTENTION_CHROME);
    store.set({ title: null, icon: false });
    expect(changes).toBe(0);
    store.set({ title: { kind: 'failed', count: 1 }, icon: true });
    const first = store.getSnapshot();
    store.set({ title: { kind: 'failed', count: 1 }, icon: true });
    expect(store.getSnapshot()).toBe(first);
    expect(changes).toBe(1);
    stop();
    store.set(NO_ATTENTION_CHROME);
    expect(changes).toBe(1);
  });

  it('applyFavicon swaps the icon link between the two files and leaves a page without the link alone', () => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    link.setAttribute('href', FAVICON_PLAIN);
    document.head.append(link);
    applyFavicon(document, true);
    expect(link.getAttribute('href')).toBe(FAVICON_ATTENTION);
    applyFavicon(document, false);
    expect(link.getAttribute('href')).toBe(FAVICON_PLAIN);
    link.remove();
    expect(() => {
      applyFavicon(document, true);
    }).not.toThrow();
  });
});
