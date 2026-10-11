// Key tables and the two schemas generated from them (01 section 1.6, E12, E14): the merged schema and the overrides
// schema can never disagree because both are derived from the same table.
import { z } from 'zod';

/** One key of a section: its validation and its default. The default must satisfy the schema. */
export interface KeySpec<T extends z.ZodType = z.ZodType> {
  readonly schema: T;
  readonly default: z.output<T>;
  /**
   * Schema of the key inside `runtime.json`, when it differs from `schema`: a key whose `schema` fills defaults of its
   * own (the alert rules) must not inject them into an overrides file, because the merge would then overwrite the
   * skill layer. Absent = `schema` is used.
   */
  readonly overrides?: z.ZodType;
}

export type SectionKeys = Readonly<Record<string, KeySpec>>;

/** Shape of the merged section: every key carries its default. */
export type SectionShape<K extends SectionKeys> = { readonly [P in keyof K]: z.ZodDefault<K[P]['schema']> };

/** Shape of the overrides section: every key optional, nothing injected. */
export type SectionOverridesShape<K extends SectionKeys> = {
  readonly [P in keyof K]: z.ZodOptional<K[P]['overrides'] extends z.ZodType ? K[P]['overrides'] : K[P]['schema']>;
};

export type SectionSchema<K extends SectionKeys> = z.ZodPrefault<z.ZodObject<SectionShape<K>, z.core.$strict>>;
export type SectionOverridesSchema<K extends SectionKeys> = z.ZodOptional<
  z.ZodObject<SectionOverridesShape<K>, z.core.$strict>
>;

/**
 * `z.strictObject({k: spec.schema.default(spec.default)}).prefault({})`. `.prefault({})` and not `.default({})`: the
 * latter returns `{}` without the inner defaults (E12). The default is a factory returning a deep clone: zod's plain
 * `.default(value)` clones one level only, so nested defaults (the alert rules) would be shared between parses.
 */
export function sectionSchema<K extends SectionKeys>(keys: K): SectionSchema<K>;
export function sectionSchema(keys: SectionKeys): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(keys))
    shape[name] = spec.schema.default(() => structuredClone(spec.default));
  return z.strictObject(shape).prefault({});
}

/** `z.strictObject({k: spec.schema.optional()}).optional()`: unknown keys rejected, no defaults injected. */
export function sectionOverridesSchema<K extends SectionKeys>(keys: K): SectionOverridesSchema<K>;
export function sectionOverridesSchema(keys: SectionKeys): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(keys)) shape[name] = (spec.overrides ?? spec.schema).optional();
  return z.strictObject(shape).optional();
}

/** Integer key with an inclusive range. */
export function intKey(min: number, max: number, def: number): KeySpec<z.ZodNumber> {
  return { schema: z.number().int().min(min).max(max), default: def };
}

/** Integer key with an inclusive range whose default is `null` (derived from a legacy key, or "off"). */
export function nullableIntKey(min: number, max: number): KeySpec<z.ZodNullable<z.ZodNumber>> {
  return { schema: z.number().int().min(min).max(max).nullable(), default: null };
}

/** Boolean key. */
export function boolKey(def: boolean): KeySpec<z.ZodBoolean> {
  return { schema: z.boolean(), default: def };
}

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;
