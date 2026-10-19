// Shared inputs of configuration resolution (01 section 2.3 steps 1 and 3): reading the JSON files with the legacy
// wording, the schema gate (2.6) and the typed form of the merged legacy (L) configuration.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { z } from 'zod';

import { parseJson, formatFloat, quoteText, type JsonDoc, type JsonObject } from '../json/index.ts';
import { readSmallFile } from '../platform/fsx.ts';
import { SKILL_FOLDER_NAME, layoutOfModule } from '../platform/layout.ts';

export type { JsonObject };

/** A configuration file is a few KB; anything above this is a mistake, not a configuration. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export { SKILL_FOLDER_NAME } from '../platform/layout.ts';

/** The runtime folder of this install (ADR 0062): `<skillDir>/bundle` in the bundle layout, `<repo>/runtime` in a checkout. */
export function defaultRuntimeDir(): string {
  return layoutOfModule(import.meta.url).runtimeDir;
}

/**
 * The skill folder (ADR 0062) that holds `SKILL.md`, `config/defaults.json` and `runtime/defaults.json`: the folder around
 * `bundle/` when installed, `<repo>/skills/monitoring-claude-sessions` in a checkout.
 */
export function defaultSkillDir(): string {
  return layoutOfModule(import.meta.url).skillDir;
}

/**
 * The skill folder that belongs to a runtime folder: `<repo>/skills/monitoring-claude-sessions` when `runtimeDir` is the
 * runtime workspace of a checkout (it has that sibling), otherwise the parent of `runtimeDir` (an installed skill whose
 * runtime folder sits inside it, or a test fixture laid out as `<skill>/runtime`).
 */
export function skillDirOfRuntimeDir(runtimeDir: string): string {
  const parent = path.dirname(path.resolve(runtimeDir));
  const checkout = path.join(parent, 'skills', SKILL_FOLDER_NAME);
  return existsSync(path.join(checkout, 'SKILL.md')) ? checkout : parent;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bytes of `file`; `null` for a missing file when `optional`. Every other failure is `CONFIG_UNREADABLE`. */
async function readBytes(file: string, optional: boolean): Promise<Buffer | null> {
  try {
    return await readSmallFile(file, MAX_CONFIG_BYTES);
  } catch (error) {
    if (optional && errorCode(error) === 'ENOENT') return null;
    throw new McsError('CONFIG_UNREADABLE', `cannot read ${file}: ${reasonOf(error)}`, { cause: error });
  }
}

function parseObject(file: string, bytes: Buffer): JsonObject {
  let text: string;
  try {
    // The BOM stays in the text on purpose: a BOM is not JSON and `parseJson` refuses it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new McsError('CONFIG_INVALID', `${file} is not valid JSON: the file is not valid UTF-8`, { cause: error });
  }
  let doc: JsonDoc;
  try {
    doc = parseJson(text);
  } catch (error) {
    throw new McsError('CONFIG_INVALID', `${file} is not valid JSON: ${reasonOf(error)}`, { cause: error });
  }
  if (doc.k !== 'obj') throw new McsError('CONFIG_INVALID', `${file} must contain a JSON object`);
  return doc;
}

/** Reads a JSON object file: `CONFIG_UNREADABLE` when it cannot be read, `CONFIG_INVALID` when its content is not an object. */
export async function readConfigJson(file: string): Promise<JsonObject> {
  const bytes = await readBytes(file, false);
  if (bytes === null) throw new McsError('CONFIG_UNREADABLE', `cannot read ${file}: no content`);
  return parseObject(file, bytes);
}

/** As {@link readConfigJson}, `null` when the file does not exist. */
export async function readOptionalConfigJson(file: string): Promise<JsonObject | null> {
  const bytes = await readBytes(file, true);
  return bytes === null ? null : parseObject(file, bytes);
}

export interface SkillDefaults {
  readonly path: string;
  /** The shared defaults without the `_` keys, in file order. */
  readonly doc: JsonObject;
}

/** Step 1: `<skill>/config/defaults.json`. Any failure is `CONFIG_UNREADABLE` "cannot read shared defaults <path>: <reason>". */
export async function loadSkillDefaults(skillDir: string): Promise<SkillDefaults> {
  const file = path.join(skillDir, 'config', 'defaults.json');
  try {
    const doc = await readConfigJson(file);
    return { path: file, doc: { k: 'obj', v: doc.v.filter(([key]) => !key.startsWith('_')) } };
  } catch (error) {
    if (error instanceof McsError) {
      const reason = error.message.startsWith(`cannot read ${file}: `)
        ? error.message.slice(`cannot read ${file}: `.length)
        : error.message;
      throw new McsError('CONFIG_UNREADABLE', `cannot read shared defaults ${file}: ${reason}`, { cause: error });
    }
    throw error;
  }
}

export function getEntry(doc: JsonObject, key: string): JsonDoc | undefined {
  return doc.v.find(([k]) => k === key)?.[1];
}

/** The `schema_version` of a file as a number: an int in the safe range or a finite float; `null` when absent or of another type. */
export function schemaVersionOf(doc: JsonObject): number | null {
  const v = getEntry(doc, 'schema_version');
  if (v === undefined) return null;
  if (v.k === 'int')
    return v.v >= BigInt(Number.MIN_SAFE_INTEGER) && v.v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.v) : null;
  if (v.k === 'float' && Number.isFinite(v.v)) return v.v;
  return null;
}

