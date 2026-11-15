// `status` (01 6.3, 4.10; 06 2.3): the legacy JSON of a task with the new keys, or the text lines of the app (the `--json` envelope
// carries `UserStatusReport`); exit 0 iff it runs. Option table and rendering only; the operations are `opsApp.statusUser` and
// `ops.lifecycle.status`.
import { opsApp, opsLifecycle, type UserStatusReport } from '@mcs/engine';
import { PRODUCT_NAME } from '@mcs/shared';
import { appBrowserUrl } from '@mcs/shared/protocol';

import type { CommandDefinition } from '../main.ts';

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `2 h 3 min`: the two largest units that are not zero; a count that is not a number of seconds is `0 s`. */
export function uptimeText(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const part = (count: number, unit: string): string[] => (count === 0 ? [] : [`${String(count)} ${unit}`]);
  if (total >= DAY)
    return [...part(Math.floor(total / DAY), 'd'), ...part(Math.floor((total % DAY) / HOUR), 'h')].join(' ');
  if (total >= HOUR) {
    return [...part(Math.floor(total / HOUR), 'h'), ...part(Math.floor((total % HOUR) / MINUTE), 'min')].join(' ');
  }
  if (total >= MINUTE) return `${String(Math.floor(total / MINUTE))} min`;
  return `${String(total)} s`;
}

/** The address a person types: `http://127.0.0.1:<port>/`. An address that does not parse is shown as it is. */
function browserUrlOf(url: string): string {
  try {
    return appBrowserUrl(Number(new URL(url).port));
  } catch {
    return url;
  }
}

const LABEL_WIDTH = 12;

function field(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

function terminalsText(terminals: UserStatusReport['terminals']): string {
  return terminals === null ? 'unknown' : `${String(terminals.live)} live (max ${String(terminals.max)})`;
}

/**
 * The lines of `status` for the app (06 2.3): the name, the version and the state; then the address, the pid and the uptime, the
 * live terminals, whether the code is outdated, the autostart, the folder and the logs. An app that does not run says why (the hint
 * of the operation) instead of the figures of a process. The hint is printed as the operation worded it: the kernel words the
 * commands it suggests for the app (`--task user` is dropped, `scope.ts`).
 */
export function userStatusLines(report: UserStatusReport): string[] {
  const running = report.running;
  const version = report.runtime_version === undefined ? '' : ` ${report.runtime_version}`;
  const state = running ? 'running' : report.probe === 'stopped' ? 'not running' : `not running (${report.probe})`;
  const lines = [`${PRODUCT_NAME}${version}: ${state}`];
  if (report.url !== undefined) lines.push(field('url', browserUrlOf(report.url)));
  if (report.port_note !== null) lines.push(field('port', report.port_note));
  if (report.pid !== undefined) {
    const up = report.uptime_s === undefined ? '' : ` (up ${uptimeText(report.uptime_s)})`;
    lines.push(field('pid', `${String(report.pid)}${up}`));
  }
  if (running) lines.push(field('terminals', terminalsText(report.terminals)));
  if (running && report.outdated !== undefined) {
    lines.push(field('outdated', report.outdated ? 'yes (run `caw restart`)' : 'no'));
  }
  if (!running && report.hint !== undefined) lines.push(field('hint', report.hint));
  lines.push(field('autostart', report.autostart), field('folder', report.home), field('logs', report.logs_dir));
  return lines;
}

export function makeCommand(
  ops: Pick<typeof opsLifecycle, 'status'> = opsLifecycle,
  app: Pick<typeof opsApp, 'statusUser'> = opsApp,
): CommandDefinition {
  return {
    name: 'status',
    summary:
      'show whether the app runs: address, pid, uptime, live terminals, autostart; with --task, the monitor of a task (JSON)',
    synopsis: '[--task SLUG]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to look at (task scope; default: the task "default" when it exists)',
      },
    },
    defaultScope: 'user',
    async run(ctx) {
      if (ctx.scope === 'user') {
        const result = await app.statusUser(ctx.op);
        return {
          data: result.report,
          text: userStatusLines(result.report),
          warnings: result.warnings,
          exitCode: result.exitCode,
        };
      }
      const task = ctx.args.string('task');
      const result = await ops.status(ctx.op, task === undefined ? {} : { task });
      return { data: result.report, legacy: result.report, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
