/// <reference types="node" />
// Covers the CLI contracts of WP-02: the error catalogue and McsError (errors.ts), the envelope (cli/envelope.ts), the
// config inspection projection (cli/results.ts) and the zod-free control protocol (protocol/control.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLI_ERROR_CODES, CliErrorCodeSchema, McsError, cliExitCode, isCliErrorCode } from '../errors.ts';
import {
  CLI_SCHEMA,
  CliEnvelopeSchema,
  CliErrorSchema,
  cliEnvelopeSchema,
  failureEnvelope,
  successEnvelope,
  toCliError,
  type CliEnvelope,
} from './envelope.ts';
import { ConfigInspectionSchema, toConfigInspection, type ConfigFileStatus } from './results.ts';
import {
  CONTROL_BACKUP_TIMEOUT_MS,
  CONTROL_CLIENT_TIMEOUT_MS,
  CONTROL_ERROR_CODES,
  CONTROL_OPS,
  CONTROL_PHASES,
  CONTROL_REPLAY_TIMEOUT_MS,
  CONTROL_REQUEST_MAX_BYTES,
  controlTimeoutMs,
  parseControlRequest,
  parseControlResponse,
  type ControlRequest,
  type ControlResponse,
} from '../protocol/control.ts';

const ID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';
const TOKEN = 'f'.repeat(64);

function registrySection(heading: string, next: string): string {
  const text = readFileSync(
    fileURLToPath(new URL('../../../../../docs/design/98-contract-registry.md', import.meta.url)),
    'utf8',
  );
  const start = text.indexOf(heading);
  const end = text.indexOf(next, start);
  expect(start, heading).toBeGreaterThan(-1);
  return text.slice(start, end);
}

describe('CliErrorCode (98 7.2, C19)', () => {
  it('is exactly the registry catalogue', () => {
    const section = registrySection('### 7.2 CLI error codes', '### 7.3');
    const codes: string[] = [];
    for (const line of section.split('\n')) {
      if (!line.startsWith('| `')) continue;
      const firstCell = line.split('|')[1] ?? '';
      for (const m of firstCell.matchAll(/`([A-Z_]+)`/g)) if (m[1] !== undefined) codes.push(m[1]);
    }
    expect(codes.length).toBeGreaterThan(30);
    expect([...CLI_ERROR_CODES].sort()).toEqual([...codes].sort());
    expect(new Set(CLI_ERROR_CODES).size).toBe(CLI_ERROR_CODES.length);
  });

  it('contains the codes other designs name', () => {
    for (const code of ['USAGE', 'NOT_FOUND', 'HOOKS_FAILED', 'CONFIG_INVALID', 'INTERNAL', 'API_ERROR']) {
      expect(CLI_ERROR_CODES).toContain(code);
    }
    expect(CLI_ERROR_CODES).not.toContain('E_MSYS_PATH');
    expect(CLI_ERROR_CODES).not.toContain('E_ATTEMPTS_TIME_FORMAT');
  });

  it('exits 2 for USAGE, 3 for TERMINALS_LIVE and 1 for everything else', () => {
    expect(cliExitCode('USAGE')).toBe(2);
    expect(cliExitCode('TERMINALS_LIVE')).toBe(3);
    for (const code of CLI_ERROR_CODES.filter((c) => c !== 'USAGE' && c !== 'TERMINALS_LIVE')) {
      expect(cliExitCode(code), code).toBe(1);
    }
  });

  it('validates with a type guard and a zod enum', () => {
    expect(isCliErrorCode('USAGE')).toBe(true);
    expect(isCliErrorCode('usage')).toBe(false);
    expect(isCliErrorCode(7)).toBe(false);
    expect(CliErrorCodeSchema.safeParse('INTERNAL').success).toBe(true);
    expect(CliErrorCodeSchema.safeParse('csrf_rejected').success).toBe(false);
  });
});

