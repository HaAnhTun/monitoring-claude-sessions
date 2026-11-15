// The opt-in probe of the REAL `claude` (CAW design 03 8 and A3, ADR 0090). It is skipped unless `CAW_REAL_CLAUDE=1`, it is never part
// of `npm test` or of CI (no project of `vitest.config.ts` includes `*.live.test.ts`), and the lead runs it once by hand. It exists
// because the link reads the registry that Claude Code writes (`<claude home>/sessions/<pid>.json`) and three things about it
// are not known from the one survey that exists: whether `startedAt` is the start of the process or of the session, what `procStart`
// is, and whether `-n <token>` shows up as the `name` of the entry. It also settles three assumptions of the design: the registry pid
// is equal to the root pid of the terminal or a descendant of it, `/clear` rewrites the session id of the SAME pid, and
// `--resume <id>` keeps the id.
//
// What it does, with the real terminal service (the same node-pty backend as the product) in a throw-away folder:
//   1. starts `claude`, waits for its registry entry, records the SHAPE of the entry and the relation of its pid to the root pid;
//   2. types `/clear` (a local command: it costs no tokens) and records whether the same pid got a new session id;
//   3. starts `claude -n <token>` and records whether `name` equals the token;
//   4. only with `CAW_REAL_CLAUDE_PROMPT=1`: sends one tiny prompt (a few tokens are billed) so that a transcript exists, ends the
//      process, resumes the session with `--resume <id>` and records whether the id and the start time stay.
// `CAW_REAL_CLAUDE_TRUST=1` presses Enter once at the start of each session, to accept the "trust this folder" question of a folder
// Claude Code has never seen (this writes the throw-away folder into the user's Claude configuration: off by default).
//
// The report is ONE line on stdout, `CAW_LINK_PROBE {json}`: key names, kinds of values, times in milliseconds and the few enumerated
// values (`status`, `kind`, `entrypoint`). It never holds a session id, a folder, a `name`, a prompt or any terminal content.
// Record it in ADR 0090 and keep the fake claude of the testkit consistent with it.
//
// Run it (no project includes the file, so give vitest a throw-away config that does; the real Claude home and the real PATH are used):
//   CAW_REAL_CLAUDE=1 npx vitest run --config <config> packages/engine/test/link-real-claude.live.test.ts
// with a config that holds `{ ssr: { resolve: { conditions: ['@mcs/source'] } }, test: { include: ['packages/engine/test/link-real-claude.live.test.ts'],
// pool: 'forks', testTimeout: 240000, hookTimeout: 60000 } }`.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { TerminalSectionSchema, folderPathKey } from '@mcs/shared';
import { makeTempDir, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { listRegistryEntries, type RegistryEntry } from '../src/external/registry.ts';
import { claudeHomeOf, projectFolderName } from '../src/ingest/transcripts/discovery.ts';
import { listDescendantPids, pidAlive } from '../src/platform/process.ts';
import {
  createDefaultTerminalService,
  type SessionInfo,
  type TerminalService,
  type Viewer,
} from '../src/terminal/index.ts';

const ENABLED = process.env['CAW_REAL_CLAUDE'] === '1';
const WITH_PROMPT = process.env['CAW_REAL_CLAUDE_PROMPT'] === '1';
const WITH_TRUST = process.env['CAW_REAL_CLAUDE_TRUST'] === '1';
const SECOND = 1000;

const claudeHome = claudeHomeOf(process.env);
const noLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** The kind of a JSON value, never the value. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function plain(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The raw object of a registry file, or null. */
function readRaw(pid: number): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(claudeHome, 'sessions', `${String(pid)}.json`), 'utf8'));
    return plain(value) ? value : null;
  } catch {
    return null;
  }
}

