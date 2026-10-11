/**
 * Sanitization shared by the hook handler and the engine's transcript normalizer (02 2.5).
 *
 * Zod-free and free of Node built-ins: the SHA-256 and UTF-8 code below are self-contained so the handler
 * keeps its fast start, and `@mcs/shared` stays usable in the browser.
 */

// The only global read here. Declared locally because `@mcs/shared` compiles without Node typings; at run time it
// is the Node `process` (or absent in a browser). `hostIsWin32` is the single platform branch outside
// `engine/src/platform/**` (98 1.7, 06 4, I-34).
declare const process: { readonly platform?: string } | undefined;

const BACKSLASH = String.fromCharCode(0x5c);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- pyJsonDumps -------------------------------------------------------------------------------------------------

function pyString(text: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0x20 && c !== 0x22 && c !== 0x5c) continue;
    let escape: string;
    switch (c) {
      case 0x22:
        escape = BACKSLASH + '"';
        break;
      case 0x5c:
        escape = BACKSLASH + BACKSLASH;
        break;
      case 0x0a:
        escape = BACKSLASH + 'n';
        break;
      case 0x0d:
        escape = BACKSLASH + 'r';
        break;
      case 0x09:
        escape = BACKSLASH + 't';
        break;
      case 0x08:
        escape = BACKSLASH + 'b';
        break;
      case 0x0c:
        escape = BACKSLASH + 'f';
        break;
      default:
        escape = BACKSLASH + 'u' + c.toString(16).padStart(4, '0');
    }
    out += text.slice(start, i) + escape;
    start = i + 1;
  }
  return out + text.slice(start) + '"';
}

/**
 * Python `repr(float)` for the numbers JSON text can carry. A JavaScript number cannot tell the integer 1 from the float
 * 1.0, so an integer-valued number below 1e16 prints as an integer (the common case: counts, ids, timestamps) and one
 * from 1e16 up prints as a float, like `1e+22` in the legacy golden.
 */
function pyNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return 'Infinity';
  if (n === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(n, -0)) return '-0.0';
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  const [mantissa = '', exponentText = '0'] = n.toExponential().split('e');
  const exponent = Number(exponentText);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replace('-', '').replace('.', '');
  if (exponent >= -4 && exponent < 16) {
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
      const fraction = digits.slice(exponent + 1);
      return sign + whole + '.' + (fraction === '' ? '0' : fraction);
    }
    return sign + '0.' + '0'.repeat(-exponent - 1) + digits;
  }
  const lead = digits.slice(0, 1) + (digits.length > 1 ? '.' + digits.slice(1) : '');
  return sign + lead + 'e' + (exponent < 0 ? '-' : '+') + String(Math.abs(exponent)).padStart(2, '0');
}

function pyDump(value: unknown, stack: object[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return pyNumber(value);
    case 'bigint':
      return value.toString();
    case 'string':
      return pyString(value);
    case 'function':
    case 'symbol':
      throw new TypeError('Object of type ' + typeof value + ' is not JSON serializable');
    case 'object':
      break;
  }
  if (stack.includes(value)) throw new TypeError('Circular reference detected');
  stack.push(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      return '[' + items.map((item) => pyDump(item, stack)).join(', ') + ']';
    }
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(value, key);
      if (child === undefined) continue;
      parts.push(pyString(key) + ': ' + pyDump(child, stack));
    }
    return '{' + parts.join(', ') + '}';
  } finally {
    stack.pop();
  }
}

/**
 * Python `json.dumps(value, ensure_ascii=False)` with the default separators `", "` and `": "` and insertion key order
 * (02 2.5.1). `undefined` is `null` in a list and absent in an object. Functions and symbols throw `TypeError`, as in
 * Python. Integer-like object keys come out first in JavaScript's own order, which Python does not do.
 */
export function pyJsonDumps(value: unknown): string {
  return pyDump(value, []);
}

// ---- clip --------------------------------------------------------------------------------------------------------

/**
 * Legacy-compatible clip (02 2.5.1, golden `clip.json`): a non-string is dumped by `pyJsonDumps` first, the length is
 * counted in code points, and a longer text keeps its first `n` code points plus ` ... [truncated K chars]`.
 * `n` follows Python slicing, so a negative `n` drops code points from the end.
 */
export function clip(value: unknown, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError('clip: n must be an integer');
  const text = typeof value === 'string' ? value : pyJsonDumps(value);
  const codePoints = Array.from(text);
  if (codePoints.length <= n) return text;
  return codePoints.slice(0, n).join('') + ' ... [truncated ' + String(codePoints.length - n) + ' chars]';
}

// ---- redact ------------------------------------------------------------------------------------------------------

