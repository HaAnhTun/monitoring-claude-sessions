// Pure half of the clean-worktree gate (design 08 section 4.6, like docker-posix-plan.mjs): the options, the step plan G0-G13,
// the failure classes of the flaky-test policy (4.5), the parsers of tool output, the leak deltas and the report. No I/O here, so
// the tooling test drives every function without a worktree; `gate-clean.mjs` runs the plan.
import { isAbsolute, relative, resolve } from 'node:path';

export const REPORT_SCHEMA = 'caw.gate/1';
export const SKIP_EXIT = 77;
export const DEFAULT_WORKERS = 3;
/** A 5-second CPU mean above this percentage runs the gate with `QA_TIME_SCALE=2` (4.4). */
export const CPU_SCALE_THRESHOLD = 60;
/** The listener ranges the preflight and the leak step record (test ports and the product default). */
export const LISTEN_RANGES = [
  [18000, 18999],
  [7690, 7690],
];
/** The process families counted before and after the run (new leak classes of the terminal, 4.4). */
export const PROCESS_COUNTERS = ['OpenConsole', 'conhost', 'node (worktree)', 'fake-claude'];

/** One entry per step: id, key (accepted by `--skip`), title. */
export const STEP_TABLE = [
  ['G0', 'preflight', 'preflight'],
  ['G1', 'worktree', 'worktree'],
  ['G2', 'install', 'npm ci'],
  ['G3', 'ci', 'ci --offline --bundle'],
  ['G4', 'tooling', 'test:tooling alone'],
  ['G5', 'isolation', 'test:isolation alone'],
  ['G6', 'resilience', 'test:resilience alone'],
  ['G7', 'pty', 'test:pty and soak'],
  ['G8', 'contracts', 'schemas:check and no Python file'],
  ['G9', 'browser', 'Playwright configs'],
  ['G10', 'shots', 'visual QA shots'],
  ['G11', 'bench', 'terminal bench (report only)'],
  ['G12', 'docker', 'docker:posix'],
  ['G13', 'leaks', 'leak deltas and cleanup'],
];
export const STEP_IDS = STEP_TABLE.map(([id]) => id);

/** The ci rows G3 requires (a row that is missing is a failure: `ci.mjs` must not lose a gate unseen). */
export const REQUIRED_CI_ROWS = [
  'format:check',
  'lint',
  'typecheck',
  'check:deps',
  'build',
  'test',
  'test:pty',
  'smoke',
  'bundle:check',
  'smoke:bundle',
];
/** Rows that may be SKIPPED, and only off Windows (terminals are Windows-only in this release, spec Q1). */
export const PTY_ROWS = ['test:pty', 'test:e2e:terminal'];

export class UsageError extends Error {}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
/** Removes terminal colour codes from tool output. */
export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

/** True when `child` is `parent` or lies below it (both made absolute first). */
export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Parses the command line. `out` is required (and must lie outside the repository: the caller checks with `isInside`). */
export function parseArgs(argv) {
  const opts = {
    out: undefined,
    ref: 'HEAD',
    worktree: undefined,
    skip: new Set(),
    keep: false,
    workers: DEFAULT_WORKERS,
    withDocker: false,
    repo: undefined,
  };
  const value = (i, flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
      case '--ref':
      case '--worktree':
      case '--repo':
        opts[arg.slice(2)] = value(i, arg);
        i += 1;
        break;
      case '--skip':
        for (const part of value(i, arg).split(',')) {
          const id = stepIdOf(part.trim());
          if (id === undefined) throw new UsageError(`--skip: unknown step '${part.trim()}'; known: ${knownSteps()}`);
          opts.skip.add(id);
        }
        i += 1;
        break;
      case '--workers': {
        const text = value(i, arg);
        if (!/^[1-9]\d*$/.test(text)) throw new UsageError('--workers must be a positive integer');
        opts.workers = Number(text);
        i += 1;
        break;
      }
      case '--keep':
        opts.keep = true;
        break;
      case '--with-docker':
        opts.withDocker = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.out === undefined)
    throw new UsageError('--out <dir> is required: the report folder, outside the repository');
  for (const id of ['G0', 'G1']) {
    if (opts.skip.has(id))
      throw new UsageError(`${id} cannot be skipped: every later step needs the baseline and the worktree`);
  }
  return opts;
}

