// `doctor` (01 6.4, V4; 06 2.3, 2.6): the portability checks of the machine and the runtime and, with a task, its workspace; for the
// app the workspace of the app (when it was made) and the `app.*` checks, which `main.ts` wires in. The checks themselves are
// proven in the engine (doctor.test.ts, app-checks.test.ts); here is what the command asks for and how it prints it.
import type { DoctorInput, OpContext } from '@mcs/engine';
import type { DoctorReport } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext, OpDeps } from '../main.ts';
import { command, makeCommand } from './doctor.ts';

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

const PASSED: DoctorReport = {
  task: null,
  ok: true,
  checks: [
    { id: 'node.version', ok: true, level: 'error', detail: 'node 24' },
    { id: 'claude.home', ok: false, level: 'warn', detail: 'no claude home', fix: 'run claude once' },
  ],
};

const FAILED: DoctorReport = {
  task: null,
  ok: false,
  checks: [{ id: 'app.claude', ok: false, level: 'error', detail: 'claude was not found', fix: 'install it' }],
};

/** A doctor that records its inputs and answers `report`. */
function recording(report: DoctorReport) {
  const seen: { readonly input: DoctorInput; readonly deps: OpDeps | undefined }[] = [];
  return {
    seen,
    ops: {
      run: (_ctx: OpContext, input?: DoctorInput, deps?: OpDeps) => {
        seen.push({ input: input ?? {}, deps });
        return Promise.resolve(report);
      },
    },
  };
}

const MADE = { userInstanceExists: () => Promise.resolve(true) };
const NEVER_MADE = { userInstanceExists: () => Promise.resolve(false) };

describe('doctor command', () => {
  it('takes --task, and checks the app when nothing selects a task', () => {
    expect(command.name).toBe('doctor');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual(['task']);
    expect(command.options['task']?.required).not.toBe(true);
  });
});

describe('doctor command: a task call (unchanged)', () => {
  it('runs the checks of the task with the dependencies of the kernel and prints the doctor lines', async () => {
    const { seen, ops } = recording(PASSED);
    const deps: OpDeps = { extraChecks: {} };
    const out = await makeCommand(ops, {
      userInstanceExists: () => {
        throw new Error('a call in task scope asked about the app');
      },
    }).run(contextOf({ task: 'demo' }, 'task', deps));
    expect(seen).toEqual([{ input: { task: 'demo' }, deps }]);
    expect(out.text).toEqual([
      '[ok] node.version: node 24',
      '[warn] claude.home: no claude home',
      '  fix: run claude once',
    ]);
    expect(out.data).toEqual(PASSED);
    expect(out.exitCode).toBe(0);
  });

  it('without a task only the machine-wide checks run, and an error-level failure is exit 1', async () => {
    const { seen, ops } = recording(FAILED);
    const out = await makeCommand(ops, NEVER_MADE).run(contextOf({}, 'task'));
    expect(seen.map((s) => s.input)).toEqual([{}]);
    expect(out.exitCode).toBe(1);
    expect(out.text).toEqual(['[FAIL] app.claude: claude was not found', '  fix: install it']);
  });

  it('a context built without a scope is a task call', async () => {
    const { seen, ops } = recording(PASSED);
    await makeCommand(ops, NEVER_MADE).run(contextOf({ task: 'demo' }));
    expect(seen.map((s) => s.input)).toEqual([{ task: 'demo' }]);
  });
});

describe('doctor command: the app', () => {
  it('runs the checks of the workspace of the app, with the dependencies of the kernel (they carry the app.* checks)', async () => {
    const { seen, ops } = recording(PASSED);
    const deps: OpDeps = { extraChecks: {} };
    const out = await makeCommand(ops, MADE).run(contextOf({ task: 'user' }, 'user', deps));
    expect(seen).toEqual([{ input: { task: 'user' }, deps }]);
    expect(out.text).toEqual([
      '[ok] node.version: node 24',
      '[warn] claude.home: no claude home',
      '  fix: run claude once',
    ]);
    expect(out.exitCode).toBe(0);
  });

  it('an app that was never started has no workspace: the machine and app checks run, and the output says so', async () => {
    const { seen, ops } = recording(PASSED);
    const out = await makeCommand(ops, NEVER_MADE).run(contextOf({ task: 'user' }, 'user'));
    expect(seen.map((s) => s.input)).toEqual([{}]);
    expect(out.text).toEqual([
      '[ok] node.version: node 24',
      '[warn] claude.home: no claude home',
      '  fix: run claude once',
      'note: the app was never started (run `caw start`), so the checks of its workspace were skipped',
    ]);
    expect(out.data).toEqual(PASSED);
    expect(out.exitCode).toBe(0);
  });

  it('an error-level failure of an app check is exit 1', async () => {
    const out = await makeCommand(recording(FAILED).ops, MADE).run(contextOf({}, 'user'));
    expect(out.exitCode).toBe(1);
    expect(out.text).toEqual(['[FAIL] app.claude: claude was not found', '  fix: install it']);
  });

  it('a failure of the question about the workspace propagates (nothing is guessed)', async () => {
    const failure = new Error('cannot read the folder');
    const cmd = makeCommand(recording(PASSED).ops, { userInstanceExists: () => Promise.reject(failure) });
    await expect(cmd.run(contextOf({}, 'user'))).rejects.toBe(failure);
  });
});
