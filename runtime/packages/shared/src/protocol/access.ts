// The login URL of the user instance (06 1.8, amendment A1). Zod-free: the CLI and the web app both import it, and the
// protocol folder depends on nothing. The access code travels in the URL fragment under the key `code`, so it never
// reaches a server log, a `Referer` header or the request line.

/** The alphabet and length of a one-time access code. */
export const ACCESS_CODE_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** How long a minted access code stays valid, in seconds (the security area owns the one-use rule). */
export const ACCESS_CODE_TTL_SECONDS = 120;

/** `http://127.0.0.1:<port>/` with an optional `#code=<code>`: the only shape of a login URL. */
export const LOGIN_URL_RE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/(#code=[A-Za-z0-9_-]{32,128})?$/;

/**
 * The host of every URL we print or open. Never `localhost`: a browser tries `[::1]` first for that name while the
 * server binds `127.0.0.1` only, so a squatter on `[::1]` could receive the code. The Host and Origin guards of the
 * server keep accepting both names. Changing the host is a change of this one constant.
 */
const LOOPBACK_HOST = '127.0.0.1';

const FRAGMENT_PREFIX = '#code=';

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new RangeError('port must be an integer from 1 to 65535');
}

/** `http://127.0.0.1:<port>/`. */
export function appBrowserUrl(port: number): string {
  assertPort(port);
  return `http://${LOOPBACK_HOST}:${String(port)}/`;
}

/** `http://127.0.0.1:<port>/#code=<code>`. The error never repeats the code. */
export function buildLoginUrl(port: number, code: string): string {
  if (!ACCESS_CODE_RE.test(code)) throw new RangeError('the access code does not match the access code format');
  return `${appBrowserUrl(port)}${FRAGMENT_PREFIX}${code}`;
}

/** `'#code=<code>'` (the `hash` of a location) to the code; `null` for anything else, extra keys included. */
export function parseLoginFragment(hash: string): string | null {
  if (!hash.startsWith(FRAGMENT_PREFIX)) return null;
  const code = hash.slice(FRAGMENT_PREFIX.length);
  return ACCESS_CODE_RE.test(code) ? code : null;
}
