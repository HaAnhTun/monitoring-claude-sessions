// The clean-worktree gate (design 08 section 4.6): G0-G13 as one process. It checks out a commit into a short-path git worktree,
// installs, runs the CI table, the heavy test projects alone, the pty gate and its soak, the contract checks, the browser runs, the
// visual QA shots, the bench (report only) and optionally the Docker harness, compares the machine before and after, and writes
// `gate-report.md` and `gate-report.json` (schema caw.gate/1). Run it once under the machine locks of the plan; it takes none itself.
// Usage: node scripts/gate-clean.mjs --out <dir outside the repo> [--ref <rev>] [--worktree <dir>] [--skip <step,...>] [--keep]
//        [--workers 3] [--with-docker] [--repo <git work tree>]
// Exit codes: 0 PASS, 1 FAIL, 2 usage or environment, 3 INCOMPLETE (nothing failed, a required step was skipped), 130 interrupted.
import { spawn, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CPU_SCALE_THRESHOLD,
  REPORT_SCHEMA,
  SKIP_EXIT,
  UsageError,
  aloneAction,
  checkShotsIndex,
  classifyFailure,
  countProcesses,
  cpuPercent,
  describeAction,
  evaluateCi,
  isInside,
  leakDelta,
  nodeSupported,
  parseArgs,
  parseCiOutput,
  parseListeners,
  parsePlaywrightSummary,
  parseProcessList,
  parseVitestSummaries,
  parseVitestSummary,
  planSteps,
  renderReport,
  verdictOf,
} from './gate-clean-lib.mjs';
import { RUNTIME_ROOT } from './lib.mjs';

const MAX_ALONE_FILES = 10;
const TAIL_BYTES = 4 * 1024 * 1024;
const POWERSHELL_PROCESSES =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }';

// ---- helpers that touch the file system (exported for the tooling test) ---------------------------------------------------------

// The skill folder of a checkout, found by scanning the SKILL.md of every folder below skills (relative, forward slashes), or null.
export function findSkillFolder(root) {
  let names;
  try {
    names = readdirSync(join(root, 'skills'), { withFileTypes: true });
  } catch {
    return null;
  }
  const found = names
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => `skills/${entry.name}`)
    .sort();
  return found[0] ?? null;
}

/** Every `.py` file below `root`, outside `node_modules` and `.git` (relative, forward slashes). */
export function listPythonFiles(root) {
  const found = [];
  const visit = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel);
      else if (/\.py$/i.test(entry.name)) found.push(rel);
    }
  };
  visit(root, '');
  return found.sort();
}

function resolveNpmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const root = dirname(process.execPath);
  const candidates = [
    join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

// ---- the default tool runner and machine probes ----------------------------------------------------------------------------------

/** A runner for `{tool, args, cwd, env, logFile}`: tool is `git`, `node` or `npm`. Output goes to the log and to a bounded tail. */
export function makeRunner() {
  let current;
  const run = (spec) =>
    new Promise((resolvePromise) => {
      const started = Date.now();
      let cmd = spec.tool;
      let args = spec.args;
      if (spec.tool === 'node') cmd = process.execPath;
      if (spec.tool === 'npm') {
        const cli = resolveNpmCli();
        if (cli === undefined) {
          resolvePromise({ code: 127, text: 'npm CLI not found', ms: 0 });
          return;
        }
        cmd = process.execPath;
        args = [cli, ...spec.args];
      }
      const log = spec.logFile ? createWriteStream(spec.logFile, { flags: 'a' }) : null;
      let tail = '';
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        resolvePromise({ code: 127, text: String(error), ms: 0 });
        return;
      }
      current = child;
      const collect = (chunk) => {
        log?.write(chunk);
        tail += chunk.toString('utf8');
        if (tail.length > TAIL_BYTES) tail = tail.slice(tail.length - TAIL_BYTES);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      let spawnError = '';
      child.on('error', (error) => (spawnError = error.message));
      child.on('close', (code, signal) => {
        current = undefined;
        const finish = () =>
          resolvePromise({
            code: spawnError !== '' && (code ?? 1) <= 0 ? 127 : (code ?? (signal ? 130 : 1)),
            text: spawnError === '' ? tail : `${tail}\n${spawnError}`,
            ms: Date.now() - started,
          });
        if (log) log.end(finish);
        else finish();
      });
    });
  return { run, kill: () => current?.kill() };
}

function sample(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** The machine probes of the preflight and the leak step: CPU mean, free memory, listeners, processes and temp folders. */
export function makeProbe(cpuSampleMs = 5000) {
  const windows = process.platform === 'win32';
  return {
    async cpu() {
      const before = cpus();
      await new Promise((r) => setTimeout(r, cpuSampleMs));
      return cpuPercent(before, cpus());
    },
    freeMemMb: () => Math.round(freemem() / (1024 * 1024)),
    listeners() {
      const text = windows
        ? sample('netstat', ['-ano', '-p', 'tcp'])
        : sample('ss', ['-ltn']) || sample('netstat', ['-an']);
      return parseListeners(text);
    },
    processes() {
      const text = windows
        ? sample('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROCESSES])
        : sample('ps', ['-A', '-o', 'pid=,args=']);
      return parseProcessList(text);
    },
    tempFolders: () => readdirSync(tmpdir()).filter((name) => name.startsWith('mcs-')).length,
  };
}

const normal = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

/** Two spellings of one folder: equal after normalising, or equal after the file system resolves them (8.3 names, links). */
function samePath(a, b) {
  if (normal(a) === normal(b)) return true;
  try {
    return normal(realpathSync.native(a)) === normal(realpathSync.native(b));
  } catch {
    return false;
  }
}

// ---- the run ---------------------------------------------------------------------------------------------------------------------

/**
 * Runs the gate; resolves to the exit code. `io` replaces the environment for the tooling test: `run` (a tool runner), `probe`,
 * `stdout`, `stderr`, `signals`, `platform`, `findSkill`, `listPython`.
 */
export async function runGateClean(argv, io = {}) {
  const out = (text) => (io.stdout ?? process.stdout).write(`${text}\n`);
  const err = (text) => (io.stderr ?? process.stderr).write(`${text}\n`);
  const signals = io.signals ?? process;
  const platform = io.platform ?? process.platform;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`gate-clean: ${error.message}`);
    return 2;
  }
  const runner = io.run === undefined ? makeRunner() : { run: io.run, kill: () => undefined };
  const probe = io.probe ?? makeProbe(io.cpuSampleMs);
  const findSkill = io.findSkill ?? findSkillFolder;
  const listPython = io.listPython ?? listPythonFiles;

  let repo;
  try {
    repo = resolve(
      opts.repo ??
        execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: RUNTIME_ROOT, encoding: 'utf8' }).trim(),
    );
  } catch (error) {
    err(`gate-clean: not a git work tree: ${error.message}`);
    return 2;
  }
  const outDir = resolve(opts.out);
  const worktree = resolve(opts.worktree ?? join(dirname(repo), 'caw-qa-wt'));
  if (isInside(outDir, repo) || isInside(repo, outDir)) {
    err('gate-clean: --out must be outside the repository (the report must not dirty the tree it judges)');
    return 2;
  }
  if (
    isInside(worktree, repo) ||
    isInside(repo, worktree) ||
    isInside(outDir, worktree) ||
    isInside(worktree, outDir)
  ) {
    err('gate-clean: the worktree must be outside the repository and apart from --out');
    return 2;
  }
  mkdirSync(outDir, { recursive: true });

  const plan = planSteps({ ...opts, out: outDir });
  const state = {
    sha: undefined,
    timeScale: undefined,
    worktreeCreated: false,
    aborted: false,
    interrupted: false,
  };
  const result = {
    schema: REPORT_SCHEMA,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    commit: { ref: opts.ref, sha: undefined, treeClean: true, skill: null },
    tools: { platform: `${platform}-${process.arch}`, node: process.version },
    options: {
      workers: opts.workers,
      withDocker: opts.withDocker,
      skip: [...opts.skip],
      timeScale: undefined,
      keep: opts.keep,
    },
    machine: { start: undefined, end: undefined },
    steps: [],
    failedFiles: [],
    flakes: [],
    leaks: [],
    cleanup: { worktree, state: 'not created', drift: [] },
    interrupted: false,
    verdict: undefined,
  };

  const onSigint = () => {
    state.interrupted = true;
    err('gate-clean: interrupted, cleaning up');
    runner.kill();
  };
  signals.on('SIGINT', onSigint);

  const git = (args, cwd = repo, logFile) => runner.run({ tool: 'git', args, cwd, env: {}, logFile });

  async function snapshot() {
    const processes = await probe.processes();
    return {
      cpuPercent: undefined,
      freeMemMb: await probe.freeMemMb(),
      listeners: await probe.listeners(),
      counts: countProcesses(processes, worktree),
      tempFolders: await probe.tempFolders(),
    };
  }

  // ---- internal actions: each resolves to {ok, note?}
  const internal = {
    async preflight(logFile) {
      const notes = [];
      const sha = await git(['rev-parse', '--verify', '--quiet', `${opts.ref}^{commit}`], repo, logFile);
      if (sha.code !== 0) return { ok: false, note: `unknown ref ${opts.ref}` };
      state.sha = sha.text.trim().split(/\s+/)[0];
      result.commit.sha = state.sha;
      const status = await git(['status', '--porcelain', '--untracked-files=no'], repo, logFile);
      result.commit.treeClean = status.code === 0 && status.text.trim() === '';
      if (!nodeSupported(process.version))
        return { ok: false, note: `Node ${process.version} is outside engines.node` };
      for (const [name, tool, args] of [
        ['npm', 'npm', ['--version']],
        ['git', 'git', ['--version']],
      ]) {
        const version = await runner.run({ tool, args, cwd: repo, env: {}, logFile });
        result.tools[name] =
          version.code === 0
            ? version.text
                .trim()
                .split(/\r?\n/)
                .pop()
                .replace(/^git version /, '')
            : 'unknown';
      }
      const start = await snapshot();
      start.cpuPercent = await probe.cpu();
      result.machine.start = start;
      if (start.cpuPercent > CPU_SCALE_THRESHOLD) {
        state.timeScale = '2';
        result.options.timeScale = 2;
        notes.push(`CPU ${start.cpuPercent} percent: QA_TIME_SCALE=2`);
      }
      if (!result.commit.treeClean) return { ok: false, note: 'the tracked tree is not clean: commit or stash first' };
      return { ok: true, note: notes.join('; ') };
    },

    async worktree(logFile) {
      if (state.sha === undefined) return { ok: false, note: 'no commit resolved' };
      const listed = await git(['worktree', 'list', '--porcelain'], repo, logFile);
      const registered = listed.text
        .split(/\r?\n/)
        .some((line) => line.startsWith('worktree ') && samePath(line.slice(9), worktree));
      if (registered) await git(['worktree', 'remove', '--force', worktree], repo, logFile);
      if (existsSync(worktree)) {
        if (!registered && readdirSync(worktree).length > 0) {
          return { ok: false, note: `${worktree} exists and is not a worktree of this repository: remove it first` };
        }
        rmSync(worktree, { recursive: true, force: true });
      }
      await git(['worktree', 'prune'], repo, logFile);
      const added = await git(['worktree', 'add', '--detach', worktree, state.sha], repo, logFile);
      if (added.code !== 0) return { ok: false, note: `git worktree add failed (exit ${added.code})` };
      state.worktreeCreated = true;
      result.cleanup.state = 'created';
      result.commit.skill = findSkill(worktree);
      return { ok: true, note: result.commit.skill === null ? 'no skills/*/SKILL.md found' : '' };
    },

    async noPython() {
      const found = listPython(worktree);
      return {
        ok: found.length === 0,
        note: found.length === 0 ? '' : `Python files: ${found.slice(0, 5).join(', ')}`,
      };
    },

    async shotsIndex() {
      let index;
      try {
        index = JSON.parse(readFileSync(join(outDir, 'shots', 'index.json'), 'utf8'));
      } catch (error) {
        return { ok: false, note: `shots/index.json is unreadable: ${error.message}` };
      }
      const checked = checkShotsIndex(index);
      result.shotRecords = checked.records;
      return { ok: checked.ok, note: checked.problems.slice(0, 5).join('; '), records: checked.records };
    },

    async leaks() {
      const end = await snapshot();
      end.cpuPercent = await probe.cpu();
      result.machine.end = end;
      result.leaks = leakDelta(result.machine.start ?? { counts: {}, listeners: [], tempFolders: 0 }, end);
      const drift = await git(['status', '--porcelain', '--untracked-files=no'], worktree);
      result.cleanup.drift = drift.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const bad = result.leaks
        .filter((row) => row.delta !== 0)
        .map((row) => `${row.name} ${row.delta > 0 ? '+' : ''}${row.delta}`);
      const notes = [...bad];
      if (result.cleanup.drift.length > 0)
        notes.push(`${result.cleanup.drift.length} tracked file(s) changed by the run`);
      return { ok: notes.length === 0, note: notes.join('; ') };
    },
  };

  /** Runs one command action; returns `{code, text, ms}`. */
  async function command(step, action, logFile) {
    const env = { ...step.env, ...(state.timeScale === undefined ? {} : { QA_TIME_SCALE: state.timeScale }) };
    const cwd = action.cwd === 'runtime' ? join(worktree, 'runtime') : worktree;
    return runner.run({ tool: action.tool, args: action.args, cwd, env, logFile });
  }

  /** Runs the actions of a step once. Returns `{status, exitCode, note, text, counts, class, skippedActions}`. */
  async function runActions(step, logFile) {
    const outcome = { failed: false, exitCode: 0, notes: [], text: '', counts: {}, skippedActions: 0, ran: 0 };
    for (const action of step.actions) {
      writeFileSync(logFile, `--- ${describeAction(action)}\n`, { flag: 'a' });
      if (action.type === 'internal') {
        const answer = await internal[action.name](logFile);
        outcome.ran += 1;
        if (answer.note) outcome.notes.push(answer.note);
        if (answer.records !== undefined) outcome.counts.records = answer.records;
        if (!answer.ok) {
          outcome.failed = true;
          outcome.exitCode = 1;
          break;
        }
        continue;
      }
      const res = await command(step, action, logFile);
      outcome.text += `\n${res.text}`;
      outcome.ran += 1;
      const vitest = parseVitestSummaries(res.text);
      const first = vitest[0];
      if (first !== undefined && outcome.counts.tests === undefined) {
        outcome.counts.tests = first.tests;
        outcome.counts.files = first.files;
      }
      const playwright = parsePlaywrightSummary(res.text);
      if (playwright !== null) outcome.counts.playwright = playwright;
      if (res.code === SKIP_EXIT && action.skipOnExit77 && platform !== 'win32') {
        outcome.skippedActions += 1;
        outcome.notes.push(`${describeAction(action)}: SKIPPED off Windows`);
        if (action.tool === 'node' && action.args[0] === 'scripts/test-pty.mjs') break; // the soak has nothing to run either
        continue;
      }
      let failed = res.code !== 0;
      if (action.parse === 'ci') {
        const parsed = parseCiOutput(res.text);
        const verdict = evaluateCi(parsed, { platform });
        outcome.counts.ci = {
          total: parsed.rows.length,
          pass: parsed.rows.filter((row) => row.result === 'PASS').length,
        };
        if (!verdict.ok) {
          failed = true;
          outcome.notes.push(verdict.problems.slice(0, 4).join('; '));
        }
      }
      if (failed) {
        outcome.failed = true;
        outcome.exitCode = res.code === 0 ? 1 : res.code;
        if (res.code !== 0) outcome.notes.push(`${describeAction(action)}: exit ${res.code}`);
        if (!action.continueOnFailure) break;
      }
    }
    return outcome;
  }

  async function runStep(step) {
    const logFile = join(outDir, `${step.id}-${step.key}.log`);
    writeFileSync(logFile, '');
    const started = Date.now();
    let outcome = await runActions(step, logFile);
    const row = {
      id: step.id,
      key: step.key,
      title: step.title,
      optional: step.optional,
      log: `${step.id}-${step.key}.log`,
    };
    let failureClass;
    const failedFiles = [];
    if (outcome.failed) {
      failureClass = classifyFailure(outcome.text);
      const summary = parseVitestSummary(outcome.text);
      let allPassAlone = false;
      if (summary !== null && summary.failedFiles.length > 0) {
        let passed = 0;
        for (const failure of summary.failedFiles.slice(0, MAX_ALONE_FILES)) {
          const alone = await command(step, aloneAction(failure), logFile);
          const ok = alone.code === 0;
          if (ok) passed += 1;
          failedFiles.push({
            file: failure.file,
            step: step.id,
            class: classifyFailure(outcome.text),
            passesAlone: ok,
            owner: '',
          });
        }
        allPassAlone =
          passed === Math.min(summary.failedFiles.length, MAX_ALONE_FILES) &&
          summary.failedFiles.length <= MAX_ALONE_FILES;
      }
      // 4.5 item 3: every failed file passes alone, so it is a load or concurrency defect: run that project once more.
      if (step.project !== null && allPassAlone) {
        writeFileSync(logFile, `--- whole project again (the failed files passed alone)\n`, { flag: 'a' });
        const second = await runActions(step, logFile);
        if (!second.failed) {
          for (const f of failedFiles) result.flakes.push({ step: step.id, file: f.file, class: f.class });
          outcome = { ...second, notes: [...second.notes, 'flaky: green on the second whole run'] };
        } else {
          outcome = second;
        }
      }
    }
    result.failedFiles.push(...failedFiles);
    let status;
    if (outcome.failed) {
      status = step.reportOnly || (step.environmentIsReportOnly && failureClass === 'X') ? 'WARN' : 'FAIL';
    } else if (outcome.skippedActions > 0 && outcome.skippedActions === outcome.ran) {
      status = 'SKIPPED';
    } else {
      status = 'PASS';
    }
    return {
      ...row,
      status,
      exitCode: outcome.exitCode,
      ms: Date.now() - started,
      counts: Object.keys(outcome.counts).length === 0 ? undefined : outcome.counts,
      class: outcome.failed ? failureClass : undefined,
      note: outcome.notes.filter(Boolean).join('; '),
    };
  }

  let crash;
  try {
    for (const step of plan) {
      const base = { id: step.id, key: step.key, title: step.title, optional: step.optional, ms: 0 };
      if (state.interrupted) {
        result.steps.push({ ...base, status: 'NOT RUN', note: 'interrupted' });
        continue;
      }
      if (step.skipped !== null) {
        result.steps.push({ ...base, status: 'SKIPPED', note: step.skipped });
        out(`=== ${step.id} ${step.title}: SKIPPED (${step.skipped})`);
        continue;
      }
      if (state.aborted) {
        result.steps.push({ ...base, status: 'NOT RUN', note: 'an earlier step stopped the run' });
        continue;
      }
      out(`=== ${step.id} ${step.title}`);
      const done = await runStep(step);
      result.steps.push(done);
      out(`    ${done.status}${done.note ? ` (${done.note})` : ''}`);
      if (done.status === 'FAIL' && ['G0', 'G1', 'G2'].includes(step.id)) state.aborted = true;
    }
  } catch (error) {
    crash = error;
    err(`gate-clean: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signals.off('SIGINT', onSigint);
    // the end snapshot, when the leak step did not take one
    if (result.machine.end === undefined && result.machine.start !== undefined) {
      try {
        result.machine.end = await snapshot();
      } catch {
        // the snapshot is informative only
      }
    }
    if (state.worktreeCreated) {
      if (opts.keep) result.cleanup.state = 'kept (--keep)';
      else {
        await git(['worktree', 'remove', '--force', worktree]);
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
        await git(['worktree', 'prune']);
        result.cleanup.state = existsSync(worktree) ? 'removal failed: remove it by hand' : 'removed';
      }
    }
  }

  result.interrupted = state.interrupted;
  result.finishedAt = new Date().toISOString();
  result.verdict = crash === undefined ? verdictOf(result) : 'FAIL';
  writeFileSync(join(outDir, 'gate-report.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, 'gate-report.md'), renderReport(result));
  out('\n| step | gate | result | ms |\n|---|---|---|---|');
  for (const step of result.steps) out(`| ${step.id} | ${step.title} | ${step.status} | ${step.ms ?? 0} |`);
  out(`verdict: ${result.verdict}`);
  out(`report: ${join(outDir, 'gate-report.md')}`);
  if (state.interrupted) return 130;
  if (result.verdict === 'PASS') return 0;
  return result.verdict === 'INCOMPLETE' ? 3 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runGateClean(process.argv.slice(2));
}