describe('McsError', () => {
  it('is an Error carrying code, hint and details', () => {
    const e = new McsError('SLUG_INVALID', 'invalid task slug', { hint: 'try --slug', details: { slug: 'X' } });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(McsError);
    expect(e.name).toBe('McsError');
    expect(e.code).toBe('SLUG_INVALID');
    expect(e.message).toBe('invalid task slug');
    expect(e.hint).toBe('try --slug');
    expect(e.details).toEqual({ slug: 'X' });
    expect(String(e)).toBe('McsError: invalid task slug');
  });

  it('keeps hint and details optional and the cause chain', () => {
    const cause = new Error('boom');
    const e = new McsError('INTERNAL', 'failed', { cause });
    expect(e.hint).toBeUndefined();
    expect(e.details).toBeUndefined();
    expect(e.cause).toBe(cause);
    expect(new McsError('USAGE', 'x').cause).toBeUndefined();
  });

  it('maps to a CliError with nulls for the missing parts', () => {
    expect(toCliError(new McsError('USAGE', 'bad flag'))).toEqual({
      code: 'USAGE',
      message: 'bad flag',
      hint: null,
      details: null,
    });
    expect(toCliError(new McsError('NOT_FOUND', 'm', { hint: 'h', details: { a: 1 } }))).toEqual({
      code: 'NOT_FOUND',
      message: 'm',
      hint: 'h',
      details: { a: 1 },
    });
  });
});

