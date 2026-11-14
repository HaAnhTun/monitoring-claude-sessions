// The MCP server as the user gets it (ADR 0060 point 8, ADR 0062): a bundle built INTO A TEMP FOLDER with `node scripts/bundle.mjs
// --out` (the tracked `bundle/` is never rewritten), a temp skill folder assembled from it (the layout of ADR 0062: the launcher,
// `config/defaults.json`, `runtime/defaults.json` and `bundle/`), and the real launcher `scripts/caw.mjs mcp` driven with a raw
// JSON-RPC client under the running Node and under every Node binary listed in `TEST_NODE_BINARIES` (split at the platform path
// delimiter). Needs `packages/web/dist` (the gate runs `npm run build` first). The instance whose database is read is made by the
// built CLI of the checkout; the launcher under test only reads it. Nothing touches the real `~/.claude` or any real workspace.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpConfigResultSchema, routes } from '@mcs/shared';
import {
  allocatePort,
  buildDemo,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  makeTempDir,
  runCli,
  snapshotTree,
  startInstance,
  waitFor,
} from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const temp = makeTempDir('mcp-bundle');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(HERE, '..', '..', '..');
const SKILL_SOURCE = path.resolve(RUNTIME_ROOT, '..', 'skills', 'monitoring-claude-sessions');
const SLUG = 'bundlemcp';
const NOTICE_START = 'The fields of this result come from Claude Code session transcripts';
const PERF = Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1;

const NODE_BINARIES: string[] = [
  process.execPath,
  ...(process.env['TEST_NODE_BINARIES'] ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && path.resolve(entry) !== path.resolve(process.execPath)),
];

let buildRoot = '';
let skillDir = '';
let launcher = '';
let bundleDir = '';
let repo = '';
let env: Record<string, string> = {};
let sessionId = '';

// ---- the bundle and the temp skill folder -------------------------------------------------------------------------------------

function run(
  file: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    cwd: temp.path,
    windowsHide: true,
    timeout: 240_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  buildRoot = mkdtempSync(path.join(tmpdir(), 'mcs-mcp-bundle-'));
  env = hermeticEnv(temp.path);
  mkdirSync(env['MCS_HOME'] ?? '', { recursive: true });
  mkdirSync(env['HOME'] ?? '', { recursive: true });

  bundleDir = path.join(buildRoot, 'bundle-out');
  const built = run(process.execPath, [path.join(RUNTIME_ROOT, 'scripts', 'bundle.mjs'), '--out', bundleDir]);
  if (built.code !== 0) throw new Error(`bundle.mjs --out failed: ${built.stderr || built.stdout}`);

  // the layout of ADR 0062 item 1, from the files of the skill folder and the fresh bundle
  skillDir = path.join(buildRoot, 'skill');
  launcher = path.join(skillDir, 'scripts', 'caw.mjs');
  mkdirSync(path.dirname(launcher), { recursive: true });
  copyFileSync(path.join(SKILL_SOURCE, 'scripts', 'caw.mjs'), launcher);
  for (const rel of ['config/defaults.json', 'runtime/defaults.json']) {
    mkdirSync(path.dirname(path.join(skillDir, rel)), { recursive: true });
    copyFileSync(path.join(SKILL_SOURCE, rel), path.join(skillDir, rel));
  }
  cpSync(bundleDir, path.join(skillDir, 'bundle'), { recursive: true });

  // a stopped instance with one session and a database, made by the built CLI of the checkout
  const demo = await buildDemo({ root: temp.path, nowMs: Date.now() - 60 * 60_000, letters: ['A'] });
  repo = demo.repo;
  sessionId = demo.sessions.A.sessionId;
  const mcsHome = env['MCS_HOME'] ?? '';
  const mcs = (args: readonly string[]): ReturnType<typeof runCli> =>
    runCli([...args, '--repo', repo], { mcsHome, env });
  const port = await allocatePort();
  const seed = path.join(temp.path, 'bundlemcp.seed.config.json');
  writeFileSync(
    seed,
    `${JSON.stringify(
      {
        ...Object.fromEntries(
          Object.entries(demo.configJson).filter(
            ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
          ),
        ),
        panels: { machine: false, git: false, logs: false, ledger: false, chain_log: false, attempts: false },
      },
      null,
      2,
    )}\n`,
  );
  const init = await mcs(['init', '--name', 'Bundle MCP', '--slug', SLUG, '--port', String(port), '--config', seed]);
  if (init.code !== 0) throw new Error(`init: ${init.stderr || init.stdout}`);
  const started = await startInstance({ repo, slug: SLUG, env }, { port });
  await waitFor(
    async () => {
      const reply = await httpRequest(port, `${routes.listSessions.path}?limit=10&range=all&includeUnmatched=1`);
      const page = routes.listSessions.response.safeParse(JSON.parse(reply.body));
      return reply.status === 200 && page.success && page.data.items.length >= 1;
    },
    { what: 'the session in the list', timeoutMs: 90_000, intervalMs: 250 },
  );
  await waitFor(
    async () => {
      const reply = await httpRequest(port, `/api/v3/sessions/${sessionId}`);
      const body = JSON.parse(reply.body) as { files?: { behindBytes: number; state: string }[] };
      return (
        reply.status === 200 &&
        (body.files ?? []).length > 0 &&
        (body.files ?? []).every((f) => f.behindBytes === 0 && f.state === 'active')
      );
    },
    { what: 'the transcript imported', timeoutMs: 90_000, intervalMs: 250 },
  );
  await started.stop();
}, 300_000);