function knownSteps() {
  return STEP_TABLE.map(([id, key]) => `${id}/${key}`).join(', ');
}

/** `G3`, `g3` or `ci` to `G3`; undefined for anything else. */
export function stepIdOf(text) {
  const lower = text.toLowerCase();
  const row = STEP_TABLE.find(([id, key]) => id.toLowerCase() === lower || key === lower);
  return row?.[0];
}

const RUNTIME = 'runtime';

const node = (args, extra = {}) => ({ type: 'command', tool: 'node', args, cwd: RUNTIME, ...extra });
const npm = (args, extra = {}) => ({ type: 'command', tool: 'npm', args, cwd: RUNTIME, ...extra });

/**
 * The step plan. Every step has `id`, `key`, `title`, `actions` (commands run in the worktree's `runtime` folder, or named internal
 * actions), `env` (added to the environment of its commands), `reportOnly` (a failure is shown but does not fail the verdict),
 * `optional` (skipping it does not make the verdict INCOMPLETE) and `skipped` (the reason, or null).
 * `project` names a vitest project that the flake rule may re-run once (4.5).
 */
export function planSteps(options) {
  const workers = options.workers ?? DEFAULT_WORKERS;
  const skip = options.skip ?? new Set();
  const out = options.out ?? '';
  const base = { VITEST_MAX_WORKERS: String(workers), QA_PTY_REQUIRED: '1' };
  const shotsDir = `${out.replaceAll('\\', '/').replace(/\/+$/, '')}/shots`;
  const definitions = {
    G0: { actions: [{ type: 'internal', name: 'preflight' }] },
    G1: { actions: [{ type: 'internal', name: 'worktree' }] },
    G2: { actions: [npm(['ci', '--prefer-offline'])] },
    G3: {
      actions: [node(['scripts/ci.mjs', '--offline', '--bundle', '--keep-going'], { parse: 'ci' })],
    },
    G4: { actions: [npm(['run', 'test:tooling'])], project: 'tooling' },
    G5: { actions: [npm(['run', 'test:isolation'])], project: 'isolation' },
    G6: { actions: [npm(['run', 'test:resilience'])], project: 'resilience' },
    G7: {
      actions: [
        node(['scripts/test-pty.mjs'], { skipOnExit77: true }),
        node(['scripts/pty-soak.mjs', '--runs', '3'], { skipOnExit77: true }),
      ],
    },
    G8: { actions: [npm(['run', 'schemas:check']), { type: 'internal', name: 'noPython' }] },
    G9: {
      actions: [
        node(['node_modules/@playwright/test/cli.js', 'test', '-c', 'packages/web/e2e/playwright.config.ts'], {
          continueOnFailure: true,
        }),
        npm(['run', 'test:e2e:terminal'], { skipOnExit77: true }),
      ],
    },
    G10: {
      env: { MCS_SHOTS_DIR: shotsDir },
      actions: [
        node(['node_modules/@playwright/test/cli.js', 'test', '-c', 'packages/web/e2e/qa/playwright.config.ts']),
        { type: 'internal', name: 'shotsIndex' },
      ],
    },
    G11: {
      reportOnly: true,
      optional: true,
      actions: [npm(['run', 'bench:terminal', '--', '--minutes', '2', '--report-only'])],
    },
    G12: {
      optional: true,
      environmentIsReportOnly: true,
      actions: [npm(['run', 'docker:posix', '--', '--targets', 'node22,node24,alpine24', '--platform', 'amd64'])],
    },
    G13: { actions: [{ type: 'internal', name: 'leaks' }] },
  };
  return STEP_TABLE.map(([id, key, title]) => {
    const definition = definitions[id];
    let skipped = null;
    if (skip.has(id)) skipped = `--skip ${id}`;
    else if (id === 'G12' && !options.withDocker) skipped = 'not requested (--with-docker)';
    return {
      id,
      key,
      title,
      reportOnly: false,
      optional: false,
      environmentIsReportOnly: false,
      project: null,
      ...definition,
      env: { ...base, ...definition.env },
      skipped,
    };
  });
}

/** The command that re-runs one failed test file alone (4.5 item 1). */
export function aloneAction(failure) {
  const args = ['node_modules/vitest/vitest.mjs', 'run'];
  if (failure.project) args.push('--project', failure.project);
  args.push(failure.file);
  return node(args);
}

