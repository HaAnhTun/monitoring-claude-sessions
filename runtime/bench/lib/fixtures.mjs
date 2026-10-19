// Synthetic fixtures of the benchmarks: a temp root with a hermetic environment, a fake Claude home with N sessions (the eight
// demo sessions plus small ones), one session with a long transcript for the transcript page, a repo with a chain log and a
// ledger, and a writer for the big transcript of B4. The builders come from the built testkit (`@mcs/testkit`, whose `dist` the
// gate builds first). Everything is labelled FIXTURE and lives under a temp folder.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadTestkit, runNode } from './target.mjs';

const SESSION_WINDOW_MS = 60 * 60 * 1000;
const PAGE_EVENT_PAIRS = 150;

/** A deterministic UUID-shaped id from a label. */
export function fixtureId(label) {
  const hex = createHash('sha256').update(`mcs-bench:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The panels the benchmark turns on: the sources a fixture can feed without a git repository. */
const PANELS = { machine: true, git: false, logs: true, ledger: true, chain_log: true, attempts: true };

/**
 * Builds the fixture. `sessions` is the number of sessions in the window (at least the 8 of the demo). Resolves
 * `{ root, env, repo, slug, claudeHome, projectDir, pageSessionId, sessionCount, init, writeBig, dispose }`:
 *  - `init(launcher, port)` runs `init` for the task `bench` with the fixture config;
 *  - `writeBig(mb)` writes a transcript of that many MiB into the project folder (written under a temp name, then renamed, so the
 *    importer never sees a half-written file) and resolves `{ sessionId, bytes, writeMs }`;
 *  - `dispose()` removes the temp root.
 */
export async function buildFixture({ sessions = 100 } = {}) {
  const tk = await loadTestkit();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcs-bench-')));
  const nowMs = Date.now();
  const env = { ...tk.hermeticEnv(root), MCS_LAUNCHER_MODE: 'bundle' };
  for (const key of ['HOME', 'MCS_HOME']) mkdirSync(env[key], { recursive: true });
  const demo = await tk.buildDemo({ root, nowMs });
  tk.writeFixtureMarker(root);

  // the long session first: its transcript page (250 events) is a B5 endpoint
  const pageSessionId = fixtureId('page-session');
  const extra = Math.max(0, sessions - 8);
  for (let index = 0; index < extra; index += 1) {
    const sessionId = index === 0 ? pageSessionId : fixtureId(`small-${String(index)}`);
    const startMs = nowMs - SESSION_WINDOW_MS + index * 1000;
    const builder = new tk.TranscriptBuilder({ sessionId, cwd: demo.repo, startMs });
    const pairs = index === 0 ? PAGE_EVENT_PAIRS : 2;
    for (let pair = 0; pair < pairs; pair += 1) {
      builder.user(`FIXTURE bench prompt ${String(pair)}`);
      builder.assistant({
        messageId: `msg_fixture_bench_${String(index)}_${String(pair)}`,
        text: `FIXTURE bench answer ${String(pair)}`,
      });
    }
    const file = join(demo.projectDir, `${sessionId}.jsonl`);
    builder.write(file);
    const at = new Date(nowMs - index * 1000);
    utimesSync(file, at, at);
  }

  const configPath = join(root, 'bench.config.json');
  // the demo config narrows the event window below the floor of the runtime; the benchmark keeps the defaults
  const demoConfig = { ...demo.configJson };
  delete demoConfig.limits;
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...demoConfig, title: 'FIXTURE bench monitor', window_hours: 24, panels: PANELS }, null, 2)}\n`,
  );

  const bigSessionId = fixtureId('big-session');
  const fixture = {
    root,
    env,
    repo: demo.repo,
    slug: 'bench',
    claudeHome: demo.claudeHome,
    projectDir: demo.projectDir,
    pageSessionId,
    bigSessionId,
    sessionCount: 8 + extra,
    async init(launcher, port) {
      const run = await runNode(
        launcher,
        [
          'init',
          '--name',
          'FIXTURE bench',
          '--slug',
          'bench',
          '--repo',
          demo.repo,
          '--port',
          String(port),
          '--config',
          configPath,
        ],
        { env, cwd: root, timeoutMs: 60_000 },
      );
      if (run.code !== 0)
        throw new Error(`init exited ${String(run.code)}: ${(run.stderr || run.stdout).trim().split('\n')[0] ?? ''}`);
    },
    dispose() {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    },
    writeBig(mb) {
      const started = performance.now();
      const targetBytes = Math.round(mb * 1024 * 1024);
      const builder = tk.bigTranscript({ sessionId: bigSessionId, targetBytes });
      const temp = join(demo.projectDir, 'bench-big.tmp');
      builder.write(temp);
      const bytes = statSync(temp).size;
      renameSync(temp, join(demo.projectDir, `${bigSessionId}.jsonl`));
      return { sessionId: bigSessionId, bytes, writeMs: performance.now() - started };
    },
  };
  return fixture;
}
