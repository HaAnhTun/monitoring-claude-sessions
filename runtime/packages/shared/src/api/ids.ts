// Identifier schemas of the API (03 5.1, registry 1.1). The patterns of session, agent, run and tool-use ids are the
// single literals of `@mcs/shared/protocol` (02 2.3.2, registry C35); nothing here redeclares them.
import { z } from 'zod';

import { AGENT_RE, PROBE_SESSION_PREFIX, RUN_ID_RE, SID_RE, TOOL_ID_RE } from '../protocol/index.ts';
import { UUID_V4_RE } from '../ids.ts';

/** `sessionId`: the Claude session id, lowercase. Not `z.uuid()`, which enforces RFC variant bits (exp X6). */
export const SessionIdSchema = z.string().regex(SID_RE);

/** `agentId`: `'main'` or the Claude agent id (`'main'` matches the pattern too). Always used with its `sessionId`. */
export const AgentIdSchema = z.string().regex(AGENT_RE);

/** `runId` of a workflow run. */
export const RunIdSchema = z.string().regex(RUN_ID_RE);

/** `toolUseId`: the provider's tool-use id. */
export const ToolUseIdSchema = z.string().regex(TOOL_ID_RE);

/**
 * `projectId`: the lowercase sanitized project folder name, also the key of a folder row. Claude's sanitizer writes
 * letters, digits and dashes only, and a POSIX folder name starts with a dash, so the first character is not special.
 */
export const PROJECT_ID_RE = /^[a-z0-9-]{1,255}$/;
export const ProjectIdSchema = z.string().regex(PROJECT_ID_RE);

/** `instanceId`: uuid v4 (the workspace identity of 01). */
export const InstanceIdSchema = z.string().regex(UUID_V4_RE);

/** Stream epoch: eight lowercase hex characters, one per server process (03 9.2). */
export const EPOCH_RE = /^[0-9a-f]{8}$/;
export const EpochSchema = z.string().regex(EPOCH_RE);

/** Path parameter of `ingestProbe`: a probe session id of 02 2.2 step 9 (the prefix comes from the protocol). */
export const PROBE_SESSION_ID_RE = new RegExp(`^${PROBE_SESSION_PREFIX}[0-9a-f]{12}$`);
export const ProbeSessionIdSchema = z.string().regex(PROBE_SESSION_ID_RE);

/** `tool` filter value (03 5.4). */
export const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export const ToolNameSchema = z.string().regex(TOOL_NAME_RE);

/** `model` filter value (03 5.4): no comma, no whitespace. */
export const MODEL_ID_RE = /^[^,\s]{1,128}$/;
export const ModelIdSchema = z.string().regex(MODEL_ID_RE);

/**
 * `eventId`, `toolCallId`, `workItemId`, `alertId`, `seq`: positive integers stable for the life of the database.
 * Capped at 2^53 - 1 so that JSON round trips stay exact.
 */
export const PositiveIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A count or a size: a non-negative safe integer. */
export const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const DECIMAL_RE = /^-?\d{1,16}$/;

/**
 * An integer written in plain decimal digits (optional minus sign), parsed to a number within `[min, max]`. Query and
 * path parameters use this instead of a bare `z.coerce.number()`, which would turn `''`, `' '`, `'1e3'` and `'0x10'`
 * into numbers: the text check runs first and only then the number is coerced.
 *
 * Nothing here is a `.transform()`: zod removes the `default` of a transforming schema from the generated input JSON
 * Schema, and the documented defaults of 03 6.1 must reach `schemas/api/*.query.schema.json`. `.overwrite()` is a check
 * that keeps the schema non-transforming. The text check is a refinement (not `.regex()`) so that the generated schema
 * does not carry a string `pattern` next to its integer type.
 */
export function intString(min: number, max: number) {
  return z
    .string()
    .refine((text) => DECIMAL_RE.test(text), { error: 'Expected plain decimal digits' })
    .pipe(
      z.coerce
        .number<string>()
        // `-0` would be a real negative zero, which `toEqual` and hashes tell apart from `0`
        .overwrite((n) => (n === 0 ? 0 : n))
        .int()
        .min(min)
        .max(max),
    )
    .meta({ type: 'integer', minimum: min, maximum: max });
}
