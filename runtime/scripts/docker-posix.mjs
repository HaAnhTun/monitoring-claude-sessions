// Docker POSIX harness (ADR 0065 item 4, V4 decision 8). Streams a clean source tree into throw-away labelled containers and runs
// the CI gates inside as the unprivileged `node` user. No host folder is ever mounted; only containers carrying this run's label
// are removed. Run it under the `docker` lock of the plan.
// Usage: npm run docker:posix -- [--targets node22,node24,node26,alpine24,floor] [--platform amd64|arm64|all] [--quick]
//        [--ref <git ref> | --worktree] [--bundle] [--out <dir>] [--keep] [--no-build] [--prune [--images]] [--dry-run]
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_TARGETS,
  HARNESS_LABEL,
  RUN_LABEL_KEY,
  SUMMARY_SCHEMA,
  TARGETS,
  buildArgs,
  dockerfileFor,
  expandRuns,
  gatesFor,
  imageTag,
  listContainersArgs,
  listImagesArgs,
  parseGateTables,
  runArgs,
  targetKey,
} from './docker-posix-plan.mjs';
import { createWorktreeTar, listWorktreeFiles, repoRoot } from './docker-posix-tar.mjs';
import { RUNTIME_ROOT } from './lib.mjs';

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = {
    targets: DEFAULT_TARGETS,
    platform: 'amd64',
    quick: false,
    ref: undefined,
    worktree: false,
    bundle: false,
    out: undefined,
    keep: false,
    prune: false,
    images: false,
    noBuild: false,
    dryRun: false,
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
      case '--targets':
        opts.targets = value(i, arg)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--platform':
        opts.platform = value(i, arg);
        i += 1;
        break;
      case '--ref':
        opts.ref = value(i, arg);
        i += 1;
        break;
      case '--out':
        opts.out = value(i, arg);
        i += 1;
        break;
      case '--repo':
        opts.repo = value(i, arg);
        i += 1;
        break;
      case '--quick':
        opts.quick = true;
        break;
      case '--worktree':
        opts.worktree = true;
        break;
      case '--bundle':
        opts.bundle = true;
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--images':
        opts.images = true;
        break;
      case '--no-build':
        opts.noBuild = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  const unknown = opts.targets.filter((t) => !Object.hasOwn(TARGETS, t));
  if (unknown.length > 0 || opts.targets.length === 0) {
    throw new UsageError(
      `unknown target: ${unknown.join(', ') || '(none)'}; known: ${Object.keys(TARGETS).join(', ')}`,
    );
  }
  if (!['amd64', 'arm64', 'all'].includes(opts.platform))
    throw new UsageError('--platform must be amd64, arm64 or all');
  if (opts.worktree && opts.ref !== undefined) throw new UsageError('--worktree and --ref are mutually exclusive');
  if (opts.worktree && opts.bundle) {
    throw new UsageError('--bundle is for --ref runs only: the committed bundle of a working tree is stale by design');
  }
  if (opts.images && !opts.prune) throw new UsageError('--images only goes with --prune');
  if (!opts.worktree && opts.ref === undefined) opts.ref = 'HEAD';
  return opts;
}

