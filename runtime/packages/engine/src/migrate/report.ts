// The result of `mcs migrate-workspace` (ADR 0068) and the texts built from it: the lines of the default output and the
// summary of the `migrate-workspace` audit entry. Both name counts and locations only, never a pattern text.
import type { PatternStep } from './patterns.ts';

export type MigrationVerdict = 'current' | 'needs-migration' | 'blocked';

export interface WorkspaceMigrationReport {
  readonly slug: string;
  readonly verdict: MigrationVerdict;
  readonly mode: 'dry-run' | 'applied';
  /** What apply does (dry run) or did (applied), in order. Empty for `current` and `blocked`. */
  readonly actions: readonly string[];
  readonly patterns: readonly PatternStep[];
  /** `<CODE>: <reason>`; any blocker means nothing is (or was) written. */
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  /** The backup folder relative to the workspace, when apply wrote one. */
  readonly backup: string | null;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The summary of the audit entry: counts and locations. */
export function auditSummary(steps: readonly PatternStep[], adopted: boolean): string {
  const translated = steps.filter((s) => s.action === 'translate').map((s) => s.where);
  const kept = steps.filter((s) => s.action === 'keep').length;
  const parts = [
    `translated ${count(translated.length, 'pattern')} to the JavaScript dialect${
      translated.length === 0 ? '' : ` (${translated.join(', ')})`
    }`,
    `kept ${count(kept, 'pattern')} as written`,
  ];
  if (adopted) parts.push('added instance.json, audit/, data/ and logs/');
  return parts.join('; ');
}

/**
 * The default output of one report. `hint: false` leaves out the closing line that names the single-task command: a sweep
 * (`--all`) prints one such line for all workspaces.
 */
export function reportLines(r: WorkspaceMigrationReport, options: { readonly hint?: boolean } = {}): string[] {
  const lines = [`task '${r.slug}': ${r.verdict} (${r.mode === 'dry-run' ? 'dry run, nothing written' : 'applied'})`];
  for (const action of r.actions) lines.push(`  ${r.mode === 'dry-run' ? 'would ' : ''}${action}`);
  for (const blocker of r.blockers) lines.push(`  blocked: ${blocker}`);
  if (r.backup !== null) lines.push(`  backup: ${r.backup}`);
  if (options.hint !== false && r.mode === 'dry-run' && r.verdict === 'needs-migration') {
    lines.push(`run \`mcs migrate-workspace --task ${r.slug} --apply\` to convert it (a backup is written first)`);
  }
  return lines;
}