/** Order matters. Each rule that changes the text sets the `redacted` flag (02 2.5.3). */
export const REDACTION_RULES: readonly { readonly id: string; readonly re: RegExp; readonly to: string }[] = [
  {
    id: 'R1',
    re: /\b(authorization|proxy-authorization)\s*[:=]\s*(bearer|basic|token)?\s*[^\s"']+/gi,
    to: '$1: [redacted]',
  },
  {
    id: 'R2',
    // The design writes \b([A-Za-z0-9_.-]*(KEYWORDS)[A-Za-z0-9_.-]*)\s*[:=]\s*(VALUE). This form matches exactly the same
    // texts (the name has to reach the end of its character run anyway) but looks for the keyword once, ahead of the
    // name, so a long run of keywords and dots costs O(n^2) instead of O(n^3): the original needs 1 s for 4 KiB of
    // `token.`, and the handler hard-exits at 1.2 s. The R2 differential test in sanitize.test.ts compares the two.
    re: /\b((?=[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential))[A-Za-z0-9_.-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&]+)/gi,
    to: '$1=[redacted]',
  },
  {
    id: 'R3',
    re: /(--?(token|password|passwd|secret|api-?key|auth|key)(=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
    to: '$1[redacted]',
  },
  {
    id: 'R4',
    re: /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    to: '[redacted]',
  },
  { id: 'R5', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, to: '$1[redacted]@' },
  { id: 'R6', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[email]' },
  // replacer: keeps pure lowercase hex of length 40 or 64 (git ids), else '[redacted:' + m.length + ']'
  { id: 'R7', re: /[A-Za-z0-9+/=_-]{40,}/g, to: '[redacted:<length>]' },
];

/**
 * Hardening beyond R1-R7 (change request CR-WP-04-1): R1 and R2 need the separator right after the field name, so a
 * quoted field of a JSON body or a Python dict (`"password":"x"`, `'api_key': 'x'`, nested at any depth in a
 * stringified tool input) slips through them. The value of such a field is replaced; the name and quotes stay.
 * Applied after R1-R7, idempotent. The keyword is looked up once, ahead of the name, for the reason given at R2.
 */
const QUOTED_SECRET_FIELD =
  /(["'])((?=[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization))[A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi;

const GIT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Longest text `redact` looks at; the rest is cut (with the clip marker) before any rule runs. */
const REDACT_INPUT_MAX_CP = 4096;

function applyRule(rule: { readonly id: string; readonly re: RegExp; readonly to: string }, text: string): string {
  if (rule.id === 'R7') {
    return text.replace(rule.re, (match) =>
      GIT_ID_RE.test(match) ? match : '[redacted:' + String(match.length) + ']',
    );
  }
  return text.replace(rule.re, rule.to);
}

/**
 * `redact` plus whether any rule changed the text (the `redacted` flag of the envelope). The input is clipped to
 * 4096 code points first, so the work is bounded.
 */
export function redactDetailed(text: string): { text: string; redacted: boolean } {
  let current = clip(text, REDACT_INPUT_MAX_CP);
  let redacted = false;
  for (const rule of REDACTION_RULES) {
    const next = applyRule(rule, current);
    if (next !== current) redacted = true;
    current = next;
  }
  const quoted = current.replace(QUOTED_SECRET_FIELD, '$1$2$1$3"[redacted]"');
  if (quoted !== current) redacted = true;
  return { text: quoted, redacted };
}

/** Applied to every preview and summary, never to ids (02 2.5.3). Pure and bounded. */
export function redact(text: string): string {
  return redactDetailed(text).text;
}

// ---- summarizeToolInput ------------------------------------------------------------------------------------------

/** Legacy keys first (CS:C.2), then the keys added by this design. */
const SUMMARY_KEYS = [
  'command',
  'file_path',
  'pattern',
  'description',
  'prompt',
  'script',
  'url',
  'query',
  'path',
  'notebook_path',
  'skill',
  'subject',
] as const;

/** Python truthiness: an empty list or object is falsy (JavaScript calls it truthy). */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** `JSON.stringify` returns `undefined` for a value that has no JSON form; its typing hides that. */
function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** `summarizeToolInput` plus the `redacted` flag. */
export function summarizeToolInputDetailed(input: unknown): { text: string; redacted: boolean } {
  if (!isRecord(input)) return { text: '', redacted: false };
  let key: unknown;
  for (const name of SUMMARY_KEYS) {
    const candidate: unknown = Reflect.get(input, name);
    if (pyTruthy(candidate)) {
      key = candidate;
      break;
    }
  }
  if (key === undefined) return { text: '', redacted: false };
  const text = typeof key === 'string' ? key : (stringifyJson(key) ?? '');
  const firstLine = text.split('\n')[0] ?? '';
  const redacted = redactDetailed(firstLine);
  return { text: clip(redacted.text, 160), redacted: redacted.redacted };
}

/**
 * One line that says what a tool call does (02 2.5.2): the first truthy of the known keys, first line only, redacted,
 * clipped to 160 code points. A non-string key is `JSON.stringify`-ed (Python used `str()`).
 */
export function summarizeToolInput(input: unknown): string {
  return summarizeToolInputDetailed(input).text;
}

// ---- SHA-256 and canonical JSON hash -----------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** UTF-8 bytes of a JavaScript string; a lone surrogate becomes U+FFFD, as the platform's own UTF-8 encoder does. */
function utf8Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[n] = c;
      n += 1;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x800) {
      out[n] = 0xc0 | (c >> 6);
      out[n + 1] = 0x80 | (c & 0x3f);
      n += 2;
    } else if (c < 0x10000) {
      out[n] = 0xe0 | (c >> 12);
      out[n + 1] = 0x80 | ((c >> 6) & 0x3f);
      out[n + 2] = 0x80 | (c & 0x3f);
      n += 3;
    } else {
      out[n] = 0xf0 | (c >> 18);
      out[n + 1] = 0x80 | ((c >> 12) & 0x3f);
      out[n + 2] = 0x80 | ((c >> 6) & 0x3f);
      out[n + 3] = 0x80 | (c & 0x3f);
      n += 4;
    }
  }
  return out.subarray(0, n);
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(message: Uint8Array): string {
  const length = message.length;
  const paddedLength = ((length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(paddedLength - 4, (length << 3) >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] ?? 0;
      const w2 = w[t - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) | 0;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + choose + (SHA256_K[t] ?? 0) + (w[t] ?? 0)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] ?? 0) + a;
    h[1] = (h[1] ?? 0) + b;
    h[2] = (h[2] ?? 0) + c;
    h[3] = (h[3] ?? 0) + d;
    h[4] = (h[4] ?? 0) + e;
    h[5] = (h[5] ?? 0) + f;
    h[6] = (h[6] ?? 0) + g;
    h[7] = (h[7] ?? 0) + hh;
  }
  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}

/** `undefined` means "leave out" (an undefined, function or symbol value of an object). */
function canonicalJson(value: unknown, stack: object[]): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJsonHash: a bigint is not JSON');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
  }
  if (stack.includes(value)) throw new TypeError('canonicalJsonHash: circular reference');
  stack.push(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      return '[' + items.map((item) => canonicalJson(item, stack) ?? 'null').join(',') + ']';
    }
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const child = canonicalJson(Reflect.get(value, key), stack);
      if (child !== undefined) parts.push(JSON.stringify(key) + ':' + child);
    }
    return '{' + parts.join(',') + '}';
  } finally {
    stack.pop();
  }
}