/** `io.dockerBin` replaces the docker command in the tests (a `.mjs`/`.js` path runs with this Node: the fake docker). */
function dockerCommand(bin, args) {
  return /\.m?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

/** Runs one docker command. `input` is a string, a Buffer or a Readable for stdin; `sink` receives stdout and stderr. */
function runDocker(ctx, args, { input, sink, onChild } = {}) {
  return new Promise((resolvePromise) => {
    const [cmd, cmdArgs] = dockerCommand(ctx.dockerBin, args);
    let child;
    try {
      child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: ctx.vars });
    } catch (error) {
      resolvePromise({ code: 127, out: '', missing: true, error });
      return;
    }
    onChild?.(child);
    const chunks = [];
    const collect = (chunk) => {
      chunks.push(chunk);
      sink?.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    // The container may exit before it has read the whole tar: an EPIPE on stdin is not an error of the harness.
    child.stdin.on('error', () => undefined);
    let missing = false;
    child.on('error', (error) => {
      missing = error.code === 'ENOENT';
    });
    child.on('close', (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 130 : 1), out: Buffer.concat(chunks).toString('utf8'), missing });
    });
    if (input === undefined) child.stdin.end();
    else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
    else {
      input.on('error', (error) => {
        sink?.write(`harness: source stream failed: ${error.message}\n`);
        child.stdin.destroy();
      });
      input.pipe(child.stdin);
    }
  });
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function resolveRef(repo, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitArchive(repo, sha) {
  const child = spawn('git', ['archive', '--format=tar', sha], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return child.stdout;
}

function describePlan(opts, runs, source) {
  const lines = [`docker-posix plan (dry run): source ${source}`];
  for (const run of runs) {
    const key = targetKey(run.target, run.platform);
    lines.push(
      `- ${key}: ${TARGETS[run.target].base} linux/${run.platform} -> ${imageTag(run.target, run.platform)}${run.quick ? ' (quick)' : ''}`,
    );
    if (TARGETS[run.target].floor) lines.push(`    gates: launcher --version expects the floor message and exit 1`);
    else
      lines.push(
        `    gates: ${gatesFor({ quick: run.quick, bundle: opts.bundle })
          .map(([, c]) => c)
          .join(' ; ')}`,
      );
    lines.push(`    docker ${buildArgs(run.target, run.platform).join(' ')}   (only when the image is missing)`);
    const args = runArgs({ runId: '<run id>', ...run, bundle: opts.bundle, keep: opts.keep });
    lines.push(`    docker ${args.slice(0, -1).join(' ')} <script>`);
  }
  lines.push('nothing was started (dry run)');
  return lines.join('\n');
}

async function removeByLabel(ctx, label, log) {
  const listed = await runDocker(ctx, listContainersArgs(label));
  const ids = listed.out.split(/\s+/).filter((id) => /^[0-9a-f]{6,64}$/i.test(id));
  if (ids.length === 0) return 0;
  log(`removing ${ids.length} container(s) labelled ${label}`);
  await runDocker(ctx, ['rm', '-f', ...ids]);
  return ids.length;
}

/** Runs the harness; resolves to the exit code (0 all passed, 1 a target failed, 2 usage or environment, 130 interrupted). */
export async function runHarness(argv, io = {}) {
  const ctx = { vars: io.env ?? process.env, dockerBin: io.dockerBin ?? 'docker' };
  const out = (text) => (io.stdout ?? process.stdout).write(`${text}\n`);
  const err = (text) => (io.stderr ?? process.stderr).write(`${text}\n`);
  const signals = io.signals ?? process;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`docker-posix: ${error.message}`);
    return 2;
  }
  let repo;
  try {
    repo = resolve(opts.repo ?? repoRoot(RUNTIME_ROOT));
  } catch (error) {
    err(`docker-posix: not a git work tree: ${error.message}`);
    return 2;
  }
  const runs = expandRuns(opts);

  let sha;
  if (!opts.prune && opts.ref !== undefined) {
    sha = resolveRef(repo, opts.ref);
    if (sha === undefined) {
      err(`docker-posix: unknown git ref: ${opts.ref}`);
      return 2;
    }
  }
  const sourceText = opts.worktree ? 'working tree snapshot' : `git archive ${opts.ref} (${sha})`;
  if (opts.dryRun) {
    out(describePlan(opts, runs, opts.prune ? 'none (prune)' : sourceText));
    return 0;
  }

  const version = await runDocker(ctx, ['version', '--format', '{{.Server.Version}}']);
  if (version.missing || version.code === 127) {
    err('docker-posix: the docker command was not found on PATH; install Docker first');
    return 2;
  }
  if (version.code !== 0) {
    err(`docker-posix: docker is installed but the daemon did not answer (exit ${version.code})`);
    return 2;
  }

  if (opts.prune) {
    const removed = await removeByLabel(ctx, HARNESS_LABEL, out);
    let images = 0;
    if (opts.images) {
      const listed = await runDocker(ctx, listImagesArgs());
      const ids = [...new Set(listed.out.split(/\s+/).filter((id) => /^(sha256:)?[0-9a-f]{6,64}$/i.test(id)))];
      if (ids.length > 0) await runDocker(ctx, ['rmi', ...ids]);
      images = ids.length;
    }
    out(`docker-posix: pruned ${removed} container(s)${opts.images ? ` and ${images} image(s)` : ''}`);
    return 0;
  }

  let files;
  if (opts.worktree) {
    try {
      files = listWorktreeFiles(repo);
      createWorktreeTar(repo, files).destroy(); // validates every path and size before anything starts
    } catch (error) {
      err(`docker-posix: ${error.message}`);
      return 2;
    }
  }

  const runId = newRunId();
  const outDir = resolve(opts.out ?? join(RUNTIME_ROOT, '.dev', 'docker-posix', runId));
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let interrupted = false;
  let current;
  const onSigint = () => {
    interrupted = true;
    err('docker-posix: interrupted, cleaning up this run only');
    current?.kill();
  };
  signals.on('SIGINT', onSigint);

  const results = [];
  try {
    for (const run of runs) {
      if (interrupted) break;
      const key = targetKey(run.target, run.platform);
      const tag = imageTag(run.target, run.platform);
      const logFile = join(outDir, `${key}.log`);
      const log = createWriteStream(logFile);
      const started = Date.now();
      out(`=== ${key} (${tag}, linux/${run.platform}${run.quick ? ', quick' : ''})`);
      log.write(`target ${key}\nimage ${tag}\nbase ${TARGETS[run.target].base}\nsource ${sourceText}\n\n`);
      const record = {
        target: run.target,
        platform: run.platform,
        key,
        image: tag,
        quick: run.quick,
        log: `${key}.log`,
      };

      let failure;
      const inspect = await runDocker(ctx, ['image', 'inspect', '--format', '{{.Id}}', tag]);
      if (inspect.code !== 0) {
        if (opts.noBuild) failure = 'image missing and --no-build was given';
        else {
          log.write(`--- docker ${buildArgs(run.target, run.platform).join(' ')}\n`);
          const build = await runDocker(ctx, buildArgs(run.target, run.platform), {
            input: dockerfileFor(run.target, run.platform),
            sink: log,
            onChild: (child) => (current = child),
          });
          if (build.code !== 0) failure = `image build failed (exit ${build.code})`;
        }
      }
      let code = 1;
      let text = '';
      if (failure === undefined && !interrupted) {
        const input = opts.worktree ? createWorktreeTar(repo, files) : gitArchive(repo, sha);
        const result = await runDocker(ctx, runArgs({ runId, ...run, bundle: opts.bundle, keep: opts.keep }), {
          input,
          sink: log,
          onChild: (child) => (current = child),
        });
        code = result.code;
        text = result.out;
      }
      current = undefined;
      const tables = parseGateTables(text);
      const gates = tables.at(-1) ?? [];
      const result = interrupted
        ? 'INTERRUPTED'
        : failure !== undefined
          ? `FAIL (${failure})`
          : code === 0
            ? 'PASS'
            : `FAIL (exit ${code})`;
      log.write(`\nresult ${result}\n`);
      await new Promise((r) => log.end(r));
      Object.assign(record, { result, exitCode: failure === undefined ? code : null, ms: Date.now() - started, gates });
      if (tables.length > 1) record.innerGates = tables.at(-2);
      results.push(record);
      out(`    ${result}`);
    }
  } finally {
    signals.off('SIGINT', onSigint);
    if (!opts.keep) await removeByLabel(ctx, `${RUN_LABEL_KEY}=${runId}`, out);
  }

  const passed = !interrupted && results.length === runs.length && results.every((r) => r.result === 'PASS');
  const summary = {
    schema: SUMMARY_SCHEMA,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: opts.worktree ? { kind: 'worktree', files: files.length } : { kind: 'ref', ref: opts.ref, sha },
    bundle: opts.bundle,
    kept: opts.keep,
    result: interrupted ? 'interrupted' : passed ? 'pass' : 'fail',
    targets: results,
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  out('\n| target | result | ms |\n|---|---|---|');
  for (const r of results) out(`| ${r.key} | ${r.result} | ${r.ms} |`);
  out(`summary: ${join(outDir, 'summary.json')}`);
  if (opts.keep) out(`kept containers: docker ps -a --filter label=${RUN_LABEL_KEY}=${runId}`);
  if (interrupted) return 130;
  return passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runHarness(process.argv.slice(2));
}
