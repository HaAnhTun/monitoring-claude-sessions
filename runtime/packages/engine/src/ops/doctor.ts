// `ops.doctor.run` (01 6.4, V4): the portability doctor. It runs the built-in checks of `doctor-checks.ts` in a fixed order,
// then the checks other areas contribute through `DoctorDeps.extraChecks` (the hooks area replaces the default `hooks`
// line; `workspace.format`, `config.keys` and others are appended in key order). A check that throws, and a provider that
// throws or does not answer within its budget (2 s unless the provider names its own `timeoutMs`), becomes one failed check:
// doctor never crashes on the machine it diagnoses. A provider may answer `null` to leave its line out (the `app.*` checks of
// the user instance do outside the user scope), and `DoctorInput.only` runs a subset (`caw check`, 06 2.6).
import { DoctorReportSchema, type DoctorCheck, type DoctorReport } from '@mcs/shared';

import type { WorkspaceRef } from '../workspace/paths.ts';
import type { CheckDeps, CheckResult } from './config.ts';
import { BUILTIN_CHECKS, configOf, nodeDoctorSeams, type CheckEnv, type DoctorSeams } from './doctor-checks.ts';
import type { ProbeResult } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

/**
 * A check another area contributes (a `DepsEntry` of its own block in `cli/src/main.ts`). `null` leaves the line out.
 * `timeoutMs` is the time the check may take; without it {@link PROVIDER_TIMEOUT_MS} applies. A check that starts a program
 * (`claude --version`, PowerShell, `icacls`) names a longer budget and bounds each program itself.
 */
export type DoctorCheckProvider = ((ctx: OpContext, ws: WorkspaceRef | null) => Promise<DoctorCheck | null>) & {
  readonly timeoutMs?: number;
};

export interface DoctorDeps extends CheckDeps {
  /** Keyed by check id. `hooks` replaces the default hooks line; other keys add checks after the built-in ones. */
  readonly extraChecks?: Readonly<Record<string, DoctorCheckProvider>>;
}

export interface DoctorInput {
  /** The task whose workspace checks run; without it only the machine-wide checks run (workspace checks say skipped). */
  readonly task?: string;
  /**
   * Run only these checks: an exact id (`node.version`) or a family, an entry that ends in a dot (`app.` selects `app.claude`,
   * `app.port`, ...). A check that is not selected is not run and has no line; `ok` covers the selected ones. Without the option
   * every check runs; an empty list selects none.
   */
  readonly only?: readonly string[];
}

/** How long a contributed check may take unless it names a budget of its own. */
export const PROVIDER_TIMEOUT_MS = 2000;

function selects(only: readonly string[] | undefined, id: string): boolean {
  if (only === undefined) return true;
  return only.some((entry) => (entry.endsWith('.') ? id.startsWith(entry) : id === entry));
}

function failedCheck(id: string, detail: string): DoctorCheck {
  return { id, ok: false, level: 'warn', detail, fix: 'run again with MCS_DEBUG=1 and report the message' };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(id: string, run: () => Promise<DoctorCheck | null>, ms: number): Promise<DoctorCheck | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(failedCheck(id, `did not answer within ${String(ms)} ms`));
    }, ms);
    timer.unref();
    run().then(
      (check) => {
        clearTimeout(timer);
        resolve(check);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(failedCheck(id, `check failed: ${messageOf(error)}`));
      },
    );
  });
}

function once<T>(compute: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => (cached ??= compute());
}

/** `ops.doctor.run`: every check, in order; `ok` is false iff an error-level check failed. Writes nothing. */
export async function run(
  ctx: OpContext,
  input: DoctorInput = {},
  deps: DoctorDeps = {},
  seams: Partial<DoctorSeams> = {},
): Promise<DoctorReport> {
  const all: DoctorSeams = { ...nodeDoctorSeams, ...seams };
  const ws = input.task === undefined ? null : await openWorkspace(ctx, input.task);
  const env: CheckEnv = {
    ctx,
    ws,
    seams: all,
    deps,
    probe: once<ProbeResult>(() => {
      if (ws === null) return Promise.reject(new Error('no task'));
      return all.probe(ws, ctx.runtimeDir);
    }),
    config: once<CheckResult>(() => configOf(ctx, ws, deps)),
  };
  const extra = deps.extraChecks ?? {};
  const checks: DoctorCheck[] = [];
  const ask = async (id: string, provider: DoctorCheckProvider): Promise<void> => {
    const answer = await withTimeout(id, () => provider(ctx, ws), provider.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    if (answer !== null) checks.push(answer);
  };
  for (const [id, check] of BUILTIN_CHECKS) {
    if (!selects(input.only, id)) continue;
    const provider = extra[id];
    if (provider !== undefined) {
      await ask(id, provider);
      continue;
    }
    try {
      checks.push(await check(env));
    } catch (error) {
      checks.push(failedCheck(id, `check failed: ${messageOf(error)}`));
    }
  }
  const builtin = new Set(BUILTIN_CHECKS.map(([id]) => id));
  for (const id of Object.keys(extra).sort()) {
    const provider = extra[id];
    if (builtin.has(id) || provider === undefined || !selects(input.only, id)) continue;
    await ask(id, provider);
  }
  const report: DoctorReport = {
    task: ws?.slug ?? null,
    checks,
    ok: checks.every((c) => c.ok || c.level !== 'error'),
  };
  return DoctorReportSchema.parse(report);
}

/** The text lines: `[ok|warn|FAIL] id: detail`, and `  fix: ...` under a failed check. */
export function doctorLines(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    const tag = c.ok ? 'ok' : c.level === 'error' ? 'FAIL' : 'warn';
    lines.push(`[${tag}] ${c.id}: ${c.detail}`);
    if (!c.ok && c.fix !== undefined) lines.push(`  fix: ${c.fix}`);
  }
  return lines;
}
