// `ops.doctor.run` (01 6.4, V4): the portability doctor. It runs the built-in checks of `doctor-checks.ts` in a fixed order,
// then the checks other areas contribute through `DoctorDeps.extraChecks` (the hooks area replaces the default `hooks`
// line; `workspace.format`, `config.keys` and others are appended in key order). A check that throws, and a provider that
// throws or does not answer within 2 s, becomes one failed check: doctor never crashes on the machine it diagnoses.
import { DoctorReportSchema, type DoctorCheck, type DoctorReport } from '@mcs/shared';

import type { WorkspaceRef } from '../workspace/paths.ts';
import type { CheckDeps, CheckResult } from './config.ts';
import { BUILTIN_CHECKS, configOf, nodeDoctorSeams, type CheckEnv, type DoctorSeams } from './doctor-checks.ts';
import type { ProbeResult } from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

/** A check another area contributes (a `DepsEntry` of its own block in `cli/src/main.ts`). */
export type DoctorCheckProvider = (ctx: OpContext, ws: WorkspaceRef | null) => Promise<DoctorCheck>;

export interface DoctorDeps extends CheckDeps {
  /** Keyed by check id. `hooks` replaces the default hooks line; other keys add checks after the built-in ones. */
  readonly extraChecks?: Readonly<Record<string, DoctorCheckProvider>>;
}

export interface DoctorInput {
  /** The task whose workspace checks run; without it only the machine-wide checks run (workspace checks say skipped). */
  readonly task?: string;
}

/** How long a contributed check may take. */
export const PROVIDER_TIMEOUT_MS = 2000;

function failedCheck(id: string, detail: string): DoctorCheck {
  return { id, ok: false, level: 'warn', detail, fix: 'run again with MCS_DEBUG=1 and report the message' };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(id: string, run: () => Promise<DoctorCheck>, ms: number): Promise<DoctorCheck> {
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
  for (const [id, check] of BUILTIN_CHECKS) {
    const provider = extra[id];
    if (provider !== undefined) {
      checks.push(await withTimeout(id, () => provider(ctx, ws), PROVIDER_TIMEOUT_MS));
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
    if (builtin.has(id) || provider === undefined) continue;
    checks.push(await withTimeout(id, () => provider(ctx, ws), PROVIDER_TIMEOUT_MS));
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
