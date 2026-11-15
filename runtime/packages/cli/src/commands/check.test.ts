// `check` (01 6.3, 6.4; 06 2.3, 2.6): for a task the one-line summary of its configuration; for the app the prerequisite checks (the
// doctor pipeline limited to the machine-level checks and the `app.*` family, `userCheckIds`), exit 1 iff an error-level check
// failed. The checks themselves are proven in the engine (app-checks.test.ts, doctor.test.ts).
import { userCheckIds, type CheckResult, type DoctorInput, type OpContext } from '@mcs/engine';
import type { DoctorReport } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext, OpDeps } from '../main.ts';
import { command, makeCommand } from './check.ts';

type Typed = Record<string, string | boolean>;

/** The context a command gets from the kernel: the values are the text typed on the command line. */
function contextOf(values: Typed, scope?: 'user' | 'task', deps: OpDeps = {}): CommandContext {
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
      int: (name) => {
        const v = text(name);
        return v === undefined ? undefined : Number(v);
      },
    },
    ...(scope === undefined ? {} : { scope }),
    deps,
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

const SUMMARY = { line: 'config ok: demo (port 18000)' } as unknown as CheckResult;

const PASSED: DoctorReport = {
  task: null,
  ok: true,
  checks: [
    { id: 'node.version', ok: true, level: 'error', detail: 'node 24' },
    { id: 'app.port', ok: false, level: 'warn', detail: '7690 is busy', fix: 'caw start picks the next free port' },
  ],
};

const FAILED: DoctorReport = {
  task: null,
  ok: false,
  checks: [{ id: 'app.claude', ok: false, level: 'error', detail: 'claude was not found', fix: 'install it' }],
};

function recordingDoctor(report: DoctorReport) {
  const seen: { readonly input: DoctorInput; readonly deps: OpDeps | undefined }[] = [];
  return {
    seen,
    doctor: {
      run: (_ctx: OpContext, input?: DoctorInput, deps?: OpDeps) => {
        seen.push({ input: input ?? {}, deps });
        return Promise.resolve(report);
      },
    },
  };
}

function neverConfig(): never {
  throw new Error('a call in the scope of the app reached the configuration check of a task');
}

function neverDoctor(): never {
  throw new Error('a call in task scope reached the doctor');
}

const MADE = { userInstanceExists: () => Promise.resolve(true) };
const NEVER_MADE = { userInstanceExists: () => Promise.resolve(false) };

describe('check command', () => {
  it('takes --task, and checks the prerequisites of the app when nothing selects a task', () => {
    expect(command.name).toBe('check');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual(['task']);
    expect(command.options['task']?.required).not.toBe(true);
  });
});

describe('check command: a task call (unchanged)', () => {
  it('prints the one-line summary of the configuration of the task', async () => {
    const seen: { readonly input: unknown; readonly deps: OpDeps | undefined }[] = [];
    const deps: OpDeps = {};
    const cmd = makeCommand(
      {
        check: (_ctx, input, d) => {
          seen.push({ input, deps: d });
          return Promise.resolve(SUMMARY);
        },
      },
      { run: neverDoctor },
      { userInstanceExists: neverDoctor },
    );
    const out = await cmd.run(contextOf({ task: 'demo' }, 'task', deps));
    expect(seen).toEqual([{ input: { task: 'demo' }, deps }]);
    expect(out.text).toEqual([SUMMARY.line]);
    expect(out.data).toBe(SUMMARY);
    expect(out.exitCode).toBeUndefined();
  });

  it('without a task the shared defaults are checked, and a context without a scope is a task call', async () => {
    const seen: unknown[] = [];
    const cmd = makeCommand(
      {
        check: (_ctx, input) => {
          seen.push(input);
          return Promise.resolve(SUMMARY);
        },
      },
      { run: neverDoctor },
      { userInstanceExists: neverDoctor },
    );
    await cmd.run(contextOf({}));
    expect(seen).toEqual([{}]);
  });
});

describe('check command: the app', () => {
  it('runs the doctor limited to the machine checks and the app.* family, with the workspace of the app when it exists', async () => {
    const { seen, doctor } = recordingDoctor(PASSED);
    const deps: OpDeps = {};
    const out = await makeCommand({ check: neverConfig }, doctor, MADE).run(contextOf({ task: 'user' }, 'user', deps));
    expect(seen).toEqual([{ input: { task: 'user', only: userCheckIds }, deps }]);
    expect(out.text).toEqual([
      '[ok] node.version: node 24',
      '[warn] app.port: 7690 is busy',
      '  fix: caw start picks the next free port',
    ]);
    expect(out.data).toEqual(PASSED);
    expect(out.exitCode).toBe(0);
  });

  it('the list of checks is the one of the engine: node, runtime, claude home, MCS_HOME and every app check', () => {
    expect(userCheckIds).toEqual([
      'node.version',
      'node.sqlite',
      'runtime.layout',
      'claude.home',
      'mcshome.writable',
      'app.',
    ]);
  });

  it('an app that was never started has no workspace: the defaults are checked, and the output says so', async () => {
    const { seen, doctor } = recordingDoctor(PASSED);
    const out = await makeCommand({ check: neverConfig }, doctor, NEVER_MADE).run(contextOf({}, 'user'));
    expect(seen.map((s) => s.input)).toEqual([{ only: userCheckIds }]);
    expect(out.text?.at(-1)).toBe(
      'note: the app was never started (run `caw start`), so its own configuration does not exist yet: the defaults were checked',
    );
    expect(out.exitCode).toBe(0);
  });

  it('exits 1 iff an error-level check failed (a warning does not)', async () => {
    const failed = await makeCommand({ check: neverConfig }, recordingDoctor(FAILED).doctor, MADE).run(
      contextOf({}, 'user'),
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.text).toEqual(['[FAIL] app.claude: claude was not found', '  fix: install it']);
    const warned = await makeCommand({ check: neverConfig }, recordingDoctor(PASSED).doctor, MADE).run(
      contextOf({}, 'user'),
    );
    expect(warned.exitCode).toBe(0);
  });
});
