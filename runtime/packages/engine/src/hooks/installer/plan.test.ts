// T-IN-01 to T-IN-04 (02 3.9): the merge matrix, idempotency, the clean uninstall and the ownership rule of the pure plan.
import { McsError } from '@mcs/shared';
import { ASYNC_HOOK_EVENTS, INSTALLED_HOOK_EVENTS } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_NODE,
  FIXTURE_SCRIPT,
  LAYOUTS,
  MATRIX_EVENTS,
  PLAN_CASES,
  USER_HANDLER,
  ourGroup,
  ourHandler,
  pretty,
  type Expect,
  type PlanCase,
} from '../../../test/fixtures/settings/cases.ts';
import {
  buildEntry,
  desiredEntries,
  hooksFailed,
  isOurs,
  planHooks,
  unifiedDiff,
  type HookCommandEntry,
} from './plan.ts';

const CTX = { nodePath: FIXTURE_NODE, hookEntryPath: FIXTURE_SCRIPT } as const;
const DESIRED: ReadonlyMap<string, HookCommandEntry> = new Map(MATRIX_EVENTS.map((e) => [e, buildEntry(e, CTX)]));
const NONE: ReadonlyMap<string, HookCommandEntry> = new Map();

function refusalOf(run: () => unknown): McsError {
  try {
    run();
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the plan to be refused');
}

/** The text an install must give: the object in the layout of the input (base layout unless a variant says otherwise). */
function expectedText(input: string | null, obj: unknown): string {
  const finalNewline = input === null || input.trim() === '' || input.endsWith('\n');
  return JSON.stringify(obj, null, 2) + (finalNewline ? '\n' : '');
}

function isExpect(value: PlanCase['install']): value is Expect {
  return 'obj' in value;
}

describe('buildEntry and desiredEntries (02 3.3)', () => {
  it('writes the hand-made entries of the fixtures', () => {
    for (const event of MATRIX_EVENTS) expect(buildEntry(event, CTX)).toEqual(ourHandler(event));
  });

  it('runs the stable script of the context through the Node executable, in exec form with the marker', () => {
    expect(buildEntry('Stop', CTX)).toEqual({
      type: 'command',
      command: 'C:/FIXTURE/node.exe',
      args: ['--no-warnings', 'C:/FIXTURE/mcs-home/hooks/mcs-hook.mjs', '--mcs-hook', 'Stop'],
      timeout: 5,
    });
  });

  it('gives the four tool events async mode and --async, unless --sync-tool-events asks for sync', () => {
    for (const event of ASYNC_HOOK_EVENTS) {
      const entry = buildEntry(event, CTX);
      expect(entry.async).toBe(true);
      expect(entry.args.at(-1)).toBe('--async');
      const sync = buildEntry(event, { ...CTX, syncToolEvents: true });
      expect(sync.async).toBeUndefined();
      expect(sync.args).not.toContain('--async');
    }
  });

  it('gives SessionEnd a 2 second timeout and every other event 5', () => {
    expect(buildEntry('SessionEnd', CTX).timeout).toBe(2);
    expect(buildEntry('UserPromptSubmit', CTX).timeout).toBe(5);
  });

  it('turns backslashes into slashes in both paths', () => {
    const entry = buildEntry('Stop', {
      nodePath: String.raw`C:\FIXTURE\node.exe`,
      hookEntryPath: String.raw`C:\FIXTURE\h\mcs-hook.mjs`,
    });
    expect(entry.command).toBe('C:/FIXTURE/node.exe');
    expect(entry.args[1]).toBe('C:/FIXTURE/h/mcs-hook.mjs');
  });

  it('desiredEntries holds the 21 installed events in installation order, each one ours', () => {
    const entries = desiredEntries(CTX);
    expect([...entries.keys()]).toEqual([...INSTALLED_HOOK_EVENTS]);
    expect(entries.size).toBe(21);
    for (const [event, entry] of entries) {
      expect(isOurs(entry)).toBe(true);
      expect(entry.args).toContain(event);
    }
  });
});

describe('T-IN-04 ownership: only the marker argument makes a handler ours', () => {
  it('recognises the exec form and the shell form', () => {
    expect(isOurs(ourHandler('Stop'))).toBe(true);
    expect(isOurs({ type: 'command', command: 'node x.mjs --mcs-hook Stop' })).toBe(true);
    expect(isOurs({ type: 'command', command: '--mcs-hook' })).toBe(true);
    expect(isOurs({ type: 'command', command: 'node', args: ['--mcs-hook'] })).toBe(true);
  });

  it('does not take a user script named hook.js, nor a name that merely contains the marker', () => {
    expect(isOurs({ type: 'command', command: 'node', args: ['C:/FIXTURE/user/hook.js', 'Stop'] })).toBe(false);
    expect(isOurs({ type: 'command', command: 'node C:/FIXTURE/user/hook.js' })).toBe(false);
    expect(isOurs({ type: 'command', command: 'node', args: ['x--mcs-hook'] })).toBe(false);
    expect(isOurs({ type: 'command', command: 'node', args: ['--mcs-hook-other'] })).toBe(false);
    expect(isOurs({ type: 'command', command: 'node x --mcs-hooks' })).toBe(false);
  });

  it('only a command handler can be ours', () => {
    expect(isOurs({ type: 'http', url: 'http://127.0.0.1', args: ['--mcs-hook'] })).toBe(false);
    expect(isOurs({ command: 'node --mcs-hook' })).toBe(false);
  });

  it('is false for anything that is not a plain object', () => {
    for (const value of [
      null,
      undefined,
      'node --mcs-hook',
      5,
      true,
      [],
      [{ type: 'command', args: ['--mcs-hook'] }],
    ]) {
      expect(isOurs(value)).toBe(false);
    }
    expect(isOurs({ type: 'command', args: 'not an array' })).toBe(false);
  });

  it('an uninstall removes only handlers with the marker and leaves a user script named hook.js', () => {
    const hookJs = { type: 'command', command: 'node', args: ['C:/FIXTURE/user/hook.js'] };
    const input = pretty({ hooks: { Stop: [{ hooks: [hookJs, ourHandler('Stop')] }] } });
    const plan = planHooks(input, 'uninstall', NONE);
    expect(plan.removed).toEqual(['Stop']);
    expect(plan.obj).toEqual({ hooks: { Stop: [{ hooks: [hookJs] }] } });
  });
});

describe('T-IN-01 merge matrix: the text and the lists of an install', () => {
  for (const c of PLAN_CASES) {
    it(c.id, () => {
      if (!isExpect(c.install)) {
        const error = refusalOf(() => planHooks(c.input, 'install', DESIRED));
        expect(error.code).toBe('HOOKS_FAILED');
        expect(error.details).toMatchObject({ reason: c.install.refusal });
        return;
      }
      const plan = planHooks(c.input, 'install', DESIRED);
      expect(plan.changed).toBe(c.install.changed);
      expect(plan.created).toBe(c.input === null);
      expect(plan.added).toEqual(c.install.added);
      expect(plan.replaced).toEqual(c.install.replaced);
      expect(plan.removed).toEqual(c.install.removed);
      expect(plan.kept).toEqual(c.install.kept);
      if (c.install.changed) {
        expect(plan.obj).toEqual(c.install.obj);
        expect(plan.text).toBe(expectedText(c.input, c.install.obj));
        expect(Object.keys(plan.obj['hooks'] as object)).toEqual(Object.keys(c.install.obj['hooks'] as object));
        expect(plan.diff).toContain('@@');
      } else {
        expect(plan.text).toBe(c.input ?? '');
        expect(plan.diff).toBe('');
      }
    });
  }

  it('writes exactly this text for a fresh install (the anchor of the format)', () => {
    const plan = planHooks(null, 'install', new Map([['SessionStart', buildEntry('SessionStart', CTX)]]));
    expect(plan.text).toBe(
      [
        '{',
        '  "hooks": {',
        '    "SessionStart": [',
        '      {',
        '        "hooks": [',
        '          {',
        '            "type": "command",',
        '            "command": "C:/FIXTURE/node.exe",',
        '            "args": [',
        '              "--no-warnings",',
        '              "C:/FIXTURE/mcs-home/hooks/mcs-hook.mjs",',
        '              "--mcs-hook",',
        '              "SessionStart"',
        '            ],',
        '            "timeout": 5',
        '          }',
        '        ]',
        '      }',
        '    ]',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('refuses a file that holds a secret without quoting any of it', () => {
    for (const input of ['{ "token": "FIXTURE-SECRET-VALUE", "a": }', '{ "token": "FIXTURE-SECRET-VALUE" "a": 1 }']) {
      const error = refusalOf(() => planHooks(input, 'install', DESIRED));
      expect(error.message).not.toContain('FIXTURE-SECRET');
      expect(error.message).toMatch(/not valid JSON/);
    }
  });

  it('names the line and column of an error when the parser gives a position', () => {
    const error = refusalOf(() => planHooks('{\n  "a": 1\n  "b": 2\n}', 'install', DESIRED));
    expect(error.message).toContain('near line 3, column 3');
  });

  it('names the event of a refused entry and the key of a refused hooks value', () => {
    const event = refusalOf(() => planHooks('{"hooks":{"Stop":{}}}', 'uninstall', NONE));
    expect(event.details).toMatchObject({ reason: 'SETTINGS_EVENT_NOT_ARRAY', event: 'Stop' });
    expect(event.message).toContain('hooks.Stop');
  });

  it('applies the same refusals to an uninstall', () => {
    const error = refusalOf(() => planHooks('{"hooks": []}', 'uninstall', NONE));
    expect(error.details).toMatchObject({ reason: 'SETTINGS_HOOKS_NOT_OBJECT' });
  });

  it('keeps hooksFailed errors as HOOKS_FAILED with the reason in the details', () => {
    const error = hooksFailed('LOCKED', 'busy', { hint: 'wait', details: { settingsPath: 'x' } });
    expect(error.code).toBe('HOOKS_FAILED');
    expect(error.hint).toBe('wait');
    expect(error.details).toEqual({ reason: 'LOCKED', settingsPath: 'x' });
  });
});

describe('T-IN-01 layouts: the line ending, the byte order mark, the indentation and the final newline are kept', () => {
  const isCanonical = (input: string | null): boolean => {
    try {
      return input !== null && input === pretty(JSON.parse(input));
    } catch {
      return false;
    }
  };
  const sources = PLAN_CASES.filter(
    (c) => isCanonical(c.input) && c.input?.includes('\n  ') === true && isExpect(c.install) && c.install.changed,
  );

  it('has canonical base files to transform', () => {
    expect(sources.length).toBeGreaterThanOrEqual(4);
  });

  for (const layout of LAYOUTS) {
    for (const c of sources.slice(0, 4)) {
      it(`${layout.id}: ${c.id}`, () => {
        const install = c.install as Expect;
        const input = layout.apply(c.input ?? '');
        const plan = planHooks(input, 'install', DESIRED);
        expect(plan.text).toBe(layout.apply(pretty(install.obj)));
        expect(plan.obj).toEqual(install.obj);
        // and the way back gives the layout of the input again (the removal of our old entries changes the content)
        const back = planHooks(plan.text, 'uninstall', NONE);
        const expectedBack: unknown = c.pristine
          ? JSON.parse(c.input ?? '{}')
          : planHooks(c.input, 'uninstall', NONE).obj;
        expect(back.text).toBe(layout.apply(pretty(expectedBack)));
      });
    }
  }

  it('keeps text that is not ASCII as it is, and writes it as text rather than as escapes', () => {
    const wide = `FIXTURE ${String.fromCodePoint(0x1f642)} ${String.fromCodePoint(0xe9)}`;
    const input = pretty({ note: wide, hooks: { Stop: [{ hooks: [USER_HANDLER(wide)] }] } });
    const installed = planHooks(input, 'install', DESIRED);
    expect(installed.text).toContain(wide);
    expect(planHooks(installed.text, 'uninstall', NONE).text).toBe(input);
  });

  it('writes a compact one-line file in the default two-space layout', () => {
    const plan = planHooks('{"theme":"dark"}', 'install', new Map([['SessionEnd', buildEntry('SessionEnd', CTX)]]));
    expect(plan.text.startsWith('{\n  "theme": "dark",\n  "hooks": {')).toBe(true);
    expect(plan.text.endsWith('}')).toBe(true);
  });

  it('does not touch the formatting of a file when there is nothing to change', () => {
    const odd = '\uFEFF{\r\n\t"theme":   "dark",\r\n\t"env": {}}\r\n';
    const plan = planHooks(odd, 'uninstall', NONE);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(odd);
    const again = planHooks(odd, 'install', NONE);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(odd);
  });

  it('an uninstall of a missing, empty or blank file changes nothing', () => {
    for (const input of [null, '', ' \n']) {
      const plan = planHooks(input, 'uninstall', NONE);
      expect(plan.changed).toBe(false);
      expect(plan.text).toBe(input ?? '');
    }
  });
});

describe('T-IN-02 idempotent: a second install plans no change', () => {
  for (const c of PLAN_CASES.filter((x) => isExpect(x.install))) {
    it(c.id, () => {
      const first = planHooks(c.input, 'install', DESIRED);
      const second = planHooks(first.text, 'install', DESIRED);
      expect(second.changed).toBe(false);
      expect(second.text).toBe(first.text);
      expect(second.added).toEqual([]);
      expect(second.replaced).toEqual([]);
      expect([...second.kept].sort()).toEqual([...MATRIX_EVENTS].sort());
    });
  }

  it('with all 21 events as well', () => {
    const wanted = desiredEntries(CTX);
    const first = planHooks('{"theme":"dark"}\n', 'install', wanted);
    expect(first.added).toHaveLength(21);
    const second = planHooks(first.text, 'install', wanted);
    expect(second.changed).toBe(false);
    expect(second.kept).toHaveLength(21);
  });
});

describe('T-IN-03 clean uninstall: uninstall(install(x)) is x', () => {
  for (const c of PLAN_CASES.filter((x) => x.pristine && isExpect(x.install))) {
    it(c.id, () => {
      const installed = planHooks(c.input, 'install', DESIRED);
      const back = planHooks(installed.text, 'uninstall', NONE);
      const original = c.input === null || c.input.trim() === '' ? {} : (JSON.parse(c.input) as unknown);
      expect(back.obj).toEqual(original);
      expect(back.removed.sort()).toEqual([...MATRIX_EVENTS].sort());
      if (c.input !== null && c.input.trim() !== '' && c.input === pretty(original)) expect(back.text).toBe(c.input);
      if (c.input === '{}') expect(back.text).toBe('{}');
    });
  }

  it('removes the entries of old versions and leaves the handlers of the user in their groups', () => {
    const c = PLAN_CASES.find((x) => x.id === 'our old entries with other paths');
    const plan = planHooks(c?.input ?? null, 'uninstall', NONE);
    expect(plan.obj).toEqual({ hooks: { Stop: [{ matcher: 'x', hooks: [USER_HANDLER('stop')] }] } });
    expect(plan.removed).toEqual(['SessionStart', 'PreToolUse', 'Stop', 'Notification']);
  });

  it('drops the hooks key that the removal emptied, and keeps one that was empty before', () => {
    const emptied = planHooks(pretty({ a: 1, hooks: { Stop: [ourGroup('Stop')] } }), 'uninstall', NONE);
    expect(emptied.obj).toEqual({ a: 1 });
    const empty = planHooks(pretty({ a: 1, hooks: {} }), 'uninstall', NONE);
    expect(empty.changed).toBe(false);
    expect(empty.obj).toEqual({ a: 1, hooks: {} });
  });

  it('keeps an event array the user left empty, and a group the user left without handlers', () => {
    const input = pretty({ hooks: { Stop: [], Notification: [{ hooks: [] }], SessionEnd: [ourGroup('SessionEnd')] } });
    const plan = planHooks(input, 'uninstall', NONE);
    expect(plan.obj).toEqual({ hooks: { Stop: [], Notification: [{ hooks: [] }] } });
  });
});

describe('the diff of the hooks key', () => {
  it('shows only the hooks key, as added lines for a fresh install', () => {
    const plan = planHooks(
      pretty({ theme: 'dark' }),
      'install',
      new Map([['SessionEnd', buildEntry('SessionEnd', CTX)]]),
    );
    const lines = plan.diff.split('\n');
    expect(lines.slice(0, 3)).toEqual(['--- hooks (current)', '+++ hooks (planned)', '@@ -0,0 +1,19 @@']);
    expect(lines.slice(3).every((l) => l.startsWith('+'))).toBe(true);
    expect(plan.diff).not.toContain('theme');
    expect(lines[3]).toBe('+  "hooks": {');
    expect(plan.diff).toContain('+    "SessionEnd": [');
  });

  it('shows a replaced path as one removed and one added line, with context', () => {
    const plan = planHooks(
      pretty({ hooks: { SessionEnd: [ourGroup('SessionEnd', 'C:/FIXTURE/old/mcs-hook.mjs')] } }),
      'install',
      new Map([['SessionEnd', buildEntry('SessionEnd', CTX)]]),
    );
    expect(plan.replaced).toEqual(['SessionEnd']);
    expect(plan.diff).toContain('-              "C:/FIXTURE/old/mcs-hook.mjs",');
    expect(plan.diff).toContain('+              "C:/FIXTURE/mcs-home/hooks/mcs-hook.mjs",');
  });

  it('is empty when nothing changes', () => {
    expect(planHooks('{}', 'uninstall', NONE).diff).toBe('');
  });

  it('plans a file with two thousand groups of the user without trouble', () => {
    const groups = Array.from({ length: 2000 }, (_, i) => ({ hooks: [USER_HANDLER(`n${String(i)}`)] }));
    const plan = planHooks(pretty({ hooks: { Stop: groups } }), 'install', desiredEntries(CTX));
    expect(plan.added).toHaveLength(21);
    expect(plan.replaced).toEqual([]);
    expect((plan.obj['hooks'] as { Stop: unknown[] }).Stop).toHaveLength(2001);
    expect(plan.diff.split('\n').length).toBeLessThan(2000);
  });
});

describe('unifiedDiff', () => {
  const lines = (text: string): string[] => text.split('');

  it('is empty for equal lists', () => {
    expect(unifiedDiff(lines('abc'), lines('abc'), 3)).toBe('');
    expect(unifiedDiff([], [], 3)).toBe('');
  });

  it('writes one hunk with the context on both sides', () => {
    expect(unifiedDiff(lines('abcdefgh'), lines('abcdXfgh'), 2)).toBe(
      ['--- hooks (current)', '+++ hooks (planned)', '@@ -3,5 +3,5 @@', ' c', ' d', '-e', '+X', ' f', ' g'].join('\n'),
    );
  });

  it('splits distant changes into two hunks and merges close ones', () => {
    const a = lines('abcdefghijklmnop');
    const far = unifiedDiff(a, lines('Xbcdefghijklmnoq'), 1);
    expect(far.match(/^@@/gm)).toHaveLength(2);
    const near = unifiedDiff(a, lines('aXcdXfghijklmnop'), 1);
    expect(near.match(/^@@/gm)).toHaveLength(1);
    expect(near).toContain('@@ -1,6 +1,6 @@');
  });

  it('counts a pure addition and a pure removal', () => {
    expect(unifiedDiff([], lines('xy'), 3)).toContain('@@ -0,0 +1,2 @@');
    expect(unifiedDiff(lines('xy'), [], 3)).toContain('@@ -1,2 +0,0 @@');
  });

  it('keeps the matching lines in the middle of a change (longest common subsequence)', () => {
    const diff = unifiedDiff(lines('aXbYc'), lines('aPbQc'), 0).split('\n').slice(2);
    expect(diff).toEqual(['@@ -2,1 +2,1 @@', '-X', '+P', '@@ -4,1 +4,1 @@', '-Y', '+Q']);
  });

  it('shows two big unrelated blocks as removed and added as a whole, without a table', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${String(i)}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${String(i)}`);
    const diff = unifiedDiff(a, b, 3).split('\n');
    expect(diff[2]).toBe('@@ -1,3000 +1,3000 @@');
    expect(diff.filter((l) => l.startsWith('-a'))).toHaveLength(3000);
    expect(diff.filter((l) => l.startsWith('+b'))).toHaveLength(3000);
  });
});
