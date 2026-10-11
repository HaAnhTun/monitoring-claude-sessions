// Opaque keyset cursor (03 5.3): base64url of `{"v":1,"r":<routeId>,"s":<sort>,"d":"asc"|"desc","k":<last sort value>,
// "i":<last id>,"w":[fromMs,toMs]|null,"f":<12 hex of the filter hash>}`, at most 512 characters. Pure code: the base64url
// and UTF-8 steps are written out because `@mcs/shared` has no `Buffer`, `btoa` or `TextEncoder`.
import { z } from 'zod';

import { canonicalJsonHash } from '../protocol/index.ts';

export const CURSOR_VERSION = 1;
export const CURSOR_MAX_LENGTH = 512;

export const CursorPayloadSchema = z.strictObject({
  v: z.literal(CURSOR_VERSION),
  r: z.string().min(1).max(64),
  s: z.string().min(1).max(64),
  d: z.enum(['asc', 'desc']),
  k: z.union([z.string(), z.number()]),
  i: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  w: z
    .tuple([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
    .nullable(),
  f: z.string().regex(/^[0-9a-f]{12}$/),
});

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

/** What a server handler expects of a cursor that came back with a request. */
export interface CursorExpectation {
  r: string;
  s: string;
  d: 'asc' | 'desc';
  f: string;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0xfffd;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

/** Strict UTF-8 decoding: `null` for a truncated, overlong, surrogate or out-of-range sequence. */
function utf8Decode(bytes: readonly number[]): string | null {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let need: number;
    let cp: number;
    let min: number;
    if (b0 < 0x80) {
      need = 0;
      cp = b0;
      min = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      return null;
    }
    for (let n = 1; n <= need; n++) {
      const b = bytes[i + n];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (need > 0 && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) return null;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

function base64UrlEncode(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 3) << 4) | ((b1 ?? 0) >> 4));
    if (b1 !== undefined) out += ALPHABET.charAt(((b1 & 15) << 2) | ((b2 ?? 0) >> 6));
    if (b2 !== undefined) out += ALPHABET.charAt(b2 & 63);
  }
  return out;
}

function base64UrlDecode(text: string): number[] | null {
  if (!BASE64URL_RE.test(text) || text.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const char of text) {
    acc = (acc << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? bytes : null; // non-zero leftover bits: not what an encoder writes
}

/**
 * Encodes a cursor. Throws `ZodError` for a malformed payload and `RangeError` when the text would exceed 512
 * characters (the caller clips a long sort value or restarts at the first page).
 */
export function encodeCursor(payload: Omit<CursorPayload, 'v'>): string {
  const { r, s, d, k, i, w, f } = payload;
  const checked = CursorPayloadSchema.parse({ v: CURSOR_VERSION, r, s, d, k, i, w, f });
  const text = base64UrlEncode(
    utf8Encode(
      JSON.stringify({
        v: checked.v,
        r: checked.r,
        s: checked.s,
        d: checked.d,
        k: checked.k,
        i: checked.i,
        w: checked.w,
        f: checked.f,
      }),
    ),
  );
  if (text.length > CURSOR_MAX_LENGTH)
    throw new RangeError(`cursor is ${text.length} characters, the limit is ${CURSOR_MAX_LENGTH}`);
  return text;
}

/** Decodes a cursor. Any malformed input is `null` (the route answers `400 cursor_invalid`); this never throws. */
export function decodeCursor(text: string): CursorPayload | null {
  if (text.length === 0 || text.length > CURSOR_MAX_LENGTH) return null;
  const bytes = base64UrlDecode(text);
  if (bytes === null) return null;
  const json = utf8Decode(bytes);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = CursorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** True when the cursor belongs to this route, sort, direction and filter (otherwise `400 cursor_invalid`). */
export function cursorMatches(cursor: CursorPayload, expected: CursorExpectation): boolean {
  return cursor.r === expected.r && cursor.s === expected.s && cursor.d === expected.d && cursor.f === expected.f;
}

/** Parameters that choose a page, not a result set: they are not part of the filter hash. */
const PAGING_KEYS: ReadonlySet<string> = new Set(['cursor', 'limit', 'includeTotal', 'sort', 'dir']);

/**
 * The 12 hex characters stored as `f`: the first 12 hex characters of the SHA-256 of the canonical JSON (keys sorted
 * recursively) of the filter without its paging parameters. Changing a filter between two pages changes this value.
 */
export function filterHash(filter: Readonly<Record<string, unknown>>): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) if (!PAGING_KEYS.has(key)) rest[key] = value;
  return canonicalJsonHash(rest).slice(0, 12);
}