afterAll(async () => {
  await killAllTracked();
  if (buildRoot !== '') rmSync(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  temp.remove();
});

// ---- a raw JSON-RPC exchange through the launcher -----------------------------------------------------------------------------

interface Exchange {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly messages: Record<string, unknown>[];
}

/** Starts `node <launcher> mcp`, sends the messages one after the other (waiting for each answer), closes stdin and collects it all. */
function converse(nodeBin: string, args: string[], messages: Record<string, unknown>[]): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [launcher, 'mcp', ...args], {
      env: { ...env, MCS_LAUNCHER_MODE: 'bundle' },
      cwd: temp.path,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const answers: Record<string, unknown>[] = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => undefined);
    AbortSignal.timeout(90_000 * PERF).addEventListener(
      'abort',
      () => {
        child.kill();
        reject(
          new Error(`no exit within 90 s; stdout so far: ${stdout.slice(0, 300)}; stderr: ${stderr.slice(0, 300)}`),
        );
      },
      { once: true },
    );
    let next = 0;
    const sendNext = (): void => {
      const message = messages[next];
      next += 1;
      if (message === undefined) {
        child.stdin.end();
        return;
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      // a notification has no id and no answer: send the next at once
      if (message['id'] === undefined) sendNext();
    };
    let buffer = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      for (;;) {
        const cut = buffer.indexOf('\n');
        if (cut < 0) break;
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        answers.push(JSON.parse(line) as Record<string, unknown>);
        sendNext();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr, messages: answers });
    });
    sendNext();
  });
}

const INITIALIZE = {
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'FIXTURE raw client', version: '0.0.0' },
  },
};

