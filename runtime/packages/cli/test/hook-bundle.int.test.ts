// The install contract of the hook handler (ADR 0062 item 6) against a freshly built `mcs-hook.mjs` (never the tracked one):
// one spool line per payload, `MCS_HOOK_DISABLE=1` silent, a hard exit within the budget while stdin stays open, `--version`,
// exit 0 without output on junk input and on an unwritable `MCS_HOME`, and the same behaviour when the file is copied alone
// to another folder (what the hooks installer does). Every run uses a temp `MCS_HOME`; nothing touches real settings.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { HANDLER_HARD_EXIT_MS, HANDLER_VERSION, routeKey, type HookRouteV1 } from '@mcs/shared/protocol';
import { buildRepo, buildTaskWorkspace, hookPayload, useTempDirs } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const makeTemp = useTempDirs();
const PERF = Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1;
const LF = String.fromCharCode(10);
const SID = '11111111-2222-4333-8444-555555555555';
const INSTANCE = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';

let buildRoot = '';
let hookFile = '';
let aloneFile = '';

beforeAll(async () => {
  // the shared build outlives the per-test temp folders of useTempDirs
  buildRoot = mkdtempSync(join(tmpdir(), 'mcs-hook-bundle-'));
  const root = buildRoot;
  const bundleDir = join(root, 'bundle');
  await buildBundle({ outDir: bundleDir, entries: { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' }, web: false });
  hookFile = join(bundleDir, 'mcs-hook.mjs');
  mkdirSync(join(root, 'alone'));
  aloneFile = join(root, 'alone', 'mcs-hook.mjs');
  copyFileSync(hookFile, aloneFile);
}, 120_000);

afterAll(() => {
  if (buildRoot !== '') rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Raw {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
}

function runNode(
  entry: string,
  args: string[],
  opts: { env: Record<string, string>; stdin?: string; holdStdin?: boolean },
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--no-warnings', entry, ...args], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    if (opts.holdStdin !== true) child.stdin.end(opts.stdin);
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        wallMs: performance.now() - started,
      });
    });
  });
}

function envFor(mcsHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { TZ: 'UTC', MCS_HOME: mcsHome };
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

const fwd = (path: string): string => path.split(sep).join('/');

/** A temp `MCS_HOME` with one running route whose transcripts folder matches the payload. */
function setup(): { mcsHome: string; spoolDir: string; payload: string } {
  const root = makeTemp('hook-bundle-run').path;
  const { repo } = buildRepo(join(root, 'repo'));
  const workspace = fwd(buildTaskWorkspace(repo, { slug: 'task-a', config: {}, instance: { instanceId: INSTANCE } }));
  const transcriptsDir = fwd(join(root, 'claude', 'projects', 'proj'));
  mkdirSync(transcriptsDir, { recursive: true });
  const mcsHome = join(root, 'mcs-home');
  mkdirSync(join(mcsHome, 'routes'), { recursive: true });
  const route: HookRouteV1 = {
    v: 1,
    instanceId: INSTANCE,
    workspace,
    spoolDir: `${workspace}/data/spool`,
    stateFile: `${workspace}/state.json`,
    enabled: true,
    match: { transcriptsDirs: [routeKey(transcriptsDir)], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: Date.now(),
  };
  writeFileSync(join(mcsHome, 'routes', `${INSTANCE}.json`), JSON.stringify(route));
  const base = { sessionId: SID, cwd: fwd(repo), transcriptPath: `${transcriptsDir}/${SID}.jsonl` };
  return { mcsHome, spoolDir: route.spoolDir, payload: JSON.stringify(hookPayload('Stop', base)) };
}

function spoolLines(spoolDir: string): Record<string, unknown>[] {
  if (!existsSync(spoolDir)) return [];
  return readdirSync(spoolDir)
    .sort()
    .flatMap((name) => readFileSync(join(spoolDir, name), 'utf8').split(LF))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectSilentSuccess(result: Raw): void {
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
}

describe.each([
  ['the fresh bundle', () => hookFile],
  ['the file copied alone', () => aloneFile],
])('hook bundle install contract: %s', (_name, entryOf) => {
  it('writes one spool line for a payload', async () => {
    const s = setup();
    expectSilentSuccess(await runNode(entryOf(), ['--mcs-hook', 'Stop'], { env: envFor(s.mcsHome), stdin: s.payload }));
    const lines = spoolLines(s.spoolDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, session_id: SID });
  });

  it('MCS_HOOK_DISABLE=1: silent, nothing written', async () => {
    const s = setup();
    const env = envFor(s.mcsHome, { MCS_HOOK_DISABLE: '1' });
    expectSilentSuccess(await runNode(entryOf(), ['--mcs-hook', 'Stop'], { env, stdin: s.payload }));
    expect(existsSync(s.spoolDir)).toBe(false);
  });

  it('exits 0 within the hard-exit budget while stdin stays open', async () => {
    const s = setup();
    const result = await runNode(entryOf(), ['--mcs-hook', 'Stop'], { env: envFor(s.mcsHome), holdStdin: true });
    expectSilentSuccess(result);
    expect(result.wallMs).toBeLessThan((HANDLER_HARD_EXIT_MS + 300) * PERF);
  });

  it('--version prints HANDLER_VERSION', async () => {
    const s = setup();
    const result = await runNode(entryOf(), ['--version'], { env: envFor(s.mcsHome), stdin: '' });
    expect(result).toMatchObject({ code: 0, stdout: `${HANDLER_VERSION}${LF}`, stderr: '' });
  });

  it('junk input and an unwritable MCS_HOME: exit 0, no output', async () => {
    const s = setup();
    expectSilentSuccess(
      await runNode(entryOf(), ['--mcs-hook', 'Stop'], { env: envFor(s.mcsHome), stdin: '{not json' + LF }),
    );
    expect(spoolLines(s.spoolDir)).toHaveLength(0);
    const blocked = join(makeTemp('hook-bundle-file').path, 'mcs-home-is-a-file');
    writeFileSync(blocked, 'not a folder\n');
    expectSilentSuccess(await runNode(entryOf(), ['--mcs-hook', 'Stop'], { env: envFor(blocked), stdin: s.payload }));
  });
});
