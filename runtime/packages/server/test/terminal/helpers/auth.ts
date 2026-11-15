// Access helpers of the terminal integration suites (CAW-19, design 02 10, ADR 0085): the headers a browser page sends with a
// write, the exchange of an access code over real HTTP, and the `Cookie` header value that results. A suite mints a code from
// the access service it built, exchanges it here and sends the returned value as `Cookie` on its later requests.
// Nothing here prints a code or a credential: a failure names the status only.
import type { AccessService } from '@mcs/engine';
import { routes } from '@mcs/shared';
import { httpRequest } from '@mcs/testkit';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

/** The one allowed origin of a server on `port` (the loopback address the page is opened at). */
export function pageOrigin(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/** The headers of a write from the page: JSON, the custom header of the csrf guard, and `Cookie` when given. */
export function writeHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-MCS-Request': '1' };
  if (cookie !== undefined) headers['Cookie'] = cookie;
  return headers;
}

/** `POST` of the exchange route with the headers and the `Origin` of the page; `code` goes into the body as it is. */
export function postExchange(
  port: number,
  code: string,
  extra: { host?: string; origin?: string } = {},
): Promise<HttpReply> {
  return httpRequest(port, routes.authExchange.path, {
    method: 'POST',
    headers: writeHeaders(),
    origin: extra.origin ?? pageOrigin(port),
    ...(extra.host === undefined ? {} : { host: extra.host }),
    body: JSON.stringify({ code }),
  });
}

/** The `<name>=<value>` pair of the `Set-Cookie` of a reply, or `null` when it sets none. */
export function cookieFromReply(reply: HttpReply): string | null {
  const header = reply.headers['set-cookie'];
  if (header === undefined) return null;
  const pair = header.split(';')[0]?.trim() ?? '';
  return pair.includes('=') ? pair : null;
}

/**
 * Mints an access code, exchanges it over HTTP and returns the value for the `Cookie` request header. Throws, without the
 * code, when the server does not answer 200 with a cookie.
 */
export async function mintAndExchange(port: number, access: Pick<AccessService, 'mint'>): Promise<string> {
  const reply = await postExchange(port, access.mint().code);
  const cookie = cookieFromReply(reply);
  if (reply.status !== 200 || cookie === null) {
    throw new Error(
      `mintAndExchange: the exchange answered ${String(reply.status)} and ${cookie === null ? 'no cookie' : 'a cookie'}`,
    );
  }
  return cookie;
}