describe('CliEnvelope (01 6.2)', () => {
  it('uses the schema tag mcs.cli/1', () => {
    expect(CLI_SCHEMA).toBe('mcs.cli/1');
  });

  it('builds a success envelope with the documented key order', () => {
    const env = successEnvelope('status', { running: true }, ['dry run']);
    expect(Object.keys(env)).toEqual(['schema', 'command', 'ok', 'exitCode', 'data', 'error', 'warnings']);
    expect(env).toEqual({
      schema: 'mcs.cli/1',
      command: 'status',
      ok: true,
      exitCode: 0,
      data: { running: true },
      error: null,
      warnings: ['dry run'],
    });
    expect(successEnvelope('x', null).warnings).toEqual([]);
  });

  it('builds a failure envelope whose exit code follows the error code', () => {
    const usage = failureEnvelope('init', toCliError(new McsError('USAGE', 'missing --task')));
    expect(usage.ok).toBe(false);
    expect(usage.exitCode).toBe(2);
    expect(usage.data).toBeNull();
    const other = failureEnvelope('stop', toCliError(new McsError('NOT_OUR_PROCESS', 'pid belongs to someone else')), {
      data: { stopped: false },
      warnings: ['w'],
    });
    expect(other.exitCode).toBe(1);
    expect(other.data).toEqual({ stopped: false });
    expect(other.warnings).toEqual(['w']);
  });

  it('the base schema accepts what the builders produce', () => {
    expect(CliEnvelopeSchema.safeParse(successEnvelope('version', { a: 1 })).success).toBe(true);
    const busy = failureEnvelope(
      'configure',
      toCliError(
        new McsError('WORKSPACE_BUSY', 'another mcs command is changing this task', {
          hint: 'try again',
          details: { reason: 'MUTEX_TIMEOUT', name: 'mcs-task-x', waitedMs: 50 },
        }),
      ),
    );
    expect(busy.exitCode).toBe(1);
    expect(CliEnvelopeSchema.safeParse(busy).success).toBe(true);
    expect(CliEnvelopeSchema.safeParse(failureEnvelope('x', toCliError(new McsError('INTERNAL', 'm')))).success).toBe(
      true,
    );
  });

  it('a TERMINALS_LIVE failure is exit 3 and the base schema accepts it', () => {
    const live = failureEnvelope('stop', toCliError(new McsError('TERMINALS_LIVE', 'terminals are open')));
    expect(live.exitCode).toBe(3);
    expect(CliEnvelopeSchema.safeParse(live).success).toBe(true);
    const unsupported = failureEnvelope('autostart', toCliError(new McsError('UNSUPPORTED_PLATFORM', 'windows only')));
    expect(unsupported.exitCode).toBe(1);
    expect(CliEnvelopeSchema.safeParse(unsupported).success).toBe(true);
  });

  it('a data schema narrows the envelope', () => {
    const schema = cliEnvelopeSchema(CliErrorSchema.pick({ message: true }));
    expect(schema.safeParse(successEnvelope('x', { message: 'ok' })).success).toBe(true);
    expect(schema.safeParse(successEnvelope('x', { message: 1 })).success).toBe(false);
    expect(schema.safeParse(successEnvelope('x', null)).success).toBe(true);
  });

  it('rejects inconsistent envelopes', () => {
    const base: CliEnvelope<unknown> = successEnvelope('x', null);
    const bad = (patch: Record<string, unknown>) => CliEnvelopeSchema.safeParse({ ...base, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ schema: 'mcs.cli/2' })).toBe(false);
    expect(bad({ command: '' })).toBe(false);
    expect(bad({ exitCode: 3 })).toBe(false); // ok true needs exit code 0
    expect(bad({ exitCode: 4 })).toBe(false);
    expect(bad({ ok: false })).toBe(false); // ok false needs a non-zero exit code
    expect(bad({ exitCode: 1 })).toBe(false); // ok true needs exit code 0
    expect(bad({ error: { code: 'INTERNAL', message: 'm', hint: null, details: null } })).toBe(false); // ok true, error set
    expect(bad({ ok: false, exitCode: 1, error: { code: 'USAGE', message: 'm', hint: null, details: null } })).toBe(
      false,
    ); // USAGE is exit 2
    expect(bad({ ok: false, exitCode: 2, error: { code: 'USAGE', message: 'm', hint: null, details: null } })).toBe(
      true,
    );
    expect(bad({ ok: false, exitCode: 1, error: { code: 'NOPE', message: 'm', hint: null, details: null } })).toBe(
      false,
    );
    expect(
      bad({ ok: false, exitCode: 3, error: { code: 'TERMINALS_LIVE', message: 'm', hint: null, details: null } }),
    ).toBe(true); // TERMINALS_LIVE is exit 3
    expect(
      bad({ ok: false, exitCode: 1, error: { code: 'TERMINALS_LIVE', message: 'm', hint: null, details: null } }),
    ).toBe(false);
    expect(bad({ ok: false, exitCode: 3, error: { code: 'INTERNAL', message: 'm', hint: null, details: null } })).toBe(
      false,
    );
    expect(bad({ ok: false, exitCode: 3, error: null })).toBe(true); // data only, exit 3
    expect(bad({ ok: false, exitCode: 1, error: null })).toBe(true); // a check that found problems, data only
    expect(bad({ warnings: [1] })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
  });
});