/** A readable command line of an action for the report and the logs. */
export function describeAction(action) {
  if (action.type === 'internal') return `internal ${action.name}`;
  return `${action.tool} ${action.args.join(' ')}`;
}

/**
 * The class of a failure by its log text (4.5 item 2): `X` environment (browser or Docker missing), `P` a leaked process or a
 * port collision, `T` a test or hook timeout, `L` a latency or budget assertion, `A` any other assertion. First match wins in
 * that order, because a collision or a missing tool is the cause of the timeout that follows it.
 */
export function classifyFailure(logText) {
  const text = stripAnsi(logText);
  const rules = [
    [
      'X',
      /Executable doesn't exist|browserType\.launch|Cannot connect to the Docker daemon|docker: command not found|error during connect|the docker command was not found|daemon did not answer|ENOSPC/i,
    ],
    [
      'P',
      /EADDRINUSE|address already in use|port \d+ (?:is )?(?:already )?in use|leaked (?:process|child|console)|still (?:listening|running)|orphan/i,
    ],
    ['T', /Test timed out|Hook timed out|Test timeout of \d+\s?ms exceeded|Timeout of \d+\s?ms exceeded/i],
    ['L', /latency|budget|too slow|slower than/i],
  ];
  for (const [name, pattern] of rules) if (pattern.test(text)) return name;
  return 'A';
}

const COUNT_WORDS = ['failed', 'passed', 'skipped', 'todo'];

function readCounts(segment) {
  const counts = { failed: 0, passed: 0, skipped: 0, todo: 0, total: 0 };
  for (const [, n, word] of segment.matchAll(/(\d+)\s+(failed|passed|skipped|todo)/g)) counts[word] = Number(n);
  const total = /\((\d+)\)\s*$/.exec(segment.trim());
  counts.total = total ? Number(total[1]) : COUNT_WORDS.reduce((sum, word) => sum + counts[word], 0);
  return counts;
}

/** Every vitest summary (`Test Files` and `Tests` lines) of a log, in order. */
export function parseVitestSummaries(text) {
  const clean = stripAnsi(text);
  const files = [...clean.matchAll(/^\s*Test Files\s+(.+)$/gm)];
  const tests = [...clean.matchAll(/^\s*Tests\s+(.+)$/gm)];
  return files.map((match, i) => ({
    files: readCounts(match[1]),
    tests: tests[i] ? readCounts(tests[i][1]) : { failed: 0, passed: 0, skipped: 0, todo: 0, total: 0 },
  }));
}

/**
 * A failed-file line of vitest 5, colours stripped: ` FAIL  tooling a.test.js > name` (a bare project name, the form with colour
 * on, as in CI) or ` FAIL  |tooling| a.test.js > name` (pipes, the form without colour), and no project name at all with a
 * single project. The project name never holds a path separator, so a bare path is not read as one.
 */
const FAILED_FILE_LINE =
  /^\s*FAIL\s+(?:\|([^|\s]+)\|\s+|([^\s/\x5c|]+)\s+(?=\S+?\.(?:test|spec)\.[cm]?[jt]sx?))?(\S+?\.(?:test|spec)\.[cm]?[jt]sx?)/gm;

/** The last vitest summary of a log with the distinct failed files, or null when the log has none. */
export function parseVitestSummary(text) {
  const summaries = parseVitestSummaries(text);
  const last = summaries.at(-1);
  if (last === undefined) return null;
  const failed = new Map();
  for (const match of stripAnsi(text).matchAll(FAILED_FILE_LINE)) {
    const project = match[1] ?? match[2] ?? null;
    const key = `${project ?? ''}|${match[3]}`;
    if (!failed.has(key)) failed.set(key, { project, file: match[3] });
  }
  return { files: last.files, tests: last.tests, failedFiles: [...failed.values()] };
}

/** The summary line of a Playwright run (`3 passed (10s)`, `1 failed`), or null. */
export function parsePlaywrightSummary(text) {
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  let seen = false;
  for (const match of stripAnsi(text).matchAll(/^\s+(\d+)\s+(passed|failed|skipped|flaky)\b/gm)) {
    counts[match[2]] += Number(match[1]);
    seen = true;
  }
  return seen ? counts : null;
}