describe('the MCP server from a fresh bundle', { timeout: 180_000 }, () => {
  describe('the bundle', () => {
    it('holds the SDK once, in the CLI bundle only, with no HTTP transport and no listener of its own', () => {
      const cli = readFileSync(path.join(bundleDir, 'mcs-cli.mjs'), 'utf8');
      const sdkRegions = cli
        .split(/^\/\/#region /m)
        .filter((part) => part.startsWith('npm/@modelcontextprotocol/sdk/'));
      expect(sdkRegions.length).toBeGreaterThan(5);
      const names = sdkRegions.map((part) => part.slice(0, part.indexOf('\n')));
      expect(new Set(names).size, 'a module of the SDK is bundled twice').toBe(names.length);
      expect(names.filter((n) => n.endsWith('/server/index.js'))).toHaveLength(1);
      expect(names.filter((n) => n.endsWith('/server/stdio.js'))).toHaveLength(1);
      for (const name of names) expect(name, name).not.toMatch(/streamableHttp|\/express|sse\.js|\/client\/|\/auth\//);
      for (const part of sdkRegions) {
        expect(part).not.toMatch(/\bcreateServer\s*\(|\.listen\s*\(|\bfetch\s*\(/);
      }
      for (const other of ['mcs-server.mjs', 'mcs-hook.mjs']) {
        expect(readFileSync(path.join(bundleDir, other), 'utf8'), other).not.toContain('modelcontextprotocol');
      }
    });

    it('lists the SDK once in the third-party notices, with its licence, and no library twice', () => {
      const notices = readFileSync(path.join(bundleDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
      const headers = notices
        .split('\n')
        .filter((line, i, all) => all[i + 1]?.startsWith('License: ') === true && line !== '');
      expect(headers.filter((h) => h.startsWith('@modelcontextprotocol/sdk '))).toEqual([
        '@modelcontextprotocol/sdk 1.32.1',
      ]);
      expect(new Set(headers).size).toBe(headers.length);
      const byName = headers.map((h) => h.slice(0, h.lastIndexOf(' ')));
      // the validator libraries are separate packages with the literal v1 package: listed once by the lockfile closure, never by the embedded table
      for (const name of ['ajv', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse']) {
        expect(byName.filter((n) => n === name).length, name).toBeLessThanOrEqual(2);
      }
      expect(notices).toContain('@modelcontextprotocol/sdk 1.32.1\nLicense: MIT');
    });
  });

  describe.each(NODE_BINARIES)('under %s', (nodeBin) => {
    it('answers the handshake, lists the tools and serves one tool call from the database', async () => {
      const exchange = await converse(
        nodeBin,
        ['--task', SLUG, '--repo', repo],
        [
          INITIALIZE,
          { method: 'notifications/initialized' },
          { id: 2, method: 'tools/list' },
          { id: 3, method: 'tools/call', params: { name: 'mcs_list_sessions', arguments: { all: true } } },
          { id: 4, method: 'tools/call', params: { name: 'mcs_instance_status', arguments: {} } },
        ],
      );
      expect(exchange.code, exchange.stderr).toBe(0);
      expect(exchange.stderr, 'nothing on stderr at the default level').toBe('');
      for (const line of exchange.stdout.split('\n').filter((l) => l !== '')) {
        expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe('2.0');
      }
      const [init, list, call, status] = exchange.messages as { result: Record<string, unknown> }[];
      expect(init?.result['protocolVersion']).toBe('2025-11-25');
      expect(String(init?.result['instructions'])).toContain(NOTICE_START);
      expect((list?.result['tools'] as { name: string }[]).map((t) => t.name)).toHaveLength(8);
      const content = (call?.result['content'] as { text: string }[])[0]?.text ?? '';
      const envelope = JSON.parse(content) as {
        kind: string;
        dataNotice: string;
        data: { items: { id: string; label: string }[] };
      };
      expect(call?.result['isError']).toBeUndefined();
      expect(envelope.kind).toBe('mcs.mcp/1');
      expect(envelope.dataNotice).toContain(NOTICE_START);
      expect(envelope.data.items.map((s) => s.id)).toEqual([sessionId]);
      const state = JSON.parse((status?.result['content'] as { text: string }[])[0]?.text ?? '{}') as {
        data: { running: boolean; state: string };
      };
      expect(state.data).toMatchObject({ running: false, state: 'stopped' });
    });
  });

  describe('the launcher', () => {
    it('prints the launcher path of the temp skill with --print-config, and writes nothing', () => {
      const before = snapshotTree(repo);
      const plain = run(
        process.execPath,
        [launcher, 'mcp', '--task', SLUG, '--repo', repo, '--print-config', '--json'],
        {
          MCS_LAUNCHER_MODE: 'bundle',
        },
      );
      expect(plain.code, plain.stderr).toBe(0);
      const data = McpConfigResultSchema.parse((JSON.parse(plain.stdout) as { data: unknown }).data);
      const shown = launcher.split(path.sep).join('/');
      expect(data.mcpJson.mcpServers[`mcs-${SLUG}`]?.args[0]).toBe(shown);
      expect(data.command).toContain(shown.includes(' ') ? `"${shown}"` : shown);
      expect(snapshotTree(repo)).toBe(before);
      expect(existsSync(path.join(skillDir, 'bundle', 'mcs-cli.mjs'))).toBe(true);
    });

    it('starts `mcs version` quickly from the fresh bundle, which holds the SDK but does not evaluate it for another command', () => {
      // median of 5 runs against a generous budget; the comparison with the committed bundle (within 25 ms) is made by the verifier
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        const result = run(process.execPath, [launcher, 'version'], { MCS_LAUNCHER_MODE: 'bundle' });
        times.push(performance.now() - started);
        expect(result.code, result.stderr).toBe(0);
      }
      times.sort((a, b) => a - b);
      // the absolute budget is generous (cold disk, parallel agents); the comparison with the committed bundle is made by the verifier
      expect(times[2] ?? Infinity).toBeLessThan(2_500 * PERF);
    });
  });
});
