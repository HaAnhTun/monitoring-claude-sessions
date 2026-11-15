// `formatCommand` and the six `InstanceInfo.commands` strings (01 6.6): a value is quoted when it contains a space (and
// when pasting it unquoted would run or expand something), the export file is `<workspace>/logs/export.ndjson` and never
// `.jsonl`, and the strings validate as `InstanceInfo.commands`.
import { InstanceInfoSchema } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { hostPlatform } from '../platform/host.ts';
import { formatCommand, instanceCommands, type InstanceCommandInput } from './commands.ts';

const PLAIN: InstanceCommandInput = {
  launcherPath: 'D:/skill/scripts/mcs.mjs',
  slug: 'demo',
  repoDir: 'D:/work/repo',
  instanceDir: 'D:/work/repo/.claude/monitor/tasks/demo',
};

const SPACED: InstanceCommandInput = {
  launcherPath: 'D:/my skills/monitor/scripts/mcs.mjs',
  slug: 'demo',
  repoDir: 'D:/my work/repo',
  instanceDir: 'D:/my work/repo/.claude/monitor/tasks/demo',
};

describe('formatCommand', () => {
  it('joins the words with single spaces and leaves plain values unquoted', () => {
    expect(formatCommand(['node', 'D:/skill/scripts/mcs.mjs', 'status', '--task', 'demo'])).toBe(
      'node D:/skill/scripts/mcs.mjs status --task demo',
    );
    expect(formatCommand([])).toBe('');
  });

  it('quotes a value only when it contains a space', () => {
    expect(formatCommand(['node', 'D:/a b/mcs.mjs', 'x'])).toBe('node "D:/a b/mcs.mjs" x');
    expect(formatCommand(['--out', 'plain/path.ndjson'])).toBe('--out plain/path.ndjson');
    expect(
      formatCommand(['a-b', 'c_d', 'e.f', 'g:h', '--k=v', 'D:/work/repo', 'a,b', 'a+b', '@x', 'C:/ADMINI~1/x']),
    ).toBe('a-b c_d e.f g:h --k=v D:/work/repo a,b a+b @x C:/ADMINI~1/x');
  });

  it('quotes a value with a tab or a line break, an empty value, and escapes a double quote', () => {
    expect(formatCommand(['a\tb'])).toBe('"a\tb"');
    expect(formatCommand(['a\nb'])).toBe('"a\nb"');
    expect(formatCommand([''])).toBe('""');
    const backslash = String.fromCharCode(92);
    expect(formatCommand(['say "hi"'])).toBe(`"say ${backslash}"hi${backslash}""`);
    expect(formatCommand(['a"b'])).toBe(`"a${backslash}"b"`);
  });
});

describe('formatCommand: what the shell would otherwise run or expand (pasting the string must not execute a value)', () => {
  const bs = String.fromCharCode(92);
  const tick = String.fromCharCode(96);

  it('escapes backslash, dollar sign and backtick inside the double quotes, so that bash does not expand them', () => {
    expect(formatCommand(['echo', 'a b$(echo INJECTED)'])).toBe(`echo "a b${bs}$(echo INJECTED)"`);
    expect(formatCommand([`a b${tick}id${tick}`])).toBe(`"a b${bs}${tick}id${bs}${tick}"`);
    expect(formatCommand(['a b$HOME'])).toBe(`"a b${bs}$HOME"`);
    // a trailing backslash would swallow the closing quote
    expect(formatCommand([`a b${bs}`])).toBe(`"a b${bs}${bs}"`);
    // the backslash is escaped before the quote, so a pair is not read twice
    expect(formatCommand([`a${bs}"b`])).toBe(`"a${bs}${bs}${bs}"b"`);
  });

  it('quotes a value without a space when it contains a character that the shell treats as syntax', () => {
    for (const value of [
      'a$b',
      'a&b',
      'a;b',
      'a|b',
      'a<b',
      'a>b',
      'a(b)',
      'a*b',
      'a?b',
      'a[b]',
      'a{b}',
      "it's",
      '#x',
      '~x',
    ]) {
      const text = formatCommand([value]);
      expect(text.startsWith('"') && text.endsWith('"'), value).toBe(true);
    }
    expect(formatCommand(['a$b'])).toBe(`"a${bs}$b"`);
    expect(formatCommand(["it's"])).toBe(`"it's"`);
    expect(formatCommand([`a${tick}b`])).toBe(`"a${bs}${tick}b"`);
    expect(formatCommand(['a&b'])).toBe('"a&b"');
  });

  it('leaves a value alone that has such a character only after the first one where it is literal (# and ~ inside a word)', () => {
    expect(formatCommand(['a#b', 'a~b'])).toBe('a#b a~b');
  });
});

