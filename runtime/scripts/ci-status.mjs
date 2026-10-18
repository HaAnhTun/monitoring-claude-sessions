// The `ci-status` channel of the GitHub workflow (ADR 0065 item 3): CI results the lead reads with `git fetch`, no `gh` CLI.
//   node scripts/ci-status.mjs summarize [--in ci-summary.json] --out ci-job.json   one job record (env MCS_CI_JOB, _OS, _ARCH, _NODE, _JOB_STATUS)
//   node scripts/ci-status.mjs publish --dir <job records> [--remote <url|path>]   commits the run to the orphan branch `ci-status`
//   node scripts/ci-status.mjs read --sha <sha|HEAD> [--remote origin]             reads the local ref refs/remotes/<remote>/ci-status
// Exit codes: 0 ok / all green, 1 a job failed or the publish failed, 2 refused or usage error, 3 no result yet (read).
// `publish` runs only inside GitHub Actions with the workflow token (GITHUB_TOKEN), or against a local path or file:// remote
// (tests). Every git call carries `-c credential.helper=` and GIT_TERMINAL_PROMPT=0, so no credential store and no prompt is ever
// used; the token travels in an `http.extraheader` set through the environment (never in a URL, argv or log line); no force-push.
// `read` never fetches: run `git fetch origin ci-status` first. Zero dependencies.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BRANCH = 'ci-status';
export const TAIL_LINES = 40;
const MAX_LINE = 400;
const PUBLISH_ATTEMPTS = 5;
const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

