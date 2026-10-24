// `export` through the real built CLI against a real instance (01 6.3, 6.4, T-CLI-13): the file is written only below the places the
// rules allow (never `*.jsonl` inside a workspace, never another task's folder or the Claude home), an existing file is kept without
// `--force`, the file re-read has the line count of the summary, the selectors narrow the export, `--include-content` is only ever
// given explicitly, and the running instance (API) and its stopped database (DB) write the same bytes except the time fields. All
// data is synthetic (the testkit demo); nothing outside the temp tree is read, and the real `~/.claude` is never touched.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CliEnvelopeSchema, ExportLineSchema, ExportResultSchema, routes, type CliEnvelope } from '@mcs/shared';
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
  type DemoLetter,
  type DemoResult,
  type StartedInstance,
} from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportLines } from '../src/commands/export.ts';

const temp = makeTempDir('export-int');
const SLUG = 'exportcmd';
const LETTERS: readonly DemoLetter[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(0x202e);
const BACKSLASH = String.fromCharCode(92);
const PROMPT_A = 'compile the backend and run the unit tests';
const FINAL_A = 'FIXTURE Backend compiles and all 214 unit tests pass. No untracked files.';

interface Live {
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly mcsHome: string;
  readonly demo: DemoResult;
  readonly started: StartedInstance;
  readonly workspace: string;
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

function describeCli(result: { code: number; stdout: string; stderr: string }): string {
  return `exit ${String(result.code)}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 600)}`;
}

function isSettled(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return false;
  return body.files.every(
    (file: unknown) =>
      typeof file === 'object' &&
      file !== null &&
      'behindBytes' in file &&
      file.behindBytes === 0 &&
      'state' in file &&
      file.state === 'active',
  );
}

async function startLive(): Promise<Live> {
  const root = temp.path;
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? path.join(root, 'mcs-home');
  for (const dir of [mcsHome, env['HOME'] ?? path.join(root, 'home')]) mkdirSync(dir, { recursive: true });
  const demo = await buildDemo({ root, nowMs: Date.now() - 60 * 60_000 });
  const mcs: Live['mcs'] = (args) => runCli([...args, '--repo', demo.repo], { mcsHome, env });
  const seed = {
    ...Object.fromEntries(
      Object.entries(demo.configJson).filter(
        ([key]) => !['limits', 'poll', 'docker', 'watched_processes'].includes(key),
      ),
    ),
    panels: { machine: false, git: false, logs: false, ledger: false, chain_log: false, attempts: false },
  };
  const seedFile = path.join(root, 'exportcmd.seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const port = await allocatePort();
  const init = await mcs(['init', '--name', 'Export', '--slug', SLUG, '--port', String(port), '--config', seedFile]);
  if (init.code !== 0) throw new Error(`init ${describeCli(init)}`);
  const other = await mcs(['init', '--name', 'Other', '--slug', 'other', '--port', String(await allocatePort())]);
  if (other.code !== 0) throw new Error(`init other ${describeCli(other)}`);
  const started = await startInstance({ repo: demo.repo, slug: SLUG, env }, { port });
  const get = async (urlPath: string): Promise<{ status: number; body: unknown }> => {
    const reply = await httpRequest(port, urlPath);
    try {
      return { status: reply.status, body: JSON.parse(reply.body) };
    } catch {
      return { status: reply.status, body: reply.body };
    }
  };
  await waitFor(
    async () => {
      const reply = await get(`${routes.listSessions.path}?limit=100&range=all&includeUnmatched=1`);
      const page = routes.listSessions.response.safeParse(reply.body);
      return reply.status === 200 && page.success && page.data.items.length >= LETTERS.length;
    },
    { what: `${String(LETTERS.length)} sessions in the list`, timeoutMs: 90_000, intervalMs: 250 },
  );
  await waitFor(
    async () => {
      for (const letter of LETTERS) {
        const reply = await get(`/api/v3/sessions/${demo.sessions[letter].sessionId}`);
        if (reply.status !== 200 || !isSettled(reply.body)) return false;
      }
      return true;
    },
    { what: 'every transcript file imported', timeoutMs: 90_000, intervalMs: 250 },
  );
  // the lifecycle sweeps add their evidence after the files are imported: wait until the change log stops growing
  let lastHead = -1;
  let quietSince = Date.now();
  await waitFor(
    async () => {
      const reply = await get(`${routes.listSessions.path}?limit=1`);
      const head = routes.listSessions.response.safeParse(reply.body);
      if (!head.success) return false;
      if (head.data.asOfSeq !== lastHead) {
        lastHead = head.data.asOfSeq;
        quietSince = Date.now();
      }
      return Date.now() - quietSince >= 2500;
    },
    { what: 'the change log to be quiet', timeoutMs: 60_000, intervalMs: 300 },
  );
  const workspace = path.join(demo.repo, '.claude', 'monitor', 'tasks', SLUG);
  return { repo: demo.repo, env, mcsHome, demo, started, workspace, mcs };
}

function envelopeOf(stdout: string): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(stdout));
}

function linesOf(file: string): unknown[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

function typesOf(file: string): string[] {
  return linesOf(file).map((line) => ExportLineSchema.parse(line).type);
}

/** The file with the fields that differ by design between two runs (the time fields of the header and the checksum that covers them) removed. */
function withoutTimes(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => {
      if (line.startsWith('{"type":"header"')) {
        return line.replace(/"exportedAt":"[^"]*"/, '"exportedAt":"-"').replace(/"to":"[^"]*"/, '"to":"-"');
      }
      if (line.startsWith('{"type":"trailer"')) return line.replace(/"sha256":"[0-9a-f]{64}"/, '"sha256":"-"');
      return line;
    })
    .join('\n');
}

// Each test spawns several CLI processes at about a second apiece, so the 10 s project default is too short.
describe('export over a real instance', { timeout: 120_000 }, () => {
  let live: Live;
  let outside: string;
  const idOf = (letter: DemoLetter): string => live.demo.sessions[letter].sessionId;
  const exportTo = (out: string, ...more: string[]): ReturnType<Live['mcs']> =>
    live.mcs(['export', '--task', SLUG, '--out', out, ...more]);
  const failure = async (out: string, ...more: string[]): Promise<{ code: number; error: string }> => {
    const run = await exportTo(out, ...more, '--json');
    return { code: run.code, error: envelopeOf(run.stdout).error?.code ?? 'none' };
  };
  const auditCode = async (): Promise<number> => (await live.mcs(['audit', '--task', SLUG])).code;
  beforeAll(async () => {
    live = await startLive();
    outside = path.join(temp.path, 'outside');
    mkdirSync(outside, { recursive: true });
  }, 240_000);
  afterAll(async () => {
    await killAllTracked();
    temp.remove();
  });

  describe('a good export', () => {
    it('writes logs/x.ndjson, prints the summary, and the workspace audit still passes', async () => {
      const auditBefore = await auditCode();
      const out = path.join(live.workspace, 'logs', 'x.ndjson');
      const run = await exportTo(out);
      expect(run.code, run.stderr).toBe(0);
      const lines = run.stdout.trimEnd().split('\n');
      expect(lines[0]).toMatch(/^exported \d+ lines \(\d+ bytes\) to .*x\.ndjson$/);
      expect(lines[1]).toMatch(/^sha256 [0-9a-f]{64} /);
      expect(run.stdout).toContain('metadata only: no prompt, reply, thinking or tool result text');
      expect(run.stdout).toContain('(read from the running instance)');
      expect(existsSync(out)).toBe(true);
      expect(readdirSync(path.join(live.workspace, 'logs')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      const types = typesOf(out);
      expect(types[0]).toBe('header');
      expect(types.at(-1)).toBe('trailer');
      expect(types.filter((type) => type === 'session')).toHaveLength(LETTERS.length);
      expect(types).not.toContain('transcript');
      expect(await auditCode()).toBe(0);
      expect(auditBefore).toBe(0);
      const audit = await live.mcs(['audit', '--task', SLUG]);
      expect(audit.stdout).not.toContain('jsonl');
    });

    it('the file re-read has the line count and size of the summary (--json)', async () => {
      const out = path.join(outside, 'json.ndjson');
      const run = await exportTo(out, '--json');
      expect(run.code, run.stderr).toBe(0);
      const data = ExportResultSchema.parse(envelopeOf(run.stdout).data);
      expect(data).toMatchObject({ task: SLUG, mode: 'api', replaced: false });
      expect(data.path.endsWith('json.ndjson')).toBe(true);
      expect(data.summary.lines).toBe(linesOf(out).length);
      expect(data.summary.bytes).toBe(statSync(out).size);
      expect(data.summary.includeContent).toBe(false);
      const trailer = ExportLineSchema.parse(linesOf(out).at(-1));
      expect(trailer).toMatchObject({ type: 'trailer', sha256: data.summary.sha256 });
    });

    it('data/backups of the exported task is allowed too', async () => {
      const backups = path.join(live.workspace, 'data', 'backups');
      mkdirSync(backups, { recursive: true });
      const run = await exportTo(path.join(backups, 'x.ndjson'));
      expect(run.code, run.stderr).toBe(0);
      expect(existsSync(path.join(backups, 'x.ndjson'))).toBe(true);
    });
  });

  describe('where it refuses to write', () => {
    it('a .jsonl name inside a workspace is OUTPUT_PATH_FORBIDDEN, and nothing is created', async () => {
      const before = snapshotTree(live.workspace, { exclude: ['logs/**', 'run/**', 'data/**', 'state.json'] });
      const out = path.join(live.workspace, 'logs', 'x.jsonl');
      expect(await failure(out)).toEqual({ code: 1, error: 'OUTPUT_PATH_FORBIDDEN' });
      expect(existsSync(out)).toBe(false);
      expect(existsSync(`${out}.tmp`)).toBe(false);
      const text = await exportTo(out);
      expect(text.code).toBe(1);
      expect(text.stderr).toContain('.ndjson');
      for (const upper of ['X.JSONL', 'x.JsonL']) {
        expect(await failure(path.join(live.workspace, 'logs', upper))).toEqual({
          code: 1,
          error: 'OUTPUT_PATH_FORBIDDEN',
        });
      }
      expect(snapshotTree(live.workspace, { exclude: ['logs/**', 'run/**', 'data/**', 'state.json'] })).toBe(before);
    });

    it('a .jsonl name outside every workspace is fine', async () => {
      const out = path.join(outside, 'free.jsonl');
      expect((await exportTo(out)).code).toBe(0);
      expect(existsSync(out)).toBe(true);
    });

    it('the rest of the workspace, another workspace and the tasks folder are forbidden', async () => {
      const tasks = path.join(live.repo, '.claude', 'monitor', 'tasks');
      for (const dir of [
        live.workspace,
        path.join(live.workspace, 'audit'),
        path.join(live.workspace, 'data'),
        path.join(tasks, 'other'),
        path.join(tasks, 'other', 'logs'),
        tasks,
      ]) {
        mkdirSync(dir, { recursive: true });
        expect(await failure(path.join(dir, 'x.ndjson')), dir).toEqual({ code: 1, error: 'OUTPUT_PATH_FORBIDDEN' });
        expect(existsSync(path.join(dir, 'x.ndjson')), dir).toBe(false);
      }
    });

    it('the Claude home is forbidden', async () => {
      const home = live.env['CLAUDE_CONFIG_DIR'] ?? '';
      mkdirSync(home, { recursive: true });
      expect(await failure(path.join(home, 'x.ndjson'))).toEqual({ code: 1, error: 'OUTPUT_PATH_FORBIDDEN' });
      expect(existsSync(path.join(home, 'x.ndjson'))).toBe(false);
    });

    it('a missing folder, a folder as the file and a path that climbs out of logs/ are forbidden', async () => {
      expect(await failure(path.join(outside, 'no', 'such', 'x.ndjson'))).toEqual({
        code: 1,
        error: 'OUTPUT_PATH_FORBIDDEN',
      });
      mkdirSync(path.join(outside, 'a-folder.ndjson'), { recursive: true });
      expect(await failure(path.join(outside, 'a-folder.ndjson'), '--force')).toEqual({
        code: 1,
        error: 'OUTPUT_PATH_FORBIDDEN',
      });
      const climbing = `${path.join(live.workspace, 'logs')}${path.sep}..${path.sep}x.ndjson`;
      expect(await failure(climbing)).toEqual({ code: 1, error: 'OUTPUT_PATH_FORBIDDEN' });
      expect(existsSync(path.join(live.workspace, 'x.ndjson'))).toBe(false);
    });

    it('an existing file is OUTPUT_EXISTS and kept; --force replaces it by rename', async () => {
      const out = path.join(outside, 'exists.ndjson');
      writeFileSync(out, 'OLD\n');
      expect(await failure(out)).toEqual({ code: 1, error: 'OUTPUT_EXISTS' });
      expect(readFileSync(out, 'utf8')).toBe('OLD\n');
      const run = await exportTo(out, '--force', '--json');
      expect(run.code, run.stderr).toBe(0);
      expect(ExportResultSchema.parse(envelopeOf(run.stdout).data).replaced).toBe(true);
      expect(typesOf(out)[0]).toBe('header');
      expect(readdirSync(outside).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('a leftover temp file blocks the run and is not touched', async () => {
      const out = path.join(outside, 'leftover.ndjson');
      writeFileSync(`${out}.tmp`, 'LEFTOVER');
      expect(await failure(out, '--force')).toEqual({ code: 1, error: 'OUTPUT_EXISTS' });
      expect(readFileSync(`${out}.tmp`, 'utf8')).toBe('LEFTOVER');
      expect(existsSync(out)).toBe(false);
    });
  });

  describe('what it exports', () => {
    it('--include-content with strict redaction is refused (usage, exit 2) before anything is written', async () => {
      const out = path.join(outside, 'strict.ndjson');
      expect(await failure(out, '--redaction', 'strict', '--include-content')).toEqual({ code: 2, error: 'USAGE' });
      const text = await exportTo(out, '--redaction', 'strict', '--include-content');
      expect(text.code).toBe(2);
      expect(text.stderr).toContain('--include-content');
      expect(existsSync(out)).toBe(false);
    });

    it('no transcript text unless --include-content is given, and no other flag implies it', async () => {
      const plain = path.join(outside, 'plain.ndjson');
      const flags = path.join(outside, 'flags.ndjson');
      expect((await exportTo(plain)).code).toBe(0);
      expect(
        (await exportTo(flags, '--redaction', 'standard', '--include', 'sessions,events,tool_calls,usage', '--force'))
          .code,
      ).toBe(0);
      for (const file of [plain, flags]) {
        const text = readFileSync(file, 'utf8');
        expect(text).not.toContain(PROMPT_A);
        expect(text).not.toContain(FINAL_A);
        expect(typesOf(file)).not.toContain('transcript');
        expect(ExportLineSchema.parse(linesOf(file)[0])).toMatchObject({ type: 'header', includeContent: false });
      }
      const content = path.join(outside, 'content.ndjson');
      const run = await exportTo(content, '--include-content', '--session', idOf('A'));
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain('contains transcript text: treat the file as confidential');
      expect(typesOf(content)).toContain('transcript');
      expect(readFileSync(content, 'utf8')).toContain(FINAL_A);
      expect(ExportLineSchema.parse(linesOf(content)[0])).toMatchObject({ type: 'header', includeContent: true });
    });

    it('--session narrows the export to the sessions named, and --include to the record types', async () => {
      const out = path.join(outside, 'one.ndjson');
      const run = await exportTo(out, '--session', idOf('A'), '--session', idOf('B'), '--include', 'sessions');
      expect(run.code, run.stderr).toBe(0);
      const types = typesOf(out);
      expect(types).toEqual(['header', 'session', 'session', 'trailer']);
      const ids = linesOf(out)
        .map((line) => ExportLineSchema.parse(line))
        .flatMap((line) => (line.type === 'session' ? [line.data.id] : []));
      expect(ids.sort()).toEqual([idOf('A'), idOf('B')].sort());
      expect(run.stdout).toContain('records: session 2');
    });

    it('--since and --until select a window; a window without data exports a header and a trailer', async () => {
      const empty = path.join(outside, 'empty.ndjson');
      const run = await exportTo(empty, '--since', '2020-01-01T00:00:00Z', '--until', '2020-01-02T00:00:00Z');
      expect(run.code, run.stderr).toBe(0);
      expect(typesOf(empty)).toEqual(['header', 'trailer']);
      expect(run.stdout).toContain('no records matched the selection');
      const recent = path.join(outside, 'recent.ndjson');
      expect((await exportTo(recent, '--since', '30d')).code).toBe(0);
      expect(typesOf(recent).filter((type) => type === 'session')).toHaveLength(LETTERS.length);
      const all = path.join(outside, 'all.ndjson');
      expect((await exportTo(all, '--since', 'all')).code).toBe(0);
    });

    it('a flag that does not parse is a usage error that names the flag', async () => {
      const out = path.join(outside, 'bad.ndjson');
      for (const more of [
        ['--since', 'yesterday'],
        ['--until', '2026-01-02T00:00:00Z'],
        ['--since', '2026-01-02T00:00:00Z', '--until', '2026-01-01T00:00:00Z'],
        ['--session', 'not-an-id'],
        ['--include', 'nothing'],
        ['--redaction', 'loose'],
        ['--format', 'csv'],
      ]) {
        const run = await exportTo(out, ...more);
        expect(run.code, more.join(' ')).toBe(2);
        expect(run.stderr, more.join(' ')).toMatch(/^ERROR: /);
      }
      expect(existsSync(out)).toBe(false);
    });
  });

  describe('the stopped instance', () => {
    it('writes the same bytes from the database as the running instance, except the time fields, and changes no data', async () => {
      const fromApi = path.join(outside, 'cmp-api.ndjson');
      const apiRun = await exportTo(fromApi);
      expect(apiRun.code, apiRun.stderr).toBe(0);
      await live.started.stop();
      const tree = snapshotTree(live.workspace, { exclude: ['logs/**', 'run/**', 'state.json'] });
      const fromDb = path.join(outside, 'cmp-db.ndjson');
      const dbRun = await exportTo(fromDb, '--json');
      expect(dbRun.code, dbRun.stderr).toBe(0);
      const data = ExportResultSchema.parse(envelopeOf(dbRun.stdout).data);
      expect(data.mode).toBe('db');
      expect(data.summary.lines).toBe(linesOf(fromDb).length);
      expect(data.summary.bytes).toBe(statSync(fromDb).size);
      expect(withoutTimes(fromDb)).toBe(withoutTimes(fromApi));
      const text = await exportTo(path.join(outside, 'db-text.ndjson'));
      expect(text.stdout).toContain('(read from the database (the monitor is not running))');
      // the rules and the refusals are the same without a running instance
      expect(await failure(path.join(live.workspace, 'logs', 'again.jsonl'))).toEqual({
        code: 1,
        error: 'OUTPUT_PATH_FORBIDDEN',
      });
      expect(snapshotTree(live.workspace, { exclude: ['logs/**', 'run/**', 'state.json'] })).toBe(tree);
      // the content export from the database
      const content = path.join(outside, 'db-content.ndjson');
      const withContent = await exportTo(content, '--include-content', '--session', idOf('A'));
      expect(withContent.code, withContent.stderr).toBe(0);
      expect(readFileSync(content, 'utf8')).toContain(FINAL_A);
    });
  });
});

// ---- rendering --------------------------------------------------------------------------------------------------------------------

describe('rendering', () => {
  const result = (
    over: Record<string, unknown> = {},
    pathText = '/tmp/x.ndjson',
  ): Parameters<typeof exportLines>[0] => ({
    task: 't',
    mode: 'db',
    path: pathText,
    summary: {
      lines: 12,
      bytes: 3456,
      sha256: 'a'.repeat(64),
      counts: { sessions: 3, events: 7, alerts: 0 },
      includeContent: false,
    },
    replaced: false,
    ...over,
  });

  it('names the file, the counts that are not zero, and whether the file holds text', () => {
    const lines = exportLines(result());
    expect(lines[0]).toBe('exported 12 lines (3456 bytes) to /tmp/x.ndjson');
    expect(lines[1]).toBe(
      `sha256 ${'a'.repeat(64)} (of every byte before the trailer line; the file was re-read and matches)`,
    );
    expect(lines[2]).toBe('records: sessions 3, events 7');
    expect(lines[3]).toBe('metadata only: no prompt, reply, thinking or tool result text');
    expect(lines[4]).toBe('(read from the database (the monitor is not running))');
    const withText = exportLines(
      result({ replaced: true, summary: { ...result().summary, includeContent: true, counts: {} } }),
    );
    expect(withText[0]).toContain('(replaced the existing file)');
    expect(withText[2]).toBe('no records matched the selection');
    expect(withText[3]).toBe('contains transcript text: treat the file as confidential');
  });

  it('escapes the control characters of a path', () => {
    const lines = exportLines(result({}, `/tmp/a${ESC}]52;c;ZXZpbA==${RLO}b\nc.ndjson`));
    expect(lines).toHaveLength(5);
    expect(lines[0]).not.toContain(ESC);
    expect(lines[0]).not.toContain(RLO);
    expect(lines[0]).toContain(`${BACKSLASH}u001b`);
    expect(lines[0]).toContain(`${BACKSLASH}u202e`);
  });
});