/** The result table and the `not run:` line printed by `scripts/ci.mjs` (the last table of the text). */
export function parseCiOutput(text) {
  const rows = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (line.startsWith('| gate |')) rows.length = 0;
    const match = /^\| (\S+) \| (.+) \| (\d+) \|$/.exec(line);
    if (match && match[1] !== 'gate') rows.push({ name: match[1], result: match[2], ms: Number(match[3]) });
  }
  const notRun = /^not run: (.*)$/m.exec(stripAnsi(text))?.[1] ?? null;
  return { rows, notRun };
}

/** Judges the ci table of G3: every required row present and PASS (`test:pty` and `test:e2e:terminal` may be SKIPPED off Windows only). */
export function evaluateCi(parsed, { platform }) {
  const problems = [];
  const byName = new Map(parsed.rows.map((row) => [row.name, row]));
  for (const name of REQUIRED_CI_ROWS) if (!byName.has(name)) problems.push(`row ${name} is missing`);
  for (const row of parsed.rows) {
    if (row.result === 'PASS') continue;
    const skipAllowed = row.result.startsWith('SKIPPED') && PTY_ROWS.includes(row.name) && platform !== 'win32';
    if (!skipAllowed) problems.push(`row ${row.name}: ${row.result}`);
  }
  if (parsed.notRun) problems.push(`not run: ${parsed.notRun}`);
  return { ok: problems.length === 0, problems };
}

/** Listening ports inside the ranges, from `netstat -ano`, `netstat -an` or `ss -ltn` output. Sorted, distinct. */
export function parseListeners(text, ranges = LISTEN_RANGES) {
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const match = /(?:\]|[\d*]|\s)[:.](\d{2,5})\s/.exec(`${line} `);
    if (!match) continue;
    const port = Number(match[1]);
    if (ranges.some(([low, high]) => port >= low && port <= high)) found.add(port);
  }
  return [...found].sort((a, b) => a - b);
}

/** Process lines `pid|name|command line` (Windows CIM output) or `pid command line` (`ps`) as `{pid, name, command}`. */
export function parseProcessList(text) {
  const processes = [];
  for (const line of text.split(/\r?\n/)) {
    const windows = /^\s*(\d+)\|([^|]*)\|(.*)$/.exec(line);
    if (windows) {
      processes.push({ pid: Number(windows[1]), name: windows[2], command: windows[3] });
      continue;
    }
    const posix = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (posix) {
      const first = posix[2].split(/\s+/)[0].split('/').pop();
      processes.push({ pid: Number(posix[1]), name: first, command: posix[2] });
    }
  }
  return processes;
}

const slashes = (text) => text.replaceAll('\\', '/').toLowerCase();

/** Counts the process families of `PROCESS_COUNTERS`; a node process counts when the worktree folder is in its command line. */
export function countProcesses(processes, worktree) {
  const counts = Object.fromEntries(PROCESS_COUNTERS.map((name) => [name, 0]));
  const folder = worktree === undefined ? null : slashes(worktree);
  for (const { name, command } of processes) {
    const lower = name.toLowerCase();
    if (lower === 'openconsole.exe' || lower === 'openconsole') counts['OpenConsole'] += 1;
    if (lower === 'conhost.exe' || lower === 'conhost') counts['conhost'] += 1;
    if ((lower === 'node.exe' || lower === 'node') && folder !== null && slashes(command ?? '').includes(folder)) {
      counts['node (worktree)'] += 1;
    }
    if (/fake-claude\.mjs/i.test(command ?? '')) counts['fake-claude'] += 1;
  }
  return counts;
}

/**
 * The delta of two machine snapshots (`{counts, listeners, tempFolders}`). Every row has `before`, `after` and `delta`
 * (a listener row counts the ports that are new); a green gate has all deltas zero.
 */
export function leakDelta(before, after) {
  const rows = [];
  for (const name of PROCESS_COUNTERS) {
    const b = before.counts?.[name] ?? 0;
    const a = after.counts?.[name] ?? 0;
    rows.push({ name, before: b, after: a, delta: a - b });
  }
  const b = before.tempFolders ?? 0;
  const a = after.tempFolders ?? 0;
  rows.push({ name: 'temp folders mcs-*', before: b, after: a, delta: a - b });
  const was = new Set(before.listeners ?? []);
  const fresh = (after.listeners ?? []).filter((port) => !was.has(port));
  rows.push({
    name: 'listeners 18000-18999, 7690',
    before: (before.listeners ?? []).length,
    after: (after.listeners ?? []).length,
    delta: fresh.length,
    detail: fresh.length > 0 ? `new ports ${fresh.join(', ')}` : '',
  });
  return rows;
}