describe('instanceCommands', () => {
  it('builds the six strings of 01 6.6 with --repo last', () => {
    expect(instanceCommands(PLAIN)).toEqual({
      status: 'node D:/skill/scripts/mcs.mjs status --task demo --repo D:/work/repo',
      restart: 'node D:/skill/scripts/mcs.mjs restart --task demo --repo D:/work/repo',
      inspect: 'node D:/skill/scripts/mcs.mjs inspect --task demo --repo D:/work/repo',
      export:
        'node D:/skill/scripts/mcs.mjs export --task demo --out D:/work/repo/.claude/monitor/tasks/demo/logs/export.ndjson --repo D:/work/repo',
      backup: 'node D:/skill/scripts/mcs.mjs backup --task demo --repo D:/work/repo',
      cleanupDryRun: 'node D:/skill/scripts/mcs.mjs cleanup --task demo --scope logs --repo D:/work/repo',
    });
  });

  it('quotes exactly the values that contain a space', () => {
    const commands = instanceCommands(SPACED);
    expect(commands.status).toBe(
      'node "D:/my skills/monitor/scripts/mcs.mjs" status --task demo --repo "D:/my work/repo"',
    );
    expect(commands.export).toBe(
      'node "D:/my skills/monitor/scripts/mcs.mjs" export --task demo --out "D:/my work/repo/.claude/monitor/tasks/demo/logs/export.ndjson" --repo "D:/my work/repo"',
    );
    expect(commands.cleanupDryRun).toBe(
      'node "D:/my skills/monitor/scripts/mcs.mjs" cleanup --task demo --scope logs --repo "D:/my work/repo"',
    );
    // the slug never contains a space (SLUG_RE), so it is never quoted
    for (const text of Object.values(commands)) expect(text).toContain(' --task demo ');
  });

  it('quotes and escapes a repository path that holds shell syntax, so that pasting the command expands nothing', () => {
    const bs = String.fromCharCode(92);
    const hostile: InstanceCommandInput = { ...PLAIN, repoDir: 'D:/work/$(echo INJECTED)', instanceDir: 'D:/work/x y' };
    const commands = instanceCommands(hostile);
    expect(commands.status).toBe(
      `node D:/skill/scripts/mcs.mjs status --task demo --repo "D:/work/${bs}$(echo INJECTED)"`,
    );
    expect(commands.export).toContain(' --out "D:/work/x y/logs/export.ndjson" ');
  });

  it('writes the export file as export.ndjson inside the workspace, never .jsonl', () => {
    for (const input of [PLAIN, SPACED]) {
      const text = instanceCommands(input).export;
      expect(text).toContain('/logs/export.ndjson');
      expect(text).not.toContain('.jsonl');
    }
  });

  it('shows forward slashes on Windows and keeps the path as it is elsewhere', () => {
    const backslash = String.fromCharCode(92);
    const native: InstanceCommandInput = {
      launcherPath: `D:${backslash}skill${backslash}scripts${backslash}mcs.mjs`,
      slug: 'demo',
      repoDir: `D:${backslash}work${backslash}repo`,
      instanceDir: `D:${backslash}work${backslash}repo${backslash}.claude${backslash}monitor${backslash}tasks${backslash}demo`,
    };
    const status = instanceCommands(native).status;
    if (hostPlatform === 'win32') {
      expect(status).toBe('node D:/skill/scripts/mcs.mjs status --task demo --repo D:/work/repo');
    } else {
      // a backslash is special in a POSIX shell: the path is double-quoted with each backslash escaped, so a paste of the
      // command gives the path back as it is
      expect(status).toBe(
        `node "D:${backslash}${backslash}skill${backslash}${backslash}scripts${backslash}${backslash}mcs.mjs" status --task demo --repo "D:${backslash}${backslash}work${backslash}${backslash}repo"`,
      );
    }
  });

  it('builds the user-instance commands with --user and no --task or --repo (06 2.2)', () => {
    const user: InstanceCommandInput = { ...PLAIN, slug: 'user', kind: 'user' };
    expect(instanceCommands(user)).toEqual({
      status: 'node D:/skill/scripts/mcs.mjs status --user',
      restart: 'node D:/skill/scripts/mcs.mjs restart --user',
      inspect: 'node D:/skill/scripts/mcs.mjs inspect --user',
      export:
        'node D:/skill/scripts/mcs.mjs export --user --out D:/work/repo/.claude/monitor/tasks/demo/logs/export.ndjson',
      backup: 'node D:/skill/scripts/mcs.mjs backup --user',
      cleanupDryRun: 'node D:/skill/scripts/mcs.mjs cleanup --user --scope logs',
    });
    for (const text of Object.values(instanceCommands(user))) {
      expect(text).not.toContain('--task');
      expect(text).not.toContain('--repo');
    }
  });

  it('builds the task commands for kind task, and for no kind at all', () => {
    expect(instanceCommands({ ...PLAIN, kind: 'task' })).toEqual(instanceCommands(PLAIN));
    expect(instanceCommands(PLAIN).status).toContain('--task demo --repo');
  });

  it('is a valid InstanceInfo.commands object', () => {
    const shape = InstanceInfoSchema.shape.commands;
    expect(shape.safeParse(instanceCommands(PLAIN)).success).toBe(true);
    expect(shape.safeParse(instanceCommands(SPACED)).success).toBe(true);
    expect(shape.safeParse(instanceCommands({ ...PLAIN, kind: 'user' })).success).toBe(true);
  });
});
