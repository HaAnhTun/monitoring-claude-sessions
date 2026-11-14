// The pty gate (design 08 section 4.1): the real-terminal tests (project `pty`) and, with `--e2e`, the terminal browser run. Zero
// dependencies, like smoke.mjs. Terminals are Windows-only in this release (spec Q1): elsewhere the gate prints why and exits 77, the
// code that `ci.mjs` shows as SKIPPED (and `ci --strict` fails). On Windows the run is REQUIRED (`QA_PTY_REQUIRED=1`): it fails on a
// failed test, on any skipped test, and on fewer distinct test ids than the ratchet `MIN_PTY_TESTS`.
// Usage: node scripts/test-pty.mjs [--e2e] [--json-out <file>] [vitest arguments, for example a file filter]
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RUNTIME_ROOT, binPath, runNode } from './lib.mjs';

/** The exit code of "cannot run here" (the one `ci.mjs` shows as SKIPPED). */
export const SKIP_EXIT = 77;

/**
 * The ratchet: the fewest distinct test ids the pty project must run. It only ever goes up: every package that adds a `*.pty.test.ts`
 * file raises it in the same commit, so a deleted or silently excluded file turns the gate red. It starts at 0 so the gate is green
 * before the first pty file exists; the final gate sets it to the count of the first complete run, never below the count of the
 * pty-marked ids of the matrix in docs/testing.md.
 */
export const MIN_PTY_TESTS = 0;

const E2E_CONFIG = 'packages/web/e2e/terminal/playwright.config.ts';
const TEST_ID = /\bTC-[A-Z]+-\d+\b/;

/** Where the pty tests may run: Windows on x64 or arm64 (the platform of the native module, spec Q1). */
export function decide(platform, arch) {
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return { run: true };
  return {
    run: false,
    exitCode: SKIP_EXIT,
    message: `test:pty: SKIPPED on ${platform}-${arch}: terminals are Windows-only in this release (spec Q1)`,
  };
}

/**
 * The tests of a vitest JSON report as `{key, name, file, title, status}`. `key` is the distinct id the ratchet counts: the `TC-...`
 * id of the title when there is one (several rows of one test share it), else the file and the full name. `name` is always the
 * file and the full name (what the soak tallies).
 */
export function readPtyReport(report, base) {
  const tests = [];
  for (const file of report?.testResults ?? []) {
    const shown = base === undefined ? file.name : relative(base, file.name).replaceAll('\\', '/');
    for (const test of file.assertionResults ?? []) {
      const title = test.fullName ?? test.title ?? '';
      const name = `${shown}::${title}`;
      const id = TEST_ID.exec(title)?.[0];
      tests.push({ key: id ?? name, name, file: shown, title, status: test.status });
    }
  }
  return tests;
}

/** Judges the tests of a run: a failure, a skipped, pending or todo test, or fewer distinct ids than `min` fails it. */
export function judgePtyReport(tests, { min }) {
  const failed = tests.filter((t) => t.status === 'failed').length;
  const skipped = tests.filter((t) => t.status !== 'passed' && t.status !== 'failed').length;
  const ran = new Set(tests.map((t) => t.key)).size;
  const reasons = [];
  if (failed > 0) reasons.push(`${failed} failed`);
  if (skipped > 0) reasons.push(`${skipped} skipped (a skipped test fails the gate: QA_PTY_REQUIRED=1)`);
  if (ran < min) reasons.push(`only ${ran} of at least ${min} distinct test ids ran (the ratchet MIN_PTY_TESTS)`);
  return { ok: reasons.length === 0, ran, failed, skipped, reasons };
}

function parseArgs(argv) {
  const opts = { e2e: false, jsonOut: undefined, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--e2e') opts.e2e = true;
    else if (arg === '--json-out') {
      opts.jsonOut = argv[i + 1];
      i += 1;
    } else opts.rest.push(arg);
  }
  return opts;
}

/** Runs the gate; resolves to the exit code (0 green, 1 red, 77 cannot run here). `io` replaces the environment in the tooling test. */
export async function runPtyGate(argv, io = {}) {
  const out = (text) => (io.stdout ?? process.stdout).write(`${text}\n`);
  const err = (text) => (io.stderr ?? process.stderr).write(`${text}\n`);
  const cwd = io.cwd ?? RUNTIME_ROOT;
  const opts = parseArgs(argv);
  const decision = decide(io.platform ?? process.platform, io.arch ?? process.arch);
  if (!decision.run) {
    out(decision.message);
    return decision.exitCode;
  }
  const env = { ...(io.env ?? process.env), QA_PTY_REQUIRED: '1' };

  if (opts.e2e) {
    if (!existsSync(join(cwd, E2E_CONFIG))) {
      err(`test:e2e:terminal: ${E2E_CONFIG} does not exist yet`);
      return 1;
    }
    const bin = io.playwrightBin ?? binPath('@playwright/test', 'playwright');
    const code = await runNode(bin, ['test', '-c', E2E_CONFIG, ...opts.rest], { cwd, env });
    return code === 0 ? 0 : 1;
  }

  const dir = mkdtempSync(join(tmpdir(), 'mcs-test-pty-'));
  const reportFile = join(dir, 'report.json');
  try {
    const bin = io.vitestBin ?? binPath('vitest');
    const code = await runNode(
      bin,
      [
        'run',
        '--project',
        'pty',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportFile}`,
        '--passWithNoTests',
        ...opts.rest,
      ],
      { cwd, env },
    );
    if (!existsSync(reportFile)) {
      err(`test:pty: FAIL (vitest exit ${code} and no JSON report was written)`);
      return 1;
    }
    if (opts.jsonOut !== undefined) copyFileSync(reportFile, opts.jsonOut);
    const tests = readPtyReport(JSON.parse(readFileSync(reportFile, 'utf8')), cwd);
    const min = io.minTests ?? MIN_PTY_TESTS;
    const judged = judgePtyReport(tests, { min });
    if (code !== 0) judged.reasons.push(`vitest exit ${code}`);
    out(`test:pty: ${judged.ran} distinct ids, ${judged.failed} failed, ${judged.skipped} skipped (floor ${min})`);
    if (judged.reasons.length === 0) return 0;
    err(`test:pty: FAIL (${judged.reasons.join('; ')})`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runPtyGate(process.argv.slice(2));
}