describe('toConfigInspection (01 6.4, I-20)', () => {
  const files: ConfigFileStatus[] = [
    { name: 'defaults.json', path: 'C:/skill/config/defaults.json', schemaVersion: 1, present: true, ok: true },
    {
      name: 'runtime/defaults.json',
      path: 'C:/skill/runtime/defaults.json',
      schemaVersion: 1,
      present: true,
      ok: true,
    },
    { name: 'config.json', path: 'C:/ws/config.json', schemaVersion: 1, present: true, ok: true },
    { name: 'runtime.json', path: 'C:/ws/runtime.json', schemaVersion: null, present: false, ok: true },
  ];
  const resolved = {
    monitor: {
      port: 8765,
      panels: { git: true, machine: false },
      session_rules: [{ match: 'a', label: 'b' }],
      ui: { theme: 'auto' },
    },
    runtime: {
      logLevel: 'debug',
      server: { port: null, portScan: 19 },
      alerts: { rules: { inactivity: { enabled: true, minutes: 30, cooldownMinutes: 10 } } },
    },
    effectivePort: 8766,
    provenance: {
      'server.portScan': 'runtime',
      port: 'config',
      effectivePort: 'cli',
      'panels.machine': 'config',
      logLevel: 'env',
      'ui.theme': 'skill',
      'panels.git': 'skill',
      session_rules: 'skill',
      'server.port': 'builtin',
      'alerts.rules.inactivity.minutes': 'runtime',
    },
    files,
  } as const;

  it('has one entry per provenance key except effectivePort, sorted by key', () => {
    const out = toConfigInspection(resolved, 'node');
    expect(out.entries.map((e) => e.key)).toEqual([
      'alerts.rules.inactivity.minutes',
      'logLevel',
      'panels.git',
      'panels.machine',
      'port',
      'server.port',
      'server.portScan',
      'session_rules',
      'ui.theme',
    ]);
  });

  it('takes the value at the dotted path from the legacy or the runtime configuration', () => {
    const byKey = Object.fromEntries(toConfigInspection(resolved, 'node').entries.map((e) => [e.key, e]));
    expect(byKey['port']).toEqual({ key: 'port', value: 8765, source: 'config' });
    expect(byKey['panels.machine']).toEqual({ key: 'panels.machine', value: false, source: 'config' });
    expect(byKey['session_rules']?.value).toEqual([{ match: 'a', label: 'b' }]);
    expect(byKey['logLevel']).toEqual({ key: 'logLevel', value: 'debug', source: 'env' });
    expect(byKey['server.port']).toEqual({ key: 'server.port', value: null, source: 'builtin' });
    expect(byKey['server.portScan']?.source).toBe('runtime');
    expect(byKey['alerts.rules.inactivity.minutes']?.value).toBe(30);
  });

  it('passes the files, the engine and the effective port through', () => {
    const out = toConfigInspection(resolved, 'node');
    expect(out.files).toEqual(files);
    expect(out.engine).toBe('node');
    expect(out.effectivePort).toBe(8766);
    expect(Object.keys(out)).toEqual(['entries', 'files', 'effectivePort', 'engine']);
  });

  it('reports engine null for a workspace without instance.json', () => {
    expect(toConfigInspection(resolved, null).engine).toBeNull();
  });

  it('uses the field name source (not provenance) and is detached from its input', () => {
    const out = toConfigInspection(resolved, 'node');
    expect(Object.keys(out.entries[0] ?? {})).toEqual(['key', 'value', 'source']);
    const rules = out.entries.find((e) => e.key === 'session_rules')?.value;
    expect(Array.isArray(rules)).toBe(true);
    if (Array.isArray(rules)) rules.push('x');
    expect(resolved.monitor.session_rules).toHaveLength(1);
  });

  it('reports null for a provenance key without a value and never invents undefined', () => {
    const out = toConfigInspection({ ...resolved, provenance: { 'no.such.key': 'config', port: 'skill' } }, 'node');
    expect(out.entries).toEqual([
      { key: 'no.such.key', value: null, source: 'config' },
      { key: 'port', value: 8765, source: 'skill' },
    ]);
    expect(JSON.stringify(out)).not.toContain('undefined');
  });

  it('sorts in code-point order, not locale order', () => {
    const out = toConfigInspection(
      { ...resolved, provenance: { b: 'skill', B: 'skill', a_b: 'skill', 'a.b': 'skill', a: 'skill' } },
      'node',
    );
    expect(out.entries.map((e) => e.key)).toEqual(['B', 'a', 'a.b', 'a_b', 'b']);
  });

  it('validates against the shared response schema', () => {
    expect(ConfigInspectionSchema.safeParse(toConfigInspection(resolved, 'node')).success).toBe(true);
    const bad = { ...toConfigInspection(resolved, 'node'), entries: [{ key: 'x', value: 1, provenance: 'config' }] };
    expect(ConfigInspectionSchema.safeParse(bad).success).toBe(false);
    const badSource = { ...toConfigInspection(resolved, 'node'), entries: [{ key: 'x', value: 1, source: 'default' }] };
    expect(ConfigInspectionSchema.safeParse(badSource).success).toBe(false);
  });
});