/** The index of the visual QA run (`{version, files: [...]}`): every picture ok, no console error, the layout and text contracts at zero. */
export function checkShotsIndex(index) {
  const problems = [];
  const files = Array.isArray(index?.files) ? index.files : null;
  if (files === null || files.length === 0) return { ok: false, records: 0, problems: ['index.json has no records'] };
  const zero = ['lowContrastTexts', 'nonMonoText', 'tinyText', 'clippedText', 'clippedColumns', 'pageOverflowX'];
  for (const record of files) {
    const label = `${record.view ?? '?'} ${record.viewport ?? ''} ${record.theme ?? ''}`.trim();
    if (record.status !== 'ok') problems.push(`${label}: status ${record.status ?? 'missing'}`);
    if (typeof record.consoleErrors === 'number' && record.consoleErrors > 0) {
      problems.push(`${label}: ${record.consoleErrors} console error(s)`);
    }
    const measure = record.measure;
    if (measure === null || measure === undefined) continue;
    for (const key of zero) {
      const field =
        typeof measure[key] === 'number' ? measure[key] : Array.isArray(measure[key]) ? measure[key].length : 0;
      if (field > 0) problems.push(`${label}: ${key} ${field}`);
    }
    if (typeof measure.terminal?.cols === 'number' && measure.terminal.cols < 80) {
      problems.push(`${label}: terminal.cols ${measure.terminal.cols} is below 80`);
    }
  }
  return { ok: problems.length === 0, records: files.length, problems };
}

/** The mean CPU load in percent between two `os.cpus()` samples. */
export function cpuPercent(before, after) {
  let idle = 0;
  let total = 0;
  for (let i = 0; i < after.length; i += 1) {
    const b = before[i]?.times;
    const a = after[i]?.times;
    if (!a || !b) continue;
    const sum = (t) => t.user + t.nice + t.sys + t.idle + t.irq;
    idle += a.idle - b.idle;
    total += sum(a) - sum(b);
  }
  return total <= 0 ? 0 : Math.round((1 - idle / total) * 1000) / 10;
}

/** True for a Node version inside `engines.node` of the runtime (^22.22.0, ^24 or 26 and up). */
export function nodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major === 22) return minor >= 22;
  return major === 24 || major >= 26;
}

export const STATUSES = ['PASS', 'FAIL', 'WARN', 'SKIPPED', 'NOT RUN'];

/**
 * The verdict of a finished run: FAIL when a blocking step failed, a leak delta is not zero, the run was interrupted or a step did
 * not run; INCOMPLETE when nothing failed but a required step was skipped; PASS otherwise.
 */
export function verdictOf(result) {
  if (result.interrupted) return 'FAIL';
  const steps = result.steps ?? [];
  if (steps.some((step) => step.status === 'FAIL' || step.status === 'NOT RUN')) return 'FAIL';
  if ((result.leaks ?? []).some((row) => row.delta !== 0)) return 'FAIL';
  if ((result.cleanup?.drift ?? []).length > 0) return 'FAIL';
  if (steps.some((step) => step.status === 'SKIPPED' && !step.optional)) return 'INCOMPLETE';
  return 'PASS';
}

/** One line of counts for the gate table. */
export function describeCounts(counts) {
  if (!counts) return '';
  const parts = [];
  if (counts.tests)
    parts.push(`tests ${counts.tests.passed} passed, ${counts.tests.failed} failed, ${counts.tests.skipped} skipped`);
  if (counts.files) parts.push(`files ${counts.files.total}`);
  if (counts.playwright) {
    const p = counts.playwright;
    parts.push(`playwright ${p.passed} passed, ${p.failed} failed, ${p.skipped} skipped`);
  }
  if (counts.ci) parts.push(`ci rows ${counts.ci.pass} of ${counts.ci.total} pass`);
  if (counts.records !== undefined) parts.push(`${counts.records} shot records`);
  return parts.join('; ');
}

