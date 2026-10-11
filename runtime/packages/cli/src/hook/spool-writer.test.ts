import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, sep } from 'node:path';

import {
  ENVELOPE_MAX_BYTES,
  SPOOL_SEGMENT_HARD_CAP,
  SPOOL_SEGMENT_SOFT_CAP,
  spoolSegmentName,
  type HookEnvelopeV1,
  type HookRouteV1,
} from '@mcs/shared/protocol';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { appendEnvelope, encodeLine, minimalEnvelope } from './spool-writer.ts';

const makeTemp = useTempDirs();
const AT = Date.UTC(2026, 9, 11, 14, 5);
const LF = String.fromCharCode(10);
const fwd = (path: string): string => path.split(sep).join('/');

function envelope(overrides: Partial<HookEnvelopeV1> = {}): HookEnvelopeV1 {
  return {
    v: 1,
    kind: 'hook',
    instance_id: '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab',
    event_uid: '0f8b5e2a-7c41-4e0b-9d3a-2b1c0d9e8f7a',
    received_at: AT,
    event: 'PreToolUse',
    argv_event: 'PreToolUse',
    session_id: null,
    transcript_path: null,
    cwd: null,
    prompt_id: null,
    agent_id: null,
    agent_type: null,
    tool_use_id: null,
    permission_mode: null,
    claude_pid: null,
    payload_bytes: 10,
    content_hash: '0123456789abcdef0123456789abcdef',
    handler: { version: '3.0.0', pid: 1, async: true },
    flags: [],
    data: { tool_name: 'Bash', tool_summary: 'npm test', tool_input_hash: 'ff' },
    ...overrides,
  };
}

function routeIn(root: string): HookRouteV1 {
  const workspace = fwd(root);
  return {
    v: 1,
    instanceId: '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab',
    workspace,
    spoolDir: `${workspace}/data/spool`,
    stateFile: `${workspace}/state.json`,
    enabled: true,
    match: { transcriptsDirs: [], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: 1,
  };
}

describe('minimalEnvelope', () => {
  it('keeps the listed data keys, cuts calls to 16 and adds the flag once', () => {
    const calls = Array.from({ length: 30 }, (_unused, i) => ({ tool_use_id: `t${String(i)}`, tool_name: 'Bash' }));
    const minimal = minimalEnvelope(envelope({ data: { tool_name: 'Bash', tool_summary: 'x', calls, reason: 'r' } }));
    expect(Object.keys(minimal.data)).toEqual(['tool_name', 'reason', 'calls']);
    expect(minimal.data['calls']).toHaveLength(16);
    expect(minimalEnvelope(minimal).flags).toEqual(['minimal']);
  });
});

describe('encodeLine', () => {
  it('is the full line when it fits and the minimal one when forced or too long', () => {
    expect(JSON.parse(encodeLine(envelope(), false).toString())).toMatchObject({ flags: [] });
    expect(JSON.parse(encodeLine(envelope(), true).toString())).toMatchObject({ flags: ['minimal'] });
    const long = envelope({ data: { tool_name: 'Bash', tool_summary: 'y'.repeat(ENVELOPE_MAX_BYTES) } });
    const line = encodeLine(long, false);
    expect(line.length).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    expect(line.toString().endsWith(LF)).toBe(true);
  });
});

describe('appendEnvelope', () => {
  it('creates the spool folder below an existing workspace and appends whole lines to the hour segment', () => {
    const root = makeTemp('spool').path;
    const route = routeIn(root);
    expect(appendEnvelope(route, envelope()).outcome).toBe('written');
    expect(appendEnvelope(route, envelope({ received_at: AT + 1000 })).outcome).toBe('written');
    expect(readdirSync(route.spoolDir)).toEqual([spoolSegmentName(AT)]);
    expect(readFileSync(join(route.spoolDir, spoolSegmentName(AT)), 'utf8').split(LF)).toHaveLength(3);
    expect(appendEnvelope(route, envelope({ received_at: AT + 3_600_000 })).outcome).toBe('written');
    expect(readdirSync(route.spoolDir)).toHaveLength(2);
  });

  it('does not re-create a workspace that is gone', () => {
    const root = makeTemp('spool').path;
    const route = routeIn(join(root, 'gone'));
    expect(appendEnvelope(route, envelope())).toMatchObject({ outcome: 'failed', detail: 'ENOENT' });
    expect(existsSync(join(root, 'gone'))).toBe(false);
  });

  it('fails without throwing when the spool path is a file', () => {
    const root = makeTemp('spool').path;
    const route = routeIn(root);
    mkdirSync(join(root, 'data'));
    closeSync(openSync(join(root, 'data', 'spool'), 'w'));
    expect(appendEnvelope(route, envelope()).outcome).toBe('failed');
  });

  it('writes a minimal envelope at the soft cap and nothing at the hard cap', () => {
    const root = makeTemp('spool').path;
    const route = routeIn(root);
    mkdirSync(route.spoolDir, { recursive: true });
    const segment = join(route.spoolDir, spoolSegmentName(AT));
    const soft = openSync(segment, 'w');
    ftruncateSync(soft, SPOOL_SEGMENT_SOFT_CAP);
    closeSync(soft);
    expect(appendEnvelope(route, envelope()).outcome).toBe('written');
    expect(statSync(segment).size).toBeGreaterThan(SPOOL_SEGMENT_SOFT_CAP);
    const hard = openSync(segment, 'r+');
    ftruncateSync(hard, SPOOL_SEGMENT_HARD_CAP);
    closeSync(hard);
    expect(appendEnvelope(route, envelope())).toMatchObject({ outcome: 'full' });
    expect(statSync(segment).size).toBe(SPOOL_SEGMENT_HARD_CAP);
  });
});
