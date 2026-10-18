// `ops.instances` (01 6.4, 3.4): the listing of the workspaces of a tasks root with the identity and the probe state of each,
// and the explicit identity repair of a copied workspace. The repair itself is `workspace/repair.ts`; this module adds the
// dry run / `--yes` switch of the command. The old-engine column of V3 is gone (V4: one engine).
import path from 'node:path';

import type { InstanceRow } from '@mcs/shared';

import { readSmallFile } from '../platform/fsx.ts';
import { listWorkspaces, type WorkspaceEntry } from '../workspace/list.ts';
import { applyRepair, planRepair, type RepairOptions, type RepairPlan } from '../workspace/repair.ts';
import { BUILD_STAMP_FILE } from '../platform/layout.ts';
import { isLiveState, probeInstance, type ProbeResult } from './probe.ts';
import { openWorkspace, quickProbe, type OpContext } from './workspace.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';

/** What `list` needs from the outside world; tests pass scripted versions. */
export interface InstancesSeams {
  /** The full probe (01 4.8). Default: `probeInstance` with the short timeouts of 01 6.4 (control 300 ms, HTTP 1 s). */
  readonly probe?: (ws: WorkspaceRef) => Promise<Pick<ProbeResult, 'state' | 'pid' | 'url' | 'identity'>>;
  /** The `codeStamp` of the runtime folder's `.mcs-build.json`; `null` when it cannot be read. */
  readonly codeStamp?: () => Promise<string | null>;
}

export interface ListInput {
  /** `false` (`--no-probe`): `state.json` and `pidAlive` only. Default true. */
  readonly probe?: boolean;
}

export interface ListResult {
  readonly instances: readonly InstanceRow[];
}

/** The `codeStamp` of `<runtimeDir>/.mcs-build.json`, or `null`. */
export async function readCodeStamp(runtimeDir: string): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(
      (await readSmallFile(path.join(runtimeDir, BUILD_STAMP_FILE), 1024 * 1024)).toString('utf8'),
    );
    if (typeof value !== 'object' || value === null || !('codeStamp' in value)) return null;
    return typeof value.codeStamp === 'string' ? value.codeStamp : null;
  } catch {
    return null;
  }
}

function identityOf(entry: WorkspaceEntry): InstanceRow['identity'] {
  if (entry.problem !== null) return 'broken';
  return entry.instance === null ? 'missing' : 'node';
}

async function rowOf(
  ctx: OpContext,
  entry: WorkspaceEntry,
  probe: boolean,
  seams: InstancesSeams,
  stamp: string | null,
): Promise<InstanceRow> {
  const base = {
    slug: entry.slug,
    identity: identityOf(entry),
    problem: entry.problem,
  };
  const fileVersion = entry.instance?.runtimeVersion ?? null;
  if (entry.ws === null)
    return { ...base, state: 'unknown', url: null, pid: null, version: fileVersion, outdated: false };
  if (!probe) {
    const quick = await quickProbe(entry.ws);
    return { ...base, state: quick.state, url: quick.url, pid: quick.pid, version: fileVersion, outdated: false };
  }
  const run =
    seams.probe ??
    ((ws) => probeInstance(ws, { runtimeDir: ctx.runtimeDir, controlTimeoutMs: 300, httpTimeoutMs: 1000 }));
  const result = await run(entry.ws);
  const live = isLiveState(result.state);
  const runningStamp = result.identity?.codeStamp;
  return {
    ...base,
    state: result.state,
    url: result.url,
    pid: result.pid,
    version: (live ? result.identity?.runtimeVersion : undefined) ?? fileVersion,
    outdated: live && stamp !== null && runningStamp !== undefined && runningStamp !== stamp,
  };
}

/** `ops.instances.list`: one row per workspace of the tasks root, in slug order; the probes run in parallel. */
export async function list(ctx: OpContext, input: ListInput = {}, seams: InstancesSeams = {}): Promise<ListResult> {
  const probe = input.probe ?? true;
  const entries = await listWorkspaces(ctx.root);
  const stamp = probe ? await (seams.codeStamp ?? (() => readCodeStamp(ctx.runtimeDir)))() : null;
  const instances = await Promise.all(entries.map((entry) => rowOf(ctx, entry, probe, seams, stamp)));
  return { instances };
}

/** The text table of `instances list`: a header and one line per row. */
export function listLines(result: ListResult): string[] {
  if (result.instances.length === 0) return ['no tasks'];
  const header = ['slug', 'identity', 'state', 'url', 'pid', 'version', 'outdated'];
  const rows = result.instances.map((r) => [
    r.slug,
    r.identity,
    r.state,
    r.url ?? '-',
    r.pid === null ? '-' : String(r.pid),
    r.version ?? '-',
    r.outdated ? 'yes' : 'no',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

export interface RepairInput {
  readonly task: string;
  /** `--yes`: apply the plan; without it the plan is printed and nothing is written (01 3.4). */
  readonly yes?: boolean;
}

export interface RepairIdentityResult {
  readonly plan: RepairPlan;
  readonly applied: boolean;
}

/** `ops.instances.repairIdentity` (01 3.4): a dry run by default; `--yes` applies and refuses while a runtime runs. */
export async function repairIdentity(
  ctx: OpContext,
  input: RepairInput,
  o: RepairOptions = {},
): Promise<RepairIdentityResult> {
  const ws = await openWorkspace(ctx, input.task);
  const plan = await planRepair(ws, { clock: ctx.clock, ...o });
  if (input.yes !== true) return { plan, applied: false };
  const result = await applyRepair(ws, plan, { clock: ctx.clock, ...o });
  return { plan: result.plan, applied: true };
}

/** The text of `instances repair`: what the plan does, and whether it was applied. */
export function repairLines(result: RepairIdentityResult): string[] {
  const { plan } = result;
  const lines = [
    `task: ${plan.slug}`,
    `identity: ${plan.oldInstanceId.slice(0, 8)} -> ${plan.newInstanceId.slice(0, 8)}` +
      (plan.mismatch ? ` (instance.json named '${plan.oldSlug}')` : ''),
    plan.moveData && plan.orphanedDir !== null ? `move data/ to ${plan.orphanedDir}/` : 'no data to move',
  ];
  if (plan.removeState) lines.push('remove state.json');
  if (plan.removeRun) lines.push('clear run/');
  lines.push(result.applied ? 'repaired' : `dry run: nothing changed; run again with --yes to apply`);
  return lines;
}