/**
 * First 32 hex characters of the SHA-256 of the JSON text of `value` with object keys sorted recursively (02 2.5.4).
 * Correlates a PermissionRequest with its PreToolUse (`tool_input_hash`) and names a batch (`ids_hash`).
 */
export function canonicalJsonHash(value: unknown): string {
  const text = canonicalJson(value, []) ?? 'null';
  return sha256Hex(utf8Bytes(text)).slice(0, 32);
}

// ---- paths -------------------------------------------------------------------------------------------------------

/** True on a Windows host; false elsewhere and in a browser. The one place this package reads the platform. */
export function hostIsWin32(): boolean {
  if (typeof process === 'undefined') return false;
  return process.platform === 'win32';
}

/**
 * Backslashes become `/`, repeated `/` collapse (a leading `//` stays, for UNC), a trailing `/` goes. The root of a
 * drive (`C:/`) and of the file system (`/`, `//`) keep their slash. Case is kept (02 2.5.4).
 */
export function normalizePath(path: string): string {
  const slashed = path.split(BACKSLASH).join('/');
  let lead = 0;
  while (lead < slashed.length && slashed[lead] === '/') lead += 1;
  const prefix = lead === 0 ? '' : lead === 2 ? '//' : '/';
  let body = slashed.slice(lead).replace(/\/{2,}/g, '/');
  if (body.endsWith('/')) {
    body = body.slice(0, -1);
    if (/^[A-Za-z]:$/.test(body)) body += '/';
  }
  return prefix + body;
}

/** `normalizePath`, lowercased on Windows (case-insensitive file system). Pass `win32` to override the host. */
export function routeKey(path: string, win32: boolean = hostIsWin32()): string {
  const normalized = normalizePath(path);
  return win32 ? normalized.toLowerCase() : normalized;
}
