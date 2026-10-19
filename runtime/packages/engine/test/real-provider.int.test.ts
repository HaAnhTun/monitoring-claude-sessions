// The opt-in test against the real product (ADR 0070 item 6, ADR 0014): one `claude -p` run with the hook entries of the installer
// in a temporary settings file, and the proof that its hook handler wrote a line to the spool of a temporary instance. It is
// skipped unless `MCS_E2E_CLAUDE=1`, because it costs tokens and needs the real login of the person who runs it; only the lead runs
// it, with the owner's consent (plan section 13.2, M4 step 2).
//
// What is real: the `claude` program, its authentication (it keeps the real HOME, the one allowed access to the real `~/.claude`;
// `--setting-sources local` and `--no-session-persistence` make it read no settings file of the user and write no transcript).
// What is temporary: the settings file (built by the installer), `MCS_HOME`, the working folder and the instance workspace. The
// environment of the child has `MCS_HOOK_DISABLE` removed (the Vitest setup sets it for every test) and carries
// `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HooksApplyResultSchema } from '@mcs/shared';
import { waitFor } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';
import { applyHooks } from '../src/hooks/installer/apply.ts';
import { writeRouteFile } from '../src/ingest/routes-file.ts';
import { claudeHomeOf } from '../src/ingest/transcripts/discovery.ts';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const ENABLED = process.env['MCS_E2E_CLAUDE'] === '1';
const INSTANCE_ID = '0e2e0e2e-0e2e-4e2e-8e2e-0e2e0e2e0e2e'; // FIXTURE instance id
const RUN_TIMEOUT_MS = 180_000;
const SPOOL_WAIT_MS = 5_000;

let root = '';

beforeAll(() => {
  if (ENABLED) root = mkdtempSync(path.join(tmpdir(), 'mcs-real-provider-'));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The program and arguments of one non-interactive run; on Windows `claude` may be a `.cmd` shim, which needs a shell. */
function runClaude(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn('claude', windows ? args.map((a) => JSON.stringify(a)) : [...args], {
      cwd,
      env,
      shell: windows,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code });
    });
  });
}

/** Every line of every spool segment of the workspace. */
function spoolLines(spool: string): string[] {
  try {
    return readdirSync(spool)
      .filter((name) => name.endsWith('.ndjson'))
      .flatMap((name) => readFileSync(path.join(spool, name), 'utf8').split('\n'))
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

describe.skipIf(!ENABLED)(
  'real provider: one claude -p run reaches the spool (opt-in: set MCS_E2E_CLAUDE=1; costs tokens and uses the real login)',
  () => {
    it(
      'writes a hook envelope to the spool of a temporary instance within 5 s of the run',
      async () => {
        // the hook handler of the current sources, as the installer copies it
        const bundle = path.join(root, 'bundle');
        await buildBundle({ outDir: bundle, entries: { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' }, web: false });
        const mcsHome = path.join(root, 'mcs-home');
        const work = path.join(root, 'work');
        const workspace = path.join(root, 'workspace');
        const spool = path.join(workspace, 'data', 'spool');
        mkdirSync(work, { recursive: true });
        mkdirSync(spool, { recursive: true });

        // the settings file is built by the installer, in test mode, below the temporary folder
        const settings = path.join(root, 'settings.json');
        const installed = await applyHooks({
          scope: 'file',
          settingsPath: settings,
          mcsHome,
          env: { MCS_TEST: '1', MCS_HOME: mcsHome },
          yes: true,
          source: path.join(bundle, 'mcs-hook.mjs'),
          nodePath: process.execPath,
        });
        expect(HooksApplyResultSchema.parse(installed.result).action).toBe('applied');

        // the route that sends the events of the working folder to the temporary workspace
        await writeRouteFile(
          {
            instanceId: INSTANCE_ID,
            instanceDir: workspace,
            mcsHome,
            repoDir: work,
            hooksEnabled: true,
            sessionIds: [],
            transcriptsDir: null,
            projectsRoot: path.join(claudeHomeOf(process.env), 'projects'),
          },
          { stoppedAt: null },
        );

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          MCS_HOME: mcsHome,
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
        // the Vitest setup disables the handler for every test; this one needs it on
        delete env['MCS_HOOK_DISABLE'];
        const run = await runClaude(
          [
            '-p',
            'Reply with the single word ok.',
            '--settings',
            settings,
            '--setting-sources',
            'local',
            '--no-session-persistence',
          ],
          work,
          env,
        );
        expect(run.code, 'claude exited with an error: is it installed and logged in?').toBe(0);

        await waitFor(() => spoolLines(spool).length > 0, {
          what: 'a hook envelope in the spool',
          timeoutMs: SPOOL_WAIT_MS,
          intervalMs: 100,
        });
        const first = JSON.parse(spoolLines(spool)[0] ?? '{}') as { instance_id?: string; v?: number };
        expect(first.v).toBe(1);
        expect(first.instance_id).toBe(INSTANCE_ID);
      },
      RUN_TIMEOUT_MS + SPOOL_WAIT_MS + 120_000,
    );
  },
);