/** The legacy display of a parsed value (`None`, `True`, quoted strings), as a list or dict was shown in messages. */
function reprValue(v: JsonDoc): string {
  switch (v.k) {
    case 'null':
      return 'None';
    case 'bool':
      return v.v ? 'True' : 'False';
    case 'str':
      return quoteText(v.v);
    case 'int':
      return v.v.toString();
    case 'float':
      return formatFloat(v.v);
    case 'arr':
      return `[${v.v.map(reprValue).join(', ')}]`;
    case 'obj':
      return `{${v.v.map(([k, x]) => `${quoteText(k)}: ${reprValue(x)}`).join(', ')}}`;
  }
}

/** The legacy `str(v)` display: a string is shown as it is, anything else as `reprValue` shows it. */
function pyStr(v: JsonDoc): string {
  return v.k === 'str' ? v.v : reprValue(v);
}

/** The legacy version test: 1, 1.0 and `true` all count as 1 (a wrong type is then reported by the key check). */
function isSupportedVersion(v: JsonDoc): boolean {
  if (v.k === 'int') return SUPPORTED_SCHEMA_VERSIONS.some((s) => v.v === BigInt(s));
  if (v.k === 'float') return SUPPORTED_SCHEMA_VERSIONS.some((s) => v.v === s);
  if (v.k === 'bool') return SUPPORTED_SCHEMA_VERSIONS.some((s) => Number(v.v) === s);
  return false;
}

const MIGRATE_HINT = 'Run `mcs config migrate` to update the file explicitly, or update the skill.';

/**
 * The schema gate of 01 2.6 with the legacy texts (`check_schema_version`): a missing or `null` version is
 * `CONFIG_SCHEMA_MISSING`, a version this skill does not support is `CONFIG_SCHEMA_UNSUPPORTED`. `where` is the file path.
 */
export function checkSchemaVersion(doc: JsonObject, where: string, file: 'config.json' | 'runtime.json'): void {
  const v = getEntry(doc, 'schema_version');
  if (v === undefined || v.k === 'null') {
    throw new McsError(
      'CONFIG_SCHEMA_MISSING',
      `${where} has no schema_version; refusing to guess (add "schema_version": 1 after checking the keys against reference/configuration.md in the skill folder)`,
      { details: { file } },
    );
  }
  if (!isSupportedVersion(v)) {
    throw new McsError(
      'CONFIG_SCHEMA_UNSUPPORTED',
      `${where} uses schema_version ${pyStr(v)} but this skill supports [${SUPPORTED_SCHEMA_VERSIONS.join(', ')}]; update the skill or migrate the file explicitly`,
      { hint: MIGRATE_HINT, details: { file } },
    );
  }
}

// ---- the typed legacy (L) configuration

const UiSchema = z.looseObject({
  theme: z.enum(['auto', 'light', 'dark']),
  density: z.enum(['comfortable', 'compact']),
  newest_first: z.boolean(),
  show_tools: z.boolean(),
  show_thinking: z.boolean(),
  show_prompts: z.boolean(),
});

const SessionRuleSchema = z.looseObject({ match: z.string(), label: z.string().optional() });

const AttemptsSchema = z.looseObject({
  start: z.string(),
  end: z.string(),
  label_prefix: z.string().optional(),
  time_format: z.string().optional(),
});

/** The merged L keys after validation (01 2.3 `monitor`). The legacy predicates of `validate-legacy.ts` have already run. */
export const LegacyConfigSchema = z.strictObject({
  schema_version: z.number(),
  title: z.string(),
  port: z.number(),
  repo: z.string(),
  transcripts_dir: z.string().nullable(),
  window_hours: z.number(),
  active_seconds: z.number(),
  pending_tool_grace_seconds: z.number(),
  include_unmatched: z.boolean(),
  session_rules: z.array(SessionRuleSchema),
  session_ids: z.array(z.string()),
  panels: z.record(z.string(), z.boolean()),
  live_log_globs: z.array(z.string()),
  chain_log: z.string().nullable(),
  ledger: z.string().nullable(),
  stop_file: z.string().nullable(),
  attempts: AttemptsSchema.nullable(),
  watched_processes: z.array(z.string()),
  docker: z.boolean(),
  ui: UiSchema,
  poll: z.record(z.string(), z.number()),
  limits: z.record(z.string(), z.number()),
});

export type LegacyConfig = z.output<typeof LegacyConfigSchema>;

/** Gives the merged L object its type. A failure means the shared defaults file itself lacks or mistypes a key. */
export function parseLegacyConfig(merged: unknown): LegacyConfig {
  const parsed = LegacyConfigSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? 'configuration' : issue.path.map(String).join('.');
  throw new McsError(
    'CONFIG_INVALID',
    `invalid merged configuration: ${where}: ${issue?.message ?? 'does not have the expected shape'}; check the shared defaults file`,
    { cause: parsed.error },
  );
}