const cell = (text) =>
  String(text ?? '')
    .replaceAll('|', '/')
    .replace(/\s+/g, ' ');

function machineLines(label, snapshot) {
  if (!snapshot) return [`- ${label}: not recorded`];
  const counts = Object.entries(snapshot.counts ?? {})
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
  return [
    `- ${label}: CPU ${snapshot.cpuPercent ?? '?'} percent, free memory ${snapshot.freeMemMb ?? '?'} MB, ` +
      `listeners ${(snapshot.listeners ?? []).length === 0 ? 'none' : snapshot.listeners.join(', ')}, ` +
      `temp folders mcs-* ${snapshot.tempFolders ?? '?'}, processes ${counts || 'none'}`,
  ];
}

/** The Markdown report (`gate-report.md`): commit, tool versions, machine state, gate table, failed files, leaks, cleanup, verdict. */
export function renderReport(result) {
  const verdict = result.verdict ?? verdictOf(result);
  const lines = ['# Clean-worktree gate report', '', `Schema: ${REPORT_SCHEMA}`, ''];
  lines.push('## Commit', '');
  lines.push(`- ref: ${result.commit?.ref ?? '?'}`, `- sha: ${result.commit?.sha ?? '?'}`);
  if (result.commit?.skill) lines.push(`- skill folder: ${result.commit.skill}`);
  lines.push(`- tracked tree clean at start: ${result.commit?.treeClean === false ? 'no' : 'yes'}`, '');
  lines.push('## Tool versions', '');
  for (const [name, version] of Object.entries(result.tools ?? {})) lines.push(`- ${name}: ${version}`);
  const o = result.options ?? {};
  lines.push(
    `- workers: ${o.workers ?? DEFAULT_WORKERS}, QA_TIME_SCALE: ${o.timeScale ?? 'unset'}, docker: ${o.withDocker ? 'requested' : 'not requested'}`,
    '',
  );
  lines.push('## Machine state', '');
  lines.push(...machineLines('start', result.machine?.start), ...machineLines('end', result.machine?.end), '');
  lines.push('## Gates', '', '| step | gate | result | counts | ms |', '|---|---|---|---|---|');
  for (const step of result.steps ?? []) {
    const note = step.note ? ` (${step.note})` : '';
    const cls = step.class ? ` [class ${step.class}]` : '';
    lines.push(
      `| ${step.id} | ${cell(step.title)} | ${step.status}${cell(cls)}${cell(note)} | ${cell(describeCounts(step.counts))} | ${step.ms ?? 0} |`,
    );
  }
  lines.push('');
  lines.push('## Failed files', '');
  if ((result.failedFiles ?? []).length === 0) lines.push('none', '');
  else {
    lines.push('| file | step | class | passes alone | owner |', '|---|---|---|---|---|');
    for (const f of result.failedFiles) {
      const alone = f.passesAlone === null || f.passesAlone === undefined ? 'not run' : f.passesAlone ? 'yes' : 'no';
      lines.push(`| ${cell(f.file)} | ${f.step} | ${f.class} | ${alone} | ${cell(f.owner || 'unassigned')} |`);
    }
    lines.push('');
  }
  if ((result.flakes ?? []).length > 0) {
    lines.push('## Flakes', '');
    for (const flake of result.flakes)
      lines.push(`- ${flake.step}: ${flake.file} (class ${flake.class}), green on the second whole run`);
    lines.push('');
  }
  lines.push('## Leaks', '');
  if ((result.leaks ?? []).length === 0) lines.push('not measured', '');
  else {
    lines.push('| what | before | after | delta |', '|---|---|---|---|');
    for (const row of result.leaks) {
      lines.push(
        `| ${cell(row.name)} | ${row.before} | ${row.after} | ${row.delta}${row.detail ? ` (${cell(row.detail)})` : ''} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Cleanup', '');
  lines.push(`- worktree ${result.cleanup?.worktree ?? 'unknown'}: ${result.cleanup?.state ?? 'unknown'}`);
  if ((result.cleanup?.drift ?? []).length > 0) {
    lines.push(`- tracked files changed by the run: ${result.cleanup.drift.join(', ')}`);
  }
  lines.push('', '## Verdict', '', `Verdict: ${verdict}`, '');
  return lines.join('\n');
}