// ---- sanitizing -----------------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // an authorization header: everything after it on the line
  [/(authorization["']?\s*[:=]\s*).*/gi, '$1***'],
  // GitHub tokens (classic, OAuth, app, refresh, fine-grained)
  [/(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g, '***'],
  // credentials in URLs
  [/([a-z][a-z0-9+.-]*:[/][/])[^\s/@]+@/gi, '$1***@'],
  // key/value forms: "token=xyz", "bearer xyz", "password: xyz"
  [
    /((?:bearer|basic|x-access-token|token|password|passwd|secret|api[_-]?key)["']?(?:\s*[:=]\s*|\s+)["']?)[^\s"']+/gi,
    '$1***',
  ],
  // long opaque strings with letters and digits (base64, hex): hashes are lost too, which is acceptable in a tail
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*[0-9])(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, '***'],
];

/** Drops control characters (ANSI colour codes included), masks anything that looks like a credential, bounds the length. */
export function sanitizeLine(line) {
  let text = '';
  for (const char of String(line)) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9) text += ' ';
    else if (code >= 32 && code !== 127) text += char;
  }
  // what is left of an ANSI colour sequence once its escape character is gone
  text = text.replace(/\[[0-9;]*m/g, '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}...` : text;
}

/** At most TAIL_LINES sanitized lines (the last ones). */
export function sanitizeTail(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(-TAIL_LINES).map((line) => sanitizeLine(line));
}

function shortText(value, max = 80) {
  return typeof value === 'string' ? sanitizeLine(value).slice(0, max) : null;
}

const RESULTS = new Set(['pass', 'fail', 'skipped', 'not-run', 'cancelled', 'unknown']);

function cleanResult(value) {
  return typeof value === 'string' && RESULTS.has(value) ? value : 'unknown';
}

function cleanGates(gates) {
  if (!Array.isArray(gates)) return [];
  return gates.slice(0, 50).map((gate) => ({
    name: shortText(gate?.name) ?? '?',
    result: cleanResult(gate?.result),
    ms: Number.isFinite(gate?.ms) ? Math.max(0, Math.round(gate.ms)) : 0,
  }));
}

/** Normalizes a job record from an artifact (it may be poisoned: every field is bounded and the tail re-sanitized). */
export function cleanJob(record) {
  return {
    name: shortText(record?.name) ?? '?',
    os: shortText(record?.os, 40),
    arch: shortText(record?.arch, 20),
    node: shortText(record?.node, 20),
    result: cleanResult(record?.result),
    gates: cleanGates(record?.gates),
    failedGate: shortText(record?.failedGate),
    tail: sanitizeTail(record?.tail),
  };
}

// ---- summarize ------------------------------------------------------------------------------------------------------

const JOB_STATUS = { success: 'pass', failure: 'fail', cancelled: 'cancelled' };

/** One job record from the `mcs.ci-run/1` summary of `ci.mjs --summary-json` (optional) and the job status of the runner. */
export function summarize(summary, env) {
  const status = JOB_STATUS[env.MCS_CI_JOB_STATUS ?? ''] ?? 'unknown';
  let result = status;
  if (summary !== undefined) {
    result = summary.result === 'pass' ? 'pass' : 'fail';
    if (status === 'fail' || status === 'cancelled') result = status;
  }
  return cleanJob({
    name: env.MCS_CI_JOB,
    os: env.MCS_CI_OS,
    arch: env.MCS_CI_ARCH,
    node: env.MCS_CI_NODE,
    result,
    gates: summary?.gates,
    failedGate: summary?.failedGate,
    tail: summary?.tail,
  });
}

// ---- argument parsing -----------------------------------------------------------------------------------------------

function options(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '') ?? '';
    if (!known.includes(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      throw new Error(`unknown or incomplete option ${argv[i]}`);
    }
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

// ---- git ------------------------------------------------------------------------------------------------------------

/** Runs git with the credential store disabled and prompts off. `ctx.header` (publish in Actions) goes in through the environment. */
function git(ctx, args, extra = {}) {
  const env = { ...ctx.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...extra.env };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  if (ctx.header !== undefined) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = ctx.header;
  }
  const argv = ['-c', 'credential.helper=', ...args];
  const viaNode = /[.]m?js$/.test(ctx.gitBin);
  const result = spawnSync(viaNode ? process.execPath : ctx.gitBin, viaNode ? [ctx.gitBin, ...argv] : argv, {
    cwd: extra.cwd ?? ctx.cwd,
    env,
    input: extra.input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitOk(ctx, args, extra) {
  const result = git(ctx, args, extra);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split(LF).slice(-3).map(sanitizeLine).join(' | ');
    throw new Error(`git ${args[0]} failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout.trim();
}

/** 'local' (a path or file://), 'https', or 'other' (ssh, scp-like, http, git://). */
export function remoteKind(remote) {
  if (/^file:[/][/]/i.test(remote)) return 'local';
  if (/^https:[/][/]/i.test(remote)) return 'https';
  if (/^[a-z][a-z0-9+.-]*:[/][/]/i.test(remote)) return 'other';
  if (/^[A-Za-z]:/.test(remote) && (remote[2] === '/' || remote[2] === BACKSLASH)) return 'local';
  const colon = remote.indexOf(':');
  const slash = remote.search(/[/]/);
  const back = remote.indexOf(BACKSLASH);
  if (colon !== -1 && (slash === -1 || colon < slash) && (back === -1 || colon < back)) return 'other';
  return 'local';
}

// ---- publish --------------------------------------------------------------------------------------------------------

function listJsonFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listJsonFiles(path));
    else if (name.endsWith('.json')) out.push(path);
  }
  return out;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function publish(argv, ctx) {
  const opts = options(argv, ['dir', 'remote']);
  const { env } = ctx;
  if (opts.dir === undefined) throw new Error('publish needs --dir <job records>');
  const given =
    opts.remote ??
    (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}.git` : '');
  if (given === '') throw new Error('publish needs --remote (or GITHUB_SERVER_URL and GITHUB_REPOSITORY)');
  const kind = remoteKind(given);
  const inActions = env.GITHUB_ACTIONS === 'true';
  const token = env.GITHUB_TOKEN ?? '';
  if (kind === 'other' || /^https:[/][/][^/]*@/i.test(given)) {
    ctx.stderr.write('ci-status: refused: publish uses an https remote without credentials or a local path only\n');
    return 2;
  }
  if (kind === 'https' && !(inActions && token !== '')) {
    ctx.stderr.write(
      'ci-status: refused: publishing to a network remote runs only inside GitHub Actions with GITHUB_TOKEN ' +
        '(local credentials are never used)\n',
    );
    return 2;
  }
  // git runs in a temporary store, so a relative path remote is resolved against the caller's folder
  const remote = kind === 'local' && !/^file:/i.test(given) ? resolve(ctx.cwd, given) : given;
  const sha = env.GITHUB_SHA ?? '';
  const runId = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) || !/^[0-9]{1,20}$/.test(runId) || !/^[0-9]{1,5}$/.test(attempt)) {
    throw new Error('publish needs GITHUB_SHA (full hex), GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT (digits)');
  }
  const jobDir = resolve(ctx.cwd, opts.dir);
  // no records at all (every job cancelled or broken before its summary) publishes a failed run with no jobs
  const jobs = (existsSync(jobDir) ? listJsonFiles(jobDir) : []).map((file) =>
    cleanJob(JSON.parse(readFileSync(file, 'utf8'))),
  );
  jobs.sort((a, b) => `${a.name} ${a.os} ${a.node}`.localeCompare(`${b.name} ${b.os} ${b.node}`));
  const result =
    jobs.length > 0 && jobs.every((job) => job.result === 'pass' || job.result === 'skipped') ? 'pass' : 'fail';
  const run = {
    schema: 'mcs.ci-status/1',
    sha,
    ref: shortText(env.GITHUB_REF, 200),
    runId,
    runAttempt: attempt,
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
        ? shortText(`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`, 300)
        : null,
    finishedAt: new Date().toISOString(),
    result,
    jobs,
  };
  const runPath = `runs/${sha}/${runId}-${attempt}.json`;
  const runText = `${JSON.stringify(run, null, 2)}${LF}`;
  const latestText = `${JSON.stringify({ sha, runId, result }, null, 2)}${LF}`;
  const gitCtx = {
    ...ctx,
    header:
      inActions && token !== ''
        ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
        : undefined,
  };
  const work = mkdtempSync(join(tmpdir(), 'mcs-ci-status-'));
  try {
    gitOk(gitCtx, ['init', '-q', '--bare', work]);
    const local = { cwd: work, env: { GIT_INDEX_FILE: join(work, 'mcs-index') } };
    const ident = {
      GIT_AUTHOR_NAME: 'mcs-ci-status',
      GIT_AUTHOR_EMAIL: '',
      GIT_COMMITTER_NAME: 'mcs-ci-status',
      GIT_COMMITTER_EMAIL: '',
    };
    for (let i = 1; i <= PUBLISH_ATTEMPTS; i += 1) {
      const heads = gitOk(gitCtx, ['ls-remote', '--heads', remote, `refs/heads/${BRANCH}`], local);
      const parent = heads === '' ? undefined : heads.split(/\s/)[0];
      if (parent !== undefined) {
        gitOk(gitCtx, ['fetch', '-q', '--no-tags', remote, `refs/heads/${BRANCH}`], local);
        gitOk(gitCtx, ['read-tree', parent], local);
      } else {
        gitOk(gitCtx, ['read-tree', '--empty'], local);
      }
      for (const [path, text] of [
        [runPath, runText],
        ['latest.json', latestText],
      ]) {
        const blob = gitOk(gitCtx, ['hash-object', '-w', '--stdin'], { ...local, input: text });
        gitOk(gitCtx, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], local);
      }
      const tree = gitOk(gitCtx, ['write-tree'], local);
      const commit = gitOk(
        gitCtx,
        [
          'commit-tree',
          tree,
          ...(parent === undefined ? [] : ['-p', parent]),
          '-m',
          `ci-status: ${sha} run ${runId}-${attempt} ${result}`,
        ],
        { ...local, env: { ...local.env, ...ident } },
      );
      const pushed = git(gitCtx, ['push', '-q', remote, `${commit}:refs/heads/${BRANCH}`], local);
      if (pushed.code === 0) {
        ctx.stdout.write(`ci-status: published ${runPath} (${result})\n`);
        return 0;
      }
      ctx.stderr.write(`ci-status: push attempt ${i} rejected, retrying on the newer branch\n`);
      sleep(200 * i + Math.floor(Math.random() * 300));
    }
    ctx.stderr.write(`ci-status: publish failed after ${PUBLISH_ATTEMPTS} attempts\n`);
    return 1;
  } catch (error) {
    ctx.stderr.write(
      `ci-status: publish failed: ${sanitizeLine(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- read -----------------------------------------------------------------------------------------------------------

function read(argv, ctx) {
  const opts = options(argv, ['sha', 'remote']);
  const remoteName = opts.remote ?? 'origin';
  if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) throw new Error('--remote must be a remote name');
  let sha = opts.sha ?? 'HEAD';
  if (sha === 'HEAD') sha = gitOk(ctx, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error('--sha must be HEAD or a full commit hash');
  const ref = `refs/remotes/${remoteName}/${BRANCH}`;
  if (git(ctx, ['rev-parse', '--verify', '-q', ref]).code !== 0) {
    ctx.stdout.write(`ci-status: no ${ref} yet (run: git fetch ${remoteName} ${BRANCH})\n`);
    return 3;
  }
  // --full-tree: without it git reads the path relative to the caller's subfolder (read runs from runtime/).
  const listing = git(ctx, ['ls-tree', '--full-tree', '--name-only', ref, `runs/${sha}/`]);
  const runs = listing.stdout
    .split(LF)
    .map((line) => line.trim())
    .map((line) => /^runs[/][0-9a-f]+[/]([0-9]+)-([0-9]+)[.]json$/.exec(line))
    .filter((match) => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]));
  const last = runs.at(-1);
  if (last === undefined) {
    ctx.stdout.write(`ci-status: no result for ${sha.slice(0, 12)} yet (fetch again in a minute)\n`);
    return 3;
  }
  const run = JSON.parse(gitOk(ctx, ['show', `${ref}:${last[0]}`]));
  ctx.stdout.write(`ci-status: ${sha.slice(0, 12)} run ${last[1]}-${last[2]}: ${run.result}\n`);
  for (const job of Array.isArray(run.jobs) ? run.jobs.map(cleanJob) : []) {
    const where = [job.os, job.arch, job.node && `node ${job.node}`].filter(Boolean).join(', ');
    ctx.stdout.write(`  ${job.name} (${where}): ${job.result}${job.failedGate ? ` at ${job.failedGate}` : ''}\n`);
  }
  return run.result === 'pass' ? 0 : 1;
}

// ---- entry ----------------------------------------------------------------------------------------------------------

/** `io` replaces the process parts in the tests (`gitBin` a `.mjs` path runs with this Node: the fake git). */
export function main(argv, io = {}) {
  const ctx = {
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    gitBin: io.gitBin ?? 'git',
  };
  const [command, ...rest] = argv;
  try {
    if (command === 'summarize') {
      const opts = options(rest, ['in', 'out']);
      if (opts.out === undefined) throw new Error('summarize needs --out <file>');
      const input = opts.in === undefined ? undefined : resolve(ctx.cwd, opts.in);
      const summary = input !== undefined && existsSync(input) ? JSON.parse(readFileSync(input, 'utf8')) : undefined;
      const record = summarize(summary, ctx.env);
      const target = resolve(ctx.cwd, opts.out);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(record, null, 2)}${LF}`);
      ctx.stdout.write(`ci-status: ${record.name} ${record.result}\n`);
      return 0;
    }
    if (command === 'publish') return publish(rest, ctx);
    if (command === 'read') return read(rest, ctx);
    throw new Error('usage: ci-status.mjs summarize|publish|read [options]');
  } catch (error) {
    ctx.stderr.write(`ci-status: ${sanitizeLine(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