describe('control protocol (01 4.3, zod-free)', () => {
  const requests: ControlRequest[] = [
    { v: 1, op: 'identify' },
    { v: 1, op: 'shutdown', instanceId: ID, token: TOKEN, reason: 'stop' },
    { v: 1, op: 'shutdown', instanceId: ID, token: TOKEN, reason: 'stop', force: true },
    { v: 1, op: 'terminals', instanceId: ID, token: TOKEN },
    { v: 1, op: 'access', instanceId: ID, token: TOKEN },
    { v: 1, op: 'backup', instanceId: ID, token: TOKEN, dest: 'C:/ws/data/backups/x.partial/monitor.db' },
    { v: 1, op: 'ingest-replay', instanceId: ID, token: TOKEN, fromSegment: 'hooks-20261011T08Z.ndjson' },
    { v: 1, op: 'ingest-replay', instanceId: ID, token: TOKEN, fromSegment: null },
  ];

  it('lists the six ops, three phases and eight error codes', () => {
    expect([...CONTROL_OPS]).toEqual(['identify', 'shutdown', 'backup', 'ingest-replay', 'terminals', 'access']);
    expect([...CONTROL_PHASES]).toEqual(['starting', 'ready', 'stopping']);
    expect([...CONTROL_ERROR_CODES]).toEqual([
      'BAD_REQUEST',
      'FORBIDDEN',
      'INSTANCE_MISMATCH',
      'NOT_READY',
      'BACKUP_FAILED',
      'INTERNAL',
      'TERMINALS_LIVE',
      'UNSUPPORTED',
    ]);
    expect(CONTROL_REQUEST_MAX_BYTES).toBe(4096);
  });

  it('parses every request shape from one JSON line', () => {
    for (const r of requests) expect(parseControlRequest(JSON.stringify(r)), r.op).toEqual(r);
  });

  it('names the replay field fromSegment and keeps it required (null means all segments)', () => {
    const noField = { v: 1, op: 'ingest-replay', instanceId: ID, token: TOKEN };
    expect(parseControlRequest(JSON.stringify(noField))).toBeNull();
    expect(parseControlRequest(JSON.stringify({ ...noField, from: null }))).toBeNull();
    expect(parseControlRequest(JSON.stringify({ ...noField, fromSegment: 3 }))).toBeNull();
  });

  it('rejects everything that is not exactly one request', () => {
    const base = { v: 1, op: 'shutdown', instanceId: ID, token: TOKEN, reason: 'stop' };
    const cases: [string, string][] = [
      ['empty', ''],
      ['not json', '{'],
      ['array', '[]'],
      ['null', 'null'],
      ['two lines', `${JSON.stringify(base)}\n${JSON.stringify(base)}`],
      ['wrong version', JSON.stringify({ ...base, v: 2 })],
      ['unknown op', JSON.stringify({ ...base, op: 'restart' })],
      ['extra key', JSON.stringify({ ...base, extra: 1 })],
      ['identify with extra', JSON.stringify({ v: 1, op: 'identify', instanceId: ID })],
      ['missing token', JSON.stringify({ v: 1, op: 'shutdown', instanceId: ID, reason: 'stop' })],
      ['bad reason', JSON.stringify({ ...base, reason: 'crash' })],
      ['non-string token', JSON.stringify({ ...base, token: 5 })],
      ['empty dest', JSON.stringify({ v: 1, op: 'backup', instanceId: ID, token: TOKEN, dest: '' })],
      ['too large', JSON.stringify({ ...base, token: 'x'.repeat(CONTROL_REQUEST_MAX_BYTES) })],
    ];
    for (const [name, line] of cases) expect(parseControlRequest(line), name).toBeNull();
  });

  it('counts the 4096-byte limit in UTF-8 bytes, not characters', () => {
    const pad = (n: number, ch: string) =>
      JSON.stringify({ v: 1, op: 'backup', instanceId: ID, token: TOKEN, dest: ch.repeat(n) });
    const exact = pad(4096 - Buffer.byteLength(pad(0, 'a')), 'a');
    expect(Buffer.byteLength(exact)).toBe(4096);
    expect(parseControlRequest(exact)).not.toBeNull();
    expect(parseControlRequest(pad(4096 - Buffer.byteLength(pad(0, 'a')) + 1, 'a'))).toBeNull();
    const twoByte = String.fromCharCode(0xe9);
    expect(parseControlRequest(pad(2100, twoByte))).toBeNull(); // 2100 characters, 4200 bytes
  });

  const responses: ControlResponse[] = [
    {
      v: 1,
      ok: true,
      op: 'identify',
      instanceId: ID,
      pid: 4242,
      phase: 'ready',
      runtimeVersion: '3.0.0',
      codeStamp: 'a1b2c3d4e5',
      port: 18765,
      url: 'http://127.0.0.1:18765',
      startedAt: '2026-10-11T08:09:10.500Z',
    },
    {
      v: 1,
      ok: true,
      op: 'identify',
      instanceId: ID,
      pid: 4242,
      phase: 'starting',
      runtimeVersion: '3.0.0',
      codeStamp: 'a1b2c3d4e5',
      port: null,
      url: null,
      startedAt: '2026-10-11T08:09:10.500Z',
    },
    { v: 1, ok: true, op: 'shutdown', phase: 'stopping' },
    { v: 1, ok: true, op: 'backup', bytes: 4096, dbSchemaVersion: 3 },
    { v: 1, ok: true, op: 'ingest-replay', segments: 2 },
    {
      v: 1,
      ok: true,
      op: 'terminals',
      live: 1,
      max: 8,
      sessions: [{ name: 'api-1', startedAt: '2026-11-14T10:00:00.000Z' }],
    },
    {
      v: 1,
      ok: true,
      op: 'access',
      code: 'a'.repeat(43),
      expiresAt: '2026-11-14T10:02:00.000Z',
      ttlSeconds: 120,
    },
    { v: 1, ok: false, error: 'FORBIDDEN' },
    { v: 1, ok: false, error: 'TERMINALS_LIVE' },
    { v: 1, ok: false, error: 'UNSUPPORTED' },
  ];

  it('parses every response shape', () => {
    for (const r of responses) expect(parseControlResponse(JSON.stringify(r)), JSON.stringify(r)).toEqual(r);
  });

  it('rejects malformed responses', () => {
    const cases: [string, unknown][] = [
      ['unknown error', { v: 1, ok: false, error: 'NOPE' }],
      ['ok without op', { v: 1, ok: true }],
      ['identify without pid', { v: 1, ok: true, op: 'identify', instanceId: ID, phase: 'ready' }],
      ['bad phase', { v: 1, ok: true, op: 'shutdown', phase: 'ready' }],
      ['negative bytes', { v: 1, ok: true, op: 'backup', bytes: -1, dbSchemaVersion: 3 }],
      ['segments as string', { v: 1, ok: true, op: 'ingest-replay', segments: '2' }],
      ['wrong version', { v: 2, ok: false, error: 'FORBIDDEN' }],
    ];
    for (const [name, value] of cases) expect(parseControlResponse(JSON.stringify(value)), name).toBeNull();
    expect(parseControlResponse('not json')).toBeNull();
  });

  it('gives each op its own client timeout (2 s, backup 10 min, replay 30 s)', () => {
    expect(CONTROL_CLIENT_TIMEOUT_MS).toBe(2000);
    expect(CONTROL_BACKUP_TIMEOUT_MS).toBe(600_000);
    expect(CONTROL_REPLAY_TIMEOUT_MS).toBe(30_000);
    expect(controlTimeoutMs('identify')).toBe(2000);
    expect(controlTimeoutMs('shutdown')).toBe(2000);
    expect(controlTimeoutMs('backup')).toBe(600_000);
    expect(controlTimeoutMs('ingest-replay')).toBe(30_000);
  });
});
