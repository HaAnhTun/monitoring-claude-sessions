// The hooks commands as the CLI adapts them (01 6.3, 6.4; ADR 0070 item 7): option tables, the consent prompt that appears only when
// stdin and stdout are both terminals and applies the plan only for the typed word, and the text of a plan, a result and a status.
// The engine operations are scripted; the real flow is proved by `test/hooks.int.test.ts`.
import type { OpContext } from '@mcs/engine';
import type { HooksApplyResult, HooksStatusResult } from '@mcs/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../main.ts';
import { makeCommand as makeInstall } from './install.ts';
import { statusLines } from './status.ts';
import { disableCommand, enableCommand } from './toggle.ts';
import { makeCommand as makeUninstall } from './uninstall.ts';
import { verifyLines } from './verify.ts';
import { CONSENT_TEXT, DRY_RUN_LAST_LINE, EXEC_FORM_NOTE, type ConsentIo } from './shared.ts';

type Typed = Record<string, string | boolean>;

function contextOf(values: Typed, json = false): CommandContext {
  const text = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    op: { repo: 'R' } as unknown as OpContext,
    args: {
      positionals: [],
      string: text,
      strings: (name) => {
        const v = text(name);
        return v === undefined ? [] : [v];
      },
      flag: (name) => values[name] === true,
      int: () => undefined,
    },
    deps: {},
    json,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

function applyResult(over: Partial<HooksApplyResult> = {}): HooksApplyResult {
  return {
    scope: 'project-local',
    settingsPath: 'R/.claude/settings.local.json',
    action: 'plan',
    added: ['SessionStart', 'Stop'],
    replaced: ['Notification'],
    removed: [],
    kept: ['SessionEnd'],
    warnings: [{ code: 'HOOKS_LIVE_RELOAD', message: 'running sessions pick this up' }],
    backupPath: null,
    diff: '--- a\n+++ b\n+x\n',
    script: { action: 'created', path: 'H/hooks/mcs-hook.mjs', sha256: null },
    ...over,
  };
}

/** A consent that is a terminal or not and answers with `answer`; `asked` records what the person saw. */
function consentOf(tty: boolean, answer: string): ConsentIo & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    isTty: () => tty,
    ask: (lines) => {
      asked.push([...lines]);
      return Promise.resolve(answer);
    },
  };
}

