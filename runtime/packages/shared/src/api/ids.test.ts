import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentIdSchema,
  EpochSchema,
  InstanceIdSchema,
  ModelIdSchema,
  PositiveIdSchema,
  ProbeSessionIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  SessionIdSchema,
  ToolNameSchema,
  ToolUseIdSchema,
  intString,
} from './ids.ts';

const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';

describe('id schemas (03 5.1)', () => {
  it.each([
    [SessionIdSchema, SID, true],
    [SessionIdSchema, SID.toUpperCase(), false],
    // the legacy pattern accepts ids that are not RFC variant 1/2 uuids (exp X6)
    [SessionIdSchema, '00000000-0000-0000-0000-000000000000', true],
    [SessionIdSchema, 'not-a-session', false],
    [AgentIdSchema, 'main', true],
    [AgentIdSchema, 'a1b2c3d4e5f6', true],
    [AgentIdSchema, 'ab', false],
    [AgentIdSchema, 'has space', false],
    [RunIdSchema, 'wf_abc-123', true],
    [RunIdSchema, 'abc', false],
    [ToolUseIdSchema, 'toolu_01AbC', true],
    [ToolUseIdSchema, '', false],
    [ToolUseIdSchema, 'x'.repeat(129), false],
    [ProjectIdSchema, 'my-project-1', true],
    // the characters Claude's sanitizer can produce, lower-cased: a POSIX folder name starts with a dash
    [ProjectIdSchema, '-leading', true],
    [ProjectIdSchema, '-home-user-project', true],
    [ProjectIdSchema, '-', true],
    [ProjectIdSchema, '0', true],
    [ProjectIdSchema, 'd--work-app', true],
    [ProjectIdSchema, '', false],
    [ProjectIdSchema, 'has space', false],
    [ProjectIdSchema, 'under_score', false],
    [ProjectIdSchema, 'dot.dot', false],
    [ProjectIdSchema, 'a/b', false],
    [ProjectIdSchema, ['a', 'b'].join(String.fromCharCode(92)), false],
    [ProjectIdSchema, '..', false],
    [ProjectIdSchema, ['new', 'line'].join(String.fromCharCode(10)), false],
    [ProjectIdSchema, `trailing${String.fromCharCode(10)}`, false],
    [ProjectIdSchema, 'Upper', false],
    [ProjectIdSchema, 'a'.repeat(255), true],
    [ProjectIdSchema, 'a'.repeat(256), false],
    [InstanceIdSchema, '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b', true],
    [InstanceIdSchema, '0b9f3f3e-6f0e-1c1e-9a53-0f4f2f1c9d11', false],
    [ProbeSessionIdSchema, '00000000-0000-4000-8000-0123456789ab', true],
    [ProbeSessionIdSchema, '00000000-0000-4000-8000-0123456789AB', false],
    [ProbeSessionIdSchema, SID, false],
    [EpochSchema, 'deadbeef', true],
    [EpochSchema, 'DEADBEEF', false],
    [EpochSchema, 'deadbee', false],
    [ToolNameSchema, 'mcp__server.tool:1', true],
    [ToolNameSchema, 'bad name', false],
    [ModelIdSchema, 'claude-x-1', true],
    [ModelIdSchema, 'a,b', false],
    [PositiveIdSchema, 1, true],
    [PositiveIdSchema, 0, false],
    [PositiveIdSchema, 1.5, false],
  ])('%# accepts or refuses %j', (schema, value, ok) => {
    expect(schema.safeParse(value).success).toBe(ok);
  });

  it('intString parses plain decimal text only (no coercion quirks)', () => {
    const schema = intString(-1, 100);
    expect(schema.parse('-1')).toBe(-1);
    expect(schema.parse('42')).toBe(42);
    for (const bad of ['', ' ', '1e1', '0x10', '1.5', '101', '-2', '+3', '٣', '5.0', ' 5', '5 ']) {
      expect(schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('intString never yields negative zero, so equality and hashes do not depend on the spelling', () => {
    expect(Object.is(intString(-5, 5).parse('-0'), 0)).toBe(true);
    expect(Object.is(intString(-5, 5).parse('0'), 0)).toBe(true);
    expect(intString(-5, 5).parse('-5')).toBe(-5);
  });

  it('intString keeps its bounds in the generated input JSON Schema (03 13 items 1 and 4)', () => {
    const json = z.toJSONSchema(z.strictObject({ n: intString(-3, 40) }), { io: 'input' });
    expect(json.properties?.['n']).toMatchObject({ type: 'integer', minimum: -3, maximum: 40 });
    // no string `pattern` next to the integer type, and a default is kept (a transform would drop it)
    expect(json.properties?.['n']).not.toHaveProperty('pattern');
    const withDefault = z.toJSONSchema(z.strictObject({ n: intString(1, 9).default(5) }), { io: 'input' });
    expect(withDefault.properties?.['n']).toMatchObject({ type: 'integer', minimum: 1, maximum: 9, default: 5 });
  });
});
