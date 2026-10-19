// Identifier rules shared by every package (01 section 3.1, registry 1.8). Pure: no I/O, no Node built-ins.
import { z } from 'zod';

/** Instance id: lowercase uuid v4, the shape `crypto.randomUUID()` produces. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Task slug: the folder name of a workspace. Device names are excluded separately (`RESERVED_SLUGS`). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Longest slug, mirrored by `SLUG_RE`. */
export const SLUG_MAX_LENGTH = 48;

/** Windows device names cannot be folder names. Legacy list (`con nul prn aux`) plus `com0`-`com9` and `lpt0`-`lpt9`. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 10 }, (_, i) => [`com${i}`, `lpt${i}`]).flat(),
]);

/** Tail of the legacy message `invalid task slug <quoteText(slug)> (<this text>)`. */
export const SLUG_RULE_TEXT = 'use lowercase letters, digits and hyphens, at most 48 characters';

/** True when `slug` matches `SLUG_RE` and is not a reserved device name. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

const NOT_SLUG_CHAR = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * Legacy `slugify` (01 3.1): lowercase, runs of anything but `[a-z0-9]` become one hyphen, trim hyphens, cut to 48,
 * trim hyphens again, empty becomes `task`. It does not reject reserved names; callers validate with `isValidSlug`.
 */
export function slugify(name: string): string {
  const hyphenated = name.toLowerCase().replace(NOT_SLUG_CHAR, '-').replace(EDGE_HYPHENS, '');
  const cut = hyphenated.slice(0, SLUG_MAX_LENGTH).replace(EDGE_HYPHENS, '');
  return cut === '' ? 'task' : cut;
}

/** `YYYY-MM-DDTHH:MM:SSZ` (audit headers, instance.json, backup manifests). */
export const IsoSecondsZ = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

/** `MAJOR.MINOR.PATCH` with an optional pre-release tag; no build metadata (same rule as `scripts/set-version.mjs`). */
export const Semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