interface Rig {
  readonly service: TerminalService;
  readonly folder: string;
  readonly output: { bytes: number };
  start(over?: { resume?: string }): Promise<SessionInfo>;
  /** The live registry entries that were not there before the rig started and that name the folder. */
  newEntries(): Promise<readonly RegistryEntry[]>;
  write(info: SessionInfo, text: string): void;
  trust(info: SessionInfo): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The real terminal service over the real Claude home, in a throw-away folder; everything it starts is ended by `afterEach`. */
async function rig(args: readonly string[] = []): Promise<Rig> {
  const temp = makeTempDir('real-claude');
  const folder = path.join(temp.path, 'work');
  mkdirSync(folder, { recursive: true });
  const known = new Set((await listRegistryEntries({ claudeHome, pidAlive })).entries.map((entry) => entry.pid));
  const service = createDefaultTerminalService({
    config: { ...TerminalSectionSchema.parse(undefined), args: [...args] },
    logger: noLog,
    mcsHome: path.join(temp.path, 'mcs-home'),
  });
  const projectDir = path.join(claudeHome, 'projects', projectFolderName(folder).name);
  cleanups.push(async () => {
    await service.shutdown();
    // the folder of the Claude home that only this probe made (a prompt makes one): the name is derived from the throw-away folder
    if (path.dirname(projectDir) === path.join(claudeHome, 'projects') && existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    temp.remove();
  });
  const output = { bytes: 0 };
  const viewer: Viewer = {
    send: (chunk) => {
      output.bytes += chunk.length;
    },
    end: () => undefined,
  };
  return {
    service,
    folder,
    output,
    async start(over = {}) {
      const info = await service.create({ folder, ...(over.resume === undefined ? {} : { resume: over.resume }) });
      service.get(info.name)?.attach(viewer, { replay: false });
      return info;
    },
    async newEntries() {
      const listing = await listRegistryEntries({ claudeHome, pidAlive });
      return listing.entries.filter(
        (entry) =>
          entry.alive &&
          !known.has(entry.pid) &&
          entry.cwd !== null &&
          folderPathKey(entry.cwd) === folderPathKey(folder),
      );
    },
    write(info, text) {
      service.get(info.name)?.write(text);
    },
    async trust(info) {
      if (!WITH_TRUST) return;
      await waitFor(() => output.bytes > 0, { what: 'the first output of claude', timeoutMs: 30 * SECOND });
      service.get(info.name)?.write('\r');
    },
  };
}

function report(label: string, data: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`CAW_LINK_PROBE ${JSON.stringify({ label, ...data })}\n`);
}

/** The structure of one entry: key names, kinds of values, the enumerated values, times relative to the spawn. No id, folder or name. */
function shapeOf(
  raw: Readonly<Record<string, unknown>>,
  spawnedAt: number,
  rootPid: number,
  pid: number,
): Record<string, unknown> {
  const kinds: Record<string, string> = {};
  for (const key of Object.keys(raw).sort()) kinds[key] = kindOf(raw[key]);
  const startedAt = raw['startedAt'];
  const procStart = raw['procStart'];
  const name = raw['name'];
  return {
    keys: Object.keys(raw).sort(),
    kinds,
    status: raw['status'],
    kind: raw['kind'],
    entrypoint: raw['entrypoint'],
    pidDomain: raw['pidDomain'],
    nameSource: raw['nameSource'],
    pidIsRoot: pid === rootPid,
    startedAtMinusSpawnMs: typeof startedAt === 'number' ? startedAt - spawnedAt : null,
    updatedAtMinusSpawnMs: typeof raw['updatedAt'] === 'number' ? raw['updatedAt'] - spawnedAt : null,
    statusUpdatedAtMinusSpawnMs: typeof raw['statusUpdatedAt'] === 'number' ? raw['statusUpdatedAt'] - spawnedAt : null,
    procStart: {
      kind: kindOf(procStart),
      digits: typeof procStart === 'number' || typeof procStart === 'string' ? String(procStart).length : null,
      ratioToStartedAt:
        typeof procStart === 'number' && typeof startedAt === 'number' && startedAt !== 0
          ? Math.round((procStart / startedAt) * 1000) / 1000
          : null,
    },
    nameKind: kindOf(name),
    nameLength: typeof name === 'string' ? name.length : null,
  };
}

describe.skipIf(!ENABLED)('the real claude and its registry entry (CAW_REAL_CLAUDE=1, never in CI)', () => {
  it('writes an entry for its process: its shape, when it appears, how its pid relates to the root, and what /clear does', async () => {
    const r = await rig();
    const status = r.service.status();
    expect(status.supported, 'the terminal needs a supported host').toBe(true);
    expect(status.claude.found, 'claude must be on the PATH').toBe(true);

    const spawnedAt = Date.now();
    const info = await r.start();
    await r.trust(info);
    const found = await waitFor(async () => (await r.newEntries())[0], {
      what: 'a registry entry of the new claude',
      timeoutMs: 60 * SECOND,
      intervalMs: 250,
    }).catch(() => null);
    if (found === null) {
      report('first-start', { appeared: false, waitedMs: Date.now() - spawnedAt, outputBytes: r.output.bytes });
    }
    expect(found, 'no registry entry appeared (a trust question? try CAW_REAL_CLAUDE_TRUST=1)').not.toBeNull();
    if (found === null) return;
    const entry = found;

    const appearedAfterMs = Date.now() - spawnedAt;
    const tree = await listDescendantPids(info.pid);
    const descendants = tree ?? [];
    const relation = entry.pid === info.pid ? 'equal' : descendants.includes(entry.pid) ? 'descendant' : 'other';
    const raw = readRaw(entry.pid);
    expect(raw).not.toBeNull();
    report('first-start', {
      appeared: true,
      appearedAfterMs,
      pidRelation: relation,
      treeAvailable: tree !== null,
      shape: raw === null ? null : shapeOf(raw, spawnedAt, info.pid, entry.pid),
    });

    // /clear: a local command. Does the SAME pid get a new session id, or does a new process or file appear?
    const before = entry.sessionId;
    r.write(info, '/clear\r');
    const outcome = await waitFor(
      async () => {
        const now = readRaw(entry.pid);
        if (now !== null && typeof now['sessionId'] === 'string' && now['sessionId'] !== before) {
          return 'same-pid-new-session-id';
        }
        const others = (await r.newEntries()).filter((candidate) => candidate.pid !== entry.pid);
        return others.length > 0 ? 'new-process' : null;
      },
      { what: 'a change after /clear', timeoutMs: 15 * SECOND, intervalMs: 250 },
    ).catch(() => 'unchanged-within-15s');
    report('clear', { outcome });
  });

  it('shows -n <token> as the name of the entry, or does not', async () => {
    const token = `caw-probe-${Date.now().toString(36)}`;
    const r = await rig(['-n', token]);
    const spawnedAt = Date.now();
    const info = await r.start();
    await r.trust(info);
    const entry = await waitFor(async () => (await r.newEntries())[0], {
      what: 'a registry entry of the named claude',
      timeoutMs: 60 * SECOND,
      intervalMs: 250,
    });
    const raw = readRaw(entry.pid);
    report('named', {
      appearedAfterMs: Date.now() - spawnedAt,
      nameEqualsToken: raw !== null && raw['name'] === token,
      nameKind: raw === null ? null : kindOf(raw['name']),
      nameSource: raw === null ? null : raw['nameSource'],
    });
    expect(raw).not.toBeNull();
  });

  it.skipIf(!WITH_PROMPT)(
    '--resume <id> keeps the session id (one tiny prompt is sent: CAW_REAL_CLAUDE_PROMPT=1)',
    async () => {
      const r = await rig();
      const first = await r.start();
      await r.trust(first);
      const entry = await waitFor(async () => (await r.newEntries())[0], {
        what: 'a registry entry of the first claude',
        timeoutMs: 60 * SECOND,
        intervalMs: 250,
      });
      const transcript = path.join(
        claudeHome,
        'projects',
        projectFolderName(r.folder).name,
        `${entry.sessionId}.jsonl`,
      );
      r.write(first, 'reply with the single word ok\r');
      await waitFor(() => existsSync(transcript), {
        what: 'the transcript of the first session',
        timeoutMs: 90 * SECOND,
        intervalMs: 500,
      });
      const firstStart = entry.startedAtMs;
      await r.service.kill(first.name);
      await waitFor(() => !pidAlive(entry.pid), { what: 'the first claude to end', timeoutMs: 30 * SECOND });

      const spawnedAt = Date.now();
      const second = await r.start({ resume: entry.sessionId });
      await r.trust(second);
      const resumed = await waitFor(
        async () => (await r.newEntries()).find((candidate) => candidate.pid !== entry.pid),
        { what: 'a registry entry of the resumed claude', timeoutMs: 60 * SECOND, intervalMs: 250 },
      );
      const descendants = (await listDescendantPids(second.pid)) ?? [];
      report('resume', {
        sameSessionId: resumed.sessionId === entry.sessionId,
        startedAtVsOriginalMs:
          resumed.startedAtMs !== null && firstStart !== null ? resumed.startedAtMs - firstStart : null,
        startedAtMinusSpawnMs: resumed.startedAtMs === null ? null : resumed.startedAtMs - spawnedAt,
        pidRelation: resumed.pid === second.pid ? 'equal' : descendants.includes(resumed.pid) ? 'descendant' : 'other',
      });
      expect(resumed.sessionId.length).toBeGreaterThan(0);
    },
  );
});
