// HTTP and SSE helpers (05 4.4). Every request uses `agent: false`: a reused keep-alive socket was reset under Vitest (E8, 4.6 rule 8).
import { request, type IncomingHttpHeaders } from 'node:http';

export interface HttpRequestOptions {
  method?: string;
  /** Value of the `Host` header (default `127.0.0.1:<port>`). */
  host?: string;
  /** Value of the `Origin` header. */
  origin?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Budget for the whole exchange in ms (default 10 000). */
  timeoutMs?: number;
}

export interface HttpReply {
  status: number;
  /** Lower-case names; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function requestHeaders(
  port: number,
  opts: { host?: string; origin?: string; headers?: Record<string, string> },
): Record<string, string> {
  const headers: Record<string, string> = { ...opts.headers };
  headers['Host'] = opts.host ?? `127.0.0.1:${String(port)}`;
  if (opts.origin !== undefined) headers['Origin'] = opts.origin;
  return headers;
}

/** One request on a fresh connection to 127.0.0.1:<port>. */
export function httpRequest(port: number, path: string, opts: HttpRequestOptions = {}): Promise<HttpReply> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = requestHeaders(port, opts);
  if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: flatten(res.headers),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.once('error', reject);
    });
    req.once('timeout', () => {
      req.destroy(new Error(`httpRequest: ${method} ${path} timed out after ${String(timeoutMs)} ms`));
    });
    req.once('error', reject);
    req.end(opts.body);
  });
}

export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

export interface ReadSseOptions {
  lastEventId?: string;
  maxEvents: number;
  timeoutMs: number;
}

/** Parses SSE text incrementally: `feed` returns the frames completed by the new text. */
class SseParser {
  #buffer = '';
  #id: string | undefined;
  #event: string | undefined;
  #data: string[] = [];

  feed(text: string): SseEvent[] {
    this.#buffer += text;
    const out: SseEvent[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const frame = this.#line(line);
      if (frame !== undefined) out.push(frame);
      newline = this.#buffer.indexOf('\n');
    }
    return out;
  }

  #line(line: string): SseEvent | undefined {
    if (line === '') {
      const frame = this.#data.length === 0 ? undefined : this.#frame();
      this.#id = undefined;
      this.#event = undefined;
      this.#data = [];
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'id') this.#id = value;
    else if (name === 'event') this.#event = value;
    else if (name === 'data') this.#data.push(value);
    return undefined;
  }

  #frame(): SseEvent {
    return {
      ...(this.#id === undefined ? {} : { id: this.#id }),
      ...(this.#event === undefined ? {} : { event: this.#event }),
      data: this.#data.join('\n'),
    };
  }
}

/**
 * Opens an event stream and returns the first `maxEvents` frames (comments are skipped). When `timeoutMs` ends first, or the
 * server closes the stream, the frames received so far are returned; a status other than 200 rejects.
 */
export function readSse(port: number, path: string, opts: ReadSseOptions): Promise<SseEvent[]> {
  const headers = requestHeaders(port, { headers: { Accept: 'text/event-stream' } });
  if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId;
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (error === undefined) resolve(events);
      else reject(error);
    };
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error(`readSse: ${path} answered ${String(res.statusCode)}`));
        return;
      }
      res.setEncoding('utf8');
      const parser = new SseParser();
      res.on('data', (text: string) => {
        for (const frame of parser.feed(text)) {
          events.push(frame);
          if (events.length >= opts.maxEvents) {
            finish();
            return;
          }
        }
      });
      res.once('end', () => {
        finish();
      });
      res.once('error', () => {
        finish();
      });
    });
    const timer = setTimeout(() => {
      finish();
    }, opts.timeoutMs);
    req.once('error', (error) => {
      finish(settled ? undefined : error);
    });
    req.end();
  });
}
