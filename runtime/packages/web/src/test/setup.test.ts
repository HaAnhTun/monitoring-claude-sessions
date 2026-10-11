import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

// Covers the test setup itself (jest-dom matchers, per-test cleanup) and the pre-paint script public/theme-init.js,
// which no component imports (04-ui.md section 9).

describe('test setup', () => {
  it('registers the jest-dom matchers', () => {
    const element = document.createElement('p');
    document.body.append(element);
    expect(element).toBeInTheDocument();
    element.remove();
  });

  it('starts every test with an empty body (cleanup runs between tests)', () => {
    expect(document.body.children).toHaveLength(0);
  });
});

describe('theme-init.js', () => {
  const script = readFileSync(resolve(import.meta.dirname, '../../public/theme-init.js'), 'utf8');

  function run(stored: Record<string, string>, throwing = false) {
    const attributes = new Map<string, string>([
      ['data-theme', 'auto'],
      ['data-density', 'comfortable'],
    ]);
    const sandbox = {
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
        },
      },
      localStorage: {
        getItem: (key: string): string | null => {
          if (throwing) throw new Error('storage blocked');
          return stored[key] ?? null;
        },
      },
    };
    runInNewContext(script, sandbox);
    return { theme: attributes.get('data-theme'), density: attributes.get('data-density') };
  }

  it('keeps the defaults without stored preferences', () => {
    expect(run({})).toEqual({ theme: 'auto', density: 'comfortable' });
  });

  it('applies theme and density of the new key', () => {
    const stored = { 'mcs.ui.v3': JSON.stringify({ theme: 'dark', density: 'compact' }) };
    expect(run(stored)).toEqual({ theme: 'dark', density: 'compact' });
  });

  it('falls back to the legacy key', () => {
    const stored = { 'ccm.prefs.v1': JSON.stringify({ theme: 'light' }) };
    expect(run(stored)).toEqual({ theme: 'light', density: 'comfortable' });
  });

  it('prefers the new key over the legacy key', () => {
    const stored = {
      'mcs.ui.v3': JSON.stringify({ theme: 'dark' }),
      'ccm.prefs.v1': JSON.stringify({ theme: 'light' }),
    };
    expect(run(stored).theme).toBe('dark');
  });

  it('ignores invalid values, corrupt JSON and blocked storage', () => {
    expect(run({ 'mcs.ui.v3': JSON.stringify({ theme: 'neon', density: 7 }) })).toEqual({
      theme: 'auto',
      density: 'comfortable',
    });
    expect(run({ 'mcs.ui.v3': '{not json' })).toEqual({ theme: 'auto', density: 'comfortable' });
    expect(run({}, true)).toEqual({ theme: 'auto', density: 'comfortable' });
  });
});