/** The prompt path prints the plan through the terminal module; the tests keep the real streams quiet. */
function silenceStreams(): void {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

describe('hooks install', () => {
  beforeEach(silenceStreams);

  it('has the options of 01 6.3 and the name of the envelope', () => {
    const cmd = makeInstall({ install: () => Promise.reject(new Error('unused')) });
    expect(cmd.name).toBe('hooks install');
    expect(Object.keys(cmd.options)).toEqual([
      'scope',
      'settings-file',
      'task',
      'sync-tool-events',
      'dry-run',
      'yes',
      'no-prompt',
    ]);
    expect(cmd.options['scope']?.choices).toEqual(['project-local', 'user', 'project']);
  });

  it('is a dry run without --yes: the plan names the file, the events, the script copy, the exec-form requirement and the consent text', async () => {
    const calls: boolean[] = [];
    const cmd = makeInstall(
      {
        install: (_ctx, input) => {
          calls.push(input.yes === true);
          return Promise.resolve(applyResult());
        },
      },
      consentOf(false, 'install'),
    );
    const result = await cmd.run(contextOf({ task: 'demo' }));
    expect(calls).toEqual([false]);
    const text = (result.text ?? []).join('\n');
    expect(text).toContain('settings file: R/.claude/settings.local.json (scope project-local)');
    expect(text).toContain('+ SessionStart');
    expect(text).toContain('~ Notification');
    expect(text).toContain('= SessionEnd');
    expect(text).toContain('script copy H/hooks/mcs-hook.mjs: would be created');
    expect(text).toContain(EXEC_FORM_NOTE);
    expect(text).toContain('args');
    expect(text).toContain(CONSENT_TEXT);
    expect(result.text?.at(-1)).toBe(DRY_RUN_LAST_LINE);
    expect(result.warnings).toEqual(['running sessions pick this up']);
  });

  it('never asks when stdin or stdout is not a terminal, with --json, --no-prompt or --dry-run, even if the answer would be the word', async () => {
    const calls: boolean[] = [];
    const ops = {
      install: (_ctx: OpContext, input: { yes?: boolean }) => {
        calls.push(input.yes === true);
        return Promise.resolve(applyResult());
      },
    };
    const cases: [Typed, boolean, boolean][] = [
      [{}, false, false],
      [{}, true, true],
      [{ 'no-prompt': true }, true, false],
      [{ 'dry-run': true }, true, false],
    ];
    for (const [flags, tty, json] of cases) {
      const consent = consentOf(tty, 'install');
      const result = await makeInstall(ops, consent).run(contextOf(flags, json));
      if (tty && json) expect(consent.asked).toEqual([]);
      if (flags['no-prompt'] === true || flags['dry-run'] === true || !tty) expect(consent.asked).toEqual([]);
      expect(result.text?.at(-1)).toBe(DRY_RUN_LAST_LINE);
    }
    expect(calls.every((yes) => !yes)).toBe(true);
  });

  it('on a terminal asks once, naming the file and the scope, and applies only when the word is typed', async () => {
    const calls: boolean[] = [];
    const ops = {
      install: (_ctx: OpContext, input: { yes?: boolean }) => {
        calls.push(input.yes === true);
        return Promise.resolve(
          input.yes === true ? applyResult({ action: 'applied', backupPath: 'H/backups/b.json' }) : applyResult(),
        );
      },
    };
    const wrong = consentOf(true, 'yes');
    const declined = await makeInstall(ops, wrong).run(contextOf({}));
    expect(calls).toEqual([false]);
    expect(wrong.asked).toHaveLength(1);
    const question = (wrong.asked[0] ?? []).join('\n');
    expect(question).toContain('R/.claude/settings.local.json');
    expect(question).toContain('scope project-local');
    expect(question).toContain('Type the word install');
    expect(declined.text).toEqual(['not applied; nothing was written']);

    calls.length = 0;
    const right = consentOf(true, ' install \n');
    const done = await makeInstall(ops, right).run(contextOf({}));
    expect(calls).toEqual([false, true]);
    expect((done.text ?? []).join('\n')).toContain('installed hooks in R/.claude/settings.local.json');
    expect((done.text ?? []).join('\n')).toContain('backup of the previous file: H/backups/b.json');
  });

  it('with --yes applies without asking; --yes with --dry-run is a usage error', async () => {
    const calls: boolean[] = [];
    const consent = consentOf(true, 'install');
    const cmd = makeInstall(
      {
        install: (_ctx, input) => {
          calls.push(input.yes === true);
          return Promise.resolve(applyResult({ action: 'applied' }));
        },
      },
      consent,
    );
    await cmd.run(contextOf({ yes: true }));
    expect(calls).toEqual([true]);
    expect(consent.asked).toEqual([]);
    await expect(cmd.run(contextOf({ yes: true, 'dry-run': true }))).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('passes the selectors on; a relative --settings-file becomes absolute', async () => {
    const seen: unknown[] = [];
    const cmd = makeInstall({
      install: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(applyResult({ action: 'noop', script: { action: 'current', path: 'p', sha256: null } }));
      },
    });
    const result = await cmd.run(
      contextOf({ 'settings-file': 'settings.json', task: 'demo', 'sync-tool-events': true, scope: 'user' }),
    );
    expect(seen[0]).toMatchObject({ task: 'demo', scope: 'user', syncToolEvents: true, yes: false });
    expect((seen[0] as { settingsFile: string }).settingsFile).toMatch(/settings\.json$/);
    expect((seen[0] as { settingsFile: string }).settingsFile).not.toBe('settings.json');
    expect((result.text ?? []).join('\n')).toContain('already installed');
  });
});

describe('hooks uninstall', () => {
  beforeEach(silenceStreams);

  it('asks for the word uninstall and nothing else', async () => {
    const calls: boolean[] = [];
    const ops = {
      uninstall: (_ctx: OpContext, input: { yes?: boolean }) => {
        calls.push(input.yes === true);
        return Promise.resolve(
          applyResult({
            action: input.yes === true ? 'applied' : 'plan',
            added: [],
            replaced: [],
            removed: ['Stop'],
            kept: [],
            script: { action: 'removed', path: 'H/hooks/mcs-hook.mjs', sha256: null },
          }),
        );
      },
    };
    const install = consentOf(true, 'install');
    const refused = await makeUninstall(ops, install).run(contextOf({}));
    expect(refused.text).toEqual(['not applied; nothing was written']);
    expect(calls).toEqual([false]);
    const uninstall = consentOf(true, 'uninstall');
    const done = await makeUninstall(ops, uninstall).run(contextOf({}));
    expect(calls).toEqual([false, false, true]);
    expect((done.text ?? []).join('\n')).toContain('removed hooks from');
    expect((done.text ?? []).join('\n')).not.toContain('exec form');
  });
});

describe('hooks enable and hooks disable', () => {
  it('are two commands with one required --task; a running monitor is reported as a warning', async () => {
    expect(enableCommand.name).toBe('hooks enable');
    expect(disableCommand.name).toBe('hooks disable');
    expect(Object.keys(enableCommand.options)).toEqual(['task']);
    expect(enableCommand.options['task']).toMatchObject({ required: true });
    const result = await (
      await import('./toggle.ts')
    )
      .makeCommand(true, {
        setEnabled: () =>
          Promise.resolve({
            task: 'demo',
            enabled: true,
            previous: false,
            changed: true,
            routeFile: 'H/routes/x.json',
            running: true,
          }),
      })
      .run(contextOf({ task: 'demo' }));
    expect(result.text?.[0]).toBe("hooks enabled for task 'demo' (hooks.enabled: false -> true)");
    expect(result.warnings?.[0]).toContain('restart');
  });
});

describe('the text of verify and status', () => {
  it('verify marks a skipped check and a failed one', () => {
    expect(
      verifyLines({
        checks: [
          { check: 'V1', ok: true, detail: 'parses' },
          { check: 'V3', ok: false, detail: 'moved' },
          { check: 'V7', ok: null, detail: 'stopped' },
        ],
      }),
    ).toEqual(['[ok] V1: parses', '[FAIL] V3: moved', '[skip] V7: stopped']);
  });

  it('status offers the uninstall whenever an install exists and says so plainly when none does', () => {
    const base: HooksStatusResult = {
      installs: [],
      script: { state: 'not_installed', path: 'H/hooks/mcs-hook.mjs', sha256: null, handlerVersion: null },
      handlerLog: [],
      lastEnvelopeAt: {},
    };
    expect(statusLines(base).join('\n')).toContain('hooks: not installed');
    expect(statusLines(base).join('\n')).not.toContain('mcs hooks uninstall');
    const installed: HooksStatusResult = {
      ...base,
      installs: [{ settingsPath: 'S', scope: 'user', events: 21, handlerVersion: '4.0.0', at: Date.UTC(2026, 9, 19) }],
      handlerLog: [{ code: 'ROUTE_UNREADABLE', count: 2, lastAt: Date.UTC(2026, 9, 19, 1) }],
      lastEnvelopeAt: { '11111111-1111-4111-8111-111111111111': null },
    };
    const text = statusLines(installed).join('\n');
    expect(text).toContain('S (scope user, 21 events, handler 4.0.0, installed 2026-10-19T00:00:00Z)');
    expect(text).toContain('ROUTE_UNREADABLE x2 (last 2026-10-19T01:00:00Z)');
    expect(text).toContain('last envelope of instance 11111111: none yet');
    expect(text).toContain('mcs hooks uninstall');
  });
});
